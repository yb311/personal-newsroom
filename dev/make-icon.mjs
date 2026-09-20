/** Rasterises assets/icon.svg into assets/icon.png and assets/icon.icns.
 *
 *  Run with `npm run icon:build`. Plain .mjs, not .ts: this is executed by
 *  Electron — the only SVG renderer we already depend on — rather than node.
 *  Everything hangs off `whenReady().then()`; top-level await in an Electron
 *  ESM main never gets to run.
 */
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, 'assets');
const ICONSET = join(ASSETS, 'icon.iconset');
const MASTER = 1024;

/** name -> pixel size, exactly the set `iconutil` expects. */
const SLICES = {
  'icon_16x16': 16, 'icon_16x16@2x': 32,
  'icon_32x32': 32, 'icon_32x32@2x': 64,
  'icon_128x128': 128, 'icon_128x128@2x': 256,
  'icon_256x256': 256, 'icon_256x256@2x': 512,
  'icon_512x512': 512, 'icon_512x512@2x': 1024
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = readFileSync(join(ASSETS, 'icon.svg'), 'utf8');
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:${MASTER}px;height:${MASTER}px}</style>${svg}`;

  // Chromium refuses top-level navigation to data: URLs, so stage a real file.
  const stage = join(mkdtempSync(join(tmpdir(), 'pnr-icon-')), 'icon.html');
  writeFileSync(stage, html);

  const win = new BrowserWindow({
    width: MASTER, height: MASTER, show: false, frame: false, transparent: true,
    useContentSize: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  });
  await win.loadFile(stage);

  const master = await win.webContents.capturePage();
  const got = master.getSize().width;
  if (got !== MASTER) throw new Error(`captured ${got}px, expected ${MASTER}`);

  writeFileSync(join(ASSETS, 'icon.png'), master.toPNG());

  rmSync(ICONSET, { recursive: true, force: true });
  mkdirSync(ICONSET, { recursive: true });
  for (const [name, size] of Object.entries(SLICES)) {
    const img = size === MASTER
      ? master
      : master.resize({ width: size, height: size, quality: 'best' });
    writeFileSync(join(ICONSET, `${name}.png`), img.toPNG());
  }

  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(ASSETS, 'icon.icns')]);
  rmSync(ICONSET, { recursive: true, force: true });
  rmSync(dirname(stage), { recursive: true, force: true });

  console.log('wrote assets/icon.png and assets/icon.icns');
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
