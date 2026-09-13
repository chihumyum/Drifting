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
import { validateDeferredMemoEvidence } from './renderer-deferred-memo-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const baselineCommit = '96795513615124cab9ea8c09315516bf698ab1b0';
const reportFile = path.resolve(root, process.argv.find(arg => arg.startsWith('--report='))?.slice(9)
  ?? 'docs/renderer-performance/acceptance/f7-memo-deferred.json');
const harnessFiles = ['scripts/run-renderer-deferred-memo.mjs', 'scripts/renderer-deferred-memo-contract.mjs',
  'scripts/renderer-graphs-ui.tsx', 'scripts/renderer-graphs-ui.html'];
const configFiles = ['vite.renderer.config.ts', 'vite-plugins/deferred-entry.ts', 'vite-plugins/deferred-settings.ts', 'vite-plugins/deferred-super-views.ts'];
const fingerprint = source => createHash('sha256').update(referenceEvidenceFingerprint(source))
  .update(configFiles.map(file => readFileSync(path.join(source, file))).join('\0'))
  .update(harnessFiles.map(file => readFileSync(path.join(root, file))).join('\0')).digest('hex');
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  validateDeferredMemoEvidence(report);
  assert.equal(report.after.source.fingerprint, fingerprint(root), 'Memo loading evidence is stale.');
  console.log('Memo loading evidence passed. Native startup budgets remain separate.');
  process.exit(0);
}
const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome);
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'drifting-memo-loading-')));
const baseline = path.join(temporary, 'baseline');
let worktree = false; let browser; let server; let development;
const clients = new Set();
Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000' });
const targets = { memo: '/shells/desktop/views/DesktopSuperMemoMaterialView.tsx', graph: '/shells/desktop/views/DesktopStoryGraphView.tsx', element: '/shells/desktop/views/DesktopSuperElementView.tsx', shared: '/components/DriftPanel.tsx' };
const target = id => Object.keys(targets).find(name => id.endsWith(targets[name]));
try {
  execFileSync('git', ['worktree', 'add', '--detach', baseline, baselineCommit], { cwd: root, stdio: 'pipe' }); worktree = true;
  symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
  const startFingerprint = fingerprint(root);
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  const portFile = path.join(temporary, 'profile/DevToolsActivePort'); let port = 0;
  for (let n = 0; n < 200; n++) {
    assert(!launchError && browser.exitCode === null, 'Owned Chrome exited during startup.');
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    if (Number.isInteger(port) && port > 0) break;
    await delay(50);
  }
  assert(Number.isInteger(port) && port > 0);
  async function page() {
    const client = await CDP({ port, target: await CDP.New({ port }) }); clients.add(client);
    await client.Page.enable(); await client.Runtime.enable(); await client.Network.enable();
    await client.Page.bringToFront(); await client.Emulation.setFocusEmulationEnabled({ enabled: true });
    const errors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const until = async (expression, label = expression) => {
      for (let n = 0; n < 200; n++) { if (await evaluate(expression)) return; await delay(25); }
      throw new Error(`Timed out: ${label}; ${JSON.stringify(errors)}; ${await evaluate('document.body.innerText.slice(0, 1500)')}`);
    };
    const navigate = async url => { const loaded = client.Page.loadEventFired(); await client.Page.navigate({ url }); await loaded; };
    const close = async () => { await client.close(); clients.delete(client); };
    return { client, errors, evaluate, until, navigate, close };
  }
  async function serve(source, outDir) {
    server = await preview({ root: source, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
    return server.resolvedUrls.local[0];
  }
  async function stop() { await new Promise(resolve => server.httpServer.close(resolve)); server = null; }
  async function production(source, mode) {
    const chunks = []; const outDir = path.join(temporary, mode);
    await build({ root: source, configFile: path.join(source, 'vite.renderer.config.ts'), logLevel: 'warn',
      plugins: [{ name: 'memo-loading-observation', enforce: 'pre',
        transform(code, id) { const name = target(id); if (name) return `;(globalThis.__MEMO_EVALUATIONS__ ??= []).push(${JSON.stringify(name)});\n${code}`; },
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') {
            const relative = chunk.facadeModuleId ? path.relative(source, chunk.facadeModuleId) : null;
            chunks.push({ file: chunk.fileName, bytes: Buffer.byteLength(chunk.code), facade: relative === 'index.html' || relative?.startsWith('src/') ? relative : null,
              imports: chunk.imports, css: [...(chunk.viteMetadata?.importedCss ?? [])], targets: [...new Set(Object.keys(chunk.modules).map(target).filter(Boolean))] });
          }
        },
      }], build: { outDir, emptyOutDir: true } });
    const initialFiles = new Set();
    const visit = file => { if (initialFiles.has(file)) return; initialFiles.add(file); for (const item of chunks.find(c => c.file === file)?.imports ?? []) visit(item); };
    for (const chunk of chunks.filter(c => c.facade === 'index.html')) visit(chunk.file);
    for (const chunk of chunks) chunk.initial = initialFiles.has(chunk.file);
    const origin = await serve(source, outDir); const p = await page(); const parsed = new Set(); const requested = new Set();
    await p.client.Debugger.enable();
    p.client.Debugger.scriptParsed(({ url }) => { if (url.startsWith(origin)) parsed.add(new URL(url).pathname.slice(1)); });
    p.client.Network.requestWillBeSent(({ request }) => { if (request.url.startsWith(origin)) requested.add(new URL(request.url).pathname.slice(1)); });
    await p.navigate(origin);
    await p.until('document.readyState === "complete"');
    const initial = { evaluated: await p.evaluate('globalThis.__MEMO_EVALUATIONS__ ?? []'), parsed: [...parsed].sort(), requested: [...requested].sort() };
    const result = { source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), fingerprint: fingerprint(source) },
      initialJsBytes: chunks.filter(c => c.initial).reduce((sum, c) => sum + c.bytes, 0), chunks, initial };
    await p.close(); await stop(); return result;
  }
  const before = await production(baseline, 'before');
  const after = await production(root, 'after');
  const uiDir = path.join(temporary, 'ui');
  await build({ root, configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-graphs-ui.html') } } });
  const origin = await serve(root, uiDir); const ui = [];
  let browserVersion = '';
  for (const mobile of [false, true]) {
    const p = await page(); browserVersion = (await p.client.Browser.getVersion()).product; const requests = []; const held = []; let gate = 'fail';
    await p.client.Emulation.setDeviceMetricsOverride({ width: mobile ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile: false });
    await p.client.Fetch.enable({ patterns: ['*memo-material-*.js*', '*graph-ui-*.js*', '*story-graph-*.js*', '*element-graph-*.js*'].map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
    p.client.Fetch.requestPaused(event => {
      const url = new URL(event.request.url); const memo = url.pathname.includes('/memo-material-');
      requests.push({ kind: memo ? 'memo' : 'graph', url: url.pathname + url.search });
      if (memo && gate === 'fail') void p.client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'InternetDisconnected' });
      else if (memo && gate === 'hold') held.push(event.requestId);
      else void p.client.Fetch.continueRequest({ requestId: event.requestId });
    });
    await p.navigate(`${origin}scripts/renderer-graphs-ui.html?memo&preload${mobile ? '&mobile' : ''}`);
    await p.until('Boolean(document.querySelector(".tiptap"))');
    const draft = await p.evaluate('window.__GRAPHS_UI__.inspect()');
    const checks = { initiallyDeferred: requests.length === 0 };
    await p.evaluate('document.querySelector(".tiptap").focus(); window.__GRAPHS_UI__.open("memo-material")');
    await p.until('Boolean(document.querySelector("[role=alert] button"))');
    checks.failedLocally = requests.length === 1 && await p.evaluate('Boolean(document.querySelector(".super-view-head__back")) && !document.querySelector(".super-mm-overlay")');
    gate = 'hold';
    await p.evaluate('document.querySelector("[role=alert] button").focus(); document.querySelector("[role=alert] button").click()');
    for (let n = 0; n < 200 && !held.length; n++) await delay(25);
    assert.equal(held.length, 1);
    checks.retryNewKey = requests.length === 2 && requests[0].url !== requests[1].url && requests[0].url.split('?')[0] === requests[1].url.split('?')[0];
    await p.evaluate('window.__GRAPHS_UI__.edit(); document.querySelector(".super-view-head__back").click()');
    await p.until('window.__GRAPHS_UI__.observations.active === "none"');
    for (const requestId of held.splice(0)) await p.client.Fetch.continueRequest({ requestId });
    await p.until('performance.getEntriesByType("resource").some(e => e.name.includes("memo-material-") && e.transferSize > 0)');
    await delay(100);
    checks.canceledOpenStaysClosed = await p.evaluate('!document.querySelector(".super-mm-overlay") && window.__GRAPHS_UI__.observations.active === "none"');
    const edited = await p.evaluate('window.__GRAPHS_UI__.inspect()');
    checks.editorPreserved = edited.editorId === draft.editorId && edited.mounts === 1 && edited.unmounts === 0 && edited.text.includes('synthetic edit');
    await p.evaluate('window.__memoFallbacks = 0; new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches("[role=status]") || n.querySelector("[role=status]"))) window.__memoFallbacks++; }).observe(document.getElementById("root"), { childList: true, subtree: true }); window.__GRAPHS_UI__.open("memo-material");');
    await p.until('Boolean(document.querySelector(".super-mm-overlay"))');
    checks.cachedReopen = requests.length === 2 && await p.evaluate('window.__memoFallbacks === 0');
    checks.actualMaterials = await p.evaluate('document.querySelector(".super-mm-overlay").textContent.includes("synthetic-a alpha") && document.querySelector(".super-mm-overlay").textContent.includes("synthetic-a beta")');
    await p.evaluate('document.querySelector(".super-mm-overlay input").focus()');
    await p.client.Input.insertText({ text: 'alpha' });
    await p.until('!document.querySelector(".smm-scroll").textContent.includes("synthetic-a beta")');
    checks.queryFilters = await p.evaluate('document.querySelector(".super-mm-overlay").textContent.includes("synthetic-a alpha")');
    await p.evaluate('document.querySelector(".smm-library-toolbar__create").click()');
    await p.until('Boolean(document.querySelector("[role=dialog] input, [role=dialog] textarea"))');
    await p.client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await p.client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    checks.composeEscapeKeepsView = await p.evaluate('Boolean(document.querySelector(".super-mm-overlay")) && window.__GRAPHS_UI__.observations.active === "memo-material"');
    await p.evaluate('window.__GRAPHS_UI__.project("synthetic-b")');
    await p.until('document.querySelector(".super-mm-overlay")?.textContent.includes("synthetic-b beta")');
    checks.projectIsolated = await p.evaluate('!document.querySelector(".super-mm-overlay").textContent.includes("synthetic-a alpha") && document.querySelector(".super-mm-overlay input").value === ""');
    await p.evaluate('document.querySelector(".super-view-head__back").click()');
    await p.until('window.__GRAPHS_UI__.observations.active === "none"');
    checks.backAccepted = await p.evaluate('!document.querySelector(".super-mm-overlay")');
    checks.noGraphRequested = requests.every(r => r.kind === 'memo');
    assert.deepEqual(p.errors, []);
    ui.push({ shell: mobile ? 'mobile' : 'desktop', checks, requests, uncaughtErrors: p.errors }); await p.close();
  }
  // A late import must render only the currently mounted project's data.
  const late = await page(); const lateHeld = []; let lateGate = 'fail';
  await late.client.Fetch.enable({ patterns: [{ urlPattern: '*memo-material-*.js*', requestStage: 'Request' }] });
  late.client.Fetch.requestPaused(event => {
    if (lateGate === 'fail') void late.client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'InternetDisconnected' });
    else lateHeld.push(event.requestId);
  });
  await late.navigate(`${origin}scripts/renderer-graphs-ui.html?memo`);
  await late.until('Boolean(document.querySelector(".tiptap"))');
  await late.evaluate('window.__GRAPHS_UI__.open("memo-material")');
  await late.until('Boolean(document.querySelector("[role=alert] button"))');
  lateGate = 'hold'; await late.evaluate('document.querySelector("[role=alert] button").click()');
  for (let n = 0; n < 200 && !lateHeld.length; n++) await delay(25);
  assert.equal(lateHeld.length, 1);
  await late.evaluate('window.__GRAPHS_UI__.project("synthetic-b")');
  await late.until('window.__GRAPHS_UI__.observations.projectId === "synthetic-b" && Boolean(document.querySelector("[role=status]"))');
  await late.evaluate('document.querySelector(".super-view-head__back").focus()');
  const pendingFocus = await late.evaluate('document.activeElement === document.querySelector(".super-view-head__back")');
  for (const requestId of lateHeld.splice(0)) await late.client.Fetch.continueRequest({ requestId });
  await late.until('Boolean(document.querySelector(".super-mm-overlay"))');
  const lateProject = {
    currentDataOnly: await late.evaluate('document.querySelector(".super-mm-overlay").textContent.includes("synthetic-b beta") && !document.querySelector(".super-mm-overlay").textContent.includes("synthetic-a alpha")'),
    focusTransferred: pendingFocus && await late.evaluate('document.activeElement === document.querySelector(".super-view-head__back")'),
  };
  assert.deepEqual(late.errors, []); await late.close();
  // A separate fresh page proves a failed speculative load does not poison demand.
  const p = await page(); const preloadRequests = []; let first = true;
  await p.client.Fetch.enable({ patterns: [{ urlPattern: '*memo-material-*.js*', requestStage: 'Request' }] });
  p.client.Fetch.requestPaused(event => {
    const url = new URL(event.request.url); preloadRequests.push(url.pathname + url.search);
    if (first) { first = false; void p.client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'InternetDisconnected' }); }
    else void p.client.Fetch.continueRequest({ requestId: event.requestId });
  });
  await p.navigate(`${origin}scripts/renderer-graphs-ui.html?memo&preload`);
  await p.until('Boolean(document.querySelector(".workspace-super-trigger"))');
  await p.evaluate('document.querySelector(".workspace-super-trigger").focus()');
  for (let n = 0; n < 200 && !preloadRequests.length; n++) await delay(25);
  assert.equal(preloadRequests.length, 1); await delay(150);
  const invisibleFailure = await p.evaluate('!document.querySelector("[role=alert]") && window.__GRAPHS_UI__.observations.active === "none"');
  await p.evaluate('document.querySelector(".workspace-super-trigger").click()');
  await p.until('Boolean(document.querySelector(".super-mm-overlay"))');
  const preload = { invisibleFailure, demandRecovered: preloadRequests.length === 2 && preloadRequests[0] !== preloadRequests[1], requests: preloadRequests };
  assert.deepEqual(p.errors, []); await p.close(); await stop();
  development = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'warn', optimizeDeps: { entries: ['scripts/renderer-graphs-ui.html'] }, server: { host: '127.0.0.1', port: 0, open: false } });
  await development.listen();
  const dev = await page();
  await dev.navigate(`${development.resolvedUrls.local[0]}scripts/renderer-graphs-ui.html?memo`);
  await dev.until('Boolean(document.querySelector(".tiptap"))');
  await dev.evaluate('window.__GRAPHS_UI__.open("memo-material")');
  await dev.until('Boolean(document.querySelector(".super-mm-overlay"))');
  assert.deepEqual(dev.errors, []); await dev.close(); await development.close(); development = null;
  assert.equal(fingerprint(root), startFingerprint, 'Source changed during acceptance.');
  const report = { schemaVersion: 1, kind: 'renderer_deferred_memo', status: 'passed', generatedAt: new Date().toISOString(),
    environment: { node: process.version, browser: browserVersion },
    before, after, ui, preload, lateProject, dev: 'passed', acceptance: { native: 'not-run', fullAppStartup: 'not-run' },
    limitations: [
      'Production main entry is measured with module evaluation counters, emitted import closure and Chromium parsed/requested script events. No native bridge or author database, app readiness or native startup timing is measured.',
      'Mounted UI uses production view bodies, deferred wrappers, navigation controls, stores and mobile host with synthetic workspace data and a real Tiptap/Yjs draft; it is not the full ProjectRuntime or ChapterEditor.',
      'Real failed fetch, explicit retry, close while loading, cached reopen, search, compose Escape and project replacement are checked. Database writes, asset editing, physical touch and IME are not exercised.',
      'Entry retries fetch the same build file with a fresh query key. Static dependencies and CSS must already belong to the initial shell; module evaluation errors and native offline/upgrade consistency are separate gates.',
    ] };
  validateDeferredMemoEvidence(report); writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ before: before.initialJsBytes, after: after.initialJsBytes, ui, preload }, null, 2));
} finally {
  for (const client of clients) await client.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let n = 0; n < 30 && browser.exitCode === null; n++) await delay(100); if (browser.exitCode === null) browser.kill('SIGKILL'); }
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  if (development) await development.close();
  if (worktree) execFileSync('git', ['worktree', 'remove', '--force', baseline], { cwd: root, stdio: 'pipe' });
  rmSync(temporary, { recursive: true, force: true });
}
