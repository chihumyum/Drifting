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
const laneRow = () =>
  renderToStaticMarkup(
    createElement(StoryGraphLaneRow, {
      lane,
      nodes: [node('a', 'finished'), node('b', 'draft'), node('c', 'finished')],
      chapterCount: 3,
      canvasContentWidth: 800,
      railWidth: 158,
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
  it('draws the glass chip as clear glass with a sand dash, on the phone too, and keeps the paper chip for old callers', () => {
    const on = chip();
    expect(on).toContain('class="ui-chip glass glass--rest glass--small"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('kind-mark--storyline');
    expect(on).not.toContain('filter-chip');
    expect(chip({ active: false })).toContain('aria-pressed="false"');
    expect(chip({ drift: true })).toContain('kind-mark--drift');
    expect(chip({ dimmed: true, count: 0 })).toContain('is-empty');
    expect(chip({ count: 4 })).toContain('<span class="ui-chip__count">4</span>');

    // Old callers keep the paper chip; the phone draws the same glass chip.
    const paper = renderToStaticMarkup(createElement(FilterChip, { active: true }, '全部'));
    expect(paper).toContain('filter-chip filter-chip--pill');
    expect(paper).not.toContain('glass');
    const mobile = onMobile(() => chip({ drift: true }));
    expect(mobile).toContain('class="ui-chip glass glass--rest glass--small"');
    expect(mobile).toContain('kind-mark--drift');
    expect(mobile).not.toContain('filter-chip');
    expect(source('src/renderer/components/ui/FilterChip.tsx')).not.toContain('isMobileShell');

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
    expect(mobile).toContain('class="super-view-head__back glass glass--rest glass--round"');

    // One switch on every platform: the segmented switcher is gone.
    const switcher = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');
    expect(switcher).toContain('<GlassSlider');
    expect(switcher).not.toContain('isMobileShell');
    expect(switcher).not.toContain('super-view-head__switcher');
    const relation = source('src/renderer/shells/desktop/components/DesktopSuperViewRelationControl.tsx');
    expect(relation).toContain('look="glass"');
    expect(relation).toContain('className="ui-word-toggle glass glass--rest glass--small"');
    expect(relation).not.toContain("'filter-chip--drift-edge'");
    expect(relation).not.toContain('isMobileShell');
    expect(relation).not.toContain('relation-kind-menu-trigger');

    const css = source('src/styles/super-view-header.css');
    expect(css).toContain(".super-view-head__hint {");
    expect(css).toMatch(/html\[data-shell-mode\] \.super-view-head__meta \{[^}]*text-transform: none;/);
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
    // At rest the glass is handed over without a layout read; "at rest" is
    // after the slider's own travel, the Super View push for the switch.
    expect(slider).toContain('if (performance.now() - setOff >= travelMs.current) {\n        leaveSliderGlass(handoff, rect);');
    expect(slider).toContain("'--slider-ms': `${travel?.ms ?? SPRING_MS}ms`,");
    expect(switcher).toContain('const SWITCH_TRAVEL = { ms: PUSH_MS, easing: PUSH_EASING };');
    expect(switcher).toContain('travel={SWITCH_TRAVEL}');

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
    expect(workspace).toMatch(/<div\s+ref=\{rootRef\}\s+className="app-root desktop-app-shell"/);
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
    const desktop = laneRow();
    expect(desktop).toContain('graph-rail-cell graph-rail-cell--glass');
    expect(desktop).toContain('sand-cell');
    expect(desktop).toContain('kind-mark--storyline');
    expect(desktop).toMatch(/class="graph-tile glass glass--rest is-edge-selected is-on"/);
    expect(desktop).toMatch(/class="graph-tile glass glass--rest is-draft"/);
    expect(desktop).toMatch(/class="graph-tile glass glass--rest is-link-source"/);
    expect(desktop).toContain('--glass-cc:#88a');

    // The phone draws the same lanes: no tinted tiles or name dots to fall back on.
    const mobile = onMobile(() => laneRow());
    expect(mobile).toBe(desktop);
    expect(mobile).not.toContain('graph-rail__name-dot');

    const view = source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx');
    expect(view).not.toContain('glass={!mobileShell}');
    expect(view).toMatch(/<ActRail\s+key=\{projectId\}\s+glass\s/u);
    expect(view).toMatch(/<TimelinePin\s[^>]*?\sglass\s/u);
    expect(view).toContain('{mobileShell && linkSource && !newEdgePair && (');
    expect(view).toContain('className="super-view-head__hint" role="status"');
    expect(view).toContain('<ModalRoot onClose={closeNewEdgeDialog}');
    expect(view).toContain('className="relation-pair"');
    // Every platform picks a new relation's type in the dialog shell.
    expect(view).toContain('{newEdgePair && (() => {');
    expect(view).not.toContain('graph-newedge');
    expect(view).toContain('strokeWidth={selected ? 2.2 : 1.5}');

    const unplaced = source('src/renderer/features/graph/StoryGraphUnplacedChapters.tsx');
    expect(unplaced).toContain('className="menu-surface__item graph-head__unplaced-row"');
    expect(unplaced).toContain('className="ui-word-toggle glass glass--rest glass--small"');
    expect(unplaced).not.toContain('graph-head__unplaced-chip-dot');
    expect(unplaced).not.toContain('isMobileShell');

    const css = source('src/styles/graph-view.css');
    const desktopCss = css.slice(css.indexOf('Desktop (砂笔 + 素玻璃)'));
    expect(desktopCss).not.toMatch(/--accent/);
    expect(desktopCss).toMatch(/\.graph-drift-edge__halo \{\s*display: none;/);
    expect(desktopCss).toContain('.graph-drift-edge:is(:hover, .is-lit, .is-selected)');
    // The retired drift drawer and header legend are gone.
    expect(css).not.toMatch(/\.graph-drift__|\.graph-head__legend|\.graph-head__filter/);
    expect(css).toContain('.graph-pin.is-bound .graph-pin__label:not(.glass)::before');
  });

  it('turns the card popovers into the hover card\'s own card, the expanded editor a floating layer', () => {
    const shellSource = source('src/renderer/components/ui/EntityCardPopoverShell.tsx');
    // The expanded editor floats on every platform: no bordered card, no dark scrim.
    expect(shellSource).toContain("'entity-card-popover--float',");
    expect(shellSource).toContain('<div className="entity-card-backdrop entity-card-backdrop--mist" />');
    expect(shellSource).not.toContain('isMobileShell');
    expect(shellSource).toContain("['entity-card-popover--card', 'hover-card-surface', className]");
    // A chapter or drift card: the hover card's head, its summary on a slip, its two rows.
    const node = source('src/renderer/components/graph/NodeCardPopover.tsx');
    expect(node).toContain('<EntityHoverCardHead content={head} />');
    expect(node).toContain('<label className="hover-card__slip">{summaryField}</label>');
    expect(node).toContain("icon: { brush: 'arrow-forward' },");
    expect(node.match(/variant="primary"/g)).toHaveLength(1);
    // The element popover writes on the field slip; neither card keeps a
    // bordered fallback for the phone.
    const element = source('src/renderer/features/graph/ElementCardPopover.tsx');
    expect(element).toContain('className="entity-card__slip ui-field ui-field--area glass glass--rest glass--field"');
    expect(element.match(/variant="primary"/g)).toHaveLength(1);
    for (const card of [node, element]) expect(card).not.toContain('isMobileShell');
    const css = source('src/styles/ui-controls.css');
    const float = rules(css, ['entity-card-popover--float', 'entity-card__head', 'entity-card__foot']);
    expect(float.length).toBeGreaterThan(0);
    for (const [selector, body] of float) {
      expect(body, selector).not.toMatch(/border-(top|bottom):\s*1px/);
    }

    // A relation's card is the hover card's own: its type as a sand dash, each end as a key and value.
    const popover = source('src/renderer/components/graph/RelationEdgePopover.tsx');
    expect(popover).toContain('className="relation-edge-popover--card entity-card-popover--card hover-card-surface"');
    expect(popover).toContain("mark={{ kind: 'storyline', color }}");
    expect(popover).toContain('<dl className="hover-card__kv">');
  });

  it('draws the element overview in sand, its chapter band and touch gestures kept for the phone', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    expect(view).toContain("import '../../../../styles/super-element.css';");
    // The body arrives through a deferred entry whose CSS a production build never
    // injects; the immediate shell owns the sheet (renderer-boundaries.test.ts).
    expect(source('src/renderer/shells/desktop/views/DeferredSuperViews.tsx'))
      .toContain("import '../../../../styles/super-element.css';");
    // The desktop islands (element-isles.acceptance.test.ts) dropped 聚焦 and 粘带.
    expect(view).not.toContain('data-super-element-toggle');
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
    expect(source('src/renderer/shells/desktop/views/DeferredSuperViews.tsx'))
      .toContain("import '../../../../styles/super-memo-material.css';");
    expect(view).toContain('look="glass"');
    expect(view).toContain('menu-surface menu-surface--rich menu-surface--panel entity-filter-popover');
    expect(view).toContain('<TodoStatusToggle');
    // Only behaviour asks for the touch screen: the library cards' explicit menus.
    expect(view.match(/mobileActions=\{touchActions\}/g)).toHaveLength(2);
    expect(view.match(/const touchActions = getPlatformRuntime\(\)\.isMobileShell;/g)).toHaveLength(2);
    expect(view).not.toMatch(/\bmobileShell\b|LEGACY_/u);

    const css = source('src/styles/super-memo-material.css');
    expect(css).not.toMatch(/box-shadow|text-transform:\s*uppercase|background:\s*hsl\(var\(--ink-1\)\)|--accent/);
    expect(css).not.toMatch(/-132px|420ms|15s linear/);
  });

  it('shelves comments beside the TODOs and lets each rail be dragged wider into more columns', () => {
    const view = source('src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx');
    // The comment rail sits between the TODOs and the library, on every platform.
    expect(view).toMatch(/<TodoRail[\s\S]*<CommentRail[\s\S]*<LibraryItemMain/);
    expect(view).not.toMatch(/!mobileShell && \(\s*<CommentRail/);
    // Review's own cards, grouped by what they are written on.
    expect(view).toContain('groupReviewItems(openNotes, groupData)');
    expect(view).toContain('<ReviewItemCard');
    expect(view).toContain('className="review-group review-group--glass smm-comment-group"');
    expect(view).toContain('kind="note"');
    // The entity filter reaches comments written on the entity, not only related ones.
    expect(view).toContain('comment.targetKind === entityFilter.kind && comment.targetId === entityFilter.id');
    // Both rails carry a dragged edge that bleeds glass and is remembered.
    expect(view.match(/<RailEdge label=/g)).toHaveLength(2);
    expect(view).toContain('role="separator"');
    expect(view).toContain('stepGlassFlow(edge, Math.abs(moveEvent.clientX - lastX))');
    expect(view).toContain('<span className="flow-line flow-line--v smm-rail__edge-flow" aria-hidden="true" />');
    expect(view).toContain('storeRailWidths(next)');

    const css = source('src/styles/super-memo-material.css');
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.smm-rail')).toContain('min-width: 240px;');
    expect(rule('.smm-rail')).not.toMatch(/(^|\s)width:/);
    // TODO cards fill a grid; comment groups flow whole down newspaper columns.
    expect(rule('.smm-rail__list')).toContain('grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));');
    expect(view).toContain('<div className="smm-comment-columns">{groups.map(renderGroup)}</div>');
    expect(rule('.smm-comment-columns')).toContain('column-width: 240px;');
    expect(rule('.smm-comment-columns > .review-group.smm-comment-group')).toContain('break-inside: avoid;');
    expect(rule('.smm-rail__edge')).toContain('cursor: col-resize;');
    expect(rule('.smm-main')).toContain('min-width: 360px;');
  });

  it('sets TODO, comment and material cards in the same interface text roles', () => {
    const cards = source('src/styles/material-workbench.css');
    const rule = (selector: string) => cards.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    // The comment card is Review's: body in the body role, its head index type in secondary.
    const review = source('src/styles/comments-review.css');
    expect(review).toContain('font: var(--ui-font-body, 13px)/1.4 var(--font-sans);');
    expect(review).toContain('font: var(--ui-font-secondary, 9px)/1.2 var(--font-mono);');
    // The TODO and material cards beside it follow the same setting; their old
    // sizes are only the smallest setting's fallbacks.
    expect(rule('.todo-card--glass .todo-card__body')).toContain('font: var(--ui-font-body, 13px)/1.4 var(--font-sans);');
    expect(rule('.todo-card--glass .todo-card__header')).toContain('font: var(--ui-font-secondary, 9px)/1.2 var(--font-mono);');
    expect(rule('.todo-card--glass .todo-card__header')).not.toMatch(/uppercase|letter-spacing/);
    // ＋ 关联 is one text button on all three cards and in the right sidebar:
    // the TODO card's own and the shared relation picker's, the phone's too.
    const controls = source('src/styles/ui-controls.css');
    const addButton = controls.match(/\n\.relation-add-button \{([^}]*)\}/)?.[1] ?? '';
    expect(addButton).toContain('font: var(--ui-font-caption, 11.5px) var(--font-sans);');
    expect(addButton).toContain('border: 0;');
    expect(addButton).toContain('text-transform: none;');
    expect(source('src/renderer/features/library/TodoCard.tsx')).toContain('className="relation-add-button"');
    const picker = source('src/renderer/components/rightBars/EntityRelationPicker.tsx');
    expect(picker).toContain('className="entity-relation-picker__add relation-add-button"');
    expect(picker).not.toContain('dashed');
    expect(picker).not.toContain('isMobileShell');
    expect(cards).not.toContain('.todo-card__relate');
    expect(rule('.library-item-card__title')).toContain('font: 500 var(--ui-font-body, 13px)/1.35 var(--font-sans);');
    expect(rule('.library-item-card__meta')).toContain('font: var(--ui-font-secondary, 10px)/1.4 var(--font-mono);');
    expect(rule('.library-item-card__excerpt .note-excerpt')).toContain('font-size: var(--ui-font-body, 12.5px);');
    // The sidebar tree keeps its compact excerpt.
    expect(rule('.note-excerpt')).toContain('font-size: 12.5px;');
  });

  it('documents the Chip and the Super Views and closes the open gap', () => {
    const docs = designSystemDocs();
    for (const heading of ['## Chip', '## Super View 头部', '## 关系类型菜单', '## 故事图谱', '## 卡片弹层', '## 审阅与素材', '## 要素全景']) {
      expect(docs).toContain(heading);
    }
    expect(docs).toContain('`FilterChip look="glass"`');
    expect(docs).toContain('`.ui-word-toggle`');
    const readme = source('docs/design-system/README.md');
    expect(readme).not.toContain('Chip（第二层控件）未定');
    expect(readme).not.toContain('书架与 Super View 仍有描边输入框');
  });
});
