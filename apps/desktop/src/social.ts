import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { join } from 'node:path';
import type { Db } from '@pnr/store';
import {
  configureRssHub, rssHubMode, packState, installPack, removePack, type PackManifest
} from '@pnr/feed';

/**
 * The social-sources pack lives in the user's data directory, not inside the
 * app bundle, so it survives app updates and can be removed to reclaim ~370 MB
 * without reinstalling anything.
 */
export const SOCIAL_DIR = join(app.getPath('userData'), 'social-sources');

/** Published alongside each release; see scripts/build-rsshub-pack.sh. */
const MANIFEST_URL =
  'https://raw.githubusercontent.com/yb311/personal-newsroom/main/catalogs/data/rsshub-pack.json';

const get = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

const set = (db: Db, key: string, value: string): void => {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, Date.now());
};

/**
 * Points the adapter at whichever source of routes is configured.
 *
 * An instance the user runs wins over the downloaded pack: it is theirs, it
 * starts instantly, and it costs no disk. No public instance is used as a
 * default — that would hand a stranger's server the list of things they read.
 */
export function applyRssHubConfig(db: Db): void {
  const instance = get(db, 'rsshub.instanceUrl');
  configureRssHub({
    ...(instance ? { instanceUrl: instance } : {}),
    packageDir: SOCIAL_DIR
  });
}

export function socialApi(db: Db, getWin: () => BrowserWindow | null) {
  return {
    async status(): Promise<{
      mode: string; instanceUrl: string | null;
      pack: { installed: boolean; version: string | null; bytes: number | null };
      installing: boolean;
    }> {
      const st = await packState(SOCIAL_DIR);
      return {
        mode: await rssHubMode(),
        instanceUrl: get(db, 'rsshub.instanceUrl'),
        pack: { installed: st.installed, version: st.version, bytes: st.bytes },
        installing
      };
    },

    setInstance(url: string): void {
      const clean = url.trim().replace(/\/$/, '');
      set(db, 'rsshub.instanceUrl', clean);
      applyRssHubConfig(db);
    },

    async install(): Promise<{ ok: boolean; error?: string; version?: string }> {
      if (installing) return { ok: false, error: 'already_installing' };
      installing = true;
      try {
        const res = await fetch(MANIFEST_URL);
        if (!res.ok) throw new Error('manifest_unavailable');
        const manifest = (await res.json()) as PackManifest;
        const st = await installPack(SOCIAL_DIR, manifest, (p) => {
          getWin()?.webContents.send('social:progress', p);
        });
        applyRssHubConfig(db);
        return { ok: true, ...(st.version ? { version: st.version } : {}) };
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
      } finally {
        installing = false;
      }
    },

    async remove(): Promise<boolean> {
      await removePack(SOCIAL_DIR);
      applyRssHubConfig(db);
      return true;
    }
  };
}

let installing = false;
