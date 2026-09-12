import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import { build, preview } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? '.local-data/renderer-performance/latest.json';
const assertInputBudget = process.argv.includes('--assert-input-budget');
const chrome = process.env.DRIFTING_PERF_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);
if (!chrome || !existsSync(chrome)) throw new Error('Set DRIFTING_PERF_CHROME to an installed Chromium executable');
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-renderer-perf-'));
const profile = path.join(temporary, 'profile');
const outDir = path.join(temporary, 'dist');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(ts|tsx|css)$/.test(file)) sourceFiles.push(path.relative(root, file));
  }
}
visit(path.join(root, 'src/renderer'));
sourceFiles.push('scripts/run-renderer-performance.mjs', 'scripts/renderer-performance.html', 'pnpm-lock.yaml');
sourceFiles.sort();
const fingerprint = () => hash(sourceFiles.map((file) => `${file}\0${hash(readFileSync(file))}`).join('\n'));
const sourceFingerprint = fingerprint();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let browser;
let server;
let client;
try {
  await build({
    root, configFile: false, envDir: false, logLevel: 'warn',
    resolve: { alias: { '@': path.join(root, 'src') } },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-performance.html') } },
  });
  server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
  browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  let launchError;
  browser.on('error', (error) => { launchError = error; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 200 && !existsSync(portFile); attempt++) {
    if (launchError || browser.exitCode !== null) throw new Error('Isolated Chromium did not start');
    await delay(100);
  }
  if (!existsSync(portFile)) throw new Error('Chromium debugging endpoint timed out');
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const target = await CDP.New({ port });
  client = await CDP({ port, target });
  await client.Page.enable();
  await client.Runtime.enable();
  const pageErrors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) => pageErrors.push(exceptionDetails.text));
  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url: `${server.resolvedUrls.local[0]}scripts/renderer-performance.html` });
  await loaded;
  const result = await client.Runtime.evaluate({
    expression: 'window.__DRIFTING_PERFORMANCE_HARNESS__.run()', awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails || pageErrors.length) throw new Error(`Harness failed: ${JSON.stringify(result.exceptionDetails ?? pageErrors)}`);
  if (sourceFingerprint !== fingerprint()) throw new Error('Source changed during measurement; discard this run');
  const report = {
    schemaVersion: 1, kind: 'renderer_performance_run', generatedAt: new Date().toISOString(),
    status: 'measured', source: {
      commit: sourceCommit, rendererFingerprint: sourceFingerprint,
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
      build: 'vite-production-isolated-harness',
    },
    environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), node: process.version },
    ...result.result.value,
    limitations: [
      'Synthetic ProseMirror transactions in isolated headless Chromium; not native input, IME, or app-wide acceptance.',
      'Animation-frame callback is not a compositor paint measurement.',
      'Timing includes harness wrappers with counters disabled; compare only equivalent environments and fixtures.',
      'Agent, graph, references, full-app startup, multi-tab memory, native and physical-device acceptance: NOT RUN.',
    ],
  };
  if (assertInputBudget) {
    report.budgetChecks = report.scenarios.flatMap((scenario) => [
      { id: `${scenario.id}:input-locality`, passed: Object.values(scenario.counts).every((count) => count === 0) },
      { id: `${scenario.id}:transaction-p95`, passed: scenario.transactionMs.p95 <= (scenario.fixture.characters > 20_000 ? 5 : 2) },
    ]);
    if (report.budgetChecks.some((check) => !check.passed)) {
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, source: report.source, status: report.status, behaviorChecks: report.behaviorChecks, budgetChecks: report.budgetChecks, scenarios: report.scenarios.map(({ id, counts, transactionMs }) => ({ id, counts, transactionP95Ms: transactionMs.p95 })) }, null, 2));
} finally {
  if (client) await client.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    for (let attempt = 0; attempt < 30 && browser.exitCode === null; attempt++) await delay(100);
    if (browser.exitCode === null) {
      browser.kill('SIGKILL');
      await new Promise((resolve) => browser.once('exit', resolve));
    }
  }
  if (server) await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  rmSync(temporary, { recursive: true, force: true });
}
