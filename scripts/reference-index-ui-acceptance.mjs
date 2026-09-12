import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';

export async function runReferenceIndexUiAcceptance(root) {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].find(existsSync);
  if (!chrome) throw new Error('Set DRIFTING_PERF_CHROME to an installed Chromium executable.');
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-reference-ui-'));
  const outDir = path.join(temporary, 'dist');
  const profile = path.join(temporary, 'profile');
  let server;
  let browser;
  let client;
  try {
    await build({
      root, configFile: false, envDir: false, logLevel: 'warn',
      plugins: [{
        name: 'isolated-reference-status-seam',
        enforce: 'pre',
        resolveId(source, importer) {
          if (importer?.endsWith('/components/editor/ReferenceIndexNotice.tsx') && source === '../../services/reference-index.service') {
            return path.join(root, 'scripts/reference-index-ui-service.ts');
          }
        },
      }, react()],
      resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] },
      build: { target: 'esnext', outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/reference-index-ui.html') } },
    });
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
    let launchError;
    browser.on('error', (error) => { launchError = error; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 200 && !existsSync(portFile); attempt += 1) {
      if (launchError || browser.exitCode !== null) throw new Error('Isolated Chromium did not start.');
      await delay(100);
    }
    if (!existsSync(portFile)) throw new Error('Chromium debugging endpoint timed out.');
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    client = await CDP({ port, target: await CDP.New({ port }) });
    await client.Page.enable();
    await client.Runtime.enable();
    const pageErrors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => pageErrors.push(exceptionDetails.text));
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: `${server.resolvedUrls.local[0]}scripts/reference-index-ui.html` });
    await loaded;
    const evaluate = async (expression) => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails || pageErrors.length) throw new Error(`Reference UI failed: ${JSON.stringify(result.exceptionDetails ?? pageErrors)}`);
      return result.result.value;
    };
    const behavior = await evaluate('window.__REFERENCE_INDEX_UI__.run()');
    const layouts = [];
    const screenshots = path.join(root, '.local-data/renderer-performance');
    mkdirSync(screenshots, { recursive: true });
    for (const [width, language, dark] of [[375, 'zh-CN', false], [375, 'en', true], [1280, 'zh-CN', false]]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 400, deviceScaleFactor: 1, mobile: false });
      layouts.push(await evaluate(`window.__REFERENCE_INDEX_UI__.show(${JSON.stringify(language)}, ${dark})`));
      const screenshot = await client.Page.captureScreenshot({ format: 'png' });
      writeFileSync(path.join(screenshots, `f6a3-reference-notice-${width}-${language}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    return { browser: (await client.Browser.getVersion()).product, mode: 'production React profiling renderer; fixture status seam; actual notice/styles/locales', ...behavior, layouts };
  } finally {
    if (client) await client.close();
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      for (let attempt = 0; attempt < 30 && browser.exitCode === null; attempt += 1) await delay(100);
      if (browser.exitCode === null) {
        browser.kill('SIGKILL');
        await new Promise((resolve) => browser.once('exit', resolve));
      }
    }
    if (server) await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
}
