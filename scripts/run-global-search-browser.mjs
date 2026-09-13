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
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-global-search-ui-'));
let browser; let server; let client;
try {
  const outDir = path.join(temporary, 'dist');
  await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react(), { name: 'acceptance-search-counters', enforce: 'pre', transform(code, id) {
      if (!/components\/search\/(?:GlobalSearchModal\.tsx|global-search-model\.ts)$/.test(id)) return;
      if (!code.includes('function safeParse(')) return;
      assert(code.includes('return JSON.parse(json);')); assert(code.includes('): EntityGroup | null {'));
      return code.replace('return JSON.parse(json);', 'globalThis.__GLOBAL_SEARCH_COUNTS__.parses++; return JSON.parse(json);')
        .replace('): EntityGroup | null {', '): EntityGroup | null { globalThis.__GLOBAL_SEARCH_COUNTS__.groups++;');
    } }],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-global-search.html') } },
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
  const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/renderer-global-search.html' }); await loaded;
  const result = await client.Runtime.evaluate({ expression: '(async () => ({...await globalThis.__GLOBAL_SEARCH__.run(), browserVersion: navigator.userAgent}))()', awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); assert.deepEqual(errors, []);
  writeFileSync(output, JSON.stringify({ ...result.result.value, uncaughtErrors: errors }, null, 2) + '\n');
  console.log('Global search browser measurements captured.');
} finally {
  if (client) { try { await client.Browser.close(); } catch { /* Browser may already be terminal. */ } await client.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]); if (browser.exitCode === null) browser.kill('SIGTERM'); }
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
