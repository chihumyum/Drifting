import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { closeHeadlessSession, launchHeadlessBrowser } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/qa/interface-text-sizes.json');
const sources = [
  'scripts/run-interface-text-sizes.mjs', 'scripts/interface-text-sizes-ui.html', 'scripts/interface-text-sizes-ui.tsx',
  'src/renderer/lib/interface-typography.ts', 'src/renderer/store/settings-store.ts',
  'src/renderer/store/settings-store-appearance.test.ts',
  'src/renderer/features/settings/panels/BasicPreferencePanels.tsx', 'src/renderer/features/settings/SettingsPrimitives.tsx',
  'src/renderer/components/ui/GlassSlider.tsx', 'src/renderer/components/ui/ContextMenuSurface.tsx',
  'src/styles/desktop-typography.css', 'src/styles/settings.css', 'src/styles/ui-controls.css',
  'src/styles/index.css', 'src/styles/interface-fonts.css',
  'src/renderer/locales/zh-CN.json', 'src/renderer/locales/en.json',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const source of sources) hash.update(source).update(readFileSync(path.join(root, source)));
  return hash.digest('hex');
};
function validate(report) {
  assert.equal(report.kind, 'interface-text-sizes');
  assert.equal(report.fingerprint, fingerprint(), 'Interface text size evidence is stale.');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.runs.map(run => run.viewport), [[1280, 800], [800, 800]]);
  for (const run of report.runs) {
    assert.equal(run.status, 'passed', JSON.stringify(run.samples.filter(sample => Object.values(sample.checks).some(value => !value))));
    assert.equal(run.samples.length, 20);
    for (const locale of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
      for (const size of ['smallest', 'small', 'standard', 'large', 'largest']) {
        const sample = run.samples.find(item => item.locale === locale && item.theme === theme && item.size === size);
        assert(sample);
        assert.equal(Object.keys(sample.checks).length, 11);
        assert(Object.values(sample.checks).every(value => value === true));
      }
    }
    assert(run.mobileFallback && run.mobileProse);
    assert.deepEqual(run.reloaded, { size: 'largest', selected: 'largest', prose: 21 });
  }
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-text-sizes-'));
  let browser, client, server;
  try {
    const before = fingerprint();
    const outDir = path.join(temporary, 'dist');
    await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [react()],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_LOCAL_ONLY_MODE': '"true"' },
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/interface-text-sizes-ui.html') } } });
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const errors = [], runs = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const ready = () => evaluate(`new Promise((resolve, reject) => { let tries = 0; const check = () => {
      if (window.__INTERFACE_TEXT_SIZES__?.ready()) requestAnimationFrame(() => requestAnimationFrame(resolve));
      else if (++tries > 200) reject(new Error('Fixture not ready')); else setTimeout(check, 50);
    }; check(); })`);
    for (const width of [1280, 800]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile: false });
      const loaded = client.Page.loadEventFired();
      await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/interface-text-sizes-ui.html' }); await loaded; await ready();
      const run = await evaluate('window.__INTERFACE_TEXT_SIZES__.run()');
      mkdirSync(path.join(root, '.qa'), { recursive: true });
      writeFileSync(path.join(root, `.qa/interface-text-sizes-${width}.png`), Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
      const reloaded = client.Page.loadEventFired(); await client.Page.reload(); await reloaded; await ready();
      run.reloaded = await evaluate('window.__INTERFACE_TEXT_SIZES__.restored()');
      runs.push(run);
    }
    assert.equal(fingerprint(), before, 'Sources changed during acceptance.');
    const report = { kind: 'interface-text-sizes', fingerprint: before, sources, runs, errors };
    validate(report);
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  } finally {
    await closeHeadlessSession({ client, browser, server });
    rmSync(temporary, { recursive: true, force: true });
  }
}
console.log('Interface text sizes: 40 browser combinations and both reloads passed.');
