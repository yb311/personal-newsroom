/**
 * The root script behind 休眠时唤醒 Mac, offline: pmset is replaced by a stub
 * that only records its arguments, and the component's folder by a temporary
 * one. Nothing is booked and no password is needed.
 *
 *   npm run test:wake
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeScriptForTest, installCommands, removeCommands } from '../apps/desktop/src/wake.ts';

let bad = 0;
const check = (ok: boolean, label: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${label}`); };

const dir = mkdtempSync(join(tmpdir(), 'pnr-wake-'));
writeFileSync(join(dir, 'pmset'), `#!/bin/sh\necho "$*" >> "${dir}/calls.log"\n`);
chmodSync(join(dir, 'pmset'), 0o755);
const script = join(dir, 'schedule-wakes.sh');
writeFileSync(script, wakeScriptForTest.replace('PATH=/usr/bin:', `PATH=${dir}:/usr/bin:`).replace(/^DIR=.*$/m, `DIR="${dir}"`));
const run = (conf: string): string[] => {
  writeFileSync(join(dir, 'wake.conf'), conf);
  writeFileSync(join(dir, 'calls.log'), '');
  execFileSync('/bin/sh', [script]);
  return readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
};
const booked = (calls: string[]): string[] => calls.filter((c) => c.startsWith('schedule wake '));

console.log('=== 唤醒脚本 ===');
const all = booked(run(`2 7\n${dir}\n`));
check(all.length >= 7 && all.length <= 9 && all.every((c) => /^schedule wake \d\d\/\d\d\/\d\d \d\d:15:50 所闻$/.test(c)),
  `每 3 小时：约 8 次，都在 15 分 50 秒，署名「所闻」（${all.length} 次）`);
const hours = new Set(all.map((c) => Number(c.split(' ')[3]!.slice(0, 2))));
check([...hours].every((h) => (h - 7 + 24) % 3 === 0), `从每日时间起每 3 小时（${[...hours].sort((a, b) => a - b).join(',')} 点）`);
const daily = run(`1 8\n${dir}\n`);
check(booked(daily).length === 1 && booked(daily)[0]!.includes(' 08:15:50 '), '每天一次：只约 8:15:50');
check(daily.filter((c) => c.startsWith('schedule cancel wake ')).length >= all.length, '改设置时先取消之前约好的唤醒');
check(booked(run(`0 7\n${dir}\n`)).length === 0 && readFileSync(join(dir, 'wake.scheduled'), 'utf8') === '', '不唤醒：一次也不约');
check(booked(run(`2 7\n/Applications/已删除的所闻.app\n`)).length === 0, 'app 已被删除：不再唤醒别人的 Mac');
run(`2 7 $(touch ${dir}/pwned); rm -rf /nonexistent\n${dir}\n`);
check(!existsSync(join(dir, 'pwned')), '配置文件里的命令不会被执行，只取数字');

console.log('\n=== 安装与卸载命令 ===');
for (const [name, text] of [['安装', installCommands('/var/folders/x/pnr-wake-abc', 501)], ['卸载', removeCommands()]] as const) {
  const f = join(dir, `${name}.sh`); writeFileSync(f, text);
  let ok = true; try { execFileSync('/bin/sh', ['-n', f]); } catch { ok = false; }
  check(ok, `${name}命令语法正确`);
}
check(/install -o 501 -g staff -m 644 .*wake\.conf/.test(installCommands('/tmp/x', 501)), '配置文件归用户所有：之后改设置不用再输密码');
check(/install -o root -g wheel -m 755 .*schedule-wakes\.sh/.test(installCommands('/tmp/x', 501)), '以 root 运行的脚本归 root 所有，用户改不了');

rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符合预期` : '\n全部符合预期');
process.exit(bad ? 1 : 0);
