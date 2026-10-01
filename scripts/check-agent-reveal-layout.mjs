import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import CDP from 'chrome-remote-interface';
import { launchHeadlessBrowser, closeHeadlessSession } from './renderer-headless-browser.mjs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const { agentEditProseStyle, placeAgentRevealCaret } = require('../src/renderer/components/editor/agent-edit-animation.ts');
const { AgentRevealText } = require('../src/renderer/components/editor/AgentRevealText.tsx');

const synthetic = '这是一段用于逐帧排版验收的合成正文。每行末尾的标点、长词与后续文字都应预先参与换行。 Synthetic office affinity, punctuation (and several words),  preserved spaces and a\t tab. '.repeat(2);
const scenarios = [
  { name: 'insert', segments: [{ kind: 'ins', text: synthetic }] },
  { name: 'delete', segments: [{ kind: 'del', text: synthetic }] },
  { name: 'replace', segments: [
    { kind: 'equal', text: '固定开头。 ' },
    { kind: 'del', text: '删除的合成句子，保留原来的换行直到擦除完毕。 '.repeat(2) },
    { kind: 'ins', text: synthetic },
    { kind: 'equal', text: ' 固定中间。' },
    { kind: 'del', text: '第二个旧片段。' },
    { kind: 'ins', text: '第二个新片段。' },
    { kind: 'equal', text: ' 固定结尾。' },
  ] },
].map(({ name, segments }) => {
  const deleted = segments.filter(s => s.kind === 'del').reduce((sum, s) => sum + s.text.length, 0);
  const total = segments.filter(s => s.kind !== 'equal').reduce((sum, s) => sum + s.text.length, 0);
  return {
    name, deleted,
    oldText: segments.filter(s => s.kind !== 'ins').map(s => s.text).join(''),
    newText: segments.filter(s => s.kind !== 'del').map(s => s.text).join(''),
    // Exercise the production React markup at every character boundary, not a
    // second implementation that could agree with its own incorrect oracle.
    frames: Array.from({ length: total + 1 }, (_, progress) => renderToStaticMarkup(createElement(AgentRevealText, { segments, progress }))),
  };
});
const visibilitySegments = [
  { kind: 'equal', text: 'A' }, { kind: 'del', text: 'BCD' }, { kind: 'ins', text: 'EF' },
  { kind: 'equal', text: 'G' }, { kind: 'del', text: 'HI' }, { kind: 'ins', text: 'JK' }, { kind: 'equal', text: 'L' },
];
const visibilityCases = ['agent-reveal', 'field-diff'].flatMap(classPrefix =>
  ['ABCDGHIL', 'ACDGHIL', 'ADGHIL', 'AGHIL', 'AGIL', 'AGL', 'AEGL', 'AEFGL', 'AEFGJL', 'AEFGJKL'].map((visible, progress) => ({
    classPrefix, progress, visible,
    text: progress < 5 ? 'ABCDGHIL' : 'AEFGJKL',
    html: renderToStaticMarkup(createElement(AgentRevealText, { segments: visibilitySegments, progress, classPrefix })),
  })),
);

// Renderer-only geometry check with synthetic text and an isolated browser.
// Run: pnpm exec tsx scripts/check-agent-reveal-layout.mjs
// Add --output=<path> to regenerate the checked-in report.
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
const profile = mkdtempSync(join(tmpdir(), 'drifting-reveal-layout-'));
let browser, client;
try {
  browser = await launchHeadlessBrowser({ profile });
  client = await CDP({ port: browser.port, target: await CDP.New({ port: browser.port }) });
  await client.Page.enable();
  const { frameTree } = await client.Page.getFrameTree();
  const css = ['src/styles/index.css', 'src/styles/entity-editors.css', 'src/styles/comments-review.css'].map(file => readFileSync(file, 'utf8')).join('\n');
  await client.Page.setDocumentContent({ frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>*, *::before, *::after { box-sizing: border-box; }${css}</style></head><body><div class="editor__spread"><div class="page"><div class="page__body"><div class="ProseMirror"><p id="prose"></p></div></div></div><div class="agent-edit-layer"><div id="old" class="agent-reveal"></div><div id="fixed" class="agent-reveal"></div></div></div></body></html>` });
  const { result, exceptionDetails } = await client.Runtime.evaluate({ returnByValue: true, expression: `(() => {
    const styleFor = ${agentEditProseStyle.toString()};
    const placeCaret = ${placeAgentRevealCaret.toString()};
    const source = document.querySelector('#prose');
    const old = document.querySelector('#old');
    const fixed = document.querySelector('#fixed');
    const text = '这是一段用于排版验收的合成正文。作者调整文本区域的宽度、字体与首行缩进后，动画应当继续跟随真实段落换行。 Synthetic text with several words,  preserved spaces and a\t tab. '.repeat(5);
    for (const el of [source, old, fixed]) el.textContent = text;
    function lines(el) {
      const base = el.getBoundingClientRect();
      const node = el.firstChild;
      const range = document.createRange();
      const list = [];
      for (let i = 0; i < text.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        const y = Math.round((r.top - base.top) * 100) / 100;
        const last = list[list.length - 1];
        if (!last || last.y !== y) list.push({ y, from: i, x: Math.round((r.left - base.left) * 100) / 100 });
      }
      return list;
    }
    const cases = [];
    for (const width of [420, 720, 960]) {
      for (const indent of ['0px', '2em']) {
        document.documentElement.style.setProperty('--editor-max-width', width + 'px');
        document.documentElement.style.setProperty('--editor-indent', indent);
        document.documentElement.style.setProperty('--editor-font-size', '18px');
        const cs = getComputedStyle(source);
        const rect = source.getBoundingClientRect();
        for (const el of [old, fixed]) { el.removeAttribute('style'); el.style.position = 'absolute'; el.style.width = rect.width + 'px'; }
        for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'textAlign', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) old.style[key] = cs[key];
        Object.assign(fixed.style, styleFor(cs));
        const expected = lines(source);
        cases.push({ width, indent, paragraphWidth: rect.width, oldWidth: old.getBoundingClientRect().width, fixedWidth: fixed.getBoundingClientRect().width, oldMatches: JSON.stringify(lines(old)) === JSON.stringify(expected), fixedMatches: JSON.stringify(lines(fixed)) === JSON.stringify(expected), expectedLines: expected.length, oldLines: lines(old).length, fixedLines: lines(fixed).length, sourceWrap: cs.textWrap, fixedWrap: getComputedStyle(fixed).textWrap });
      }
    }
    // Dynamic acceptance: freeze a complete phase's layout and compare every
    // glyph on every frame, including hidden suffixes, at both editor surfaces.
    const scenarios = ${JSON.stringify(scenarios)};
    function glyphs(el, groupWords = true) {
      const base = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const list = [], positions = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < node.length; i++) {
          positions.push([node, i]);
        }
      }
      // A split inline run can report the entire ff ligature's box for either
      // half. Measure Latin shaping runs together, and CJK glyphs individually;
      // this checks layout without mistaking Range box fragmentation for motion.
      const units = el.textContent.matchAll(groupWords ? /[A-Za-z]+|[\\s\\S]/gu : /[\\s\\S]/g);
      for (const match of units) {
        const start = positions[match.index], end = positions[match.index + match[0].length - 1];
        range.setStart(start[0], start[1]); range.setEnd(end[0], end[1] + 1);
        const r = range.getBoundingClientRect();
        for (let i = 0; i < match[0].length; i++) list.push([r.left - base.left, r.top - base.top, r.width, r.height]);
      }
      return list;
    }
    // Subpixel glyph bounds can differ by one layout unit across inline runs.
    // Collapsed whitespace has no painted box and can belong to either line.
    const sameGlyph = (a, b) => b && (a[2] === 0 && b[2] === 0 || a.every((n, j) => Math.abs(n - b[j]) < 0.05));
    const sameGlyphs = (a, b) => a.length === b.length && a.every((r, i) => sameGlyph(r, b[i]));
    const dynamicCases = [];
    let caretFrames = 0, caretMismatches = 0;
    const body = source.parentElement.parentElement;
    for (const surface of ['manuscript', 'entity']) {
      body.className = surface === 'entity' ? 'elem-body' : 'page__body';
      for (const width of [420, 720, 960]) {
        for (const indent of ['0px', '2em']) {
          document.documentElement.style.setProperty('--editor-max-width', width + 'px');
          document.documentElement.style.setProperty('--editor-indent', indent);
          source.style.textIndent = indent;
          for (const scenario of scenarios) {
            let expected = glyphs(source), expectedRaw = glyphs(source, false), previousPrefix = [], prefixMismatchFrames = 0, prefixLayoutShiftFrames = 0;
            let mismatchFrames = 0, firstMismatch = null;
            for (let progress = 0; progress < scenario.frames.length; progress++) {
              const phaseText = progress < scenario.deleted ? scenario.oldText : scenario.newText;
              if (source.textContent !== phaseText) {
                source.textContent = phaseText;
                expected = glyphs(source);
                expectedRaw = glyphs(source, false);
              }
              const cs = getComputedStyle(source);
              for (const el of [old, fixed]) {
                Object.assign(el.style, styleFor(cs));
                el.style.width = source.getBoundingClientRect().width + 'px';
              }
              fixed.innerHTML = scenario.frames[progress];
              const caret = fixed.querySelector('.agent-reveal__caret');
              if (caret) {
                const boundary = Array.from(fixed.children).map(el => el.lastElementChild).find(el => el?.textContent && el.className === (progress < scenario.deleted ? 'agent-reveal__del' : 'agent-reveal__unshown'));
                placeCaret(caret, boundary);
                const range = document.createRange(); range.selectNodeContents(boundary); range.collapse(true);
                const target = range.getBoundingClientRect(), actualCaret = caret.getBoundingClientRect();
                caretFrames++;
                if (target.height && (Math.abs(actualCaret.left - target.left - 1) > 0.05 || Math.abs(actualCaret.top - target.top) > 0.05 || Math.abs(actualCaret.height - target.height) > 0.05)) caretMismatches++;
              }
              const actual = glyphs(fixed);
              if (fixed.textContent !== phaseText || !sameGlyphs(actual, expected)) {
                mismatchFrames++;
                if (!firstMismatch) {
                  const glyph = actual.findIndex((r, i) => !sameGlyph(r, expected[i]));
                  firstMismatch = { progress, glyph, actual: actual[glyph], expected: expected[glyph], text: phaseText.slice(Math.max(0, glyph - 5), glyph + 8) };
                }
              }
              if (scenario.name === 'insert') {
                old.textContent = scenario.newText.slice(0, progress);
                // Reproduce the original inline caret, which also consumed width.
                const caret = document.createElement('span');
                caret.style.cssText = 'display:inline-block;width:2px;height:1em;margin-left:1px;vertical-align:text-bottom';
                old.append(caret);
                const prefix = glyphs(old, false);
                if (!sameGlyphs(prefix, expectedRaw.slice(0, progress))) prefixMismatchFrames++;
                if (!sameGlyphs(previousPrefix, prefix.slice(0, previousPrefix.length))) prefixLayoutShiftFrames++;
                previousPrefix = prefix;
              }
            }
            dynamicCases.push({ surface, width, indent, scenario: scenario.name, frames: scenario.frames.length, mismatchFrames, firstMismatch, ...(scenario.name === 'insert' ? { prefixMismatchFrames, prefixLayoutShiftFrames } : {}) });
          }
        }
      }
    }
    const visibilityCases = ${JSON.stringify(visibilityCases)};
    let visibilityMismatches = 0;
    for (const test of visibilityCases) {
      fixed.innerHTML = test.html;
      const walker = document.createTreeWalker(fixed, NodeFilter.SHOW_TEXT);
      let visible = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (getComputedStyle(node.parentElement).visibility !== 'hidden') visible += node.textContent;
      }
      if (visible !== test.visible || fixed.textContent !== test.text) visibilityMismatches++;
    }
    return { cases, dynamicCases, caret: { frames: caretFrames, mismatches: caretMismatches }, visibility: { cases: visibilityCases.length, mismatches: visibilityMismatches } };
  })()` });
  assert.equal(exceptionDetails, undefined, JSON.stringify(exceptionDetails));
  const { cases, dynamicCases, caret, visibility } = result.value;
  const report = { schemaVersion: 2, engine: 'Chromium', scope: 'Synthetic renderer text layout; not Tauri visual acceptance', cases, dynamicCases, caret, visibility };
  console.log(JSON.stringify(report, null, 2));
  assert(cases.some(row => !row.oldMatches), 'must reproduce old mismatch');
  assert(cases.every(row => row.fixedMatches && row.fixedWidth === row.paragraphWidth), 'fixed layout must match every character line and width');
  assert(dynamicCases.some(row => row.prefixLayoutShiftFrames > 0), 'must reproduce already-painted glyphs moving during a prefix reveal');
  assert(dynamicCases.every(row => row.mismatchFrames === 0), 'every reveal frame must preserve the complete phase layout');
  assert.equal(caret.mismatches, 0, 'caret must track the measured text boundary');
  assert.equal(visibility.mismatches, 0, 'prose and fields must reveal only the expected text in each phase');
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
} finally {
  await closeHeadlessSession({ client, browser });
  rmSync(profile, { recursive: true, force: true });
}
