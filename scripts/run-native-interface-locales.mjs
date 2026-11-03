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
const samples = [], accountMenuLayouts = [];
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
    const layouts = evaluate(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,120));
      const previousSize=document.documentElement.dataset.interfaceTextSize;
      location.hash='/';
      const deadline=Date.now()+5000;
      while(Date.now()<deadline&&!document.querySelector('.pp-rail__account'))await wait();
      const trigger=document.querySelector('.pp-rail__account'); if(!trigger)throw new Error('Shelf account menu missing');
      const result=[];
      try{
        trigger.click(); await wait();
        for(const textSize of ['smallest','small','standard','large','largest']){
          document.documentElement.dataset.interfaceTextSize=textSize; await document.fonts.ready; await wait();
          const select=document.querySelector('.user-menu .ui-select'), row=select.closest('.user-menu__item');
          const label=row.children[1], value=select.querySelector('.ui-select__value');
          const range=document.createRange();range.selectNodeContents(label);
          const themeRange=document.createRange();themeRange.selectNodeContents(document.querySelector('.user-menu__item--static').children[1]);
          const menu=document.querySelector('.user-menu').getBoundingClientRect();
          result.push({textSize,label:label.textContent,lines:new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size,
            themeLines:new Set([...themeRange.getClientRects()].map(r=>Math.round(r.top))).size,
            valueClipped:value.scrollWidth>value.clientWidth+1,
            overlap:label.getBoundingClientRect().right>select.getBoundingClientRect().left,
            menuInViewport:menu.left>=0&&menu.right<=innerWidth,rowHeight:row.getBoundingClientRect().height});
        }
        document.querySelector('.user-menu .ui-select').click();await wait();
        const list=document.querySelector('[role=listbox]');
        if(list.parentElement!==document.body||getComputedStyle(list).position!=='fixed')throw new Error('Account language list must portal to body');
        list.querySelectorAll('[role=option]')[${catalog.locales.indexOf(locale)}].click();await wait();
      }finally{
        if(document.querySelector('.user-menu'))trigger.click();
        if(previousSize===undefined)delete document.documentElement.dataset.interfaceTextSize;
        else document.documentElement.dataset.interfaceTextSize=previousSize;
        location.hash='/settings?section=language';await wait();
      }
      return result;
    })()`);
    for (const layout of layouts) {
      assert.equal(layout.lines, 1, `${locale}/${layout.textSize}: language label wraps`);
      assert.equal(layout.themeLines, 1, `${locale}/${layout.textSize}: theme label wraps`);
      assert(!layout.valueClipped && !layout.overlap && layout.menuInViewport, `${locale}/${layout.textSize}: language control overflows`);
      accountMenuLayouts.push({ locale, ...layout });
    }
    samples.push({ ...sample, webViewReload: 'passed' });
  }
  writeFileSync('docs/qa/interface-locales-native.json', JSON.stringify({ kind: 'nine-language-interface-native', status: 'passed',
    sourceSha256: catalog.sourceSha256, platform: 'macos-tauri-wkwebview', profile: 'isolated-worktree',
    samples, accountMenuLayouts, limitations: ['Authenticated DOM input in WKWebView; this does not claim physical pointer or keyboard acceptance, native-speaker review, or OS process restart.'],
  }, null, 2) + '\n');
  console.log(`Passed ${samples.length} native locale/reload samples.`);
} finally {
  evaluate(`import('/src/renderer/store/settings-store.ts').then(m=>m.useSettingsStore.getState().setUiLocale(${JSON.stringify(original)}))`);
  evaluate("location.hash='/'");
}
