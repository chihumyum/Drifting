import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

const shell = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../../platform/runtime', () => ({
  getPlatformRuntime: () => ({
    isMobileShell: shell.mobile,
    isMacDesktop: false,
    desktopWindowControls: false,
  }),
}));

import { FilterChip } from '../../../components/ui/FilterChip';
import { leaveSliderGlass, takeSliderGlass } from '../../../components/ui/glass-slider-handoff';
import { SuperViewHeader } from '../../../components/SuperViewHeader';
import { coverWorkspace } from '../useInertUnderSuperView';
import { StoryGraphLaneRow } from '../../../features/graph/StoryGraphLaneRow';
import type { PositionedNode, StoryGraphLane } from '../../../features/graph/story-graph-layout';
import { designSystemDocs } from '../../../components/design-system-docs.test-support';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function onMobile<T>(render: () => T): T {
  shell.mobile = true;
  try {
    return render();
  } finally {
    shell.mobile = false;
  }
}

/** Every rule whose selector names one of `classes` (whole class names), as [selector, body]. */
function rules(css: string, classes: string[]): Array<[string, string]> {
  const named = classes.map((name) => new RegExp(`${name.replace(/[.-]/g, '\\$&')}(?![\\w-])`));
  const found: Array<[string, string]> = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (named.some((name) => name.test(selector))) found.push([selector, match[2]]);
  }
  return found;
}

const chip = (props: Partial<Parameters<typeof FilterChip>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(FilterChip, { active: true, look: 'glass', markerColor: '#88a', ...props }, '同人物'),
  );

const lane: StoryGraphLane = { id: 's1', name: '主线', color: '#88a', synthetic: false } as StoryGraphLane;
const node = (id: string, writingStatus: string) =>
  ({
    id,
    title: id,
    summary: '',
    bookOrder: 1,
    writingStatus,
    x: 0,
    y: 0,
    storyline: { color: '#88a' },
  }) as unknown as PositionedNode;
const laneRow = (glass: boolean) =>
  renderToStaticMarkup(
    createElement(StoryGraphLaneRow, {
      glass,
      lane,
      nodes: [node('a', 'finished'), node('b', 'draft'), node('c', 'finished')],
      chapterCount: 3,
      canvasContentWidth: 800,
      tileRefs: { current: new Map() },
      linkSource: 'c',
      isNodeEdgeSelected: (id: string) => id === 'a',
      onNodePointerDown: () => undefined,
      onNodeClick: () => undefined,
      onNodeDoubleClick: () => undefined,
      onNodePreviewEnter: () => undefined,
      onLanePreviewEnter: () => undefined,
      onPreviewLeave: () => undefined,
    }),
  );

describe('Super View sand and glass acceptance', () => {
  it('draws the desktop chip as clear glass with a sand dash and keeps the paper chip elsewhere', () => {
    const on = chip();
    expect(on).toContain('class="ui-chip glass glass--rest glass--small"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('kind-mark--storyline');
    expect(on).not.toContain('filter-chip');
    expect(chip({ active: false })).toContain('aria-pressed="false"');
    expect(chip({ drift: true })).toContain('kind-mark--drift');
    expect(chip({ dimmed: true, count: 0 })).toContain('is-empty');
    expect(chip({ count: 4 })).toContain('<span class="ui-chip__count">4</span>');

    // Old callers and the paused mobile shell keep the paper chip.
    const paper = renderToStaticMarkup(createElement(FilterChip, { active: true }, '全部'));
    expect(paper).toContain('filter-chip filter-chip--pill');
    expect(paper).not.toContain('glass');
    const mobile = onMobile(() => chip({ drift: true }));
    expect(mobile).toContain('filter-chip--drift-edge');
    expect(mobile).not.toContain('ui-chip');

    const css = source('src/styles/ui-controls.css');
    for (const [selector, body] of rules(css, ['ui-chip', 'ui-word-toggle'])) {
      expect(body, selector).not.toMatch(/text-transform:\s*uppercase|letter-spacing|border:\s*1px|box-shadow|background:\s*hsl\(var\(--ink-1\)\)/);
    }
    expect(css).toMatch(/\.ui-chip\[aria-pressed='false'\] > \.ui-chip__mark \{\s*opacity: 0\.35;/);
  });

  it('makes the header back round glass and the views one of three on the glass slider', () => {
    const header = renderToStaticMarkup(createElement(SuperViewHeader, { onBack: () => undefined, meta: '3' }));
    expect(header).toContain('super-view-head__back glass glass--rest glass--round');
    const mobile = onMobile(() =>
      renderToStaticMarkup(createElement(SuperViewHeader, { onBack: () => undefined })),
    );
    expect(mobile).toContain('class="super-view-head__back"');

    const switcher = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');
    expect(switcher).toContain('<GlassSlider');
    expect(switcher).toContain('getPlatformRuntime().isMobileShell');
    const relation = source('src/renderer/shells/desktop/components/DesktopSuperViewRelationControl.tsx');
    expect(relation).toContain('look="glass"');
    expect(relation).toContain("'ui-word-toggle glass glass--rest glass--small'");
    expect(relation).not.toContain("'filter-chip--drift-edge'");

    const css = source('src/styles/super-view-header.css');
    expect(css).toContain(".super-view-head__hint {");
    expect(css).toMatch(/html:not\(\[data-shell-mode='mobile'\]\) \.super-view-head__meta \{[^}]*text-transform: none;/);
  });

  it('slides the view switch glass across a Super View switch on the Review filter slider', async () => {
    // One slider for both: the Super View switch is the Review panel's
    // all/comment/TODO slider, not a copy, and draws no glass of its own.
    const switcher = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');
    expect(switcher).toContain("import { GlassSlider } from '../../../components/ui/GlassSlider';");
    expect(source('src/renderer/components/rightBars/ReviewPanel.tsx')).toContain("import { GlassSlider } from '../ui/GlassSlider';");
    expect(source('src/styles/super-view-header.css')).not.toMatch(/glass-slider__thumb|super-view-head__views[^{]*::(before|after)/);

    // Each view draws its own header, so a switch replaces the slider; the
    // shared handoff key carries the glass from the old one to the new one.
    expect(switcher).toContain('handoff="super-view-switch"');
    const slider = source('src/renderer/components/ui/GlassSlider.tsx');
    expect(slider).toContain('const shown = !placed && handedFrom ? handedFrom : thumb;');
    expect(slider).toContain("'--slider-x': `${shown?.x ?? 0}px`,");
    expect(slider).toContain('const handed = takeSliderGlass(handoff);');
    // At rest the glass is handed over without a layout read.
    expect(slider).toContain('if (performance.now() - setOff >= SPRING_MS) {\n        leaveSliderGlass(handoff, rect);');

    // What a slider leaves is taken once, in the same commit, and never later.
    const graph = { x: 72, y: 0, w: 85, h: 26 };
    leaveSliderGlass('super-view-switch', graph);
    expect(takeSliderGlass('super-view-switch')).toBe(graph);
    expect(takeSliderGlass('super-view-switch')).toBeUndefined();
    leaveSliderGlass('super-view-switch', graph);
    await Promise.resolve();
    expect(takeSliderGlass('super-view-switch')).toBeUndefined();
  });

  it('covers the whole desktop window and leaves the workspace under it inert', () => {
    // No status strip runs across the desktop window any more, so nothing of
    // the workspace (the account cell's Home) is left showing at the bottom.
    const typography = source('src/styles/desktop-typography.css');
    const desktopRoot = typography.slice(typography.indexOf("html[data-shell-mode='desktop'] {"), typography.indexOf('}'));
    expect(desktopRoot).toContain('--super-view-bottom-inset: 0px;');
    expect(desktopRoot).not.toContain('--super-view-bottom-inset: var(--ui-footer-height)');
    for (const [selector, body] of rules(source('src/styles/super-view-header.css'), ['super-view-overlay'])) {
      if (selector !== '.super-view-overlay') continue;
      expect(body).toMatch(/top: 0;[\s\S]*left: 0;[\s\S]*right: 0;[\s\S]*bottom: var\(--super-view-bottom-inset\);/);
    }

    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    expect(workspace).toContain('useInertUnderSuperView(rootRef);');
    expect(workspace).toContain('<div ref={rootRef} className="app-root desktop-app-shell">');
    // The Super Views mount beside the workspace root, never inside it.
    const shell = source('src/renderer/shells/desktop/DesktopAppShell.tsx');
    expect(shell.indexOf('<DesktopOverlayHost')).toBeGreaterThan(shell.indexOf('<DesktopWorkspace'));

    const editor = { isConnected: true, focus: vi.fn() };
    const body = {};
    const doc = { activeElement: editor as unknown, body };
    vi.stubGlobal('document', doc);
    vi.useFakeTimers();
    try {
      const root = { inert: false, contains: (node: unknown) => node === editor };
      const cover = coverWorkspace(root as unknown as HTMLElement);
      cover.set(true);
      expect(root.inert).toBe(true);
      // The workspace blurs; once the Super View is gone, focus comes back.
      doc.activeElement = body;
      cover.set(false);
      expect(root.inert).toBe(false);
      vi.runAllTimers();
      expect(editor.focus).toHaveBeenCalledWith({ preventScroll: true });

      // Focus taken elsewhere meanwhile is left alone.
      editor.focus.mockClear();
      doc.activeElement = editor;
      cover.set(true);
      cover.set(false);
      doc.activeElement = { other: true };
      vi.runAllTimers();
      expect(editor.focus).not.toHaveBeenCalled();
      cover.set(true);
      cover.dispose();
      expect(root.inert).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps the relation-type menu in two unruled parts, chips above and menu rows below', () => {
    const menu = source('src/renderer/components/ui/RelationKindMenu.tsx');
    expect(menu).toContain('relation-kind-menu--glass');
    expect(menu).toContain('className="menu-surface__item relation-kind-menu__row--glass"');
    expect(menu).toContain('className="relation-kind-menu__color glass glass--round"');
    expect(menu).toContain('<i className="sand sand--blob-2"');
    expect(menu).toContain('<GlassSlider');
    expect(menu).toContain('className="ui-field glass glass--rest glass--field glass--small"');
    expect(menu).toContain('<Button variant="primary" size="sm" onClick={save}>');
    expect(menu).toContain('<BrushIcon name="trash" size={13} />');

    const field = source('src/renderer/components/ui/RelationTypeField.tsx');
    expect(field).toContain('className="menu-surface__item relation-type-suggestions__option"');
    expect(field).toContain('<KindMark kind="storyline" color={resolveOptionColor(option.id)} />');

    // The list scrolls rather than squeezing its rows, and is no narrower than a field.
    const controls = source('src/styles/ui-controls.css');
    expect(controls).toMatch(/\.relation-kind-suggestions\.menu-surface \.relation-type-suggestions__option \{\s*flex-shrink: 0;/);
    expect(controls).toContain('min-width: var(--menu-width-wide);');
    // A glass field's caret is its selected glass, not the accent focus ring.
    expect(controls).toMatch(/\.ui-field > :is\(input, textarea\):focus-visible \{[^}]*box-shadow: none;/);

    const css = source('src/styles/super-view-header.css');
    expect(css).toContain(".super-view-head__right > :not(.header-chip-strip, .super-view-head__hint)");
    const glassMenu = css.slice(css.indexOf('Desktop relation-type menu'));
    expect(glassMenu).not.toMatch(/border-top: 1px|border-bottom: 1px|text-transform: uppercase/);
  });

  it('draws the story graph lanes as cells and the chapters as storyline glass', () => {
    const desktop = laneRow(true);
    expect(desktop).toContain('graph-rail-cell graph-rail-cell--glass');
    expect(desktop).toContain('sand-cell');
    expect(desktop).toContain('kind-mark--storyline');
    expect(desktop).toMatch(/class="graph-tile glass glass--rest is-edge-selected is-on"/);
    expect(desktop).toMatch(/class="graph-tile glass glass--rest is-draft"/);
    expect(desktop).toMatch(/class="graph-tile glass glass--rest is-link-source"/);
    expect(desktop).toContain('--glass-cc:#88a');

    const mobile = laneRow(false);
    expect(mobile).not.toContain('glass');
    expect(mobile).toContain('graph-rail__name-dot');

    const view = source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx');
    expect(view.match(/glass=\{!mobileShell\}/g)).toHaveLength(3);
    expect(view).toContain('{mobileShell && linkSource && !newEdgePair && (');
    expect(view).toContain('className="super-view-head__hint" role="status"');
    expect(view).toContain('<ModalRoot onClose={closeNewEdgeDialog}');
    expect(view).toContain('className="relation-pair"');
    expect(view).toContain('strokeWidth={mobileShell ? (selected ? 2.4 : 1.8) : selected ? 2.2 : 1.5}');

    const unplaced = source('src/renderer/features/graph/StoryGraphUnplacedChapters.tsx');
    expect(unplaced).toContain('className="menu-surface__item graph-head__unplaced-row"');
    expect(unplaced).toContain("'ui-word-toggle glass glass--rest glass--small'");

    const css = source('src/styles/graph-view.css');
    const desktopCss = css.slice(css.indexOf('Desktop (砂笔 + 素玻璃)'));
    expect(desktopCss).not.toMatch(/--accent/);
    expect(desktopCss).toMatch(/\.graph-drift-edge__halo \{\s*display: none;/);
    expect(desktopCss).toContain('.graph-drift-edge:is(:hover, .is-lit, .is-selected)');
    // The retired drift drawer and header legend are gone.
    expect(css).not.toMatch(/\.graph-drift__|\.graph-head__legend|\.graph-head__filter/);
    expect(css).toContain('.graph-pin.is-bound .graph-pin__label:not(.glass)::before');
  });

  it('turns the card popovers into floating layers with the field slip and one primary button', () => {
    const shellSource = source('src/renderer/components/ui/EntityCardPopoverShell.tsx');
    expect(shellSource).toContain("float ? 'entity-card-popover--float' : ''");
    for (const file of [
      'src/renderer/components/graph/NodeCardPopover.tsx',
      'src/renderer/features/graph/ElementCardPopover.tsx',
    ]) {
      const card = source(file);
      expect(card, file).toContain('className="entity-card__slip ui-field ui-field--area glass glass--rest glass--field"');
      expect(card.match(/variant="primary"/g), file).toHaveLength(1);
      expect(card, file).toContain('getPlatformRuntime().isMobileShell');
    }
    const css = source('src/styles/ui-controls.css');
    const float = rules(css, ['entity-card-popover--float', 'entity-card__head', 'entity-card__foot']);
    expect(float.length).toBeGreaterThan(0);
    for (const [selector, body] of float) {
      expect(body, selector).not.toMatch(/border-(top|bottom):\s*1px/);
    }

    const popover = source('src/renderer/components/graph/RelationEdgePopover.tsx');
    expect(popover).toContain('relation-edge-popover--menu');
    expect(popover).toContain('<KindMark kind="storyline" color={color} />');
  });

  it('frames the element overview in sand and draws its band as a small timeline', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    expect(view).toContain("import '../../../../styles/super-element.css';");
    expect(view).toContain('data-super-element-toggle="focus"');
    expect(view).toContain('className="super-view-head__hint"');
    expect(view).toContain('className="relation-pair"');
    for (const anchor of ['m-super-view-link-mode', 'beginSuperViewPinch', "touchAction: 'none'", "'[data-super-card]'"]) {
      expect(view).toContain(anchor);
    }
    const box = source('src/renderer/features/graph/SuperElementCategoryBox.tsx');
    expect(box).toContain('<SandCell');
    expect(box).toContain("isLinkSource ? 'is-held' : ''");

    const css = source('src/styles/super-element.css');
    expect(css).not.toMatch(/text-transform:\s*uppercase|background:\s*hsl\(var\(--ink-1\)\)|--accent|-132px|420ms|15s linear/);
    // Only the cells' rings carry a box-shadow (the glass rim), never a lift.
    for (const [selector, body] of rules(css, ['se-card', 'se-band', 'se-category'])) {
      if (/box-shadow/.test(body)) expect(selector, selector).toContain('.cell-ring');
    }
  });

  it('lays the TODO and material view on one plane with chips and a one-click entity menu', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx');
    expect(view).toContain("import '../../../../styles/super-memo-material.css';");
    expect(view).toContain('look="glass"');
    expect(view).toContain('menu-surface menu-surface--rich menu-surface--panel entity-filter-popover');
    expect(view).toContain('<TodoStatusToggle');
    expect(view.match(/mobileActions=\{mobileShell\}/g)).toHaveLength(2);

    const css = source('src/styles/super-memo-material.css');
    expect(css).not.toMatch(/box-shadow|text-transform:\s*uppercase|background:\s*hsl\(var\(--ink-1\)\)|--accent/);
    expect(css).not.toMatch(/-132px|420ms|15s linear/);
  });

  it('documents the Chip and the Super Views and closes the open gap', () => {
    const docs = designSystemDocs();
    for (const heading of ['## Chip', '## Super View 头部', '## 关系类型菜单', '## 故事图谱', '## 卡片弹层', '## TODO 与素材库', '## 要素全景']) {
      expect(docs).toContain(heading);
    }
    expect(docs).toContain('`FilterChip look="glass"`');
    expect(docs).toContain('`.ui-word-toggle`');
    const readme = source('docs/design-system/README.md');
    expect(readme).not.toContain('Chip（第二层控件）未定');
    expect(readme).not.toContain('书架与 Super View 仍有描边输入框');
  });
});
