/**
 * Adding a source: two routes of one platform are two sources, and adding the
 * same one twice is refused. Sources used to be named from the first 18 bytes
 * of their address, so /bilibili/user/video/<any uid> all got one id and the
 * second was refused as a duplicate.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../packages/store/src/index.ts';
import { createApi } from '../apps/desktop/src/ipc.ts';

const dir = mkdtempSync(join(tmpdir(), 'pnr-add-source-'));
const db = openDb(join(dir, 'newsroom.db'));
const api = createApi(db, dir);
let bad = 0;
const check = (ok: boolean, what: string): void => { if (!ok) bad++; console.log(`  ${ok ? '✅' : '❌'} ${what}`); };

const a = await api.addSource({ kind: 'rsshub', value: '/bilibili/user/video/2267573', name: 'A' });
const b = await api.addSource({ kind: 'rsshub', value: '/bilibili/user/video/2267574', name: 'B' });
const again = await api.addSource({ kind: 'rsshub', value: '/bilibili/user/video/2267573', name: 'A again' });
check(a.ok && b.ok, '同一平台的两条路由都能加');
check(Boolean(a.id) && a.id !== b.id, '两条路由是两个来源（id 不同）');
check(!again.ok && again.error === 'duplicate', '同一条路由再加一次被拒绝，原因是 duplicate');
const rows = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE added_by = 'user'").get() as { n: number };
check(rows.n === 2, `库里是两个用户来源（实际 ${rows.n}）`);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 项不符预期` : '\n添加来源全部符合预期');
process.exit(bad ? 1 : 0);
