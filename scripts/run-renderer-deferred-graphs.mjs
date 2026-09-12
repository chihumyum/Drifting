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
import { runPreloadAcceptance, validatePreloadAcceptance } from './renderer-preload-acceptance.mjs';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const baseline = process.argv.includes('--baseline');
const baselineCommit = 'd7e8c9a';
const preload = process.argv.includes('--preload');
assert(!baseline || !preload, 'Preload acceptance requires the current implementation.');
const reportArg = process.argv.find(arg => arg.startsWith('--report='))?.slice('--report='.length);
const output = path.resolve(root, reportArg ?? `docs/renderer-performance/acceptance/${preload ? 'f7-intent-preloading' : `f7-graphs-${baseline ? 'baseline' : 'deferred'}`}.json`);
const fingerprint = (source) => createHash('sha256').update(referenceEvidenceFingerprint(source))
  .update(readFileSync(path.join(source, 'vite.renderer.config.ts')))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(new URL('./renderer-preload-acceptance.mjs', import.meta.url)))
  .update(readFileSync(new URL('./renderer-graphs-ui.tsx', import.meta.url)))
  .update(readFileSync(new URL('./renderer-graphs-ui.html', import.meta.url)))
  .update(readFileSync(path.join(root, 'vite-plugins/deferred-settings.ts')))
  .update(readFileSync(path.join(root, 'vite-plugins/deferred-entry.ts')))
  .update(readFileSync(path.join(root, 'vite-plugins/deferred-super-views.ts'))).digest('hex');
const targets = {
  story: '/shells/desktop/views/DesktopStoryGraphView.tsx',
  element: '/shells/desktop/views/DesktopSuperElementView.tsx',
  shared: '/components/DriftPanel.tsx',
};
const target = (id) => Object.keys(targets).find((name) => id.endsWith(targets[name]));
function sourceFacade(source, id) {
  if (!id) return null;
  const relative = path.relative(source, id);
  // Detached baselines share dependencies through a symlink. Package module
  // paths are not application entry identities and must not expose the host.
  return relative === 'index.html' || relative.startsWith('src/') || relative.startsWith('scripts/') ? relative : null;
}
function validate(report) {
  assert.equal(report.kind, 'renderer_deferred_graphs'); assert.equal(report.status, 'passed');
  assert.equal(report.mode, baseline ? 'baseline' : 'deferred');
  assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  for (const name of Object.keys(targets)) {
    assert.equal(report.initial.evaluated.includes(name), baseline, `Initial evaluation: ${name}`);
    assert.equal(report.chunks.some((c) => c.initial && c.targets.includes(name)), baseline, `Static entry: ${name}`);
    assert.equal(report.initial.parsed.some((file) => report.chunks.some((c) => c.file === file && c.targets.includes(name))), baseline, `Initial parsing: ${name}`);
  }
  if (!baseline) {
    assert.equal(report.ui.length, 2);
    for (const ui of report.ui) {
      for (const key of ['initiallyDeferred', 'sharedRetry', 'storyRetry', 'elementRetry', 'switchWhileLoading', 'lateResultIgnored', 'focusTransferred', 'editorPreserved', 'projectIsolated', 'cachedReopen', 'graphRendered', 'modeChanged', 'mobileBackAccepted', 'driftPanelBackAccepted']) assert.equal(ui[key], true, `${ui.shell}: ${key}`);
      for (const kind of Object.keys(targets)) {
        const attempts = ui.requests.filter(r => r.kind === kind && r.url.includes('graph-attempt='));
        assert.equal(attempts.length, 2, JSON.stringify(ui.requests));
        assert.notEqual(attempts[0].url, attempts[1].url);
        assert.equal(attempts[0].url.split('?')[0], attempts[1].url.split('?')[0]);
      }
    }
    assert(report.tests.length > 4 && report.tests.every(t => t.status === 'passed'));
    assert.equal(report.devGraphs, 'passed');
  }
  if (preload) validatePreloadAcceptance(report.preloading);
  assert.equal(report.acceptance.native, 'not-run'); assert.equal(report.acceptance.fullAppPerformance, 'not-run');
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  if (!baseline) assert.equal(report.source.fingerprint, fingerprint(root), 'Graph evidence is stale.');
  console.log('Graph loading evidence passed; native and full-app performance remain separate.');
  process.exit(0);
}
const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chrome, 'Set DRIFTING_PERF_CHROME to Chromium.');
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'drifting-deferred-graphs-')));
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
    execFileSync('pnpm', ['exec', 'vitest', 'run', 'src/renderer/lib/deferred-', 'src/renderer/features/graph/', 'src/renderer/hooks/useSuperViewEscapeStack.test.ts', 'src/renderer/architecture/renderer-boundaries.test.ts', '--reporter=json', `--outputFile=${json}`], { stdio: 'pipe' });
    const result = JSON.parse(readFileSync(json, 'utf8')); assert(result.success && result.numFailedTests === 0 && result.numPendingTests === 0);
    tests = result.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration })));
  }
  const chunks = [];
  const outDir = path.join(temporary, 'production');
  await build({ root: source, configFile: path.join(source, 'vite.renderer.config.ts'), logLevel: 'warn',
    plugins: [{ name: 'graph-evaluation-observation', enforce: 'pre',
      transform(code, id) { const name = target(id); if (name) return `;(globalThis.__GRAPH_EVALUATIONS__ ??= []).push(${JSON.stringify(name)});\n${code}`; },
      generateBundle(_options, bundle) { for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.push({ file: item.fileName, bytes: Buffer.byteLength(item.code), entry: item.isEntry, facade: sourceFacade(source, item.facadeModuleId), imports: item.imports, css: [...(item.viteMetadata?.importedCss ?? [])], targets: [...new Set(Object.keys(item.modules).map(target).filter(Boolean))] }); },
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
    await client.Page.bringToFront();
    await client.Emulation.setFocusEmulationEnabled({ enabled: true });
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
  const initial = { evaluated: await production.evaluate('globalThis.__GRAPH_EVALUATIONS__ ?? []'), parsed: [...parsed].sort(), requested: [...requested].sort() };
  await stopServer();
  const initialCss = new Set(chunks.filter(c => c.initial).flatMap(c => c.css));
  const ui = []; let devGraphs = 'not-run'; let preloading = null;
  if (!baseline) {
    for (const suffix of ['DesktopStoryGraphView.tsx', 'DesktopSuperElementView.tsx', 'graph-ui-components.ts']) {
      const entry = chunks.find(c => c.facade?.endsWith('/' + suffix));
      assert(entry && !entry.initial);
      for (const dependency of entry.imports) assert(initialFiles.has(dependency), `Cold dependency bypasses graph loading owner: ${dependency}`);
      for (const css of entry.css) assert(initialCss.has(css), `Graph CSS is not loaded by the shell: ${css}`);
    }
  }
  if (!baseline) {
    const uiDir = path.join(temporary, 'ui');
    await build({ root, configFile: path.join(root, 'vite.renderer.config.ts'), logLevel: 'warn', build: { outDir: uiDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/renderer-graphs-ui.html') } } });
    origin = await serve(uiDir);
    if (preload) preloading = await runPreloadAcceptance({ page, origin, clients });
    for (const mobile of [false, true]) {
      const { client, evaluate, until, navigate } = await page();
      await client.Emulation.setDeviceMetricsOverride({ width: mobile ? 390 : 1280, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile: false });
      const gates = { shared: 'fail', story: 'fail', element: 'fail' }; const requests = []; const held = [];
      const kindOf = (url) => url.includes('/graph-ui-') ? 'shared' : url.includes('/story-graph-') ? 'story' : 'element';
      await client.Fetch.enable({ patterns: ['*graph-ui-*.js*', '*story-graph-*.js*', '*element-graph-*.js*'].map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
      client.Fetch.requestPaused(event => {
        const kind = kindOf(event.request.url); const url = new URL(event.request.url);
        requests.push({ kind, url: url.pathname + url.search });
        if (gates[kind] === 'fail') void client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'InternetDisconnected' });
        else if (gates[kind] === 'hold') held.push(event.requestId);
        else void client.Fetch.continueRequest({ requestId: event.requestId });
      });
      await navigate(`${origin}scripts/renderer-graphs-ui.html${mobile ? '?mobile' : ''}`);
      await until('Boolean(document.querySelector(".tiptap"))');
      const before = await evaluate('window.__GRAPHS_UI__.inspect()');
      const initiallyDeferred = requests.length === 0;
      await evaluate('document.querySelector(".tiptap").focus(); window.__GRAPHS_UI__.open("graph")');
      await until('Boolean(document.querySelector("[role=alert]"))');
      assert.equal(requests.length, 1); assert.equal(requests[0].kind, 'shared');
      gates.shared = 'pass';
      await evaluate('document.querySelector("[role=alert] button").click()');
      await until('Boolean(document.querySelector("[role=alert]")) && document.querySelector("[role=alert]").textContent.length > 0');
      for (let n = 0; n < 200 && !requests.some(r => r.kind === 'story'); n++) await delay(25);
      assert(requests.some(r => r.kind === 'story'));
      await until('Boolean(document.querySelector("[role=alert]"))');
      const sharedRetry = requests.filter(r => r.kind === 'shared' && r.url.includes('graph-attempt=')).length === 2;
      gates.story = 'hold'; await evaluate('document.querySelector("[role=alert] button").click()');
      for (let n = 0; n < 200 && !held.length; n++) await delay(25);
      assert(held.length); const storyRetry = requests.filter(r => r.kind === 'story' && r.url.includes('graph-attempt=')).length === 2;
      await evaluate('window.__GRAPHS_UI__.edit(); document.querySelector(".super-view-head__switcher-option").click()');
      await until('window.__GRAPHS_UI__.observations.active === "element" && Boolean(document.querySelector("[role=alert]"))');
      const switchWhileLoading = !await evaluate('Boolean(document.querySelector(".graph-overlay"))');
      writeFileSync(path.join(root, `.local-data/renderer-performance/f7c-${mobile ? 'mobile' : 'desktop'}-error.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
      gates.element = 'pass';
      await evaluate('window.__focusEvents = []; for (const kind of ["focusin", "focusout"]) document.addEventListener(kind, e => window.__focusEvents.push({ kind, target: e.target.outerHTML?.slice(0, 200), related: e.relatedTarget?.outerHTML?.slice(0, 200) }), true);');
      await evaluate('document.querySelector("[role=alert] button").focus()');
      assert(await evaluate('document.activeElement === document.querySelector("[role=alert] button")'), 'Retry button must receive browser focus before testing transfer');
      await evaluate('document.querySelector("[role=alert] button").click()');
      await until('Boolean(document.querySelector(".super-element-overlay"))', 'actual element graph');
      const elementRetry = requests.filter(r => r.kind === 'element' && r.url.includes('graph-attempt=')).length === 2;
      const focusTransferred = await evaluate('document.activeElement === document.querySelector(".super-view-head__back")');
      if (!focusTransferred) console.error('Focus diagnostic', await evaluate('({ events: window.__focusEvents, active: document.activeElement.outerHTML.slice(0,300), back: document.querySelector(".super-view-head__back")?.outerHTML.slice(0,300) })'));
      const current = await evaluate('window.__GRAPHS_UI__.inspect()');
      const editorPreserved = current.editorId === before.editorId && current.mounts === 1 && current.unmounts === 0 && current.text.includes('synthetic edit');
      // Switch the synthetic project's projection/provider while old story code
      // is held. The fixture intentionally creates a new document for the new project.
      await evaluate('window.__GRAPHS_UI__.project("synthetic-b")');
      await until('document.querySelector(".super-element-overlay")?.textContent.includes("synthetic-b element")');
      gates.story = 'pass'; for (const requestId of held.splice(0)) await client.Fetch.continueRequest({ requestId });
      await until('performance.getEntriesByType("resource").some(e => e.name.includes("story-graph-") && e.transferSize > 0)');
      const lateResultIgnored = await evaluate('window.__GRAPHS_UI__.observations.active === "element" && !document.querySelector(".graph-overlay")');
      await evaluate('window.__statusMounts = 0; window.__observer = new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches("[role=status]") || n.querySelector("[role=status]"))) window.__statusMounts++; }); window.__observer.observe(document.getElementById("root"), { childList: true, subtree: true });');
      await evaluate('document.querySelectorAll(".super-view-head__switcher-option")[1].click()');
      await until('Boolean(document.querySelector(".graph-overlay .graph-tile"))', 'actual story graph');
      const graphRendered = await evaluate('document.querySelectorAll(".graph-tile").length === 11');
      const projectIsolated = await evaluate('document.querySelector(".graph-overlay").textContent.includes("synthetic-b chapter") && !document.querySelector(".graph-overlay").textContent.includes("synthetic-a chapter")');
      await evaluate('document.querySelectorAll(".graph-head__view-toggle button")[1].click()');
      await until('document.querySelector(".graph-overlay")?.dataset.view === "narrative"');
      const modeChanged = true;
      await evaluate('window.dispatchEvent(new CustomEvent("drifting:mobile-workspace-back", { cancelable: true, detail: { source: "keyboard" } }))');
      await until('window.__GRAPHS_UI__.observations.active === "none"');
      const mobileBackAccepted = true;
      await evaluate('window.__GRAPHS_UI__.open("graph")');
      await until('Boolean(document.querySelector(".graph-overlay .graph-tile"))');
      const cachedReopen = await evaluate('window.__statusMounts === 0 && document.querySelector(".graph-overlay").dataset.view === "narrative"');
      await evaluate('document.querySelector(".drift-panel__tab").click()');
      await until('Boolean(document.querySelector(".drift-panel.is-open .drift-panel__hand"))');
      await evaluate('window.dispatchEvent(new CustomEvent("drifting:mobile-workspace-back", { cancelable: true, detail: { source: "keyboard" } }))');
      await until('Boolean(document.querySelector(".drift-panel__tab")) && !document.querySelector(".drift-panel__hand")', 'drift panel closes after animation');
      const driftPanelBackAccepted = await evaluate('window.__GRAPHS_UI__.observations.active === "graph"');
      writeFileSync(path.join(root, `.local-data/renderer-performance/f7c-${mobile ? 'mobile' : 'desktop'}-graph.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
      ui.push({ shell: mobile ? 'mobile-host' : 'desktop', initiallyDeferred, sharedRetry, storyRetry, elementRetry, switchWhileLoading, lateResultIgnored, focusTransferred, editorPreserved, projectIsolated, cachedReopen, graphRendered, modeChanged, mobileBackAccepted, driftPanelBackAccepted, requests });
      await client.close(); clients.delete(client);
    }
    await stopServer();
    development = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'warn', server: { host: '127.0.0.1', port: 0, open: false } });
    await development.listen();
    const devPage = await page();
    await devPage.navigate(`${development.resolvedUrls.local[0]}scripts/renderer-graphs-ui.html`);
    await devPage.until('Boolean(document.querySelector(".tiptap"))');
    await devPage.evaluate('window.__GRAPHS_UI__.open("graph")');
    await devPage.until('Boolean(document.querySelector(".graph-overlay .graph-tile"))', 'development story graph');
    await devPage.evaluate('window.__GRAPHS_UI__.open("element")');
    await devPage.until('Boolean(document.querySelector(".super-element-overlay"))', 'development element graph');
    devGraphs = 'passed';
    await devPage.client.close(); clients.delete(devPage.client);
    await development.close(); development = null;
  }

  assert.equal(sourceFingerprint, fingerprint(source), 'Source changed during acceptance.');
  const report = { schemaVersion: 1, kind: 'renderer_deferred_graphs', status: 'passed', mode: baseline ? 'baseline' : 'deferred', generatedAt: new Date().toISOString(),
    source: { commit, fingerprint: sourceFingerprint, dirty: Boolean(execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) },
    environment: { platform: process.platform, node: process.version, browser: (await production.client.Browser.getVersion()).product },
    initialJsBytes: chunks.filter((c) => c.initial).reduce((sum, c) => sum + c.bytes, 0), chunks, initial, ui, tests, devGraphs, preloading,
    acceptance: { productionModuleLoading: 'passed', mountedGraphs: baseline ? 'not-run' : 'passed', native: 'not-run', fullAppPerformance: 'not-run' },
    limitations: [
      'The main-entry measurement builds actual production main.tsx/config with three module evaluation counters. No native bridge or author database is available; app readiness and native startup latency are not measured.',
      'Mounted acceptance uses actual graph bodies, wrappers, stores, shared relation provider, mobile host, and a synthetic workspace navigation provider. The draft is a real Tiptap/Yjs instance but is not the production ChapterEditor or ProjectRuntimeProvider.',
      'Actual network requests for shared graph UI, story graph and element graph are each failed and retried with fresh query keys. Every emitted entry static dependency must be in the initial HTML closure. No native offline/upgrade consistency or module-evaluation failure recovery is claimed.',
      'The mobile host runs at a 390x844 browser viewport without native platform metadata. Typed Back events and host focus are tested; native gesture modes, Android hardware Back, physical IME and full project lifecycle remain untested.',
      'Graph display/mode switching and synthetic project isolation are verified. Native SQLite mutations, all graph editing/popover actions and p95 performance budgets are not part of this report.'
    ] };
  try { validate(report); } catch (error) { console.error(JSON.stringify({ ui })); throw error; }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(root, output), source: report.source, initialJsBytes: report.initialJsBytes, ui, preloading, tests: tests.length }));
} finally {
  for (const client of clients) await client.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let n = 0; n < 30 && browser.exitCode === null; n++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise((resolve) => browser.once('exit', resolve)); } }
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (development) await development.close();
  if (worktree) execFileSync('git', ['worktree', 'remove', '--force', source], { stdio: 'pipe' });
  rmSync(temporary, { recursive: true, force: true });
}
