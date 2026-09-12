import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, createServer, preview } from 'vite';
import CDP from 'chrome-remote-interface';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const baseline = process.argv.includes('--baseline');
const baselineCommit = '4a6734d';
const output = path.join(root, `docs/renderer-performance/acceptance/f7-settings-${baseline ? 'baseline' : 'deferred'}.json`);
const fingerprint = (source) => createHash('sha256').update(referenceEvidenceFingerprint(source))
  .update(readFileSync(path.join(source, 'vite.renderer.config.ts')))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(new URL('./renderer-settings-ui.tsx', import.meta.url)))
  .update(readFileSync(new URL('./renderer-settings-ui.html', import.meta.url)))
  .update(readFileSync(path.join(root, 'vite-plugins/deferred-settings.ts'))).digest('hex');
const panelNames = ['AccountSettingsPanel', 'SubscriptionSettingsPanel', 'PreferenceSettingsPanels', 'IntelligenceSettingsPanels', 'AgentSettingsPanel', 'ControlSettingsPanels'];
const target = (id) => panelNames.find((name) => id.endsWith(`/features/settings/panels/${name}.tsx`));
function sourceFacade(source, id) {
  if (!id) return null;
  const relative = path.relative(source, id);
  // Detached baselines share dependencies through a symlink. Package module
  // paths are not application entry identities and must not expose the host.
  return relative === 'index.html' || relative.startsWith('src/') || relative.startsWith('scripts/') ? relative : null;
}
function validate(report) {
  assert.equal(report.kind, 'renderer_deferred_settings'); assert.equal(report.status, 'passed');
  assert.equal(report.mode, baseline ? 'baseline' : 'deferred');
  assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  for (const name of panelNames) {
    assert.equal(report.initial.evaluated.includes(name), baseline, `Initial evaluation: ${name}`);
    assert.equal(report.chunks.some((c) => c.initial && c.targets.includes(name)), baseline, `Static entry: ${name}`);
    assert.equal(report.initial.parsed.some((file) => report.chunks.some((c) => c.file === file && c.targets.includes(name))), baseline, `Initial parsing: ${name}`);
  }
  if (!baseline) {
    assert.equal(report.ui.length, 2);
    for (const ui of report.ui) {
      assert(ui.initiallyDeferred && ui.failedLocally && ui.retryRecovered && ui.headerPreserved);
      assert(ui.navigationDuringLoad && ui.closeDuringLoad && ui.cachedReopen);
      assert(ui.realPreferenceChanged && ui.sentinelPreserved);
      assert(ui.blockedRequests > 0 && ui.retryRequests > 0);
      assert(ui.requestUrls.length >= 2 && new Set(ui.requestUrls).size === ui.requestUrls.length);
      const attempts = ui.requestUrls.filter((url) => url.includes('settings-attempt='));
      assert.equal(attempts.length, 2);
      assert.equal(new Set(attempts.map((url) => url.split('?')[0])).size, 1);
      if (ui.platformShell === 'desktop') assert.equal(ui.modalClosedDuringLoad, true);
    }
    assert(report.tests.length > 4 && report.tests.every((t) => t.status === 'passed'));
    assert.equal(report.devSettings, 'passed');
  }
  assert.equal(report.acceptance.native, 'not-run'); assert.equal(report.acceptance.fullAppPerformance, 'not-run');
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  if (!baseline) assert.equal(report.source.fingerprint, fingerprint(root), 'Settings evidence is stale.');
  console.log('Settings loading evidence passed; native and full-app performance remain separate.');
  process.exit(0);
}
const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome, 'Set DRIFTING_PERF_CHROME to Chromium.');
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'drifting-deferred-settings-')));
let source = root; let worktree = false; let browser; let server; let development;
const clients = new Set();
const env = { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000' };
Object.assign(process.env, env);
try {
  if (baseline) {
    source = path.join(temporary, 'source');
    execFileSync('git', ['worktree', 'add', '--detach', source, baselineCommit], { stdio: 'pipe' }); worktree = true;
    symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  }
  const sourceFingerprint = fingerprint(source);
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let tests = [];
  if (!baseline) {
    const json = path.join(temporary, 'tests.json');
    execFileSync('pnpm', ['exec', 'vitest', 'run', 'src/renderer/lib/deferred-module.test.ts', 'src/renderer/features/settings/', 'src/renderer/app/mobile-standalone-routes.acceptance.test.ts', '--reporter=json', `--outputFile=${json}`], { stdio: 'pipe' });
    const result = JSON.parse(readFileSync(json, 'utf8')); assert(result.success && result.numFailedTests === 0 && result.numPendingTests === 0);
    tests = result.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration })));
  }
  const chunks = [];
  const outDir = path.join(temporary, 'production');
  await build({ root: source, configFile: path.join(source, 'vite.renderer.config.ts'), logLevel: 'warn',
    plugins: [{ name: 'settings-evaluation-observation', enforce: 'pre',
      transform(code, id) { const name = target(id); if (name) return `;(globalThis.__SETTINGS_EVALUATIONS__ ??= []).push(${JSON.stringify(name)});\n${code}`; },
      generateBundle(_options, bundle) { for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.push({ file: item.fileName, bytes: Buffer.byteLength(item.code), entry: item.isEntry, facade: sourceFacade(source, item.facadeModuleId), imports: item.imports, targets: [...new Set(Object.keys(item.modules).map(target).filter(Boolean))] }); },
    }], build: { outDir, emptyOutDir: true } });
  const initialFiles = new Set();
  function visit(file) { if (initialFiles.has(file)) return; initialFiles.add(file); for (const imported of chunks.find((c) => c.file === file)?.imports ?? []) visit(imported); }
  for (const chunk of chunks.filter((c) => c.facade === 'index.html')) visit(chunk.file);
  for (const chunk of chunks) chunk.initial = initialFiles.has(chunk.file);
  const profile = path.join(temporary, 'profile');
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; browser.on('error', (error) => { launchError = error; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let n = 0; n < 200 && !existsSync(portFile); n++) { if (launchError || browser.exitCode !== null) throw new Error('Chromium failed to start'); await delay(100); }
  assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  async function page() {
    const client = await CDP({ port, target: await CDP.New({ port }) }); clients.add(client);
    await client.Page.enable(); await client.Runtime.enable(); await client.Network.enable();
    await client.Network.setCacheDisabled({ cacheDisabled: true });
    const errors = []; client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async (expression) => { const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const until = async (expression, label = expression) => { for (let n = 0; n < 200; n++) { if (await evaluate(expression)) return; await delay(25); } throw new Error(`UI timed out: ${label}; ${JSON.stringify(errors)}`); };
    const navigate = async (url) => { const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url }); await loaded; };
    return { client, evaluate, until, navigate };
  }
  async function serve(directory) { server = await preview({ root: source, configFile: false, envDir: false, logLevel: 'warn', build: { outDir: directory }, preview: { host: '127.0.0.1', port: 0, open: false } }); return server.resolvedUrls.local[0]; }
  async function stopServer() { await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve())); server = null; }
  let origin = await serve(outDir);
  const production = await page(); const parsed = new Set(); const requested = new Set();
  await production.client.Debugger.enable();
  production.client.Debugger.scriptParsed(({ url }) => { if (url.startsWith(origin)) parsed.add(url.slice(origin.length)); });
  production.client.Network.requestWillBeSent(({ request }) => { if (request.url.startsWith(origin)) requested.add(new URL(request.url).pathname.slice(1)); });
  await production.navigate(origin);
  const initial = { evaluated: await production.evaluate('globalThis.__SETTINGS_EVALUATIONS__ ?? []'), parsed: [...parsed].sort(), requested: [...requested].sort() };
  await stopServer();
  const ui = []; let devSettings = 'not-run';
  if (!baseline) {
    const entry = chunks.find((c) => c.facade === 'src/renderer/features/settings/settings-panels.ts');
    assert(entry && !entry.initial);
    for (const dependency of entry.imports) assert(initialFiles.has(dependency), `Settings retry has a cold static dependency: ${dependency}`);
  }
  if (!baseline) {
    const uiDir = path.join(temporary, 'ui');
    await build({ root, configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-settings-ui.html') } } });
    origin = await serve(uiDir);
    for (const mobile of [false, true]) {
      const { client, evaluate, until, navigate } = await page();
      await client.Emulation.setDeviceMetricsOverride({ width: mobile ? 390 : 1280, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile: false });
      let gate = mobile ? 'fail' : 'hold'; let blockedRequests = 0; let retryRequests = 0; const held = []; const requestUrls = [];
      await client.Fetch.enable({ patterns: [{ urlPattern: '*settings-panels-*.js*', requestStage: 'Request' }] });
      client.Fetch.requestPaused((event) => {
        requestUrls.push(new URL(event.request.url).pathname + new URL(event.request.url).search);
        if (gate === 'fail') { blockedRequests++; void client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'InternetDisconnected' }); }
        else if (gate === 'hold') held.push(event.requestId);
        else { retryRequests++; void client.Fetch.continueRequest({ requestId: event.requestId }); }
      });
      await navigate(`${origin}scripts/renderer-settings-ui.html${mobile ? '?mobile' : ''}`);
      await until('Boolean(document.querySelector("#open-settings"))');
      const initiallyDeferred = await evaluate('!performance.getEntriesByType("resource").some(e => e.name.includes("settings-panels-"))');
      let modalClosedDuringLoad = null;
      if (!mobile) {
        await evaluate('window.__SETTINGS_UI__.modal(true)');
        await until('Boolean(document.querySelector("[role=status]"))');
        for (let n = 0; n < 200 && !held.length; n++) await delay(25);
        assert(held.length > 0);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await until('!document.querySelector(".set-overlay")');
        modalClosedDuringLoad = true; gate = 'fail';
        for (const requestId of held.splice(0)) { blockedRequests++; await client.Fetch.failRequest({ requestId, errorReason: 'InternetDisconnected' }); }
      }
      await evaluate('window.__draftNode = document.querySelector("#synthetic-draft"); window.__draftNode.value = "Synthetic draft survives loading"; window.__SETTINGS_UI__.navigate("/settings?section=language")');
      await until('Boolean(document.querySelector("[role=alert]"))', 'local chunk error');
      writeFileSync(path.join(root, `.local-data/renderer-performance/f7b-${mobile ? 'mobile' : 'desktop'}-error.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
      const failedLocally = await evaluate('Boolean(document.querySelector(".set-head__back")) && !document.querySelector("#language")');
      await evaluate('window.__settingsHeader = document.querySelector(".set-head"); true');
      // Retry the same emitted file with a fresh module-map query, then hold it
      // so selection and cancellation can be exercised before it resolves.
      gate = 'hold'; await evaluate('document.querySelector("[role=alert] button").click()');
      for (let n = 0; n < 200 && !held.length; n++) await delay(25);
      assert(held.length > 0, 'The browser did not retry the failed settings URL.');
      if (mobile) { await evaluate('document.querySelector(".set-head__back").click()'); await until('window.__SETTINGS_UI__.observations.location === "/settings"'); }
      await evaluate('document.querySelector(".set-rail__item").click()');
      await until('window.__SETTINGS_UI__.observations.location.endsWith("section=appearance") && Boolean(document.querySelector("[role=status]"))');
      const navigationDuringLoad = await evaluate('Boolean(document.querySelector(".set-head__back")) && window.__settingsHeader === document.querySelector(".set-head")');
      await evaluate('document.querySelector(".set-head__back").click()');
      if (mobile) { await until('window.__SETTINGS_UI__.observations.location === "/settings"'); await evaluate('document.querySelector(".set-head__back").click()'); }
      await until('window.__SETTINGS_UI__.observations.location === "/"');
      gate = 'pass'; for (const requestId of held.splice(0)) { retryRequests++; await client.Fetch.continueRequest({ requestId }); }
      // Wait for the actual request and module completion, not a fixed sleep.
      await until('performance.getEntriesByType("resource").some(e => e.name.includes("settings-panels-") && e.responseEnd > 0 && e.transferSize > 0)', 'retried chunk transfer');
      const closeDuringLoad = await evaluate('window.__SETTINGS_UI__.observations.location === "/" && !document.querySelector(".set-overlay")');
      await evaluate('window.__SETTINGS_UI__.navigate("/settings?section=language")');
      await until('Boolean(document.querySelector("#language"))', 'real language settings after chunk retry');
      const retryRecovered = true;
      // Loaded reopen is synchronous on render; no status subtree should mount.
      await evaluate('window.__settingsHeader = document.querySelector(".set-head"); window.__statusMounts = 0; window.__observer = new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches("[role=status]") || n.querySelector("[role=status]"))) window.__statusMounts++; }); window.__observer.observe(document.querySelector("#root"), { childList: true, subtree: true });');
      await evaluate('window.__SETTINGS_UI__.navigate("/settings?section=appearance")'); await until('Boolean(document.querySelector("#appearance"))');
      const headerPreserved = await evaluate('window.__settingsHeader === document.querySelector(".set-head")');
      await evaluate('window.__SETTINGS_UI__.navigate("/")'); await until('Boolean(document.querySelector("#open-settings"))');
      await evaluate('document.querySelector("#open-settings").click()'); await until('Boolean(document.querySelector("#language"))');
      const cachedReopen = await evaluate('window.__statusMounts === 0');
      await evaluate('[...document.querySelectorAll("#language .set-locale")].find(b => b.textContent.includes("zh-CN")).click()');
      await until('window.__SETTINGS_UI__.locale() === "zh-CN"');
      await evaluate('[...document.querySelectorAll("#language .set-locale")].find(b => b.textContent.includes("en")).click()');
      await until('window.__SETTINGS_UI__.locale() === "en"');
      const realPreferenceChanged = await evaluate('JSON.parse(localStorage.getItem("settings-storage")).state.uiLocale === "en"');
      const sentinelPreserved = await evaluate('window.__draftNode === document.querySelector("#synthetic-draft") && window.__draftNode.value === "Synthetic draft survives loading" && window.__SETTINGS_UI__.observations.mounts === 1 && window.__SETTINGS_UI__.observations.unmounts === 0');
      ui.push({ modalClosedDuringLoad, platformShell: mobile ? 'mobile' : 'desktop', initiallyDeferred, failedLocally, retryRecovered, headerPreserved, navigationDuringLoad, closeDuringLoad, cachedReopen, realPreferenceChanged, sentinelPreserved, blockedRequests, retryRequests, requestUrls });
      await client.close(); clients.delete(client);
    }
    await stopServer();
    // The virtual entry has a separate Vite development URL. Exercise it with
    // actual transformed modules, not just the production Rollup output.
    development = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'warn', server: { host: '127.0.0.1', port: 0, open: false } });
    await development.listen();
    const devPage = await page();
    await devPage.navigate(`${development.resolvedUrls.local[0]}scripts/renderer-settings-ui.html`);
    await devPage.until('Boolean(document.querySelector("#open-settings"))');
    await devPage.evaluate('document.querySelector("#open-settings").click()');
    await devPage.until('Boolean(document.querySelector("#language"))', 'development settings module');
    assert(await devPage.evaluate('performance.getEntriesByType("resource").some(e => e.name.includes("settings-panels.ts?settings-attempt=1"))'));
    devSettings = 'passed';
    await devPage.client.close(); clients.delete(devPage.client);
    await development.close(); development = null;
  }
  assert.equal(sourceFingerprint, fingerprint(source), 'Source changed during acceptance.');
  const report = { schemaVersion: 1, kind: 'renderer_deferred_settings', status: 'passed', mode: baseline ? 'baseline' : 'deferred', generatedAt: new Date().toISOString(),
    source: { commit, fingerprint: sourceFingerprint, dirty: Boolean(execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) },
    environment: { platform: process.platform, node: process.version, browser: (await production.client.Browser.getVersion()).product },
    initialJsBytes: chunks.filter((c) => c.initial).reduce((sum, c) => sum + c.bytes, 0), chunks, initial, ui, tests, devSettings,
    acceptance: { productionModuleLoading: 'passed', mountedStandaloneSettings: baseline ? 'not-run' : 'passed', native: 'not-run', fullAppPerformance: 'not-run' },
    limitations: [
      'Production main.tsx and Vite config are unchanged by the graph observer except for six panel evaluation counters. The browser has no native bridge or author data; app readiness and startup latency are not measured.',
      'Mounted UI acceptance uses actual desktop/mobile standalone settings and real dynamically fetched panel code in a separate synthetic MemoryRouter fixture. The sentinel is a textarea and effect counter, not a ProjectRuntimeProvider or prose editor.',
      'Real browser module fetch is failed once, retried at the same emitted file with a fresh module-map query, and delayed while navigating/closing. Panel rendering after retry and real local preference persistence are checked. This is not failed module evaluation, missing upgrade assets, native offline loading or device input acceptance.',
      'Full project settings panels, deep-link scroll in the complete modal, hardware Back and native/physical interaction still require project/device acceptance. No private database or account is loaded.'
    ] };
  validate(report); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(root, output), source: report.source, initialJsBytes: report.initialJsBytes, ui, tests: tests.length }));
} finally {
  for (const client of clients) await client.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let n = 0; n < 30 && browser.exitCode === null; n++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise((resolve) => browser.once('exit', resolve)); } }
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (development) await development.close();
  if (worktree) execFileSync('git', ['worktree', 'remove', '--force', source], { stdio: 'pipe' });
  rmSync(temporary, { recursive: true, force: true });
}
