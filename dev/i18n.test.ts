/**
 * Interface text, offline.  npm run test:i18n
 *
 * Both dictionaries must have the same keys (plural forms aside), every key
 * the interface asks for must exist, and no component may carry its own
 * Chinese sentence — only brand and language names written in themselves.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };
const src = join(import.meta.dirname, '../apps/renderer/src');

type Dict = { [k: string]: string | Dict };
const flat = (d: Dict, p = ''): string[] =>
  Object.entries(d).flatMap(([k, v]) => (typeof v === 'string' ? [p + k] : flat(v, `${p}${k}.`)));
const base = (k: string): string => k.replace(/_(one|other)$/, '');
const keys = (lang: string): Set<string> =>
  new Set(flat(JSON.parse(readFileSync(join(src, 'locales', `${lang}.json`), 'utf8')) as Dict).map(base));
const zh = keys('zh-CN'), en = keys('en');

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));
const code = files(src).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
const used = new Set(code.flatMap(({ text }) => [...text.matchAll(/\bt\('([A-Za-z.]+)'/g)].map((m) => m[1]!)));

console.log('=== 界面文字 ===');
check([...zh].every((k) => en.has(k)) && [...en].every((k) => zh.has(k)), `中英词典键一致（${zh.size} 条）`);
const missing = [...used].filter((k) => !zh.has(k));
check(missing.length === 0, `界面用到的 ${used.size} 个键都有翻译${missing.length ? `，缺：${missing.join(', ')}` : ''}`);
const ALLOWED = /所闻|中文|日本語/g;
const stray = code.flatMap(({ f, text }) => text.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l) && /[一-鿿]/.test(l.replace(ALLOWED, '')))
  .map((l) => `${f.slice(src.length + 1)}: ${l.trim().slice(0, 60)}`));
check(stray.length === 0, `组件里没有写死的中文${stray.length ? `：\n      ${stray.join('\n      ')}` : ''}`);

console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
