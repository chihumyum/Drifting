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

import { SuperElementRelateLayer } from '../../../features/graph/SuperElementRelateLayer';
import { ElementIsleDetail } from '../components/ElementIsleDetail';
import type { BookElement } from '../../../domain/book-element';
import { designSystemDocs } from '../../../components/design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const element = (id: string, name: string) => ({ id, name, summary: `${name}的设定`, categoryId: 'people', groupName: null }) as unknown as BookElement;
const elements = [element('alan', '修灯人阿岚'), element('lin', '林潮'), element('cap', '老船长')];
const noop = () => undefined;

function layer(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(SuperElementRelateLayer, {
    elements,
    colorOf: () => '#8a7fd0',
    live: { current: new Map([['alan', { x: 0, y: 0 }], ['lin', { x: 260, y: 0 }], ['cap', { x: 0, y: 200 }]]) },
    fallback: new Map(),
    edges: [
      { id: 'teach', fromId: 'alan', toId: 'lin', color: '#7a6fc0', roles: ['师父', '徒弟'], bend: 0.07, title: '修灯人阿岚 → 林潮 · 师徒' },
      { id: 'know', fromId: 'cap', toId: 'lin', color: '#4d8a5a', roles: ['旧识'], bend: 0.07, title: '老船长 → 林潮 · 旧识' },
    ],
    roleLabels: 'all',
    labelScale: 1,
    activeElementId: null,
    selectedEdgeIds: new Set<string>(),
    receding: 'none',
    focusedElementId: null,
    connectedElementIds: null,
    dimmedElementIds: null,
    hiddenElementIds: null,
    markWeights: null,
    linkSourceElementId: null,
    draggingElementId: null,
    pinnedElementIds: new Set(['lin']),
    majorElementIds: new Set(['cap']),
    edgeWidths: { normal: 1.5, selected: 2.2 },
    onElementClick: noop,
    selectEdge: noop,
    ...props,
  }));
}

describe('the element overview’s 关系 layout', () => {
  it('draws each element as a free sand cell and each relation as a line with its role names', () => {
    const html = layer();
    expect(html.match(/class="sand-cell se-card se-card--free[^"]*"/g)).toHaveLength(3);
    expect(html).toMatch(/data-element-id="lin"[^>]*>|class="sand-cell se-card se-card--free is-pinned"/);
    expect(html).toContain('is-pinned');
    expect(html).toContain('se-card--free is-major');
    expect(html.match(/data-super-edge="true"/g)).toHaveLength(2);
    // A directed relation names both ends, a symmetric one its shared role once.
    expect(html).toContain('<text>师父</text>');
    expect(html).toContain('<text>徒弟</text>');
    expect(html.match(/<text>旧识<\/text>/g)).toHaveLength(1);
    // Cells carry no summary: it stays on the hover card.
    expect(html).not.toContain('se-card__summary');
    // While only the focused element's neighbourhood shows, the other lines leave.
    const isolated = layer({ receding: 'hide', selectedEdgeIds: new Set(['teach']) });
    expect(isolated.match(/data-super-edge="true"/g)).toHaveLength(1);
    expect(layer({ receding: 'recede' })).toContain('se-relate-line is-receded');
  });

  it('marks a dragged element 已固定 on its card with the way back', () => {
    const html = renderToStaticMarkup(createElement(ElementIsleDetail, {
      name: '林潮', summary: '', categoryName: '人物', color: '#8a7fd0', mentions: 3, ticks: [],
      companions: [], relations: [], isolated: false,
      pinnedLabel: '已固定', onUnpin: noop,
      onIsolate: noop, onFocus: noop, onEdit: noop, onOpen: noop, onClose: noop,
    }));
    expect(html).toContain('<span class="se-detail__pinned">已固定</span>');
    expect(html).toContain('superElement.isles.unpin');
    const unpinned = renderToStaticMarkup(createElement(ElementIsleDetail, {
      name: '林潮', summary: '', categoryName: '人物', color: '#8a7fd0', mentions: 3, ticks: [],
      companions: [], relations: [], isolated: false,
      onIsolate: noop, onFocus: noop, onEdit: noop, onOpen: noop, onClose: noop,
    }));
    expect(unpinned).not.toContain('superElement.isles.unpin');
  });

  it('opens in 关系, switches layout from the header, keeps the islands, and moves without re-rendering the canvas', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    // The layout switch sits in the header before the counts; the legend top right in the canvas.
    expect(view).toContain('relationControl={false}');
    expect(view).toContain('metaLead={!mobileShell && <SuperElementLayoutSwitch layout={layoutMode} onLayout={chooseLayout} />}');
    expect(view.indexOf('<SuperElementLayoutSwitch')).toBeLessThan(view.indexOf('className="super-view-body"'));
    expect(source('src/renderer/components/SuperViewHeader.tsx')).toMatch(/\{navigationSlot\}\s*\{metaLead\}\s*\{meta != null/);
    // While the floating island is open the legend steps left of it.
    expect(view).toContain("? `calc(${(islandWidth * 100).toFixed(2)}% + 24px)`");
    // The islands stay: 群岛 renders the category boxes, 关系 the free cells and lines.
    expect(view).toContain("(!relateShown || islesPhase === 'leaving') && categoryModels.map");
    expect(view).toContain('{relateShown && (\n            <SuperElementRelateLayer');
    expect(view).toContain('{!relateShown && !bandSticky && !edgesViewportOnly && (');
    // Each frame only writes the layer's DOM; React hears of the layout once it rests.
    expect(view).toContain('onFrame: () => relateLayerRef.current?.paint(),');
    // A change of layout starts from and returns to where the islands show each element.
    expect(view).toContain('placeRelate(isleStarts);');
    expect(view).toContain('moveRelateTo(isleStartsAt(islesLod(camera.zoom)), () => {');
    // Dragging an element in 关系 pins it where it lands; on the islands it still changes category.
    expect(view).toContain('beginRelateDrag(held.id);');
    expect(view).toContain('endRelateDrag(held.id);');
    expect(view).toContain('updateElement(carry.id, { categoryId: target })');
    expect(view).toContain('{layoutMode === \'relate\' && (');
    expect(view).toContain('onClick={rearrangeRelate}');
    // Role names thin out from far away and in a crowded window.
    expect(view).toContain("roleLabels={lod === 'far' || relateCrowded ? 'active' : 'all'}");

    const hook = source('src/renderer/features/graph/useElementRelateLayout.ts');
    // A book with no remembered choice opens in 关系.
    expect(hook).toContain("useState<ElementLayoutMode>('relate')");
    // Reduced motion shows the end of the same run at once.
    expect(hook).toMatch(/if \(inputRef\.current\.reducedMotion\(\)\) \{\s*simulationRef\.current = null;\s*live\.current = copy\(end\);/);
    expect(hook).toContain('writeRelateRecord(projectId, {');

    const header = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');
    expect(header).toContain("relationControl && (activeSuperView === 'element' || activeSuperView === 'graph')");
    const tools = source('src/renderer/shells/desktop/components/SuperElementCanvasTools.tsx');
    expect(tools).toContain('<GlassSlider');
    expect(tools).toContain("{ value: 'relate', label: t('superElement.layout.relate') }");
    const legend = source('src/renderer/shells/desktop/components/SuperViewRelationLegend.tsx');
    expect(legend).toContain('<RelationKindMenu');
    // The story graph's relation kinds leave its header for the same legend, under its sticky rows.
    const story = source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx');
    expect(story).toContain('relationControl={false}');
    expect(story).toMatch(/<SuperViewRelationLegend\s+canvas="graph"\s+style=\{\{ top: \(isNarrative \? GRAPH_CONFIG\.AXIS_HEIGHT : actRailHeight\) \+ 10 \}\}/);
  });

  it('styles the free cells, the role names, the switch and the legend in sand and glass', () => {
    const css = source('src/styles/super-element.css');
    const shared = source('src/styles/super-view-header.css');
    expect(css).toMatch(/\.se-card\.sand-cell\.se-card--free \{[^}]*background: hsl\(var\(--paper\)\);/);
    expect(css).toMatch(/\.se-relate-role > rect \{\s*fill: hsl\(var\(--paper\)\);/);
    expect(css).toMatch(/\.se-isle-lines\.is-moving \{\s*opacity: 0;/);
    expect(css).toMatch(/\.se-layout-switch \{[^}]*display: inline-flex;/);
    expect(css).not.toContain('.se-tools');
    expect(shared).toMatch(/\.super-view-legend \{[^}]*top: 10px;[^}]*right: 12px;/);
    // A shown kind of line is the ordinary state: only the row under the pointer rings.
    expect(shared).toContain(".super-view-legend__row.glass[aria-pressed]:not(:hover, :focus-visible, :active)::before {");
    expect(shared).toMatch(/\.super-view-legend__row\[aria-pressed='false'\] > \.super-view-legend__stroke \{\s*opacity: 0\.25;/);
  });

  it('is written down and named in both languages', () => {
    const docs = designSystemDocs();
    expect(docs).toContain('**关系**布局');
    expect(docs).toContain('头部「x 类 · x 要素」左边');
    expect(docs).toContain('内容区右上角');
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')).superElement;
    const en = JSON.parse(source('src/renderer/locales/en.json')).superElement;
    expect([zh.layout.isles, zh.layout.relate, zh.relate.relayout]).toEqual(['群岛', '关系', '重新排布']);
    expect(JSON.parse(source('src/renderer/locales/zh-CN.json')).edgeKindManager.editTypes).toBe('编辑类型');
    expect([en.layout.isles, en.layout.relate]).toEqual(['Islands', 'Relations']);
  });
});
