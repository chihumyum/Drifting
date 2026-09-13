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

function rule(text: string, selector: string): string {
  const from = text.indexOf(selector);
  const to = text.indexOf('}', from + selector.length);
  if (from < 0 || to < 0) throw new Error(`Missing rule: ${selector}`);
  return text.slice(from, to);
}

describe('shared menu surface style', () => {
  it('defines one compact action-menu shell and semantic row states', () => {
    const tokens = source('src/styles/index.css');
    const controls = source('src/styles/ui-controls.css');
    const surface = block(controls, '.menu-surface {', '.menu-surface--rich {');
    const item = block(controls, '.menu-surface__item {', '.menu-surface__item:hover');

    expect(tokens).toContain('--menu-surface-bg: hsl(var(--surface));');
    expect(tokens).toContain('--menu-surface-border: hsl(var(--rule-strong));');
    expect(tokens).toContain('--menu-surface-radius: var(--radius-sm);');
    expect(tokens).toContain('--menu-item-hover-bg: hsl(var(--paper-deep));');
    expect(tokens).toContain('--menu-item-danger: hsl(var(--destructive));');
    expect(tokens).toContain('--menu-width-compact: 180px;');
    expect(tokens).toContain('--menu-width-standard: 220px;');
    expect(tokens).toContain('--menu-width-wide: 280px;');
    expect(tokens).toContain('--menu-width-panel: 360px;');
    expect(tokens).toContain('--menu-width-settings: 420px;');
    expect(surface).toContain('border: 1px solid var(--menu-surface-border);');
    expect(surface).toContain('box-shadow: var(--menu-surface-shadow);');
    expect(surface).toContain('width: var(--menu-width-compact);');
    expect(surface).toContain('font-size: 12.5px;');
    expect(surface).toContain('line-height: 18px;');
    expect(item).toContain('min-height: 30px;');
    expect(item).toContain('padding: 6px 8px;');
    expect(item).toContain('border-radius: var(--radius-xs);');
    expect(item).toContain('overflow-wrap: anywhere;');
    expect(item).toContain('white-space: normal;');
    expect(item).not.toContain('white-space: nowrap;');
    expect(controls).toContain('.menu-surface--compact {');
    expect(controls).toContain('.menu-surface--standard {');
    expect(controls).toContain('.menu-surface--wide {');
    expect(controls).toContain('.menu-surface--panel {');
    expect(controls).toContain('.menu-surface--settings {');
    expect(controls).toContain('.menu-surface__item--danger');
    expect(controls).toContain('background: var(--menu-item-danger-hover-bg);');
  });

  it('automatically gives pointer-anchored React menus the shared shell', () => {
    const contextSurface = source('src/renderer/components/ui/ContextMenuSurface.tsx');

    expect(contextSurface).toContain("role === 'menu' ? 'menu-surface' : null");
    expect(contextSurface).toContain("'context-menu-surface'");
    expect(contextSurface).toContain("position: 'fixed'");
    expect(contextSurface).toContain('computePointSurfacePosition');
    expect(contextSurface).toContain('createPortal(');
  });

  it('covers every cursor-triggered app menu, including custom lifecycle owners', () => {
    const contextMenuFiles = [
      'src/renderer/components/leftBars/EntityCellContextMenu.tsx',
      'src/renderer/components/leftBars/SimpleContextMenu.tsx',
      'src/renderer/components/leftBars/ElementGroupPicker.tsx',
      'src/renderer/components/graph/TimelinePinMenu.tsx',
      'src/renderer/components/graph/TimelineRailMenu.tsx',
      'src/renderer/components/topBars/TopTimeline/TabContextMenu.tsx',
    ];
    for (const path of contextMenuFiles) {
      expect(source(path), path).toContain('<ContextMenuSurface');
    }

    const actRail = source('src/renderer/components/BottomTimeline/ActRail.tsx');
    const material = source('src/renderer/features/library/LibraryItemCard.tsx');
    const editor = source('src/renderer/features/editor/editor-context-menu.ts');
    expect(
      actRail.match(/className="menu-surface menu-surface--compact actrail__menu"/g),
    ).toHaveLength(2);
    expect(actRail).toContain('menu-surface__item--danger');
    expect(material).toContain(
      'className="menu-surface menu-surface--rich menu-surface--wide btl-cmenu"',
    );
    expect(material).toContain("' menu-surface__item--danger is-danger'");
    expect(editor).toContain(
      '`${MENU_CLASS} menu-surface menu-surface--compact`',
    );
    expect(editor).toContain(
      '`${MENU_CLASS} menu-surface menu-surface--compact editor-comment-menu__flyout`',
    );
    expect(editor).toContain(".className = 'menu-surface__item';");
  });

  it('aligns button dropdowns and keeps rich popovers on the same shell tokens', () => {
    const anchoredMenus = [
      'src/renderer/components/editor/EditorTopBar.tsx',
      'src/renderer/components/leftBars/ElementCategoryCreateMenu.tsx',
      'src/renderer/components/leftBars/SortMenu.tsx',
      'src/renderer/components/editor/PatchEditorCard.tsx',
    ];
    for (const path of anchoredMenus) {
      expect(source(path), path).toContain('className="menu-surface');
    }

    const richMenus = [
      'src/renderer/components/topBars/UserMenu.tsx',
      'src/renderer/features/agent/desktop/DesktopAgentPanel.tsx',
      'src/renderer/components/ui/RelationKindMenu.tsx',
      'src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx',
      'src/renderer/features/graph/StoryGraphUnplacedChapters.tsx',
      'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx',
    ];
    for (const path of richMenus) {
      expect(source(path), path).toContain('menu-surface menu-surface--rich');
    }
  });

  it('assigns every menu owner to the shared width scale instead of local widths', () => {
    const compact = [
      'src/renderer/components/BottomTimeline/ActRail.tsx',
      'src/renderer/components/graph/TimelinePinMenu.tsx',
      'src/renderer/components/graph/TimelineRailMenu.tsx',
      'src/renderer/components/leftBars/SortMenu.tsx',
      'src/renderer/components/topBars/TopTimeline/TabContextMenu.tsx',
      'src/renderer/features/editor/editor-context-menu.ts',
    ];
    for (const path of compact) {
      expect(source(path), path).toContain('menu-surface--compact');
    }

    const standard = [
      'src/renderer/components/editor/EditorTopBar.tsx',
      'src/renderer/components/leftBars/ElementCategoryCreateMenu.tsx',
      'src/renderer/components/leftBars/ElementGroupPicker.tsx',
      'src/renderer/components/leftBars/EntityCellContextMenu.tsx',
      'src/renderer/components/leftBars/SimpleContextMenu.tsx',
    ];
    for (const path of standard) {
      expect(source(path), path).toContain('menu-surface--standard');
    }

    expect(source('src/renderer/components/topBars/UserMenu.tsx')).toContain(
      "'menu-surface--panel' : 'menu-surface--wide'",
    );
    expect(source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx')).toContain(
      'menu-surface--panel agt-history-menu',
    );
    expect(source('src/renderer/components/ui/RelationKindMenu.tsx')).toContain(
      'menu-surface--settings relation-kind-menu',
    );
    expect(source('src/renderer/components/editor/PatchEditorCard.tsx')).toContain(
      'menu-surface--wide patch-card__anchor-pop',
    );
    expect(source('src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx')).toContain(
      'menu-surface--panel entity-filter-popover',
    );

    const legacyOuterRules = [
      ['src/styles/act-rail.css', '.actrail__menu {'],
      ['src/styles/timeline-pin-menu.css', '.tlpin-menu {'],
      ['src/styles/agent-panel.css', '.agt-menu {'],
      ['src/styles/bottom-timeline.css', '.btl__unplaced-popover {'],
      ['src/styles/bottom-timeline.css', '.btl-cmenu {'],
      ['src/styles/super-view-header.css', '.relation-kind-menu {'],
      ['src/styles/graph-view.css', '.graph-head__unplaced-popover {'],
      ['src/styles/entity-editors.css', '.menu-surface.patch-card__anchor-pop {'],
    ] as const;
    for (const [path, selector] of legacyOuterRules) {
      expect(rule(source(path), selector), `${path} ${selector}`).not.toMatch(
        /(?:^|\n)\s*(?:min-width|max-width|width)\s*:/,
      );
    }
  });

  it('removes the breadcrumb left accent bar and records the native-menu boundary', () => {
    const css = source('src/styles/index.css');
    const activeCrumb = block(
      css,
      '.crumb-dropdown__item--active {',
      '.crumb-dropdown__item--active:hover {',
    );
    const doc = source('docs/design-system.md');

    expect(activeCrumb).toContain('background: var(--menu-item-hover-bg);');
    expect(activeCrumb).toContain('font-weight: 500;');
    expect(activeCrumb).not.toContain('inset');
    expect(doc).toContain('右键坐标、三点按钮、排序按钮、breadcrumb');
    expect(doc).toContain('浏览器/系统原生 context menu 不属于 renderer 可定制范围');
    expect(doc).toContain('180 / 220 / 280 / 360 / 420px');
    expect(doc).toContain('单行内容稳定为 `30px`');
    expect(doc).toContain('不能证明不同平台上的字体栅格化、阴影观感');
  });
});
