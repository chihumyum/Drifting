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

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const reportPath = 'docs/agent-runtime/acceptance/projection-settings-ui.json';
const files = [
  'scripts/run-markdown-projection-settings.mjs',
  'src/renderer/features/settings/panels/MarkdownProjectionSettings.tsx',
  'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
  'src/renderer/components/modals/PreAlphaOnboardingDialog.tsx',
  'src/renderer/components/modals/ConfirmationDialog.tsx',
  'src/renderer/components/agent/AgentMcpAccessSettings.tsx',
  'src/renderer/services/markdown-projection-status.ts',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
];
const fingerprint = () => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint());
  console.log('Projection settings browser evidence matches current source.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(existsSync);
  assert(chrome, 'Chrome is required');
  const before = fingerprint();
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-projection-ui-'));
  const fixture = '.local-data/projection-settings-ui';
  mkdirSync(fixture, { recursive: true });
  mkdirSync('.qa/projection-settings', { recursive: true });
  writeFileSync(`${fixture}/index.html`, '<!doctype html><html><head><meta charset="UTF-8"><title>Synthetic projection settings</title></head><body><div id="root"></div><script type="module" src="/.local-data/projection-settings-ui/fixture.tsx"></script></body></html>');
  writeFileSync(`${fixture}/fixture.tsx`, `
    import { createRoot } from 'react-dom/client';
    import i18next from 'i18next';
    import '/src/renderer/lib/i18n';
    import '/src/styles/index.css';
    import '/src/styles/materials.css';
    import '/src/styles/ui-controls.css';
    import '/src/styles/settings.css';
    import '/src/styles/auth.css';
    import { MemoryRouter } from 'react-router-dom';
    import { platform } from '/src/renderer/platform';
    import { getPlatformRuntime } from '/src/renderer/platform/runtime';
    import { useAuthStore } from '/src/renderer/store/auth';
    import { useProjectStore } from '/src/renderer/store/project-store';
    import { publishMarkdownProjectionStatus as publish } from '/src/renderer/services/markdown-projection-status';
    import { MarkdownProjectionSettings } from '/src/renderer/features/settings/panels/MarkdownProjectionSettings';
    import { AgentMcpAccessSettings } from '/src/renderer/components/agent/AgentMcpAccessSettings';
    import { ConfirmationDialog } from '/src/renderer/components/modals/ConfirmationDialog';
    import { PreAlphaFirstRunGate } from '/src/renderer/components/modals/PreAlphaOnboardingDialog';
    Object.assign(getPlatformRuntime(), { target: 'desktop', isMacDesktop: true });
    useProjectStore.setState({ currentProject: { id: 'synthetic', name: 'Synthetic project' } });
    const api = window.__PROJECTION_UI__ = { calls: [], nextRoot: null, fail: false, publish, locale: language => i18next.changeLanguage(language),
      folder: { directory: '/synthetic/first/markdown-projections', root: '/synthetic/first', enabled: true } };
    platform.markdownProjection.pickOutputRoot = async () => api.nextRoot;
    platform.markdownProjection.folder = async () => api.folder;
    platform.markdownProjection.setDefaultRoot = async root => {
      api.calls.push(['default', root]);
      if (api.fail) throw new Error('Synthetic folder is not writable');
      return api.folder = { ...api.folder, root, directory: root + '/markdown-projections' };
    };
    platform.markdownProjection.setEnabled = async enabled => { api.calls.push(['enabled', enabled]); return api.folder = { ...api.folder, enabled }; };
    platform.markdownProjection.open = async projectId => { api.calls.push(['open', projectId]); };
    platform.mcpServer.list = async () => [];
    publish('synthetic', { state: 'ready', directory: '/synthetic/first/markdown-projections/project-id', customRoot: null, generatedAt: '2026-10-03T00:00:00Z', readOnly: false, reverseSync: true, enabled: true });
    const renderer = createRoot(document.getElementById('root'));
    // A new key mounts the panel afresh, so it reads the folder settings again.
    api.render = (mounted, key = 0) => renderer.render(<>
      <main style={{ maxWidth: 820, padding: 30, margin: 'auto' }}>
        <section id="projection" key={key}><MarkdownProjectionSettings projectRuntimeMounted={mounted} /></section>
        <section id="mcp"><AgentMcpAccessSettings open /></section>
      </main>
      <ConfirmationDialog />
    </>);
    // The desktop first run past its welcome: the Markdown folder step comes next.
    api.renderGate = () => {
      localStorage.setItem('drifting.alpha-guide.v6:synthetic-user', 'seen');
      localStorage.removeItem('drifting.markdown-folder-guide.v2');
      useAuthStore.setState({ isAuthenticated: true, user: { id: 'synthetic-user' }, session: null });
      // A new key mounts a fresh gate, as a new launch would.
      renderer.render(<MemoryRouter key={api.launches = (api.launches ?? 0) + 1}>
        <PreAlphaFirstRunGate><div id="shelf">Shelf</div></PreAlphaFirstRunGate>
        <ConfirmationDialog />
      </MemoryRouter>);
    };
    api.render(true);
  `);
  let server, browser, client;
  const checks = [];
  try {
    server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'error',
      cacheDir: path.join(temporary, 'vite'),
      plugins: [{ name: 'synthetic-projection-actions', enforce: 'pre', load(id) {
        if (id === path.join(root, 'src/renderer/services/markdown-projection.service.ts')) return `
          import { publishMarkdownProjectionStatus as publish } from '/src/renderer/services/markdown-projection-status';
          import { platform } from '/src/renderer/platform';
          // The open project follows all projects here, so it is captured at the new location.
          export async function setMarkdownFolderDefaultRoot(root) {
            const next = await platform.markdownProjection.setDefaultRoot(root);
            publish('synthetic', { state: 'ready', directory: next.directory + '/project-id', customRoot: null, generatedAt: '2026-10-03T00:02:00Z' });
            return next;
          }
          export const setMarkdownFolderEnabled = enabled => platform.markdownProjection.setEnabled(enabled);
          export async function setMarkdownProjectionOutputRoot(projectId, customRoot) {
            const api = window.__PROJECTION_UI__; api.calls.push(['set', projectId, customRoot]);
            if (api.fail) throw new Error('Synthetic folder is not writable');
            publish(projectId, { state: 'ready', directory: (customRoot ?? api.folder.root) + '/markdown-projections/project-id', customRoot, generatedAt: '2026-10-03T00:01:00Z' });
          }
          export async function refreshMarkdownProjection(projectId) { window.__PROJECTION_UI__.calls.push(['refresh', projectId]); }
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
      for (let i = 0; i < 600; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(50); }
      throw new Error(`Timed out: ${expression}`);
    };
    const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
    const buttons = selector => `[...document.querySelectorAll('${selector} button')]`;
    const button = (selector, label) => `${buttons(selector)}.find(b => b.textContent === ${JSON.stringify(label)})`;
    const click = async (label, selector = '#projection') => {
      await until(`${button(selector, label)} && !${button(selector, label)}.disabled`);
      await evaluate(`${button(selector, label)}.click()`);
    };
    const calls = () => evaluate('__PROJECTION_UI__.calls.splice(0)');
    const dangerInk = (selector, label) => evaluate(`(() => {
      const danger = ${button(selector, label)};
      const plain = ${buttons(selector)}.find(b => !b.className.includes('danger') && !b.className.includes('primary'));
      return danger.className.includes('ui-button--danger') && getComputedStyle(danger).color !== getComputedStyle(plain).color;
    })()`);
    const projectCode = "document.querySelectorAll('#projection code')[1]?.textContent ?? ''";
    await client.Emulation.setDeviceMetricsOverride({ width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/${fixture}/index.html` });
    await until("document.querySelectorAll('#projection button').length === 7");
    await evaluate("__PROJECTION_UI__.locale('en')");
    await until("document.querySelector('#projection').textContent.includes('Choose for this project')");
    assert.equal(await evaluate("document.querySelectorAll('#mcp code').length"), 0);
    assert.equal(await evaluate("document.querySelector('#mcp').textContent.includes('External Agents can also use')"), true);
    checks.push('MCP shows a projection hint without directory controls');
    await evaluate("__PROJECTION_UI__.publish('synthetic', { mirrorIssues: [{ path: '正文/002 晨雾.md', reason: 'frontmatter' }], preserved: ['正文/003 旧稿.md'] })");
    await until("document.querySelector('#projection').textContent.includes('正文/002 晨雾.md: the properties at the top are malformed')");
    assert.equal(await evaluate("document.querySelector('#projection').textContent.includes('1 edited old file was kept')"), true);
    checks.push('an edited file that cannot merge and preserved copies are reported');
    await evaluate("__PROJECTION_UI__.publish('synthetic', { mirrorIssues: [], preserved: undefined })");
    await until("!document.querySelector('#projection [role=alert]')");
    await click('Show in Finder');
    await until('__PROJECTION_UI__.calls.length === 1');
    assert.deepEqual(await calls(), [['open', 'synthetic']]);
    checks.push('Show in Finder opens the open project\'s folder');
    await click('Choose folder');
    await until(`!${button('#projection', 'Choose folder')}.disabled`);
    assert.deepEqual(await calls(), []);
    checks.push('canceling folder selection preserves the current location');
    await evaluate("__PROJECTION_UI__.nextRoot = '/synthetic/custom'");
    await click('Choose folder');
    await until("document.querySelector('#projection code').textContent === '/synthetic/custom/markdown-projections'");
    assert.deepEqual(await calls(), [['default', '/synthetic/custom']]);
    assert.equal(await evaluate("document.querySelector('#projection code').previousElementSibling.textContent"), 'All projects');
    assert.equal((await text('#projection')).includes('Restore default location'), false);
    assert.equal(await evaluate(`${buttons('#projection')}.some(b => /default/i.test(b.textContent))`), false);
    checks.push('choosing the location for all projects updates the shown path, and there is no default to restore');
    await evaluate("__PROJECTION_UI__.nextRoot = '/synthetic/own'");
    await click('Choose for this project');
    await until(`${projectCode}.startsWith('/synthetic/own/')`);
    await click('Update now');
    await until('__PROJECTION_UI__.calls.length === 2');
    await click('Follow all projects');
    await until(`${projectCode}.startsWith('/synthetic/custom/')`);
    assert.deepEqual(await calls(), [['set', 'synthetic', '/synthetic/own'], ['refresh', 'synthetic'], ['set', 'synthetic', null]]);
    checks.push('a location of the project\'s own, update and follow-all-projects use the current project');
    await evaluate('__PROJECTION_UI__.fail = true');
    await click('Choose folder');
    await until("document.querySelector('#projection [role=alert]')");
    assert.equal(await text('#projection code'), '/synthetic/custom/markdown-projections');
    await evaluate('__PROJECTION_UI__.fail = false');
    await calls();
    checks.push('a failed folder change shows an error and preserves the previous path');
    assert.equal(await dangerInk('#projection', 'Turn off Markdown folder'), true);
    await click('Turn off Markdown folder');
    await until("document.querySelector('.confirmation-dialog__message')");
    assert.equal(await evaluate("document.activeElement.textContent === 'Cancel'"), true);
    await click('Cancel', '.modal-root');
    await until("!document.querySelector('.confirmation-dialog__message')");
    assert.deepEqual(await calls(), []);
    await click('Turn off Markdown folder');
    await until("document.querySelector('.confirmation-dialog__message')");
    assert.equal((await text('.confirmation-dialog__message')).includes('edits made there no longer merge back'), true);
    await click('Turn off Markdown folder', '.modal-root');
    await until("document.querySelector('#projection').textContent.includes('Off: projects no longer write Markdown')");
    assert.deepEqual(await calls(), [['enabled', false]]);
    assert.equal(await evaluate("document.querySelectorAll('#projection code').length"), 0);
    assert.deepEqual(await evaluate(`${buttons('#projection')}.map(b => b.textContent)`), ['Turn on']);
    checks.push('turning the folder off is drawn in the danger ink, asks first with Cancel focused, and leaves only Turn on');
    await click('Turn on');
    await until("document.querySelector('#projection').textContent.includes('Turn off Markdown folder')");
    assert.deepEqual(await calls(), [['enabled', true]]);
    checks.push('turning it back on restores the location and project controls');
    // A device with no location chosen: nothing is written and nothing claims a place.
    await evaluate("__PROJECTION_UI__.folder = { directory: null, root: null, enabled: true }");
    await evaluate("__PROJECTION_UI__.publish('synthetic', { state: 'unset', directory: null, customRoot: null, generatedAt: undefined })");
    await evaluate('__PROJECTION_UI__.render(true, 1)');
    await until("document.querySelector('#projection').textContent.includes('All projects · No location chosen')");
    assert.equal(await evaluate("document.querySelectorAll('#projection code').length"), 0);
    assert.equal(await evaluate(`${button('#projection', 'Show in Finder')}.disabled`), true);
    assert.equal(await evaluate(`${button('#projection', 'Choose folder')}.className.includes('primary')`), true);
    assert.equal((await text('#projection [role=status]')).includes('No location chosen'), true);
    assert.equal(await evaluate(`${button('#projection', 'Update now')}.disabled`), true);
    assert.equal(await evaluate(`${button('#projection', 'Copy path')}.disabled`), true);
    await evaluate("__PROJECTION_UI__.nextRoot = '/synthetic/custom'");
    await click('Choose folder');
    await until("document.querySelector('#projection code')?.textContent === '/synthetic/custom/markdown-projections'");
    await until(`${projectCode}.startsWith('/synthetic/custom/')`);
    assert.deepEqual(await calls(), [['default', '/synthetic/custom']]);
    assert.equal(await evaluate(`${button('#projection', 'Show in Finder')}.disabled`), false);
    checks.push('with no location chosen nothing shows a path, Finder and Update now wait, and Choose folder leads; choosing one writes the open project there');
    await evaluate("__PROJECTION_UI__.locale('zh-CN')");
    await until("document.querySelector('#projection').textContent.includes('为本项目单独选择')");
    await evaluate("__PROJECTION_UI__.nextRoot = '/synthetic/custom'");
    await click('选择文件夹');
    await until("document.querySelector('#projection code').textContent.startsWith('/synthetic/custom/')");
    await calls();
    for (const width of [1100, 760]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      writeFileSync(`.qa/projection-settings/zh-${width}.png`, Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    }
    checks.push('Chinese controls wrap without horizontal overflow at two desktop widths');
    await evaluate('__PROJECTION_UI__.render(false)');
    await until("document.querySelector('#projection').textContent.includes('打开项目后')");
    assert.equal(await evaluate(`${buttons('#projection')}.length`), 3);
    await click('在访达中打开');
    await until('__PROJECTION_UI__.calls.length === 1');
    assert.deepEqual(await calls(), [['open', null]]);
    checks.push('with no project open the location and switch remain, and Finder opens the folder holding projects');
    await client.Emulation.setDeviceMetricsOverride({ width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate("__PROJECTION_UI__.folder = { directory: null, root: null, enabled: true }");
    await evaluate('__PROJECTION_UI__.renderGate()');
    await until(`document.querySelector('.first-run-gate') && ${button('.first-run-gate__card', '选择文件夹…')}`);
    assert.equal(await evaluate("document.querySelector('#shelf')"), null);
    assert.equal((await text('.first-run-gate')).includes('Markdown 文件夹放在哪里？'), true);
    // No default is offered: no location, and no way on but choosing or turning the folder off.
    assert.equal(await evaluate("document.querySelector('.markdown-folder-guide__location')"), null);
    assert.equal(await evaluate("document.querySelectorAll('.first-run-gate code').length"), 0);
    // The card's own actions; the interface language waits apart in the window's corner.
    assert.deepEqual(await evaluate(`${buttons('.first-run-gate__card')}.map(b => b.textContent)`), ['关闭 Markdown 文件夹', '选择文件夹…']);
    assert.equal(await evaluate(`${button('.first-run-gate__card', '选择文件夹…')}.className.includes('ui-button--primary')`), true);
    assert.equal(await evaluate("document.activeElement?.textContent"), '选择文件夹…');
    assert.equal(await evaluate("!!document.querySelector('.first-run-gate__language .ui-select')"), true);
    assert.equal(await dangerInk('.first-run-gate', '关闭 Markdown 文件夹'), true);
    // The card fades in; shoot it once it has arrived.
    await until("document.querySelector('.first-run-gate__card').getAnimations({ subtree: true }).every(a => a.playState === 'finished')");
    writeFileSync('.qa/projection-settings/first-run-zh.png', Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    checks.push('the first run asks the author to choose the Markdown folder, offering no default, before the shelf');
    await evaluate('__PROJECTION_UI__.nextRoot = null');
    await click('选择文件夹…', '.first-run-gate');
    await until(`!${button('.first-run-gate__card', '选择文件夹…')}.disabled`);
    assert.deepEqual(await calls(), []);
    assert.deepEqual(await evaluate(`${buttons('.first-run-gate__card')}.map(b => b.textContent)`), ['关闭 Markdown 文件夹', '选择文件夹…']);
    assert.equal(await evaluate("document.querySelector('#shelf')"), null);
    checks.push('canceling the folder picker leaves the first run waiting for a choice');
    await evaluate("__PROJECTION_UI__.nextRoot = '/synthetic/chosen'");
    await click('选择文件夹…', '.first-run-gate');
    await until("document.querySelector('.markdown-folder-guide__path')?.textContent === '/synthetic/chosen/markdown-projections'");
    assert.equal(await text('.markdown-folder-guide__label'), '已选择');
    assert.deepEqual(await calls(), [['default', '/synthetic/chosen']]);
    assert.deepEqual(await evaluate(`${buttons('.first-run-gate__card')}.map(b => b.textContent)`), ['关闭 Markdown 文件夹', '选择文件夹…', '继续']);
    assert.equal(await evaluate("document.activeElement?.textContent"), '继续');
    await click('继续', '.first-run-gate');
    await until("document.querySelector('#shelf')");
    assert.equal(await evaluate("localStorage.getItem('drifting.markdown-folder-guide.v2')"), 'seen');
    checks.push('a chosen folder becomes the location for all projects and the shelf opens after it');
    await evaluate('__PROJECTION_UI__.renderGate()');
    await until("document.querySelector('.markdown-folder-guide__path')?.textContent === '/synthetic/chosen/markdown-projections'");
    assert.deepEqual(await evaluate(`${buttons('.first-run-gate__card')}.map(b => b.textContent)`), ['关闭 Markdown 文件夹', '选择文件夹…', '继续']);
    checks.push('a folder already chosen on this device lets the first run go on without choosing again');
    await evaluate("__PROJECTION_UI__.folder = { directory: null, root: null, enabled: true }");
    await evaluate('__PROJECTION_UI__.renderGate()');
    await until(`${button('.first-run-gate__card', '选择文件夹…')} && !document.querySelector('.markdown-folder-guide__path')`);
    await click('关闭 Markdown 文件夹', '.first-run-gate');
    await until("document.querySelector('.confirmation-dialog__message')");
    await click('取消', '.modal-root');
    await until("!document.querySelector('.confirmation-dialog__message')");
    assert.equal(await evaluate("document.querySelector('#shelf')"), null);
    await click('关闭 Markdown 文件夹', '.first-run-gate');
    await until("document.querySelector('.confirmation-dialog__message')");
    await click('关闭 Markdown 文件夹', '.modal-root');
    await until("document.querySelector('#shelf')");
    assert.deepEqual(await calls(), [['enabled', false]]);
    checks.push('the first run can turn the folder off, only after the danger confirmation');
    assert.equal(before, fingerprint());
    writeFileSync(reportPath, JSON.stringify({ kind: 'markdown-projection-settings-browser', generatedAt: new Date().toISOString(), sourceSha256: before, status: 'passed', synthetic: true, checks,
      boundaries: { browser: 'real React components and clicks; synthetic native picker and service actions', filesystemAndScheduler: 'separate pnpm mcp:acceptance', nativePicker: 'not exercised' } }, null, 2) + '\n');
    console.log(`Projection settings UI: ${checks.length} checks passed.`);
  } finally {
    if (client) await client.close();
    if (browser && browser.exitCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await exited;
    }
    if (server) await server.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}
