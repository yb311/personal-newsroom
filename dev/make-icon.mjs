/** Builds every app-icon artefact from the single source, assets/AppIcon.icon.
 *
 *  Run with `npm run icon:build`. Needs Xcode 26 (for Icon Composer's `ictool`
 *  and `actool`); the artefacts it produces are committed, so building or
 *  packaging the app itself never needs Xcode.
 *
 *  Outputs:
 *    assets/Assets.car  macOS 26+. Liquid Glass, all six appearances. Goes in
 *                       Contents/Resources with `CFBundleIconName = AppIcon`.
 *    assets/icon.icns   macOS 15 and earlier. 16pt to 512@2x, laid out on the
 *                       Big Sur grid: an 824pt sheet centred on a 1024pt canvas
 *                       with the system drop shadow. `CFBundleIconFile`.
 *    assets/icon.png    The 1024pt master of that same legacy rendering. Used
 *                       for the Dock icon during unpackaged `npm run dev`.
 *
 *  Plain .mjs, not .ts: Electron runs this, and everything hangs off
 *  `whenReady().then()` because top-level await in an Electron ESM main never
 *  gets to run.
 */
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, 'assets');
const SOURCE = join(ASSETS, 'AppIcon.icon');
const ICONSET = join(ASSETS, 'icon.iconset');
const CANVAS = 1024;

/** The Big Sur icon grid, measured off an icns that `actool` itself produced
 *  from this same document: an 824pt sheet centred on 1024pt, and a shadow
 *  8pt down with a ~9.3pt gaussian (CSS blur radius is 2 sigma). */
const SHEET = 824;
const SHADOW = 'drop-shadow(0 8px 19px rgba(0, 0, 0, 0.30))';

/** name -> pixel size, exactly the set `iconutil` expects. */
const SLICES = {
  'icon_16x16': 16, 'icon_16x16@2x': 32,
  'icon_32x32': 32, 'icon_32x32@2x': 64,
  'icon_128x128': 128, 'icon_128x128@2x': 256,
  'icon_256x256': 256, 'icon_256x256@2x': 512,
  'icon_512x512': 512, 'icon_512x512@2x': 1024
};

const ICTOOL = '/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool';

function requireXcode() {
  if (existsSync(ICTOOL)) return;
  throw new Error(
    `Icon Composer not found at ${ICTOOL}\n` +
    'Rebuilding the icon needs Xcode 26 or later. The built artefacts are\n' +
    'committed, so this is only needed after editing assets/AppIcon.icon.');
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  requireXcode();
  const work = mkdtempSync(join(tmpdir(), 'pnr-icon-'));

  // 1. Let Icon Composer render the icon the way macOS 26 will: the system
  //    shape, the material, the specular edge. That render is also what the
  //    legacy icns gets built out of, so the two OS generations cannot drift.
  const flat = join(work, 'flat.png');
  execFileSync(ICTOOL, [SOURCE, '--export-image', '--output-file', flat,
    '--platform', 'macOS', '--rendition', 'Default',
    '--width', String(CANVAS), '--height', String(CANVAS), '--scale', '1']);

  // 2. Inset it onto the legacy grid and give it the shadow macOS used to draw.
  const inset = (CANVAS - SHEET) / 2;
  const page = join(work, 'legacy.html');
  writeFileSync(page, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
img{position:absolute;left:${inset}px;top:${inset}px;width:${SHEET}px;height:${SHEET}px;filter:${SHADOW}}</style>
<img src="file://${flat}">`);

  const win = new BrowserWindow({
    width: CANVAS, height: CANVAS, show: false, frame: false, transparent: true,
    useContentSize: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, webSecurity: false }
  });
  await win.loadFile(page);

  const master = await win.webContents.capturePage();
  const got = master.getSize().width;
  if (got !== CANVAS) throw new Error(`captured ${got}px, expected ${CANVAS}`);
  writeFileSync(join(ASSETS, 'icon.png'), master.toPNG());

  // 3. Every legacy slice, down to the 16pt one Finder uses in list view.
  rmSync(ICONSET, { recursive: true, force: true });
  mkdirSync(ICONSET, { recursive: true });
  for (const [name, size] of Object.entries(SLICES)) {
    const img = size === CANVAS
      ? master
      : master.resize({ width: size, height: size, quality: 'best' });
    writeFileSync(join(ICONSET, `${name}.png`), img.toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(ASSETS, 'icon.icns')]);
  rmSync(ICONSET, { recursive: true, force: true });

  // 4. The macOS 26 asset catalogue. actool also drops its own cut-down icns
  //    beside it (256pt at most), which ours supersedes.
  execFileSync('actool', [SOURCE, '--compile', work, '--platform', 'macosx',
    '--minimum-deployment-target', '26.0', '--app-icon', 'AppIcon',
    '--output-partial-info-plist', join(work, 'partial.plist')],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync('cp', [join(work, 'Assets.car'), join(ASSETS, 'Assets.car')]);

  rmSync(work, { recursive: true, force: true });
  console.log('wrote assets/Assets.car, assets/icon.icns, assets/icon.png');
  app.exit(0);
}).catch((err) => { console.error(String(err.message || err)); app.exit(1); });
