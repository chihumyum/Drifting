import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import CDP from 'chrome-remote-interface';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';
import { validateProjectRoutes } from './renderer-project-routes-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); process.chdir(root);
const base = 'c290c9981e8255055624adccf669fd4515c2647f';
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f7-project-routes.json';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function fingerprint(directory) {
  const digest = createHash('sha256').update(referenceEvidenceFingerprint(directory));
  for (const file of ['vite.renderer.config.ts', ...readdirSync(path.join(directory, 'vite-plugins')).sort().map(name => `vite-plugins/${name}`)]) digest.update(file).update(readFileSync(path.join(directory, file)));
  for (const file of ['scripts/renderer-feature-loading-closure.mjs', 'scripts/renderer-project-routes.tsx', 'scripts/renderer-project-routes-contract.mjs', 'scripts/run-renderer-project-routes.mjs']) digest.update(file).update(readFileSync(path.join(root, file)));
  return digest.digest('hex');
}
const targets = { 'shells/desktop/DesktopAppShell.tsx': 'desktopShell', 'shells/mobile/MobileAppShell.tsx': 'mobileShell', 'features/editor/desktop/DesktopEditorRoutes.tsx': 'editorRoutes', 'views/ProjectDashboard.tsx': 'dashboard' };
const target = id => Object.entries(targets).find(([suffix]) => id.endsWith(`/src/renderer/${suffix}`))?.[1];
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validateProjectRoutes(report);
  if (!process.argv.includes('--historical')) assert.equal(report.after.source.fingerprint, fingerprint(root), 'Project route evidence is stale.');
  console.log('Project route evidence passed; native and full-app acceptance remain manual.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync); assert(chrome);
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-project-routes-')); const baseline = path.join(temporary, 'baseline'); let added = false;
  const sourceFingerprint = fingerprint(root); const sourceCommit = git('rev-parse', 'HEAD');
  async function measure(directory, label) {
    directory = realpathSync(directory); const current = label === 'after';
    const chunks = []; const outDir = path.join(temporary, `${label}-dist`); const profile = path.join(temporary, `${label}-chrome`);
    let server, browser, client;
    try {
      console.log(`Building ${label} production renderer`);
      await build({ root: directory, configFile: path.join(directory, 'vite.renderer.config.ts'), logLevel: 'warn',
        plugins: [{ name: 'project-route-observation', enforce: 'pre',
          transform(code, id) {
            if (id === path.join(directory, 'src/renderer/main.tsx')) {
              assert(code.includes('void bootstrap();'));
              return `import { bootstrapProjectRouteProbe } from ${JSON.stringify(path.join(directory, 'scripts/renderer-project-routes.tsx'))};\n${code.replace('void bootstrap();', 'if (globalThis.__PROJECT_ROUTE_PROBE__) bootstrapProjectRouteProbe(); else void bootstrap();')}`;
            }
            if (id === path.join(directory, 'src/renderer/views/ProjectPickerView.tsx')) {
              const anchor = "export function ProjectPickerView({ presentation = 'desktop' }: ProjectPickerViewProps) {"; assert(code.includes(anchor));
              return code.replace(anchor, `${anchor}\nif (globalThis.__PROJECT_ROUTE_PROBE__) return globalThis.__PROJECT_ROUTE_PROBE__.shelf();`);
            }
            if (id === path.join(directory, 'src/renderer/app/project-route-components.tsx')) return `${code}\nif (globalThis.__PROJECT_ROUTE_PROBE__) Object.assign(projectRoutes, globalThis.__PROJECT_ROUTE_PROBE__.routes);`;
            const key = target(id); if (key) return `;(globalThis.__PROJECT_ROUTE_EVALUATIONS__ ??= []).push(${JSON.stringify(key)});\n${code}`;
          },
          generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') chunks.push({ file: chunk.fileName, htmlEntry: chunk.facadeModuleId === path.join(directory, 'index.html'), facade: chunk.facadeModuleId === path.join(directory, 'src/renderer/app/project-route-components.tsx') ? 'src/renderer/app/project-route-components.tsx' : null, bytes: Buffer.byteLength(chunk.code), imports: chunk.imports, css: [...(chunk.viteMetadata?.importedCss ?? [])], targets: [...new Set(Object.keys(chunk.modules).map(target).filter(Boolean))] });
          },
        }], build: { outDir, emptyOutDir: true } });
      const initialFiles = new Set(); const visit = file => { if (initialFiles.has(file)) return; initialFiles.add(file); for (const imported of chunks.find(chunk => chunk.file === file)?.imports ?? []) visit(imported); };
      chunks.filter(chunk => chunk.htmlEntry).forEach(chunk => visit(chunk.file)); chunks.forEach(chunk => { chunk.initial = initialFiles.has(chunk.file); });
      server = await preview({ root: directory, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
      browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
      let launchError; browser.on('error', error => { launchError = error; }); const portFile = path.join(profile, 'DevToolsActivePort');
      for (let i = 0; i < 200 && !existsSync(portFile); i++) { if (launchError || browser.exitCode !== null) throw new Error('Headless browser failed to start'); await delay(100); }
      assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      client = await CDP({ port, target: await CDP.New({ port }) });
      await client.Page.enable(); await client.Runtime.enable(); await client.Debugger.enable(); await client.Network.enable(); await client.Network.setCacheDisabled({ cacheDisabled: true });
      const requested = new Set(), parsed = new Set();
      const localPath = url => { try { return new URL(url).pathname.slice(1); } catch { return ''; } };
      client.Network.requestWillBeSent(({ request }) => requested.add(localPath(request.url)));
      client.Debugger.scriptParsed(({ url }) => parsed.add(localPath(url)));
      async function evaluate(expression) { const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; }
      async function until(expression) { for (let i = 0; i < 300; i++) { const value = await evaluate(expression); if (value) return value; await delay(20); } throw new Error(`Browser condition timed out: ${expression}`); }
      const navigate = route => evaluate(`location.hash = ${JSON.stringify(route)}`);
      const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
      const fresh = async () => { await client.Page.navigate({ url: `${origin}#/` }); await until("Boolean(document.querySelector('[data-shelf]'))"); };
      await fresh();
      const initial = { requested: [...requested].sort(), parsed: [...parsed].sort(), evaluated: await evaluate('globalThis.__PROJECT_ROUTE_EVALUATIONS__ ?? []') };
      const checks = {}, failures = [];
      if (current) {
        assert.deepEqual(initial.evaluated, []); checks.coldUntilDemand = true;
        const entry = chunks.find(chunk => chunk.targets.includes('desktopShell')); assert(entry && !entry.initial);
        const shared = entry.imports.find(file => !initialFiles.has(file)); assert(shared, 'Fixture must exercise a cold shared JS dependency.');
        const css = entry.css.find(file => !chunks.filter(chunk => chunk.initial).some(chunk => chunk.css.includes(file))); assert(css);
        let action = 'fail', paused; const errors = [];
        client.Fetch.requestPaused(async event => { try { if (action === 'fail') await client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'Failed' }); else paused = event; } catch (error) { errors.push(String(error)); } });
        for (const [kind, file] of [['shared-js', shared], ['css', css]]) {
          if (kind === 'css') { await client.Page.navigate({ url: 'about:blank' }); await fresh(); }
          action = 'fail'; await client.Fetch.enable({ patterns: [{ urlPattern: `*/${file}`, requestStage: 'Request' }] });
          await navigate('/project/synthetic-a/editor/node-a'); await until("Boolean(document.querySelector('[role=alert]'))");
          const workspacesBeforeRetry = await evaluate('globalThis.__PROJECT_ROUTE_PROBE__.observations.mounts'); assert.equal(workspacesBeforeRetry, 0);
          await evaluate("document.querySelector('[role=alert] button:not(.set-btn--primary)').click()"); await until("Boolean(document.querySelector('[data-shelf]'))"); checks.backAfterFailure = true;
          await navigate('/project/synthetic-a/editor/node-a'); await until("Boolean(document.querySelector('[role=alert]'))");
          await client.Fetch.disable(); requested.clear();
          const loaded = client.Page.loadEventFired(); await evaluate("document.querySelector('[role=alert] .set-btn--primary').click()"); await loaded;
          const afterRetryProject = await until("document.querySelector('[data-project]')?.getAttribute('data-project')"); assert.equal(afterRetryProject, 'synthetic-a');
          assert(requested.has(file)); assert.equal(await evaluate('globalThis.__PROJECT_ROUTE_PROBE__.observations.mounts'), 1);
          failures.push({ kind, file, workspacesBeforeRetry, afterRetryProject, requestedAfterRetry: [...requested].sort() });
          checks[kind === 'css' ? 'cssFailure' : 'sharedJsFailure'] = true; checks.reloadRetry = true;
        }
        await client.Page.navigate({ url: 'about:blank' }); await fresh(); action = 'hold'; paused = undefined;
        await client.Fetch.enable({ patterns: [{ urlPattern: `*/${entry.file}`, requestStage: 'Request' }] });
        await navigate('/project/synthetic-a/editor/node-a');
        for (let i = 0; i < 300 && !paused && !errors.length; i++) await delay(20); assert(paused); assert.deepEqual(errors, []);
        await until("Boolean(document.querySelector('[role=status] button'))");
        await evaluate("document.querySelector('[role=status] button').click()"); await until("Boolean(document.querySelector('[data-shelf]'))"); checks.loadingBack = true;
        await navigate('/project/synthetic-b/editor/node-b'); await client.Fetch.continueRequest({ requestId: paused.requestId }); await client.Fetch.disable();
        assert.equal(await until("document.querySelector('[data-project]')?.getAttribute('data-project')"), 'synthetic-b'); checks.lateProjectOwner = true;
        await evaluate("globalThis.__draftElement = document.querySelector('[data-draft]'); globalThis.__draftElement.value = 'synthetic unsaved draft'");
        for (const [route, kind] of [['', 'home'], ['/editor/all', 'allChapters'], ['/editor/node-c', 'node'], ['/editor/storyline/storyline-c', 'storyline'], ['/element/element-c', 'element'], ['/category/category-c', 'category']]) {
          await navigate(`/project/synthetic-b${route}`); await until(`document.querySelector('[data-leaf]')?.getAttribute('data-leaf') === ${JSON.stringify(kind)}`);
          assert.equal(await evaluate("document.querySelector('[data-draft]') === globalThis.__draftElement && globalThis.__draftElement.value === 'synthetic unsaved draft'"), true);
          assert.equal(await evaluate('globalThis.__PROJECT_ROUTE_PROBE__.observations.mounts'), 1);
        }
        checks.routeTable = true; checks.draftContinuity = true;
        const evaluations = await evaluate('globalThis.__PROJECT_ROUTE_EVALUATIONS__'); assert.deepEqual([...evaluations].sort(), Object.values(targets).sort());
        await navigate('/'); await until("Boolean(document.querySelector('[data-shelf]'))");
        await navigate('/project/synthetic-c'); await until("document.querySelector('[data-project]')?.getAttribute('data-project') === 'synthetic-c'");
        assert.deepEqual(await evaluate('globalThis.__PROJECT_ROUTE_EVALUATIONS__'), evaluations); checks.cachedReopen = true; assert.deepEqual(errors, []);
        await navigate('/settings'); await until("document.querySelector('[data-leaf]')?.getAttribute('data-leaf') === 'settings'");
        assert.equal(await evaluate("document.querySelector('[data-project]') === null"), true); checks.standaloneSettings = true;
      }
      return { browser: await client.Browser.getVersion(), source: { commit: current ? sourceCommit : base, fingerprint: fingerprint(directory) }, chunks, initial, initialJsBytes: chunks.filter(chunk => chunk.initial).reduce((sum, chunk) => sum + chunk.bytes, 0), checks, failures };
    } finally {
      if (client) await client.close();
      if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); } }
      if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    }
  }
  try {
    Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000' });
    git('worktree', 'add', '--detach', baseline, base); added = true;
    cpSync(path.join(root, 'scripts/renderer-project-routes.tsx'), path.join(baseline, 'scripts/renderer-project-routes.tsx')); symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const before = await measure(baseline, 'before'); const after = await measure(root, 'after'); assert.equal(fingerprint(root), sourceFingerprint, 'Source changed during acceptance.');
    const report = { kind: 'renderer_deferred_project_routes', status: 'passed', generatedAt: new Date().toISOString(), before, after,
      acceptance: { productionModuleLoading: 'passed', syntheticRouteOwnership: 'passed', nativeOrDevice: 'not-run', wholeAppStartup: 'not-measured', fixedDeviceBudgets: 'not-measured' },
      limitations: ['Actual production imports/configuration are retained with evaluation counters. A test-only bootstrap renders real AppRoutes with synthetic shelf/workspace/editor leaves, without native bootstrap, author data or accounts. This is route ownership and resource-loading evidence, not complete workspace correctness.', 'Initial JS bytes are the uncompressed static dependency closure of equivalently instrumented builds. Requests, parse events and evaluations are measured separately. No native startup, input-to-paint, heap or fixed-device budget is claimed.', 'Shared JS and CSS failures happen before any workspace mounts. Explicit Retry reloads the current document and URL to clear browser module/dependency failures. Ready code stays cached for the renderer lifetime; nested navigation does not reload or replace the synthetic parent draft DOM.', 'Simulator, native window, physical input, real workspace recovery and full-app manual acceptance were intentionally not run under the maintainer instruction.'] };
    validateProjectRoutes(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ output, checks: Object.keys(after.checks).length, initialJsBytes: [before.initialJsBytes, after.initialJsBytes], source: after.source }));
  } finally { if (added) git('worktree', 'remove', '--force', baseline); rmSync(temporary, { recursive: true, force: true }); }
}
