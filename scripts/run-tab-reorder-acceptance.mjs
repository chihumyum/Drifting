import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/renderer-performance/acceptance/tab-reorder.json');
const inputs = ['src/renderer/components/topBars/TopTimeline/TopTimeline.tsx',
  'src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json',
  'src/renderer/components/topBars/TopTimeline/tab-native-drag.acceptance.test.ts',
  'src/renderer/components/topBars/TopTimeline/tab-reorder.ts',
  'src/renderer/components/topBars/TopTimeline/tab-reorder.test.ts',
  'src/renderer/components/topBars/TopTimeline/useTabReorder.ts',
  'src/renderer/store/ui-store.ts', 'src/styles/index.css',
  'src/renderer/performance/tab-reorder-scenario.tsx',
  'scripts/renderer-tab-reorder.html', 'scripts/run-tab-reorder-acceptance.mjs'];
const fingerprint = () => createHash('sha256').update(inputs.map(file => readFileSync(path.join(root, file))).join('\0')).digest('hex');
function validate(report) {
  assert.equal(report.kind, 'animated-tab-reorder');
  assert.equal(report.fingerprint, fingerprint(), 'Tab reorder evidence is stale.');
  assert.deepEqual(report.profiles.map(profile => profile.reducedMotion), [false, true]);
  for (const profile of report.profiles) {
    assert.equal(Object.keys(profile.checks).length, 24);
    for (const [name, passed] of Object.entries(profile.checks)) assert.equal(passed, true, name);
  }
  assert.deepEqual(report.uncaughtErrors, []);
  assert.equal(report.native, 'not-run');
  assert.deepEqual(report.nativeDragDropEnabled, { base: false, macos: false });
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Animated tab reorder evidence matches current source.');
  process.exit(0);
}
const before = fingerprint();
const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome);
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-tab-reorder-'));
let browser; let server; let client;
try {
  const outDir = path.join(temporary, 'dist');
  await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-tab-reorder.html') } },
  });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`], { stdio: 'ignore' });
  const portFile = path.join(temporary, 'profile', 'DevToolsActivePort');
  let port = 0;
  for (let index = 0; index < 200; index++) {
    assert.equal(browser.exitCode, null);
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    if (Number.isInteger(port) && port > 0) break;
    await delay(50);
  }
  assert(port > 0, 'Owned Chrome did not publish its debugging port.');
  client = await CDP({ port, target: await CDP.New({ port }) }); await client.Page.enable(); await client.Runtime.enable();
  await client.Page.bringToFront();
  const errors = []; client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/renderer-tab-reorder.html' }); await loaded;
  const profiles = [];
  for (const reduced of [false, true]) {
    await client.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
    const result = await client.Runtime.evaluate({ expression: 'globalThis.__TAB_REORDER__.run()', awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    profiles.push(result.result.value);
  }
  assert.equal(before, fingerprint(), 'Source changed during acceptance.');
  const report = { kind: 'animated-tab-reorder', generatedAt: new Date().toISOString(), fingerprint: before,
    profiles, uncaughtErrors: errors, native: 'not-run',
    nativeDragDropEnabled: Object.fromEntries([['base', 'tauri.conf.json'], ['macos', 'tauri.macos.conf.json']].map(([name, file]) => [name,
      JSON.parse(readFileSync(path.join(root, 'src-tauri', file), 'utf8')).app.windows.find(window => window.label === 'main').dragDropEnabled])),
    boundary: 'Production React TopTimeline and UI-store, synthetic HTML drag events in Chromium. Actual animation frames, overflow scrolling and reduced motion. No physical native drag or complete editor acceptance.' };
  validate(report);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Animated tab reorder browser evidence passed.');
} finally {
  if (client) { try { await client.Browser.close(); } catch { /* Browser may already be terminal. */ } await client.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]); if (browser.exitCode === null) browser.kill('SIGTERM'); }
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
