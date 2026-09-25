/**
 * Stage only the two native dependencies that cannot live inside an esbuild
 * bundle. Everything else is bundled into main.cjs / worker.cjs, keeping the
 * application package small and independent of the monorepo's node_modules.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, 'apps', 'desktop', 'packaging', 'app');
const destination = join(staging, 'node_modules');

rmSync(join(root, 'apps', 'desktop', 'packaging'), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(root, 'apps', 'desktop', 'packaging', 'bin'), { recursive: true });

cpSync(join(root, 'apps', 'desktop', 'dist'), join(staging, 'dist'), { recursive: true });
cpSync(join(root, 'apps', 'desktop', 'catalogs'), join(staging, 'catalogs'), { recursive: true });
cpSync(join(root, 'apps', 'worker', 'dist', 'worker.cjs'), join(staging, 'worker.cjs'));
// The reader core is a standalone executable; electron-builder puts it in
// Contents/Resources/bin, where both the app and the background worker look.
cpSync(join(root, 'native', 'reader', 'bin', 'pnr-reader'), join(root, 'apps', 'desktop', 'packaging', 'bin', 'pnr-reader'));
const packageMetadata = {
  name: 'personal-newsroom',
  productName: '所闻',
  // The one version number: the root package.json, which the release workflow
  // checks against the tag. A copy here once shipped every build as 0.1.0.
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  description: '本地优先、意图驱动的个人新闻编辑部',
  author: 'yb311',
  license: 'AGPL-3.0-or-later',
  main: 'dist/main.cjs'
};
writeFileSync(join(staging, 'package.json'), JSON.stringify({
  ...packageMetadata,
  dependencies: {
    'better-sqlite3': '13.0.3',
    'sqlite-vec': '0.1.9'
  }
}, null, 2));
cpSync(join(root, 'packaging', 'runtime', 'package-lock.json'), join(staging, 'package-lock.json'));
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: staging,
  stdio: 'inherit'
});

// better-sqlite3 ships prebuilds for every supported platform. The package is
// macOS-only, and each artifact is architecture-specific, so retain only the
// binary the current package can actually load.
const prebuilds = join(destination, 'better-sqlite3', 'prebuilds');
for (const name of ['darwin-arm64.node', 'darwin-x64.node']) {
  if (name !== `darwin-${process.arch}.node`)
    rmSync(join(prebuilds, name), { force: true });
}
for (const name of ['linux-arm64.node', 'linux-x64.node', 'linuxmusl-arm64.node',
                    'linuxmusl-x64.node', 'win32-arm64.node', 'win32-x64.node']) {
  rmSync(join(prebuilds, name), { force: true });
}

// All runtime modules above are included explicitly by the packager's file
// rules. Removing dependency metadata prevents electron-builder from walking
// back to the monorepo root and copying unrelated workspace dependencies.
writeFileSync(join(staging, 'package.json'), JSON.stringify(packageMetadata, null, 2));

console.log(`staged native runtime for ${process.platform}-${process.arch}`);
