import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import CDP from 'chrome-remote-interface';
import { closeHeadlessSession, launchHeadlessBrowser } from './renderer-headless-browser.mjs';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const localeEvidence = JSON.parse(readFileSync('docs/qa/interface-locales.json', 'utf8'));
const files = [...localeEvidence.sources, 'scripts/interface-locales-ui.tsx', 'scripts/interface-locales-ui.html', 'scripts/run-interface-locales.mjs'];
const fingerprint = () => { const h = createHash('sha256'); for (const file of files) h.update(file).update(readFileSync(file)); return h.digest('hex'); };
const output = 'docs/qa/interface-locales-browser.json';
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.sourceSha256, fingerprint()); assert.equal(report.status, 'passed');
  assert.equal(report.samples.length, localeEvidence.locales.length * 2);
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-ui-locales-'));
  let browser, client, server;
  try {
    const before = fingerprint(), outDir = path.join(temporary, 'dist');
    await build({ root, configFile: false, envDir: false, logLevel: 'warn', plugins: [{ name: 'locale-fixture-preload', enforce: 'pre', transform(_code, id) {
      // Shelf menu locale controls do not activate project-settings preloading.
      if (id.endsWith('/features/settings/useSettingsPanels.ts')) return 'export const useSettingsPreloadIntent = () => ({});';
    } }, react()],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_LOCAL_ONLY_MODE': '"true"' },
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'scripts/interface-locales-ui.html') } } });
    server = await preview({ root, configFile: false, envDir: false, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const errors = [], samples = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const settle = () => evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const ready = () => evaluate(`new Promise((resolve,reject)=>{let tries=0; const poll=()=>{if(window.__INTERFACE_LOCALES__?.ready()) resolve(true);else if(++tries>200)reject(new Error('Fixture timeout'));else setTimeout(poll,50)};poll()})`);
    for (const width of [1280, 800]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 850, deviceScaleFactor: 1, mobile: false });
      const loaded = client.Page.loadEventFired();
      await client.Page.navigate({ url: server.resolvedUrls.local[0] + 'scripts/interface-locales-ui.html' }); await loaded; await ready();
      for (const locale of localeEvidence.locales) {
        const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8'));
        await evaluate(`document.querySelector('#language .ui-select').click()`); await settle();
        const menu = await evaluate(`({options:document.querySelectorAll('[role=option]').length,portal:document.querySelector('[role=listbox]')?.parentElement===document.body,fixed:getComputedStyle(document.querySelector('[role=listbox]')).position})`);
        assert.equal(menu.options, 9); assert(menu.portal); assert.equal(menu.fixed, 'fixed');
        await evaluate(`document.querySelector('[role=listbox] input').value=''`);
        // Native names are the option labels; the selected item uses the canonical code in the fixture API.
        const index = localeEvidence.locales.indexOf(locale);
        await evaluate(`document.querySelectorAll('[role=option]')[${index}].click()`); await settle();
        const sample = await evaluate(`({ locale:__INTERFACE_LOCALES__.locale(),language:__INTERFACE_LOCALES__.language(),lang:document.documentElement.lang,title:document.querySelector('#sample h2').textContent,prose:document.querySelector('#synthetic-prose').value,overflow:document.documentElement.scrollWidth>innerWidth,headingFont:getComputedStyle(document.querySelector('#sample h2')).fontFamily })`);
        assert.equal(sample.locale, locale); assert.equal(sample.language, locale); assert.equal(sample.lang, locale);
        assert.equal(sample.title, catalog.manuscriptExport.title); assert(!sample.overflow);
        assert.equal(sample.prose, 'Synthetic Ω 雨. This draft must survive a language change.');
        const reload = client.Page.loadEventFired(); await client.Page.reload(); await reload; await ready(); await settle();
        assert.equal(await evaluate('__INTERFACE_LOCALES__.locale()'), locale);
        // Check the real account-menu picker too, including its nested body portal.
        await evaluate("document.querySelector('#account-trigger').click()"); await settle();
        await evaluate("document.querySelector('.user-menu .ui-select').click()"); await settle();
        assert.equal(await evaluate("document.querySelectorAll('[role=option]').length"), 9);
        await evaluate(`document.querySelectorAll('[role=option]')[${index}].click()`); await settle();
        await evaluate("document.querySelector('#account-trigger').click()"); await settle();
        samples.push({ width, ...sample, portal: menu.portal, fixed: menu.fixed, restart: 'passed', accountMenu: 'passed' });
        if (width === 800 && ['ja', 'ko', 'de', 'zh-TW'].includes(locale)) {
          mkdirSync('.qa', { recursive: true }); writeFileSync(`.qa/interface-locales-${locale}.png`, Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
        }
      }
    }
    assert.deepEqual(errors, []); assert.equal(fingerprint(), before);
    writeFileSync(output, JSON.stringify({ kind: 'nine-language-interface-browser', status: 'passed', sourceSha256: before, samples, errors,
      limitations: ['Production React/CSS in Chromium using synthetic text. Native WKWebView and native-speaker review are separate.'] }, null, 2) + '\n');
    console.log(`Passed ${samples.length} real-control language/reload samples.`);
  } finally { await closeHeadlessSession({ client, browser, server }); }
}
