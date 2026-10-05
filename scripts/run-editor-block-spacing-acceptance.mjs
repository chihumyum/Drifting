import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { createServer } from 'vite';
import { launchHeadlessBrowser } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/block-spacing.json');
const inputs = [
  'scripts/run-editor-block-spacing-acceptance.mjs', 'scripts/renderer-headless-browser.mjs',
  'scripts/renderer-settings-ui.tsx', 'scripts/renderer-settings-ui.html',
  'src/renderer/lib/editor-preferences.ts', 'src/renderer/app/effects/AppEffects.tsx',
  'src/renderer/store/settings-store.ts', 'src/renderer/features/settings/SettingsSlider.tsx',
  'src/renderer/features/settings/settings-slider-value.ts',
  'src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
  'src/styles/index.css', 'src/styles/entity-editors.css', 'src/styles/settings.css',
  'src/styles/mobile-workspace.css', 'src/styles/mobile-settings.css',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of inputs) hash.update(file).update('\0').update(readFileSync(path.join(root, file)));
  return hash.digest('hex');
};
const before = fingerprint();
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, before, 'Regenerate editor block spacing evidence.');
  console.log('Editor block spacing evidence matches current source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-block-spacing-'));
  let server, browser, client;
  try {
    server = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'),
      envDir: false, logLevel: 'error', cacheDir: path.join(temporary, 'vite'),
      server: { host: '127.0.0.1', port: 0, hmr: false, open: false },
    });
    await server.listen();
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'chrome') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    await client.Page.addScriptToEvaluateOnNewDocument({ source: `
      if (!localStorage.getItem('settings-storage')) localStorage.setItem('settings-storage',
        JSON.stringify({ state: { uiLocale: 'zh-CN' }, version: 30 }));
    ` });
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 600; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(50); }
      throw new Error(`Timed out: ${expression}`);
    };
    const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const input = async (label, value, type = 'number') => {
      await evaluate(`{
        const el = document.querySelector('#editor input[type="${type}"][aria-label="${label}"]');
        if (!el) throw new Error('Missing input: ${label}');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '${value}');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }`);
      await settle();
    };
    const openSettings = async () => {
      await until('window.__SETTINGS_UI__ && document.querySelector("#open-settings")');
      await evaluate('__SETTINGS_UI__.modal(true)');
      await until('document.querySelector("#editor .set-preview h3")');
    };
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-settings-ui.html` });
    await openSettings();
    await evaluate(`(async () => {
      await import('/src/styles/entity-editors.css');
      await import('/src/styles/mobile-workspace.css');
      const fixture = document.createElement('div'); fixture.id = 'spacing-samples';
      fixture.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:800px;overflow:auto;background:white';
      const tags = ['p', 'h1', 'h2', 'h3'];
      const blocks = tags.flatMap(a => tags.flatMap(b => [a, b]))
        .map(tag => '<' + tag + '>示例 Sample</' + tag + '>').join('');
      fixture.innerHTML = ['page__body', 'elem-body', 'patch-card__body'].map(surface =>
        '<section class="' + surface + '"><div class="ProseMirror prose max-w-none focus:outline-none" data-surface="' + surface + '">' + blocks + '</div></section>'
      ).join('') + '<section class="all-chap-row page__body"><div class="ProseMirror prose" data-surface="all-chapters">' + blocks + '</div></section>';
      document.body.append(fixture);
      await document.fonts.ready;
    })()`);
    const samples = [];
    const measure = async (bodyFontSize, paragraphSpacing, layout) => {
      const measured = await evaluate(`Array.from(document.querySelectorAll('[data-surface], #editor .set-preview'), surface => {
        const name = surface.dataset.surface || 'settings-preview';
        const blocks = [...surface.children];
        return { surface: name, blocks: blocks.map((el, index) => {
          const css = getComputedStyle(el), next = blocks[index + 1];
          return { tag: el.tagName, top: parseFloat(css.marginTop), bottom: parseFloat(css.marginBottom),
            gap: next ? next.getBoundingClientRect().top - el.getBoundingClientRect().bottom : null,
            fontSize: parseFloat(css.fontSize) };
        }) };
      })`);
      const expected = bodyFontSize * paragraphSpacing;
      for (const surface of measured) for (const [index, block] of surface.blocks.entries()) {
        const last = index === surface.blocks.length - 1;
        const trimmed = last && ['patch-card__body', 'settings-preview'].includes(surface.surface);
        const context = `${layout}/${surface.surface}/${block.tag}/${bodyFontSize}/${paragraphSpacing}`;
        assert.equal(block.top, 0, context);
        assert(Math.abs(block.bottom - (trimmed ? 0 : expected)) < 0.02, context);
        if (block.gap !== null) assert(Math.abs(block.gap - expected) < 0.04, `${context}: measured gap ${block.gap}`);
      }
      const preview = measured.find(item => item.surface === 'settings-preview');
      assert.deepEqual(preview.blocks.filter(item => item.tag !== 'P').map(item => item.fontSize), [28, 22, 18]);
      const persisted = await evaluate('JSON.parse(localStorage.getItem("settings-storage")).state');
      assert.equal(persisted.bodyFontSize, bodyFontSize);
      assert.equal(persisted.paragraphSpacing, paragraphSpacing);
      samples.push({ layout, bodyFontSize, paragraphSpacing, gapPx: expected,
        surfaces: measured.map(item => item.surface), blockCount: measured.reduce((n, item) => n + item.blocks.length, 0) });
    };
    for (const layout of ['desktop', 'narrow']) {
      await client.Emulation.setDeviceMetricsOverride({ width: layout === 'desktop' ? 1280 : 390, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.querySelector('#spacing-samples').classList.toggle('m-workspace', ${layout === 'narrow'});
        document.querySelector('#spacing-samples').style.width = '${layout === 'desktop' ? 600 : 350}px'`);
      for (const bodyFontSize of [12, 17, 28]) {
        await input('字号 (px)', bodyFontSize);
        for (const paragraphSpacing of [0, 0.125, 1, 2.5]) {
          await input('段间距 (em)', paragraphSpacing);
          await measure(bodyFontSize, paragraphSpacing, layout);
        }
      }
    }
    await input('字号 (px)', 17);
    await input('段间距 (em)', 0.75, 'range');
    await measure(17, 0.75, 'slider');
    const reloaded = client.Page.loadEventFired();
    await client.Page.reload();
    await reloaded;
    await openSettings(); await settle();
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#editor .set-preview h1")).marginBottom'), '12.75px');
    await evaluate('[...document.querySelectorAll("#editor button")].find(el => el.textContent === "还原推荐样式").click()');
    await settle();
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#editor .set-preview h1")).marginBottom'), '17px');
    await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate('document.querySelector("#editor .set-preview").scrollIntoView({ block: "start" })');
    await settle();
    mkdirSync(path.join(root, '.qa'), { recursive: true });
    writeFileSync(path.join(root, '.qa/editor-block-spacing.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ kind: 'editor-block-spacing', status: 'passed',
      generatedAt: new Date().toISOString(), sourceSha256: before, inputs, samples,
      checks: { equalComputedMargins: true, equalMeasuredGaps: true, allBlockPairs: true,
        liveSettingsNumberAndSlider: true, fractionalAndZeroSpacing: true, settingsPreviewHeadings: true,
        reloadPersistence: true, recommendedStyleReset: true },
      boundary: 'Chromium, real Settings controls/store/preferences/styles and synthetic prose markup; desktop and narrow renderer geometry. No Tauri window, physical device, or prose editing interaction.',
    }, null, 2) + '\n');
    console.log(`Editor block spacing: ${samples.length} layout/settings samples passed, including actual block gaps, live controls, reload and reset.`);
  } finally {
    try { if (client) await client.close(); }
    finally {
      try { if (browser) await browser.close(); }
      finally { if (server) await server.close(); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
