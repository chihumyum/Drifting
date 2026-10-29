// Heavy-seed interaction journeys, evaluated in the renderer through the
// frontend debug bridge by scripts/perf-stress-baseline.ts. DOM-level only: the
// same code drives a Debug development renderer and a --release-perf production
// bundle, which exposes no internal modules. Each journey returns compact
// numbers; frame timing is only comparable while the window keeps focus, and
// every result says whether it did.
(() => {
  const VERSION = 1;
  if (window.__driftingPerf && window.__driftingPerf.version === VERSION) return 'already';
  const P = { version: VERSION, jobs: {} };
  // A hidden window runs no frames at all; fall back to a timer so a journey
  // still finishes (its frame numbers are then marked unfocused).
  const raf = () => new Promise((resolve) => {
    requestAnimationFrame(resolve);
    setTimeout(resolve, document.visibilityState === 'hidden' ? 50 : 1000);
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const round = (value) => (value == null ? value : Math.round(value * 10) / 10);
  const dom = () => document.getElementsByTagName('*').length;
  const editors = () => document.querySelectorAll('.ProseMirror').length;

  function stats(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1]),
      over50: sorted.filter((x) => x > 50).length, over100: sorted.filter((x) => x > 100).length };
  }

  // Frame gaps while the document has focus; an unfocused window is throttled.
  function monitor() {
    const m = { gaps: [], running: true, last: 0, unfocusedFrames: 0 };
    const loop = (t) => {
      if (!m.running) return;
      if (!document.hasFocus()) { m.unfocusedFrames += 1; m.last = 0; }
      else { if (m.last) m.gaps.push(t - m.last); m.last = t; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    m.stop = () => { m.running = false; return { frames: stats(m.gaps), focused: m.unfocusedFrames === 0 }; };
    return m;
  }

  // Run an action, wait until ready() holds (checked each frame), two frames
  // for paint, then a settle window that catches trailing work.
  async function measure(action, ready, { timeout = 20000, settle = 1000 } = {}) {
    const m = monitor();
    await raf();
    const start = performance.now();
    let error;
    try { const result = action(); if (result && result.then) await result; } catch (caught) { error = String(caught); }
    let readyAt = null;
    while (performance.now() - start < timeout) {
      let ok = false;
      try { ok = !ready || ready(); } catch { ok = false; }
      if (ok) { readyAt = performance.now(); break; }
      await raf();
    }
    await raf(); await raf();
    const visibleMs = performance.now() - start;
    await sleep(settle);
    return { readyMs: readyAt == null ? null : round(readyAt - start), visibleMs: round(visibleMs), error, ...m.stop(), dom: dom(), editors: editors() };
  }

  function tap(element, { double = false } = {}) {
    const rect = element.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    element.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    element.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    if (double) element.dispatchEvent(new MouseEvent('dblclick', { ...base, detail: 2 }));
  }

  function key(code, keyValue, modifiers = {}, target = document.body) {
    const init = { key: keyValue, code, bubbles: true, cancelable: true, composed: true,
      metaKey: !!modifiers.meta, shiftKey: !!modifiers.shift, altKey: !!modifiers.alt, ctrlKey: !!modifiers.ctrl };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // By accessible label, else by visible text (icon glyphs and line breaks ignored).
  const button = (label) => {
    const buttons = [...document.querySelectorAll('button')];
    return buttons.find((b) => (b.getAttribute('aria-label') || '') === label)
      || buttons.find((b) => b.offsetParent && b.innerText.replace(/\s+/g, ' ').trim().replace(/^☰ /, '') === label);
  };
  const visibleEditors = () => [...document.querySelectorAll('.ProseMirror')].filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === 'visible'
      && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) : true);
  });
  const activeEditor = () => visibleEditors()[0] || null;
  const longEditorShown = () => { const el = activeEditor(); return !!el && el.textContent.length > 15000; };
  function scroller(element) {
    for (let node = element; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 10) return node;
    }
    return null;
  }
  async function scrollFor(element, { ms, step }) {
    const m = monitor();
    const start = performance.now();
    const top = element.scrollTop;
    while (performance.now() - start < ms) { element.scrollTop += step; await raf(); }
    await sleep(400);
    return { scrolled: Math.round(element.scrollTop - top), ...m.stop() };
  }
  // Summaries over repeated steps (tab switches, opens, closes).
  const summarize = (steps) => ({
    n: steps.length,
    visibleMs: stats(steps.map((s) => (s.readyMs == null ? 99999 : s.visibleMs))),
    frameMax: stats(steps.map((s) => (s.frames ? s.frames.max : 0))),
    timeouts: steps.filter((s) => s.readyMs == null).length,
    focused: steps.every((s) => s.focused),
    dom: steps.length ? steps[steps.length - 1].dom : dom(),
    editors: editors(),
  });
  async function ensureLeftSidebar() {
    if (button('展开左侧栏')) await measure(() => tap(button('展开左侧栏')), () => !!button('收起左侧栏'), { settle: 800 });
  }
  const chapterRow = (prefix) => [...document.querySelectorAll('.sand-cell')].find((e) => e.innerText.trim().startsWith(prefix));
  async function ensureChapterPanel() {
    await ensureLeftSidebar();
    if (chapterRow('第')) return;
    tap(button('章节'));
    await waitFor(() => chapterRow('第'), 10000, 'the chapter panel');
  }
  async function waitFor(find, timeout, what) {
    const start = performance.now();
    while (performance.now() - start < timeout) { const found = find(); if (found) return found; await sleep(100); }
    throw new Error(`Timed out waiting for ${what}`);
  }
  const projectCard = (name) => [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes(name));

  P.journeys = {
    async enterLocalMode({ project }) {
      // The page first checks its session; then either onboarding or the shelf appears.
      const onboarding = () => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('继续本地模式'));
      const first = await waitFor(() => onboarding() || projectCard(project), 60000, 'onboarding or the bookshelf');
      if (first === onboarding()) first.click();
      await waitFor(() => projectCard(project), 30000, 'the bookshelf');
      return { onboarding: first !== projectCard(project) };
    },

    async openProject({ name }) {
      const card = await waitFor(() => projectCard(name), 15000, `the ${name} card`);
      return measure(() => card.click(), () => location.hash.includes('/project/') && dom() > 400, { settle: 4000, timeout: 30000 });
    },

    async openChapter({ prefix }) {
      const clip = await waitFor(() => [...document.querySelectorAll('.btl-clip')].find((c) => c.innerText.trim().startsWith(prefix)), 15000, `the ${prefix} timeline clip`);
      return measure(() => tap(clip), longEditorShown, { settle: 2500 });
    },

    async typing({ n = 30, interval = 120, text = '潮', position = 'end' }) {
      const element = activeEditor();
      if (!element) throw new Error('No visible editor');
      const editor = element.editor;
      if (position === 'end') editor.commands.focus('end');
      else editor.chain().setTextSelection(Math.floor(editor.state.doc.content.size / 2)).focus().run();
      await sleep(400);
      // The browser text path needs document focus; otherwise drive the editor directly.
      const inputPath = document.hasFocus() ? 'execCommand' : 'editor.insertContent';
      const before = element.textContent.length;
      const m = monitor();
      const latency = [];
      for (let i = 0; i < n; i += 1) {
        const start = performance.now();
        if (inputPath === 'execCommand') document.execCommand('insertText', false, text);
        else editor.commands.insertContent(text);
        await raf(); await raf();
        latency.push(performance.now() - start);
        const wait = interval - (performance.now() - start);
        if (wait > 0) await sleep(wait);
      }
      await sleep(1500);
      const inserted = element.textContent.length - before;
      if (inserted < n * text.length) throw new Error(`Typing inserted ${inserted} of ${n * text.length} characters`);
      return { inputPath, inserted, keyToSecondFrame: stats(latency), ...m.stop() };
    },

    async scroll({ ms = 3000, step = 40 }) {
      const element = activeEditor();
      const target = element && scroller(element);
      if (!target) throw new Error('No scrollable editor');
      target.scrollTop = 0;
      await sleep(500);
      return scrollFor(target, { ms, step });
    },

    async idle({ ms = 4000 }) {
      const m = monitor();
      await sleep(ms);
      const animations = document.getAnimations ? document.getAnimations() : [];
      return { ...m.stop(), dom: dom(), editors: editors(), animations: animations.length,
        runningAnimations: animations.filter((a) => a.playState === 'running').length };
    },

    async sidebars({ open }) {
      const pairs = open ? [['展开左侧栏', '收起左侧栏'], ['展开右侧栏', '收起右侧栏']] : [['收起左侧栏', '展开左侧栏'], ['收起右侧栏', '展开右侧栏']];
      const out = {};
      for (const [from, to] of pairs) {
        const control = button(from);
        out[from] = control ? await measure(() => tap(control), () => !!button(to), { settle: 1500 }) : { skipped: true };
      }
      return out;
    },

    async sidebarPanels({ labels = ['要素', '构想', '章节', '素材库', '统计', 'Review'] }) {
      const out = {};
      for (const label of labels) {
        const control = button(label);
        if (!control) { out[label] = { missing: true }; continue; }
        const before = dom();
        out[label] = await measure(() => tap(control), () => dom() !== before, { settle: 1500, timeout: 5000 });
      }
      return out;
    },

    // Opens chapters from the chapter panel as kept tabs (a single click opens a
    // preview tab; a double click keeps it).
    async openTabs({ prefixes }) {
      await ensureChapterPanel();
      const steps = [];
      for (const prefix of prefixes) {
        const row = chapterRow(prefix);
        if (!row) { steps.push({ readyMs: null, missing: prefix }); continue; }
        row.scrollIntoView({ block: 'center' });
        await sleep(150);
        const before = location.hash;
        steps.push(await measure(() => tap(row), () => location.hash !== before && longEditorShown(), { settle: 500, timeout: 8000 }));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
        await sleep(300);
      }
      return { first: steps.slice(0, 3).map((s) => s.visibleMs), last: steps.slice(-3).map((s) => s.visibleMs), ...summarize(steps) };
    },

    async switchTabs({ count }) {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const steps = [];
      for (let i = 0; i < count; i += 1) {
        const before = location.hash;
        steps.push(await measure(() => key('ArrowRight', 'ArrowRight', { meta: true, alt: true }),
          () => location.hash !== before && longEditorShown(), { settle: 300, timeout: 5000 }));
      }
      return summarize(steps);
    },

    async search({ query = '修船厂', moves = 10 }) {
      const input = () => [...document.querySelectorAll('input,textarea')].find((i) => i.offsetParent && /搜索|Search/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '')));
      const open = await measure(() => key('KeyF', 'f', { meta: true, shift: true }), () => !!input(), { settle: 800, timeout: 5000 });
      const field = input();
      if (!field) throw new Error('Global search did not open');
      field.focus();
      const typing = [];
      let value = '';
      for (const character of query) {
        value += character;
        const before = dom();
        typing.push(await measure(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }, () => dom() !== before, { settle: 1200, timeout: 8000 }));
      }
      const moving = [];
      for (let i = 0; i < moves; i += 1) moving.push(await measure(() => key('ArrowDown', 'ArrowDown', {}, field), null, { settle: 150 }));
      key('Escape', 'Escape', {}, field);
      await sleep(500);
      return { open, typing: summarize(typing), moving: summarize(moving) };
    },

    async wholeBook() {
      await ensureChapterPanel();
      const control = button('通览全书');
      if (!control) throw new Error('No whole-book control');
      const hash = location.hash;
      const before = dom();
      const open = await measure(() => tap(control), () => location.hash !== hash && dom() > before + 200, { settle: 3000, timeout: 20000 });
      const target = [...document.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY)
        && e.scrollHeight > e.clientHeight + 500 && e.clientHeight > 300).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!target) return { open };
      return { open, scrollHeight: target.scrollHeight, slow: await scrollFor(target, { ms: 4000, step: 40 }), fast: await scrollFor(target, { ms: 3000, step: 150 }) };
    },

    async superViews() {
      const out = {};
      for (const [name, code] of [['storyGraph', 'Digit3'], ['elementPanorama', 'Digit4'], ['materialWorkbench', 'Digit5']]) {
        const before = dom();
        out[name] = await measure(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: code.slice(-1), code, metaKey: true, altKey: true, bubbles: true, cancelable: true })),
          () => Math.abs(dom() - before) > 100, { settle: 2500, timeout: 10000 });
      }
      return out;
    },

    async closeTabs({ max = 30 }) {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      // A Super View may be in front; Mod+W closes the active chapter tab.
      for (let i = 0; i < 20 && !longEditorShown(); i += 1) {
        key('ArrowRight', 'ArrowRight', { meta: true, alt: true });
        await sleep(400);
      }
      const steps = [];
      for (let i = 0; i < max && editors() > 0; i += 1) {
        const before = editors();
        steps.push(await measure(() => key('KeyW', 'w', { meta: true }), () => editors() < before, { settle: 500, timeout: 6000 }));
        if (steps.length >= 2 && steps.slice(-2).every((step) => step.readyMs == null)) break;
      }
      return { lastMs: steps.length ? steps[steps.length - 1].visibleMs : null, ...summarize(steps) };
    },
  };

  // Long journeys outlive one bridge evaluation; start them and poll the job.
  P.start = (id, name, options) => {
    P.jobs[id] = { state: 'running' };
    Promise.resolve()
      .then(() => P.journeys[name](options || {}))
      .then((value) => { P.jobs[id] = { state: 'done', value }; },
        (error) => { P.jobs[id] = { state: 'error', error: `${error}${error && error.stack ? `\n${error.stack}` : ''}` }; });
    return id;
  };
  P.focus = () => ({ focused: document.hasFocus(), visibility: document.visibilityState });
  window.__driftingPerf = P;
  return 'installed';
})()
