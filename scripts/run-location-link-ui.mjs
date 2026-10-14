import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { createServer } from 'vite';

// Real Chrome input on the real entity-link extension and Agent chat bubble:
// clicking a location link opens its target and lands on the cited paragraphs.
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const reportPath = 'docs/acceptance/location-links-ui.json';
const files = [
  'scripts/run-location-link-ui.mjs',
  'src/renderer/lib/location-link.ts',
  'src/renderer/lib/agent/location-link-catalog.ts',
  'src/renderer/lib/extensions/entity-link.ts',
  'src/renderer/lib/scroll-to-block.ts',
  'src/renderer/features/editor/open-entity-link.ts',
  'src/renderer/features/workspace/navigation/open-location-link.ts',
  'src/renderer/features/agent/AgentMessageViews.tsx',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
};

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint(), 'Location link browser evidence is stale');
  console.log('Location link browser evidence matches current source.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(existsSync);
  assert(chrome, 'Chrome is required');
  const before = fingerprint();
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-location-link-ui-'));
  const fixture = '.local-data/location-link-ui';
  mkdirSync(fixture, { recursive: true });
  mkdirSync('.qa/location-links', { recursive: true });
  writeFileSync(`${fixture}/index.html`, '<!doctype html><html><head><meta charset="UTF-8"><title>Synthetic location links</title></head><body><div id="root"></div><script type="module" src="/.local-data/location-link-ui/fixture.tsx"></script></body></html>');
  writeFileSync(`${fixture}/fixture.tsx`, `
    import { createRoot } from 'react-dom/client';
    import { Editor } from '@tiptap/core';
    import StarterKit from '@tiptap/starter-kit';
    import '/src/renderer/lib/i18n';
    import '/src/styles/index.css';
    import { EntityLink } from '/src/renderer/lib/extensions/entity-link';
    import { BlockId } from '/src/renderer/lib/extensions/block-id';
    import { openEntityLinkTarget } from '/src/renderer/features/editor/open-entity-link';
    import { MessageView } from '/src/renderer/features/agent/AgentMessageViews';
    import { WorkspaceNavigationProvider } from '/src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
    import { useDataStore } from '/src/renderer/store/data-store';

    const blocks = Array.from({ length: 40 }, (_, index) => 'b' + (index + 1));
    const chapter = { type: 'doc', content: blocks.map((id, index) => ({
      type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: '雨夜第 ' + (index + 1) + ' 段。' }] })) };
    const api = window.__LOCATION_UI__ = { opened: [], chapter };
    useDataStore.setState({
      bookNodes: [{ id: 'rain', projectId: 'synthetic', title: '雨夜', kind: 'chapter' }],
      bookElements: [], bookElementCategories: [], storylines: [], trashedEntityIds: new Set(),
    });
    const navigator = {
      projectId: 'synthetic',
      open(target) { api.opened.push(target); document.getElementById('target').hidden = false; },
      activate() {}, showProjectHome() {}, leaveDeletedTarget() {},
    };
    const target = document.createElement('section');
    target.id = 'target';
    target.hidden = true;
    target.style.cssText = 'height: 360px; overflow: auto; border: 1px solid #ccc; margin-top: 16px';
    target.innerHTML = '<div data-chapter-id="rain">' + blocks.map((id, index) =>
      '<p data-block-id="' + id + '" style="margin: 0; padding: 8px 12px">雨夜第 ' + (index + 1) + ' 段。</p>').join('') + '</div>';

    const app = document.getElementById('root');
    app.style.cssText = 'max-width: 760px; margin: 24px auto; font: 16px/1.6 system-ui';
    const element = document.createElement('div');
    element.id = 'element';
    app.append(element);
    api.editor = new Editor({
      element,
      extensions: [StarterKit.configure({ link: false }), BlockId,
        EntityLink.configure({ autoDetectEnabled: false, onClick: (ref) => openEntityLinkTarget(navigator.open, ref) })],
      content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'e1' }, content: [
        { type: 'text', text: '见' },
        { type: 'text', text: '雨夜第 21–25 行', marks: [{ type: 'entityLink', attrs: {
          targetKind: 'node', targetId: 'rain', targetBlockId: 'b11', targetEndBlockId: 'b13' } }] },
        { type: 'text', text: '。' },
      ] }] },
    });
    const chat = document.createElement('div');
    chat.id = 'chat';
    app.append(chat, target);
    api.renderChat = (text) => createRoot(chat).render(
      <WorkspaceNavigationProvider navigator={navigator}><MessageView msg={{ kind: 'assistant', text }} /></WorkspaceNavigationProvider>);
    api.reset = () => { api.opened = []; target.scrollTop = 0; target.hidden = true; };
  `);
  let server, browser, client;
  const checks = [];
  try {
    server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'error',
      cacheDir: path.join(temporary, 'vite'),
      plugins: [{ name: 'synthetic-location-bodies', enforce: 'pre', load(id) {
        // The cited chapter body comes from the fixture instead of live Yjs.
        if (id === path.join(root, 'src/renderer/lib/agent/chapter-prose.ts')) return `
          export async function getEntityContentJson(kind, id) {
            return JSON.stringify(id === 'rain' ? window.__LOCATION_UI__.chapter : { type: 'doc', content: [] });
          }
        `;
      } }], server: { host: '127.0.0.1', port: 0, hmr: false, open: false } });
    await server.listen();
    const profile = path.join(temporary, 'chrome');
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++) { assert.equal(browser.exitCode, null); await delay(50); }
    assert(existsSync(portFile));
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    client = await CDP({ port, target: await CDP.New({ port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 200; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(25); }
      throw new Error(`Timed out: ${expression}`);
    };
    // Real browser input: press and release the mouse at the element's center.
    const mouseClick = async selector => {
      const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await client.Input.dispatchMouseEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
    };
    // The cited block is centered in the chapter pane and its range flashes.
    const landed = async (first, last) => {
      await until(`(() => {
        const pane = document.getElementById('target').getBoundingClientRect();
        const block = document.querySelector('[data-block-id="${first}"]').getBoundingClientRect();
        return Math.abs((block.top + block.bottom) / 2 - (pane.top + pane.bottom) / 2) < 30;
      })()`);
      const ids = Array.from({ length: Number(last.slice(1)) - Number(first.slice(1)) + 1 }, (_, i) => 'b' + (Number(first.slice(1)) + i));
      await until(`${JSON.stringify(ids)}.every(id => document.querySelector('[data-block-id="' + id + '"]').getAnimations().length > 0)`);
      const neighbours = [`b${Number(first.slice(1)) - 1}`, `b${Number(last.slice(1)) + 1}`];
      assert.equal(await evaluate(`${JSON.stringify(neighbours)}.some(id => document.querySelector('[data-block-id="' + id + '"]').getAnimations().length > 0)`), false);
    };
    await client.Emulation.setDeviceMetricsOverride({ width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/${fixture}/index.html` });
    await until("document.querySelector('#element .entity-link')");

    assert.deepEqual(await evaluate(`(() => { const link = document.querySelector('#element .entity-link');
      return [link.dataset.targetBlockId, link.dataset.targetEndBlockId, link.classList.contains('entity-link--deep')]; })()`), ['b11', 'b13', true]);
    checks.push('a stored location link renders its paragraph anchor, range end and deep-link style');
    await mouseClick('#element .entity-link');
    await until('__LOCATION_UI__.opened.length === 1');
    assert.deepEqual(await evaluate('__LOCATION_UI__.opened'), [{ entityType: 'node', id: 'rain' }]);
    await landed('b11', 'b13');
    writeFileSync('.qa/location-links/editor-click.png', Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    checks.push('clicking an editor location link opens the chapter, centers paragraph 11 and flashes paragraphs 11–13');

    await evaluate("__LOCATION_UI__.reset(); __LOCATION_UI__.renderChat('参见[雨夜第 41–45 行](drifting:chapters/雨夜/prose.md#L41-L45)，以及[失效位置](drifting:chapters/雨夜/prose.md#L999)。')");
    await until("document.querySelectorAll('#chat a').length === 2");
    await mouseClick('#chat a');
    await until('__LOCATION_UI__.opened.length === 1');
    await landed('b21', 'b23');
    assert.equal(await evaluate('location.pathname.endsWith("/index.html")'), true);
    writeFileSync('.qa/location-links/chat-click.png', Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    checks.push('clicking a drifting: link in an Agent message resolves lines 41–45 to paragraphs 21–23 without navigating the page');

    await evaluate('__LOCATION_UI__.reset()');
    await mouseClick('#chat a:nth-of-type(2)');
    await until('__LOCATION_UI__.opened.length === 1');
    assert.deepEqual(await evaluate('__LOCATION_UI__.opened'), [{ entityType: 'node', id: 'rain' }]);
    await delay(400);
    assert.equal(await evaluate('document.getElementById("target").scrollTop'), 0);
    checks.push('a chat link whose lines no longer exist still opens its chapter without jumping');

    assert.equal(before, fingerprint(), 'Source changed during location link acceptance');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ kind: 'location-links-browser', generatedAt: new Date().toISOString(), sourceSha256: before, status: 'passed', synthetic: true, checks,
      boundaries: {
        browser: 'real Chrome mouse input on the real entityLink extension, scroll-to-block and Agent message view; synthetic navigator and chapter body',
        runtime: 'Agent write/read and projection paths are covered by vitest and pnpm mcp:acceptance',
        desktopApp: 'Tauri window input not exercised; operating-system drifting://open links need a bundled app',
      } }, null, 2) + '\n');
    console.log(`Location link UI: ${checks.length} checks passed.`);
  } finally {
    if (client) await client.close();
    if (browser && browser.exitCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await exited;
    }
    if (server) await server.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}
