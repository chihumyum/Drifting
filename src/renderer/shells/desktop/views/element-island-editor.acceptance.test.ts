import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, useContext, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

import { SuperElementIsland } from '../components/SuperElementIsland';
import { ISLAND_WIDTH_DEFAULT, clampIslandWidth } from '../components/super-element-island-width';
import { CategoryIsleDetail, CategoryIsleStrip } from '../components/ElementIsleDetail';
import { TabPromotionSuppressedContext } from '../../../store/tab-promotion-context';
import { EditorRailPresentationContext } from '../../../components/editor/editor-rail-presentation';
import { usePromoteCurrentTab, useUiStore } from '../../../store/ui-store';
import { designSystemDocs } from '../../../components/design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const noop = () => undefined;

function island(mode: 'peek' | 'sheet', editor: ReactNode, widthRatio = 0.5) {
  return renderToStaticMarkup(createElement(SuperElementIsland, {
    mode,
    title: '林潮',
    kindLabel: '要素 · 人物',
    peek: createElement('div', { className: 'peek-probe' }),
    strip: createElement('div', { className: 'strip-probe' }),
    editor,
    widthRatio,
    onWidthRatio: noop,
    onCollapse: noop,
    onClose: noop,
    onOpenInTab: noop,
  }));
}

function SuppressionProbe() {
  const rail = useContext(EditorRailPresentationContext);
  return createElement('span', {
    'data-suppressed': String(useContext(TabPromotionSuppressedContext)),
    'data-outline': String(rail?.outlineVisible),
    'data-outline-owned': String(typeof rail?.onOutlineToggle === 'function'),
  });
}

const members = [
  { id: 'lin', name: '林潮', mentions: 12 },
  { id: 'crew', name: '巡潮员', mentions: 0 },
];

describe('the element overview’s floating island', () => {
  it('starts as a small card that holds no editor', () => {
    const html = island('peek', createElement('div', { className: 'editor-probe' }));
    // The small card is the hover card's own card (rounded, edged in resting glass).
    expect(html).toContain('class="se-island se-island--peek hover-card-surface"');
    expect(html).toContain('data-super-modal');
    expect(html).toContain('class="peek-probe"');
    expect(html).not.toContain('editor-probe');
    expect(html).not.toContain('role="separator"');
  });

  it('grows into a sheet holding the workspace editor, its left edge dragged between 15% and 75%', () => {
    const html = island('sheet', createElement(SuppressionProbe), 0.5);
    expect(html).toContain('class="se-island se-island--sheet"');
    expect(html).toContain('style="width:50.00%"');
    expect(html).toMatch(/class="se-island__edge" role="separator" aria-orientation="vertical"[^>]*aria-valuemin="15" aria-valuemax="75" aria-valuenow="50"/);
    expect(html).toContain('class="flow-line flow-line--v se-island__edge-flow"');
    // The editor edits without promoting whichever tab sits under the Super
    // View, and opens with its outline folded, the toolbar button the island's own.
    expect(html).toContain('<div class="se-island__body"><span data-suppressed="true" data-outline="false" data-outline-owned="true"></span></div>');
    expect(html).toContain('<div class="se-island__strip"><div class="strip-probe"></div>');
    expect(html).toContain('superElement.isles.island.fold');
    expect(html).toContain('data-se-open-tab=""');
    expect(html).toContain('superElement.isles.island.collapse');
    expect(html).not.toContain('peek-probe');
  });

  it('keeps the width between its bounds', () => {
    expect(clampIslandWidth(0.05)).toBe(0.15);
    expect(clampIslandWidth(0.9)).toBe(0.75);
    expect(clampIslandWidth(0.4)).toBe(0.4);
    expect(clampIslandWidth(Number.NaN)).toBe(ISLAND_WIDTH_DEFAULT);
  });

  it('does not promote the current tab from an editor inside the island', () => {
    const promoted: string[] = [];
    const original = useUiStore.getState().promoteTab;
    useUiStore.setState({ promoteTab: ((projectId: string) => { promoted.push(projectId); }) as typeof original });
    function Editing({ projectId }: { projectId: string }) {
      const promote = usePromoteCurrentTab(projectId);
      promote();
      return null;
    }
    try {
      renderToStaticMarkup(createElement(Editing, { projectId: 'workspace' }));
      renderToStaticMarkup(createElement(TabPromotionSuppressedContext.Provider, { value: true }, createElement(Editing, { projectId: 'island' })));
    } finally {
      useUiStore.setState({ promoteTab: original });
    }
    expect(promoted).toEqual(['workspace']);
  });

  it('shows a category as its elements, most mentioned first', () => {
    const card = renderToStaticMarkup(createElement(CategoryIsleDetail, {
      name: '人物', color: '#8a7fd0', members, onFocus: noop, onEdit: noop, onOpen: noop, onClose: noop,
    })).replaceAll('&quot;', '"');
    expect(card).toContain('superElement.isles.island.categoryMeta:{"count":2}');
    // Its elements are the card's rows, each led by its square seal, the count at the far end.
    expect(card.match(/class="hover-card__row"/g)).toHaveLength(4);
    expect(card).toContain('<span class="hover-card__row-aside">superElement.isles.island.mentions:{"count":12}</span>');
    expect(card).toContain('superElement.isles.island.unmentioned');
    expect(card).toContain('data-se-open-tab=""');
    // 编辑 is a row like the rest: no primary button on the card.
    expect(card).not.toContain('glass--primary');
    expect(card).toContain('class="hover-card__head"');
    const strip = renderToStaticMarkup(createElement(CategoryIsleStrip, { color: '#8a7fd0', members, onFocus: noop }));
    expect(strip.match(/class="se-strip__chip"/g)).toHaveLength(2);
    expect(strip).toContain('superElement.isles.island.mostMentioned');
  });

  it('mounts the workspace editors on the overview and moves 正文同段 into the relation menu', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    expect(view).toContain('<ElementEditorView key={islandSubject.id} elementIdOverride={islandSubject.id} />');
    expect(view).toContain('<CategoryEditorView key={islandSubject.id} categoryIdOverride={islandSubject.id} />');
    // A category opens on the island; the paused mobile shell still leaves for its tab.
    expect(view).toMatch(/if \(!mobileShell\) \{\s*setIsleCategory\(\(current\) => /);
    expect(view).toMatch(/return;\s*\}\s*openEntity\(\{ entityType: 'category', id \}\);\s*close\(\);/);
    // Escape folds the sheet back into its card before the island closes.
    expect(view).toContain("id: `island-sheet:${isleFocus ?? isleCategory ?? ''}`,");
    expect(view).toContain("onEscape: () => setIslandMode('peek'),");
    // The island's editor scrolls itself instead of panning the canvas.
    expect(view).toContain("if ((e.target as Element | null)?.closest?.('[data-super-modal]')) return;");
    expect(view).toContain('relationMenuLead={mobileShell ? undefined : (');
    expect(view.match(/data-se-lines=""/g)).toHaveLength(1);
    expect(view.indexOf('data-se-lines=""')).toBeLessThan(view.indexOf('rightSlot={'));
    const header = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');
    expect(header).toContain('<DesktopSuperViewRelationControl canvas={relationCanvas} lead={relationMenuLead} />');
    const topBar = source('src/renderer/components/editor/EditorTopBar.tsx');
    expect(topBar).toContain("const visible = owned ? presentation.outlineVisible === true : mode === 'visible';");
    expect(topBar).toContain("onClick={owned ?? (() => setMode(visible ? 'hidden' : 'visible'))}");
    expect(source('src/renderer/components/ui/RelationKindMenu.tsx')).toMatch(/\{lead\}\s*<section className="relation-kind-menu__section">/);
  });

  it('is a lifted piece of desk with rounded corners and no glass, written down as the island', () => {
    const css = source('src/styles/super-element.css');
    expect(css).toMatch(/\.se-island \{[^}]*border-radius: 10px;[^}]*background: var\(--menu-surface-bg\);/);
    expect(css).toMatch(/\.se-island \{[^}]*user-select: text;/);
    expect(css).toMatch(/\.se-island--sheet \{[^}]*top: 12px;[^}]*right: 12px;[^}]*bottom: 12px;[^}]*border-radius: 14px;/);
    expect(css).toMatch(/\.se-island__body \{[^}]*background: hsl\(var\(--paper\)\);/);
    expect(css).not.toMatch(/\.se-island[^{]*\{[^}]*glass-texture/);
    // Narrow, the header keeps the name, 收成小卡 and close; the card still opens the tab.
    expect(css).toMatch(/\.se-island\.is-compact \.se-island__kind,\s*\.se-island\.is-compact \.se-island__open \{\s*display: none;/);
    expect(source('src/renderer/shells/desktop/components/SuperElementIsland.tsx')).toContain('setCompact(entry.contentRect.width < COMPACT_WIDTH)');
    const docs = designSystemDocs();
    expect(docs).toContain('**浮岛**');
    expect(docs).toContain('15% 到 75%');
    expect(docs).toContain('浮岛窄于 `360px` 时');
    expect(docs).toContain('默认收起大纲');
    expect(docs).toContain('TabPromotionSuppressedContext');
    expect(docs).toContain('「自动连线」');
  });
});
