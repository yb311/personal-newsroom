/**
 * Ready-made RSSHub routes: filling, URL recognition and, when a pack is
 * available (PNR_RSSHUB_PACK=<dir>), live fetching and failure reasons.
 *   npm run test:rsshub
 */
import { readFileSync } from 'node:fs';
import { setCuratedRoutes, curatedRoutes, fillRoute, matchRouteFromUrl, resolveSourceInput,
         configureRssHub, adapterFor, type CuratedRoute } from '../packages/feed/src/index.ts';
import type { SourceRecord } from '../packages/core/src/index.ts';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

const routes = JSON.parse(readFileSync(new URL('../catalogs/data/rsshub-routes.json', import.meta.url), 'utf8')) as CuratedRoute[];
setCuratedRoutes(routes);
console.log(`=== 路由清单：${routes.length} 条，${new Set(routes.map((r) => r.platform)).size} 个平台 ===`);
check(routes.every((r) => r.example && r.params.every((p) => typeof p.description === 'string')), '每条都有示例和参数说明');

const author = curatedRoutes().find((r) => r.path === '/sspai/author/:id')!;
check(fillRoute(author, { id: 'urfp0d9i' }) === '/sspai/author/urfp0d9i', '按填写的值拼出路由');
check(fillRoute(author, {}) === null, '缺必填项时拼不出');
const douban = curatedRoutes().find((r) => r.path.startsWith('/douban/book/latest'))!;
check(fillRoute(douban, {}) === '/douban/book/latest', '选填项留空时省略');

const hit = matchRouteFromUrl(curatedRoutes(), 'https://sspai.com/u/urfp0d9i/posts');
check(hit?.path === '/sspai/author/urfp0d9i', `粘贴少数派作者主页 → ${hit?.path}`);
const r = resolveSourceInput('https://sspai.com/u/urfp0d9i/posts');
check(r?.kind === 'rsshub' && r.suggestedName === '少数派 · 作者', `添加链接时自动识别（${r?.kind} ${r?.suggestedName}）`);
check(resolveSourceInput('https://www.theverge.com/rss/index.xml')?.kind === 'rss', '普通 RSS 地址不受影响');

const pack = process.env['PNR_RSSHUB_PACK'];
if (!pack) console.log('\n（没有设置 PNR_RSSHUB_PACK，跳过联网部分）');
else {
  console.log('\n=== 联网：用扩展实际抓取 ===');
  configureRssHub({ packageDir: pack });
  const run = async (path: string) => adapterFor('rsshub')!({ id: 't', kind: 'rsshub', name: 't', domain: null, url: path, category: null,
    lang: null, country: null, trust: 0.5, enabled: 1, dateHydration: null, configJson: null } as SourceRecord, {});
  const ok = await run('/sspai/index');
  check(ok.items.length > 0, `少数派首页抓到 ${ok.items.length} 条`);
  const missing = await run('/nonexistent-namespace/abc');
  check('route_not_found' in missing.diagnostics.droppedByReason, `不存在的路由报「路由不存在」（${Object.keys(missing.diagnostics.droppedByReason)}）`);
}

console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
