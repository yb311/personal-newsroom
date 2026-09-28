import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import {
  type UpdateState, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, AUTO_UPDATE_KEY, MOVE_DECLINED_KEY,
  autoEnabled, support, failureReason, notesText
} from './update-logic.ts';
import type zhCN from '../../renderer/src/locales/zh-CN.json';

/**
 * Software updates from GitHub Releases (electron-updater, Squirrel.Mac).
 *
 * The app looks for a new version at launch and every six hours, downloads it
 * in the background, and once it is ready asks whether to restart now. "Later"
 * installs it at the next quit. Only GitHub is contacted, and only for the
 * release metadata and the signed zip; Squirrel refuses a download that is not
 * signed by the same team.
 *
 * Development runs never check. A copy running outside /Applications cannot
 * replace itself, so it offers to move there first.
 */

type Texts = typeof zhCN.update;

export interface UpdaterDeps {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  texts(): Texts;
  window(): BrowserWindow | null;
  broadcast(state: UpdateState): void;
  log(event: string, attrs?: Record<string, unknown>): void;
}

const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

export function createUpdater(deps: UpdaterDeps) {
  const inApplications = app.isPackaged && process.platform === 'darwin' && app.isInApplicationsFolder();
  const unsupported = support({ packaged: app.isPackaged, inApplications });
  let state: UpdateState = {
    phase: unsupported ? 'unsupported' : 'idle', current: app.getVersion(), version: null, percent: null,
    reason: unsupported, checkedAt: null, auto: autoEnabled(deps.read(AUTO_UPDATE_KEY))
  };
  const set = (patch: Partial<UpdateState>): void => { state = { ...state, ...patch }; deps.broadcast(state); };
  /** The check the person asked for from the menu or Settings: it reports back even when nothing is new. */
  let manual = false;
  /** Asked once per version per session; after "Later" it waits for the quit. */
  let prompted: string | null = null;

  const box = async (options: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }> => {
    const owner = deps.window();
    return owner && !owner.isDestroyed() ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  };
  const tell = (message: string, detail = ''): void => {
    void box({ type: 'info', message, detail, buttons: [deps.texts().ok] });
  };

  const askToRestart = async (info: UpdateInfo): Promise<void> => {
    if (prompted === info.version) return;
    prompted = info.version;
    const t = deps.texts();
    const notes = notesText(info.releaseNotes);
    const { response } = await box({
      type: 'info', message: fill(t.readyTitle, { version: info.version }),
      detail: [t.readyDetail, notes].filter(Boolean).join('\n\n'),
      buttons: [t.restart, t.later], defaultId: 0, cancelId: 1
    });
    if (response === 0) install();
  };

  const install = (): void => {
    if (state.phase !== 'ready') return;
    deps.log('update.install', { version: state.version });
    // Let the dialog close before the windows go.
    setImmediate(() => autoUpdater.quitAndInstall());
  };

  if (!unsupported) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: () => undefined, debug: () => undefined,
      warn: (m: unknown) => deps.log('update.warn', { message: String(m).slice(0, 200) }),
      error: (m: unknown) => deps.log('update.error', { message: String(m).slice(0, 200) })
    };
    autoUpdater.on('checking-for-update', () => set({ phase: 'checking', reason: null }));
    autoUpdater.on('update-not-available', () => {
      set({ phase: 'upToDate', checkedAt: Date.now(), version: null, percent: null });
      if (manual) tell(fill(deps.texts().upToDate, { version: state.current }));
      manual = false;
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      set({ phase: 'downloading', version: info.version, percent: 0, checkedAt: Date.now() });
      deps.log('update.available', { version: info.version });
      if (manual) tell(fill(deps.texts().downloading, { version: info.version }), deps.texts().downloadingDetail);
      manual = false;
    });
    autoUpdater.on('download-progress', (p: { percent: number }) => set({ percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      set({ phase: 'ready', version: info.version, percent: 100 });
      deps.log('update.downloaded', { version: info.version });
      void askToRestart(info);
    });
    autoUpdater.on('error', (error: unknown) => {
      const reason = failureReason(error);
      set({ phase: 'error', reason, percent: null });
      if (manual) tell(deps.texts().failed, reason === 'offline' ? deps.texts().offline : deps.texts().failedDetail);
      manual = false;
    });
  }

  /** Looks for a new version. `byHand` means the person asked, so every outcome is reported. */
  const check = async (byHand: boolean): Promise<UpdateState> => {
    const t = deps.texts();
    if (state.reason === 'dev' || state.reason === 'location') {
      if (byHand) {
        if (state.reason === 'location') await offerMove(true);
        else tell(t.devTitle, t.devDetail);
      }
      return state;
    }
    if (state.phase === 'ready') {
      if (byHand) { prompted = null; await askToRestart({ version: state.version! } as UpdateInfo); }
      return state;
    }
    if (state.phase === 'checking' || state.phase === 'downloading') {
      if (byHand && state.phase === 'downloading') tell(fill(t.downloading, { version: state.version ?? '' }), t.downloadingDetail);
      return state;
    }
    manual = byHand;
    try { await autoUpdater.checkForUpdates(); }
    catch { /* reported through the 'error' event */ }
    return state;
  };

  /** Squirrel cannot replace a copy outside /Applications; offer to move it there (the app relaunches). */
  const offerMove = async (byHand: boolean): Promise<void> => {
    if (!byHand && deps.read(MOVE_DECLINED_KEY) === '1') return;
    const t = deps.texts();
    const { response, checkboxChecked } = await box({
      type: 'question', message: t.moveTitle, detail: t.moveDetail,
      buttons: [t.move, t.notNow], defaultId: 0, cancelId: 1,
      ...(byHand ? {} : { checkboxLabel: t.dontAsk })
    });
    if (response !== 0) { if (checkboxChecked) deps.write(MOVE_DECLINED_KEY, '1'); return; }
    try { app.moveToApplicationsFolder(); }
    catch (error) {
      deps.log('update.move', { failed: String(error).slice(0, 160) });
      tell(t.moveFailed);
    }
  };

  const start = (): void => {
    if (state.reason === 'location') { setTimeout(() => void offerMove(false), FIRST_CHECK_DELAY_MS); return; }
    if (unsupported) return;
    const tick = (): void => { if (state.auto) void check(false); };
    setTimeout(tick, FIRST_CHECK_DELAY_MS);
    setInterval(tick, CHECK_INTERVAL_MS).unref();
  };

  return {
    start,
    state: (): UpdateState => state,
    check,
    install,
    setAuto(on: boolean): UpdateState {
      deps.write(AUTO_UPDATE_KEY, on ? '1' : '0');
      set({ auto: on });
      return state;
    }
  };
}
