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
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-agent-removal-ui-'));
let browser; let server; let client;
try {
  const outDir = path.join(temporary, 'dist');
  await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react(), {
    name: 'synthetic-agent-removal-ports', enforce: 'pre',
    transform(code, id) {
      if (id.endsWith('/sqlite-repo/agent-conversation-repo.ts')) return 'export function createAgentConversationRepository() { return new Proxy({}, { get: (_target, key) => (...args) => globalThis.__AGENT_REMOVAL_UI__.ports[key](...args) }); }';
      if (id.endsWith('/features/settings/panels/AgentSettingsPanel.tsx')) { assert(code.includes('function AgentUsageSection(')); return code + '\nexport { AgentUsageSection };'; }
    },
  }], define: { 'process.env.NODE_ENV': JSON.stringify('development'), 'import.meta.env.VITE_LOCAL_ONLY_MODE': JSON.stringify('true'), 'import.meta.env.VITE_REQUIRE_AUTH': JSON.stringify('false'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://localhost:3000') },
    resolve: { dedupe: ['react', 'react-dom'], alias: { '@': path.join(root, 'src') } },
    build: { outDir, emptyOutDir: true, minify: false, rollupOptions: { input: path.join(root, 'scripts/renderer-agent-removal-ui.html') } },
  });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
  browser = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`], { stdio: 'ignore' });
  const portFile = path.join(temporary, 'profile', 'DevToolsActivePort');
  for (let index = 0; index < 100 && !existsSync(portFile); index++) { assert.equal(browser.exitCode, null); await delay(50); }
  assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  client = await CDP({ port, target: await CDP.New({ port }) }); await client.Page.enable(); await client.Runtime.enable();
  const errors = []; client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/renderer-agent-removal-ui.html' }); await loaded;
  const result = await client.Runtime.evaluate({ expression: 'globalThis.__AGENT_REMOVAL_UI__.run()', awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); assert.deepEqual(errors, []);
  const checks = result.result.value; assert.equal(Object.keys(checks).length, 8); assert(Object.values(checks).every(value => value === true));
  writeFileSync(output, JSON.stringify({ build: 'development-React-StrictMode-isolated-Chromium', ports: 'synthetic-conversation-repository', checks, uncaughtErrors: errors }, null, 2) + '\n');
  console.log('Agent usage UI: eight checks passed on the actual component, store and confirmation dialog.');
} finally {
  if (client) { try { await client.Browser.close(); } catch { /* Browser may already be terminal. */ } await client.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]); if (browser.exitCode === null) browser.kill('SIGTERM'); }
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
