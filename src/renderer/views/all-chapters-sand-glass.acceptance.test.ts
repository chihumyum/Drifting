import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from '../components/design-system-docs.test-support';

const root = resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('通览全书 in sand and glass', () => {
  const view = read('src/renderer/views/AllChaptersEditorView.tsx');
  const css = read('src/styles/all-chapters.css');

  it('draws no rule between chapters on the desktop', () => {
    expect(view).toContain('const desktopChrome = !getPlatformRuntime().isMobileShell;');
    // Only the paused touch shell keeps the rule under each chapter.
    expect(view).toContain('!desktopChrome && idx < orderedNodes.length - 1');
    expect(view).toContain("import '../../styles/all-chapters.css';");
  });

  it('stands an act title on the desk with one dry stroke under its name', () => {
    expect(view).toContain("className={`act-break${desktopChrome ? ' act-break--sand' : ''}`}");
    expect(view).toContain("t('allChapters.actOrdinal'");
    expect(view).toContain('className="sand sand--ul sand--arrive act-break__stroke"');

    const num = block(css, '.act-break--sand .act-break__num {', '}');
    expect(num).toContain('font-family: var(--font-structure);');
    expect(num).toContain('font-size: 15px;');
    const label = block(css, '.act-break--sand .act-break__label {', '}');
    expect(label).toContain('font-family: var(--font-content);');
    const stroke = block(css, '.act-break__stroke {', '}');
    expect(stroke).toContain('--sand-c: hsl(var(--ink-3));');
  });

  it('offers one primary and a secondary glass button when the book is empty', () => {
    expect(view).toContain("all-chap-empty__btn${desktopChrome ? ' glass glass--primary' : ''}");
    expect(view).toContain("all-chap-empty__btn${desktopChrome ? ' glass glass--rest' : ''}");
    expect(view).toContain('<BrushIcon name="torii" size={15} />');
    // No hand-written outlined buttons in the view itself.
    expect(view).not.toContain("border: '1px solid hsl(var(--rule))'");
  });

  it('keeps the desktop surfaces flat: no shadow, no wash', () => {
    expect(css).not.toMatch(/box-shadow/u);
    for (const match of css.matchAll(/background:\s*([^;]+);/gu)) {
      expect(match[1]).toBe('transparent');
    }
  });
});

describe('the manuscript folio in sand', () => {
  const row = read('src/renderer/components/editor/VirtualChapterRow.tsx');
  const indexCss = read('src/styles/index.css');

  it('names the storyline once, by its sand dash and its name in ink', () => {
    expect(read('src/renderer/views/AllChaptersEditorView.tsx')).toContain('sandFolio={desktopChrome}');
    const folio = block(row, '{sandFolio ? (', ') : (');
    expect(folio).toContain("t('virtualChapterRow.chapterNumber', { n: index + 1 })");
    expect(folio).toContain('<span className="page__folio-line page__folio-storyline">');
    expect(folio).toContain('<KindMark kind="storyline" color={storylineColor} />');
    expect(folio).not.toContain('page__chapter-mark');
    expect(folio).not.toContain('page__folio-line--accent');
    expect(folio).not.toContain('style=');
    const storyline = block(indexCss, '.page__folio-storyline {', '}');
    expect(storyline).toContain('display: inline-flex;');
    expect(storyline).toContain('color: hsl(var(--ink-3));');
  });

  it('has the new words in both locales and documents both surfaces', () => {
    for (const locale of ['zh-CN', 'en']) {
      const messages = JSON.parse(read(`src/renderer/locales/${locale}.json`)) as {
        allChapters: { actOrdinal?: unknown; actions: { backHome?: unknown } };
        virtualChapterRow: { chapterNumber?: unknown };
      };
      expect(typeof messages.allChapters.actOrdinal, locale).toBe('string');
      expect(messages.allChapters.actOrdinal as string, locale).toContain('{{n}}');
      expect(typeof messages.virtualChapterRow.chapterNumber, locale).toBe('string');
      expect(typeof messages.allChapters.actions.backHome, locale).toBe('string');
    }
    const doc = designSystemDocs();
    expect(doc).toContain('章与章之间不画线');
    expect(doc).toContain('幕名下面一笔干砂');
    expect(doc).toContain('不再在下面重复一行「— 主线 —」');
  });
});
