/** Run only against the isolated dev:worktree --frontend-debug profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const catalog = JSON.parse(readFileSync('docs/qa/interface-locales.json', 'utf8'));
function command(...args) {
  const stdout = execFileSync('pnpm', ['exec', 'tsx', 'src/dev-cli/main.ts', 'frontend', ...args], { encoding: 'utf8', timeout: 30000 });
  const response = JSON.parse(stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1));
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.data.result;
}
const evaluate = expression => command('evaluate', '--expression', expression);
// The bridge reports its native app identity; refuse the author's ordinary app.
const isolated = evaluate("window.__DRIFTING_FRONTEND_DEBUG_V1__.snapshot().runtime.appInfo.name.startsWith('Drifting Test ')");
assert.equal(isolated, true, 'Native language acceptance requires an isolated worktree App');
const original = evaluate("import('/src/renderer/store/settings-store.ts').then(m=>m.useSettingsStore.getState().uiLocale)");
const samples = [];
try {
  evaluate("location.hash='/settings?section=language'");
  await delay(1000);
  for (const locale of catalog.locales) {
    const sample = evaluate(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,120));
      const select=document.querySelector('#language .ui-select'); if(!select)throw new Error('Language picker missing');
      select.click(); await wait();
      const list=document.querySelector('[role=listbox]'); const options=[...list.querySelectorAll('[role=option]')];
      const portal=list.parentElement===document.body, fixed=getComputedStyle(list).position;
      if(options.length!==9)throw new Error('Expected nine language options');
      options[${catalog.locales.indexOf(locale)}].click(); await wait();
      const {useSettingsStore}=await import('/src/renderer/store/settings-store.ts');
      const {i18next}=await import('/src/renderer/lib/i18n.ts');
      const saved=JSON.parse(localStorage.getItem('settings-storage')).state.uiLocale;
      return {locale:useSettingsStore.getState().uiLocale,lang:document.documentElement.lang,language:i18next.language,saved,portal,fixed,
        title:document.querySelector('#language .set-panel__title')?.textContent,
        selected:select.textContent.trim(),overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.equal(sample.locale, locale); assert.equal(sample.lang, locale); assert.equal(sample.language, locale);
    assert.equal(sample.saved, locale); assert(sample.portal); assert.equal(sample.fixed, 'fixed'); assert(!sample.overflow);
    const translation = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8'));
    assert.equal(sample.title, translation.settings.language.title);
    // Reload the same WebView and verify both initialization paths.
    evaluate('setTimeout(()=>location.reload(),50); true'); await delay(900);
    const restored = evaluate("import('/src/renderer/store/settings-store.ts').then(({useSettingsStore})=>({locale:useSettingsStore.getState().uiLocale,lang:document.documentElement.lang}))");
    assert.equal(restored.locale, locale); assert.equal(restored.lang, locale);
    samples.push({ ...sample, webViewReload: 'passed' });
  }
  writeFileSync('docs/qa/interface-locales-native.json', JSON.stringify({ kind: 'nine-language-interface-native', status: 'passed',
    sourceSha256: catalog.sourceSha256, platform: 'macos-tauri-wkwebview', profile: 'isolated-worktree',
    samples, limitations: ['Authenticated DOM input in WKWebView; this does not claim physical pointer or keyboard acceptance, native-speaker review, or OS process restart.'],
  }, null, 2) + '\n');
  console.log(`Passed ${samples.length} native locale/reload samples.`);
} finally {
  evaluate(`import('/src/renderer/store/settings-store.ts').then(m=>m.useSettingsStore.getState().setUiLocale(${JSON.stringify(original)}))`);
  evaluate("location.hash='/'");
}
