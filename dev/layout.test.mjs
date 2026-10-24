/*
 * Layout test: opens the real, built interface in a hidden Electron window and
 * looks for the kind of fault that is easy to ship and hard to notice — a
 * button hidden under the traffic lights, a settings button pushed out of the
 * sidebar by a long label, two controls on top of each other — at every window
 * width, sidebar width, language and state it can reach.
 *
 *   npm run test:layout            full matrix (about a minute)
 *   LAYOUT_QUICK=1 npm run test:layout   a thin slice, for quick checks
 *
 * What it checks is written once, in dev/layout/audit.js, as rules that hold on
 * every screen (see the header there). Because the rules are general, a new
 * control or a longer translation is covered without a new test. Besides the
 * rules, a few scenarios replay a mistake that really happened, so it cannot
 * come back (the list that jumps to another source after a slow refresh; the
 * platform picker laid out crooked).
 *
 * Needs `vite build` first (the npm script does it). Runs offline, with made-up
 * data instead of a database (dev/layout/fixture.js).
 */
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'apps/desktop/dist/renderer');
const QUICK = Boolean(process.env.LAYOUT_QUICK);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

const feeds = JSON.parse(readFileSync(join(ROOT, 'catalogs/data/feeds.json'), 'utf8')).slice(0, 300).map((f, i) => ({ ...f, enabled: i % 7 === 0 }));
const routes = JSON.parse(readFileSync(join(ROOT, 'catalogs/data/rsshub-routes.json'), 'utf8'));
const fixtureJs = readFileSync(join(ROOT, 'dev/layout/fixture.js'), 'utf8');
const auditJs = readFileSync(join(ROOT, 'dev/layout/audit.js'), 'utf8');

if (!existsSync(join(DIST, 'index.html'))) { console.error('没有构建好的界面：先运行 npm run test:layout（它会先构建）'); process.exit(2); }

/** The page under test: the built app with `window.pnr` replaced by the fixture. */
function page(q) {
  const config = { lang: q.get('lang') ?? 'zh-CN', ai: q.get('ai') === '1', packReady: q.get('pack') !== '0', feeds, routes };
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const css = html.match(/href="([^"]*index-[^"]*\.css)"/)[1];
  const js = html.match(/src="([^"]*index-[^"]*\.js)"/)[1];
  return `<!doctype html><html lang="${config.lang}"><head><meta charset="utf-8"><title>layout</title><link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div>
<script>
  window.__layoutConfig = ${JSON.stringify(config)};
  try {
    localStorage.clear();
    ${q.get('sidebar') ? `localStorage.setItem('pnr.sidebarWidth', '${q.get('sidebar')}');` : ''}
    ${q.get('assistant') === '1' ? "localStorage.setItem('pnr.assistantOpen', '1');" : ''}
    ${q.get('chat') === '1' ? "localStorage.setItem('pnr.assistantChat', 'c1');" : ''}
  } catch {}
</script>
<script>${fixtureJs}</script>
<script>${auditJs}</script>
<script type="module" src="${js}"></script></body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/layout.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(url.searchParams)); return; }
  const file = join(DIST, url.pathname);
  if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Findings, grouped by sentence: one fault seen in forty states is one line. */
const found = new Map();
let audits = 0;

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(Number(process.env.LAYOUT_SERVE) || 0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // LAYOUT_SERVE=<port> serves the fixture page for looking at by hand, e.g. in a browser:
  //   http://127.0.0.1:<port>/layout.html?lang=en&ai=1&sidebar=190&assistant=1&pack=0
  if (process.env.LAYOUT_SERVE) { console.log(`http://127.0.0.1:${server.address().port}/layout.html`); return; }
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  let where = '';
  const report = (message) => {
    const entry = found.get(message) ?? { states: [] };
    entry.states.push(where); found.set(message, entry);
  };
  wc.on('console-message', (...a) => {
    const e = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] };
    if (e.level === 'error' || e.level === 3) report(`console: ${String(e.message).slice(0, 160)}`);
  });
  wc.on('render-process-gone', (_e, d) => report(`crash: the page died (${d.reason})`));

  const js = (code) => Promise.race([
    wc.executeJavaScript(code),
    sleep(15000).then(() => { throw new Error(`the page stopped answering at “${where}” while running: ${String(code).slice(0, 90)}`); })
  ]);
  const load = async (params, hash = '') => {
    await win.loadURL(`${base}/layout.html?${new URLSearchParams(params)}${hash}`);
    for (let i = 0; i < 100; i++) { if (await js("Boolean(document.querySelector('.app, .settings-window #root > *'))")) break; await sleep(30); }
    await sleep(120);
  };
  const size = async (w, h) => { win.setContentSize(w, h); await sleep(110); };
  const command = async (c) => { await js(`__fx.command(${JSON.stringify(c)}); true`); await sleep(90); };
  const audit = async (label, opts) => {
    where = label; audits++;
    if (process.env.LAYOUT_VERBOSE) console.log(label);
    const messages = await js(`__audit(${JSON.stringify(opts ?? {})})`);
    if (process.env.LAYOUT_VERBOSE) console.log(`  → ${messages.length}`, await js("[innerWidth, document.querySelector('.sidebar')?.getBoundingClientRect().width, document.querySelector('.assistant')?.getBoundingClientRect().width].join(' ')"));
    for (const message of messages) report(message);
  };
  /** Polls until `test` (page code) is true. */
  const until = async (test, ms = 3000) => { for (let t = 0; t < ms; t += 40) { if (await js(test)) return true; await sleep(40); } return false; };

  const WIDTHS = QUICK ? [760, 1100] : [760, 900, 1100, 1440];
  const SIDEBARS = QUICK ? [190, 360] : [190, 220, 360];
  const MODES = QUICK ? [['zh-CN', false], ['en', true]] : [['zh-CN', false], ['en', false], ['zh-CN', true], ['en', true]];
  const HEIGHT = 700;

  // Debugging aid: LAYOUT_EVAL='<page code>' prints what that code returns in one state, then stops.
  if (process.env.LAYOUT_EVAL) {
    await load({ lang: process.env.LAYOUT_LANG ?? 'zh-CN', ai: '0', sidebar: process.env.LAYOUT_SIDEBAR ?? '190' });
    await size(Number(process.env.LAYOUT_WIDTH ?? 1100), HEIGHT);
    console.log(JSON.stringify(await js(process.env.LAYOUT_EVAL), null, 1));
    server.close(); app.exit(0); return;
  }

  // ── the main window, in every state the layout can be in ─────────────────
  for (const [lang, ai] of MODES) {
    for (const sidebar of SIDEBARS) {
      const tag = `${lang}${ai ? '+AI' : ''} sidebar=${sidebar}`;
      await load({ lang, ai: ai ? '1' : '0', sidebar });
      for (const pass of ['list', 'item']) {
        if (pass === 'item') { await command('read'); await js("document.querySelector('.row-item')?.click()"); await sleep(120); }
        for (const view of pass === 'list' ? ['read', 'today', 'flashes', 'watches'] : ['read']) {
          for (const w of WIDTHS) {
            for (const assistant of [false, true]) {
              await size(w, HEIGHT);
              const open = await js("Boolean(document.querySelector('.assistant'))");
              if (open !== assistant) await command('assistant');
              await command(view);
              const label = `${tag} ${w}px ${view}${pass === 'item' ? '+article' : ''}${assistant ? ' +assistant' : ''}`;
              await audit(label);
              // The article translated: the bar above it, translations under each block, the title's.
              if (pass === 'item' && ai) {
                await command('translate');
                await until("Boolean(document.querySelector('.translate-bar') && document.querySelector('.prose .pnr-t'))");
                await audit(`${label} translated`);
                await js("document.querySelectorAll('.translate-bar .segmented button')[1]?.click()"); await sleep(80);
                await audit(`${label} translation only`);
                await js("document.querySelectorAll('.translate-bar .segmented button')[0]?.click()"); await sleep(40);
                await command('translate');
              }
              // A toolbar short of room folds its search field into a button; opened, the field takes the article buttons' place.
              if (await js("Boolean(document.querySelector('.search-toggle')?.offsetParent)")) {
                await js("document.querySelector('.search-toggle').click()"); await sleep(80);
                await audit(`${label} search opened`);
                if (!await js("document.activeElement === document.querySelector('.toolbar .search-field input')")) { where = label; report('search: opening the folded search field does not put the cursor in it'); }
                await js("document.querySelector('.toolbar .search-field input').blur()"); await sleep(40);
              }
              // Holding ⌥ changes 全部更新 into a longer label (it lives in the sidebar).
              if (await js("Boolean(document.querySelector('.sidebar'))")) {
                await js("window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true }))"); await sleep(50);
                await audit(`${label} ⌥`);
                await js("window.dispatchEvent(new KeyboardEvent('keyup', { altKey: false }))");
              }
            }
          }
          if (await js("Boolean(document.querySelector('.assistant'))")) await command('assistant');
        }
      }
    }
  }

  // ── the shortest window the app allows (minHeight 520) ───────────────────
  for (const [lang, ai] of QUICK ? [['zh-CN', false]] : [['zh-CN', false], ['en', true]]) {
    await load({ lang, ai: ai ? '1' : '0', sidebar: '220' });
    await js("document.querySelector('.row-item')?.click()");
    for (const w of [760, 1100]) {
      for (const view of ['read', 'today', 'flashes', 'watches']) {
        await size(w, 520); await command(view);
        await audit(`${lang}${ai ? '+AI' : ''} ${w}x520 ${view}`);
      }
    }
  }

  // ── 划词翻译: the bar beside a selection, and the translation it turns into ──
  for (const lang of QUICK ? ['zh-CN'] : ['zh-CN', 'en']) {
    await load({ lang, ai: '1', sidebar: '220', assistant: '1', chat: '1' });
    await js("document.querySelector('.row-item')?.click()"); await sleep(200);
    for (const w of [760, 1100]) {
      await size(w, HEIGHT);
      for (const [area, selector] of [['article', '.prose p'], ['assistant', '.assistant .answer p']]) {
        const selected = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
          const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);
        if (!selected) { where = `${lang} selection ${area}`; report(`selection: nothing to select in ${area}`); continue; }
        if (!await until("Boolean(document.querySelector('.selection-popover .selection-actions'))")) { where = `${lang} selection ${area}`; report('selection: selecting text shows no translate bar'); continue; }
        await audit(`${lang} ${w}px selection bar in ${area}`);
        await js("document.querySelector('.selection-popover .selection-actions button').click()");
        if (!await until("Boolean(document.querySelector('.selection-popover .selection-result'))")) { report('selection: 翻译 shows no translation'); continue; }
        await audit(`${lang} ${w}px selection translated in ${area}`);
        await js("document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))"); await sleep(60);
      }
    }
  }

  // ── the assistant with a conversation in it (answers, citations, an agent's cards) ──
  for (const lang of QUICK ? ['zh-CN'] : ['zh-CN', 'en']) {
    await load({ lang, ai: '1', assistant: '1', chat: '1', sidebar: '220' });
    for (const w of [760, 1100, 1440]) {
      await size(w, HEIGHT);
      await js("document.querySelector('.assistant')?.scrollIntoView?.()");
      await audit(`${lang} assistant conversation ${w}px`);
    }
  }

  // ── what each view shows once something in it is picked ──────────────────
  // Every row of 今日 (the brief, 关注之外, headlines or an earlier edition), the
  // richest flash, each section of a watch with a correction being written, the
  // add-watch sheet, and the assistant's history and welcome.
  for (const [lang, ai] of QUICK ? [['zh-CN', true]] : MODES) {
    await load({ lang, ai: ai ? '1' : '0', sidebar: '220' });
    const tag = `${lang}${ai ? '+AI' : ''}`;
    for (const w of QUICK ? [760, 1100] : [760, 900, 1440]) {
      for (const assistant of [false, true]) {
        await size(w, HEIGHT);
        if (await js("Boolean(document.querySelector('.assistant'))") !== assistant) await command('assistant');
        const at = `${tag} ${w}px${assistant ? ' +assistant' : ''}`;
        await command('today'); await sleep(150);
        const rows = await js("document.querySelectorAll('.split-view .row-item').length");
        for (let i = 0; i < rows; i++) {
          await js(`document.querySelectorAll('.split-view .row-item')[${i}]?.click()`); await sleep(160);
          await audit(`${at} today row ${i}`);
          await js("document.querySelector('.detail-back:not([hidden])')?.click()"); await sleep(40);
        }
        await command('flashes'); await sleep(120);
        await js("document.querySelector('.split-view .row-item')?.click()"); await sleep(120);
        await audit(`${at} flash`);
        await command('watches'); await sleep(120);
        await js("document.querySelector('.split-view .row-item')?.click()"); await sleep(150);
        for (const section of [0, 1, 2]) {
          await js(`document.querySelectorAll('.segmented.tabs button')[${section}]?.click()`); await sleep(160);
          await audit(`${at} watch section ${section}`);
          if (section === 1) {
            await js("document.querySelector('.watch-items .verdicts .tool:last-child')?.click()"); await sleep(80);
            await audit(`${at} watch correction`);
            await js("document.querySelector('.watch-items .note-row .push')?.click()"); await sleep(40);
          }
        }
        if (assistant && ai) {
          // By icon, not position: the bar's buttons come and go with what the assistant shows.
          await js("document.querySelector('.assistant-bar .lucide-history')?.closest('button')?.click()"); await sleep(150);
          await audit(`${at} assistant history`);
          await js("document.querySelector('.assistant-bar .lucide-plus')?.closest('button')?.click()"); await sleep(150);
          await audit(`${at} assistant welcome`);
        }
      }
    }
    await size(760, HEIGHT);
    await command('watches'); await sleep(100);
    await js("document.querySelector('.toolbar-list .tool:last-child')?.click()"); await sleep(200);
    await audit(`${tag} add watch sheet`);
    await js("document.querySelectorAll('dialog[open] .segmented button')[1]?.click()"); await sleep(120);
    await audit(`${tag} add watch sheet, own words`);
    await js("document.querySelector('dialog[open] .dialog-actions .push')?.click()"); await sleep(120);
  }

  // ── sheets: 订阅管理, with its three tabs, with and without the RSSHub banner ─
  for (const lang of QUICK ? ['zh-CN'] : ['zh-CN', 'en']) {
    for (const pack of ['1', '0']) {
      await load({ lang, ai: '0', pack });
      for (const [w, h] of [[760, HEIGHT], [1100, HEIGHT], [760, 520]]) {
        await size(w, h);
        await command('subscribe');
        for (const tabIndex of [0, 1, 2]) {
          await js(`document.querySelectorAll('.modal > header .segmented button')[${tabIndex}].click()`); await sleep(250);
          const label = `${lang} sheet tab ${tabIndex} pack=${pack} ${w}x${h}`;
          await audit(label);
          if (tabIndex === 1) {
            where = label;
            for (const message of await js('__auditPicker()')) report(message);
            // Open a route that needs input, so its form is checked as well.
            await js("document.querySelector('.route-list button')?.click()"); await sleep(150);
            await audit(`${label} route form`);
            for (const message of await js('__auditPicker()')) report(message);
          }
        }
        await js("document.querySelector('.modal > header .push').click()"); await sleep(200);
      }
    }
  }

  // ── a slow refresh must not change which source's articles are listed ────
  // The bug: after adding a source the app refreshes. If you open another source
  // while that runs, the refresh used to put the old source's articles back into
  // the list, under the new source's name.
  await load({ lang: 'zh-CN', ai: '0' });
  await size(1100, HEIGHT);
  where = 'slow refresh';
  await js('window.__release = __fx.block("refresh"); true');
  await command('subscribe'); await sleep(200);
  await js("document.querySelector('.catalogue input[type=checkbox]').click()"); await sleep(150);
  await js("document.querySelector('.modal > header .push').click()");        // 完成 → the app refreshes, and waits
  await sleep(300);
  const rows = await js("[...document.querySelectorAll('.side-row.source')].map((b) => b.textContent)");
  const pick = async (i) => { await js(`document.querySelectorAll('.side-row.source')[${i}].click()`); await sleep(250); };
  await pick(0);                                                              // look at one source
  await pick(3);                                                              // then at another
  const wanted = await js("document.querySelector('.toolbar-title h1').textContent");
  await js('window.__release(); true'); await sleep(500);                           // the refresh finishes
  const shown = await js("[...new Set([...document.querySelectorAll('.row-item .src')].map((e) => e.textContent))]");
  const title = await js("document.querySelector('.toolbar-title h1').textContent");
  if (title !== wanted) report(`jump: the title changed from “${wanted}” to “${title}” when a refresh finished`);
  if (shown.length !== 1 || shown[0] !== wanted) report(`jump: the list shows ${JSON.stringify(shown)} under the title “${wanted}” after a refresh finished (sources: ${rows.length})`);

  // ── Settings, its own window ─────────────────────────────────────────────
  for (const lang of QUICK ? ['zh-CN'] : ['zh-CN', 'en']) {
    await load({ lang, ai: '1' }, '#settings');
    for (const [w, h] of [[720, 580], [620, 440]]) {
      await size(w, h);
      const count = await js("document.querySelectorAll('.settings-sidebar button').length");
      for (let i = 0; i < count; i++) {
        await js(`document.querySelectorAll('.settings-sidebar button')[${i}].click()`); await sleep(250);
        await audit(`${lang} settings ${w}x${h} section ${i}`);
      }
    }
  }

  // ── verdict ──────────────────────────────────────────────────────────────
  console.log(`\n${audits} 个状态已检查（${QUICK ? '快速' : '完整'}矩阵）`);
  for (const [message, { states }] of found) {
    const shownStates = [...new Set(states)];
    console.log(`\n✗ ${message}\n    ${shownStates.length} 个状态，例如：${shownStates.slice(0, 3).join(' ｜ ')}`);
  }
  console.log(found.size ? `\n版式检查失败：${found.size} 类问题` : '\n版式检查通过');
  server.close(); app.exit(found.size ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
