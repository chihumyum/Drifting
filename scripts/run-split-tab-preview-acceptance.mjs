import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/split-tab-preview.json');
const suites = ['src/renderer/store/ui-store.split-preview.test.ts', 'src/renderer/store/ui-store.workspace-tabs.test.ts'];
const inputs = [...suites, 'src/renderer/store/ui-store.ts',
  'src/renderer/components/topBars/TopTimeline/TopTimeline.tsx',
  'src/renderer/shells/desktop/navigation/useDesktopWorkspaceNavigator.ts',
  'src/renderer/components/editor/useSyncSplitFocusedUrl.ts',
  'src/renderer/performance/split-tab-preview-scenario.tsx',
  'scripts/renderer-split-tab-preview.html', 'scripts/run-split-tab-preview-acceptance.mjs'];
const fingerprint = () => createHash('sha256').update(inputs.map(file => readFileSync(path.join(root, file))).join('\0')).digest('hex');
function validate(report) {
  assert.equal(report.kind, 'split-tab-preview');
  assert.equal(report.fingerprint, fingerprint(), 'Split preview evidence is stale.');
  assert.equal(Object.keys(report.browser).length, 11);
  for (const [name, passed] of Object.entries(report.browser)) assert.equal(passed, true, name);
  assert(report.tests.length > 20);
  for (const test of report.tests) assert.equal(test.status, 'passed', test.name);
  assert.deepEqual(report.uncaughtErrors, []);
  assert.equal(report.native, 'not-run');
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Split preview evidence matches current source.');
  process.exit(0);
}
const before = fingerprint();
const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome, 'Chromium is required.');
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-split-preview-'));
let browser, server, client;
try {
  const testFile = path.join(temporary, 'tests.json');
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${testFile}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (run.error) throw run.error;
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const tests = JSON.parse(readFileSync(testFile, 'utf8')).testResults.flatMap(suite =>
    suite.assertionResults.map(test => ({ name: test.fullName, status: test.status })));
  const outDir = path.join(temporary, 'dist');
  await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-split-tab-preview.html') } },
  });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-background-timer-throttling', '--remote-debugging-port=0',
    `--user-data-dir=${path.join(temporary, 'profile')}`], { stdio: 'ignore' });
  const portFile = path.join(temporary, 'profile', 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 200; i++) {
    assert.equal(browser.exitCode, null);
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    if (Number.isInteger(port) && port > 0) break;
    await delay(50);
  }
  assert(port > 0, 'Owned Chromium did not publish its debugging port.');
  client = await CDP({ port, target: await CDP.New({ port }) });
  await client.Page.enable(); await client.Runtime.enable();
  const errors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/renderer-split-tab-preview.html' });
  await loaded;
  const result = await client.Runtime.evaluate({ expression: 'globalThis.__SPLIT_TAB_PREVIEW__.run()', awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  assert.equal(before, fingerprint(), 'Source changed during acceptance.');
  const report = { kind: 'split-tab-preview', generatedAt: new Date().toISOString(), fingerprint: before,
    tests, browser: result.result.value, uncaughtErrors: errors, native: 'not-run',
    boundary: 'Production React tab strip, desktop navigation, and UI store; synthetic entities and browser clicks in Chromium. Prose editor input and native Tauri acceptance are not covered.' };
  validate(report);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Split preview acceptance passed: ${tests.length} tests and 11 browser checks.`);
} finally {
  if (client) { try { await client.Browser.close(); } catch { /* Browser may already be closed. */ } await client.close(); }
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]);
    if (browser.exitCode === null) browser.kill('SIGTERM');
  }
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
