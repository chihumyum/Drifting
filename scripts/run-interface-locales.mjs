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
const files = [...localeEvidence.sources, 'scripts/interface-locales-ui.tsx', 'scripts/interface-locales-ui.html', 'scripts/run-interface-locales.mjs',
  'src/styles/index.css', 'src/styles/ui-controls.css', 'src/styles/desktop-typography.css',
  'src/renderer/components/ui/GlassSelect.tsx', 'src/renderer/components/ui/AnchoredPopover.tsx',
  'src/renderer/components/ui/anchored-popover-stack.ts'];
const fingerprint = () => { const h = createHash('sha256'); for (const file of files) h.update(file).update(readFileSync(file)); return h.digest('hex'); };
const output = 'docs/qa/interface-locales-browser.json';
const textSizes = ['smallest', 'small', 'standard', 'large', 'largest'];
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.sourceSha256, fingerprint()); assert.equal(report.status, 'passed');
  assert.equal(report.samples.length, localeEvidence.locales.length * 2);
  assert.equal(report.accountMenuLayouts.length, localeEvidence.locales.length * 2 * textSizes.length);
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
    const errors = [], samples = [], accountMenuLayouts = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const pointerClick = async (selector, index = 0) => {
      const point = await evaluate(`(()=>{
        const element=document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        element.scrollIntoView({block:'nearest'});
        const box=element.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};
      })()`);
      await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
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
        await pointerClick('#account-trigger'); await settle();
        for (const textSize of textSizes) {
          await evaluate(`document.documentElement.dataset.interfaceTextSize=${JSON.stringify(textSize)}`); await settle();
          const layout = await evaluate(`(()=>{
            const select=document.querySelector('.user-menu .ui-select');
            const row=select.closest('.user-menu__item'), label=row.children[1], value=select.querySelector('.ui-select__value');
            const range=document.createRange(); range.selectNodeContents(label);
            const lines=new Set([...range.getClientRects()].map(rect=>Math.round(rect.top))).size;
            const themeLabel=document.querySelector('.user-menu__item--static').children[1];
            const themeRange=document.createRange();themeRange.selectNodeContents(themeLabel);
            const themeLines=new Set([...themeRange.getClientRects()].map(rect=>Math.round(rect.top))).size;
            const menu=document.querySelector('.user-menu').getBoundingClientRect();
            const labelBounds=label.getBoundingClientRect(), selectBounds=select.getBoundingClientRect();
            return {label:label.textContent,lines,themeLines,labelWidth:labelBounds.width,selectWidth:selectBounds.width,
              valueClipped:value.scrollWidth>value.clientWidth+1,overlap:labelBounds.right>selectBounds.left,
              menuInViewport:menu.left>=0&&menu.right<=innerWidth,rowHeight:row.getBoundingClientRect().height};
          })()`);
          if (layout.lines !== 1 || layout.valueClipped || layout.overlap) {
            mkdirSync('.qa', { recursive: true }); writeFileSync('.qa/interface-locales-menu-failure.png', Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
          }
          assert.equal(layout.lines, 1, `${locale}/${textSize}: account language label wraps: ${JSON.stringify(layout)}`);
          assert.equal(layout.themeLines, 1, `${locale}/${textSize}: account theme label wraps`);
          assert(!layout.valueClipped, `${locale}/${textSize}: selected language is clipped`);
          assert(!layout.overlap && layout.menuInViewport, `${locale}/${textSize}: account language control overflows`);
          accountMenuLayouts.push({width,locale,textSize,...layout});
          if (width === 800 && ['en', 'pt-BR'].includes(locale) && ['standard', 'largest'].includes(textSize)) {
            mkdirSync('.qa', { recursive: true }); writeFileSync(`.qa/interface-locales-menu-${locale}-${textSize}.png`, Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
          }
        }
        await evaluate("document.documentElement.dataset.interfaceTextSize='standard'"); await settle();
        await pointerClick('.user-menu .ui-select'); await settle();
        assert.equal(await evaluate("document.querySelectorAll('[role=option]').length"), 9);
        await pointerClick('[role=option]', index); await settle();
        assert.equal(await evaluate('__INTERFACE_LOCALES__.locale()'), locale);
        assert(await evaluate("!!document.querySelector('.user-menu')"), 'The account menu must survive selecting its nested language option');
        await pointerClick('#account-trigger'); await settle();
        samples.push({ width, ...sample, portal: menu.portal, fixed: menu.fixed, restart: 'passed', accountMenu: 'passed' });
        if (width === 800 && ['ja', 'ko', 'de', 'zh-TW'].includes(locale)) {
          mkdirSync('.qa', { recursive: true }); writeFileSync(`.qa/interface-locales-${locale}.png`, Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
        }
      }
    }
    assert.deepEqual(errors, []); assert.equal(fingerprint(), before);
    writeFileSync(output, JSON.stringify({ kind: 'nine-language-interface-browser', status: 'passed', sourceSha256: before, samples, accountMenuLayouts, errors,
      limitations: ['Production React/CSS in Chromium using synthetic text. Native WKWebView and native-speaker review are separate.'] }, null, 2) + '\n');
    console.log(`Passed ${samples.length} real-control language/reload samples.`);
  } finally { await closeHeadlessSession({ client, browser, server }); }
}
