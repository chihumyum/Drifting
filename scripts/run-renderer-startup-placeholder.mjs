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

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = 'docs/renderer-performance/acceptance/startup-placeholder.json';
const inputs = ['index.html', 'public/startup.js', 'src/renderer/main.tsx',
  'src/renderer/lib/initial-theme.ts', 'src/renderer/platform/runtime.ts', 'src/styles/index.css',
  'src/renderer/components/ui/LoadingStatus.tsx', 'src/styles/loading-status.css',
  'src/renderer/components/editor/EditorMainArea.tsx', 'src/renderer/components/editor/ChapterEditor.tsx',
  'src/renderer/views/NodeEditorView.tsx', 'src/renderer/views/ProjectPickerView.tsx',
  'src/renderer/shells/mobile/standalone/MobileProjectShelfContent.tsx',
  'src/renderer/shells/desktop/views/DeferredSuperViews.tsx', 'src/renderer/app/AppRoutes.tsx',
  'src-tauri/tauri.conf.json', 'vite.renderer.config.ts', 'package.json', 'pnpm-lock.yaml',
  'scripts/run-renderer-startup-placeholder.mjs'];
const fingerprint = () => createHash('sha256').update(inputs.map(file => `${file}\0${readFileSync(file)}`).join('\0')).digest('hex');
const cases = [
  { name: 'default', systemDark: true, scheme: 'light' },
  { name: 'saved-dark', settings: { themeMode: 'dark', uiLocale: 'en' }, scheme: 'dark' },
  { name: 'system-dark', settings: { themeMode: 'system' }, systemDark: true, scheme: 'dark' },
  { name: 'system-light', settings: { themeMode: 'system' }, scheme: 'light' },
  { name: 'corrupt-storage', corrupt: true, systemDark: true, scheme: 'light' },
  { name: 'blocked-storage', blocked: true, systemDark: true, scheme: 'light' },
  { name: 'reduced-motion', settings: { themeMode: 'light', uiLocale: 'en' }, reduced: true, scheme: 'light' },
];
const checks = ['visibleWithoutScripts', 'themeAndLocale', 'reducedMotion', 'heldThroughBootstrap', 'replacedByReact', 'localLoading'];
function validate(report) {
  assert.equal(report.kind, 'renderer_startup_placeholder');
  assert.equal(report.status, 'passed');
  assert.equal(report.source.fingerprint, fingerprint(), 'Startup placeholder evidence is stale.');
  assert.deepEqual(report.runs.map(run => `${run.mode}/${run.name}`).sort(),
    ['development', 'production'].flatMap(mode => cases.map(test => `${mode}/${test.name}`)).sort());
  for (const run of report.runs) for (const check of checks) assert.equal(run.checks[check], true, `${run.mode}/${run.name}/${check}`);
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Startup placeholder browser evidence passed.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  assert(chrome, 'Chrome is required');
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-startup-placeholder-'));
  const source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fingerprint: fingerprint() };
  const runs = [];
  let server, browser, client, entry;
  const observation = {
    name: 'startup-placeholder-observer', enforce: 'pre',
    transform(code, id) {
      // Keep the real entry, stylesheet imports and createRoot lifecycle. Only
      // the mounted App is synthetic, so no database or author account opens.
      if (id === path.join(root, 'src/renderer/App.tsx')) return `
        import { useState } from 'react';
        import { LoadingStatus } from './components/ui/LoadingStatus';
        export default function App() {
          const [ready, setReady] = useState(false);
          return <main data-react-mounted>{ready ? <div data-startup-ready>Ready</div>
            : <LoadingStatus label="Loading synthetic content" />}
            <button onClick={() => setReady(true)}>Finish synthetic loading</button></main>;
        }`;
      if (id === path.join(root, 'src/renderer/main.tsx')) {
        const anchor = 'await hydratePlatformRuntime();'; assert(code.includes(anchor));
        return code.replace(anchor, 'await new Promise(resolve => { window.__STARTUP_RESUME__ = resolve; });\n' + anchor);
      }
    },
    generateBundle(_options, bundle) {
      entry = Object.values(bundle).find(chunk => chunk.type === 'chunk' && chunk.facadeModuleId === path.join(root, 'index.html'))?.fileName;
    },
  };
  Object.assign(process.env, { VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct', VITE_API_BASE_URL: 'http://localhost:3000' });
  try {
    const outDir = path.join(temporary, 'production');
    await build({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false,
      logLevel: 'error', plugins: [observation], build: { outDir, emptyOutDir: true } });
    assert(entry); assert(existsSync(path.join(outDir, 'startup.js')));
    const profile = path.join(temporary, 'chrome');
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++) { assert.equal(browser.exitCode, null); await delay(100); }
    assert(existsSync(portFile)); const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    for (const mode of ['production', 'development']) {
      server = mode === 'production'
        ? await preview({ root, configFile: false, logLevel: 'error', build: { outDir }, preview: {
          host: '127.0.0.1', port: 0, open: false,
          headers: { 'Content-Security-Policy': JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp },
        } })
        : await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false,
          logLevel: 'error', cacheDir: path.join(temporary, 'vite'), plugins: [observation],
          server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false } });
      if (mode === 'development') await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}/`;
      for (const test of cases) {
        const target = await CDP.New({ port }); client = await CDP({ port, target });
        await client.Page.enable(); await client.Runtime.enable(); await client.Network.enable();
        await client.Network.setCacheDisabled({ cacheDisabled: true });
        await client.Emulation.setDeviceMetricsOverride({ width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
        await client.Emulation.setEmulatedMedia({ features: [
          { name: 'prefers-color-scheme', value: test.systemDark ? 'dark' : 'light' },
          { name: 'prefers-reduced-motion', value: test.reduced ? 'reduce' : 'no-preference' },
        ] });
        await client.Page.addScriptToEvaluateOnNewDocument({ source: `
          localStorage.clear();
          ${test.settings ? `localStorage.setItem('settings-storage', ${JSON.stringify(JSON.stringify({ state: test.settings }))});` : ''}
          ${test.corrupt ? "localStorage.setItem('settings-storage', '{broken');" : ''}
          ${test.blocked ? `const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
            Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Synthetic storage denial'); } });
            window.__RESTORE_STORAGE__ = () => Object.defineProperty(window, 'localStorage', descriptor);` : ''}
        ` });
        const errors = []; let heldStartup, heldEntry;
        client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
        await client.Fetch.enable({ patterns: [
          { urlPattern: '*/startup.js', requestStage: 'Request' },
          { urlPattern: `*/${mode === 'production' ? entry : 'src/renderer/main.tsx'}*`, requestStage: 'Request' },
        ] });
        client.Fetch.requestPaused(event => {
          if (new URL(event.request.url).pathname === '/startup.js') heldStartup = event.requestId;
          else heldEntry = event.requestId;
        });
        const evaluate = async expression => {
          const value = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
          assert(!value.exceptionDetails, JSON.stringify(value.exceptionDetails)); return value.result.value;
        };
        const until = async expression => {
          for (let i = 0; i < 1500; i++) { assert.deepEqual(errors, []); if (await evaluate(`Boolean(${expression})`)) return; await delay(20); }
          throw new Error(`Timed out: ${mode}/${test.name}/${expression}`);
        };
        await client.Page.navigate({ url: origin });
        await until("document.querySelector('#app-startup-loading > span')");
        const geometry = await evaluate(`(() => {
          const element = document.querySelector('#app-startup-loading > span');
          const rect = element.getBoundingClientRect();
          return { width: parseFloat(getComputedStyle(element).width), height: parseFloat(getComputedStyle(element).height),
            x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
            display: getComputedStyle(element.parentElement).display };
        })()`);
        assert.equal(geometry.width, 24); assert.equal(geometry.height, 24);
        assert(Math.abs(geometry.x - 500) < 1); assert(Math.abs(geometry.y - 350) < 1); assert.equal(geometry.display, 'grid');
        const screenshots = path.join(root, '.qa/startup-placeholder'); mkdirSync(screenshots, { recursive: true });
        if (test.name === 'default') writeFileSync(path.join(screenshots, `${mode}-before-scripts.png`),
          Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        const result = { visibleWithoutScripts: true };
        for (let i = 0; i < 200 && !heldStartup; i++) await delay(20); assert(heldStartup);
        await client.Fetch.continueRequest({ requestId: heldStartup });
        await until('document.documentElement.dataset.colorScheme');
        assert.equal(await evaluate('document.documentElement.dataset.colorScheme'), test.scheme);
        assert.equal(await evaluate("document.querySelector('#app-startup-loading').getAttribute('aria-label')"), test.settings?.uiLocale === 'en' ? 'Starting Drifting' : '正在启动 Drifting');
        const brightness = await evaluate("getComputedStyle(document.querySelector('#app-startup-loading')).backgroundColor.match(/\\d+/g).slice(0,3).map(Number).reduce((a,b) => a+b,0)");
        assert(test.scheme === 'dark' ? brightness < 150 : brightness > 700); result.themeAndLocale = true;
        assert.equal(await evaluate("getComputedStyle(document.querySelector('#app-startup-loading > span')).animationName"), test.reduced ? 'none' : 'app-startup-spin'); result.reducedMotion = true;
        writeFileSync(path.join(screenshots, `${mode}-${test.name}.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        for (let i = 0; i < 200 && !heldEntry; i++) await delay(20); assert(heldEntry);
        // Only storage access during the no-module placeholder phase is under test.
        await evaluate('window.__RESTORE_STORAGE__?.(); window.__startupNode = document.querySelector("#app-startup-loading"); true');
        await client.Fetch.continueRequest({ requestId: heldEntry });
        await until('window.__STARTUP_RESUME__');
        assert.equal(await evaluate('window.__startupNode === document.querySelector("#app-startup-loading")'), true); result.heldThroughBootstrap = true;
        await evaluate('window.__STARTUP_RESUME__(); true'); await until('document.querySelector("[data-react-mounted]")');
        assert.equal(await evaluate('document.querySelector("#app-startup-loading")'), null);
        assert.equal(await evaluate('document.documentElement.dataset.colorScheme'), test.scheme); result.replacedByReact = true;
        await until('document.querySelector("[role=status] .loading-status__spinner")');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".loading-status__spinner")).animationName'), test.reduced ? 'none' : 'loading-status-spin');
        assert.equal(await evaluate('getComputedStyle(document.querySelector(".loading-status__spinner")).width'), '24px');
        await evaluate('document.querySelector("[data-react-mounted] button").click()');
        await until('document.querySelector("[data-startup-ready]")');
        assert.equal(await evaluate('document.querySelector(".loading-status")'), null); result.localLoading = true;
        assert.deepEqual(errors, []); runs.push({ mode, name: test.name, checks: result });
        console.log(`${mode}/${test.name}: passed`);
        await client.close(); client = null; await CDP.Close({ port, id: target.id });
      }
      if (mode === 'development') await server.close();
      else await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
      server = null;
    }
    const report = { kind: 'renderer_startup_placeholder', status: 'passed', generatedAt: new Date().toISOString(), source, runs,
      limitations: ['Real HTML, classic startup script, main.tsx and React mount with a synthetic App. No author database or native window is opened.',
        'Production preview uses the configured production CSP. Tests cover HTML availability through React commit, not native window creation before HTML arrives or total app startup time.',
        'Blocked storage is restored before releasing the app module; the blocked-storage check covers only the standalone placeholder.'] };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(output);
  } finally {
    if (client) await client.close();
    if (server) { if (typeof server.close === 'function') await server.close(); else await new Promise(resolve => server.httpServer.close(resolve)); }
    if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100); if (browser.exitCode === null) { browser.kill('SIGKILL'); await new Promise(resolve => browser.once('exit', resolve)); } }
    rmSync(temporary, { recursive: true, force: true });
  }
}
