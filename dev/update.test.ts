/** 软件更新的纯逻辑, offline.  npm run test:update */
import { readFileSync } from 'node:fs';
import { support, failureReason, notesText, autoEnabled } from '../apps/desktop/src/update-logic.ts';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

console.log('=== 能不能更新 ===');
check(support({ packaged: false, inApplications: false }) === 'dev', '开发版不检查更新');
check(support({ packaged: true, inApplications: false }) === 'location', '不在「应用程序」文件夹里的签名版不能替换自己');
check(support({ packaged: true, inApplications: true }) === null, '装在「应用程序」里的签名版可以更新');
check(autoEnabled(undefined) && autoEnabled('1') && !autoEnabled('0'), '自动检查默认开，关掉才关');

console.log('\n=== 失败原因 ===');
check(failureReason(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })) === 'offline', '断网算「连不上」');
check(failureReason(new Error('net::ERR_INTERNET_DISCONNECTED')) === 'offline', 'Chromium 的网络错误也算「连不上」');
check(failureReason(new Error('Could not get code signature for running application')) === 'failed', '签名之类的错误算「失败」');

console.log('\n=== 更新说明 ===');
const html = `<h2>What's Changed</h2><ul><li>按关注自动挑源 by <a href="https://github.com/yb311">@yb311</a></li><li>Fix &amp; polish</li></ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/yb311/personal-newsroom/compare/v0.1.0...v0.1.1">v0.1.0...v0.1.1</a></p>`;
const text = notesText(html);
check(text.includes('• 按关注自动挑源 by @yb311') && text.includes('• Fix & polish'), `GitHub 的 HTML 变成纯文字列表（${JSON.stringify(text)}）`);
check(!/<|Full Changelog/.test(text), '去掉标签和对比链接');
check(notesText('x'.repeat(2000)).length <= 601, '太长的截断');
check(notesText(null) === '', '没有说明时为空');

console.log('\n=== 发布配置 ===');
const cfg = readFileSync(new URL('../apps/desktop/electron-builder.config.mjs', import.meta.url), 'utf8');
check(/provider: 'github', owner: 'yb311', repo: 'personal-newsroom'/.test(cfg) && /'zip'/.test(cfg), '打包配置指向 GitHub Release，并生成 zip（Squirrel 只认 zip）');
const wf = readFileSync(new URL('../.github/workflows/release-macos.yml', import.meta.url), 'utf8');
check(/release\/latest-mac\.yml \\/.test(wf) && /release\/\*\.zip\.blockmap \\/.test(wf), '发布时上传 latest-mac.yml 和 blockmap');

console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exitCode = bad ? 1 : 0;
