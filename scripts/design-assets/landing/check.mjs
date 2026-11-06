// Run against a generated Showcase site directory with Chromium.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import CDP from 'chrome-remote-interface';
import { closeHeadlessSession, launchHeadlessBrowser, withDeadline } from '../../renderer-headless-browser.mjs';
import { HOMES, LANG_KEY } from './locales.mjs';

const [directory, reportPath, screenshots] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node scripts/design-assets/landing/check.mjs <site directory> [report JSON] [screenshots directory]');
const root = path.resolve(directory);
// The download buttons fetch the latest release's installers by name (build.mjs).
const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const RELEASE = 'https://github.com/chihumyum/Drifting/releases/latest/download/';
const INSTALLERS = { mac: `${RELEASE}Drifting_${version}_macos_arm64.dmg`, windows: `${RELEASE}Drifting_${version}_windows_x64-setup.exe` };
const fingerprint = createHash('sha256');
for (const file of [...HOMES.map(({ file }) => file), 'assets/prefs.js', 'assets/site.css', 'assets/landing.js', 'assets/pages.js', 'sitemap.xml']) {
  fingerprint.update(file).update('\0').update(readFileSync(path.join(root, file)));
}
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1) + (path.extname(pathname) ? '' : '.html');
  const file = path.resolve(root, relative);
  try {
    if (!file.startsWith(root + path.sep)) throw new Error('outside site');
    const content = readFileSync(file);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-landing-'));
let browser, client;
try {
  browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'profile') });
  client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
  await client.Page.enable();
  await client.Runtime.enable();
  const errors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
  const evaluate = async (expression) => {
    const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return; } catch {}
      await delay(40);
    }
    const state = await evaluate('({ path: location.pathname, lang: document.documentElement.lang, languages: navigator.languages })');
    throw new Error(`Timed out waiting for ${label} at ${JSON.stringify(state)}`);
  };
  const ready = (locale) => waitFor(
    `document.readyState==='complete' && document.documentElement.lang===${JSON.stringify(locale)} && !!document.querySelector('#md-raw .line')`,
    locale + ' home',
  );
  const go = async (url, locale) => {
    const loaded = client.Page.loadEventFired();
    const navigation = await client.Page.navigate({ url: origin + url });
    assert.equal(navigation.errorText, undefined);
    if (navigation.loaderId) await withDeadline(loaded, 10000, url);
    await ready(locale);
  };
  const pointerClick = async (selector) => {
    const point = await evaluate(`(()=> {
      const element=document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({block:'nearest'});
      const {x,y,width,height}=element.getBoundingClientRect();
      return {x:x+width/2,y:y+height/2};
    })()`);
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const setLanguage = async (acceptLanguage) => client.Emulation.setUserAgentOverride({ userAgent: 'Drifting Landing Acceptance Chrome', acceptLanguage });
  const clearChoice = () => client.Storage.clearDataForOrigin({ origin, storageTypes: 'local_storage' });
  const setViewport = (width) => client.Emulation.setDeviceMetricsOverride({ width, height: 850, deviceScaleFactor: 1, mobile: false });
  const layouts = [], automatic = [];
  await client.Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Exercise CJK first, then all locales at the same widths.
  const order = ['zh-TW', 'ja', 'de', 'pt-BR', 'en', 'zh-CN', 'ko', 'es', 'fr'];
  await setLanguage('en-US');
  for (const width of [1280, 390, 320]) {
    await setViewport(width);
    for (const locale of order) {
      const home = HOMES.find((item) => item.locale === locale);
      const copy = JSON.parse(readFileSync(new URL(`copy/${locale}.json`, import.meta.url), 'utf8'));
      await go(home.path, locale);
      await evaluate('document.fonts.ready.then(()=>true)');
      await pointerClick('.language-switcher summary');
      const geometry = await evaluate(`(()=> {
        const menu=document.querySelector('.language-switcher nav');
        const header=document.querySelector('.bar-actions').getBoundingClientRect();
        const brand=document.querySelector('.bar .brand').getBoundingClientRect();
        const box=menu.getBoundingClientRect(), trigger=document.querySelector('.language-switcher summary').getBoundingClientRect();
        const tabs=[...document.querySelectorAll('.vg .sb-tabs')].map(row=>row.scrollWidth<=row.clientWidth+1);
        return {options:menu.querySelectorAll('a').length, selected:menu.querySelector('[aria-current=page]').dataset.locale,
          menuFits:box.left>=0&&box.right<=innerWidth&&box.bottom<=innerHeight&&box.width>0,
          headerFits:header.left>=brand.right&&header.right<=innerWidth,
          triggerFits:trigger.left>=0&&trigger.right<=innerWidth,
          pageFits:document.documentElement.scrollWidth<=innerWidth+1, tabsFit:tabs.every(Boolean),
          agentHeaderFits:document.querySelector('.agt-head').scrollWidth<=document.querySelector('.agt-head').clientWidth+1,
          example:document.querySelector('#md-raw').textContent,
          agent:document.querySelector('#ag-edit').textContent,
          download:document.querySelector('.hero .cta a').href,
          windowsDownload:document.querySelector('.hero .cta [data-platform=windows]').href,
          armDownload:document.querySelector('.closing-text a[href$="_windows_arm64-setup.exe"]')?.href ?? null,
          // The menu is the app's: 240 wide (or the window less its gutters), 16px corners,
          // and the page's own language ticked.
          menuStyle:box.width===Math.min(240,innerWidth-32)&&getComputedStyle(menu).borderTopLeftRadius==='16px'
            &&getComputedStyle(menu.querySelector('[aria-current=page]'),'::after').webkitMaskImage.includes('check'),
          // Where each heading, the lede and the tagline wrap: the characters on either side of every
          // line break, and whether a space or a <wbr> lies between them.
          wraps:[...document.querySelectorAll('.lede, .tagline, main h2, main h3')].flatMap((element)=>{
            const walker=document.createTreeWalker(element, NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);
            const found=[]; let previous=null, top=null, gap=false;
            for (let node=walker.nextNode(); node; node=walker.nextNode()) {
              if (node.nodeType===1) { if (node.tagName==='WBR') gap=true; continue; }
              for (let i=0;i<node.data.length;i+=1) {
                const ch=node.data[i];
                if (/\\s/.test(ch)) { gap=true; continue; }
                const range=document.createRange(); range.setStart(node,i); range.setEnd(node,i+1);
                const rect=range.getBoundingClientRect();
                if (top!==null&&rect.top>top+rect.height/2) found.push({before:previous, after:ch, gap});
                if (top===null||rect.top>top+rect.height/2) top=rect.top;
                previous=ch; gap=false;
              }
            }
            return found;
          })};
      })()`);
      for (const key of ['menuFits', 'headerFits', 'triggerFits', 'pageFits', 'tabsFit', 'agentHeaderFits', 'menuStyle']) assert(geometry[key], `${locale} at ${width}px: ${key}`);
      // Korean breaks only between words; Japanese headings only at their marked phrases
      // (or after punctuation). Neither splits a word across lines.
      if (locale === 'ko' || locale === 'ja') {
        for (const wrap of geometry.wraps) {
          assert(wrap.gap || /[、。，．・？！：；）」』]/.test(wrap.before), `${locale} at ${width}px breaks inside a word: ${wrap.before}|${wrap.after}`);
        }
      }
      assert.equal(geometry.options, 9);
      assert.equal(geometry.selected, locale);
      assert(geometry.example.includes(copy['story.opening']));
      assert(geometry.example.includes('# ' + copy['story.stairs']));
      assert(geometry.example.includes('## ' + copy['story.seventh']));
      assert(geometry.example.includes('**'));
      assert.equal(geometry.agent, copy['story.agentAfter']);
      assert.equal(geometry.download, INSTALLERS.mac);
      assert.equal(geometry.windowsDownload, INSTALLERS.windows);
      assert.equal(geometry.armDownload, `${RELEASE}Drifting_${version}_windows_arm64-setup.exe`);
      if (screenshots && width === 390 && ['zh-TW', 'ja', 'de', 'pt-BR'].includes(locale)) {
        mkdirSync(screenshots, { recursive: true });
        writeFileSync(path.join(screenshots, `landing-${locale}-390.png`), Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
      }
      await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert(await evaluate("!document.querySelector('.language-switcher').open"));
      // The hero's GitHub button asks for a star, and a download brings the note
      // asking for one into the place of the line under the buttons, without
      // moving anything (site.mjs askForStarOnDownload).
      const star = await evaluate(`(async ()=> {
        const hero=document.querySelector('.hero'), note=hero.querySelector('.star-note'), meta=hero.querySelector('.meta');
        const button=hero.querySelector('.cta .star-link');
        const before={height:hero.offsetHeight, note:getComputedStyle(note).visibility};
        addEventListener('click', (event)=>event.preventDefault(), {once:true});
        hero.querySelector('[data-platform=mac]').click();
        // The line under the buttons keeps its place until its fade is over.
        await new Promise((resolve)=>setTimeout(resolve, parseFloat(getComputedStyle(meta).transitionDuration)*1000+100));
        const closing=document.querySelector('.closing-text .star-note');
        return {before, height:hero.offsetHeight, note:getComputedStyle(note).visibility, meta:getComputedStyle(meta).visibility,
          closing:getComputedStyle(closing).visibility, button:button.textContent.trim(), buttonHref:button.href,
          mark:getComputedStyle(button.querySelector('.mk-star')).webkitMaskImage.includes('mark-star'),
          noteHref:note.querySelector('a').href, footer:document.querySelector('footer .star-link').textContent.trim()};
      })()`);
      assert.deepEqual(star, { before: { height: star.height, note: 'hidden' }, height: star.height, note: 'visible', meta: 'hidden',
        closing: 'visible', button: copy['star.button'], buttonHref: 'https://github.com/chihumyum/Drifting', mark: true,
        noteHref: 'https://github.com/chihumyum/Drifting', footer: copy['star.button'] }, `${locale} at ${width}px: star`);
      await pointerClick('#studio-sb [data-tab="elements"]');
      await pointerClick('#studio-sb [data-k="lin"]');
      assert(await evaluate("document.querySelector('[data-p=lin]').classList.contains('on')"));
      const { example, agent, download, windowsDownload, armDownload, wraps, ...layout } = geometry;
      if (locale === 'ko' || locale === 'ja') layout.headingWraps = `${wraps.length} breaks, none inside a word`;
      layouts.push({ width, locale, ...layout, markdownDemo: 'passed', studioDemo: 'passed', agentDemo: 'passed', download: 'passed', starOnDownload: 'passed' });
    }
  }
  await setViewport(390);
  for (const [browserLanguage, expected] of [
    ['zh-Hant-HK', 'zh-TW'], ['zh-Hans-TW', 'zh-CN'], ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['es-MX', 'es'],
    ['de-AT', 'de'], ['fr-CA', 'fr'], ['pt-PT', 'pt-BR'], ['en-GB', 'en'], ['ar-SA,fr-CA', 'fr'], ['ru-RU', 'en'],
  ]) {
    await clearChoice();
    await setLanguage(browserLanguage);
    const suffix = `?from=review&case=${encodeURIComponent(browserLanguage)}#agent`;
    await go('/' + suffix, expected);
    assert.equal(await evaluate('location.pathname'), HOMES.find((home) => home.locale === expected).path);
    assert.equal(await evaluate('location.search + location.hash'), suffix);
    automatic.push({ browserLanguage, locale: expected });
  }

  // An explicit page, a manual choice and a future root visit are distinct.
  await setLanguage('ja-JP');
  await go('/de', 'de');
  await pointerClick('.language-switcher summary');
  await pointerClick('[data-locale="pt-BR"]');
  await ready('pt-BR');
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(LANG_KEY)})`), 'pt-BR');
  await go('/', 'pt-BR');
  await pointerClick('footer a[href="/support#en"]');
  await waitFor("location.pathname==='/support' && document.documentElement.lang==='en'", 'English support');
  await pointerClick('#lang-btn');
  await waitFor("document.documentElement.lang==='zh-CN'", 'Chinese support');
  await pointerClick('.bar .brand');
  await ready('pt-BR');
  await go('/ja', 'ja');
  await pointerClick('.language-switcher summary');
  await pointerClick('[data-locale="en"]');
  await ready('en');
  await go('/?manual=en', 'en');
  await evaluate(`localStorage.setItem(${JSON.stringify(LANG_KEY)}, 'zh'); true`);
  await go('/', 'zh-CN');

  // A Windows visitor's Windows installer leads each row in the primary glass,
  // and the header's Download fetches it.
  await client.Emulation.setUserAgentOverride({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Drifting Landing Acceptance Chrome',
    acceptLanguage: 'zh-CN', platform: 'Win32',
    userAgentMetadata: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false },
  });
  await go('/zh', 'zh-CN');
  const visitor = await evaluate(`(()=> [...document.querySelectorAll('.downloads')].map((row)=>{
    const first=row.querySelector('a');
    return {platform:first.dataset.platform, primary:first.classList.contains('glass--primary'),
      others:[...row.querySelectorAll('[data-platform]')].filter((link)=>link!==first&&link.classList.contains('glass--primary')).length};
  }).concat([{header:document.querySelector('.bar-dl').href, target:document.querySelector('.bar-dl').target}]))()`);
  const header = visitor.pop();
  assert.equal(visitor.length, 2);
  for (const row of visitor) assert.deepEqual(row, { platform: 'windows', primary: true, others: 0 });
  assert.deepEqual(header, { header: INSTALLERS.windows, target: '' });
  // That Download fetches the installer itself, so it asks for a star too.
  assert(await evaluate(`(()=> { addEventListener('click', (event)=>event.preventDefault(), {once:true});
    document.querySelector('.bar-dl').click(); return document.documentElement.classList.contains('downloaded'); })()`));
  // Back to the Japanese browser the storage check below expects.
  await setLanguage('ja-JP');

  const blocked = await client.Page.addScriptToEvaluateOnNewDocument({
    source: 'Storage.prototype.getItem = Storage.prototype.setItem = function () { throw new Error("Storage blocked"); };',
  });
  await go('/', 'ja');
  await pointerClick('.language-switcher summary');
  await pointerClick('[data-locale="en"]');
  await ready('en');
  assert.equal(await evaluate('location.hash'), '#en');
  await client.Page.removeScriptToEvaluateOnNewDocument({ identifier: blocked.identifier });

  assert.deepEqual(errors, []);
  const report = {
    status: 'passed',
    sourceSha256: fingerprint.digest('hex'),
    layouts,
    automatic,
    manual: ['Windows visitor gets the Windows installer first', 'explicit locale URL', 'pointer switching', 'saved choice across visits', 'information pages keep the home choice', 'English with Japanese browser', 'legacy Chinese choice', 'storage unavailable'],
  };
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Passed ${layouts.length} layouts, ${automatic.length} browser language matches and ${report.manual.length} preference checks.`);
} finally {
  await closeHeadlessSession({ client, browser, server: { httpServer: server } });
  rmSync(temporary, { recursive: true, force: true });
}
