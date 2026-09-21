/**
 * npm run doctor — checks the setup and prints every switch and tunable.
 * Read-only: the database is opened read-only and nothing is written.
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeFlags } from '../packages/core/src/index.ts';
import { defaultDataDir } from '../packages/store/src/index.ts';
import { locateBinary, plainText } from '../packages/reader-core/src/index.ts';
import { GEMINI_MODELS, GeminiProvider, OllamaProvider, OpenAiProvider, AnthropicProvider, CompatibleProvider } from '../packages/ai/src/index.ts';
import { configureRssHub, rssHubMode, MAX_ITEM_AGE_DAYS, FEED_BODY_MIN_WORDS } from '../packages/feed/src/index.ts';
import { MIN_WORDS } from '../packages/reader/src/index.ts';
import { THRESHOLDS, BATCH_SIZE } from '../packages/recall/src/index.ts';
import { DIGEST_WINDOW_HOURS, DIGEST_FALLBACK_HOURS, PROGRESS_WINDOW_DAYS, FLASH_WINDOW_HOURS,
         DEDUP_WINDOW_HOURS, MIN_IMPORTANCE } from '../packages/generate/src/index.ts';

const ok = (b: boolean): string => (b ? '✅' : '❌');
let problems = 0;
const line = (good: boolean, label: string, detail = ''): void => { if (!good) problems++; console.log(`  ${ok(good)} ${label}${detail ? `  ${detail}` : ''}`); };

console.log('环境');
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
line(major > 24 || (major === 24 && minor >= 15), `Node ${process.versions.node}`, '需要 ≥ 24.15');
const bin = locateBinary();
line(Boolean(bin), '阅读核心 pnr-reader', bin ?? '找不到：运行 npm run reader:build');
if (bin) {
  const t = Date.now();
  const [probe] = await plainText(['a&amp;#39;b']).catch(() => ['']);
  line(probe === "a'b", '阅读核心能正常应答', `${Date.now() - t}ms`);
}

console.log('\n数据');
const dataDir = process.env['PNR_DATA_DIR'] ?? defaultDataDir();
const dbPath = join(dataDir, 'newsroom.db');
line(existsSync(dbPath), '数据库', dbPath);
let settings: Record<string, string> = {};
if (existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.loadExtension(sqliteVec.getLoadablePath());
  const one = <T,>(sql: string): T => db.prepare(sql).get() as T;
  line(true, `sqlite-vec ${one<{ v: string }>('SELECT vec_version() v').v}`);
  const migrations = (db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((m) => m.name);
  line(true, `迁移 ${migrations.length} 个`, migrations.at(-1) ?? '');
  const c = one<{ s: number; e: number; i: number; w: number; b: number }>(
    `SELECT (SELECT COUNT(*) FROM sources) s, (SELECT COUNT(*) FROM sources WHERE enabled=1) e,
            (SELECT COUNT(*) FROM items) i, (SELECT COUNT(*) FROM watches) w,
            (SELECT COUNT(*) FROM items WHERE body_state='ok') b`);
  line(true, `源 ${c.s}（启用 ${c.e}）· 文章 ${c.i}（有正文 ${c.b}）· 关注 ${c.w}`);
  const garbled = one<{ n: number }>("SELECT COUNT(*) n FROM items WHERE title LIKE '%&#%' OR title LIKE '%&amp;%'").n;
  line(garbled === 0, '标题里没有残留的 HTML 实体', garbled ? `${garbled} 条（旧数据，清空数据目录重抓即可）` : '');
  settings = Object.fromEntries((db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  db.close();
}

console.log('\nAI');
const provider = settings['ai.provider'] ?? 'gemini';
if (provider === 'none') line(true, '阅读模式（未启用 AI）');
else if (provider === 'ollama') {
  const r = await new OllamaProvider({ host: settings['ai.ollamaHost'], writeModel: settings['ai.ollamaWriteModel'], fastModel: settings['ai.ollamaFastModel'], embedModel: settings['ai.ollamaEmbedModel'] }).check();
  line(r.ok, 'Ollama', r.problem ?? '');
} else if (provider === 'openai') {
  const r = await new OpenAiProvider(settings['ai.openaiApiKey'] ?? process.env['OPENAI_API_KEY'] ?? '', {
    ...(settings['ai.writeModel'] ? { write: settings['ai.writeModel'] } : {}), ...(settings['ai.fastModel'] ? { fast: settings['ai.fastModel'] } : {})
  }).check();
  line(r.ok, 'OpenAI', r.problem ?? '');
} else if (provider === 'anthropic') {
  const r = await new AnthropicProvider(settings['ai.anthropicApiKey'] ?? process.env['ANTHROPIC_API_KEY'] ?? '', {
    ...(settings['ai.writeModel'] ? { write: settings['ai.writeModel'] } : {}), ...(settings['ai.fastModel'] ? { fast: settings['ai.fastModel'] } : {})
  }).check();
  line(r.ok, 'Anthropic Claude', r.problem ?? '');
} else if (provider === 'openai-compatible') {
  const r = await new CompatibleProvider({ endpoint: settings['ai.compatibleEndpoint'] ?? '', apiKey: settings['ai.compatibleApiKey'] ?? '',
    writeModel: settings['ai.writeModel'] ?? '', ...(settings['ai.fastModel'] ? { fastModel: settings['ai.fastModel'] } : {}),
    ...(settings['ai.embedModel'] ? { embedModel: settings['ai.embedModel'] } : {}) }).check();
  line(r.ok, 'OpenAI Compatible', r.problem ?? '');
} else {
  const key = settings['ai.geminiApiKey'] ?? process.env['GEMINI_API_KEY'] ?? '';
  const r = await new GeminiProvider(key).check();
  line(r.ok, `Gemini（写作 ${GEMINI_MODELS.write} · 判定 ${GEMINI_MODELS.fast} · 向量 ${GEMINI_MODELS.embed}）`, r.problem ?? '');
}

console.log('\nRSSHub');
const pack = process.env['PNR_RSSHUB_PACK'] ?? join(homedir(), 'Library', 'Application Support', '所闻', 'social-sources');
configureRssHub({ ...(settings['rsshub.instanceUrl'] ? { instanceUrl: settings['rsshub.instanceUrl'] } : {}), packageDir: pack });
const mode = await rssHubMode();
console.log(`  ${mode === 'off' ? '➖' : '✅'} ${mode === 'http' ? `自建实例 ${settings['rsshub.instanceUrl']}` : mode === 'library' ? `扩展 ${pack}` : '未安装（可选）'}`);

console.log('\n开关');
for (const [k, v] of Object.entries(describeFlags())) console.log(`  ${k.padEnd(20)} ${v}`);

console.log('\n可调参数');
const tunables: [string, unknown][] = [
  ['入库只收最近（天）', MAX_ITEM_AGE_DAYS], ['feed 全文当正文的最少词数', FEED_BODY_MIN_WORDS],
  ['正文最少词数', MIN_WORDS], ['判定每批条数', BATCH_SIZE],
  ['意图闸门 宁可多看/平衡/宁可少看', Object.values(THRESHOLDS).map((t) => t.intent).join(' / ')],
  ['摘要选材窗口（小时，兜底）', `${DIGEST_WINDOW_HOURS}（${DIGEST_FALLBACK_HOURS}）`], ['进展选材窗口（天）', PROGRESS_WINDOW_DAYS],
  ['快讯窗口 / 去重窗口（小时）', `${FLASH_WINDOW_HOURS} / ${DEDUP_WINDOW_HOURS}`], ['快讯最低重要度', MIN_IMPORTANCE]
];
for (const [k, v] of tunables) console.log(`  ${k.padEnd(22)} ${v}`);

console.log(problems ? `\n${problems} 项需要处理` : '\n一切正常');
process.exit(problems ? 1 : 0);
