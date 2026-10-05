import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { createServer } from 'vite';

// Renderer-only acceptance: real Settings controls/store/CSS with synthetic
// link markup and a disposable browser profile. Native Tauri is a separate gate.
const root = fileURLToPath(new URL('..', import.meta.url));
const inputs = ['src/styles/index.css', 'scripts/run-entity-link-highlight-acceptance.mjs'];
const fingerprint = () => createHash('sha256').update(inputs.map(file => readFileSync(path.join(root, file))).join('\0')).digest('hex');
const before = fingerprint();
const chrome = process.env.DRIFTING_PERF_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium',
].find(existsSync);
assert(chrome, 'Set DRIFTING_PERF_CHROME to Chromium.');
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-link-highlight-'));
let server, browser, client;
try {
  server = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'),
    envDir: false, logLevel: 'error', cacheDir: path.join(temporary, 'vite'),
    server: { host: '127.0.0.1', port: 0, hmr: false, open: false },
  });
  await server.listen();
  const profile = path.join(temporary, 'chrome');
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) { assert.equal(browser.exitCode, null); await delay(50); }
  assert(existsSync(portFile));
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  client = await CDP({ port, target: await CDP.New({ port }) });
  await client.Page.enable(); await client.Runtime.enable(); await client.DOM.enable(); await client.CSS.enable();
  await client.Page.addScriptToEvaluateOnNewDocument({ source: `
    if (!localStorage.getItem('settings-storage')) {
      localStorage.setItem('settings-storage', JSON.stringify({ state: { uiLocale: 'zh-CN' }, version: 30 }));
    }
  ` });
  const evaluate = async expression => {
    const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 600; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(50); }
    throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(0, 2000)')}`);
  };
  const click = label => evaluate(`[...document.querySelectorAll('#editor button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
  const persisted = () => evaluate("JSON.parse(localStorage.getItem('settings-storage')).state.entityLinkHighlightMode");
  const persistedBandStyle = () => evaluate("JSON.parse(localStorage.getItem('settings-storage')).state.entityLinkBandStyle");
  const highlight = async (mode, label) => {
    await click(label);
    await until(`document.documentElement.dataset.entityLinkHighlight === ${JSON.stringify(mode)}`);
    assert.equal(await persisted(), mode);
  };
  const colorMode = async (mode, label) => {
    await click(label);
    await until(`document.documentElement.dataset.entityLinkStyle === ${JSON.stringify(mode)}`);
  };
  const bandStyle = async (style, label) => {
    await click(label);
    await until(`document.documentElement.dataset.entityLinkBandStyle === ${JSON.stringify(style)}`);
    assert.equal(await persistedBandStyle(), style);
  };
  await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/renderer-settings-ui.html` });
  await until("window.__SETTINGS_UI__ && document.querySelector('#open-settings')");
  await evaluate('__SETTINGS_UI__.modal(true)');
  await until("[...document.querySelectorAll('#editor button')].some(b => b.textContent === '两者都有')");
  assert.equal(await evaluate('document.documentElement.dataset.entityLinkHighlight'), 'both');
  assert.equal(await evaluate('document.documentElement.dataset.entityLinkBandStyle'), 'wash');
  await evaluate(`{
    const sample = document.createElement('aside'); sample.id = 'link-samples';
    sample.style.cssText = 'position:fixed;top:0;left:0;color:rgb(30,40,50);background:white;z-index:2147483647;font-size:18px;line-height:2;max-width:620px;padding:16px';
    sample.innerHTML = ['element','node','patch','category','storyline'].map(kind =>
      '<span class="entity-link entity-link--' + kind + '" style="--entity-link-color:#aa5577">Synthetic ' + kind + '</span> '
    ).join('') + '<div style="width:150px">前文<span id="wrapped-link" class="entity-link" style="--entity-link-color:#aa5577">海边的纸灯照亮回程的小路，晚风吹动树梢。</span><span data-layout-tail>后文 AV office</span></div>'
      + '<div><strong><span class="entity-link entity-link--node" style="--entity-link-color:#aa5577">原有加粗 AV office</span></strong><span data-layout-tail> 后文</span></div>'
      + '<div><span class="entity-link entity-link--node" style="--entity-link-color:#aa5577"><strong>链接内加粗 AV office</strong></span><span data-layout-tail> 后文</span></div>';
    document.body.append(sample);
  }`);
  await evaluate('document.fonts.ready');
  const { root: dom } = await client.DOM.getDocument();
  const { nodeIds } = await client.DOM.querySelectorAll({ nodeId: dom.nodeId, selector: '#link-samples .entity-link' });
  const hover = async on => {
    for (const nodeId of nodeIds) await client.CSS.forcePseudoState({ nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
  };
  const styles = () => evaluate(`Array.from(document.querySelectorAll('#link-samples .entity-link'), el => {
    const css = getComputedStyle(el); return { color: css.color, band: css.backgroundImage !== 'none', image: css.backgroundImage, size: css.backgroundSize, repeat: css.backgroundRepeat, border: css.borderBottomWidth };
  })`);
  const geometry = () => evaluate(`Array.from(document.querySelectorAll('#link-samples .entity-link, #link-samples [data-layout-tail]'), el => {
    const css = getComputedStyle(el);
    const range = document.createRange(); range.selectNodeContents(el);
    return {
      weight: css.fontWeight, parentWeight: getComputedStyle(el.parentElement).fontWeight,
      padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
      rects: Array.from(range.getClientRects(), r => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    };
  })`);
  await evaluate("document.documentElement.dataset.entityLinkInteractive = 'off'");
  const plainGeometry = await geometry();
  await evaluate("document.documentElement.dataset.entityLinkInteractive = 'on'");
  let geometryChecks = 0;
  const expectStyle = async (text, band, styleName = 'wash') => {
    const actualGeometry = await geometry();
    assert.deepEqual(actualGeometry, plainGeometry, 'Highlighting must preserve plain-prose positions and wrapping');
    for (const item of actualGeometry) {
      assert.equal(item.weight, item.parentWeight, 'Links must inherit the prose weight');
      assert.deepEqual(item.padding, ['0px', '0px', '0px', '0px']);
    }
    geometryChecks++;
    for (const style of await styles()) {
      assert.equal(style.color, text ? 'rgb(170, 85, 119)' : 'rgb(30, 40, 50)');
      assert.equal(style.band, band);
      if (band) {
        assert(style.image.startsWith(styleName === 'dots' ? 'radial-gradient(' : 'linear-gradient('));
        if (styleName === 'dots') {
          assert.equal(style.size, '4px 2px');
          assert.equal(style.repeat, 'repeat-x');
        }
      }
    }
  };
  const wrappedRects = () => evaluate("Array.from(document.querySelector('#wrapped-link').getClientRects(), r => ({ width: r.width, height: r.height }))");
  const initialRects = await wrappedRects();
  assert(initialRects.length > 1);
  for (const [styleName, styleLabel] of [['wash', '连续色带'], ['dots', '细点']]) {
    await bandStyle(styleName, styleLabel);
    for (const [mode, label] of [['contextual', '随归属'], ['kind', '按类型'], ['hover', '仅 Hover']]) {
      await colorMode(mode, label);
      for (const [treatment, button] of [['band', '色带'], ['text', '变色'], ['both', '两者都有']]) {
        await highlight(treatment, button);
        assert.equal(await evaluate("[...document.querySelectorAll('#editor button')].some(b => b.textContent === '细点')"), treatment !== 'text');
        await hover(false);
        await expectStyle(mode !== 'hover' && treatment !== 'band', mode !== 'hover' && treatment !== 'text', styleName);
        await hover(true);
        await expectStyle(treatment !== 'band', treatment !== 'text', styleName);
        assert.deepEqual(await wrappedRects(), initialRects);
      }
    }
  }
  for (const [treatment, button] of [['band', '色带'], ['both', '两者都有'], ['text', '变色']]) {
    await colorMode('contextual', '随归属');
    await highlight(treatment, button);
    await colorMode('prose', '正文');
    assert.equal(await evaluate("[...document.querySelectorAll('#editor button')].some(b => b.textContent === '两者都有')"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('#editor button')].some(b => b.textContent === '细点')"), true);
    for (const [styleName, styleLabel] of [['wash', '连续色带'], ['dots', '细点']]) {
      await bandStyle(styleName, styleLabel);
      for (const hovered of [false, true]) {
        await hover(hovered);
        await expectStyle(false, true, styleName);
        for (const style of await styles()) assert.equal(style.border, '0px');
        assert.deepEqual(await wrappedRects(), initialRects);
        const neutralStyles = await styles();
        await evaluate("document.querySelectorAll('#link-samples .entity-link').forEach(el => el.style.setProperty('--entity-link-color', '#00ff00'))");
        assert.deepEqual(await styles(), neutralStyles, 'Prose bands must ignore entity colors');
        await evaluate("document.querySelectorAll('#link-samples .entity-link').forEach(el => el.style.setProperty('--entity-link-color', '#aa5577'))");
      }
      await evaluate("document.documentElement.dataset.entityLinkInteractive = 'off'");
      await expectStyle(false, false);
      await evaluate("document.documentElement.dataset.entityLinkInteractive = 'on'; document.querySelectorAll('#link-samples .entity-link').forEach(el => el.classList.add('entity-link--dangling'))");
      await expectStyle(false, false);
      await evaluate("document.querySelectorAll('#link-samples .entity-link').forEach(el => el.classList.remove('entity-link--dangling'))");
      assert.equal(await persisted(), treatment);
    }
  }
  await colorMode('contextual', '随归属');
  assert.equal(await persisted(), 'text');
  await expectStyle(true, false);
  for (const [mode, label] of [['band', '色带'], ['text', '变色'], ['both', '两者都有']]) {
    await highlight(mode, label);
    await evaluate("document.documentElement.dataset.entityLinkInteractive = 'off'");
    await expectStyle(false, false);
    await evaluate("document.documentElement.dataset.entityLinkInteractive = 'on'; document.querySelectorAll('#link-samples .entity-link').forEach(el => el.classList.add('entity-link--dangling'))");
    await expectStyle(false, false);
    await evaluate("document.querySelectorAll('#link-samples .entity-link').forEach(el => el.classList.remove('entity-link--dangling'))");
  }
  await highlight('text', '变色');
  await colorMode('prose', '正文');
  await bandStyle('dots', '细点');
  mkdirSync(path.join(root, '.qa'), { recursive: true });
  const clip = await evaluate("(() => { const r = document.querySelector('#link-samples').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()");
  writeFileSync(path.join(root, '.qa/entity-link-dots.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip })).data, 'base64'));
  const reloaded = client.Page.loadEventFired();
  await client.Page.reload();
  await reloaded;
  await until("window.__SETTINGS_UI__ && document.querySelector('#open-settings')");
  await evaluate('__SETTINGS_UI__.modal(true)');
  await until("document.documentElement.dataset.entityLinkStyle === 'prose' && document.querySelector('#editor')");
  assert.equal(await persisted(), 'text');
  assert.equal(await persistedBandStyle(), 'dots');
  assert.equal(await evaluate('document.documentElement.dataset.entityLinkBandStyle'), 'dots');
  assert.equal(await evaluate("[...document.querySelectorAll('#editor button')].some(b => b.textContent === '两者都有')"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('#editor button')].find(b => b.textContent === '细点').getAttribute('aria-pressed')"), 'true');
  await evaluate(`document.querySelector('#editor .set-entity-link-style').closest('.set-row').scrollIntoView({ block: 'center' })`);
  mkdirSync(path.join(root, '.qa'), { recursive: true });
  writeFileSync(path.join(root, '.qa/entity-link-highlights.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
  assert.equal(before, fingerprint(), 'Source changed during acceptance.');
  const report = {
    kind: 'entity-link-highlight', generatedAt: new Date().toISOString(), fingerprint: before, inputs,
    checks: { settingsAndAppearance: true, zeroPadding: true, inheritedWeight: true,
      preservedBold: true, stableTextGeometry: true, disabledAndDeleted: true, reloadPersistence: true },
    geometryChecks, native: 'not-run',
    boundary: 'Real Settings controls and production CSS with synthetic inline links in Chromium. Includes wrapped CJK, Latin, and both bold nesting orders. Excludes deep-link arrows and native Tauri interaction.',
  };
  const output = path.join(root, 'docs/editor/acceptance/entity-link-highlight.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log('Entity Link highlights passed: settings clicks, 2 band styles × 3 treatments × 3 color modes × rest/hover × 5 kinds, wrapped text, inherited bold, zero padding, stable enabled/disabled geometry, always-on neutral prose bands, disabled/deleted links, reload persistence. Renderer only; native Tauri not exercised.');
} finally {
  if (client) await client.close();
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await exited;
  }
  if (server) await server.close();
  rmSync(temporary, { recursive: true, force: true });
}
