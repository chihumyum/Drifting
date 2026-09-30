import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, createServer, preview } from 'vite';
import CDP from 'chrome-remote-interface';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';
import { featureLoadingClosure } from './renderer-feature-loading-closure.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); process.chdir(root);
const output = 'docs/renderer-performance/acceptance/settings-entry.json';
const fingerprint = () => createHash('sha256').update(referenceEvidenceFingerprint(root))
  .update(readFileSync('vite-plugins/deferred-settings.ts')).update(readFileSync('vite-plugins/deferred-entry.ts'))
  .update(readFileSync('scripts/renderer-settings-ui.tsx')).update(readFileSync('scripts/renderer-settings-ui.html'))
  .update(readFileSync('vite.renderer.config.ts')).update(readFileSync('scripts/renderer-project-entry.tsx'))
  .update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const checks = ['shellWithoutWorkspace', 'basicWithoutDeferredPanels', 'preferencePersisted', 'localLoading', 'navigationDuringLoad', 'latePanelIgnored', 'cachedGroup', 'localFailure', 'retryRecovered', 'returnToShelf'];
function validate(report) {
  assert.equal(report.kind, 'renderer_settings_entry'); assert.equal(report.status, 'passed');
  assert.equal(report.source.fingerprint, fingerprint(), 'Settings entry evidence is stale.');
  assert.equal(report.runs.length, 4);
  assert.deepEqual(report.runs.map(r => `${r.mode}:${r.mobile}`).sort(), ['development:false', 'development:true', 'production:false', 'production:true']);
  for (const run of report.runs) {
    assert(Number.isFinite(run.basicOpenMs) && run.basicOpenMs >= 0);
    assert.deepEqual(Object.keys(run.checks).sort(), [...checks].sort());
    for (const check of checks) assert.equal(run.checks[check], true, `${run.mode}/${run.mobile}/${check}`);
  }
  assert.equal(report.projectModal.retryRecovered, true);
  assert.equal(report.projectModal.draftPreserved, true);
  assert.equal(report.production.basicEager, true);
  assert.equal(report.production.workspaceEager, false);
  assert.equal(report.production.heavySettingsEager, false);
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Standalone settings browser and production module boundary evidence passed.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync); assert(chrome);
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-settings-entry-'));
  const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fingerprint: fingerprint() };
  const targets = { basic: '/features/settings/panels/BasicPreferencePanels.tsx', controls: '/features/settings/panels/ControlSettingsPanels.tsx', intelligence: '/features/settings/panels/IntelligenceSettingsPanels.tsx', agent: '/features/settings/panels/AgentSettingsPanel.tsx', editor: '/features/settings/panels/PreferenceSettingsPanels.tsx', desktop: '/shells/desktop/DesktopAppShell.tsx', mobile: '/shells/mobile/MobileAppShell.tsx' };
  const chunks = [], runs = [];
  const projectModal = {};
  const observation = {
    name: 'settings-entry-observer', enforce: 'pre',
    transform(code, id) {
      if (id === path.join(root, 'src/renderer/main.tsx')) {
        assert(code.includes('void bootstrap();'));
        return `import { bootstrapProjectEntryProbe } from '/scripts/renderer-project-entry.tsx';\n${code.replace('void bootstrap();', 'bootstrapProjectEntryProbe();')}`;
      }
      if (id === path.join(root, 'src/renderer/views/ProjectPickerView.tsx')) {
        const anchor = "export function ProjectPickerView({ presentation = 'desktop' }: ProjectPickerViewProps) {"; assert(code.includes(anchor));
        return code.replace(anchor, `${anchor}\nif (globalThis.__PROJECT_ENTRY_PROBE__) return globalThis.__PROJECT_ENTRY_PROBE__.shelf();`);
      }
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') chunks.push({ file: chunk.fileName, imports: chunk.imports,
        entry: chunk.facadeModuleId === path.join(root, 'index.html'),
        controls: chunk.facadeModuleId === path.join(root, 'src/renderer/features/settings/panels/AccountControlSettingsPanels.ts'),
        facade: chunk.facadeModuleId?.startsWith(root) ? path.relative(root, chunk.facadeModuleId) : null,
        route: chunk.facadeModuleId === path.join(root, 'src/renderer/app/project-route-components.tsx'),
        targets: Object.entries(targets).filter(([, suffix]) => Object.keys(chunk.modules).some(id => id.endsWith(suffix))).map(([key]) => key) });
    },
  };
  Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000' });
  let server, browser, client;
  try {
    const outDir = path.join(temporary, 'production');
    console.log('Building production settings boundary');
    await build({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'error', plugins: [observation], build: { outDir, emptyOutDir: true } });
    const initial = new Set();
    function visit(file) { if (initial.has(file)) return; initial.add(file); chunks.find(c => c.file === file).imports.forEach(visit); }
    chunks.filter(c => c.entry).forEach(c => visit(c.file));
    chunks.forEach(c => { c.initial = initial.has(c.file); });
    const available = featureLoadingClosure(chunks).files;
    const coldDependencies = chunks.filter(c => c.targets.some(key => ['controls', 'intelligence', 'agent', 'editor'].includes(key)))
      .flatMap(chunk => chunk.imports.filter(dependency => !available.has(dependency)));
    assert.deepEqual([...new Set(coldDependencies)], [], 'Project settings retry has cold shared dependencies');
    const eager = key => chunks.some(c => initial.has(c.file) && c.targets.includes(key));
    const production = { basicEager: eager('basic'), workspaceEager: eager('desktop') || eager('mobile'), heavySettingsEager: ['controls', 'intelligence', 'agent', 'editor'].some(eager) };
    assert(production.basicEager && !production.workspaceEager && !production.heavySettingsEager, JSON.stringify(production));
    const controlChunk = chunks.find(c => c.controls); const routeChunk = chunks.find(c => c.route); assert(controlChunk && routeChunk);
    const profile = path.join(temporary, 'chrome');
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++) { assert.equal(browser.exitCode, null); await delay(100); }
    assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    for (const mode of ['production', 'development']) {
      server = mode === 'production'
        ? await preview({ root, configFile: false, envDir: false, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } })
        : await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'error', cacheDir: path.join(temporary, 'vite'), plugins: [observation], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false } });
      if (mode === 'development') await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
      const controlPath = mode === 'production' ? controlChunk.file : 'src/renderer/features/settings/panels/AccountControlSettingsPanels.ts';
      const routePath = mode === 'production' ? routeChunk.file : 'src/renderer/app/project-route-components.tsx';
      for (const mobile of [false, true]) {
        console.log(`Checking ${mode}, ${mobile ? 'mobile shell' : 'desktop shell'}`);
        client = await CDP({ port, target: await CDP.New({ port }) });
        await client.Page.enable(); await client.Page.addScriptToEvaluateOnNewDocument({ source: 'performance.setResourceTimingBufferSize(10000)' }); await client.Runtime.enable(); await client.Network.enable(); await client.Network.setCacheDisabled({ cacheDisabled: true });
        await client.Emulation.setDeviceMetricsOverride({ width: mobile ? 390 : 1200, height: 800, deviceScaleFactor: 1, mobile: false });
        const requested = new Set(), errors = [];
        client.Network.requestWillBeSent(({ request }) => requested.add(new URL(request.url).pathname.slice(1)));
        client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
        const evaluate = async expression => {
          const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
          assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
        };
        const until = async expression => { for (let i = 0; i < 1600; i++) { assert.deepEqual(errors, []); if (await evaluate(`Boolean(${expression})`)) return; await delay(20); } throw new Error(`Timed out: ${expression}`); };
        const navigate = hash => evaluate(`location.hash = ${JSON.stringify(hash)}`);
        const fresh = async () => { await client.Page.navigate({ url: `${origin}?preload=0${mobile ? '&mobile' : ''}#/` }); await until('globalThis.__PROJECT_ENTRY_PROBE__?.observations.shelfAt'); };
        let gate = 'hold', held;
        await client.Fetch.enable({ patterns: [{ urlPattern: `*/${controlPath}*`, requestStage: 'Request' }, { urlPattern: `*/${routePath}*`, requestStage: 'Request' }] });
        client.Fetch.requestPaused(async event => {
          if (event.request.url.includes(routePath) || gate === 'fail') await client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'Failed' });
          else if (gate === 'hold') held = event.requestId;
          else await client.Fetch.continueRequest({ requestId: event.requestId });
        });
        await fresh();
        const result = {};
        await evaluate("window.__settingsClick = performance.now(); location.hash = '/settings?section=language'");
        await until("document.querySelector('#language')");
        const basicOpenMs = await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__settingsClick))))');
        assert(!requested.has(routePath));
        assert.equal(await evaluate('globalThis.__PROJECT_ENTRY_PROBE__.observations.mounts'), 0);
        result.shellWithoutWorkspace = true;
        assert(!requested.has(controlPath));
        const forbidden = mode === 'production' ? chunks.filter(c => c.targets.some(key => ['intelligence', 'agent', 'editor'].includes(key))).map(c => c.file)
          : ['IntelligenceSettingsPanels', 'AgentSettingsPanel', 'PreferenceSettingsPanels'].map(name => `src/renderer/features/settings/panels/${name}.tsx`);
        for (const file of forbidden) assert(!requested.has(file), `Basic settings requested ${file}`);
        result.basicWithoutDeferredPanels = true;
        await evaluate("[...document.querySelectorAll('#language .set-locale')].find(b => b.textContent.includes('en')).click()");
        await until("JSON.parse(localStorage.getItem('settings-storage')).state.uiLocale === 'en'"); result.preferencePersisted = true;
        await evaluate("window.__header = document.querySelector('.set-head'); true");
        await navigate('/settings?section=sync');
        await until("document.querySelector('.set-main [role=status] .app-fullscreen-status__spinner')");
        for (let i = 0; i < 200 && !held; i++) await delay(20); assert(held);
        assert.equal(await evaluate("Boolean(document.querySelector('.set-head__back')) && !document.querySelector('.app-fullscreen-status')"), true);
        result.localLoading = true;
        const screenshots = path.join(root, '.qa/settings-entry'); mkdirSync(screenshots, { recursive: true });
        writeFileSync(path.join(screenshots, `${mode}-${mobile ? 'mobile' : 'desktop'}-loading.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        await navigate('/settings?section=appearance'); await until("document.querySelector('#appearance')");
        assert.equal(await evaluate("window.__header === document.querySelector('.set-head')"), true); result.navigationDuringLoad = true;
        gate = 'pass'; await client.Fetch.continueRequest({ requestId: held });
        await until(`performance.getEntriesByType('resource').some(e => e.name.includes(${JSON.stringify(controlPath)}) && e.responseEnd > 0)`);
        assert.equal(await evaluate("Boolean(document.querySelector('#appearance')) && !document.querySelector('#sync')"), true); result.latePanelIgnored = true;
        await navigate('/settings?section=privacy'); await until("document.querySelector('#privacy')");
        await navigate('/settings?section=about'); await until("document.querySelector('#about')"); result.cachedGroup = true;
        await client.Page.navigate({ url: 'about:blank' }); gate = 'fail'; await fresh();
        await navigate('/settings?section=privacy'); await until("document.querySelector('.set-main [role=alert]')");
        assert.equal(await evaluate("Boolean(document.querySelector('.set-head__back')) && !document.querySelector('.app-fullscreen-status') && !document.querySelector('.app-fullscreen-status__spinner')"), true); result.localFailure = true;
        gate = 'pass'; await evaluate("document.querySelector('[role=alert] button').click()");
        await until("document.querySelector('#privacy')"); assert.equal(await evaluate('location.hash'), '#/settings?section=privacy'); result.retryRecovered = true;
        await evaluate("document.querySelector('.set-head__back').click()");
        if (mobile) { await until("location.hash === '#/settings'"); await evaluate("document.querySelector('.set-head__back').click()"); }
        await until("document.querySelector('[data-shelf]')"); result.returnToShelf = true;
        assert.deepEqual(errors, []);
        runs.push({ mode, mobile, basicOpenMs, checks: result });
        console.log(JSON.stringify(runs.at(-1)));
        await client.close(); client = null;
      }
      if (mode === 'development') {
        client = await CDP({ port, target: await CDP.New({ port }) });
        await client.Page.enable(); await client.Runtime.enable();
        const evaluate = async expression => {
          const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
          assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
        };
        const until = async expression => { for (let i = 0; i < 1500; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(20); } throw new Error(`Project modal timed out: ${expression}`); };
        let fail = true; const attempts = [];
        await client.Fetch.enable({ patterns: [{ urlPattern: '*AccountControlSettingsPanels.ts?settings-control-attempt=*', requestStage: 'Request' }] });
        client.Fetch.requestPaused(async event => {
          attempts.push(new URL(event.request.url).search);
          if (fail) await client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'Failed' });
          else await client.Fetch.continueRequest({ requestId: event.requestId });
        });
        await client.Page.navigate({ url: `${origin}scripts/renderer-settings-ui.html` });
        await until("document.querySelector('#synthetic-draft')");
        await evaluate("window.__draft = document.querySelector('#synthetic-draft'); window.__draft.value = 'Synthetic pending edit'; window.__SETTINGS_UI__.modal(true)");
        await until("document.querySelector('[role=dialog] [role=alert]')");
        await evaluate("window.__modalHeader = document.querySelector('[role=dialog] .set-head'); true");
        fail = false;
        await evaluate("document.querySelector('[role=dialog] [role=alert] button').click()");
        await until("document.querySelector('[role=dialog] #language')");
        assert.equal(attempts.length, 2); assert.notEqual(attempts[0], attempts[1]);
        projectModal.retryRecovered = true;
        assert.equal(await evaluate("window.__draft === document.querySelector('#synthetic-draft') && window.__draft.value === 'Synthetic pending edit' && window.__modalHeader === document.querySelector('[role=dialog] .set-head')"), true);
        projectModal.draftPreserved = true;
        await client.close(); client = null;
        await server.close();
      }
      else await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
      server = null;
    }
    const report = { kind: 'renderer_settings_entry', status: 'passed', generatedAt: new Date().toISOString(), source, production, runs, projectModal,
      limitations: ['Real AppRoutes, settings shells and panels with synthetic shelf/auth bootstrap; no native database, private account or manuscript. Native input and complete app startup are not measured.', 'Single basic-settings navigation timing per scenario; diagnostic only. Production module graph verifies basic preferences are eager while workspace and heavier settings remain deferred.', 'Standalone load failure recovers by explicit document reload retaining the URL. Project settings modal retries failed feature groups without reloading the document, retaining its continuous scrolling layout.'] };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(output);
  } finally {
    if (client) await client.close();
    if (server) { if (typeof server.close === 'function') await server.close(); else await new Promise(resolve => server.httpServer.close(resolve)); }
    if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); } }
    rmSync(temporary, { recursive: true, force: true });
  }
}
