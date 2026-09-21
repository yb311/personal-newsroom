import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '@pnr/store';
import type { Provider } from '@pnr/ai';
import { canonicalDedupKey, domainOf, downloadPublic, flags, log } from '@pnr/core';
import { extractArticle } from '@pnr/reader-core';

export interface SearchFillInput {
  itemId?: string; title: string; snippet?: string | null; publishedAt: number;
  dateEstimated?: boolean; lang: string; signal?: AbortSignal;
}
export interface SearchFillSource {
  refId: string; url: string; title: string; publisher: string; itemId: string | null;
  accessible: boolean; relevant: boolean; supported: boolean;
}
export interface SearchFillResult {
  materialId: string; publishable: boolean; title: string; body: string;
  sourceRefIds: string[]; sources: SearchFillSource[];
}

const VALIDATE_SCHEMA = {
  type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: {
    refId: { type: 'string' }, relevant: { type: 'boolean' }, supported: { type: 'boolean' }
  }, required: ['refId','relevant','supported'], additionalProperties: false } } },
  required: ['sources'], additionalProperties: false
} as const;
const WRITE_SCHEMA = {
  type: 'object', properties: {
    publishable: { type: 'boolean' }, title: { type: 'string' }, body: { type: 'string' },
    sourceRefIds: { type: 'array', items: { type: 'string' } }
  }, required: ['publishable','title','body','sourceRefIds'], additionalProperties: false
} as const;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24);
const softFailure = (text: string): boolean => text.length < 160
  || /captcha|verify you are human|access denied|sign in to continue|page not found|404 not found/i.test(text.slice(0, 1200));

function saveSearchItem(db: Db, source: { url: string; title: string }, input: SearchFillInput): string | null {
  const key = canonicalDedupKey(source.url); if (!key) return null;
  const existing = db.prepare('SELECT id FROM items WHERE dedup_key=?').get(key) as { id: string } | undefined;
  if (existing) return existing.id;
  const domain = domainOf(source.url); if (!domain) return null;
  const sourceId = `search-publisher:${domain}`; const now = Date.now();
  db.prepare(`INSERT INTO sources (id,kind,name,domain,url,trust,enabled,added_by,created_at)
    VALUES (?,'googlenews',?,?,?,0.7,0,'search',?) ON CONFLICT(id) DO NOTHING`)
    .run(sourceId, domain, domain, source.url, now);
  const id = `search-${sha(key)}`;
  db.prepare(`INSERT INTO items (id,dedup_key,source_id,url,title,published_at,discovered_at,snippet,date_estimated,body_state)
    VALUES (?,?,?,?,?,?,?,?,1,'pending') ON CONFLICT(dedup_key) DO NOTHING`)
    .run(id, key, sourceId, source.url, source.title || input.title, input.publishedAt, now, input.snippet ?? null);
  return (db.prepare('SELECT id FROM items WHERE dedup_key=?').get(key) as { id: string } | undefined)?.id ?? null;
}

/** Native search is evidence gathering only. Publication text is produced in a
 * second schema-validated call over locally bound reference ids. */
export async function fillFromSearch(db: Db, provider: Provider, input: SearchFillInput): Promise<SearchFillResult> {
  if (flags.disableSearch || !provider.capabilities.search) {
    return { materialId: '', publishable: false, title: '', body: '', sourceRefIds: [], sources: [] };
  }
  const materialId = `search-material-${randomUUID()}`;
  const centre = input.publishedAt; const start = new Date(centre - 24 * 3600_000);
  const end = new Date(Math.min(Date.now(), centre + 24 * 3600_000));
  const searchPrompt = [
    'Find reporting about this exact news event. Do not broaden to related events.',
    `EVENT: ${input.title}`, input.snippet ? `ORIGINAL SNIPPET: ${input.snippet}` : '',
    `REPORTING WINDOW: ${start.toISOString()} through ${end.toISOString()}`,
    input.dateEstimated ? 'The original timestamp is only when we discovered it, not a confirmed event time.' : '',
    'Return only facts confirmed by reporting in this window and expose the source URLs.'
  ].filter(Boolean).join('\n');
  const search = await provider.search(searchPrompt, { ...(input.signal ? { signal: input.signal } : {}), model: provider.writeModel });
  const unique = [...new Map(search.sources.map((s) => [s.url, s])).values()].slice(0, 10);
  const candidates: { refId: string; url: string; title: string; publisher: string; text: string; itemId: string | null; accessible: boolean }[] = [];
  for (const [index, candidate] of unique.entries()) {
    const refId = `s${index + 1}`;
    try {
      const page = await downloadPublic(candidate.url, { ...(input.signal ? { signal: input.signal } : {}) });
      const article = await extractArticle(page.url, page.body, page.contentType);
      const accessible = !softFailure(article.text);
      candidates.push({ refId, url: page.url, title: article.title ?? candidate.title ?? '',
        publisher: domainOf(page.url), text: accessible ? article.text.slice(0, 8_000) : '',
        itemId: accessible ? saveSearchItem(db, { url: page.url, title: article.title ?? candidate.title ?? input.title }, input) : null,
        accessible });
    } catch {
      candidates.push({ refId, url: candidate.url, title: candidate.title ?? '', publisher: domainOf(candidate.url),
        text: '', itemId: null, accessible: false });
    }
  }
  const evidence = candidates.filter((candidate) => candidate.accessible);

  let verdicts = new Map<string, { relevant: boolean; supported: boolean }>();
  if (evidence.length) {
    const checked = await provider.generate<{ sources: { refId: string; relevant: boolean; supported: boolean }[] }>([
      'Check each source independently.', `TARGET EVENT: ${input.title}`,
      'relevant means it reports this same event, not merely the same person/topic.',
      'supported means its extracted text contains concrete facts that can support a news brief.',
      ...evidence.map((e) => `[${e.refId}] ${e.publisher} | ${e.title}\n${e.text}`)
    ].join('\n\n'), { schema: VALIDATE_SCHEMA as unknown as Record<string, unknown>, model: provider.fastModel,
      temperature: 0, ...(input.signal ? { signal: input.signal } : {}), operation: 'search_validate' });
    const valid = new Set(evidence.map((e) => e.refId));
    verdicts = new Map((checked.data.sources ?? []).filter((v) => valid.has(v.refId)).map((v) => [v.refId, v]));
  }
  const supported = evidence.filter((e) => verdicts.get(e.refId)?.relevant && verdicts.get(e.refId)?.supported);
  let title = ''; let body = ''; let sourceRefIds: string[] = []; let publishable = false;
  if (supported.length) {
    const written = await provider.generate<{ publishable: boolean; title: string; body: string; sourceRefIds: string[] }>([
      'Write a concise breaking-news fill-in from only the bound evidence below.', `OUTPUT_LANGUAGE: ${input.lang}`,
      `EVENT: ${input.title}`, 'Every factual sentence must be supported by at least one listed ref id.',
      'Use only [sN] ids. Never write or invent a URL. If the exact event is not adequately confirmed, publishable=false.',
      ...supported.map((e) => `[${e.refId}] ${e.publisher} | ${e.title}\n${e.text}`)
    ].join('\n\n'), { schema: WRITE_SCHEMA as unknown as Record<string, unknown>, model: provider.writeModel,
      temperature: 0.15, ...(input.signal ? { signal: input.signal } : {}), operation: 'search_write' });
    const allowed = new Set(supported.map((e) => e.refId));
    sourceRefIds = [...new Set((written.data.sourceRefIds ?? []).filter((id) => allowed.has(id)))];
    publishable = written.data.publishable === true && sourceRefIds.length > 0 && Boolean(written.data.body?.trim());
    if (publishable) { title = written.data.title.trim(); body = written.data.body.trim(); }
  }
  const sources: SearchFillSource[] = candidates.map((e) => ({ refId: e.refId, url: e.url, title: e.title,
    publisher: e.publisher, itemId: e.itemId, accessible: e.accessible, relevant: verdicts.get(e.refId)?.relevant ?? false,
    supported: verdicts.get(e.refId)?.supported ?? false }));
  db.transaction(() => {
    db.prepare(`INSERT INTO search_materials (id,target_item_id,event_title,event_time,date_estimated,provider,model,
      search_text,filled_text,publishable,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(materialId, input.itemId ?? null, input.title, input.publishedAt, input.dateEstimated ? 1 : 0,
        search.provider, search.model, search.text, publishable ? `${title}\n${body}` : null, publishable ? 1 : 0, Date.now());
    const insert = db.prepare(`INSERT INTO search_material_sources (material_id,ref_id,url,title,publisher,item_id,accessible,relevant,supported,evidence_text)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const source of sources) {
      const raw = candidates.find((e) => e.refId === source.refId)!;
      insert.run(materialId, source.refId, source.url, source.title, source.publisher, source.itemId, source.accessible ? 1 : 0,
        source.relevant ? 1 : 0, source.supported ? 1 : 0, raw.text || null);
    }
  })();
  log({ event: 'search.fill', phase: publishable ? 'completed' : 'skipped',
    ...(input.itemId ? { entityId: input.itemId } : {}), ...(!publishable ? { reasonCode: 'insufficient_evidence' } : {}),
    attrs: { searched: unique.length, accessible: evidence.length, supported: supported.length } });
  return { materialId, publishable, title, body, sourceRefIds, sources };
}
