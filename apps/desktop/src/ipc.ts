import type { Db } from '@pnr/store';
import { readBody } from '@pnr/store';
import { aiAvailable, checkConnection, readSettings, writeSetting, invalidateProvider, type AiConnection } from '@pnr/ai';
import { listWatches, createWatch, updateWatch, deleteWatch, enablePreset, PRESETS, localisePreset, addCorrection } from '@pnr/watch';
import { newSinceYesterday, timeline, getDigest, recentFlashes, openQuestions } from '@pnr/generate';
import { localDateKey } from '@pnr/core';
import { CATEGORIES, countryLabel } from '@pnr/core/catalog-labels';
import { ingestSource, rssHubMode, configureRssHub, resolveSourceInput, curatedRoutes, matchRouteFromUrl, adapterFor, normalizeItems, APIFY_TOKEN_KEY,
         packState, installPack, removePack, type PackManifest } from '@pnr/feed';

/** Everything the renderer can ask for. The renderer never touches SQLite
 *  directly; it asks through these, which keeps all storage logic in one place. */
export interface ItemRow {
  id: string; title: string; url: string; publishedAt: number;
  snippet: string | null; imageUrl: string | null; author: string | null;
  sourceName: string; sourceId: string; domain: string | null;
  bodyState: string; bodyWords: number | null;
  readAt: number | null; starredAt: number | null;
  /** 1 when the upstream gave no date and this is when we first saw it. */
  dateEstimated: number;
  /** ISO 639-1 code detected by the reader core, or null. */
  lang: string | null;
}

export interface SourceRow {
  id: string; name: string; kind: string; category: string | null;
  country: string | null; domain: string | null; enabled: number;
  unread: number; total: number; lastError: string | null;
  /** Publication time of the newest item, to spot sources that stopped publishing. */
  newest: number | null;
}

const ITEM_COLS = `
  i.id, i.title, i.url, i.published_at AS publishedAt, i.snippet, i.image_url AS imageUrl,
  i.author, s.name AS sourceName, s.id AS sourceId, i.body_state AS bodyState,
  i.body_words AS bodyWords, s.domain, r.read_at AS readAt, r.starred_at AS starredAt,
  i.date_estimated AS dateEstimated, i.lang`;

/** The reading-language filter: an empty list means every language is shown. */
const READING_LANGS_KEY = 'reader.languages';

export interface ItemBody { html: string; words: number; source: 'feed' | 'page' }

export interface CatalogueResult {
  rows: SourceRow[];
  /** Matches before the category/country filters. */
  total: number;
  categories: { key: string; count: number }[];
  countries: { key: string; count: number }[];
}

/**
 * How well one source matches the search words; 0 when any word matches
 * nothing. A word matches a category when it is part of the category's label
 * or a synonym: "新闻" matches both 综合新闻 and 国际新闻, "国际新闻" only the
 * latter. Latin words match whole words in names, so "ai" does not match "Daily".
 */
function scoreSource(s: SourceRow, words: string[]): number {
  if (words.length === 0) return 1;
  const cat = s.category ? [s.category, ...(CATEGORIES[s.category] ?? [])].map((x) => x.toLowerCase()) : [];
  const country = [s.country, countryLabel(s.country)].filter(Boolean).map((x) => x!.toLowerCase());
  const name = s.name.toLowerCase();
  const domain = (s.domain ?? '').toLowerCase();
  let total = 0;
  for (const w of words) {
    const latin = /^[a-z0-9.-]+$/.test(w);
    const word = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
    const has = (text: string): boolean => (latin ? word.test(text) : text.includes(w));
    const inName = has(name);
    const score =
      cat.some((c) => c === w) ? 100
      : cat.some((c) => c.includes(w) && (!latin || w.length >= 3)) ? 70
      : name.startsWith(w) && inName ? 60
      : inName ? 40
      : (w.length >= 4 ? domain.includes(w) : domain.split(/[.-]/).includes(w)) ? 30
      : country.some(has) ? 20
      : 0;
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/** What a citation needs to be shown and opened. */
export interface ItemRef { id: string; title: string; url: string; publishedAt: number; sourceName: string | null }

export interface ItemQuery { sourceId?: string; filter?: 'all' | 'unread' | 'starred' }

export function createApi(db: Db, dataDir: string) {
  const readingLangs = (): string[] => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(READING_LANGS_KEY) as { value: string } | undefined;
    try { return row ? (JSON.parse(row.value) as string[]) : []; } catch { return []; }
  };

  // Items whose language could not be determined are always shown: hiding
  // them would drop content for a guess we could not make.
  const itemFilter = (opts: ItemQuery): { where: string; params: unknown[] } => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.sourceId) { where.push('i.source_id = ?'); params.push(opts.sourceId); }
    if (opts.filter === 'unread') where.push('r.read_at IS NULL');
    if (opts.filter === 'starred') where.push('r.starred_at IS NOT NULL');
    const langs = readingLangs();
    if (langs.length) {
      where.push(`(i.lang IS NULL OR i.lang IN (${langs.map(() => '?').join(',')}))`);
      params.push(...langs);
    }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  };

  const refsFor = (ids: string[]): ItemRef[] => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    return db.prepare(
      `SELECT i.id, i.title, i.url, i.published_at AS publishedAt, s.name AS sourceName
       FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.id IN (${unique.map(() => '?').join(',')})`
    ).all(...unique) as ItemRef[];
  };

  return {
    listSources(): SourceRow[] {
      return db.prepare(`
        SELECT s.id, s.name, s.kind, s.category, s.country, s.domain, s.enabled, s.last_error AS lastError,
               COUNT(i.id) AS total, MAX(i.published_at) AS newest,
               SUM(CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END) AS unread
        FROM sources s
        LEFT JOIN items i ON i.source_id = s.id
        LEFT JOIN reading_state r ON r.item_id = i.id
        WHERE s.enabled = 1
        GROUP BY s.id ORDER BY s.name`).all() as SourceRow[];
    },

    listItems(opts: ItemQuery & { limit?: number; offset?: number }): ItemRow[] {
      const { where, params } = itemFilter(opts);
      return db.prepare(`
        SELECT ${ITEM_COLS} FROM items i
        JOIN sources s ON s.id = i.source_id
        LEFT JOIN reading_state r ON r.item_id = i.id
        ${where} ORDER BY i.published_at DESC LIMIT ? OFFSET ?`)
        .all(...params, opts.limit ?? 60, opts.offset ?? 0) as ItemRow[];
    },

    countItems(opts: ItemQuery): number {
      const { where, params } = itemFilter(opts);
      return (db.prepare(`
        SELECT COUNT(*) c FROM items i
        JOIN sources s ON s.id = i.source_id
        LEFT JOIN reading_state r ON r.item_id = i.id ${where}`).get(...params) as { c: number }).c;
    },

    /** Languages present among stored items, most common first, plus the
     *  current selection (empty = show all). */
    readingLanguages(): { available: { lang: string | null; count: number }[]; selected: string[] } {
      return {
        available: db.prepare('SELECT lang, COUNT(*) AS count FROM items GROUP BY lang ORDER BY count DESC').all() as { lang: string | null; count: number }[],
        selected: readingLangs()
      };
    },

    setReadingLanguages(langs: string[]): void {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(READING_LANGS_KEY, JSON.stringify(langs), Date.now());
    },

    getItem(id: string): (ItemRow & { body: ItemBody | null; bodyError: string | null }) | null {
      const row = db.prepare(`
        SELECT ${ITEM_COLS}, i.body_path AS bodyPath, i.body_error AS bodyError
        FROM items i JOIN sources s ON s.id = i.source_id
        LEFT JOIN reading_state r ON r.item_id = i.id WHERE i.id = ?`).get(id) as any;
      if (!row) return null;
      const { bodyPath, ...rest } = row;
      const b = readBody(bodyPath);
      return { ...rest, body: b ? { html: b.html, words: b.words, source: b.source } : null };
    },

    markRead(id: string, read: boolean): void {
      const now = Date.now();
      db.prepare(`INSERT INTO reading_state (item_id, read_at, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at, updated_at = excluded.updated_at`)
        .run(id, read ? now : null, now);
    },

    toggleStar(id: string): boolean {
      const now = Date.now();
      const cur = db.prepare('SELECT starred_at FROM reading_state WHERE item_id = ?').get(id) as { starred_at: number | null } | undefined;
      const next = cur?.starred_at ? null : now;
      db.prepare(`INSERT INTO reading_state (item_id, starred_at, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET starred_at = excluded.starred_at, updated_at = excluded.updated_at`)
        .run(id, next, now);
      return next !== null;
    },

    setSourceEnabled(id: string, enabled: boolean): void {
      db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },

    /**
     * Searches the catalogue. Every word has to match something about a
     * source — its name, domain, category (by key, Chinese label or a common
     * synonym) or country (in English or Chinese) — and results are ranked by
     * how they matched. Category and country filters narrow the result; the
     * counts for both are computed before those filters so the chips stay useful.
     */
    catalogue(opts: { q?: string; category?: string | null; country?: string | null; limit?: number } = {}): CatalogueResult {
      const all = db.prepare(`
        SELECT id, name, kind, category, country, domain, enabled, last_error AS lastError,
               0 AS unread, 0 AS total, NULL AS newest
        FROM sources WHERE added_by != 'search'`).all() as SourceRow[];
      const words = (opts.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const scored = all.map((s) => ({ s, score: scoreSource(s, words) })).filter((x) => x.score > 0);
      const count = (key: (s: SourceRow) => string | null) => {
        const m = new Map<string, number>();
        for (const { s } of scored) { const k = key(s); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
        return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, count: n }));
      };
      const rows = scored
        .filter(({ s }) => (!opts.category || s.category === opts.category) && (!opts.country || s.country === opts.country))
        .sort((a, b) => b.score - a.score || b.s.enabled - a.s.enabled || a.s.name.localeCompare(b.s.name))
        .slice(0, opts.limit ?? 300)
        .map((x) => x.s);
      return { rows, total: scored.length, categories: count((s) => s.category), countries: count((s) => s.country) };
    },

    // ── AI surfaces ────────────────────────────────────────────────────────
    // Every one of these works with AI switched off; they return empty shapes
    // rather than throwing, so the UI can show its "add a key" state.
    async aiStatus(): Promise<{ available: boolean; provider: string; outputLang: string }> {
      const s = readSettings(db);
      return {
        available: await aiAvailable(db),
        provider: s.provider ?? 'gemini',
        outputLang: s.outputLang ?? 'zh-CN'
      };
    },

    async saveAiSettings(patch: Record<string, string>): Promise<AiConnection> {
      for (const [k, v] of Object.entries(patch)) {
        writeSetting(db, k === 'outputLang' ? 'outputLang' : `ai.${k}`, v);
      }
      invalidateProvider();
      return checkConnection(db);
    },

    /** The topic library, in the interface language. */
    presets(lang?: string): { id: string; group: string; label: string; intent: string; keywords: string[]; enabled: boolean }[] {
      const on = new Set(listWatches(db).map((w) => w.id));
      return PRESETS.map((p) => ({ ...localisePreset(p, lang), enabled: on.has(p.id) }));
    },

    watches(): unknown[] {
      const count = db.prepare(
        `SELECT COUNT(*) AS candidates, SUM(passed_gate) AS passed FROM matches WHERE watch_id = ?`
      );
      return listWatches(db).map((w) => {
        const c = count.get(w.id) as { candidates: number; passed: number | null };
        return {
          ...w,
          newCount: newSinceYesterday(db, w.id).length,
          timelineCount: timeline(db, w.id).length,
          candidates: c.candidates, passed: c.passed ?? 0,
          openQuestions: openQuestions(db, w.id).length
        };
      });
    },

    addWatch(input: { label: string; intent: string; keywords?: string[]; outputLang?: string | null }): unknown {
      return createWatch(db, { origin: 'intent', label: input.label, intent: input.intent,
                               keywords: input.keywords ?? [], outputLang: input.outputLang ?? null });
    },
    /** Adds several presets at once, from the topic library. */
    addPresets(ids: string[], lang?: string): string[] {
      return ids.map((id) => enablePreset(db, id, lang)).filter((x): x is string => Boolean(x));
    },
    editWatch(id: string, patch: Record<string, unknown>): unknown { return updateWatch(db, id, patch as never); },
    removeWatch(id: string): void { deleteWatch(db, id); },
    togglePreset(id: string, on: boolean): void {
      if (on) enablePreset(db, id); else deleteWatch(db, id);
    },
    /**
     * The person's verdict on one article. It is stored in their own words for
     * the judge to read next time, and it takes effect at once: "不要" removes
     * the article from this watch, "要" keeps it.
     */
    correct(watchId: string, itemId: string, verdict: 'wanted' | 'not_wanted', note?: string): void {
      db.transaction(() => {
        addCorrection(db, watchId, itemId, verdict, note?.trim() || undefined);
        db.prepare('UPDATE matches SET passed_gate = ? WHERE watch_id = ? AND item_id = ?')
          .run(verdict === 'wanted' ? 1 : 0, watchId, itemId);
      })();
    },

    /** Whether to ask, once, about running in the background (first-run consent). */
    backgroundPrompt(): boolean {
      const asked = db.prepare("SELECT 1 FROM settings WHERE key = 'onboarding.backgroundAsked'").get();
      const on = db.prepare("SELECT value FROM settings WHERE key = 'schedule.enabled'").get() as { value: string } | undefined;
      return !asked && on?.value !== '1';
    },
    dismissBackgroundPrompt(): void {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('onboarding.backgroundAsked', '1', ?)
        ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`).run(Date.now());
    },

    flashes(hours = 24, watchId?: string): unknown[] {
      const labels = new Map(listWatches(db).map((w) => [w.id, w.label]));
      return recentFlashes(db, hours, watchId).map((f) => ({
        ...f,
        watchLabels: f.watchIds.map((id) => labels.get(id)).filter(Boolean),
        sources: refsFor(f.itemIds)
      }));
    },

    today(date?: string): unknown {
      const d = date ?? localDateKey();
      const digest = getDigest(db, d);
      const changes = listWatches(db, true).map((w) => ({
        watchId: w.id, label: w.label, milestones: newSinceYesterday(db, w.id)
      })).filter((x) => x.milestones.length > 0);
      const cited = [
        ...(digest?.blocks ?? []).flatMap((b) => ('sourceRefIds' in b ? b.sourceRefIds ?? [] : [])),
        ...changes.flatMap((c) => c.milestones.flatMap((m) => m.itemIds))
      ];
      return { date: d, digest, changes, refs: refsFor(cited) };
    },

    /**
     * 今日要闻 — the newest headlines of the last day from each subscribed
     * source. Needs no AI: it is what 今日 shows when none is connected, and
     * what follows the brief when one is.
     */
    headlines(hours = 24, perSource = 4): { sourceId: string; sourceName: string; items: ItemRow[] }[] {
      const langs = readingLangs();
      const langWhere = langs.length ? `AND (i.lang IS NULL OR i.lang IN (${langs.map(() => '?').join(',')}))` : '';
      const rows = db.prepare(`
        SELECT * FROM (
          SELECT ${ITEM_COLS},
                 ROW_NUMBER() OVER (PARTITION BY i.source_id ORDER BY i.published_at DESC) AS rank
          FROM items i JOIN sources s ON s.id = i.source_id
          LEFT JOIN reading_state r ON r.item_id = i.id
          WHERE s.enabled = 1 AND i.published_at >= ? ${langWhere}
        ) WHERE rank <= ? ORDER BY sourceName, publishedAt DESC`)
        .all(Date.now() - hours * 3600_000, ...langs, perSource) as (ItemRow & { rank: number })[];
      const groups = new Map<string, { sourceId: string; sourceName: string; items: ItemRow[] }>();
      for (const { rank: _rank, ...it } of rows) {
        const g = groups.get(it.sourceId) ?? { sourceId: it.sourceId, sourceName: it.sourceName, items: [] };
        g.items.push(it);
        groups.set(it.sourceId, g);
      }
      return [...groups.values()];
    },

    /** Titles and sources for cited item ids, so every citation can be opened. */
    itemRefs(ids: string[]): ItemRef[] { return refsFor(ids); },

    watchTimeline(id: string): unknown {
      const ms = timeline(db, id);
      return { milestones: ms, refs: refsFor(ms.flatMap((m) => m.itemIds)), questions: openQuestions(db, id) };
    },

    /** What passed for a watch, with the judge's score and reason (or a
     *  keyword-match marker) and the person's own verdict, if they gave one. */
    watchItems(id: string, limit = 60): unknown[] {
      return db.prepare(
        `SELECT ${ITEM_COLS}, m.intent_score AS score, m.reason, m.recalled_by AS arms,
                (SELECT verdict FROM corrections c WHERE c.watch_id = m.watch_id AND c.item_id = m.item_id
                 ORDER BY c.id DESC LIMIT 1) AS verdict
         FROM matches m JOIN items i ON i.id = m.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN reading_state r ON r.item_id = i.id
         WHERE m.watch_id = ? AND m.passed_gate = 1
         ORDER BY i.published_at DESC LIMIT ?`
      ).all(id, limit);
    },

    /**
     * Adds a source the user typed in. Everything is normalised to the same
     * `sources` row shape, so a Telegram channel and a newspaper's RSS feed go
     * down exactly the same pipeline afterwards.
     */
    async addSource(input: { kind: string; value: string; name?: string; category?: string }): Promise<{ ok: boolean; id?: string; name?: string; items?: number; error?: string }> {
      const resolved = resolveSourceInput(input.value, (input.kind as never) ?? 'auto');
      if (!resolved) return { ok: false, error: 'unrecognised' };
      const { kind, url, domain } = resolved;

      const id = `user-${kind}-${Buffer.from(url).toString('base64url').slice(0, 24)}`;
      if (db.prepare('SELECT 1 FROM sources WHERE id = ?').get(id)) {
        return { ok: false, error: 'duplicate' };
      }

      const name = input.name?.trim() || resolved.suggestedName;
      db.prepare(
        `INSERT INTO sources (id, kind, name, domain, url, category, trust, enabled, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0.9, 1, 'user', ?)`
      ).run(id, kind, name, domain, url, input.category ?? 'custom', Date.now());

      // Fetch immediately: a source that silently does nothing is worse than an
      // error, so the user finds out right away whether it works.
      const source = db.prepare(
        `SELECT id, kind, name, domain, url, category, lang, country, trust, enabled,
                date_hydration AS dateHydration, config_json AS configJson,
                etag, last_modified AS lastModified FROM sources WHERE id = ?`
      ).get(id) as never;
      const r = await ingestSource(db, source, { dataDir });
      if (r.kept === 0) {
        const err = (db.prepare('SELECT last_error AS e FROM sources WHERE id = ?').get(id) as { e: string | null }).e;
        return { ok: true, id, name, items: 0, ...(err ? { error: err } : { error: 'empty' }) };
      }
      return { ok: true, id, name, items: r.inserted };
    },

    removeSource(id: string): void {
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    },

    /** Whether an Apify token is stored (the token itself never leaves the main process). */
    hasApifyToken(): boolean {
      return Boolean(db.prepare('SELECT 1 FROM settings WHERE key = ? AND value != \'\'').get(APIFY_TOKEN_KEY));
    },
    setApifyToken(token: string): void {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(APIFY_TOKEN_KEY, token.trim(), Date.now());
    },

    /** The ready-made RSSHub routes, grouped by platform in the UI. */
    rsshubRoutes(): unknown[] { return curatedRoutes(); },

    /** Which ready-made route a pasted page address belongs to, if any. */
    matchRoute(url: string): { routeId: string; path: string } | null {
      const hit = matchRouteFromUrl(curatedRoutes(), url);
      return hit ? { routeId: hit.route.id, path: hit.path } : null;
    },

    /**
     * 试抓: fetches a route without saving anything, so the person sees what
     * they would get (or why it fails) before adding it.
     */
    async previewRoute(path: string): Promise<{ ok: boolean; titles: string[]; reason?: string }> {
      const adapter = adapterFor('rsshub');
      if (!adapter) return { ok: false, titles: [], reason: 'rsshub_not_available' };
      const source = { id: 'preview', kind: 'rsshub', name: '', domain: null, url: path, category: null, lang: null,
                       country: null, trust: 0.5, enabled: 1, dateHydration: null, configJson: null } as const;
      try {
        const res = await adapter(source as never, { db });
        if (res.items.length === 0) {
          return { ok: false, titles: [], reason: Object.keys(res.diagnostics.droppedByReason)[0] ?? 'empty' };
        }
        const items = await normalizeItems(res.items.slice(0, 5));
        return { ok: true, titles: items.map((i) => i.title) };
      } catch { return { ok: false, titles: [], reason: 'route_error' }; }
    },

    async rssHubReady(): Promise<boolean> { return (await rssHubMode()) !== 'off'; },

    stats(): { items: number; sources: number; unread: number; lastRun: number | null } {
      const i = db.prepare('SELECT COUNT(*) c FROM items').get() as { c: number };
      const s = db.prepare('SELECT COUNT(*) c FROM sources WHERE enabled = 1').get() as { c: number };
      const u = db.prepare('SELECT COUNT(*) c FROM items i LEFT JOIN reading_state r ON r.item_id = i.id WHERE r.read_at IS NULL').get() as { c: number };
      const l = db.prepare('SELECT MAX(started_at) m FROM runs').get() as { m: number | null };
      return { items: i.c, sources: s.c, unread: u.c, lastRun: l.m };
    }
  };
}

export type Api = ReturnType<typeof createApi>;
