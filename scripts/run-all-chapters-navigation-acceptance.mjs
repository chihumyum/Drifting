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

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/all-chapters-navigation.json');
const inputs = [
  'scripts/run-all-chapters-navigation-acceptance.mjs', 'scripts/renderer-headless-browser.mjs',
  'scripts/renderer-all-chapters-navigation.tsx', 'scripts/renderer-all-chapters-navigation.html',
  'src/renderer/views/AllChaptersEditorView.tsx',
  'src/renderer/components/editor/all-chapters-navigation.ts',
  'src/renderer/components/editor/all-chapters-navigation.test.ts',
  'src/renderer/components/editor/VirtualChapterRow.tsx',
  'src/renderer/components/editor/chapter-static-html.ts',
  'src/renderer/components/editor/EditorOutlineRail.tsx',
  'src/renderer/components/editor/outline-viewport.ts',
  'src/renderer/components/editor/outline-rail-model.ts',
  'src/styles/index.css', 'src/styles/comments-review.css',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of inputs) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
};
const before = fingerprint();
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, before, 'Regenerate whole-book navigation evidence.');
  console.log('Whole-book navigation evidence matches current source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-book-navigation-'));
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
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 600; i++) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await delay(50);
      }
      throw new Error(`Timed out: ${expression}`);
    };
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-all-chapters-navigation.html` });
    await until('window.__BOOK_NAV__?.panes.left && window.__BOOK_NAV__?.panes.right && document.querySelector("[data-block-id=chapter-0-h1]")');
    await evaluate('document.fonts.ready');
    const positions = () => evaluate('[...document.querySelectorAll(".editor-scroll")].map(el => el.scrollTop)');
    const initial = await positions();
    assert.equal(await evaluate('!!document.querySelector("[data-pane=left] [data-block-id=chapter-45-h2]")'), false);
    await evaluate('__BOOK_NAV__.panes.left.legacy("chapter-45-h2")');
    await delay(150);
    assert.deepEqual(await positions(), initial, 'Legacy cold-heading lookup should reproduce the no-op.');

    const samples = [];
    const inspect = async (pane, id) => evaluate(`(() => {
      const pane = document.querySelector('[data-pane="${pane}"]');
      const root = pane.querySelector('.editor-scroll');
      const target = root.querySelector('[data-block-id="${id}"]') ??
        root.querySelector('[data-chapter-id="${id}"]') ??
        root.querySelector('[data-act-id="${id.replace('act:', '')}"]');
      const rect = target.getBoundingClientRect(), bounds = root.getBoundingClientRect();
      const row = target.closest('[data-chapter-id]');
      const x = Math.max(bounds.left + 200, Math.min(bounds.right - 15, rect.left + rect.width / 2));
      const y = Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, rect.top + Math.min(12, rect.height / 2)));
      return { id: '${id}', pane: '${pane}', scrollTop: root.scrollTop,
        relativeTop: rect.top - bounds.top, height: rect.height,
        visible: target.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }),
        inViewport: rect.bottom > bounds.top && rect.top < bounds.bottom,
        hitTarget: document.elementsFromPoint(x, y).some(el => el === target || target.contains(el)),
        contentVisibility: row ? getComputedStyle(row).contentVisibility : null,
        contentReady: row?.dataset.contentReady ?? null };
    })()`);
    for (const [pane, id] of [
      ['left', 'chapter-45-h2'], ['left', 'chapter-4'], ['left', 'chapter-55-h3'],
      ['left', 'act:act-20'], ['left', 'chapter-0-h1'], ['right', 'chapter-59-h1'],
    ]) {
      const other = pane === 'left' ? 1 : 0;
      const otherTop = (await positions())[other];
      assert.equal(await evaluate(`__BOOK_NAV__.panes.${pane}.jump('${id}')`), true);
      await delay(900); // Observe the resting page without wheel/scroll intervention.
      const sample = await inspect(pane, id);
      assert(sample.visible && sample.inViewport && sample.hitTarget, JSON.stringify(sample));
      if (!id.startsWith('act:')) {
        assert.equal(sample.contentVisibility, 'visible');
        assert.equal(sample.contentReady, 'true');
      }
      assert.equal((await positions())[other], otherTop, 'Jump moved the other split pane.');
      samples.push(sample);
    }
    // Exercise the actual rail button after the density window recentres.
    await evaluate('__BOOK_NAV__.panes.left.jump("chapter-45")');
    await until('[...document.querySelectorAll("[data-pane=left] .editor__toc-tag")].some(el => el.textContent.includes("Heading 45.2"))');
    await evaluate('[...document.querySelectorAll("[data-pane=left] .editor__toc-tag")].find(el => el.textContent.includes("Heading 45.2")).click()');
    await delay(1200);
    const clicked = await inspect('left', 'chapter-45-h2');
    assert(clicked.inViewport && clicked.hitTarget, JSON.stringify(clicked));
    samples.push(clicked);

    const race = await evaluate(`(async () => {
      const first = __BOOK_NAV__.panes.left.jump('chapter-50-h2');
      const latest = __BOOK_NAV__.panes.left.jump('chapter-0');
      return Promise.all([first, latest]);
    })()`);
    assert.deepEqual(race, [false, true]);
    await delay(1000);
    assert((await inspect('left', 'chapter-0')).inViewport, 'An old async jump stole the destination.');
    assert.equal(await evaluate('document.querySelectorAll("[contenteditable=true]").length'), 0);
    assert.deepEqual(errors, []);
    mkdirSync(path.join(root, '.qa'), { recursive: true });
    writeFileSync(path.join(root, '.qa/all-chapters-navigation.png'), Buffer.from(
      (await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ kind: 'all-chapters-navigation', status: 'passed',
      generatedAt: new Date().toISOString(), sourceSha256: before, inputs,
      browser: (await client.Browser.getVersion()).product,
      syntheticChaptersPerPane: 60, samples,
      checks: { legacyColdHeadingNoOpReproduced: true, coldHeadingLoadsBeforeJump: true,
        actualRailButton: true, chapterAndActTargets: true, splitPaneIsolation: true,
        latestClickWins: true, visibleAndHitTestableWithoutUserScroll: true,
        noLiveEditorPromotion: true, noUncaughtExceptions: true },
      boundary: 'Chromium renderer with real VirtualChapterRow, serializer, EditorOutlineRail, bounded loader, navigation coordinator and styles; synthetic delayed reads in two panes. No Tauri/WKWebView compositing, account, database or prose editing acceptance.',
    }, null, 2) + '\n');
    console.log(`Whole-book navigation: ${samples.length} visible, hit-testable landings passed; cold heading, rail, rapid clicks and split isolation.`);
  } finally {
    try { if (client) await client.close(); }
    finally {
      try { if (browser) await browser.close(); }
      finally { if (server) await server.close(); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
