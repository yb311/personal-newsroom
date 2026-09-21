import type { Db } from '@pnr/store';
import { readFileSync, existsSync } from 'node:fs';
import { aiAvailable, checkConnection, readSettings, writeSetting, invalidateProvider, type AiConnection } from '@pnr/ai';
import { listWatches, createWatch, updateWatch, deleteWatch, enablePreset, PRESETS, addCorrection } from '@pnr/watch';
import { newSinceYesterday, timeline, getDigest, recentFlashes } from '@pnr/generate';
import { ingestSource, rssHubMode, configureRssHub, resolveSourceInput, SUGGESTED_ROUTES,
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
}

export interface SourceRow {
  id: string; name: string; kind: string; category: string | null;
  country: string | null; domain: string | null; enabled: number;
  unread: number; total: number; lastError: string | null;
}

const ITEM_COLS = `
  i.id, i.title, i.url, i.published_at AS publishedAt, i.snippet, i.image_url AS imageUrl,
  i.author, s.name AS sourceName, s.id AS sourceId, i.body_state AS bodyState,
  i.body_words AS bodyWords, s.domain, r.read_at AS readAt, r.starred_at AS starredAt,
  i.date_estimated AS dateEstimated`;

export function createApi(db: Db) {
  return {
    listSources(): SourceRow[] {
      return db.prepare(`
        SELECT s.id, s.name, s.kind, s.category, s.country, s.domain, s.enabled, s.last_error AS lastError,
               COUNT(i.id) AS total,
               SUM(CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END) AS unread
        FROM sources s
        LEFT JOIN items i ON i.source_id = s.id
        LEFT JOIN reading_state r ON r.item_id = i.id
        WHERE s.enabled = 1
        GROUP BY s.id ORDER BY s.name`).all() as SourceRow[];
    },

    listItems(opts: { sourceId?: string; filter?: 'all' | 'unread' | 'starred'; limit?: number; offset?: number }): ItemRow[] {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.sourceId) { where.push('i.source_id = ?'); params.push(opts.sourceId); }
      if (opts.filter === 'unread') where.push('r.read_at IS NULL');
      if (opts.filter === 'starred') where.push('r.starred_at IS NOT NULL');
      params.push(opts.limit ?? 60, opts.offset ?? 0);
      return db.prepare(`
        SELECT ${ITEM_COLS} FROM items i
        JOIN sources s ON s.id = i.source_id
        LEFT JOIN reading_state r ON r.item_id = i.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY i.published_at DESC LIMIT ? OFFSET ?`).all(...params) as ItemRow[];
    },

    getItem(id: string): (ItemRow & { blocks: unknown[] | null }) | null {
      const row = db.prepare(`
        SELECT ${ITEM_COLS}, i.body_path AS bodyPath, i.body_error AS bodyError
        FROM items i JOIN sources s ON s.id = i.source_id
        LEFT JOIN reading_state r ON r.item_id = i.id WHERE i.id = ?`).get(id) as any;
      if (!row) return null;
      let blocks: unknown[] | null = null;
      if (row.bodyPath && existsSync(row.bodyPath)) {
        try { blocks = JSON.parse(readFileSync(row.bodyPath, 'utf8')).blocks; } catch { /* fall back to snippet */ }
      }
      return { ...row, blocks };
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

    catalogue(q: string, limit = 200): SourceRow[] {
      const like = `%${q}%`;
      return db.prepare(`
        SELECT id, name, kind, category, country, domain, enabled, last_error AS lastError, 0 AS unread, 0 AS total
        FROM sources WHERE (? = '' OR name LIKE ? OR domain LIKE ? OR category LIKE ?)
        ORDER BY enabled DESC, name LIMIT ?`).all(q, like, like, like, limit) as SourceRow[];
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

    presets(): { id: string; label: string; intent: string; enabled: boolean }[] {
      const on = new Set(listWatches(db).map((w) => w.id));
      return PRESETS.map((p) => ({ ...p, enabled: on.has(p.id) }));
    },

    watches(): unknown[] {
      return listWatches(db).map((w) => ({
        ...w,
        newCount: newSinceYesterday(db, w.id).length,
        timelineCount: timeline(db, w.id).length,
        passed: (db.prepare('SELECT COUNT(*) c FROM matches WHERE watch_id = ? AND passed_gate = 1').get(w.id) as { c: number }).c
      }));
    },

    addWatch(input: { label: string; intent: string; outputLang?: string }): unknown {
      return createWatch(db, { origin: 'intent', label: input.label, intent: input.intent,
                               outputLang: input.outputLang ?? null });
    },
    editWatch(id: string, patch: Record<string, unknown>): unknown { return updateWatch(db, id, patch as never); },
    removeWatch(id: string): void { deleteWatch(db, id); },
    togglePreset(id: string, on: boolean): void {
      if (on) enablePreset(db, id); else deleteWatch(db, id);
    },
    correct(watchId: string, itemId: string, verdict: 'wanted' | 'not_wanted', note?: string): void {
      addCorrection(db, watchId, itemId, verdict, note);
    },

    flashes(hours = 24, watchId?: string): unknown[] {
      const labels = new Map(listWatches(db).map((w) => [w.id, w.label]));
      return recentFlashes(db, hours, watchId).map((f) => ({ ...f, watchLabel: labels.get(f.watchId ?? '') ?? null }));
    },

    today(date?: string): unknown {
      const d = date ?? new Date().toISOString().slice(0, 10);
      const digest = getDigest(db, d);
      const changes = listWatches(db, true).map((w) => ({
        watchId: w.id, label: w.label, milestones: newSinceYesterday(db, w.id)
      })).filter((x) => x.milestones.length > 0);
      return { date: d, digest, changes };
    },

    watchTimeline(id: string): unknown {
      const ms = timeline(db, id);
      const ids = [...new Set(ms.flatMap((m) => m.itemIds))];
      const items = ids.length
        ? db.prepare(`SELECT id, title, url FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        : [];
      return { milestones: ms, items };
    },

    watchItems(id: string, limit = 60): unknown[] {
      return db.prepare(
        `SELECT ${ITEM_COLS}, m.intent_score AS score, m.reason, m.recalled_by AS arms
         FROM matches m JOIN items i ON i.id = m.item_id
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN reading_state r ON r.item_id = i.id
         WHERE m.watch_id = ? AND m.passed_gate = 1
         ORDER BY m.intent_score DESC, i.published_at DESC LIMIT ?`
      ).all(id, limit);
    },

    /**
     * Adds a source the user typed in. Everything is normalised to the same
     * `sources` row shape, so a Telegram channel and a newspaper's RSS feed go
     * down exactly the same pipeline afterwards.
     */
    async addSource(input: { kind: string; value: string; name?: string; category?: string }): Promise<{ ok: boolean; id?: string; name?: string; items?: number; error?: string }> {
      const resolved = resolveSourceInput(input.value, (input.kind as never) ?? 'auto');
      if (!resolved) return { ok: false, error: '看不懂这是什么，换个格式试试' };
      const { kind, url, domain } = resolved;

      const id = `user-${kind}-${Buffer.from(url).toString('base64url').slice(0, 24)}`;
      if (db.prepare('SELECT 1 FROM sources WHERE id = ?').get(id)) {
        return { ok: false, error: '这个源已经添加过了' };
      }

      const name = input.name?.trim() || resolved.suggestedName;
      db.prepare(
        `INSERT INTO sources (id, kind, name, domain, url, category, trust, enabled, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0.9, 1, 'user', ?)`
      ).run(id, kind, name, domain, url, input.category ?? '自定义', Date.now());

      // Fetch immediately: a source that silently does nothing is worse than an
      // error, so the user finds out right away whether it works.
      const source = db.prepare(
        `SELECT id, kind, name, domain, url, category, lang, country, trust, enabled,
                date_hydration AS dateHydration, config_json AS configJson FROM sources WHERE id = ?`
      ).get(id) as never;
      const r = await ingestSource(db, source);
      if (r.kept === 0) {
        const err = (db.prepare('SELECT last_error AS e FROM sources WHERE id = ?').get(id) as { e: string | null }).e;
        return { ok: true, id, name, items: 0, ...(err ? { error: err } : { error: '暂时没抓到内容' }) };
      }
      return { ok: true, id, name, items: r.inserted };
    },

    removeSource(id: string): void {
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    },

    suggestedRoutes(): unknown[] { return SUGGESTED_ROUTES; },

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
