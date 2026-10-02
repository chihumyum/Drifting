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
    import '/src/styles/ui-controls.css';
    import '/src/styles/settings.css';
    import { platform } from '/src/renderer/platform';
    import { getPlatformRuntime } from '/src/renderer/platform/runtime';
    import { useProjectStore } from '/src/renderer/store/project-store';
    import { publishMarkdownProjectionStatus as publish } from '/src/renderer/services/markdown-projection-status';
    import { MarkdownProjectionSettings } from '/src/renderer/features/settings/panels/MarkdownProjectionSettings';
    import { AgentMcpAccessSettings } from '/src/renderer/components/agent/AgentMcpAccessSettings';
    Object.assign(getPlatformRuntime(), { target: 'desktop', isMacDesktop: true });
    useProjectStore.setState({ currentProject: { id: 'synthetic', name: 'Synthetic project' } });
    const api = window.__PROJECTION_UI__ = { calls: [], nextRoot: null, fail: false, locale: language => i18next.changeLanguage(language) };
    platform.markdownProjection.pickOutputRoot = async () => api.nextRoot;
    platform.mcpServer.list = async () => [];
    publish('synthetic', { state: 'ready', directory: '/synthetic/default/markdown-projections/project-id', customRoot: null, generatedAt: '2026-10-03T00:00:00Z', readOnly: true, reverseSync: false });
    const renderer = createRoot(document.getElementById('root'));
    api.render = mounted => renderer.render(<main style={{ maxWidth: 820, padding: 30, margin: 'auto' }}>
      <section id="projection"><MarkdownProjectionSettings projectRuntimeMounted={mounted} /></section>
      <section id="mcp"><AgentMcpAccessSettings open /></section>
    </main>);
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
          export async function setMarkdownProjectionOutputRoot(projectId, customRoot) {
            const api = window.__PROJECTION_UI__; api.calls.push(['set', projectId, customRoot]);
            if (api.fail) throw new Error('Synthetic folder is not writable');
            publish(projectId, { state: 'ready', directory: (customRoot ?? '/synthetic/default') + '/markdown-projections/project-id', customRoot, generatedAt: '2026-10-03T00:01:00Z' });
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
    const click = label => evaluate(`[...document.querySelectorAll('#projection button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    await client.Emulation.setDeviceMetricsOverride({ width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/${fixture}/index.html` });
    await until("document.querySelectorAll('#projection button').length === 4");
    await evaluate("__PROJECTION_UI__.locale('en')");
    await until("document.querySelector('#projection').textContent.includes('Choose output folder')");
    assert.equal(await evaluate("document.querySelectorAll('#mcp code').length"), 0);
    assert.equal(await evaluate("document.querySelector('#mcp').textContent.includes('External Agents can also read')"), true);
    checks.push('MCP shows a projection hint without directory controls');
    await click('Choose output folder');
    await until("![...document.querySelectorAll('#projection button')][0].disabled");
    assert.deepEqual(await evaluate('__PROJECTION_UI__.calls'), []);
    checks.push('canceling folder selection preserves the current output');
    await evaluate("__PROJECTION_UI__.nextRoot = '/synthetic/custom'");
    await click('Choose output folder');
    await until("document.querySelector('#projection code').textContent.startsWith('/synthetic/custom/')");
    assert.deepEqual(await evaluate('__PROJECTION_UI__.calls[0]'), ['set', 'synthetic', '/synthetic/custom']);
    await click('Refresh projection');
    await until("__PROJECTION_UI__.calls.length === 2");
    await click('Restore default location');
    await until("document.querySelector('#projection code').textContent.startsWith('/synthetic/default/')");
    assert.deepEqual(await evaluate('__PROJECTION_UI__.calls[2]'), ['set', 'synthetic', null]);
    checks.push('choose, refresh and reset use the current project and update the shown path');
    await evaluate('__PROJECTION_UI__.fail = true');
    await click('Choose output folder');
    await until("document.querySelector('#projection [role=alert]')");
    assert.equal(await evaluate("document.querySelector('#projection code').textContent.startsWith('/synthetic/default/')"), true);
    checks.push('a failed folder change shows an error and preserves the previous path');
    await evaluate("__PROJECTION_UI__.fail = false; __PROJECTION_UI__.locale('zh-CN')");
    await until("document.querySelector('#projection').textContent.includes('选择输出文件夹')");
    await click('选择输出文件夹');
    await until("document.querySelector('#projection code').textContent.startsWith('/synthetic/custom/')");
    for (const width of [1100, 760]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      writeFileSync(`.qa/projection-settings/zh-${width}.png`, Buffer.from((await client.Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    }
    checks.push('Chinese controls wrap without horizontal overflow at two desktop widths');
    await evaluate('__PROJECTION_UI__.render(false)');
    await until("document.querySelectorAll('#projection button').length === 0");
    assert.equal(await evaluate("document.querySelector('#projection').textContent.includes('打开项目后')"), true);
    checks.push('standalone settings explain that a project must be open');
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
