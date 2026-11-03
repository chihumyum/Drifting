import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { closeHeadlessSession, launchHeadlessBrowser } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/qa/review-card-actions.json');
const sources = [
  'src/renderer/features/comments/ReviewItemCard.tsx',
  'src/renderer/features/comments/CommentSourceHoverCard.tsx',
  'src/renderer/features/comments/use-comment-source-hover.ts',
  'src/renderer/features/comments/CommentBodyEditor.tsx',
  'src/renderer/features/comments/review-stats-sand-glass.render.test.ts',
  'src/renderer/features/entities/hover/entity-hover-card-model.ts',
  'src/renderer/components/ui/HoverCard.tsx',
  'src/styles/comments-review.css', 'src/styles/ui-controls.css',
  'scripts/todo-edit-ui.html', 'scripts/todo-edit-ui.tsx',
  'scripts/run-review-card-actions-acceptance.mjs',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(source).update(readFileSync(path.join(root, source)));
  return hash.digest('hex');
};
const validate = (report) => {
  assert.equal(report.status, 'passed');
  assert.equal(report.fingerprint, fingerprint(), 'Review card action evidence is stale.');
  assert.equal(Object.keys(report.checks).length, 23);
  assert(Object.values(report.checks).every(value => value === true));
  assert.deepEqual(report.uncaughtErrors, []);
};

if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-review-actions-'));
  let browser, client, server;
  try {
    const before = fingerprint();
    const outDir = path.join(temporary, 'dist');
    // Reuse the existing synthetic card fixture without invoking its editing suite.
    await build({ root, configFile: false, envDir: false, logLevel: 'error', plugins: [react()],
      define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env.VITE_LOCAL_ONLY_MODE': '"true"' },
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/todo-edit-ui.html') } } });
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const uncaughtErrors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => uncaughtErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async (expression) => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async (expression) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await delay(20);
      }
      const focus = await evaluate(`({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 60), editor: !!document.querySelector('textarea'), actions: !!document.querySelector('.hover-card') })`);
      assert.fail(`Timed out: ${expression}; ${JSON.stringify(focus)}`);
    };
    const checks = {};
    const check = async (name, expression) => {
      assert(await evaluate(expression), name);
      checks[name] = true;
    };
    const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      const event = { key, code, windowsVirtualKeyCode, modifiers };
      await client.Input.dispatchKeyEvent({ ...event, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : {}) });
      await client.Input.dispatchKeyEvent({ ...event, type: 'keyUp' });
    };
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/todo-edit-ui.html' }); await loaded;
    await until('!!document.querySelector("#panel article")');
    await check('desktopReviewListHasNoMoreButtons', '!document.querySelector("#review-sort .review-card__menu-button")');
    for (const surface of ['panel', 'note']) {
      const card = `document.querySelector('#${surface} article')`;
      await check(`${surface}HasNoMoreButton`, `!${card}.querySelector('.review-card__menu-button')`);
      await evaluate(`${card}.scrollIntoView({block:'center'}); ${card}.focus()`);
      await key('Tab', 'Tab', 9, 8);
      await key('Tab', 'Tab', 9);
      await check(`${surface}ReachableByTabWithVisibleFocus`, `document.activeElement === ${card} && getComputedStyle(${card}).outlineStyle !== 'none'`);
      await check(`${surface}TabFocusDoesNotOpenActions`, '!document.querySelector(".hover-card")');
      await key('F10', 'F10', 121, 8);
      await until('document.querySelector(".hover-card__row") === document.activeElement');
      await check(`${surface}ShiftF10OpensActions`, `document.querySelector('.hover-card').id === ${card}.getAttribute('aria-describedby') && ['Edit', 'Resolve', 'Delete'].every(label => [...document.querySelectorAll('.hover-card__row')].some(row => row.textContent.trim() === label))`);
      await check(`${surface}ActionsUseFixedBodyPortal`, `document.querySelector('.hover-card').parentElement === document.body && getComputedStyle(document.querySelector('.hover-card')).position === 'fixed'`);
      await key('Escape', 'Escape', 27);
      await until('!document.querySelector(".hover-card")');
      await check(`${surface}EscapeRestoresCardFocus`, `document.activeElement === ${card}`);
      await key('ContextMenu', 'ContextMenu', 93);
      await until('document.querySelector(".hover-card__row") === document.activeElement');
      await check(`${surface}MenuKeyOpensActions`, `!!document.querySelector('.hover-card') && document.activeElement.textContent.trim() === 'Edit'`);
      await key('Enter', 'Enter', 13);
      await until(`document.activeElement === document.querySelector('#${surface} textarea')`);
      await check(`${surface}KeyboardEditKeepsEditorFocus`, `!document.querySelector('.hover-card') && document.activeElement === document.querySelector('#${surface} textarea')`);
      await key('F10', 'F10', 121, 8);
      await check(`${surface}EditorShortcutDoesNotReopenActions`, `!document.querySelector('.hover-card') && document.activeElement === document.querySelector('#${surface} textarea')`);
      await key('Escape', 'Escape', 27);
      await until(`!document.querySelector('#${surface} textarea')`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 2, y: 2 });
      await evaluate(`${card}.scrollIntoView({block:'center'})`);
      await delay(250);
      const point = await evaluate(`(() => { const r = ${card}.getBoundingClientRect(); return {x:r.left+8, y:r.top+8}; })()`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...point });
      await until('!!document.querySelector(".hover-card")');
      await check(`${surface}PointerHoverStillOpensActions`, `document.querySelector('.hover-card').id === ${card}.getAttribute('aria-describedby') && document.activeElement !== document.querySelector('.hover-card__row')`);
      const panelPoint = await evaluate(`(() => { const r = document.querySelector('.hover-card').getBoundingClientRect(); return {x:r.left+10,y:r.top+10}; })()`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...panelPoint });
      await delay(250);
      await check(`${surface}PointerCanReachActions`, '!!document.querySelector(".hover-card")');
      await key('Escape', 'Escape', 27);
      await until('!document.querySelector(".hover-card")');
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 2, y: 2 });
    }
    assert.equal(fingerprint(), before, 'Sources changed during acceptance.');
    const report = { status: 'passed', fingerprint: before, sources, checks, uncaughtErrors,
      boundary: { data: 'synthetic', input: 'Chromium CDP pointer and keyboard', sqlite: 'not_run', nativeInteraction: 'not_run' } };
    validate(report);
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  } finally {
    await closeHeadlessSession({ client, browser, server });
    rmSync(temporary, { recursive: true, force: true });
  }
}
console.log('Review card actions: 23 synthetic browser checks passed.');
