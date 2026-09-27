/**
 * Waking the Mac for the daily brief, offline: pnr-wake is compiled here and
 * asked, with --plan, which wake it would book for a given wake.conf and time.
 * Nothing is booked and no password is needed.
 *
 *   npm run test:wake
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNextWake, wakeConfText, WAKE_SERVICE } from '../apps/desktop/src/wake.ts';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };
const root = new URL('..', import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), 'pnr-wake-'));
const bin = join(dir, 'pnr-wake');
execFileSync('xcrun', ['clang', '-O2', '-Wall', '-Werror', '-mmacosx-version-min=13.0', '-framework', 'IOKit', '-framework', 'CoreFoundation',
  '-o', bin, join(root, 'native/wake/wake.c')]);

const TZ = 'Asia/Shanghai';
const at = (s: string): number => Math.floor(new Date(`${s}+08:00`).getTime() / 1000);
const plan = (conf: string, now: string): string => {
  const f = join(dir, 'wake.conf'); writeFileSync(f, conf);
  return execFileSync(bin, ['--plan', f, String(at(now))], { env: { TZ }, encoding: 'utf8' }).trim();
};
const when = (out: string): string => out === 'none' ? 'none'
  : new Date(Number(out) * 1000).toLocaleString('sv-SE', { timeZone: TZ });

console.log('=== 唤醒时间 ===');
check(when(plan(wakeConfText(true, 7), '2026-09-27T06:00:00')) === '2026-09-27 07:15:50', '摘要时间之前：当天 7:15:50');
check(when(plan(wakeConfText(true, 7), '2026-09-27T08:00:00')) === '2026-09-28 07:15:50', '摘要时间之后：第二天 7:15:50');
check(when(plan(wakeConfText(true, 7), '2026-09-27T07:15:00')) === '2026-09-28 07:15:50', '离唤醒不到一分钟：改约第二天');
check(when(plan(wakeConfText(true, 10), '2026-09-27T06:00:00')) === '2026-09-27 10:15:50', '两位数的小时');
check(plan(wakeConfText(false, 7), '2026-09-27T06:00:00') === 'none', '关闭：不约');

console.log('\n=== 设置文件只取数字 ===');
check(plan('1 7; touch /tmp/pwned\n', '2026-09-27T06:00:00') !== 'none' && plan('$(reboot) 7\n', '2026-09-27T06:00:00') === 'none', '夹带命令：只认开头的数字，命令不执行');
check(plan('1 24\n', '2026-09-27T06:00:00') === 'none' && plan('2 7\n', '2026-09-27T06:00:00') === 'none' && plan('', '2026-09-27T06:00:00') === 'none', '超出范围或为空：不约');
const target = join(dir, 'real.conf'); writeFileSync(target, '1 7\n');
const link = join(dir, 'link.conf'); symlinkSync(target, link);
check(execFileSync(bin, ['--plan', link, String(at('2026-09-27T06:00:00'))], { env: { TZ }, encoding: 'utf8' }).trim() === 'none', '符号链接不跟随');
let refused = false;
try { execFileSync(bin, [], { stdio: 'pipe' }); } catch (e) { refused = (e as { status?: number }).status === 64; }
check(refused, '不是 root：拒绝运行，什么都不约');

console.log('\n=== 下次唤醒的显示 ===');
const sched = `Scheduled power events:
 [0]  wake at 09/28/2026 07:15:50 by '所闻'
 [1]  wake at 09/27/2026 19:54:59 by 'com.apple.alarm.user-invisible-com.apple.osanalytics'
 [2]  wake at 09/26/2026 07:15:50 by '所闻'`;
const next = parseNextWake(sched, new Date('2026-09-27T12:00:00').getTime());
check(next === new Date(2026, 8, 28, 7, 15, 50).getTime(), '只看「所闻」预约的、还没到的那次');
check(parseNextWake('Scheduled power events:\n', Date.now()) === null, '没有预约：不显示');

console.log('\n=== 登录项配置 ===');
const plist = (p: string): string => readFileSync(join(root, p), 'utf8');
const daemon = plist(`packaging/launch-daemons/${WAKE_SERVICE}`);
check(/<key>BundleProgram<\/key>\s*<string>Contents\/Resources\/bin\/pnr-wake<\/string>/.test(daemon), '唤醒服务运行包内签名的 pnr-wake');
check(/<key>AssociatedBundleIdentifiers<\/key>\s*<array>\s*<string>com\.yb311\.personal-newsroom<\/string>/.test(daemon), '唤醒服务声明属于所闻');
// Labels once used by plists outside the bundle keep a disabled record in
// Background Task Management, which then refuses them to SMAppService.
const retired = ['com.yb311.personal-newsroom.update', 'com.yb311.personal-newsroom.wake'];
const labels = [daemon, plist('packaging/launch-agents/com.yb311.personal-newsroom.background.plist')]
  .map((x) => /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(x)?.[1]);
check(labels.every((l) => l && !retired.includes(l)), `不用退役的任务名（${labels.join('、')}）`);
check(readFileSync(join(root, 'native/wake/wake.c'), 'utf8').includes('"/Library/Application Support/personal-newsroom/wake.conf"'),
  '唤醒程序读的设置文件就在应用的数据文件夹里');

rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
