import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { log } from '@pnr/core';

const run = promisify(execFile);

/**
 * The social-sources pack: RSSHub and its dependency tree, distributed
 * separately from the app.
 *
 * Why not put it in the installer: the tree is ~415 MB, of which ~75 MB is
 * telemetry (Sentry, OpenTelemetry) that a local-first app has no business
 * shipping, plus routes most people never touch. Tripling the download for
 * everyone to serve a minority is the wrong trade.
 *
 * Why not `npm install` at runtime: the app does not ship npm, and resolving a
 * 629-package tree on the user's machine is a large surface for something that
 * has to work on first try. Instead a single versioned archive is built ahead
 * of time, checksummed, and extracted here — no package manager involved.
 *
 * Routes break as websites change and get fixed quickly upstream; shipping the
 * pack separately means those fixes do not have to wait for an app release.
 */
export interface PackManifest {
  version: string;
  url: string;
  sha256: string;
  /** Uncompressed size, so the UI can say what it is about to use. */
  bytes: number;
}

export interface PackState {
  installed: boolean;
  version: string | null;
  bytes: number | null;
  dir: string;
}

const MARKER = 'pack.json';

export async function packState(dir: string): Promise<PackState> {
  const marker = join(dir, MARKER);
  if (!existsSync(marker)) return { installed: false, version: null, bytes: null, dir };
  try {
    const m = JSON.parse(await readFile(marker, 'utf8')) as { version: string; bytes: number };
    const ok = existsSync(join(dir, 'node_modules', 'rsshub', 'dist-lib', 'pkg.mjs'));
    return { installed: ok, version: ok ? m.version : null, bytes: ok ? m.bytes : null, dir };
  } catch {
    return { installed: false, version: null, bytes: null, dir };
  }
}

export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'done';
  received?: number;
  total?: number;
}

/**
 * Downloads, verifies and extracts the pack.
 *
 * The checksum is mandatory: this writes executable code into the user's
 * library directory, so an archive that does not match what we published is
 * discarded rather than run.
 */
export async function installPack(
  dir: string, manifest: PackManifest, onProgress?: (p: InstallProgress) => void
): Promise<PackState> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.download-${Date.now()}.tar.gz`);

  try {
    onProgress?.({ phase: 'downloading', received: 0, total: manifest.bytes });
    const res = await fetch(manifest.url);
    if (!res.ok || !res.body) throw new Error(`download_http_${res.status}`);
    const total = Number(res.headers.get('content-length')) || manifest.bytes;

    let received = 0;
    const hash = createHash('sha256');
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      onProgress?.({ phase: 'downloading', received, total });
    });
    await pipeline(body, createWriteStream(tmp));

    onProgress?.({ phase: 'verifying' });
    const digest = hash.digest('hex');
    if (digest !== manifest.sha256) {
      throw new Error(`checksum_mismatch: expected ${manifest.sha256.slice(0, 12)}, got ${digest.slice(0, 12)}`);
    }

    onProgress?.({ phase: 'extracting' });
    // Replace rather than merge: a half-updated dependency tree is worse than
    // no tree at all.
    await rm(join(dir, 'node_modules'), { recursive: true, force: true });
    await run('/usr/bin/tar', ['-xzf', tmp, '-C', dir]);

    const bytes = (await dirSize(join(dir, 'node_modules'))) || manifest.bytes;
    await writeFile(join(dir, MARKER), JSON.stringify({ version: manifest.version, bytes, installedAt: Date.now() }));
    onProgress?.({ phase: 'done' });
    log({ event: 'rsshub.pack.installed', attrs: { version: manifest.version, bytes } });
    return packState(dir);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function removePack(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  log({ event: 'rsshub.pack.removed' });
}

async function dirSize(path: string): Promise<number> {
  try {
    const { stdout } = await run('/usr/bin/du', ['-sk', path]);
    return Number(stdout.trim().split(/\s+/)[0]) * 1024;
  } catch {
    try { return (await stat(path)).size; } catch { return 0; }
  }
}
