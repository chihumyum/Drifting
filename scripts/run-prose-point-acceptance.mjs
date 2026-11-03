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

// DOM-level acceptance of pointing at a comment's anchor in the prose
// (docs/editor/comment-anchors.md, "Pointing at an anchor"): the real
// CommentSandPainter measuring real line boxes in Chromium, CDP mouse input,
// and the pointed set it publishes after the hover intent.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/prose-point.json');
const inputs = [
  'scripts/run-prose-point-acceptance.mjs', 'scripts/renderer-headless-browser.mjs',
  'scripts/renderer-prose-point.ts', 'scripts/renderer-prose-point.html',
  'src/renderer/lib/comment-sand.ts', 'src/renderer/lib/comment-highlight.ts',
  'src/styles/comments-review.css',
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
  assert.equal(report.sourceSha256, before, 'Regenerate prose point evidence.');
  assert(Object.values(report.checks).every(Boolean), 'Every prose point check must pass.');
  console.log('Prose point evidence matches current source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-prose-point-'));
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
    const mouse = (type, x, y, buttons = 0) => client.Input.dispatchMouseEvent({ type, x, y,
      button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
    const pointed = () => evaluate('__PP__.pointed()');
    const states = async () => (await evaluate('__PP__.marks()')).map((mark) => mark.state);

    await client.Emulation.setDeviceMetricsOverride({ width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-prose-point.html` });
    for (let i = 0; i < 400; i++) {
      if (await evaluate('Boolean(window.__PP__ && __PP__.marks().length === 2 && __PP__.marks().every((m) => m.lines.length > 0))')) break;
      await delay(25);
    }
    const [first, second] = await evaluate('__PP__.marks()');
    assert(first && second && first.lines.length && second.lines.length, 'Both anchors are drawn.');
    const line = first.lines[0];
    const onFirst = { x: line.x + line.w / 2, y: line.y + line.h / 2 };
    const results = {};

    // Resting on an anchor: nothing before the intent, then its id, its swash hot.
    await mouse('mouseMoved', onFirst.x, onFirst.y);
    await delay(60);
    results.beforeIntent = await pointed();
    await delay(160);
    results.afterIntent = await pointed();
    results.statesWhilePointed = await states();
    // Past the anchor's end on the same line: let go at once.
    await mouse('mouseMoved', line.x + line.w + 60, onFirst.y);
    await delay(40);
    results.pastTheEnd = await pointed();
    results.statesAfterLeaving = await states();
    // Only passing over it lights nothing.
    await mouse('mouseMoved', onFirst.x, onFirst.y); await delay(40);
    await mouse('mouseMoved', onFirst.x, onFirst.y + 200); await delay(200);
    results.passingOver = await pointed();
    // Dragging across it (making a selection) points at nothing.
    await mouse('mousePressed', onFirst.x - 80, onFirst.y);
    await mouse('mouseMoved', onFirst.x, onFirst.y, 1); await delay(220);
    results.dragging = await pointed();
    await mouse('mouseReleased', onFirst.x, onFirst.y);
    await mouse('mouseMoved', 860, 650); await delay(40);
    // Scrolled, the other anchor is found where it now is.
    await evaluate('__PP__.scrollBy(120)'); await delay(80);
    const moved = (await evaluate('__PP__.marks()'))[1].lines[0];
    await mouse('mouseMoved', moved.x + moved.w / 2, moved.y + moved.h / 2); await delay(220);
    results.afterScroll = await pointed();
    // Leaving the scroller lets go.
    await mouse('mouseMoved', 880, 690); await delay(40);
    results.leftScroller = await pointed();

    const checks = {
      waitsForIntent: results.beforeIntent.length === 0,
      restingPointsAtAnchor: JSON.stringify(results.afterIntent) === '["A"]',
      pointedSwashIsHot: JSON.stringify(results.statesWhilePointed) === '["hot","rest"]',
      pastTheEndLetsGoAtOnce: results.pastTheEnd.length === 0 && JSON.stringify(results.statesAfterLeaving) === '["rest","rest"]',
      passingOverLightsNothing: results.passingOver.length === 0,
      draggingPointsAtNothing: results.dragging.length === 0,
      followsScrolledLines: JSON.stringify(results.afterScroll) === '["B"]',
      leavingScrollerLetsGo: results.leftScroller.length === 0,
      noUncaughtExceptions: errors.length === 0,
    };
    assert(Object.values(checks).every(Boolean), JSON.stringify({ checks, results, errors }));
    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ kind: 'prose-point', status: 'passed',
      generatedAt: new Date().toISOString(), sourceSha256: before, inputs,
      browser: (await client.Browser.getVersion()).product, results, checks,
      boundary: 'Chromium with the real CommentSandPainter, comment-highlight stores and global sheets over synthetic paragraphs with two text-anchored notes; CDP mouse input. Not the real editor, the Review panel (the card side is covered by review-stats-sand-glass.render.test.ts) or WKWebView.',
    }, null, 2) + '\n');
    console.log(`Prose point: ${Object.keys(checks).length} checks passed.`);
  } finally {
    try { if (client) await client.close(); }
    finally {
      try { if (browser) await browser.close(); }
      finally { if (server) await server.close(); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
