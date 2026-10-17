import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import CDP from 'chrome-remote-interface';
import { createServer } from 'vite';
import { launchHeadlessBrowser } from './renderer-headless-browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'docs/editor/acceptance/element-summary.json');
const inputs = ['scripts/run-element-summary-acceptance.mjs', 'scripts/renderer-headless-browser.mjs',
  'src/renderer/views/ElementEditorView.tsx', 'src/renderer/components/editor/ChapterEditor.tsx',
  'src/renderer/hooks/useAutosizeTextArea.ts', 'src/renderer/locales/zh-CN.json', 'src/renderer/locales/en.json',
  'src/styles/index.css', 'src/styles/comments-review.css', 'src/styles/entity-editors.css'];
const source = Object.fromEntries(inputs.map(file => [file,
  createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
const read = file => readFileSync(path.join(root, file), 'utf8');
function jsx(file, predicate) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  function visit(node) {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && predicate(node.getText(ast))) found.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(found.length, 1, `Unique production JSX in ${file}`); return found[0];
}
const overview = jsx(inputs[2], text => text.startsWith('<section id="el-overview"'));
const chapter = jsx(inputs[3], text => text.startsWith('<textarea') && text.includes('ref={summaryRef}'));
const view = read(inputs[2]);
const locale = JSON.parse(read('src/renderer/locales/zh-CN.json'));
const labelsForNode = key => locale.elementEditor.portrait[key];
assert.equal(locale.elementEditor.sections.overview, '概述');
assert.equal((view.match(/id: 'el-overview'/g) || []).length, 1);
assert(view.includes("text: t('elementEditor.sections.overview')"));
assert(view.includes('scrollToOutlineAnchor(id, scrollEl)'));
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'passed'); assert.deepEqual(report.source, source, 'Regenerate element summary evidence.');
  assert.equal(report.samples.length, 12);
  assert.equal(report.imageScaling.length, 3);
  assert(report.checks.consistentImageCrop);
  assert(report.overlay.bottomBrightness > report.overlay.topBrightness + 60);
  assert(Math.abs(report.overlay.leftBrightness - report.overlay.topBrightness) <= 2);
  assert(Math.abs(report.overlay.rightBrightness - report.overlay.topBrightness) <= 2);
  assert(report.checks.iconOnlyAdd && report.checks.actionsRevealOnHover && report.checks.verticalWashOnly);
  console.log('Element summary evidence matches current source.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-element-summary-'));
  let server, browser, client;
  try {
    const fixture = `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
      import { useAutosizeTextArea } from '/src/renderer/hooks/useAutosizeTextArea.ts';
      import '/src/styles/index.css';
      import '/src/styles/comments-review.css';
      import '/src/styles/entity-editors.css';
      const translations = ${JSON.stringify(locale.elementEditor)};
      const t = key => key.split('.').slice(1).reduce((value, part) => value?.[part], translations) || '观测员';
      const illustration = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="320"><rect width="280" height="320" fill="#647a68"/><circle cx="140" cy="85" r="40" fill="#d9bc92"/><path d="M40 320 Q45 150 140 145 Q235 150 240 320" fill="#344b51"/><path d="M103 58 Q140 6 180 58 L185 85 Q140 61 98 89Z" fill="#383a35"/></svg>');
      const black = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="320"><rect width="280" height="320" fill="black"/></svg>');
      const initial = '合成示例：观测员负责记录山间气象，与队友整理远行计划。'.repeat(12);
      function Element({ mode, text }) {
        const curElement = { name: '观测员', aliases: ['Observer'], summary: text };
        const [summaryValue, setSummaryValue] = useState(text);
        const [nameValue, setNameValue] = useState(curElement.name);
        const [aliasDraft, setAliasDraft] = useState('');
        const summaryRef = useAutosizeTextArea(summaryValue);
        const [hasPortrait, setHasPortrait] = useState(mode === 'image' || mode === 'black');
        const portraitBusy = mode === 'busy', portraitHasImageSlot = hasPortrait || mode === 'loading';
        const portraitUrl = hasPortrait ? (mode === 'black' ? black : illustration) : null;
        const portraitAsset = portraitHasImageSlot ? { id: 'synthetic-portrait' } : null;
        const portraitError = mode === 'error' ? '合成图片加载失败。' : null;
        const summaryReviewChange = null;
        const handleImportPortrait = () => { window.__imageActions.push('import'); setHasPortrait(true); };
        const handleRemovePortrait = () => { window.__imageActions.push('remove'); setHasPortrait(false); };
        const setPortraitPreviewOpen = () => window.__imageActions.push('preview');
        const setSummaryDirty = () => {}, setNameDirty = () => {};
        const commitSummary = () => window.__saved.push(summaryValue);
        return ${overview};
      }
      function Chapter() {
        const literary = true, summary = initial;
        const [summaryValue, setSummaryValue] = useState(summary);
        const summaryRef = useAutosizeTextArea(summaryValue);
        const handleSummarySave = () => {};
        return ${chapter};
      }
      const root = createRoot(document.getElementById('root'));
      window.__saved = []; window.__imageActions = [];
      window.__render = (width, font, mode = 'empty', text = initial) => {
        document.documentElement.style.setProperty('--editor-font-size', font + 'px');
        root.render(<div style={{ width, margin: '150px auto' }} key={width + ':' + font + ':' + mode + ':' + text}>
          <article className="page--entity"><div className="page__folio">要素 · 角色</div><Element mode={mode} text={text} /></article>
          <article id="chapter"><Chapter /></article>
        </div>);
      };
      window.__render(780, 17.5);
    `;
    server = await createServer({ root, configFile: false, envDir: false, logLevel: 'error',
      cacheDir: path.join(temporary, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false },
      optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'lucide-react'] },
      plugins: [{ name: 'element-summary-fixture', configureServer(vite) {
        vite.middlewares.use('/summary.html', (_req, res) => {
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body><div id="root"></div><script type="module" src="/summary-fixture.tsx"></script></body></html>');
        });
      }, resolveId(id) { if (id === '/summary-fixture.tsx') return id; },
      load(id) { if (id === '/summary-fixture.tsx') return fixture; } }],
    });
    await server.listen();
    browser = await launchHeadlessBrowser({ profile: path.join(temporary, 'chrome') });
    client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
    await client.Page.enable(); await client.Runtime.enable();
    const evaluate = async expression => {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const settle = () => evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await client.Page.navigate({ url: `http://127.0.0.1:${server.httpServer.address().port}/summary.html` });
    for (let i = 0; i < 200 && !(await evaluate('!!document.querySelector("#el-overview textarea")')); i++) await delay(50);
    assert(await evaluate('!!document.querySelector("#el-overview textarea")'), 'Fixture mounted');
    await evaluate('document.fonts.ready');
    const samples = [];
    for (const mode of ['empty', 'image']) for (const width of [780, 380]) for (const font of [12, 17.5, 28]) {
      await evaluate(`__render(${width}, ${font}, '${mode}')`); await settle();
      const sample = await evaluate(`(() => {
        const overview = document.querySelector('#el-overview'), hero = overview.querySelector('.elem-hero');
        const summary = overview.querySelector('textarea'), chapter = document.querySelector('#chapter textarea');
        const a = summary.getBoundingClientRect(), b = hero.getBoundingClientRect(), c = overview.getBoundingClientRect();
        const name = hero.querySelector('.elem-hero__name').getBoundingClientRect();
        const aliases = hero.querySelector('.elem-hero__main > div').getBoundingClientRect();
        const art = overview.querySelector('.elem-overview__art');
        const tools = overview.querySelector('.elem-overview__portrait-tools');
        return { mode: '${mode}', width: c.width, editorFontSize: ${font}, elementFontSize: getComputedStyle(summary).fontSize,
          chapterFontSize: getComputedStyle(chapter).fontSize, fontFamily: getComputedStyle(summary).fontFamily,
          chapterFontFamily: getComputedStyle(chapter).fontFamily, lineHeight: getComputedStyle(summary).lineHeight,
          chapterLineHeight: getComputedStyle(chapter).lineHeight, belowHeader: a.top >= b.bottom,
          nameAtLeft: Math.abs(name.left - c.left) < 1, aliasesBelowName: aliases.top >= name.bottom,
          summaryGap: a.top - aliases.bottom, noPortraitSquare: !overview.querySelector('.elem-portrait'),
          transparentImageControl: getComputedStyle(tools.querySelector('button')).backgroundColor === 'rgba(0, 0, 0, 0)',
          backgroundOutOfFlow: !art || getComputedStyle(art).position === 'absolute',
          backgroundDoesNotCaptureInput: !art || getComputedStyle(art).pointerEvents === 'none',
          controlsOutOfFlow: getComputedStyle(tools).position === 'absolute',
          quietImageControl: '${mode}' === 'image' ? getComputedStyle(tools).opacity === '0' && getComputedStyle(tools).pointerEvents === 'none' : tools.textContent.trim() === '' && !!tools.querySelector('.lucide-image-plus'),
          summaryReceivesPointer: document.elementFromPoint(Math.min(a.right - 8, c.right - c.width * .3), Math.min(a.bottom - 4, a.top + 16)) === summary,
          fullWidth: Math.abs(a.width - c.width) < 1 && Math.abs(a.left - c.left) < 1,
          insideHeader: hero.contains(summary), height: a.height, scrollHeight: summary.scrollHeight,
          scrollWidth: summary.scrollWidth, summaryWidth: a.width };
      })()`);
      assert(sample.belowHeader && sample.fullWidth && !sample.insideHeader);
      assert(sample.nameAtLeft && sample.aliasesBelowName && sample.noPortraitSquare && sample.transparentImageControl);
      assert(sample.summaryGap >= 8 && sample.summaryGap <= 13);
      assert(sample.backgroundOutOfFlow && sample.backgroundDoesNotCaptureInput && sample.controlsOutOfFlow && sample.summaryReceivesPointer && sample.quietImageControl);
      assert.equal(sample.elementFontSize, sample.chapterFontSize);
      assert.equal(sample.fontFamily, sample.chapterFontFamily); assert.equal(sample.lineHeight, sample.chapterLineHeight);
      assert(sample.scrollHeight <= sample.height + 1 && sample.scrollWidth <= sample.summaryWidth + 1);
      samples.push(sample);
    }
    await evaluate(`{
      const el = document.querySelector('#el-overview textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, '简短的合成概述');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }`); await settle();
    const shortHeight = await evaluate('document.querySelector("#el-overview textarea").getBoundingClientRect().height');
    assert(shortHeight < samples.at(-1).height, 'Summary shrinks after editing');
    await evaluate('document.querySelector("#el-overview textarea").dispatchEvent(new FocusEvent("focusout", { bubbles: true }))');
    await settle();
    assert.deepEqual(await evaluate('__saved'), ['简短的合成概述']);
    const imageScaling = [];
    for (const width of [380, 600, 1000]) {
      await evaluate(`__render(${width}, 17.5, 'image')`); await settle();
      await evaluate('Promise.all(Array.from(document.images, image => image.decode()))');
      const measured = await evaluate(`(() => {
        const art = document.querySelector('.elem-overview__art'), image = art.querySelector('img');
        const r = art.getBoundingClientRect(), css = getComputedStyle(image);
        const scale = Math.max(r.width / image.naturalWidth, r.height / image.naturalHeight);
        const w = r.width / scale, h = r.height / scale;
        const [x, y] = css.objectPosition.split(' ').map(value => parseFloat(value) / 100);
        return { documentWidth: ${width}, width: r.width, height: r.height,
          objectFit: css.objectFit, objectPosition: css.objectPosition,
          sourceWindow: { x: (image.naturalWidth - w) * x / image.naturalWidth,
            y: (image.naturalHeight - h) * y / image.naturalHeight,
            width: w / image.naturalWidth, height: h / image.naturalHeight } };
      })()`);
      assert(Math.abs(measured.width / measured.height - 4 / 5) < 0.001);
      assert.equal(measured.objectFit, 'cover'); assert.equal(measured.objectPosition, '50% 25%');
      imageScaling.push(measured);
    }
    assert.equal(imageScaling[0].width, 160); assert.equal(imageScaling[2].width, 280);
    for (const measured of imageScaling) for (const key of ['x', 'y', 'width', 'height']) {
      assert(Math.abs(measured.sourceWindow[key] - imageScaling[0].sourceWindow[key]) < 0.001,
        `Visible source window changes at ${measured.documentWidth}px: ${key}`);
    }
    const pairedGeometry = samples.slice(0, 6).every((sample, i) => sample.summaryGap === samples[i + 6].summaryGap && sample.height === samples[i + 6].height);
    assert(pairedGeometry, 'Loading an image must not move or resize Summary');
    const clickLabel = async label => {
      const point = await evaluate(`(() => {
        const el = Array.from(document.querySelectorAll('.elem-overview__portrait-action')).find(el => el.textContent.trim() === ${JSON.stringify(label)} || el.getAttribute('aria-label') === ${JSON.stringify(label)});
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...point });
      await client.Input.dispatchMouseEvent({ type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await client.Input.dispatchMouseEvent({ type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await settle();
    };
    await evaluate("__render(780, 17.5, 'empty')"); await settle();
    const imageToolsOpacity = () => evaluate('getComputedStyle(document.querySelector(".elem-overview__portrait-tools")).opacity');
    const moveAway = async () => { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 0, y: 0 }); await settle(); };
    const hoverOverview = async () => {
      const point = await evaluate('(() => { const r = document.querySelector("#el-overview").getBoundingClientRect(); return { x: r.left + r.width * .68, y: r.top + 26 }; })()');
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', ...point }); await settle();
    };
    await clickLabel(labelsForNode('add')); await moveAway();
    assert.equal(await imageToolsOpacity(), '0', 'Pointer upload must not leave controls focused and visible');
    await hoverOverview(); assert.equal(await imageToolsOpacity(), '1');
    await moveAway(); assert.equal(await imageToolsOpacity(), '0');
    await client.Page.bringToFront();
    await evaluate('document.querySelector(".elem-overview__portrait-action").focus()'); await settle();
    assert.equal(await imageToolsOpacity(), '1', 'Keyboard focus reveals image controls');
    await evaluate('document.activeElement.blur()'); await settle();
    await hoverOverview();
    await clickLabel(labelsForNode('view'));
    await clickLabel(labelsForNode('replace')); await clickLabel(labelsForNode('remove'));
    await moveAway();
    assert.deepEqual(await evaluate('__imageActions'), ['import', 'preview', 'import', 'remove']);
    assert(await evaluate('!document.querySelector(".elem-overview__art")'));
    for (const mode of ['busy', 'loading', 'error']) {
      await evaluate(`__render(780, 17.5, '${mode}')`); await settle();
      if (mode === 'busy') assert(await evaluate('document.querySelector(".elem-overview__portrait-action").disabled'));
      if (mode === 'loading') assert(await evaluate('!!document.querySelector(".elem-overview__portrait-status")'));
      if (mode === 'error') assert(await evaluate('!!document.querySelector("[role=alert]")'));
    }
    await evaluate("__render(780, 17.5, 'black')"); await settle();
    await evaluate('Promise.all(Array.from(document.images, image => image.decode()))');
    const probe = await client.Page.captureScreenshot({ format: 'png' });
    const overlay = await evaluate(`(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,${probe.data}'; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const r = document.querySelector('.elem-overview__art').getBoundingClientRect();
      const pixel = (y, x = r.left + r.width / 2) => { const p = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; return Math.round((p[0] + p[1] + p[2]) / 3); };
      return { topBrightness: pixel(r.top + 12), bottomBrightness: pixel(r.bottom - 8), leftBrightness: pixel(r.top + 12, r.left + 3), rightBrightness: pixel(r.top + 12, r.right - 4), mask: getComputedStyle(document.querySelector('.elem-overview__art')).maskImage, gradient: getComputedStyle(document.querySelector('.elem-overview__art'), '::after').backgroundImage };
    })()`);
    assert(overlay.topBrightness >= 0 && overlay.topBrightness < 45);
    assert.equal(overlay.mask, 'none');
    assert(Math.abs(overlay.leftBrightness - overlay.topBrightness) <= 2);
    assert(Math.abs(overlay.rightBrightness - overlay.topBrightness) <= 2);
    assert(overlay.bottomBrightness > 235 && overlay.bottomBrightness > overlay.topBrightness + 60);
    mkdirSync(path.join(root, '.qa'), { recursive: true });
    for (const mode of ['empty', 'image']) {
      await evaluate(`__render(780, 17.5, '${mode}', '合成示例：观测员负责记录山间气象，与队友整理远行计划。'.repeat(3))`); await settle();
      await evaluate('Promise.all(Array.from(document.images, image => image.decode()))');
      await moveAway();
      const clip = await evaluate(`(() => {const r = document.querySelector('#el-overview').getBoundingClientRect(); return { x: r.left - 16, y: r.top - 114, width: r.width + 32, height: r.height + 130, scale: 1 };})()`);
      writeFileSync(path.join(root, `.qa/element-summary-${mode}.png`), Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip })).data, 'base64'));
      if (mode === 'image') {
        await hoverOverview();
        writeFileSync(path.join(root, '.qa/element-summary-image-hover.png'), Buffer.from((await client.Page.captureScreenshot({ format: 'png', clip })).data, 'base64'));
      }
    }
    writeFileSync(output, JSON.stringify({ kind: 'element-summary', status: 'passed', generatedAt: new Date().toISOString(),
      source, samples, shortHeight, imageScaling, overlay, checks: { consistentImageCrop: true, compactNameAndAliases: true, backgroundDoesNotAffectGeometry: pairedGeometry,
        portraitAddPreviewReplaceRemove: true, busyLoadingAndErrorStates: true, iconOnlyAdd: true, actionsRevealOnHover: true, actionsRevealOnKeyboardFocus: true, verticalWashOnly: true, whiteWashStrengthensDownward: true, standaloneFullWidthRow: true, chapterTypography: true,
        noClipping: true, editShrinkAndBlurCallback: true, existingOverviewToc: true },
      boundary: 'Chromium renders extracted production overview and chapter Summary JSX, shared autosizing hook and real CSS with synthetic state and save callbacks. TOC mapping is source-checked. No full Tauri app, native WebView, database or account acceptance.',
    }, null, 2) + '\n');
    console.log('Element summary: 12 layout/font/image samples, icon-only add, hover/focus controls and vertical-only bottom-to-top wash passed.');
  } finally {
    try { if (client) await client.close(); }
    finally { try { if (browser) await browser.close(); }
      finally { if (server) await server.close(); rmSync(temporary, { recursive: true, force: true }); } }
  }
}
