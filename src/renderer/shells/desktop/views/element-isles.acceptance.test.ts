import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../../../platform/runtime', () => ({
  getPlatformRuntime: () => ({ isMobileShell: false, isMacDesktop: false, desktopWindowControls: false }),
}));

import { SuperElementCategoryBox } from '../../../features/graph/SuperElementCategoryBox';
import { buildSuperElementCategoryModel } from '../../../features/graph/super-element-category-model';
import { withElementCategoryChoices } from '../../../features/graph/canvas-hover-card';
import { isleTicks } from '../../../features/graph/element-isles-model';
import { ElementIsleDetail } from '../components/ElementIsleDetail';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import { designSystemDocs } from '../../../components/design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const category = { id: 'people', name: '人物', color: '#8a7fd0', layoutMode: 'pinned', gridX: 2, gridY: -3 } as BookElementCategory;
const element = (id: string, name: string) => ({ id, name, summary: `${name}的设定`, categoryId: 'people', groupName: null }) as unknown as BookElement;
const elements = [element('lin', '林潮'), element('cap', '老船长'), element('crew', '巡潮员'), element('far', '邮递员')];

function island(props: Record<string, unknown> = {}) {
  const model = buildSuperElementCategoryModel('people', category, elements, {
    cellHeight: 56, groupHeaderHeight: 18, paddingTop: 12, paddingBottom: 6,
  });
  return renderToStaticMarkup(createElement(SuperElementCategoryBox, {
    model,
    placement: { id: 'people', gridX: 2, gridY: -3, side: 'top' },
    onElementClick: () => undefined,
    onCategoryClick: () => undefined,
    desktop: true,
    ...props,
  }));
}

describe('the element overview as category islands', () => {
  it('draws an island whose cards recede, leave, fade when unmentioned and lift while carried', () => {
    const html = island({
      markWeights: new Map([['lin', 1], ['cap', 0.5], ['far', 0.2]]),
      dimmedElementIds: new Set(['far']),
      hiddenElementIds: new Set(['cap']),
      draggingElementId: 'lin',
      dropTarget: true,
      pinnedLabel: '已固定',
    });
    expect(html).toContain('class="se-category is-drop" data-se-category="people"');
    expect(html).toContain('<span class="se-category__pinned">已固定</span>');
    const card = (id: string) => html.match(new RegExp(`<[^>]*data-element-id="${id}"[^>]*>`))?.[0] ?? '';
    expect(card('lin')).toContain('is-lifted');
    expect(card('lin')).toContain('--se-weight:1.000');
    expect(card('cap')).toContain('is-gone');
    expect(card('far')).toContain('is-dim');
    expect(card('crew')).toContain('is-unmentioned');
    expect(card('crew')).not.toContain('--se-weight');
    // Without mention data (the paused mobile shell, or still loading) nothing reads as unmentioned.
    expect(island()).not.toContain('is-unmentioned');
  });

  it('sums the focused element up on its detail card', () => {
    const chapters = ['c1', 'c2', 'c3', 'c4'].map((id, index) => ({ id, title: `第${index + 1}章`, color: index % 2 ? '#e0b050' : '#6aa0d8' }));
    const html = renderToStaticMarkup(createElement(ElementIsleDetail, {
      name: '林潮', summary: '守灯人的女儿。', categoryName: '人物', color: '#8a7fd0', mentions: 12,
      ticks: isleTicks(chapters, new Map([['c1', 4], ['c4', 2]])),
      companions: [{ id: 'cap', name: '老船长', color: '#8a7fd0', count: 3 }],
      relations: [{ id: 'r1', typeName: '师徒', color: '#7a6fc0', incoming: true, otherName: '修灯人', otherMark: null, onSelect: () => undefined }],
      isolated: false,
      onIsolate: () => undefined, onFocus: () => undefined, onEdit: () => undefined, onOpen: () => undefined, onClose: () => undefined,
    }));
    expect(html).toContain('class="se-detail"');
    expect(html.match(/class="se-detail__tick"/g)).toHaveLength(2);
    expect(html.match(/class="se-detail__tick is-absent"/g)).toHaveLength(2);
    expect(html).toContain('--tick-c:#6aa0d8');
    expect(html.replaceAll('&quot;', '"')).toContain('superElement.isles.detail.appeared:{"appeared":2,"total":4,"first":"§01","last":"§04","gap":2}');
    expect(html).toContain('class="menu-surface__item se-detail__row"');
    expect(html).toContain('师徒 ←');
    expect(html).toContain('superElement.isles.detail.isolate');
    expect(html.match(/glass--primary/g)).toHaveLength(1);
  });

  it('changes an element’s category inside its hover card', () => {
    const groups = [{ key: 'actions', actions: [
      { key: 'categoryPicker', label: '改类目', onSelect: () => undefined },
      { key: 'deleteElement', label: '删除', danger: true },
    ] }];
    const moved: string[] = [];
    const [withChoices] = withElementCategoryChoices(groups, {
      categoryId: 'people',
      categories: [{ id: 'people', name: '人物' }, { id: 'places', name: '地点' }],
      onMove: (id) => moved.push(id),
    });
    const picker = withChoices.actions[0];
    expect(picker.onSelect).toBeUndefined();
    expect(picker.choices?.map((choice) => [choice.label, !!choice.active, !!choice.disabled])).toEqual([
      ['人物', true, true],
      ['地点', false, false],
    ]);
    picker.choices?.[1].onSelect?.();
    expect(moved).toEqual(['places']);
    expect(withChoices.actions[1].key).toBe('deleteElement');
    const [alone] = withElementCategoryChoices(groups, { categoryId: 'people', categories: [{ id: 'people', name: '人物' }], onMove: () => undefined });
    expect(alone.actions.map((action) => action.key)).toEqual(['deleteElement']);
  });

  it('keeps the band for the paused mobile shell and gives the desktop its islands', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    expect(view).toContain('const bandReservedHeightCells = mobileShell ? bandHeightCells + BAND_OUTER_RESERVE_CELLS : 1;');
    expect(view).toContain('{mobileShell && !bandSticky && (');
    expect(view).toContain('useElementMentionGraph(projectId, !mobileShell)');
    expect(view).toContain('<SuperElementIsleLines');
    // Relations go without arrowheads on the islands; the detail card says which way.
    expect(view).toContain('const directed = mobileShell && edge.directed;');
    expect(view).toContain('data-se-lod={mobileShell ? undefined : lod}');
    expect(view).toContain('className="ui-field glass glass--rest glass--field se-find"');
    expect(view).toContain('look="glass"');
    expect(view).toContain('withElementCategoryChoices(groups, {');
    // Carrying an element changes its category; carrying an island pins it.
    expect(view).toContain('updateElement(carry.id, { categoryId: target })');
    expect(view).toContain("updateCategory(carry.id, { layoutMode: 'pinned', gridX: placement.gridX + dx, gridY: placement.gridY + dy })");
    expect(view).toContain("updateCategory(target.id, { layoutMode: 'auto', gridX: null, gridY: null })");
    // A click still reaches the card: the pointer is captured only once it moves.
    expect(view).toMatch(/if \(!carry\.moved\) \{\s*if \(Math\.abs\(e\.clientX - carry\.x\) \+ Math\.abs\(e\.clientY - carry\.y\) < 5\) return;\s*carry\.moved = true;\s*try \{\s*e\.currentTarget\.setPointerCapture/);
  });

  it('washes islands in sand instead of framing them, and changes the cards with the distance', () => {
    const css = source('src/styles/super-element.css');
    expect(css).not.toContain('frame-box.png');
    expect(css).toMatch(/\.se-category::before \{\s*background: radial-gradient\(/);
    expect(css).toMatch(/\.super-view-body\[data-se-lod='far'\] \.se-card__name \{\s*display: none;/);
    expect(css).toMatch(/\.super-view-body\[data-se-lod='near'\] \.se-card__summary \{\s*display: -webkit-box;/);
    expect(css).toMatch(/\.se-card\.sand-cell\.is-dim \{\s*opacity: 0\.2;/);
    expect(css).toMatch(/\.se-detail \{[^}]*background: var\(--menu-surface-bg\);[^}]*box-shadow: var\(--menu-surface-shadow\);/);
  });

  it('is written down as the islands', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('**类目群岛**');
    expect(docs).toContain('**砂线**');
    expect(docs).toContain('没有章节带');
  });
});
