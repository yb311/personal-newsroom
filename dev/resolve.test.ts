import { resolveSourceInput } from '../packages/feed/src/index.ts';
const cases: [string, string, string][] = [
  ['https://www.theverge.com/rss/index.xml', 'rss', 'theverge.com'],
  ['theverge.com/rss/index.xml',             'rss', 'theverge.com'],
  ['https://t.me/durov',                     'telegram', 'durov'],
  ['https://t.me/s/durov',                   'telegram', 'durov'],
  ['@durov',                                 'telegram', 'durov'],
  ['durov',                                  'telegram', 'durov'],
  ['/bilibili/popular/all',                  'rsshub', '/bilibili/popular/all'],
  ['bilibili/popular/all',                   'rsshub', '/bilibili/popular/all'],
  ['随便写点什么中文',                          'null', ''],
  ['https://rsshub.app/zhihu/daily',         'rss', 'rsshub.app'],
  ['https://www.reddit.com/r/worldnews',     'reddit', 'worldnews'],
  ['https://github.com/nodejs/node',         'github', 'nodejs/node']
];
let bad = 0;
for (const [input, kind, url] of cases) {
  const r = resolveSourceInput(input);
  const ok = kind === 'null' ? r === null
    : r?.kind === kind && (url === '' || r?.url === url || r?.domain === url);
  if (!ok) bad++;
  console.log(`  ${ok?'✅':'❌'} ${input.padEnd(40)} → ${r?.kind ?? 'null'} ${String(r?.url ?? '').slice(0,30)}`);
}
console.log('\n--- 显式指定类型 ---');
for (const [input, hint] of [['bilibili/popular/all','rsshub'],['worldnews','reddit'],['front_page','hackernews']] as const) {
  const r = resolveSourceInput(input, hint as never);
  console.log(`  ${r?.kind === hint ? '✅' : '❌'} ${input.padEnd(24)} 指定 ${hint} → ${r?.kind} "${r?.url}"  名字「${r?.suggestedName}」`);
}
console.log(bad ? `\n${bad} 个不符预期` : '\n自动识别全部正确');
