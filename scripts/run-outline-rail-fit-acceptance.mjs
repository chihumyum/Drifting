import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { createServer } from 'vite';
import { launchHeadlessBrowser } from './renderer-headless-browser.mjs';

// DOM-level acceptance of the outline rail's fit beside the paper
// (docs/editor/semantic-outline-rail.md, "Fit beside the paper"): the real
// EditorOutlineRail, viewport controller and global sheets in Chromium, an
// editor column resized independently of the window, and CDP pointer/keyboard
// input so :hover and :focus-visible are the browser's own.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/outline-rail-fit.json');
const inputs = [
  'scripts/run-outline-rail-fit-acceptance.mjs', 'scripts/renderer-headless-browser.mjs',
  'scripts/renderer-outline-rail-fit.tsx', 'scripts/renderer-outline-rail-fit.html',
  'src/renderer/components/editor/EditorOutlineRail.tsx',
  'src/renderer/components/editor/outline-viewport.ts',
  'src/renderer/components/editor/outline-rail-model.ts',
  'src/styles/index.css', 'src/styles/comments-review.css', 'src/styles/ui-controls.css',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of inputs) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
};
const before = fingerprint();
// Mirrors outline-rail-model.ts; the evidence records both so a drift is visible.
const DOTS_BELOW = 196;
const LABELS_AT = 212;

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, before, 'Regenerate outline rail fit evidence.');
  assert(Object.values(report.checks).every(Boolean), 'Every outline rail fit check must pass.');
  console.log('Outline rail fit evidence matches current source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-outline-fit-'));
  let server, browser, client;
  try {
    server = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'),
      envDir: false, logLevel: 'error', cacheDir: path.join(temporary, 'vite'),
      server: { host: '127.0.0.1', port: 0, hmr: false, open: false },
    });
    await server.listen();
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'chrome') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable();
    await client.Runtime.enable();
    const errors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.text));
    const evaluate = async (expression) => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async (expression) => {
      for (let i = 0; i < 400; i++) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await delay(25);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const frames = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const windowSize = (width) => client.Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: false });
    const column = async (width) => { await evaluate(`__RAIL_FIT__.setColumn(${width})`); await frames(); await frames(); };
    const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    // One reading of the rail against the paper's text, in viewport pixels.
    const inspect = () => evaluate(`(() => {
      const rail = document.querySelector('.editor__toc-rail');
      if (!rail) return { mounted: false };
      const body = document.querySelector('.editor-body').getBoundingClientRect();
      const text = Math.min(...[...document.querySelectorAll('[data-fixture=text]')].map(el => el.getBoundingClientRect().left));
      const tags = [...rail.querySelectorAll('.editor__toc-tag')].map(el => {
        const r = el.getBoundingClientRect(); const dot = getComputedStyle(el, '::before');
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, primary: el.classList.contains('is-primary'),
          textOpacity: Number(getComputedStyle(el.querySelector('.editor__toc-tag-text')).opacity),
          dot: dot.content === 'none' ? null : { width: parseFloat(dot.width), opacity: Number(dot.opacity), background: dot.backgroundColor } };
      });
      const surfaceEl = rail.querySelector('.editor__toc-surface');
      const s = surfaceEl && getComputedStyle(surfaceEl); const sr = surfaceEl?.getBoundingClientRect();
      return { mounted: true, fit: rail.dataset.fit, gutter: text - body.left, textLeft: text, bodyLeft: body.left,
        windowWidth: innerWidth, columnWidth: body.width, tags,
        surface: surfaceEl ? { visibility: s.visibility, opacity: Number(s.opacity), left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom, background: s.backgroundColor } : null };
    })()`);
    const settle = async (milliseconds = 420) => { await delay(milliseconds); await frames(); };

    await windowSize(1600);
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-outline-rail-fit.html` });
    await until('window.__RAIL_FIT__ && document.querySelector(".editor__toc-rail .editor__toc-tag")');
    await evaluate('document.fonts.ready');
    await frames();

    const states = {};
    // Wide column: the plain-text lane, clear of the text.
    await column(1280);
    states.wide = await inspect();
    assert.equal(states.wide.fit, 'labels', JSON.stringify(states.wide));
    assert(states.wide.gutter >= LABELS_AT);
    const wideClear = states.wide.tags.every(tag => tag.right <= states.wide.textLeft && tag.dot === null && tag.textOpacity === 1);
    assert(wideClear, 'Wide labels must stay plain text clear of the paper text.');
    assert.equal(states.wide.surface, null);

    // Two side panels open: a ~400px column inside the same 1600px window.
    await column(400);
    states.narrow = await inspect();
    assert.equal(states.narrow.fit, 'dots', JSON.stringify(states.narrow));
    assert(states.narrow.gutter < DOTS_BELOW);
    const dotsClear = states.narrow.tags.every(tag => tag.right <= states.narrow.textLeft && tag.right - tag.left <= 14.5
      && tag.textOpacity === 0 && tag.dot && tag.dot.opacity === 1);
    assert(dotsClear, `Dots must stay clear of the text: ${JSON.stringify(states.narrow.tags)}`);
    const primary = states.narrow.tags.find(tag => tag.primary);
    assert(primary && primary.dot.width === 6, 'The reading location is the larger dot.');
    assert(states.narrow.tags.filter(tag => !tag.primary).every(tag => tag.dot.width < 6));
    assert.equal(states.narrow.surface.visibility, 'hidden');
    // The same column in a much wider window is still dots: the window decides nothing.
    await windowSize(2400); await frames(); await frames();
    states.narrowInWideWindow = await inspect();
    assert.equal(states.narrowInWideWindow.fit, 'dots');
    await windowSize(1600); await frames();

    // Hovering a dot unfolds the labels onto the surface, over the text.
    const target = states.narrow.tags[2];
    await mouse('mouseMoved', (target.left + target.right) / 2, (target.top + target.bottom) / 2);
    await settle();
    states.hovered = await inspect();
    assert.equal(states.hovered.surface.visibility, 'visible');
    assert.equal(states.hovered.surface.opacity, 1);
    const unfolded = states.hovered.tags.every(tag => tag.textOpacity === 1 && tag.dot.opacity === 0)
      && states.hovered.tags.some(tag => tag.right > states.hovered.textLeft);
    assert(unfolded, 'Hover unfolds every label to full text.');
    const onSurface = states.hovered.tags.every(tag => tag.left >= states.hovered.surface.left && tag.right <= states.hovered.surface.right
      && tag.top >= states.hovered.surface.top && tag.bottom <= states.hovered.surface.bottom);
    assert(onSurface, `Every unfolded label sits on the surface: ${JSON.stringify(states.hovered)}`);
    // The label, not the prose under it, takes the pointer where it overlaps the text.
    const over = states.hovered.tags.find(tag => tag.right > states.hovered.textLeft + 20);
    const hit = await evaluate(`(() => { const el = document.elementFromPoint(${over.right - 8}, ${(over.top + over.bottom) / 2}); return el?.closest('.editor__toc-tag') ? 'label' : el?.closest('.editor__toc-surface') ? 'surface' : el?.closest('[data-fixture=text]') ? 'text' : el?.className; })()`);
    assert.equal(hit, 'label');
    // Moving along the surface between labels keeps it open.
    const next = states.hovered.tags[3];
    await mouse('mouseMoved', next.left + 30, (target.bottom + next.top) / 2);
    await settle(200);
    const between = await inspect();
    assert.equal(between.surface.visibility, 'visible');

    // A click on an unfolded label navigates through the canonical jump.
    const destination = states.hovered.tags[9];
    const scrollBefore = await evaluate('document.querySelector(".editor-scroll").scrollTop');
    await mouse('mousePressed', destination.left + 20, (destination.top + destination.bottom) / 2);
    await mouse('mouseReleased', destination.left + 20, (destination.top + destination.bottom) / 2);
    await settle(900);
    const labelJump = await evaluate(`(() => { const root = document.querySelector('.editor-scroll'); const id = [...document.querySelectorAll('.editor__toc-tag')][9].title;
      const heading = [...root.querySelectorAll('[data-block-id]')].find(el => el.textContent === id);
      return { scrollTop: root.scrollTop, headingOffset: heading.getBoundingClientRect().top - root.getBoundingClientRect().top }; })()`);
    assert(labelJump.scrollTop > scrollBefore && Math.abs(labelJump.headingOffset) < 4, JSON.stringify({ scrollBefore, labelJump }));

    // Leaving folds it back.
    await mouse('mouseMoved', 900, 450);
    await settle();
    states.left = await inspect();
    assert.equal(states.left.surface.visibility, 'hidden');
    assert(states.left.tags.every(tag => tag.textOpacity === 0 && tag.right - tag.left <= 14.5));

    // A dot clicked straight away (before hover intent unfolds it) navigates too.
    await evaluate('document.querySelector(".editor-scroll").scrollTo({ top: 0 })');
    await settle(100);
    const folded = await inspect();
    const dot = folded.tags[13];
    await mouse('mouseMoved', (dot.left + dot.right) / 2, (dot.top + dot.bottom) / 2);
    await mouse('mousePressed', (dot.left + dot.right) / 2, (dot.top + dot.bottom) / 2);
    await mouse('mouseReleased', (dot.left + dot.right) / 2, (dot.top + dot.bottom) / 2);
    await settle(900);
    const dotJump = await evaluate(`(() => { const root = document.querySelector('.editor-scroll'); const id = [...document.querySelectorAll('.editor__toc-tag')][13].title;
      const heading = [...root.querySelectorAll('[data-block-id]')].find(el => el.textContent === id);
      return { scrollTop: root.scrollTop, headingOffset: heading.getBoundingClientRect().top - root.getBoundingClientRect().top }; })()`);
    assert(dotJump.scrollTop > 0 && Math.abs(dotJump.headingOffset) < 4, JSON.stringify(dotJump));
    await mouse('mouseMoved', 900, 450);
    await settle();

    // Keyboard focus unfolds it as well.
    await evaluate('document.activeElement?.blur()');
    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await settle();
    states.keyboard = await inspect();
    const focusedTag = await evaluate('Boolean(document.activeElement?.matches(".editor__toc-tag:focus-visible"))');
    assert(focusedTag, 'Tab reaches the first rail button.');
    assert.equal(states.keyboard.surface.visibility, 'visible');
    await evaluate('document.activeElement?.blur()');
    await settle();

    // Resizing re-decides, with hysteresis between the two thresholds.
    const gutterFor = async (width) => { await column(width); return inspect(); };
    const sweep = [];
    for (const width of [1020, 1036, 1060, 1036, 1020, 1000, 1036]) {
      const state = await gutterFor(width);
      sweep.push({ column: width, gutter: Math.round(state.gutter * 10) / 10, fit: state.fit });
    }
    // Recompute what the hysteresis must produce from the measured gutters.
    let expected = 'dots';
    for (const step of sweep) {
      expected = expected === 'labels' ? (step.gutter < DOTS_BELOW ? 'dots' : 'labels') : (step.gutter >= LABELS_AT ? 'labels' : 'dots');
      assert.equal(step.fit, expected, JSON.stringify(sweep));
    }
    assert(sweep.some(step => step.gutter >= DOTS_BELOW && step.gutter < LABELS_AT && step.fit === 'dots'));
    assert(sweep.some(step => step.gutter >= DOTS_BELOW && step.gutter < LABELS_AT && step.fit === 'labels'));

    // The hidden preference still unmounts the rail.
    await evaluate('__RAIL_FIT__.setOutlineRailMode("hidden")'); await frames();
    const hidden = await inspect();
    assert.equal(hidden.mounted, false);
    await evaluate('__RAIL_FIT__.setOutlineRailMode("visible")'); await frames();
    assert.equal((await inspect()).mounted, true);

    assert.deepEqual(errors, []);
    if (process.env.DRIFTING_OUTLINE_FIT_SCREENSHOTS) {
      const shots = process.env.DRIFTING_OUTLINE_FIT_SCREENSHOTS;
      mkdirSync(shots, { recursive: true });
      await column(400);
      const state = await inspect(); const tag = state.tags[2];
      writeFileSync(path.join(shots, 'dots.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip: { x: 0, y: 0, width: 420, height: 900, scale: 1 } })).data, 'base64'));
      await mouse('mouseMoved', (tag.left + tag.right) / 2, (tag.top + tag.bottom) / 2);
      await settle();
      writeFileSync(path.join(shots, 'hover.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip: { x: 0, y: 0, width: 420, height: 900, scale: 1 } })).data, 'base64'));
      await mouse('mouseMoved', 900, 450);
      await column(1280);
      writeFileSync(path.join(shots, 'wide.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 } })).data, 'base64'));
    }

    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    const summary = (state) => ({ fit: state.fit, windowWidth: state.windowWidth, columnWidth: Math.round(state.columnWidth),
      gutter: Math.round(state.gutter * 10) / 10, labels: state.tags.length,
      maxLabelRight: Math.round(Math.max(...state.tags.map(tag => tag.right - state.bodyLeft)) * 10) / 10,
      surface: state.surface && { visibility: state.surface.visibility, opacity: state.surface.opacity } });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ kind: 'outline-rail-fit', status: 'passed',
      generatedAt: new Date().toISOString(), sourceSha256: before, inputs,
      browser: (await client.Browser.getVersion()).product,
      thresholds: { dotsBelowGutter: DOTS_BELOW, labelsAtGutter: LABELS_AT },
      states: Object.fromEntries(Object.entries(states).map(([name, state]) => [name, summary(state)])),
      resizeSweep: sweep, labelJump, dotJump,
      checks: { wideLabelsUnchangedAndClear: wideClear, narrowColumnFoldsToDots: true, dotsClearOfText: dotsClear,
        readingLocationIsLargerDot: true, decidedByColumnNotWindow: true, hoverUnfoldsOntoSurface: unfolded && onSurface,
        labelTakesPointerOverText: true, surfaceBridgesGaps: true, labelClickNavigates: true, dotClickNavigates: true,
        leavingFoldsBack: true, keyboardFocusUnfolds: true, resizeHysteresis: true, hiddenStillUnmounts: true,
        noUncaughtExceptions: true },
      boundary: 'Chromium renderer with the real EditorOutlineRail, OutlineViewportController, outline model and the renderer entry\'s global sheets; a synthetic page of headings and prose in an editor column resized independently of the window; CDP mouse and keyboard input. No Tauri/WKWebView compositing, real ChapterEditor, Yjs content, side-panel components or physical pointer acceptance.',
    }, null, 2) + '\n');
    console.log(`Outline rail fit: labels at a ${summary(states.wide).gutter}px gutter, dots at ${summary(states.narrow).gutter}px; hover, click, keyboard, resize hysteresis and hidden passed.`);
  } finally {
    try { if (client) await client.close(); }
    finally {
      try { if (browser) await browser.close(); }
      finally { if (server) await server.close(); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
