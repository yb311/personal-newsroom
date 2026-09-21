import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openDb, defaultDataDir, acquireLock, releaseLock, renewLock, HEARTBEAT_MS } from '@pnr/store';
import { ingestAll } from '@pnr/feed';
import { enrichPending } from '@pnr/reader';
import { resolveProvider, readSettings, type Provider } from '@pnr/ai';
import { runDaily, runFlashCheck, runWatch, generateDeepSummary, type RunOptions, type RunResult } from '@pnr/generate';
import { createApi } from './ipc.ts';
import { socialApi, applyRssHubConfig, SOCIAL_DIR } from './social.ts';
import { enableSchedule, disableSchedule, scheduleState, recentRuns } from './schedule.ts';

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
const api = createApi(db, DATA_DIR);

seedCatalogueOnFirstRun();
applyRssHubConfig(db);

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

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '所闻',
      submenu: [
        { role: 'about', label: '关于所闻' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('app:command', 'settings') },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏所闻' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出所闻' }
      ]
    },
    { label: '文件', submenu: [
      { label: '添加订阅…', accelerator: 'CmdOrCtrl+N', click: () => win?.webContents.send('app:command', 'subscribe') },
      { role: 'close', label: '关闭窗口' }
    ] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
      ]
    },
    { label: '显示', submenu: [
      ...(['今日', '快讯', '阅读', '关注'] as const).map((label, i) => ({ label, accelerator: `CmdOrCtrl+${i + 1}`, click: () => win?.webContents.send('app:command', ['today', 'flashes', 'read', 'watches'][i]) })),
      { type: 'separator' as const },
      { label: '显示或隐藏侧边栏', accelerator: 'CmdOrCtrl+Ctrl+S', click: () => win?.webContents.send('app:command', 'sidebar') },
      { label: '搜索文章', accelerator: 'CmdOrCtrl+F', click: () => win?.webContents.send('app:command', 'search') },
      { label: '更新订阅', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.send('app:command', 'refresh') },
      { role: 'togglefullscreen', label: '进入全屏幕' }
    ] },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
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
  } finally { clearInterval(beat); releaseLock(db, lock); }
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
