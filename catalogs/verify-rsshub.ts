/**
 * Builds catalogs/data/rsshub-routes.json: the RSSHub routes the app offers
 * ready-made. Needs an installed RSSHub pack (the app's own, or one installed
 * anywhere with installPack):
 *
 *   npm run catalog:rsshub -- <pack dir>
 *
 * For each candidate in rsshub-candidates.ts it reads RSSHub's metadata
 * (parameters, example, radar rules, feature flags), drops routes that need a
 * cookie, key or browser, runs the example and keeps the route only if it
 * returned items.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CANDIDATES, type Candidate } from './rsshub-candidates.ts';
import type { CuratedRoute, RouteParam } from '../packages/feed/src/rsshub-routes.ts';
import { configureRssHub, adapters } from '../packages/feed/src/adapters/index.ts';
import type { SourceRecord } from '../packages/core/src/index.ts';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const ADVANCED = new Set(['embed', 'routeParams', 'redirect1', 'redirect2', 'showUid', 'qs', 'getAll', 'limits']);
const TIMEOUT_MS = 40_000;

interface Meta {
  path: string; name: string; url?: string; example?: string;
  parameters?: Record<string, string | { description?: string; options?: { value: string; label: string }[]; default?: string }>;
  radar?: { source?: string[] }[];
  features?: { requireConfig?: unknown; requirePuppeteer?: boolean };
}

async function loadMetadata(packDir: string): Promise<Record<string, { routes: Record<string, Meta>; url?: string }>> {
  const lib = join(packDir, 'node_modules', 'rsshub', 'dist-lib');
  const file = readdirSync(lib).find((f) => f.startsWith('routes-') && readFileSync(join(lib, f), 'utf8').slice(0, 200).includes('assets/build/routes.js'));
  if (!file) throw new Error('route metadata not found in pack');
  return (await import(pathToFileURL(join(lib, file)).href)).default;
}

const plain = (s: string): string => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '').replace(/\s+/g, ' ').trim();

async function main(): Promise<void> {
  const packDir = process.argv[2];
  if (!packDir) throw new Error('usage: verify-rsshub.ts <pack dir>');
  const meta = await loadMetadata(packDir);
  configureRssHub({ packageDir: packDir });
  const rsshub = adapters.rsshub!;

  const kept: CuratedRoute[] = [];
  const dropped: { path: string; reason: string }[] = [];

  // Runs one candidate's example; returns the curated route, or why not.
  const attempt = async (cand: Candidate): Promise<CuratedRoute | string> => {
    const ns = cand.path.split('/')[1]!;
    const rel = cand.path.slice(ns.length + 1) || '/';
    const m = meta[ns]?.routes[rel];
    if (!m) return 'not in this RSSHub version';
    if (m.features?.requirePuppeteer) return 'needs_browser';
    if (m.features?.requireConfig) return 'needs a cookie or key';
    const example = m.example ?? '';
    const source = { id: 't', kind: 'rsshub', name: 't', domain: null, url: example, category: null, lang: null,
                     country: null, trust: 0.5, enabled: 1, dateHydration: null, configJson: null } as SourceRecord;
    const res = await Promise.race([
      rsshub(source, {}).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS))
    ]);
    if (!res) return 'timeout';
    if (res.items.length === 0) return Object.keys(res.diagnostics.droppedByReason)[0] ?? 'empty';
    console.log(`  ✅ ${cand.platform} · ${cand.name ?? m.name}  (${res.items.length} 条)`);
    const optional = new Set([...rel.matchAll(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?\?/g)].map((x) => x[1]!));
    const params: RouteParam[] = [...rel.matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => {
      const key = x[1]!;
      const p = m.parameters?.[key];
      const d = typeof p === 'string' ? p : p?.description ?? '';
      return {
        key, description: plain(d), optional: optional.has(key),
        ...(typeof p === 'object' && p?.options?.length ? { options: p.options.map((o) => ({ value: String(o.value), label: plain(String(o.label)) })) } : {}),
        ...(typeof p === 'object' && p?.default !== undefined ? { default: String(p.default) } : {}),
        ...(ADVANCED.has(key) ? { advanced: true } : {})
      };
    });
    return {
      id: cand.path.replace(/[/:?{}.+]+/g, '-').replace(/^-|-$/g, ''),
      platform: cand.platform, name: cand.name ?? m.name, path: cand.path, example,
      params, sources: (m.radar ?? []).flatMap((r) => r.source ?? []),
      site: m.url ?? meta[ns]?.url ?? null
    };
  };

  // First pass in parallel; then the failures that may be passing trouble
  // (a site refusing or rate-limiting this network, an empty answer) once
  // more, one at a time and spaced out. A route that needs a browser, a
  // cookie or does not exist is not retried.
  const permanent = new Set(['needs_browser', 'needs a cookie or key', 'route_not_found', 'not in this RSSHub version']);
  const retry: Candidate[] = [];
  const queue = [...CANDIDATES];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let cand = queue.shift(); cand; cand = queue.shift()) {
      const r = await attempt(cand);
      if (typeof r !== 'string') kept.push(r);
      else if (permanent.has(r)) dropped.push({ path: cand.path, reason: r });
      else retry.push(cand);
    }
  }));
  if (retry.length) console.log(`\n再试 ${retry.length} 个（间隔 8 秒）…`);
  for (const cand of retry) {
    await new Promise((r) => setTimeout(r, 8000));
    const r = await attempt(cand);
    if (typeof r !== 'string') kept.push(r);
    else dropped.push({ path: cand.path, reason: r });
  }

  const order = new Map(CANDIDATES.map((c, i) => [c.path, i]));
  kept.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
  writeFileSync(join(DATA, 'rsshub-routes.json'), JSON.stringify(kept, null, 1));
  console.log(`\n保留 ${kept.length} / ${CANDIDATES.length}`);
  for (const d of dropped) console.log(`  ❌ ${d.path}  ${d.reason}`);
  process.exit(0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
