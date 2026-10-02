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
const reportPath = 'docs/renderer-performance/acceptance/settings-search.json';
const files = [
  'scripts/run-settings-search.mjs',
  'src/renderer/features/settings/desktop/settings-section-navigation.ts',
  'src/renderer/features/settings/desktop/DesktopSettingsModal.tsx',
  'src/renderer/features/settings/desktop/DesktopSettingsRail.tsx',
  'src/renderer/features/settings/SettingsPrimitives.tsx',
  'src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx',
  'src/renderer/features/settings/panels/BasicPreferencePanels.tsx',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
  'src/styles/settings.css',
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
  console.log('Settings search browser evidence matches current source.');
} else {
  const chrome = process.env.DRIFTING_PERF_CHROME ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium',
  ].find(existsSync);
  assert(chrome, 'Chrome is required');
  const before = fingerprint();
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-settings-search-'));
  mkdirSync('.local-data', { recursive: true });
  const fixture = mkdtempSync('.local-data/settings-search-');
  writeFileSync(`${fixture}/index.html`, `<!doctype html><html><head><meta charset="UTF-8"><title>Synthetic settings search</title></head><body><div id="root"></div><script type="module" src="/${fixture}/fixture.tsx"></script></body></html>`);
  writeFileSync(`${fixture}/fixture.tsx`, `
    import { createRoot } from 'react-dom/client';
    import i18next from 'i18next';
    import '/src/renderer/lib/i18n';
    import '/src/styles/index.css';
    import '/src/styles/ui-controls.css';
    import '/src/styles/settings.css';
    import { DesktopSettingsModal } from '/src/renderer/features/settings/desktop/DesktopSettingsModal';
    import { EditorPanel, AppearancePanel } from '/src/renderer/features/settings/panels/PreferenceSettingsPanels';
    import { SettingsGroupHeader, SettingsSectionHeader, SettingsRow } from '/src/renderer/features/settings/SettingsPrimitives';
    const Empty = () => null;
    function AgentPanel({ registerRef }) {
      return <section id="agent" className="set-panel" ref={registerRef}>
        <p>Introductory explanation</p>
        <SettingsGroupHeader label="First group" />
        <SettingsRow label="Synthetic control" desc={<>Keep the <code>API key</code> locally.</>} />
        <SettingsGroupHeader label="Second group" />
        <p id="changing-copy">Initial description</p>
        <div hidden><SettingsSectionHeader title="Hidden title" />Hidden attribute sentinel</div>
        <div style={{ display: 'none' }}>Display sentinel</div>
        <div style={{ visibility: 'hidden' }}>Visibility sentinel</div>
        <div aria-hidden="true">Aria sentinel</div>
        <input defaultValue="Input sentinel" /><textarea defaultValue="Textarea sentinel" />
        <p id="conditional-copy" style={{ display: 'none' }}>Conditional description</p>
        <details id="collapsed-copy"><summary>Advanced settings</summary><p>Collapsed description</p></details>
      </section>;
    }
    function PrivacyPanel({ registerRef }) {
      return <section id="privacy" className="set-panel" ref={registerRef} style={{ minHeight: 900 }}>
        <p>Ungrouped explanation</p>
      </section>;
    }
    const api = window.__SETTINGS_SEARCH__ = {
      locale: value => i18next.changeLanguage(value),
      panels: { AccountPanel: Empty, AppearancePanel, EditorPanel, LanguagePanel: Empty,
        ModelsPanel: Empty, CopilotPanel: Empty, AgentPanel, KeysPanel: Empty,
        SyncPanel: Empty, UpdatePanel: Empty, PrivacyPanel, AboutPanel: Empty },
    };
    await api.locale('zh-CN');
    createRoot(document.getElementById('root')).render(<DesktopSettingsModal isOpen onClose={() => {}} />);
  `);
  let server, browser, client;
  const checks = [];
  try {
    server = await createServer({ root, configFile: path.join(root, 'vite.renderer.config.ts'), envDir: false, logLevel: 'error',
      cacheDir: path.join(temporary, 'vite'),
      plugins: [{ name: 'synthetic-settings-panels', enforce: 'pre', load(id) {
        if (id === path.join(root, 'src/renderer/features/settings/useSettingsPanels.ts')) return `
          import { useEffect, useState } from 'react';
          export function useSettingsPanels() {
            const [panels, setPanels] = useState(null);
            useEffect(() => { window.__SETTINGS_SEARCH__.load = () => setPanels(window.__SETTINGS_SEARCH__.panels); }, []);
            return { panels, failed: false, retry: () => {} };
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
    const errors = [];
    client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 600; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(50); }
      throw new Error(`Timed out: ${expression}\n${errors.join('\n')}`);
    };
    const results = `({ parents: [...document.querySelectorAll('.set-rail__item')].map(e => e.getAttribute('aria-controls')), children: [...document.querySelectorAll('.set-rail__section')].map(e => e.textContent) })`;
    const search = async text => {
      await evaluate(`(() => {
        const input = document.querySelector('.set-head__search input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      return evaluate(results);
    };
    await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/${fixture}/index.html` });
    await until('window.__SETTINGS_SEARCH__?.load');
    assert.deepEqual((await search('正文输入光标')).parents, []);
    await evaluate('__SETTINGS_SEARCH__.load()');
    await until("document.querySelector('.set-rail__section')?.textContent === '书写体验'");
    assert.deepEqual(await evaluate(results), { parents: ['editor'], children: ['书写体验'] });
    checks.push('Body-only Chinese query typed before deferred panels load finds the owning section after mount');
    await evaluate("document.querySelector('.set-rail__section').click()");
    const distance = await evaluate(`(() => {
      const target = document.getElementById(document.querySelector('.set-rail__section').getAttribute('aria-controls'));
      return target.getBoundingClientRect().top - document.querySelector('.set-main').getBoundingClientRect().top;
    })()`);
    assert(Math.abs(distance - 16) < 2, `Unexpected scroll offset: ${distance}`);
    checks.push('Clicking a body search result immediately scrolls to its owning heading');
    assert.deepEqual(await search('光标颜色'), { parents: ['appearance', 'editor'], children: ['强调色', '书写体验'] });
    checks.push('Individual setting labels and related descriptions retain all matching panels');
    assert.deepEqual(await search('  api   KEY  '), { parents: ['agent'], children: ['First group'] });
    checks.push('Inline markup, case and whitespace normalize without crossing sibling group boundaries');
    assert.deepEqual(await search('Introductory explanation'), { parents: ['agent'], children: [] });
    assert.deepEqual(await search('Ungrouped explanation'), { parents: ['privacy'], children: [] });
    checks.push('Panel introductions and panels without subsection headings remain searchable');
    assert.deepEqual(await search('sentinel'), { parents: [], children: [] });
    checks.push('Hidden attributes, CSS display/visibility, aria-hidden and form values are excluded');
    await search('Updated description');
    await evaluate("document.querySelector('#changing-copy').firstChild.textContent = 'Updated description'");
    await until("document.querySelector('.set-rail__section')?.textContent === 'Second group'");
    assert.deepEqual(await evaluate(results), { parents: ['agent'], children: ['Second group'] });
    checks.push('Body-only text mutations refresh an active query without changing the heading');
    assert.deepEqual(await search('Initial description'), { parents: [], children: [] });
    await search('Conditional description');
    await evaluate("document.querySelector('#conditional-copy').style.display = 'block'");
    await until("document.querySelector('.set-rail__section')?.textContent === 'Second group'");
    await evaluate("document.querySelector('#conditional-copy').style.display = 'none'");
    await until("document.querySelectorAll('.set-rail__item').length === 0");
    checks.push('Conditional visibility adds and removes text from the active search');
    assert.deepEqual(await search('Collapsed description'), { parents: [], children: [] });
    await evaluate("document.querySelector('#collapsed-copy').open = true");
    await until("document.querySelector('.set-rail__section')?.textContent === 'Second group'");
    await evaluate("document.querySelector('#collapsed-copy').open = false");
    await until("document.querySelectorAll('.set-rail__item').length === 0");
    checks.push('Collapsed details are indexed only while expanded and refresh when toggled');
    await search('prose insertion caret');
    await evaluate("__SETTINGS_SEARCH__.locale('en')");
    await until("document.querySelector('.set-rail__item')?.getAttribute('aria-controls') === 'editor'");
    assert.equal((await evaluate(results)).children.length, 1);
    assert.deepEqual(await search('正文输入光标'), { parents: [], children: [] });
    checks.push('Locale changes replace indexed descriptions for an already-entered query');
    const titleMatch = await search('EDITOR');
    assert(titleMatch.parents.includes('editor'));
    assert.equal(await evaluate(`document.querySelector('.set-rail__item[aria-controls="editor"]').parentElement.querySelectorAll('.set-rail__section').length`), 3);
    const cleared = await search('');
    assert(cleared.parents.includes('editor') && cleared.parents.includes('agent'));
    assert(cleared.children.includes('First group') && cleared.children.includes('Second group'));
    assert(!cleared.children.includes('Hidden title'));
    checks.push('Category searches and clearing the query preserve the permanently expanded navigation');
    assert.deepEqual(errors, []);
    assert.equal(fingerprint(), before, 'Source changed during acceptance');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({ kind: 'settings-body-search-browser', generatedAt: new Date().toISOString(), sourceSha256: before, status: 'passed', synthetic: true, checks, boundaries: 'Headless Chrome with the real desktop Settings shell, editor/appearance panels, and synthetic deferred panels. Tauri window not exercised.' }, null, 2)}\n`);
    console.log(`Settings search: ${checks.length} browser checks passed.`);
  } finally {
    if (client) await client.close();
    if (browser) { const stopped = new Promise(resolve => browser.once('exit', resolve)); browser.kill('SIGTERM'); await stopped; }
    if (server) await server.close();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}
