import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setSink } from '@pnr/core';
import { openDb, defaultDataDir, acquireLock, releaseLock, renewLock, HEARTBEAT_MS } from '@pnr/store';
import { ingestAll, setCuratedRoutes } from '@pnr/feed';
import { enrichPending } from '@pnr/reader';
import { resolveProvider, readSettings, writeSetting, type Provider } from '@pnr/ai';
import { runDaily, runFlashCheck, runWatch, generateDeepSummary, type RunOptions, type RunResult } from '@pnr/generate';
import { createApi } from './ipc.ts';
import { socialApi, applyRssHubConfig, SOCIAL_DIR } from './social.ts';
import { enableSchedule, disableSchedule, scheduleState, recentRuns } from './schedule.ts';
import zhCN from '../../renderer/src/locales/zh-CN.json';
import en from '../../renderer/src/locales/en.json';

// `productName` controls packaged builds. This keeps development builds from
// showing the workspace package name in the menu bar and About panel.
app.setName('所闻');

// One app, one window. A second launch hands focus to the running instance and
// exits before it can open the database or start fetching on its own.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const DATA_DIR = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const db = openDb(join(DATA_DIR, 'newsroom.db'));

// Structured events go to the database as the worker's do, so run history and
// the recall audit's cost figures include what was run from the window.
// A month is kept; the console still gets everything during development.
let currentRun: string | null = null;
db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - 30 * 864e5);
const insEvent = db.prepare(
  `INSERT INTO events (run_id, at, event, stage, phase, entity_type, entity_id, outcome, reason_code, reason_detail, elapsed_ms, attrs_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
setSink((e) => {
  if (!app.isPackaged) console.log(`[${new Date().toISOString()}] ${e.event} ${e.phase ?? ''} ${e.attrs ? JSON.stringify(e.attrs) : ''}`);
  try {
    insEvent.run(currentRun, Date.now(), e.event, e.stage ?? null, e.phase ?? null, e.entityType ?? null, e.entityId ?? null,
                 e.outcome ?? null, e.reasonCode ?? null, e.reasonDetail ?? null, e.elapsedMs ?? null, e.attrs ? JSON.stringify(e.attrs) : null);
  } catch { /* logging must never break a run */ }
});
const api = createApi(db, DATA_DIR);

seedCatalogue();
applyRssHubConfig(db);
const routes = bundled('rsshub-routes.json');
if (routes) setCuratedRoutes(JSON.parse(readFileSync(routes, 'utf8')));

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 720, minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true }
  });
  const built = join(__dirname, 'renderer', 'index.html');
  if (existsSync(built)) void win.loadFile(built);
  else void win.loadURL('http://localhost:5173');

  // External links open in the real browser, never inside the app: new-window
  // requests (article links carry target=_blank) and in-place navigation alike.
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win?.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  setDevDockIcon();
  installApplicationMenu();
  app.setAboutPanelOptions({
    applicationName: '所闻',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 yb311'
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── interface language ──────────────────────────────────────────────────────
// Stored as 'system' | 'zh-CN' | 'en'. "Match system" is resolved here, where
// the OS languages are known; anything Chinese gets Chinese, the rest English.
type UiChoice = 'system' | 'zh-CN' | 'en';
const UI_LANGUAGE_KEY = 'ui.language';
function uiLanguage(): { choice: UiChoice; resolved: 'zh-CN' | 'en' } {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(UI_LANGUAGE_KEY) as { value: string } | undefined;
  const choice = (row?.value === 'zh-CN' || row?.value === 'en' ? row.value : 'system') as UiChoice;
  const system = app.getPreferredSystemLanguages()[0] ?? app.getLocale();
  return { choice, resolved: choice === 'system' ? (system.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en') : choice };
}
ipcMain.handle('app:uiLanguage', () => uiLanguage());
ipcMain.handle('app:setUiLanguage', (_e, choice: UiChoice) => {
  writeSetting(db, UI_LANGUAGE_KEY, choice === 'zh-CN' || choice === 'en' ? choice : 'system');
  installApplicationMenu();
  return uiLanguage();
});

/** The menu, from the same dictionaries as the window. */
function installApplicationMenu(): void {
  const m = (uiLanguage().resolved === 'en' ? en : zhCN).menu;
  const tabs = (uiLanguage().resolved === 'en' ? en : zhCN).tabs;
  const send = (command: string) => () => win?.webContents.send('app:command', command);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '所闻',
      submenu: [
        { role: 'about', label: m.about },
        { label: m.settings, accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'services', label: m.services },
        { type: 'separator' },
        { role: 'hide', label: m.hide },
        { role: 'hideOthers', label: m.hideOthers },
        { role: 'unhide', label: m.unhide },
        { type: 'separator' },
        { role: 'quit', label: m.quit }
      ]
    },
    { label: m.file, submenu: [
      { label: m.subscribe, accelerator: 'CmdOrCtrl+N', click: send('subscribe') },
      { role: 'close', label: m.close }
    ] },
    {
      label: m.edit,
      submenu: [
        { role: 'undo', label: m.undo }, { role: 'redo', label: m.redo },
        { type: 'separator' },
        { role: 'cut', label: m.cut }, { role: 'copy', label: m.copy },
        { role: 'paste', label: m.paste }, { role: 'selectAll', label: m.selectAll }
      ]
    },
    { label: m.view, submenu: [
      ...(['today', 'flashes', 'read', 'watches'] as const).map((id, i) => ({ label: tabs[id], accelerator: `CmdOrCtrl+${i + 1}`, click: send(id) })),
      { type: 'separator' as const },
      { label: m.sidebar, accelerator: 'CmdOrCtrl+Ctrl+S', click: send('sidebar') },
      { label: m.search, accelerator: 'CmdOrCtrl+F', click: send('search') },
      { label: m.refresh, accelerator: 'CmdOrCtrl+R', click: send('refresh') },
      { role: 'togglefullscreen', label: m.fullscreen }
    ] },
    {
      label: m.window,
      submenu: [
        { role: 'minimize', label: m.minimize },
        { role: 'zoom', label: m.zoom },
        { type: 'separator' },
        { role: 'front', label: m.front }
      ]
    }
  ]));
}

/** Unpackaged runs (`npm run dev`) get the generic Electron dock icon, because
 *  there is no bundle Info.plist to read `assets/icon.icns` from. Set it by
 *  hand so the app looks like itself while developing. A packaged build takes
 *  the icon from the bundle and skips this. */
function setDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  const icon = join(__dirname, '../../../assets/icon.png');
  if (existsSync(icon)) app.dock?.setIcon(icon);
}

/**
 * Merges the bundled catalogue into the database on every launch. A fresh
 * install gets every source, with `featured` ones switched on so there is
 * something to read immediately. Later versions add their new sources
 * (switched off) and refresh names and categories of catalogue sources, but
 * never change which sources the person has switched on or off.
 */
/** Bundled data files: next to the build in a package, in catalogs/data in the repo. */
function bundled(name: string): string | undefined {
  return [join(__dirname, '../catalogs', name), join(dirname(__dirname), '../../catalogs/data', name)].find(existsSync);
}

function seedCatalogue(): void {
  const fresh = (db.prepare('SELECT COUNT(*) c FROM sources').get() as { c: number }).c === 0;
  const path = bundled('feeds.json');
  if (!path) return;
  const feeds = JSON.parse(readFileSync(path, 'utf8')) as any[];
  const upsert = db.prepare(
    `INSERT INTO sources (id,kind,name,domain,url,category,lang,country,trust,enabled,date_hydration,added_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'catalog',?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain, category = excluded.category,
       country = excluded.country WHERE sources.added_by = 'catalog'`);
  const now = Date.now();
  db.transaction(() => {
    for (const f of feeds)
      upsert.run(f.id, f.kind, f.name, f.domain ?? null, f.url, f.category ?? null, f.lang ?? null,
                 f.country ?? null, f.trust, fresh && f.featured ? 1 : 0, f.dateHydration ?? null, now);
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
    const r = await ingestAll(db, 8, { dataDir: DATA_DIR });
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
 * The runs behind 今日, 快讯 and a single watch's "立即更新". They live in
 * @pnr/generate so the background worker runs exactly the same thing; this
 * only adds locking, run bookkeeping and progress messages for the window.
 * With no AI connected they still run, matching watches by their keywords.
 */
async function run(kind: 'daily' | 'flashes', lock: string, task: (provider: Provider | null, opts: RunOptions) => Promise<RunResult>) {
  if (!acquireLock(db, lock)) return { busy: true };
  const beat = setInterval(() => renewLock(db, lock), HEARTBEAT_MS);
  const runId = `${kind}-${Date.now()}`;
  db.prepare('INSERT INTO runs (id, kind, started_at) VALUES (?, ?, ?)').run(runId, kind, Date.now());
  currentRun = runId;
  try {
    const provider = await resolveProvider(db);
    const result = await task(provider, {
      dataDir: DATA_DIR,
      lang: readSettings(db).outputLang ?? 'zh-CN',
      onProgress: (p) => win?.webContents.send('app:progress', p)
    });
    db.prepare('UPDATE runs SET finished_at = ?, outcome = ?, stats_json = ? WHERE id = ?')
      .run(Date.now(), result.failed ? 'partial' : 'ok', JSON.stringify(result), runId);
    return { busy: false, ...result };
  } catch (err) {
    db.prepare("UPDATE runs SET finished_at = ?, outcome = 'failed', stats_json = ? WHERE id = ?")
      .run(Date.now(), JSON.stringify({ error: String(err) }), runId);
    return { busy: false, error: String(err).slice(0, 160) };
  } finally { currentRun = null; clearInterval(beat); releaseLock(db, lock); }
}

// Lock names match the worker's, so the app and a scheduled run never do the same job at once.
ipcMain.handle('app:runWatches', () => run('daily', 'daily', (p, o) => runDaily(db, p, o)));
ipcMain.handle('app:runFlashes', () => run('flashes', 'flashes', (p, o) => runFlashCheck(db, p, o)));
ipcMain.handle('app:runWatch', (_e, id: string) => run('daily', 'daily', (p, o) => runWatch(db, p, id, o)));

ipcMain.handle('app:deepSummary', async (_e, itemId: string) => {
  const provider = await resolveProvider(db);
  if (!provider) return { noProvider: true };
  const lang = readSettings(db).outputLang ?? 'zh-CN';
  try {
    return { summary: await generateDeepSummary(db, provider, DATA_DIR, itemId, lang) };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
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
