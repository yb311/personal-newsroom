/*
 * Browser side of the layout test: `__audit()` looks at what is on screen and
 * returns what is wrong with it, as plain sentences. It checks rules that hold
 * for every screen rather than one screen's pixels, so a new button or a longer
 * translation is covered without writing a new test:
 *
 *   reach      every control can be seen and clicked — it is not clipped away
 *              by a container that cannot scroll, and nothing sits on top of it
 *   overlap    controls that share a row do not overlap one another
 *   spill      a control stays inside the row that holds it
 *   label      a button's own label is never cut off (a name that is not
 *              legible is not a control)
 *   lights     nothing sits under the window's traffic lights
 *   scroll     the page, and vertical lists, never scroll sideways
 *   console    nothing threw while rendering (collected by the runner)
 *
 * A dialog that is open is audited alone: the page behind it is covered by design.
 * So is a floating layer (`data-floating`, such as the 划词翻译 bar): it sits over
 * the page on purpose, and the page under it is checked in the states without it.
 */
window.__audit = function audit(opts = {}) {
  const out = [];
  const TOL = 1;
  const root = document.querySelector('dialog[open]') ?? document.querySelector('[data-floating]') ?? document.body;
  const lights = opts.lights ?? { x: 76, y: 40 };

  const desc = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    const label = el.getAttribute('aria-label') || el.getAttribute('title')?.split('\n')[0] || (el.children.length === 0 ? el.textContent.trim() : '');
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}>${label ? ` “${label.slice(0, 18)}”` : ''}`;
  };
  const rect = (el) => el.getBoundingClientRect();
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = rect(el);
    return r.width > 0 && r.height > 0;
  };
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  const clipped = (cs) => cs.overflowX !== 'visible' || cs.overflowY !== 'visible';

  /** Where an element can be seen: its box cut by every ancestor that clips,
   *  inner to outer. Reaching past a clip that scrolls that way is fine (it can be
   *  scrolled to) and ends the question; reaching past one that does not is a fault. */
  const visibleBox = (el) => {
    const own = rect(el);
    let box = own;
    let hiddenForGood = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (!clipped(cs)) continue;
      const r = rect(a);
      const beyondX = own.left < r.left - TOL || own.right > r.right + TOL;
      const beyondY = own.top < r.top - TOL || own.bottom > r.bottom + TOL;
      if ((beyondX && scrolls(cs.overflowX)) || (beyondY && scrolls(cs.overflowY))) return { box, hiddenForGood: false, scrollable: true };
      if (beyondX || beyondY) hiddenForGood = true;
      box = meet(box, r);
    }
    return { box, hiddenForGood, scrollable: false };
  };

  // ── reach ──────────────────────────────────────────────────────────────────
  const controls = [...root.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], summary, [role=separator]')].filter(shown);
  for (const el of controls) {
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    const { box, hiddenForGood, scrollable } = visibleBox(el);
    if (scrollable) continue;
    const own = rect(el);
    if (hiddenForGood && area(box) < area(own) * 0.85) {
      out.push(`reach: ${desc(el)} is cut off by a container that cannot scroll (${Math.round(100 * area(box) / area(own))}% visible)`);
      continue;
    }
    if (area(box) <= 0) continue; // scrolled out of a scrolling list: reachable by scrolling
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    if (hit && !el.contains(hit) && !hit.contains(el)) out.push(`reach: ${desc(el)} is covered by ${desc(hit)}`);
  }

  // ── overlap and spill in rows ──────────────────────────────────────────────
  for (const row of root.querySelectorAll('*')) {
    const cs = getComputedStyle(row);
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
    if (cs.flexDirection !== 'row' && cs.flexDirection !== 'row-reverse') continue;
    if (cs.flexWrap !== 'nowrap') continue;
    const kids = [...row.children].filter((k) => shown(k) && getComputedStyle(k).position !== 'absolute');
    if (kids.length < 2) continue;
    const rr = rect(row);
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const m = meet(rect(kids[i]), rect(kids[j]));
        if (m.right - m.left > TOL && m.bottom - m.top > TOL) out.push(`overlap: ${desc(kids[i])} and ${desc(kids[j])} overlap in ${desc(row)} by ${Math.round(m.right - m.left)}px`);
      }
    }
    if (scrolls(cs.overflowX)) continue;
    for (const k of kids) {
      const r = rect(k);
      if (r.left < rr.left - TOL || r.right > rr.right + TOL) out.push(`spill: ${desc(k)} sticks out of ${desc(row)} by ${Math.round(Math.max(rr.left - r.left, r.right - rr.right))}px`);
    }
  }

  // ── a button's label is never cut off ──────────────────────────────────────
  for (const el of root.querySelectorAll('button, .tag, .badge, .chip, .segmented button, .push, .primary')) {
    if (!shown(el)) continue;
    for (const node of [el, ...el.querySelectorAll('span')]) {
      const cs = getComputedStyle(node);
      // An ellipsis is a label shortening on purpose (the status line in the sidebar); a plain clip is a fault.
      if (node.scrollWidth > node.clientWidth + TOL && cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis' && node.textContent.trim()) {
        out.push(`label: the label of ${desc(el)} is cut off (${node.scrollWidth}px of text in ${node.clientWidth}px)`);
        break;
      }
    }
  }

  // ── traffic lights ─────────────────────────────────────────────────────────
  if (!opts.noLights && !document.querySelector('dialog[open]')) {
    const zone = { left: 0, top: 0, right: lights.x, bottom: lights.y };
    const hits = [];
    for (const el of document.querySelectorAll('button, input, svg, img')) {
      if (shown(el) && area(meet(rect(el), zone)) > 0 && !el.closest('[hidden]')) hits.push(el);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // Cheap test first: only text whose element reaches the corner is worth measuring.
      if (!n.parentElement || area(meet(rect(n.parentElement), zone)) <= 0 || !n.textContent.trim() || !shown(n.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (area(meet(r, zone)) > 0) { hits.push(n.parentElement); break; }
    }
    for (const el of new Set(hits)) {
      const r = rect(el);
      out.push(`lights: ${desc(el)} sits under the window's traffic lights (left edge ${Math.round(r.left)}px, must be at least ${lights.x}px)`);
    }
  }

  // ── sideways scrolling ─────────────────────────────────────────────────────
  const page = document.documentElement;
  if (page.scrollWidth > innerWidth + TOL) out.push(`scroll: the page is ${page.scrollWidth}px wide in a ${innerWidth}px window`);
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollWidth <= el.clientWidth + TOL) continue;
    const cs = getComputedStyle(el);
    if (!scrolls(cs.overflowY) || !shown(el) || el.matches('pre, code, table, textarea')) continue; // code and wide tables scroll sideways by design
    if (el.scrollWidth > el.clientWidth + TOL) out.push(`scroll: ${desc(el)} scrolls sideways (${el.scrollWidth}px of content in ${el.clientWidth}px)`);
  }

  return out;
};

/** The 社交平台 sheet: a platform list beside a grid of routes. Checks what the
 *  generic rules cannot: that the two sit on one line and that each card reads
 *  from its left edge, as the card text once sat centred as a block. */
window.__auditPicker = function auditPicker() {
  const out = [];
  const nav = document.querySelector('.rsshub-picker .platforms');
  const pane = document.querySelector('.rsshub-picker .routes-pane');
  if (!nav || !pane) return ['picker: the platform list or the route pane is missing'];
  const first = nav.querySelector('button');
  const card = pane.querySelector('.route-list button');
  if (first && card && Math.abs(first.getBoundingClientRect().top - card.getBoundingClientRect().top) > 2) {
    out.push('picker: the platform list and the route cards do not start on the same line');
  }
  for (const c of pane.querySelectorAll('.route-list button')) {
    const title = c.querySelector('strong'); const hint = c.querySelector('small');
    if (!title || !hint) continue;
    const cl = c.getBoundingClientRect().left;
    if (Math.abs(title.getBoundingClientRect().left - hint.getBoundingClientRect().left) > 1) { out.push('picker: a route card’s title and hint do not start at the same edge'); break; }
    if (title.getBoundingClientRect().left - cl > 18) { out.push('picker: route card text is centred in the card instead of starting at its left edge'); break; }
  }
  for (const b of nav.querySelectorAll('button')) {
    if (b.scrollWidth > b.clientWidth + 1) { out.push(`picker: the platform name “${b.textContent}” does not fit its list`); break; }
  }
  return out;
};
