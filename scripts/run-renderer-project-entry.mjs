import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import CDP from 'chrome-remote-interface';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = 'docs/renderer-performance/acceptance/project-entry.json';
const files = [
  'src/renderer/app/useProjectRoutePreload.ts', 'src/renderer/app/project-route-module.ts',
  'src/renderer/app/project-route-components.tsx', 'src/renderer/app/DeferredProjectRoute.tsx',
  'src/renderer/app/components/FullScreenStatus.tsx', 'src/renderer/app/AppRoutes.tsx',
  'src/renderer/app/providers/ProjectRuntimeProvider.tsx', 'src/renderer/views/ProjectPickerView.tsx',
  'src/renderer/lib/deferred-module.ts', 'src/renderer/lib/deferred-preloader.ts',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json', 'src/styles/desktop-shell.css',
  'vite.renderer.config.ts', 'package.json', 'pnpm-lock.yaml',
  'scripts/renderer-project-entry.tsx', 'scripts/run-renderer-project-entry.mjs',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(readFileSync(file));
  return hash.digest('hex');
};
const expectedChecks = ['preloadWithoutMount', 'sharedLoad', 'cachedReopen', 'spinner', 'translated', 'reducedMotion', 'loadingBack', 'lateOwner', 'failureRetry', 'unknownRoute'];
function validate(report) {
  assert.equal(report.kind, 'renderer_project_entry');
  assert.equal(report.status, 'passed');
  assert.equal(report.source.fingerprint, fingerprint(), 'Project entry evidence is stale.');
  assert.deepEqual(Object.keys(report.checks).sort(), [...expectedChecks].sort());
  for (const key of expectedChecks) assert.equal(report.checks[key], true, key);
  assert.deepEqual(report.samples.map(sample => sample.mode), ['cold', 'server-warmup', 'shelf-preload']);
  for (const sample of report.samples) {
    for (const key of ['shelfMs', 'clickToMountedPaintMs']) assert(Number.isFinite(sample[key]) && sample[key] >= 0);
    assert.equal(sample.mountsBeforeClick, 0);
  }
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Project entry browser evidence passed. Native database and full-app timings are not measured.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  assert(chrome, 'Chrome is required');
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-entry-'));
  const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fingerprint: fingerprint() };
  const checks = {}, samples = [];
  let browserVersion;
  Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000' });
  async function measure(mode) {
    let server, browser, client;
    try {
      console.log(`Measuring ${mode}`);
      server = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false,
        cacheDir: path.join(temporary, `${mode}-vite`), logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false },
        plugins: [{ name: 'project-entry-observer', enforce: 'pre',
          configResolved(config) {
            if (mode === 'cold') config.environments.client.dev.warmup = [];
          },
          transform(code, id) {
            if (id === path.join(root, 'src/renderer/main.tsx')) {
              assert(code.includes('void bootstrap();'));
              return `import { bootstrapProjectEntryProbe } from '/scripts/renderer-project-entry.tsx';\n${code.replace('void bootstrap();', 'bootstrapProjectEntryProbe();')}`;
            }
            if (id === path.join(root, 'src/renderer/views/ProjectPickerView.tsx')) {
              const anchor = "export function ProjectPickerView({ presentation = 'desktop' }: ProjectPickerViewProps) {";
              assert(code.includes(anchor));
              return code.replace(anchor, `${anchor}\nif (globalThis.__PROJECT_ENTRY_PROBE__) return globalThis.__PROJECT_ENTRY_PROBE__.shelf();`);
            }
            if (id === path.join(root, 'src/renderer/app/project-route-components.tsx')) {
              return `${code}\nObject.assign(projectRoutes, globalThis.__PROJECT_ENTRY_PROBE__.routes);`;
            }
          },
        }],
      });
      await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
      const profile = path.join(temporary, `${mode}-chrome`);
      browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
      const portFile = path.join(profile, 'DevToolsActivePort');
      for (let i = 0; i < 200 && !existsSync(portFile); i++) { assert.equal(browser.exitCode, null); await delay(100); }
      assert(existsSync(portFile));
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      client = await CDP({ port, target: await CDP.New({ port }) });
      await client.Page.enable(); await client.Runtime.enable(); await client.Network.enable();
      await client.Network.setCacheDisabled({ cacheDisabled: true });
      await client.Emulation.setDeviceMetricsOverride({ width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      browserVersion = (await client.Browser.getVersion()).product;
      const errors = [];
      let routeRequests = 0;
      client.Network.requestWillBeSent(({ request }) => {
        if (new URL(request.url).pathname === '/src/renderer/app/project-route-components.tsx') routeRequests++;
      });
      client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
      async function evaluate(expression) {
        const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      async function until(expression) {
        for (let i = 0; i < 1500; i++) {
          assert.deepEqual(errors, []);
          const value = await evaluate(`Boolean(${expression})`); if (value) return value;
          await delay(20);
        }
        throw new Error(`Browser condition timed out: ${expression}`);
      }
      const fresh = async preload => {
        await client.Page.navigate({ url: `${origin}?preload=${preload ? 1 : 0}#/` });
        await until('globalThis.__PROJECT_ENTRY_PROBE__?.observations.shelfAt');
      };
      const preloading = mode === 'shelf-preload';
      await fresh(preloading);
      const shelfMs = await evaluate('globalThis.__PROJECT_ENTRY_PROBE__.observations.shelfAt');
      // Same reading/selection time in each scenario. Do not wait for preload
      // completion before clicking: the remaining work stays in the sample.
      await delay(1500);
      const beforeClick = await evaluate('({ ...globalThis.__PROJECT_ENTRY_PROBE__.observations, state: globalThis.__PROJECT_ENTRY_PROBE__.state() })');
      assert.equal(beforeClick.mounts, 0);
      assert.equal(routeRequests, preloading ? 1 : 0, 'Only the shelf preload may request route code before a click.');
      await evaluate("document.querySelector('[data-shelf] button').click()");
      await until("document.querySelector('[data-project]')?.getAttribute('data-project') === 'synthetic-a'");
      const clickToMountedPaintMs = await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - globalThis.__PROJECT_ENTRY_PROBE__.observations.openedAt))))');
      samples.push({ mode, shelfMs, selectionDwellMs: 1500, stateBeforeClick: beforeClick.state, mountsBeforeClick: beforeClick.mounts, clickToMountedPaintMs });
      if (preloading) {
        assert.equal(await evaluate('globalThis.__PROJECT_ENTRY_PROBE__.observations.mounts'), 1);
        assert.equal(routeRequests, 1, 'Click must share the preload, not fetch the route again.');
        const readyAt = await evaluate('globalThis.__PROJECT_ENTRY_PROBE__.observations.readyAt');
        checks.preloadWithoutMount = true;
        checks.sharedLoad = true;
        await evaluate("location.hash = '/'"); await until("document.querySelector('[data-shelf]')");
        await evaluate("document.querySelector('[data-shelf] button').click()");
        await until("document.querySelector('[data-project]')");
        assert.equal(await evaluate('globalThis.__PROJECT_ENTRY_PROBE__.observations.readyAt'), readyAt);
        assert.equal(routeRequests, 1);
        checks.cachedReopen = true;

        // Hold the real route module to inspect the actual fallback and back
        // navigation, including a different project becoming the final owner.
        await client.Page.navigate({ url: 'about:blank' });
        let held, fail = false;
        client.Fetch.requestPaused(async event => {
          if (fail) await client.Fetch.failRequest({ requestId: event.requestId, errorReason: 'Failed' });
          else held = event;
        });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/src/renderer/app/project-route-components.tsx', requestStage: 'Request' }] });
        await fresh(false);
        await evaluate("document.querySelector('[data-shelf] button').click()");
        await until("document.querySelector('.app-fullscreen-status__spinner')");
        for (let i = 0; i < 200 && !held; i++) await delay(20);
        assert(held);
        checks.spinner = await evaluate("getComputedStyle(document.querySelector('.app-fullscreen-status__spinner')).animationName === 'workspace-loading' && !document.querySelector('[role=progressbar]')");
        checks.translated = await evaluate("document.querySelector('[role=status]').textContent.includes('正在准备工作区') && !document.body.textContent.includes('common.loading')");
        const screenshotDir = path.join(root, '.qa/project-entry'); mkdirSync(screenshotDir, { recursive: true });
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
          await delay(80);
          writeFileSync(path.join(screenshotDir, `${theme}.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        }
        await evaluate("import('/src/renderer/lib/i18n.ts').then(m => m.i18next.changeLanguage('en'))");
        await until("document.querySelector('[role=status]').textContent.includes('Preparing your workspace')");
        await client.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        checks.reducedMotion = await evaluate("getComputedStyle(document.querySelector('.app-fullscreen-status__spinner')).animationName === 'none'");
        await evaluate("document.querySelector('[role=status] button').click()"); await until("document.querySelector('[data-shelf]')");
        checks.loadingBack = true;
        await evaluate("location.hash = '/project/synthetic-b'");
        await client.Fetch.continueRequest({ requestId: held.requestId }); await client.Fetch.disable();
        await until("document.querySelector('[data-project]')?.getAttribute('data-project') === 'synthetic-b'");
        checks.lateOwner = true;
        // Demand failure still offers explicit retry; a prewarm never removes
        // recovery controls or mounts a half-loaded project.
        await client.Page.navigate({ url: 'about:blank' }); fail = true;
        await client.Fetch.enable({ patterns: [{ urlPattern: '*/src/renderer/app/project-route-components.tsx', requestStage: 'Request' }] });
        await fresh(false); await evaluate("document.querySelector('[data-shelf] button').click()");
        await until("document.querySelector('[role=alert]')");
        assert.equal(await evaluate('globalThis.__PROJECT_ENTRY_PROBE__.observations.mounts'), 0);
        assert.equal(await evaluate("Boolean(document.querySelector('.app-fullscreen-status__spinner'))"), false);
        await client.Fetch.disable();
        await evaluate("document.querySelector('[role=alert] .set-btn--primary').click()");
        await until("document.querySelector('[data-project]')");
        checks.failureRetry = true;
        await evaluate("location.hash = '/synthetic-missing-route'");
        await until("location.hash === '#/' && document.querySelector('[data-shelf]')");
        checks.unknownRoute = true;
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify(samples.at(-1)));
    } finally {
      if (client) await client.close();
      if (browser && browser.exitCode === null) {
        browser.kill('SIGTERM');
        for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100);
        if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); }
      }
      if (server) await server.close();
    }
  }
  try {
    for (const mode of ['cold', 'server-warmup', 'shelf-preload']) await measure(mode);
    const report = { kind: 'renderer_project_entry', status: 'passed', generatedAt: new Date().toISOString(), source, browser: browserVersion, samples, checks,
      limitations: ['One development-server observation per scenario, with separate fresh Vite/browser caches and identical 1500 ms shelf dwell. Timing samples are diagnostic, not fixed-device budgets or statistical estimates.', 'Real renderer imports and styles, real AppRoutes/loading/preload hook; synthetic shelf and workspace leaves. No native database, actual project, account or complete editor startup is measured.', 'Fingerprint covers the entry implementation, locales, styles, build configuration, dependencies and this observer. Historical production route evidence remains separate.'] };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, checks }));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
