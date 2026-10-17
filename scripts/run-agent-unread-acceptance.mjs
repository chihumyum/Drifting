import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { launchHeadlessBrowser, closeHeadlessSession } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportPath = path.join(root, 'docs/agent-runtime/acceptance/unread-direct-edits.json');
const suites = [
  'src/renderer/store/agent-unread-acknowledgement.test.ts',
  'src/renderer/components/ui/entity-hover-card-model.test.ts',
  'src/renderer/lib/agent/tool-registry.test.ts',
  'src/renderer/lib/agent/runtime/drifting-write-strategies.test.ts',
  'src/renderer/store/agent-edit-store.test.ts',
  'src/renderer/store/agent-activity-store.test.ts',
  'src/renderer/store/settings-store-appearance.test.ts',
  'src/renderer/components/leftBars/element-panel-compact-index.acceptance.test.ts',
  'src/renderer/features/editor/agent-decoration-projection.test.ts',
  'src/renderer/features/editor/agent-decoration-controller.test.ts',
  'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
  'src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts',
  'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.test.ts',
];
const sources = [
  ...suites,
  'src/renderer/store/agent-edit-store.ts', 'src/renderer/store/agent-activity-store.ts',
  'src/renderer/store/settings-store.ts', 'src/renderer/hooks/useAgentUnreadMarks.ts', 'src/renderer/hooks/useFieldReview.ts',
  ...['AgentChangeIndicator', 'AgentCountBadge', 'LeftSidebarHeader', 'GroupHeaderCell', 'ChapterPanel', 'ElementPanel', 'DriftPanel'].map(name => `src/renderer/components/leftBars/${name}.tsx`),
  ...['AgentEditAnimator', 'FieldReview', 'PatchEditorCard', 'ChapterEditor'].map(name => `src/renderer/components/editor/${name}.tsx`),
  ...['ElementEditorView', 'StorylineEditorView', 'CategoryEditorView'].map(name => `src/renderer/views/${name}.tsx`),
  'src/renderer/components/ui/ElementIdentityTile.tsx', 'src/renderer/features/agent/AgentComposerConfig.tsx',
  'src/renderer/features/editor/agent-decoration-projection.ts', 'src/renderer/lib/agent/agent-edit-mode.ts',
  'src/renderer/lib/agent/tool-registry.ts', 'src/renderer/lib/agent/runtime/drifting-workspace-tool-contract.ts',
  'src/renderer/lib/agent/runtime/drifting-write-strategies.ts', 'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.ts',
  'src/styles/agent-activity.css', 'src/styles/ui-controls.css', 'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
  'scripts/renderer-agent-unread-ui.html', 'scripts/renderer-agent-unread-ui.tsx', 'scripts/run-agent-unread-acceptance.mjs',
  'docs/agent-runtime/durable-commit-review-protocol.md', 'docs/design-system.md',
  'src/renderer/features/entities/hover/entity-hover-card-model.ts',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of sources) hash.update(file).update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint(), 'Agent unread/direct-write evidence is stale');
  assert(report.tests.length >= 100 && report.tests.every(test => test.status === 'passed'));
  assert(Object.keys(report.browserChecks).length >= 13 && Object.values(report.browserChecks).every(value => value === true));
  console.log('Agent unread/direct-write evidence matches source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-agent-unread-'));
  let browser, client, server;
  try {
    const resultFile = path.join(temporary, 'tests.json');
    const tested = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${resultFile}`], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (tested.status !== 0) {
      const failed = JSON.parse(readFileSync(resultFile, 'utf8')).testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => ({ name: test.fullName, errors: test.failureMessages })));
      assert.fail(JSON.stringify(failed, null, 2));
    }
    const tests = JSON.parse(readFileSync(resultFile, 'utf8')).testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status })));
    const outDir = path.join(temporary, 'dist');
    await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react()],
      define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env.VITE_LOCAL_ONLY_MODE': JSON.stringify('true'), 'import.meta.env.VITE_REQUIRE_AUTH': JSON.stringify('false'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://localhost:3000') },
      resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'src') } },
      build: { outDir, emptyOutDir: true, minify: false, rollupOptions: { input: path.join(root, 'scripts/renderer-agent-unread-ui.html') } },
    });
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const errors = []; client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/renderer-agent-unread-ui.html' }); await loaded;
    const hoverChecks = {};
    for (const kind of ['A', 'M', 'count']) {
      const beforeResult = await client.Runtime.evaluate({ expression: `globalThis.__AGENT_UNREAD_UI__.prepareHover(${JSON.stringify(kind)})`, awaitPromise: true, returnByValue: true });
      assert(!beforeResult.exceptionDetails, beforeResult.exceptionDetails?.exception?.description);
      const before = beforeResult.result.value;
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: before.x, y: before.y });
      const afterResult = await client.Runtime.evaluate({ expression: 'globalThis.__AGENT_UNREAD_UI__.finishHoverTransition()', awaitPromise: true, returnByValue: true });
      const after = afterResult.result.value;
      assert.equal(after.labelOpacity, 0); assert.equal(after.glyphOpacity, 1); assert.equal(after.animated, true);
      assert.equal(after.glyphIsSvg, true);
      assert(before.digitWidth > 0 && Math.abs(after.glyphWidth - before.digitWidth) < 0.1, 'Hover glyph must match one digit in width');
      for (const property of ['width', 'color', 'background', 'border', 'radius', 'shadow']) assert.equal(after[property], before[property], `Hover changed ${property}`);
      hoverChecks[`quietHover${kind}`] = true;
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1200, y: 850 });
      const restored = await client.Runtime.evaluate({ expression: 'globalThis.__AGENT_UNREAD_UI__.finishHoverTransition()', awaitPromise: true, returnByValue: true });
      assert(!restored.exceptionDetails, restored.exceptionDetails?.exception?.description);
      assert.equal(restored.result.value.labelOpacity, 1); assert.equal(restored.result.value.glyphOpacity, 0);
      hoverChecks[`crossfade${kind}`] = true;
    }
    await client.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reducedBefore = await client.Runtime.evaluate({ expression: 'globalThis.__AGENT_UNREAD_UI__.prepareHover("M")', awaitPromise: true, returnByValue: true });
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: reducedBefore.result.value.x, y: reducedBefore.result.value.y });
    const reducedAfter = await client.Runtime.evaluate({ expression: 'globalThis.__AGENT_UNREAD_UI__.finishHoverTransition()', awaitPromise: true, returnByValue: true });
    assert(!reducedAfter.exceptionDetails, reducedAfter.exceptionDetails?.exception?.description);
    assert.equal(reducedAfter.result.value.animated, false); assert.equal(reducedAfter.result.value.glyphOpacity, 1);
    hoverChecks.reducedMotion = true;
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1200, y: 850 });
    await client.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text);
      return result.result.value;
    };
    const category = await evaluate('globalThis.__AGENT_UNREAD_UI__.prepareCategory("compact")');
    const screenshot = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length);
    if (screenshot) writeFileSync(screenshot, Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip: category.frame })).data, 'base64'));
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: category.x, y: category.y });
    await evaluate('globalThis.__AGENT_UNREAD_UI__.categoryPreview()');
    hoverChecks.categoryFrameAndHover = true;
    hoverChecks.categoryAgentCountsOnly = await evaluate('globalThis.__AGENT_UNREAD_UI__.categoryUnreadCount()');
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1200, y: 850 });
    await evaluate('globalThis.__AGENT_UNREAD_UI__.focusCategory()');
    await evaluate('globalThis.__AGENT_UNREAD_UI__.categoryPreview()');
    hoverChecks.categoryKeyboardPreview = await evaluate('globalThis.__AGENT_UNREAD_UI__.blurCategory()');
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: category.x, y: category.y });
    await evaluate('globalThis.__AGENT_UNREAD_UI__.categoryPreview()');
    hoverChecks.categoryClickIsolation = await evaluate('globalThis.__AGENT_UNREAD_UI__.clickCategory()');
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1200, y: 850 });
    const listCategory = await evaluate('globalThis.__AGENT_UNREAD_UI__.prepareCategory("list")');
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: listCategory.x, y: listCategory.y });
    await evaluate('globalThis.__AGENT_UNREAD_UI__.categoryPreview()'); hoverChecks.categoryListPreview = true;
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1200, y: 850 });
    const result = await client.Runtime.evaluate({ expression: 'globalThis.__AGENT_UNREAD_UI__.run()', awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text);
    assert.deepEqual(errors, []);
    const browserChecks = { ...result.result.value, ...hoverChecks };
    assert(Object.keys(browserChecks).length >= 13 && Object.values(browserChecks).every(value => value === true));
    const report = { kind: 'agent_unread_direct_edits_acceptance', status: 'passed', generatedAt: new Date().toISOString(), sourceSha256: fingerprint(), suites, tests, browserChecks,
      boundary: { data: 'synthetic', browser: 'isolated Chromium with production sidebar/store/animator components', nativeInteraction: 'not_run', hostedService: 'not_run' } };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Agent unread/direct writes: ${tests.length} tests and ${Object.keys(browserChecks).length} browser checks passed.`);
  } finally {
    await closeHeadlessSession({ client, browser, server });
    rmSync(temporary, { recursive: true, force: true });
  }
}
