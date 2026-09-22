import { randomUUID } from 'node:crypto';
import type { Db } from '@pnr/store';
import { readBody } from '@pnr/store';
import type { Provider, StreamEvent } from '@pnr/ai';
import { adapterFor, storeItems } from '@pnr/feed';
import { enrichItem } from '@pnr/reader';
import { fillFromSearch } from './search-fill.ts';

export interface ReportUnit {
  kind: 'paragraph' | 'listItem' | 'timeline' | 'tableRow';
  text: string;
  sourceRefIds: string[];
  supported: boolean;
}
export interface ReportAnswer { title: string; units: ReportUnit[] }
export interface ReportSource {
  refId: string; itemId: string | null; basis: 'article' | 'snippet' | 'search';
  title: string; url: string; publisher: string | null; publishedAt: number | null; materialText: string;
}
export interface ReportMessage {
  id: string; sequence: number; role: 'user' | 'assistant'; question: string | null;
  answer: ReportAnswer | null; status: 'pending' | 'complete' | 'cancelled' | 'failed'; model: string | null;
}
export interface ReportConversation {
  id: string; anchorItemId: string; lang: string; topic: string; initialItemIds: string[];
  messages: ReportMessage[]; sources: ReportSource[]; createdAt: number; updatedAt: number;
}
export interface ReportStartInput { anchorItemId: string; itemIds: string[]; topic: string; lang: string; restart?: boolean; requestId: string }
export interface ReportEvent {
  requestId: string; conversationId: string; messageId: string; sequence: number;
  type: 'partial' | 'complete' | 'cancelled' | 'error'; value?: Partial<ReportAnswer>; error?: string;
}

const SELECT_SCHEMA = {
  type: 'object', properties: { itemIds: { type: 'array', maxItems: 8, items: { type: 'string' } } },
  required: ['itemIds'], additionalProperties: false
} as const;
const ANSWER_SCHEMA = {
  type: 'object', properties: {
    title: { type: 'string' },
    units: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['paragraph','listItem','timeline','tableRow'] },
      text: { type: 'string' }, sourceRefIds: { type: 'array', items: { type: 'string' } }, supported: { type: 'boolean' }
    }, required: ['kind','text','sourceRefIds','supported'], additionalProperties: false } }
  }, required: ['title','units'], additionalProperties: false
} as const;

type Item = { id: string; title: string; url: string; snippet: string | null; publishedAt: number; sourceName: string | null; domain: string | null; bodyState: string; bodyPath: string | null };
const ITEM_SELECT = `i.id,i.title,i.url,i.snippet,i.published_at AS publishedAt,s.name AS sourceName,s.domain,i.body_state AS bodyState,i.body_path AS bodyPath`;
const terms = (text: string): string[] => [...new Set([
  ...(text.match(/\b[A-Z][\p{L}\d-]{2,}/gu) ?? []), ...(text.match(/[\u3400-\u9fff]{2,8}/g) ?? [])
])].slice(0, 10);

export function getReport(db: Db, selector: { conversationId?: string; anchorItemId?: string; lang?: string }): ReportConversation | null {
  const row = selector.conversationId
    ? db.prepare(`SELECT id,anchor_item_id AS anchorItemId,lang,topic,initial_item_ids_json AS initialIds,created_at AS createdAt,updated_at AS updatedAt FROM conversations WHERE id=?`).get(selector.conversationId)
    : db.prepare(`SELECT id,anchor_item_id AS anchorItemId,lang,topic,initial_item_ids_json AS initialIds,created_at AS createdAt,updated_at AS updatedAt FROM conversations WHERE anchor_item_id=? AND lang=? ORDER BY updated_at DESC LIMIT 1`).get(selector.anchorItemId, selector.lang);
  if (!row) return null;
  const c = row as any;
  const messages = (db.prepare(`SELECT id,sequence,role,question,answer_json AS answerJson,status,model FROM conversation_messages WHERE conversation_id=? ORDER BY sequence`).all(c.id) as any[])
    .map((m) => ({ id: m.id, sequence: m.sequence, role: m.role, question: m.question,
      answer: m.answerJson ? JSON.parse(m.answerJson) : null, status: m.status, model: m.model })) as ReportMessage[];
  const sources = db.prepare(`SELECT ref_id AS refId,item_id AS itemId,basis,title,url,publisher,published_at AS publishedAt,material_text AS materialText FROM conversation_sources WHERE conversation_id=? ORDER BY CAST(substr(ref_id,2) AS INTEGER)`).all(c.id) as ReportSource[];
  return { id: c.id, anchorItemId: c.anchorItemId, lang: c.lang, topic: c.topic,
    initialItemIds: JSON.parse(c.initialIds), messages, sources, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

async function discover(db: Db, topic: string, lang: string): Promise<void> {
  const q = terms(topic).slice(0, 5).join(' '); if (!q) return;
  try {
    const adapter = adapterFor('googlenews'); if (!adapter) return;
    const sourceId = `search:report:${lang}`;
    db.prepare(`INSERT INTO sources (id,kind,name,url,lang,trust,enabled,added_by,created_at) VALUES (?,'googlenews','Report discovery',?,?,0.7,0,'search',?) ON CONFLICT(id) DO UPDATE SET url=excluded.url`)
      .run(sourceId, q, lang, Date.now());
    const { items } = await adapter({ id: sourceId, kind: 'googlenews', name: 'Report discovery', domain: null, url: q,
      category: null, lang, country: lang.split('-')[1] ?? 'US', trust: 0.7, enabled: 0, dateHydration: null, configJson: null }, { db });
    storeItems(db, items.slice(0, 20));
  } catch { /* Discovery broadens the pool; local material remains usable. */ }
}

async function chooseItems(db: Db, provider: Provider, input: ReportStartInput, researchQuestion?: string): Promise<Item[]> {
  await discover(db, `${input.topic} ${researchQuestion ?? ''}`, input.lang);
  const seedIds = [...new Set([input.anchorItemId, ...input.itemIds])];
  const seed = db.prepare(`SELECT ${ITEM_SELECT} FROM items i LEFT JOIN sources s ON s.id=i.source_id WHERE i.id IN (${seedIds.map(() => '?').join(',')})`).all(...seedIds) as Item[];
  const keys = terms(`${input.topic} ${researchQuestion ?? ''}`);
  const where = keys.length ? keys.map(() => '(i.title LIKE ? OR i.snippet LIKE ?)').join(' OR ') : '1=1';
  const local = db.prepare(`SELECT ${ITEM_SELECT} FROM items i LEFT JOIN sources s ON s.id=i.source_id WHERE i.published_at>=? AND (${where}) ORDER BY i.published_at DESC LIMIT 300`)
    .all(Date.now() - 30 * 864e5, ...keys.flatMap((k) => [`%${k}%`, `%${k}%`])) as Item[];
  const pool = [...new Map([...seed, ...local].map((r) => [r.id, r])).values()];
  const picked = await provider.generate<{ itemIds: string[] }>([
    'Select at most 8 directly relevant reports for an investigation. Recall broadly but do not select merely topical stories.',
    `TOPIC: ${input.topic}`, researchQuestion ? `CURRENT QUESTION: ${researchQuestion}` : '',
    ...pool.map((r) => `${r.id} | ${new Date(r.publishedAt).toISOString()} | ${r.sourceName ?? ''} | ${r.title} | ${r.snippet ?? ''}`)
  ].filter(Boolean).join('\n'), { schema: SELECT_SCHEMA as unknown as Record<string, unknown>, model: provider.fastModel,
    temperature: 0, operation: 'report_select' });
  const byId = new Map(pool.map((r) => [r.id, r]));
  const ids = [...new Set([input.anchorItemId, ...(picked.data.itemIds ?? [])])].filter((id) => byId.has(id)).slice(0, 8);
  return ids.map((id) => byId.get(id)!);
}

async function addSources(db: Db, provider: Provider, dataDir: string, conversationId: string, items: Item[], lang: string, signal?: AbortSignal): Promise<void> {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM conversation_sources WHERE conversation_id=?').get(conversationId) as { n: number }).n;
  let next = count + 1;
  for (const item of items) {
    if (db.prepare('SELECT 1 FROM conversation_sources WHERE conversation_id=? AND item_id=?').get(conversationId, item.id)) continue;
    if (item.bodyState === 'pending') await enrichItem(db, dataDir, { id: item.id, url: item.url });
    const current = db.prepare(`SELECT ${ITEM_SELECT} FROM items i LEFT JOIN sources s ON s.id=i.source_id WHERE i.id=?`).get(item.id) as Item;
    let material = readBody(current.bodyPath)?.text ?? ''; let basis: ReportSource['basis'] = material ? 'article' : 'snippet';
    let searchMaterialId: string | null = null;
    if (!material && provider.capabilities.search) {
      const filled = await fillFromSearch(db, provider, { itemId: item.id, title: item.title, snippet: item.snippet,
        publishedAt: item.publishedAt, lang, ...(signal ? { signal } : {}) });
      if (filled.publishable) { material = `${filled.title}\n${filled.body}`; basis = 'search'; searchMaterialId = filled.materialId; }
    }
    if (!material) material = current.snippet ?? '';
    if (!material.trim()) continue;
    db.prepare(`INSERT INTO conversation_sources (conversation_id,ref_id,item_id,basis,title,url,publisher,published_at,material_text,search_material_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(conversationId, `s${next++}`, current.id, basis, current.title, current.url, current.sourceName, current.publishedAt, material, searchMaterialId, Date.now());
  }
}

function validAnswer(value: ReportAnswer, allowed: Set<string>): ReportAnswer {
  const units = (value.units ?? []).flatMap((unit) => {
    const text = String(unit.text ?? '').trim(); if (!text) return [];
    const refs = [...new Set((unit.sourceRefIds ?? []).map(String).filter((id) => allowed.has(id)))];
    const supported = unit.supported === true;
    if (supported && refs.length === 0) return [];
    return [{ kind: unit.kind, text, sourceRefIds: supported ? refs : [], supported } as ReportUnit];
  });
  return { title: String(value.title ?? '').trim(), units };
}

async function answer(db: Db, provider: Provider, conversationId: string, question: string, requestId: string,
  emit: (event: ReportEvent) => void, signal?: AbortSignal): Promise<ReportConversation> {
  const userId = `message-${randomUUID()}`; const assistantId = `message-${randomUUID()}`; const now = Date.now();
  const created = db.transaction((): boolean => {
    const existing = db.prepare('SELECT id FROM conversation_messages WHERE request_id=? OR request_id=?').get(requestId, `${requestId}:user`);
    if (existing) return false;
    const busy = db.prepare("SELECT 1 FROM conversation_messages WHERE conversation_id=? AND status='pending'").get(conversationId);
    if (busy) throw new Error('conversation_busy');
    const seq = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM conversation_messages WHERE conversation_id=?').get(conversationId) as { n: number }).n;
    db.prepare(`INSERT INTO conversation_messages (id,conversation_id,sequence,role,question,status,request_id,created_at,updated_at) VALUES (?,?,?,?,?,'complete',?,?,?)`)
      .run(userId, conversationId, seq, 'user', question, `${requestId}:user`, now, now);
    db.prepare(`INSERT INTO conversation_messages (id,conversation_id,sequence,role,status,request_id,created_at,updated_at) VALUES (?,?,?,?, 'pending',?,?,?)`)
      .run(assistantId, conversationId, seq + 1, 'assistant', requestId, now, now);
    return true;
  })();
  if (!created) return getReport(db, { conversationId })!;
  const report = getReport(db, { conversationId })!;
  const history = report.messages.filter((m) => m.status === 'complete').map((m) => m.role === 'user'
    ? `USER: ${m.question}` : `ASSISTANT: ${JSON.stringify(m.answer)}`).join('\n');
  const sourceBudget = Math.max(8_000, provider.limits.write.maxInputTokens * 3 - history.length - 8_000);
  const material: string[] = []; let used = 0;
  for (const source of report.sources) {
    const block = `[${source.refId}] ${source.basis.toUpperCase()} | ${source.publisher ?? ''} | ${source.title}\n${source.materialText}`;
    if (used + block.length > sourceBudget) continue;
    material.push(block); used += block.length;
  }
  if (history.length > provider.limits.write.maxInputTokens * 3) throw new Error('conversation_context_exceeded');
  const prompt = [
    'Write an evidence-bound investigative report answer.', `OUTPUT_LANGUAGE: ${report.lang}`, `TOPIC: ${report.topic}`,
    'Each factual sentence, list item, timeline point, or table row must be a separate unit with supported=true and sourceRefIds.',
    'Use only the provided [sN] ids. Never invent a URL. A material-not-covered explanation may use supported=false and no references.',
    'Do not silently summarize conversation history. Use full materials as supplied.', `QUESTION: ${question}`, history ? `HISTORY:\n${history}` : '',
    `MATERIALS (${material.length}/${report.sources.length} included):`, ...material
  ].filter(Boolean).join('\n\n');
  try {
    let final: ReportAnswer | null = null;
    for await (const event of provider.stream<ReportAnswer>(prompt, { schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
      model: provider.writeModel, temperature: 0.2, operation: 'report_answer', ...(signal ? { signal } : {}) })) {
      if (event.type === 'partial') emit({ requestId, conversationId, messageId: assistantId, sequence: event.sequence, type: 'partial', value: event.value });
      else if (event.type === 'error') throw event.error;
      else final = event.result.data;
    }
    if (!final) throw new Error('empty_report');
    const clean = validAnswer(final, new Set(report.sources.map((s) => s.refId)));
    if (!clean.units.length) throw new Error('uncited_report');
    db.prepare(`UPDATE conversation_messages SET answer_json=?,status='complete',model=?,updated_at=? WHERE id=?`)
      .run(JSON.stringify(clean), provider.writeModel, Date.now(), assistantId);
    db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(Date.now(), conversationId);
    emit({ requestId, conversationId, messageId: assistantId, sequence: Number.MAX_SAFE_INTEGER, type: 'complete', value: clean });
  } catch (error) {
    const cancelled = signal?.aborted === true;
    db.prepare('UPDATE conversation_messages SET status=?,updated_at=? WHERE id=?').run(cancelled ? 'cancelled' : 'failed', Date.now(), assistantId);
    emit({ requestId, conversationId, messageId: assistantId, sequence: Number.MAX_SAFE_INTEGER,
      type: cancelled ? 'cancelled' : 'error', error: String(error).slice(0, 160) });
  }
  return getReport(db, { conversationId })!;
}

export async function startReport(db: Db, provider: Provider, dataDir: string, input: ReportStartInput,
  emit: (event: ReportEvent) => void, signal?: AbortSignal): Promise<ReportConversation> {
  if (!input.restart) {
    const restored = getReport(db, { anchorItemId: input.anchorItemId, lang: input.lang });
    if (restored) return restored;
  }
  const id = `conversation-${randomUUID()}`; const now = Date.now();
  db.prepare(`INSERT INTO conversations (id,anchor_item_id,lang,topic,initial_item_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, input.anchorItemId, input.lang, input.topic, JSON.stringify([...new Set(input.itemIds)]), now, now);
  const selected = await chooseItems(db, provider, input);
  await addSources(db, provider, dataDir, id, selected, input.lang, signal);
  return answer(db, provider, id, input.topic, input.requestId, emit, signal);
}

export async function askReport(db: Db, provider: Provider, dataDir: string, conversationId: string, question: string,
  requestId: string, research: boolean, emit: (event: ReportEvent) => void, signal?: AbortSignal): Promise<ReportConversation> {
  const report = getReport(db, { conversationId }); if (!report) throw new Error('conversation_not_found');
  if (research) {
    const input: ReportStartInput = { anchorItemId: report.anchorItemId, itemIds: report.initialItemIds, topic: report.topic, lang: report.lang, requestId };
    const selected = await chooseItems(db, provider, input, question);
    await addSources(db, provider, dataDir, conversationId, selected, report.lang, signal);
  }
  return answer(db, provider, conversationId, question, requestId, emit, signal);
}
