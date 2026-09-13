import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
assert(output, 'Provide --output= for the synthetic UI evidence.');
const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome);
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-top-tabs-ui-'));
let browser; let server; let client;
try {
  const outDir = path.join(temporary, 'dist');
  await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react(), { name: 'acceptance-tab-counters', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/TopTimeline/TopTimeline.tsx')) {
        assert(code.includes('function measureLabelWidth(text: string): number {'));
        code = code.replace('function measureLabelWidth(text: string): number {', 'function measureLabelWidth(text: string): number { globalThis.__TOP_TAB_WORK__.measurements++;')
          .replace('export function TopTimeline() {', 'export function TopTimeline() { globalThis.__TOP_TAB_WORK__.renders++;')
          .replace('const cRect = container.getBoundingClientRect();', 'globalThis.__TOP_TAB_WORK__.scrollChecks++; const cRect = container.getBoundingClientRect();');
        return code.replace(/(bookNodes|storylines|bookElements|bookElementCategories)\.find\(\((\w+)\) => ([^)]*)\)/g,
          (_, collection, name, predicate) => `${collection}.find((${name}) => (globalThis.__TOP_TAB_WORK__.arrayVisits++, ${predicate}))`);
      }
      if (id.endsWith('/TopTimeline/top-tab-presentation.ts')) {
        assert(code.includes('for (const [key, leaf] of leaves) {'));
        return code.replace('for (const [key, leaf] of leaves) {', 'for (const [key, leaf] of leaves) { globalThis.__TOP_TAB_WORK__.projectedLeaves++;');
      }
      if (id.endsWith('/lib/immutable-id-index.ts')) {
        assert(code.includes('for (const record of records) {'));
        return code.replace('for (const record of records) {', 'for (const record of records) { globalThis.__TOP_TAB_WORK__.indexRows++;');
      }
    } }],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-top-tabs.html') } },
  });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`], { stdio: 'ignore' });
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
  const errors = []; client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/renderer-top-tabs.html' }); await loaded;
  const result = await client.Runtime.evaluate({ expression: '(async () => ({...await globalThis.__TOP_TABS__.run(), browserVersion: navigator.userAgent}))()', awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); assert.deepEqual(errors, []);
  writeFileSync(output, JSON.stringify({ ...result.result.value, uncaughtErrors: errors }, null, 2) + '\n');
  console.log('Top tab browser measurements captured.');
} finally {
  if (client) { try { await client.Browser.close(); } catch { /* Browser may already be terminal. */ } await client.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]); if (browser.exitCode === null) browser.kill('SIGTERM'); }
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
