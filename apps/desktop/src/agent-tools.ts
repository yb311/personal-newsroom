import { z } from 'zod';
import type { Db } from '@pnr/store';
import { publicSettings } from '@pnr/ai';
import { blockText } from '@pnr/core';
import { getWatch, listWatches, updateWatch, deleteWatch } from '@pnr/watch';
import { curatedRoutes } from '@pnr/feed';
import type { ActionView, AgentTool, NavTarget, Toolbox, ToolResult } from '@pnr/generate';
import type { Api } from './ipc.ts';

/**
 * What the news assistant can do in the app. Every tool calls the same function
 * the matching button calls — `createApi` (ipc.ts) or the runs in main.ts — so
 * locks, run records and progress messages come along unchanged.
 *
 * Risk levels live here, in code: the model cannot raise or lower them.
 *   read      looks something up                         never asks
 *   navigate  opens a page                               never asks
 *   write     a change that can be undone                asks in 「每次确认」
 *   heavy     costs money or time (AI runs, a download)  asks unless 「全部自动」
 *   danger    deletes or changes the system              asks unless 「全部自动」
 *
 * Deliberately NOT tools: anything that takes an API key or token (typed into
 * a conversation it would go to the model provider), deleting conversations,
 * the data folder. Article text never goes back to the model from here either:
 * tools return titles and ids, so a web page cannot talk the agent into a change.
 *
 * No Electron here, so the offline tests build the same toolbox.
 */

/** The main-process functions behind buttons that are not in `createApi`. */
export interface AppActions {
  refresh(): Promise<Record<string, unknown>>;
  runAll(force: boolean): Promise<Record<string, unknown>>;
  runFlashes(): Promise<Record<string, unknown>>;
  runWatch(id: string): Promise<Record<string, unknown>>;
  rewriteDigest(): Promise<Record<string, unknown>>;
  uiLanguage(): { choice: string; resolved: string };
  setUiLanguage(choice: 'system' | 'zh-CN' | 'en'): unknown;
  scheduleState(): unknown;
  setSchedule(on: boolean, hour?: number): Promise<unknown>;
  setWake(mode: 'off' | 'daily' | 'all'): Promise<unknown>;
  rssHub: {
    status(): Promise<unknown>;
    setInstance(url: string): void;
    install(): Promise<{ ok: boolean; error?: string; version?: string }>;
    remove(): Promise<boolean>;
    instance(): string;
  };
}

type Tool<S extends z.ZodType> = Omit<AgentTool<z.infer<S>>, 'args'> & { args: S };
const tool = <S extends z.ZodType>(t: Tool<S>): AgentTool => t as unknown as AgentTool;
const none = z.object({}).strict();
const id = z.string().min(1);
const clip = (s: string | null | undefined, n: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const day = (t: number | null | undefined): string | null => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : null);
const ok = (data: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, data, ...extra });
/** Drops absent optional fields (the api functions are typed without `undefined`). */
const defined = <T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
const fail = (error: string): ToolResult => ({ ok: false, error });
/** A result whose outcome the run reports: busy, an error, or done. */
const ran = (r: Record<string, unknown>): ToolResult =>
  r['busy'] ? fail('busy') : r['error'] ? fail('failed') : ok(r, { view: { fields: summary(r) } });
const summary = (r: Record<string, unknown>): ActionView['fields'] =>
  (['fetched', 'inserted', 'watches', 'flashes', 'failed'] as const).flatMap((k) => (typeof r[k] === 'number' ? [{ key: k, value: String(r[k]) }] : []));

const WATCH_FIELDS = ['label', 'intent', 'keywords', 'sensitivity', 'active', 'outputLang'] as const;
type WatchSnapshot = Pick<NonNullable<ReturnType<typeof getWatch>>, typeof WATCH_FIELDS[number]>;
const snapshot = (w: NonNullable<ReturnType<typeof getWatch>>): WatchSnapshot =>
  ({ label: w.label, intent: w.intent, keywords: w.keywords, sensitivity: w.sensitivity, active: w.active, outputLang: w.outputLang });
const show = (v: unknown): string => (Array.isArray(v) ? v.join('、') : v === null || v === undefined ? '' : String(v));

export function buildToolbox(db: Db, api: Api, actions: AppActions, hooks: { navigate(t: NavTarget): void; changed(): void }): Toolbox {
  const sourceRow = (sid: string) => db.prepare('SELECT id, name, domain, category, enabled, added_by AS addedBy FROM sources WHERE id = ?')
    .get(sid) as { id: string; name: string; domain: string | null; category: string | null; enabled: number; addedBy: string } | undefined;
  const itemRow = (iid: string) => db.prepare('SELECT id, title FROM items WHERE id = ?').get(iid) as { id: string; title: string } | undefined;
  const watchView = (wid: string): ActionView => {
    const w = getWatch(db, wid);
    return w ? { subject: w.label, fields: [{ key: 'intent', value: w.intent }], open: { kind: 'watch', watchId: w.id } } : { fields: [] };
  };
  const nav = (target: NavTarget, data: unknown = 'opened'): ToolResult => ok(data, { navigate: target });
  const lang = (): string => actions.uiLanguage().resolved;

  const tools: AgentTool[] = [
    // ── watches ────────────────────────────────────────────────────────────
    tool({ name: 'list_watches', risk: 'read', args: none, params: '{}',
      describe: 'The stories the person follows ("watches"/关注): id, name, their own words (intent), keywords, whether active, count of unseen developments.',
      async run() {
        return ok((api.watches() as ({ id: string; label: string; intent: string; keywords: string[]; active: boolean; sensitivity: string; newCount: number; timelineCount: number })[])
          .map((w) => ({ id: w.id, label: w.label, intent: w.intent, keywords: w.keywords, active: w.active, sensitivity: w.sensitivity, newDevelopments: w.newCount, timeline: w.timelineCount })));
      } }),
    tool({ name: 'watch_timeline', risk: 'read', args: z.object({ watchId: id }), params: '{"watchId": string}',
      describe: 'The timeline of developments of one watch, newest first, and the open questions it waits on.',
      async run({ watchId }) {
        if (!getWatch(db, watchId)) return fail('not_found');
        const t = api.watchTimeline(watchId) as { milestones: { occurredOn: string; summary: string; isNew: boolean }[]; questions: { question: string }[] };
        return ok({ milestones: t.milestones.slice(-15).reverse().map((m) => ({ on: m.occurredOn, isNew: m.isNew, summary: clip(m.summary, 240) })),
          openQuestions: t.questions.map((q) => q.question) });
      } }),
    tool({ name: 'watch_items', risk: 'read', args: z.object({ watchId: id, limit: z.number().int().min(1).max(40).optional() }), params: '{"watchId": string, "limit"?: number}',
      describe: 'Articles that passed a watch\'s filter, newest first, with the person\'s own verdict when given.',
      async run({ watchId, limit }) {
        return ok((api.watchItems(watchId, limit ?? 15) as { id: string; title: string; sourceName: string | null; publishedAt: number; verdict: string | null }[])
          .map((r) => ({ itemId: r.id, title: clip(r.title, 160), source: r.sourceName, publishedAt: day(r.publishedAt), verdict: r.verdict })));
      } }),
    tool({ name: 'list_presets', risk: 'read', args: none, params: '{}',
      describe: 'The ready-made topic library (预置主题) with ids and whether each is already followed.',
      async run() { return ok(api.presets(lang()).map((p) => ({ id: p.id, group: p.group, label: p.label, followed: p.enabled }))); } }),
    tool({ name: 'create_watch', risk: 'write', verbatim: ['intent'], editable: ['intent', 'label'],
      args: z.object({ label: z.string().min(1).max(40), intent: z.string().min(2).max(600), keywords: z.array(z.string()).max(20).optional() }),
      params: '{"label": short name, "intent": the person\'s own sentence, verbatim, "keywords"?: string[] (names and aliases that help find it)}',
      describe: 'Start following a story or topic.',
      preview: (a) => ({ subject: a.label, fields: [{ key: 'label', value: a.label, editable: true }, { key: 'intent', value: a.intent, editable: true },
        ...(a.keywords?.length ? [{ key: 'keywords', value: a.keywords.join('、') }] : [])] }),
      async run(a) {
        const w = api.addWatch({ label: a.label, intent: a.intent, keywords: a.keywords ?? [] }) as { id: string };
        return ok({ watchId: w.id, label: a.label }, { undo: { watchId: w.id }, view: { ...watchView(w.id), fields: [{ key: 'intent', value: a.intent },
          ...(a.keywords?.length ? [{ key: 'keywords', value: a.keywords.join('、') }] : [])] } });
      },
      async undo(u) { deleteWatch(db, (u as { watchId: string }).watchId); } }),
    tool({ name: 'add_presets', risk: 'write', args: z.object({ presetIds: z.array(id).min(1).max(10) }), params: '{"presetIds": string[]}',
      describe: 'Follow topics from the ready-made library (ids from list_presets).',
      preview: (a) => ({ fields: a.presetIds.map((p) => ({ key: 'preset', value: api.presets(lang()).find((x) => x.id === p)?.label ?? p })) }),
      async run({ presetIds }) {
        const before = new Set(listWatches(db).map((w) => w.id));
        const ids = api.addPresets(presetIds, lang());
        if (!ids.length) return fail('not_found');
        const added = ids.filter((x) => !before.has(x));
        return ok({ followed: ids }, { undo: { watchIds: added },
          view: { fields: ids.map((w) => ({ key: 'preset', value: getWatch(db, w)?.label ?? w })), open: { kind: 'watch', watchId: ids[0]! } } });
      },
      async undo(u) { for (const w of (u as { watchIds: string[] }).watchIds) deleteWatch(db, w); } }),
    tool({ name: 'update_watch', risk: 'write', verbatim: ['intent'], editable: ['intent', 'label'],
      args: z.object({ watchId: id, label: z.string().min(1).max(40).optional(), intent: z.string().min(2).max(600).optional(),
        keywords: z.array(z.string()).max(30).optional(), sensitivity: z.enum(['more', 'balanced', 'less']).optional(),
        active: z.boolean().optional(), outputLang: z.string().nullable().optional() }).strict(),
      params: '{"watchId": string, "label"?: string, "intent"?: the person\'s own words, "keywords"?: string[] (the full new list), "sensitivity"?: "more"|"balanced"|"less" (宁可多看/平衡/宁可少看), "active"?: boolean (pause/resume), "outputLang"?: language code or null}',
      describe: 'Change a watch: rename, reword, keywords, how strict its filter is, pause or resume, output language. There is no exclude list: to keep something out, change the intent in the person\'s words.',
      preview: (a) => {
        const w = getWatch(db, a.watchId); if (!w) return { fields: [] };
        return { subject: w.label, open: { kind: 'watch', watchId: w.id }, fields: WATCH_FIELDS.flatMap((k) => (a[k] === undefined ? []
          : [{ key: k, before: show(w[k]), value: show(a[k]), ...(k === 'intent' || k === 'label' ? { editable: true } : {}) }])) };
      },
      async run(a) {
        const cur = getWatch(db, a.watchId); if (!cur) return fail('not_found');
        const { watchId, ...patch } = a;
        const next = updateWatch(db, watchId, patch as never)!;
        return ok({ watchId, ...patch }, { undo: { watchId, before: snapshot(cur) }, view: { subject: next.label, open: { kind: 'watch', watchId },
          fields: WATCH_FIELDS.flatMap((k) => (patch[k] === undefined ? [] : [{ key: k, before: show(cur[k]), value: show(next[k]) }])) } });
      },
      async undo(u) { const { watchId, before } = u as { watchId: string; before: WatchSnapshot }; updateWatch(db, watchId, before as never); } }),
    tool({ name: 'delete_watch', risk: 'danger', args: z.object({ watchId: id }), params: '{"watchId": string}',
      describe: 'Stop following a watch and delete its timeline. Cannot be undone; to stop it for a while, update_watch active=false instead.',
      preview: ({ watchId }) => watchView(watchId),
      async run({ watchId }) {
        const view = watchView(watchId); if (!view.subject) return fail('not_found');
        api.removeWatch(watchId);
        const { open: _open, ...rest } = view;
        return ok({ deleted: watchId }, { view: rest });
      } }),
    tool({ name: 'correct_item', risk: 'write', verbatim: ['note'], editable: ['note'],
      args: z.object({ watchId: id, itemId: id, verdict: z.enum(['wanted', 'not_wanted']), note: z.string().max(400).optional() }),
      params: '{"watchId": string, "itemId": string, "verdict": "wanted"|"not_wanted", "note"?: the person\'s own words about why}',
      describe: 'Tell a watch that one article belongs in it or does not. The note teaches the filter; it must be the person\'s words.',
      preview: (a) => ({ subject: itemRow(a.itemId)?.title ?? a.itemId, fields: [{ key: 'watch', value: getWatch(db, a.watchId)?.label ?? a.watchId },
        { key: 'verdict', value: a.verdict }, ...(a.note ? [{ key: 'note', value: a.note, editable: true }] : [])] }),
      async run(a) {
        if (!getWatch(db, a.watchId) || !itemRow(a.itemId)) return fail('not_found');
        const gateBefore = (db.prepare('SELECT passed_gate AS g FROM matches WHERE watch_id = ? AND item_id = ?').get(a.watchId, a.itemId) as { g: number } | undefined)?.g ?? null;
        const lastId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM corrections').get() as { n: number }).n;
        api.correct(a.watchId, a.itemId, a.verdict, a.note);
        return ok({ corrected: a.itemId, verdict: a.verdict }, { undo: { ...a, gateBefore, lastId },
          view: { subject: itemRow(a.itemId)!.title, fields: [{ key: 'watch', value: getWatch(db, a.watchId)!.label }, { key: 'verdict', value: a.verdict }], open: { kind: 'watch', watchId: a.watchId, section: 'items' } } });
      },
      async undo(u) {
        const { watchId, itemId, gateBefore, lastId } = u as { watchId: string; itemId: string; gateBefore: number | null; lastId: number };
        db.transaction(() => {
          db.prepare('DELETE FROM corrections WHERE watch_id = ? AND item_id = ? AND id > ?').run(watchId, itemId, lastId);
          if (gateBefore !== null) db.prepare('UPDATE matches SET passed_gate = ? WHERE watch_id = ? AND item_id = ?').run(gateBefore, watchId, itemId);
        })();
      } }),
    tool({ name: 'run_watch', risk: 'heavy', args: z.object({ watchId: id }), params: '{"watchId": string}',
      describe: 'Update one watch now (立即更新): fetch, filter, and re-read its developments if there is new reporting. Uses AI.',
      preview: ({ watchId }) => watchView(watchId),
      async run({ watchId }) { return getWatch(db, watchId) ? ran(await actions.runWatch(watchId)) : fail('not_found'); } }),

    // ── sources ────────────────────────────────────────────────────────────
    tool({ name: 'list_sources', risk: 'read', args: none, params: '{}',
      describe: 'The subscribed sources: id, name, unread and total counts, last error.',
      async run() { return ok(api.listSources().map((s) => ({ id: s.id, name: s.name, kind: s.kind, unread: s.unread, total: s.total, newest: day(s.newest), lastError: s.lastError }))); } }),
    tool({ name: 'search_catalogue', risk: 'read',
      args: z.object({ q: z.string().max(80).optional(), category: z.string().optional(), country: z.string().optional() }),
      params: '{"q"?: words matching name, domain, category or country (Chinese or English), "category"?: key, "country"?: ISO code}',
      describe: 'Search the built-in catalogue of ~575 sources to subscribe to; each row says whether it is already subscribed. Every word must match, so use one or two short words (a name or domain); when nothing matches, try fewer words or the English name.',
      async run(a) {
        const r = api.catalogue({ ...defined(a), limit: 25 });
        return ok({ total: r.total, rows: r.rows.map((s) => ({ id: s.id, name: s.name, domain: s.domain, category: s.category, country: s.country, subscribed: s.enabled === 1 })) });
      } }),
    tool({ name: 'subscribe', risk: 'write', args: z.object({ sourceId: id }), params: '{"sourceId": string}',
      describe: 'Subscribe to a source already in the catalogue (or turn a switched-off one back on).',
      preview: ({ sourceId }) => ({ subject: sourceRow(sourceId)?.name ?? sourceId, fields: [{ key: 'domain', value: sourceRow(sourceId)?.domain ?? '' }] }),
      async run({ sourceId }) {
        const s = sourceRow(sourceId); if (!s || s.id.startsWith('search:')) return fail('not_found');
        api.setSourceEnabled(sourceId, true);
        return ok({ subscribed: s.name }, { undo: { sourceId, was: s.enabled }, view: { subject: s.name, fields: [], open: { kind: 'source', sourceId } } });
      },
      async undo(u) { const { sourceId, was } = u as { sourceId: string; was: number }; api.setSourceEnabled(sourceId, was === 1); } }),
    tool({ name: 'unsubscribe', risk: 'write', args: z.object({ sourceId: id }), params: '{"sourceId": string}',
      describe: 'Unsubscribe from a source. Its articles stay reachable from citations and 收藏.',
      preview: ({ sourceId }) => ({ subject: sourceRow(sourceId)?.name ?? sourceId, fields: [] }),
      async run({ sourceId }) {
        const s = sourceRow(sourceId); if (!s) return fail('not_found');
        api.setSourceEnabled(sourceId, false);
        return ok({ unsubscribed: s.name }, { undo: { sourceId, was: s.enabled }, view: { subject: s.name, fields: [] } });
      },
      async undo(u) { const { sourceId, was } = u as { sourceId: string; was: number }; api.setSourceEnabled(sourceId, was === 1); } }),
    tool({ name: 'add_source', risk: 'write',
      args: z.object({ value: z.string().min(2).max(2000), kind: z.enum(['auto', 'rss', 'news_sitemap', 'rsshub', 'telegram', 'reddit', 'github', 'hackernews', 'googlenews']).optional(), name: z.string().max(60).optional() }),
      params: '{"value": a feed or site address, a Telegram channel, a subreddit, an RSSHub route path, or news search words, "kind"?: "auto" (default) or a specific kind, "name"?: display name}',
      describe: 'Add a source that is not in the catalogue. It is fetched at once, so the result says whether it works.',
      preview: (a) => ({ subject: a.name ?? a.value, fields: [{ key: 'address', value: a.value }, ...(a.kind && a.kind !== 'auto' ? [{ key: 'kind', value: a.kind }] : [])] }),
      async run(a) {
        const r = await api.addSource({ kind: a.kind ?? 'auto', value: a.value, ...(a.name ? { name: a.name } : {}) });
        if (!r.ok) return fail(r.error ?? 'failed');
        return ok({ sourceId: r.id, name: r.name, items: r.items, problem: r.error ?? null }, { undo: { sourceId: r.id },
          view: { subject: r.name ?? a.value, fields: [{ key: 'items', value: String(r.items ?? 0) }], ...(r.error ? { reason: r.error } : {}), open: { kind: 'source', sourceId: r.id! } } });
      },
      async undo(u) { api.removeSource((u as { sourceId: string }).sourceId); } }),
    tool({ name: 'remove_source', risk: 'danger', args: z.object({ sourceId: id }), params: '{"sourceId": string}',
      describe: 'Delete a source the person added themselves, with its articles. Catalogue sources cannot be deleted: unsubscribe them.',
      preview: ({ sourceId }) => ({ subject: sourceRow(sourceId)?.name ?? sourceId, fields: [] }),
      async run({ sourceId }) {
        const s = sourceRow(sourceId); if (!s) return fail('not_found');
        if (s.addedBy !== 'user') return fail('catalogue_source');
        api.removeSource(sourceId);
        return ok({ removed: s.name }, { view: { subject: s.name, fields: [] } });
      } }),
    tool({ name: 'rsshub_routes', risk: 'read', args: z.object({ q: z.string().max(40).optional() }), params: '{"q"?: platform or name}',
      describe: 'Ready-made RSSHub routes (social platforms and sites without feeds) with their path templates.',
      async run({ q }) {
        const words = (q ?? '').toLowerCase();
        return ok(curatedRoutes().filter((r) => !words || `${r.platform} ${r.name} ${r.site ?? ''}`.toLowerCase().includes(words)).slice(0, 25)
          .map((r) => ({ platform: r.platform, name: r.name, path: r.path, example: r.example })));
      } }),
    tool({ name: 'match_route', risk: 'read', args: z.object({ url: z.string().url() }), params: '{"url": a page address}',
      describe: 'Which RSSHub route a page address (a profile, a channel) belongs to, and its path.',
      async run({ url }) { return ok(api.matchRoute(url)); } }),
    tool({ name: 'preview_route', risk: 'read', args: z.object({ path: z.string().min(2) }), params: '{"path": an RSSHub route path}',
      describe: 'Try an RSSHub route without saving anything: the first headlines, or why it fails.',
      async run({ path }) { return ok(await api.previewRoute(path)); } }),
    tool({ name: 'refresh_feeds', risk: 'write', args: none, params: '{}',
      describe: 'Fetch new articles from every subscribed source now (阅读 ↻). No AI.',
      async run() { return ran(await actions.refresh()); } }),

    // ── reading ────────────────────────────────────────────────────────────
    tool({ name: 'search_articles', risk: 'read',
      args: z.object({ q: z.string().max(80).optional(), sourceId: z.string().optional(), days: z.number().int().min(1).max(365).optional(), unread: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() }),
      params: '{"q"?: words in the headline, "sourceId"?: string, "days"?: number, "unread"?: boolean, "limit"?: number}',
      describe: 'Find articles in the person\'s library by headline words, source and age. Returns ids and headlines only.',
      async run(a) {
        return ok(api.searchItems(defined(a)).map((r) => ({ itemId: r.id, title: clip(r.title, 160), source: r.sourceName, sourceId: r.sourceId,
          publishedAt: day(r.publishedAt), read: Boolean(r.readAt), starred: Boolean(r.starredAt) })));
      } }),
    tool({ name: 'mark_read', risk: 'write',
      args: z.object({ itemIds: z.array(id).max(500).optional(), sourceId: z.string().optional(), allUnread: z.boolean().optional(), read: z.boolean().default(true) })
        .refine((a) => a.itemIds?.length || a.sourceId || a.allUnread, 'give itemIds, sourceId or allUnread'),
      params: '{"itemIds"?: string[], "sourceId"?: every unread article of this source, "allUnread"?: true for every unread article, "read"?: false to mark unread}',
      describe: 'Mark articles read (or unread).',
      preview: (a) => {
        const ids = a.itemIds?.length ? a.itemIds : api.unreadIds(a.sourceId);
        return { ...(a.sourceId ? { subject: sourceRow(a.sourceId)?.name ?? a.sourceId } : {}), fields: [{ key: a.read === false ? 'markUnread' : 'markRead', value: String(ids.length) }] };
      },
      async run(a) {
        const ids = a.itemIds?.length ? a.itemIds : api.unreadIds(a.sourceId);
        const before = api.markManyRead(ids, a.read !== false);
        return ok({ count: before.length }, { undo: { before }, view: { ...(a.sourceId ? { subject: sourceRow(a.sourceId)?.name ?? '' } : {}),
          fields: [{ key: a.read === false ? 'markUnread' : 'markRead', value: String(before.length) }] } });
      },
      async undo(u) { api.restoreRead((u as { before: { id: string; readAt: number | null }[] }).before); } }),
    tool({ name: 'star', risk: 'write', args: z.object({ itemId: id, starred: z.boolean() }), params: '{"itemId": string, "starred": boolean}',
      describe: 'Add an article to 收藏 (starred) or take it out.',
      preview: (a) => ({ subject: itemRow(a.itemId)?.title ?? a.itemId, fields: [] }),
      async run({ itemId, starred }) {
        const it = itemRow(itemId); if (!it) return fail('not_found');
        const was = Boolean((db.prepare('SELECT starred_at AS s FROM reading_state WHERE item_id = ?').get(itemId) as { s: number | null } | undefined)?.s);
        if (was !== starred) api.toggleStar(itemId);
        return ok({ itemId, starred }, { undo: { itemId, was }, view: { subject: it.title, fields: [], open: { kind: 'item', itemId } } });
      },
      async undo(u) {
        const { itemId, was } = u as { itemId: string; was: boolean };
        const now = Boolean((db.prepare('SELECT starred_at AS s FROM reading_state WHERE item_id = ?').get(itemId) as { s: number | null } | undefined)?.s);
        if (now !== was) api.toggleStar(itemId);
      } }),

    // ── today, flashes ─────────────────────────────────────────────────────
    tool({ name: 'get_today', risk: 'read', args: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), params: '{"date"?: "YYYY-MM-DD", default today}',
      describe: 'The daily brief the app wrote (今日摘要) and today\'s 关注之外 picks, as the app wrote them.',
      async run({ date }) {
        const t = api.today(date) as { date: string; digest: { title: string; blocks: never[] } | null; outside: { title?: string; eventTitle?: string }[] };
        return ok({ date: t.date, brief: t.digest ? { title: t.digest.title, text: clip(t.digest.blocks.map((b) => blockText(b)).join('\n'), 3000) } : null,
          outside: t.outside.map((p) => p.eventTitle ?? p.title ?? '') });
      } }),
    tool({ name: 'list_editions', risk: 'read', args: none, params: '{}', describe: 'Earlier daily briefs (往期): date and title.',
      async run() { return ok(api.editions()); } }),
    tool({ name: 'list_flashes', risk: 'read', args: z.object({ hours: z.number().int().min(1).max(168).optional(), watchId: z.string().optional() }),
      params: '{"hours"?: number (default 24), "watchId"?: string}', describe: 'Recent news flashes (快讯) the app wrote.',
      async run({ hours, watchId }) {
        return ok((api.flashes(hours ?? 24, watchId) as { id: string; title: string; publishedAt: number; importance: number; watchLabels: string[] }[])
          .map((f) => ({ id: f.id, title: f.title, at: day(f.publishedAt), importance: f.importance, watches: f.watchLabels })));
      } }),
    tool({ name: 'update_all', risk: 'heavy', args: z.object({ force: z.boolean().optional() }), params: '{"force"?: true rewrites everything (全部重新生成)}',
      describe: '全部更新: fetch every source, update every watch, the brief and flashes — only what changed, unless force. Uses AI.',
      preview: (a) => ({ fields: a.force ? [{ key: 'force', value: 'true' }] : [] }),
      async run({ force }) { return ran(await actions.runAll(Boolean(force))); } }),
    tool({ name: 'check_flashes', risk: 'heavy', args: none, params: '{}', describe: 'Check for new flashes now (快讯 ↻). Uses AI.',
      async run() { return ran(await actions.runFlashes()); } }),
    tool({ name: 'rewrite_digest', risk: 'heavy', args: none, params: '{}', describe: 'Rewrite today\'s brief only (重新生成), one AI call, no fetching.',
      async run() { return ran(await actions.rewriteDigest()); } }),
    tool({ name: 'open_report', risk: 'heavy', args: z.object({ itemId: id }), params: '{"itemId": string}',
      describe: 'Open a deep report (深度报道) on the story of one article; it is researched and written if it does not exist. Uses AI.',
      preview: ({ itemId }) => ({ subject: itemRow(itemId)?.title ?? itemId, fields: [] }),
      async run({ itemId }) { return itemRow(itemId) ? nav({ kind: 'report', itemId }) : fail('not_found'); } }),

    // ── settings ───────────────────────────────────────────────────────────
    tool({ name: 'get_settings', risk: 'read', args: none, params: '{}',
      describe: 'Current settings: AI provider and models (never keys), output language, search fill, outside picks, reading languages, interface language, background schedule.',
      async run() {
        const s = publicSettings(db) as unknown as Record<string, unknown>;
        return ok({ provider: s['provider'], writeModel: s['writeModel'], fastModel: s['fastModel'], outputLang: s['outputLang'],
          searchFillEnabled: s['searchFillEnabled'], outsidePicksEnabled: s['outsidePicksEnabled'],
          readingLanguages: api.readingLanguages().selected, uiLanguage: actions.uiLanguage().choice, schedule: actions.scheduleState() });
      } }),
    tool({ name: 'set_ai_option', risk: 'write',
      args: z.object({ key: z.enum(['outputLang', 'searchFillEnabled', 'outsidePicksEnabled']), value: z.string().min(1).max(20) }),
      params: '{"key": "outputLang" (language AI writes in, e.g. "zh-CN", "en") | "searchFillEnabled" | "outsidePicksEnabled", "value": language code, or "1"/"0"}',
      describe: 'Change an AI preference.',
      preview: (a) => ({ fields: [{ key: a.key, before: String((publicSettings(db) as unknown as Record<string, unknown>)[a.key] ?? ''), value: a.value }] }),
      async run({ key, value }) {
        const before = (publicSettings(db) as unknown as Record<string, unknown>)[key];
        api.setAiOption(key, value);
        const was = typeof before === 'boolean' ? (before ? '1' : '0') : String(before ?? '');
        return ok({ [key]: value }, { undo: { key, value: was }, view: { fields: [{ key, before: was, value }] } });
      },
      async undo(u) { const { key, value } = u as { key: 'outputLang'; value: string }; api.setAiOption(key, value); } }),
    tool({ name: 'set_reading_languages', risk: 'write', args: z.object({ langs: z.array(z.string().min(2).max(8)).max(20) }),
      params: '{"langs": ISO 639-1 codes; [] shows every language}', describe: 'Which article languages the reading lists show.',
      preview: (a) => ({ fields: [{ key: 'readingLanguages', before: api.readingLanguages().selected.join('、'), value: a.langs.join('、') }] }),
      async run({ langs }) {
        const before = api.readingLanguages().selected; api.setReadingLanguages(langs);
        return ok({ langs }, { undo: { langs: before }, view: { fields: [{ key: 'readingLanguages', before: before.join('、'), value: langs.join('、') }] } });
      },
      async undo(u) { api.setReadingLanguages((u as { langs: string[] }).langs); } }),
    tool({ name: 'set_ui_language', risk: 'write', args: z.object({ language: z.enum(['system', 'zh-CN', 'en']) }), params: '{"language": "system"|"zh-CN"|"en"}',
      describe: 'The app\'s interface language (not the language AI writes in).',
      preview: (a) => ({ fields: [{ key: 'uiLanguage', before: actions.uiLanguage().choice, value: a.language }] }),
      async run({ language }) {
        const before = actions.uiLanguage().choice; actions.setUiLanguage(language);
        return ok({ language }, { undo: { language: before }, view: { fields: [{ key: 'uiLanguage', before, value: language }] } });
      },
      async undo(u) { actions.setUiLanguage((u as { language: 'system' }).language); } }),
    tool({ name: 'schedule_state', risk: 'read', args: none, params: '{}', describe: 'Background updates: whether on, daily time, waking from sleep, recent runs.',
      async run() { return ok(actions.scheduleState()); } }),
    tool({ name: 'set_schedule', risk: 'danger', args: z.object({ on: z.boolean(), hour: z.number().int().min(0).max(23).optional() }),
      params: '{"on": boolean, "hour"?: 0-23, the daily brief time}', describe: 'Turn background updates (a macOS launch agent) on or off, and set the daily time.',
      preview: (a) => ({ fields: [{ key: 'schedule', value: a.on ? 'on' : 'off' }, ...(a.hour !== undefined ? [{ key: 'hour', value: `${a.hour}:00` }] : [])] }),
      async run({ on, hour }) { return ok(await actions.setSchedule(on, hour)); } }),
    tool({ name: 'set_wake', risk: 'danger', args: z.object({ mode: z.enum(['off', 'daily', 'all']) }),
      params: '{"mode": "off" | "daily" (wake for the brief) | "all" (also every 3 hours for flashes)}',
      describe: 'Wake the Mac from sleep for updates. macOS asks for the administrator password itself.',
      preview: (a) => ({ fields: [{ key: 'wake', value: a.mode }] }),
      async run({ mode }) { return ok(await actions.setWake(mode)); } }),
    tool({ name: 'rsshub_status', risk: 'read', args: none, params: '{}', describe: 'Whether social sources work: own RSSHub instance, the downloadable pack, or neither.',
      async run() { return ok(await actions.rssHub.status()); } }),
    tool({ name: 'rsshub_set_instance', risk: 'write', args: z.object({ url: z.string().max(300) }), params: '{"url": the person\'s own RSSHub address, "" to clear}',
      describe: 'Use the person\'s own RSSHub instance. Never suggest a public instance.',
      preview: (a) => ({ fields: [{ key: 'instance', before: actions.rssHub.instance(), value: a.url }] }),
      async run({ url }) {
        const before = actions.rssHub.instance(); actions.rssHub.setInstance(url);
        return ok({ url }, { undo: { url: before }, view: { fields: [{ key: 'instance', before, value: url }] } });
      },
      async undo(u) { actions.rssHub.setInstance((u as { url: string }).url); } }),
    tool({ name: 'rsshub_install', risk: 'heavy', args: none, params: '{}', describe: 'Download the social sources pack (about 63 MB) so RSSHub routes work without an instance.',
      async run() { const r = await actions.rssHub.install(); return r.ok ? ok(r) : fail(r.error ?? 'failed'); } }),
    tool({ name: 'rsshub_remove', risk: 'danger', args: none, params: '{}', describe: 'Delete the downloaded social sources pack to free space.',
      async run() { return (await actions.rssHub.remove()) ? ok('removed') : fail('failed'); } }),

    // ── pages ──────────────────────────────────────────────────────────────
    tool({ name: 'open_tab', risk: 'navigate', args: z.object({ tab: z.enum(['today', 'flashes', 'read', 'watches']) }),
      params: '{"tab": "today" (今日) | "flashes" (快讯) | "read" (阅读) | "watches" (关注)}', describe: 'Show one of the main sections.',
      async run({ tab }) { return nav({ kind: 'tab', tab }); } }),
    tool({ name: 'open_item', risk: 'navigate', args: z.object({ itemId: id }), params: '{"itemId": string}', describe: 'Open an article in the reader.',
      async run({ itemId }) { return itemRow(itemId) ? nav({ kind: 'item', itemId }) : fail('not_found'); } }),
    tool({ name: 'open_watch', risk: 'navigate', args: z.object({ watchId: id, section: z.enum(['timeline', 'items', 'settings']).optional() }),
      params: '{"watchId": string, "section"?: "timeline" | "items" (related reporting) | "settings"}', describe: 'Open a watch.',
      async run({ watchId, section }) { return getWatch(db, watchId) ? nav({ kind: 'watch', watchId, ...(section ? { section } : {}) }) : fail('not_found'); } }),
    tool({ name: 'open_source', risk: 'navigate', args: z.object({ sourceId: id }), params: '{"sourceId": string}', describe: 'Show one source\'s articles in 阅读.',
      async run({ sourceId }) { return sourceRow(sourceId) ? nav({ kind: 'source', sourceId }) : fail('not_found'); } }),
    tool({ name: 'open_settings', risk: 'navigate', args: z.object({ section: z.enum(['general', 'ai', 'sources', 'background']).optional() }),
      params: '{"section"?: "general" | "ai" (provider, keys, models) | "sources" (RSSHub, tokens) | "background"}',
      describe: 'Open the Settings window — the place for anything that needs a key or token.',
      async run({ section }) { return nav({ kind: 'settings', ...(section ? { section } : {}) }); } })
  ];

  return { tools, navigate: hooks.navigate, changed: hooks.changed };
}
