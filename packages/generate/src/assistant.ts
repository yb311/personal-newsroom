import { randomUUID } from 'node:crypto';
import type { Db } from '@pnr/store';
import { readBody } from '@pnr/store';
import { nearestItems, type Provider } from '@pnr/ai';
import { adapterFor } from '@pnr/feed';
import { enrichItem } from '@pnr/reader';
import { domainOf, downloadPublic, flags, localDateTime, log } from '@pnr/core';
import { extractArticle } from '@pnr/reader-core';

/**
 * 新闻助手: a conversation about news in general, not bound to any article.
 *
 * Each question is answered from material gathered for that turn — the
 * person's own library, a Google News search and, when the provider has one,
 * native web search — and every material is registered as a numbered source
 * of the chat. The model may only cite those numbers (it never writes a URL);
 * anything it says without a source is stored and shown as unsourced.
 */

export type AssistantSourceKind = 'library' | 'news' | 'web';
export interface AssistantUnit { kind: 'paragraph' | 'listItem'; text: string; sourceRefIds: string[]; supported: boolean }
export interface AssistantAnswer { units: AssistantUnit[] }
export interface AssistantSource {
  refId: string; kind: AssistantSourceKind; itemId: string | null;
  title: string; url: string; publisher: string | null; publishedAt: number | null;
}
export interface AssistantMessage {
  id: string; sequence: number; role: 'user' | 'assistant'; content: string | null;
  answer: AssistantAnswer | null; status: 'pending' | 'complete' | 'cancelled' | 'failed';
  web: boolean; error: string | null;
}
export interface AssistantChat {
  id: string; title: string; lang: string; createdAt: number; updatedAt: number;
  messages: AssistantMessage[]; sources: AssistantSource[];
}
export interface AssistantChatSummary { id: string; title: string; updatedAt: number }
export interface AssistantAskInput { chatId?: string | null; question: string; web: boolean; lang: string; requestId: string }
export type AssistantPhase = 'library' | 'news' | 'web' | 'writing';
export interface AssistantEvent {
  requestId: string; chatId: string; messageId: string;
  type: 'phase' | 'partial' | 'complete' | 'cancelled' | 'error';
  phase?: AssistantPhase; value?: Partial<AssistantAnswer>; error?: string;
}
export interface NewsHit { title: string; url: string; publisher: string | null; publishedAt: number | null; snippet: string | null }
export interface AssistantDeps {
  download: typeof downloadPublic; extract: typeof extractArticle;
  /** News search; Google News by default. */
  news: (db: Db, query: string, lang: string) => Promise<NewsHit[]>;
}

const PLAN_SCHEMA = {
  type: 'object', properties: {
    keywords: { type: 'array', maxItems: 8, items: { type: 'string' } },
    searchQuery: { type: 'string' }
  }, required: ['keywords', 'searchQuery'], additionalProperties: false
} as const;
const SELECT_SCHEMA = {
  type: 'object', properties: { itemIds: { type: 'array', maxItems: 8, items: { type: 'string' } } },
  required: ['itemIds'], additionalProperties: false
} as const;
const ANSWER_SCHEMA = {
  type: 'object', properties: {
    units: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['paragraph', 'listItem'] },
      text: { type: 'string' }, sourceRefIds: { type: 'array', items: { type: 'string' } }, supported: { type: 'boolean' }
    }, required: ['kind', 'text', 'sourceRefIds', 'supported'], additionalProperties: false } }
  }, required: ['units'], additionalProperties: false
} as const;

/** How far back the library is searched, and how much of one article is sent. */
const LIBRARY_DAYS = 30;
const MATERIAL_CHARS = 6_000;
const MAX_LIBRARY = 8;
const MAX_NEWS = 8;
const MAX_WEB = 6;

type Candidate = Omit<AssistantSource, 'refId'> & { material: string };
type Item = { id: string; title: string; url: string; snippet: string | null; publishedAt: number;
  sourceName: string | null; bodyState: string; bodyPath: string | null };
const ITEM_SELECT = `i.id,i.title,i.url,i.snippet,i.published_at AS publishedAt,s.name AS sourceName,
  i.body_state AS bodyState,i.body_path AS bodyPath`;

/** Fallback search terms when planning is unavailable: names and CJK runs. */
const roughTerms = (text: string): string[] => [...new Set([
  ...(text.match(/\b[A-Z][\p{L}\d-]{2,}/gu) ?? []), ...(text.match(/[\u3400-\u9fff]{2,6}/g) ?? [])
])].slice(0, 8);
const softFailure = (text: string): boolean => text.length < 160
  || /captcha|verify you are human|access denied|sign in to continue|page not found|404 not found/i.test(text.slice(0, 1200));
const abortIfNeeded = (signal?: AbortSignal): void => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const plainAnswer = (answer: AssistantAnswer | null): string => (answer?.units ?? []).map((u) => u.text).join(' ');

// ── reading ─────────────────────────────────────────────────────────────────

export function listChats(db: Db, limit = 40): AssistantChatSummary[] {
  return db.prepare('SELECT id, title, updated_at AS updatedAt FROM assistant_chats ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as AssistantChatSummary[];
}

export function getChat(db: Db, id: string): AssistantChat | null {
  const chat = db.prepare('SELECT id, title, lang, created_at AS createdAt, updated_at AS updatedAt FROM assistant_chats WHERE id = ?')
    .get(id) as Omit<AssistantChat, 'messages' | 'sources'> | undefined;
  if (!chat) return null;
  const messages = (db.prepare(`SELECT id, sequence, role, content, answer_json AS answerJson, status, web, error
    FROM assistant_messages WHERE chat_id = ? ORDER BY sequence`).all(id) as any[])
    .map((m) => ({ id: m.id, sequence: m.sequence, role: m.role, content: m.content,
      answer: m.answerJson ? JSON.parse(m.answerJson) as AssistantAnswer : null,
      status: m.status, web: m.web === 1, error: m.error })) as AssistantMessage[];
  const sources = db.prepare(`SELECT ref_id AS refId, kind, item_id AS itemId, title, url, publisher, published_at AS publishedAt
    FROM assistant_sources WHERE chat_id = ? ORDER BY CAST(substr(ref_id, 2) AS INTEGER)`).all(id) as AssistantSource[];
  return { ...chat, messages, sources };
}

export function deleteChat(db: Db, id: string): void {
  db.prepare('DELETE FROM assistant_chats WHERE id = ?').run(id);
}

/** A turn still marked pending after a crash would block its chat forever. */
export function recoverAssistant(db: Db): void {
  db.prepare("UPDATE assistant_messages SET status = 'failed', error = 'interrupted', updated_at = ? WHERE status = 'pending'").run(Date.now());
}

// ── gathering ───────────────────────────────────────────────────────────────

async function plan(provider: Provider, question: string, history: string, signal?: AbortSignal): Promise<{ keywords: string[]; searchQuery: string }> {
  try {
    const { data } = await provider.generate<{ keywords: string[]; searchQuery: string }>([
      'You plan research for a news assistant.', `NOW: ${localDateTime(Date.now())}`,
      'keywords: up to 8 short terms for a substring search over headlines and snippets in a local news library.',
      'Use names, places, organisations and topic words; give both Chinese and English forms when useful. Never whole sentences.',
      'searchQuery: one concise, standalone news search query for the question, resolving any reference to the earlier conversation.',
      history ? `RECENT CONVERSATION:\n${history}` : '', `QUESTION: ${question}`
    ].filter(Boolean).join('\n'), { schema: PLAN_SCHEMA as unknown as Record<string, unknown>, model: provider.fastModel,
      temperature: 0, operation: 'assistant_plan', ...(signal ? { signal } : {}) });
    const keywords = [...new Set((data.keywords ?? []).map((k) => String(k).trim()).filter((k) => k.length >= 2))].slice(0, 8);
    return { keywords: keywords.length ? keywords : roughTerms(question), searchQuery: String(data.searchQuery ?? '').trim() || question };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { keywords: roughTerms(question), searchQuery: question };
  }
}

async function fromLibrary(db: Db, provider: Provider, dataDir: string, question: string,
  q: { keywords: string[]; searchQuery: string }, signal?: AbortSignal): Promise<Candidate[]> {
  const since = Date.now() - LIBRARY_DAYS * 864e5;
  const pool = new Map<string, Item>();
  if (q.keywords.length) {
    const where = q.keywords.map(() => '(i.title LIKE ? OR i.snippet LIKE ?)').join(' OR ');
    for (const row of db.prepare(`SELECT ${ITEM_SELECT} FROM items i LEFT JOIN sources s ON s.id = i.source_id
      WHERE i.published_at >= ? AND (${where}) ORDER BY i.published_at DESC LIMIT 120`)
      .all(since, ...q.keywords.flatMap((k) => [`%${k}%`, `%${k}%`])) as Item[]) pool.set(row.id, row);
  }
  if (provider.capabilities.embedding) {
    try {
      const [vector] = await provider.embed([q.searchQuery], 'query', signal);
      const near = vector ? nearestItems(db, vector, 40).map((n) => n.itemId) : [];
      if (near.length) {
        for (const row of db.prepare(`SELECT ${ITEM_SELECT} FROM items i LEFT JOIN sources s ON s.id = i.source_id
          WHERE i.id IN (${near.map(() => '?').join(',')}) AND i.published_at >= ?`).all(...near, since) as Item[]) pool.set(row.id, row);
      }
    } catch (error) { if (signal?.aborted) throw error; /* Keyword recall still stands. */ }
  }
  // Broad questions ("今天有什么大事") match no keyword: offer the day's headlines.
  if (pool.size < 10) {
    for (const row of db.prepare(`SELECT ${ITEM_SELECT} FROM items i JOIN sources s ON s.id = i.source_id
      WHERE s.enabled = 1 AND i.published_at >= ? ORDER BY i.published_at DESC LIMIT 40`)
      .all(Date.now() - 864e5) as Item[]) if (!pool.has(row.id)) pool.set(row.id, row);
  }
  if (pool.size === 0) return [];
  abortIfNeeded(signal);

  let chosen = [...pool.values()];
  if (chosen.length > MAX_LIBRARY) {
    const lines = chosen.slice(0, 160).map((r) => `${r.id} | ${localDateTime(r.publishedAt)} | ${r.sourceName ?? ''} | ${r.title} | ${(r.snippet ?? '').slice(0, 160)}`);
    try {
      const { data } = await provider.generate<{ itemIds: string[] }>([
        `Pick at most ${MAX_LIBRARY} articles that help answer the question. Prefer directly relevant and recent reporting; pick none if nothing fits.`,
        `QUESTION: ${question}`, `SEARCH: ${q.searchQuery}`, ...lines
      ].join('\n'), { schema: SELECT_SCHEMA as unknown as Record<string, unknown>, model: provider.fastModel,
        temperature: 0, operation: 'assistant_select', ...(signal ? { signal } : {}) });
      chosen = [...new Set(data.itemIds ?? [])].map((id) => pool.get(id)).filter((r): r is Item => Boolean(r)).slice(0, MAX_LIBRARY);
    } catch (error) {
      if (signal?.aborted) throw error;
      chosen = chosen.slice(0, MAX_LIBRARY);
    }
  }
  // Full text where it can be had: fetch bodies not extracted yet.
  await Promise.all(chosen.filter((r) => r.bodyState === 'pending').map((r) => enrichItem(db, dataDir, { id: r.id, url: r.url }).catch(() => null)));
  abortIfNeeded(signal);
  return chosen.flatMap((r) => {
    const current = db.prepare(`SELECT ${ITEM_SELECT} FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id = ?`).get(r.id) as Item;
    const material = (readBody(current.bodyPath)?.text ?? '').slice(0, MATERIAL_CHARS) || current.snippet || '';
    return material.trim() ? [{ kind: 'library' as const, itemId: current.id, title: current.title, url: current.url,
      publisher: current.sourceName, publishedAt: current.publishedAt, material }] : [];
  });
}

/** Google News search: real links, headline and snippet only. Needs no AI. */
async function googleNews(db: Db, query: string, lang: string): Promise<NewsHit[]> {
  const adapter = adapterFor('googlenews'); if (!adapter) return [];
  const { items } = await adapter({ id: 'search:assistant', kind: 'googlenews', name: 'Google News', domain: null, url: query,
    category: null, lang, country: lang.split('-')[1] ?? 'US', trust: 0.7, enabled: 0, dateHydration: null, configJson: null }, { db });
  return items.map((it) => ({ title: it.title, url: it.url, publisher: it.sourceName ?? null,
    publishedAt: Date.parse(it.publishedAt) || null, snippet: it.snippet ?? null }));
}

async function fromNews(db: Db, query: string, lang: string, deps: AssistantDeps): Promise<Candidate[]> {
  if (flags.disableSearch) return [];
  try {
    return (await deps.news(db, query, lang)).slice(0, MAX_NEWS).map((it) => ({ kind: 'news' as const, itemId: null,
      title: it.title, url: it.url, publisher: it.publisher, publishedAt: it.publishedAt,
      material: [it.title, it.snippet && it.snippet !== it.title ? it.snippet : ''].filter(Boolean).join('\n') }));
  } catch { return []; }
}

/** Native web search, then each page is fetched and read locally, so a
 *  source only counts when its own text is in hand. */
async function fromWeb(provider: Provider, question: string, query: string, deps: AssistantDeps, signal?: AbortSignal): Promise<Candidate[]> {
  if (flags.disableSearch || !provider.capabilities.search) return [];
  let found: { url: string; title?: string | undefined }[] = [];
  try {
    const search = await provider.search([
      `NOW: ${localDateTime(Date.now())}`,
      'Search the web for current, reliable reporting that answers the question. Prefer primary sources and established outlets.',
      `QUESTION: ${question}`, `SEARCH: ${query}`
    ].join('\n'), { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
    found = [...new Map(search.sources.map((s) => [s.url, s])).values()].slice(0, MAX_WEB);
  } catch (error) {
    if (signal?.aborted) throw error;
    log({ event: 'assistant.web', phase: 'failed', reasonDetail: String(error).slice(0, 160) });
    return [];
  }
  const pages = await Promise.all(found.map(async (hit): Promise<Candidate | null> => {
    try {
      const page = await deps.download(hit.url, { timeoutMs: 12_000, ...(signal ? { signal } : {}) });
      const article = await deps.extract(page.url, page.body, page.contentType);
      if (softFailure(article.text)) return null;
      return { kind: 'web', itemId: null, title: article.title || hit.title || domainOf(page.url), url: page.url,
        publisher: domainOf(page.url) || null, publishedAt: null, material: article.text.slice(0, MATERIAL_CHARS) };
    } catch { return null; }
  }));
  return pages.filter((p): p is Candidate => Boolean(p));
}

/** Registers this turn's materials as numbered sources of the chat. */
function register(db: Db, chatId: string, candidates: Candidate[]): string[] {
  const byUrl = db.prepare('SELECT ref_id AS refId FROM assistant_sources WHERE chat_id = ? AND url = ?');
  const insert = db.prepare(`INSERT INTO assistant_sources (chat_id, ref_id, kind, item_id, title, url, publisher, published_at, material_text, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  return db.transaction((): string[] => {
    let next = (db.prepare('SELECT COUNT(*) AS n FROM assistant_sources WHERE chat_id = ?').get(chatId) as { n: number }).n + 1;
    const refs: string[] = [];
    for (const c of candidates) {
      const existing = byUrl.get(chatId, c.url) as { refId: string } | undefined;
      if (existing) { refs.push(existing.refId); continue; }
      const refId = `s${next++}`;
      insert.run(chatId, refId, c.kind, c.itemId, c.title, c.url, c.publisher, c.publishedAt, c.material, Date.now());
      refs.push(refId);
    }
    return [...new Set(refs)];
  })();
}

/** Only bound ids survive; a "supported" line without one is shown as unsourced. */
function clean(value: AssistantAnswer, allowed: Set<string>): AssistantAnswer {
  return { units: (value.units ?? []).flatMap((unit) => {
    const text = String(unit.text ?? '').trim(); if (!text) return [];
    const refs = [...new Set((unit.sourceRefIds ?? []).map(String).filter((id) => allowed.has(id)))];
    const supported = unit.supported === true && refs.length > 0;
    return [{ kind: unit.kind === 'listItem' ? 'listItem' : 'paragraph', text, sourceRefIds: supported ? refs : [], supported }];
  }) };
}

// ── answering ───────────────────────────────────────────────────────────────

export async function askAssistant(db: Db, provider: Provider, dataDir: string, input: AssistantAskInput,
  emit: (event: AssistantEvent) => void, signal?: AbortSignal,
  deps: AssistantDeps = { download: downloadPublic, extract: extractArticle, news: googleNews }): Promise<AssistantChat> {
  const question = input.question.trim();
  if (!question) throw new Error('empty_question');
  const now = Date.now();
  const chatId = input.chatId && getChat(db, input.chatId) ? input.chatId : `chat-${randomUUID()}`;
  const userId = `amsg-${randomUUID()}`; const messageId = `amsg-${randomUUID()}`;
  const created = db.transaction((): boolean => {
    if (db.prepare('SELECT 1 FROM assistant_messages WHERE request_id IN (?, ?)').get(input.requestId, `${input.requestId}:user`)) return false;
    if (db.prepare("SELECT 1 FROM assistant_messages WHERE chat_id = ? AND status = 'pending'").get(chatId)) throw new Error('chat_busy');
    db.prepare('INSERT INTO assistant_chats (id, title, lang, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at')
      .run(chatId, question.replace(/\s+/g, ' ').slice(0, 60), input.lang, now, now);
    const seq = (db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM assistant_messages WHERE chat_id = ?').get(chatId) as { n: number }).n;
    const add = db.prepare(`INSERT INTO assistant_messages (id, chat_id, sequence, role, content, status, web, request_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    add.run(userId, chatId, seq, 'user', question, 'complete', input.web ? 1 : 0, `${input.requestId}:user`, now, now);
    add.run(messageId, chatId, seq + 1, 'assistant', null, 'pending', input.web ? 1 : 0, input.requestId, now, now);
    return true;
  })();
  if (!created) {
    const existing = db.prepare('SELECT chat_id AS chatId FROM assistant_messages WHERE request_id = ?').get(input.requestId) as { chatId: string } | undefined;
    return getChat(db, existing?.chatId ?? chatId)!;
  }

  const send = (event: Omit<AssistantEvent, 'requestId' | 'chatId' | 'messageId'>): void =>
    emit({ requestId: input.requestId, chatId, messageId, ...event });
  const finish = (status: 'complete' | 'cancelled' | 'failed', answer: AssistantAnswer | null, error: string | null): void => {
    db.prepare('UPDATE assistant_messages SET status = ?, answer_json = ?, error = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(status, answer ? JSON.stringify(answer) : null, error, provider.writeModel, Date.now(), messageId);
    db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId);
  };

  try {
    const earlier = getChat(db, chatId)!;
    const turns = earlier.messages.filter((m) => m.status === 'complete' && m.id !== userId).slice(-8);
    const history = turns.map((m) => m.role === 'user' ? `User: ${m.content}` : `Assistant: ${plainAnswer(m.answer)}`).join('\n');

    send({ type: 'phase', phase: 'library' });
    const q = await plan(provider, question, history, signal);
    const library = await fromLibrary(db, provider, dataDir, question, q, signal);
    let online: Candidate[] = [];
    if (input.web) {
      send({ type: 'phase', phase: provider.capabilities.search && !flags.disableSearch ? 'web' : 'news' });
      const [news, web] = await Promise.all([fromNews(db, q.searchQuery, input.lang, deps), fromWeb(provider, question, q.searchQuery, deps, signal)]);
      const seen = new Set(library.map((c) => c.url));
      online = [...web, ...news].filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
    }
    abortIfNeeded(signal);
    const turnRefs = register(db, chatId, [...library, ...online]);

    // This turn's materials first, then earlier ones for follow-ups, within budget.
    const all = db.prepare(`SELECT ref_id AS refId, kind, title, publisher, published_at AS publishedAt, material_text AS material
      FROM assistant_sources WHERE chat_id = ?`).all(chatId) as { refId: string; kind: string; title: string; publisher: string | null; publishedAt: number | null; material: string }[];
    const order = [...turnRefs, ...all.map((s) => s.refId).filter((r) => !turnRefs.includes(r))];
    const byRef = new Map(all.map((s) => [s.refId, s]));
    const budget = Math.max(12_000, provider.limits.write.maxInputTokens * 3 - history.length - 10_000);
    const blocks: string[] = []; let used = 0;
    for (const ref of order) {
      const s = byRef.get(ref)!;
      const block = `[${s.refId}] ${s.kind.toUpperCase()} | ${s.publisher ?? ''} | ${s.publishedAt ? localDateTime(s.publishedAt) : ''} | ${s.title}\n${s.material}`;
      if (used + block.length > budget) continue;
      blocks.push(block); used += block.length;
    }

    send({ type: 'phase', phase: 'writing' });
    const prompt = [
      'You are the news assistant of a personal news reader. Answer the latest question.',
      `OUTPUT_LANGUAGE: ${input.lang}`, `NOW: ${localDateTime(Date.now())}`,
      'Split the answer into units: short paragraphs (kind "paragraph") or list items (kind "listItem"). Lead with the direct answer.',
      'Every fact taken from the materials: supported=true, with the [sN] ids it came from. Use only ids listed below. Never write a URL.',
      'Background or general knowledge that is not in the materials is allowed when it helps: supported=false and no ids. Never present it as recent news.',
      'If the materials do not cover the question, say so plainly instead of guessing. Never invent dates, numbers or quotes.',
      'LIBRARY = the reader\'s own subscriptions; NEWS = news-search headlines and snippets only, so claim nothing beyond them; WEB = pages found by web search.',
      input.web ? '' : 'Online search was switched off for this question; rely on the library.',
      'Be concise (about 250 words) unless the question asks for depth.',
      history ? `CONVERSATION SO FAR:\n${history}` : '', `QUESTION: ${question}`,
      blocks.length ? `MATERIALS (${blocks.length}):\n\n${blocks.join('\n\n')}` : 'MATERIALS: none were found.'
    ].filter(Boolean).join('\n\n');

    let final: AssistantAnswer | null = null;
    for await (const event of provider.stream<AssistantAnswer>(prompt, { schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
      model: provider.writeModel, temperature: 0.2, operation: 'assistant_answer', ...(signal ? { signal } : {}) })) {
      if (event.type === 'partial') send({ type: 'partial', value: event.value });
      else if (event.type === 'error') throw event.error;
      else final = event.result.data;
    }
    const answer = clean(final ?? { units: [] }, new Set(all.map((s) => s.refId)));
    if (!answer.units.length) throw new Error('empty_answer');
    finish('complete', answer, null);
    send({ type: 'complete', value: answer });
    log({ event: 'assistant.answer', phase: 'completed', entityId: chatId,
      attrs: { library: library.length, online: online.length, units: answer.units.length } });
  } catch (error) {
    const cancelled = signal?.aborted === true;
    const message = cancelled ? null : String((error as { code?: string })?.code ?? error).slice(0, 160);
    finish(cancelled ? 'cancelled' : 'failed', null, message);
    send(cancelled ? { type: 'cancelled' } : { type: 'error', error: message ?? 'failed' });
  }
  return getChat(db, chatId)!;
}
