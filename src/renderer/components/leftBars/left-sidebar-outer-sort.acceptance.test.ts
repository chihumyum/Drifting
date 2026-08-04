import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing block: ${start} -> ${end}`);
  return text.slice(from, to);
}

describe('left sidebar outer-container sorting', () => {
  it('persists independent outer storyline and category preferences', () => {
    const store = source('src/renderer/store/ui-store.ts');

    expect(store).toContain(
      "export type ChapterStorylineOuterSortMode = 'storylineOrder' | 'alphabet'",
    );
    expect(store).toContain("export type ElementCategorySortMode = 'alphabet' | 'createdAt'");
    expect(store).toContain("chapterStorylineOuterSortMode: 'storylineOrder'");
    expect(store).toContain("elementCategorySortMode: 'alphabet'");
    expect(store).toContain('chapterStorylineOuterSortMode: state.chapterStorylineOuterSortMode');
    expect(store).toContain('elementCategorySortMode: state.elementCategorySortMode');
    expect(store).toContain(
      "!Object.prototype.hasOwnProperty.call(persistedState, 'elementCategorySortMode')",
    );
    expect(store).toContain('merged.elementCategorySortMode = merged.elementSortMode');
  });

  it('renders outer sorting as separate radio groups in chapter and element menus', () => {
    const subheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const en = JSON.parse(source('src/renderer/locales/en.json'));
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json'));
    const storylineMenu = block(
      subheader,
      "{activeLeftPanel === 'nodes' && chapterIsStoryline && (",
      "{activeLeftPanel === 'elements' && (",
    );
    const elementMenu = block(
      subheader,
      "{activeLeftPanel === 'elements' && (",
      'function SubIconBtn(',
    );

    expect(storylineMenu).toContain("title: t('leftSidebar.sort.outerStorylinesGroup')");
    expect(storylineMenu).toContain('options: chapterStorylineOuterSortOptions');
    expect(storylineMenu).toContain('value: chapterStorylineOuterSortMode');
    expect(elementMenu).toContain("title: t('leftSidebar.sort.outerCategoriesGroup')");
    expect(elementMenu).toContain('options: elementCategorySortOptions');
    expect(elementMenu).toContain('value: elementCategorySortMode');
    expect(subheader).toContain(
      "{ value: 'storylineOrder', label: t('leftSidebar.sort.storylineOrder') }",
    );
    expect(subheader).toContain("t('leftSidebar.sort.categoryElements')");
    expect(en.leftSidebar.sort.outerStorylinesGroup).toBe('Outer storylines');
    expect(en.leftSidebar.sort.outerCategoriesGroup).toBe('Outer categories');
    expect(zh.leftSidebar.sort.outerStorylinesGroup).toBe('外层故事线');
    expect(zh.leftSidebar.sort.outerCategoriesGroup).toBe('外层类目');
  });

  it('sorts real storylines by orderKey or name while keeping unaffiliated last', () => {
    const panel = source('src/renderer/components/leftBars/ChapterPanel.tsx');
    const outerSort = block(panel, 'const sortedStorylines = useMemo(', 'const nodeById =');
    const groupedView = block(panel, "{viewMode === 'storyline' && (", '{hoverPreview && (');

    expect(outerSort).toContain("storylineOuterSortMode === 'alphabet'");
    expect(outerSort).toContain('a.name.localeCompare(b.name');
    expect(outerSort).toContain('a.orderKey - b.orderKey');
    expect(outerSort).toContain('a.id < b.id ? -1 : a.id > b.id ? 1 : 0');
    expect(groupedView).toContain('sortedStorylines.map((storyline) =>');
    expect(groupedView.indexOf('sortedStorylines.map((storyline) =>')).toBeLessThan(
      groupedView.indexOf('key={UNAFFILIATED_GROUP_ID}'),
    );
  });

  it('decouples real-category order from element order and pins uncategorized last', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const categorySort = block(panel, 'const categoryIds = useMemo(', 'const elementsByCategory');
    const elementSort = block(
      panel,
      'const groupedByCategory = useMemo(',
      'const handleCreateElement',
    );

    expect(categorySort).toContain("categorySortMode === 'createdAt'");
    expect(categorySort).not.toContain("sortMode === 'createdAt'");
    expect(categorySort).toContain('result.push(UNCATEGORIZED_ID)');
    expect(categorySort).toContain("if (labelA === 'others') return 1");
    expect(elementSort).toContain("sortMode === 'createdAt'");
    expect(elementSort).not.toContain('categorySortMode');
  });
});
