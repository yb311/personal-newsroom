import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openDb, defaultDataDir, acquireLock, releaseLock } from '@pnr/store';
import { ingestAll } from '@pnr/feed';
import { enrichPending } from '@pnr/reader';
import { resolveProvider, readSettings } from '@pnr/ai';
import { listWatches, prepareWatch } from '@pnr/watch';
import { recallForWatch, judgeAll, gateWatch } from '@pnr/recall';
import { generateDigest, generateProgress, generateFlashes, generateDeepSummary } from '@pnr/generate';
import { createApi } from './ipc.ts';
import { socialApi, applyRssHubConfig, SOCIAL_DIR } from './social.ts';
import { enableSchedule, disableSchedule, scheduleState, recentRuns } from './schedule.ts';

const DATA_DIR = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const db = openDb(join(DATA_DIR, 'newsroom.db'));
const api = createApi(db);

seedCatalogueOnFirstRun();
applyRssHubConfig(db);

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 520,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f0f' : '#f5f2eb',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true }
  });
  const built = join(__dirname, 'renderer', 'index.html');
  if (existsSync(built)) void win.loadFile(built);
  else void win.loadURL('http://localhost:5173');

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  setDevDockIcon();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/** Unpackaged runs (`npm run dev`) get the generic Electron dock icon, because
 *  there is no bundle Info.plist to read `assets/icon.icns` from. Set it by
 *  hand so the app looks like itself while developing. A packaged build takes
 *  the icon from the bundle and skips this. */
function setDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  const icon = join(__dirname, '../../../assets/icon.png');
  if (existsSync(icon)) app.dock?.setIcon(icon);
}

/** Loads the bundled catalogue the first time the app runs. Sources marked
 *  `featured` start enabled so there is something to read immediately. */
function seedCatalogueOnFirstRun(): void {
  const already = (db.prepare('SELECT COUNT(*) c FROM sources').get() as { c: number }).c;
  if (already > 0) return;
  const candidates = [
    join(__dirname, '../catalogs/feeds.json'),
    join(dirname(__dirname), '../../catalogs/data/feeds.json')
  ];
  const path = candidates.find(existsSync);
  if (!path) return;
  const feeds = JSON.parse(readFileSync(path, 'utf8')) as any[];
  const ins = db.prepare(
    `INSERT INTO sources (id,kind,name,domain,url,category,lang,country,trust,enabled,date_hydration,added_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'catalog',?) ON CONFLICT(id) DO NOTHING`);
  const now = Date.now();
  db.transaction(() => {
    for (const f of feeds)
      ins.run(f.id, f.kind, f.name, f.domain ?? null, f.url, f.category ?? null, f.lang ?? null,
              f.country ?? null, f.trust, f.featured ? 1 : 0, f.dateHydration ?? null, now);
  })();
}

// ── IPC ────────────────────────────────────────────────────────────────────
const handle = <K extends keyof ReturnType<typeof createApi>>(name: K): void => {
  ipcMain.handle(`api:${String(name)}`, (_e, ...args: unknown[]) => (api[name] as any)(...args));
};
for (const k of Object.keys(api) as (keyof typeof api)[]) handle(k);

ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url));

let refreshing = false;
ipcMain.handle('app:refresh', async () => {
  if (refreshing) return { busy: true };
  if (!acquireLock(db, 'fetch')) return { busy: true };
  refreshing = true;
  const runId = `run-${Date.now()}`;
  db.prepare('INSERT INTO runs (id, kind, started_at) VALUES (?, ?, ?)').run(runId, 'fetch', Date.now());
  try {
    const r = await ingestAll(db, 8);
    win?.webContents.send('app:progress', { phase: 'extracting' });
    const e = await enrichPending(db, DATA_DIR, 40, 5);
    db.prepare("UPDATE runs SET finished_at=?, outcome='ok', stats_json=? WHERE id=?")
      .run(Date.now(), JSON.stringify({ ...r, ...e }), runId);
    return { busy: false, ...r, enriched: e };
  } catch (err) {
    db.prepare("UPDATE runs SET finished_at=?, outcome='failed', stats_json=? WHERE id=?")
      .run(Date.now(), JSON.stringify({ error: String(err) }), runId);
    return { busy: false, error: String(err) };
  } finally { refreshing = false; releaseLock(db, 'fetch'); }
});

ipcMain.handle('app:enrichOne', async (_e, id: string) => {
  const row = db.prepare('SELECT id, url FROM items WHERE id = ?').get(id) as { id: string; url: string } | undefined;
  if (!row) return null;
  const { enrichItem } = await import('@pnr/reader');
  return enrichItem(db, DATA_DIR, row);
});

/**
 * The AI pass: recall → judge → gate per watch, then ONE digest call covering
 * all of them, then per-watch progress.
 *
 * Merging the digest across watches is structural, not an optimisation: writing
 * dominates cost, so one call per watch would multiply the daily bill by the
 * number of watches.
 */
let running = false;
ipcMain.handle('app:runWatches', async () => {
  if (running) return { busy: true };
  const provider = await resolveProvider(db);
  if (!provider) return { noProvider: true };
  if (!acquireLock(db, 'watches')) return { busy: true };
  running = true;
  const runId = `watch-${Date.now()}`;
  db.prepare('INSERT INTO runs (id, kind, started_at) VALUES (?, ?, ?)').run(runId, 'daily', Date.now());
  const lang = readSettings(db).outputLang ?? 'zh-CN';
  try {
    const watches = listWatches(db, true);
    if (watches.length === 0) return { busy: false, watches: 0 };

    const ready = [];
    for (const w of watches) {
      win?.webContents.send('app:progress', { phase: 'watch', label: w.label });
      const prepared = await prepareWatch(db, provider, w);
      const candidates = await recallForWatch(db, provider, prepared, { windowHours: 72, maxJudged: 40 });
      await judgeAll(db, provider, prepared, candidates);
      gateWatch(db, prepared, 'balanced');
      ready.push(prepared);
    }

    win?.webContents.send('app:progress', { phase: 'writing' });
    const digest = await generateDigest(db, provider, ready, lang);
    for (const w of ready) {
      await generateProgress(db, provider, w, w.outputLang ?? lang);
    }

    db.prepare("UPDATE runs SET finished_at = ?, outcome = 'ok', stats_json = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify({ watches: ready.length, digest: Boolean(digest) }), runId);
    return { busy: false, watches: ready.length, digest: Boolean(digest) };
  } catch (err) {
    db.prepare("UPDATE runs SET finished_at = ?, outcome = 'failed', stats_json = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify({ error: String(err) }), runId);
    return { busy: false, error: String(err) };
  } finally { running = false; releaseLock(db, 'watches'); }
});

ipcMain.handle('app:deepSummary', async (_e, itemId: string) => {
  const provider = await resolveProvider(db);
  if (!provider) return { noProvider: true };
  const lang = readSettings(db).outputLang ?? 'zh-CN';
  try {
    return { summary: await generateDeepSummary(db, provider, DATA_DIR, itemId, lang) };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
});

/** Flashes run far more often than the daily pass, so they skip the search arm
 *  and reuse whatever recall already produced. */
ipcMain.handle('app:runFlashes', async () => {
  const provider = await resolveProvider(db);
  if (!provider) return { noProvider: true };
  if (!acquireLock(db, 'flashes', process.pid, 30 * 60_000)) return { busy: true };
  const lang = readSettings(db).outputLang ?? 'zh-CN';
  try {
    let published = 0;
    for (const w of listWatches(db, true)) {
      published += (await generateFlashes(db, provider, w, w.outputLang ?? lang)).length;
    }
    return { published };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
  finally { releaseLock(db, 'flashes'); }
});

// ── background schedule ────────────────────────────────────────────────────
ipcMain.handle('app:scheduleState', () => ({ ...scheduleState(db), runs: recentRuns(db) }));
ipcMain.handle('app:setSchedule', async (_e, on: boolean, hour?: number) =>
  on ? enableSchedule(db, DATA_DIR, hour ?? 7) : disableSchedule(db));

// ── social sources pack ────────────────────────────────────────────────────
const social = socialApi(db, () => win);
for (const name of Object.keys(social) as (keyof typeof social)[]) {
  ipcMain.handle(`social:${String(name)}`, (_e, ...args: unknown[]) => (social[name] as never as (...a: unknown[]) => unknown)(...args));
}
