/**
 * The background worker's own bundle: 所闻 后台更新.app.
 *
 * launchd runs the worker as Node inside Electron (ELECTRON_RUN_AS_NODE). Run
 * from the main executable it showed up as a second 「所闻」 in Activity Monitor,
 * and from a bare `node` (development) as 「node」 in Login Items. A copy of
 * Electron's helper app under its own name gives every place macOS lists it —
 * Activity Monitor, Login Items & Extensions, permission prompts — a name that
 * says what it is and whose it is.
 *
 * The helper must live in Contents/Frameworks, and its executable's name must
 * end in " Helper": Electron recognises a helper by that suffix and only then
 * looks for its framework three levels up (any other name crashes at start).
 * So the executable is 「所闻 后台更新 Helper」, as Activity Monitor shows it,
 * and the bundle's own name — what permission prompts use — is 「所闻 后台更新」.
 *
 * Used by electron-builder's afterPack (packaged builds, signed afterwards with
 * the rest of the app) and by the development schedule (next to the dev
 * Electron, ad-hoc signed).
 */
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const WORKER_NAME = '所闻 后台更新';
export const WORKER_EXECUTABLE = `${WORKER_NAME} Helper`;
export const WORKER_BUNDLE_ID = 'com.yb311.personal-newsroom.worker';

/** Path of the worker executable inside an app's Frameworks directory. */
export const workerExecutable = (frameworks) => join(frameworks, `${WORKER_NAME}.app`, 'Contents', 'MacOS', WORKER_EXECUTABLE);

/**
 * Creates (or recreates) the worker bundle next to the plain helper in
 * `frameworks`. Returns the executable path. `adhocSign` re-signs it for
 * unsigned builds, whose original signature no longer matches the edited plist.
 */
export function makeWorkerHelper(frameworks, { adhocSign = false } = {}) {
  const source = readdirSync(frameworks).find((n) => / Helper\.app$/.test(n));
  if (!source) throw new Error(`no Electron helper in ${frameworks}`);
  const target = join(frameworks, `${WORKER_NAME}.app`);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(frameworks, source), target, { recursive: true, verbatimSymlinks: true });
  const macos = join(target, 'Contents', 'MacOS');
  const [binary] = readdirSync(macos);
  if (binary !== WORKER_EXECUTABLE) renameSync(join(macos, binary), join(macos, WORKER_EXECUTABLE));
  const plist = join(target, 'Contents', 'Info.plist');
  const set = (key, value) => {
    try { execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]); }
    catch { execFileSync('/usr/bin/plutil', ['-insert', key, '-string', value, plist]); }
  };
  set('CFBundleExecutable', WORKER_EXECUTABLE);
  set('CFBundleName', WORKER_NAME);
  set('CFBundleDisplayName', WORKER_NAME);
  set('CFBundleIdentifier', WORKER_BUNDLE_ID);
  execFileSync('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'YES', plist]);
  if (adhocSign) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', target]);
  const exe = workerExecutable(frameworks);
  if (!existsSync(exe)) throw new Error(`worker helper missing at ${exe}`);
  return exe;
}
