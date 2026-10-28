import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
    const separator = block(controls, '.menu-surface__divider,', '.user-menu__group {');

    // Menus are a lifted piece of the desk: the sidebar's opaque colour,
    // square, a half-pixel hairline and the floating shadow, with no glass
    // of their own; only the row under the pointer shows hairline glass
    // along its edges; rows carry no fill; groups are separated by space.
    expect(tokens).toContain('--menu-surface-bg: var(--workspace-ui-bg);');
    expect(tokens).toContain('--menu-surface-border: transparent;');
    expect(tokens).toContain('--menu-surface-radius: 0;');
    expect(tokens).toContain('0 0 0 0.5px hsl(var(--ink-1) / 0.16),');
    expect(tokens).toContain('--menu-item-hover-bg: hsl(var(--ink-1) / 0.05);');
    expect(tokens).toContain('--menu-item-danger: hsl(var(--destructive));');
    expect(tokens).toContain('--menu-width-compact: 180px;');
    expect(tokens).toContain('--menu-width-standard: 220px;');
    expect(tokens).toContain('--menu-width-wide: 280px;');
    expect(tokens).toContain('--menu-width-panel: 360px;');
    expect(tokens).toContain('--menu-width-settings: 420px;');
    expect(surface).toContain('border: 1px solid var(--menu-surface-border);');
    expect(surface).toContain('box-shadow: var(--menu-surface-shadow);');
    expect(surface).toContain('width: var(--menu-width-compact);');
    expect(surface).toContain('font-size: var(--ui-font-body, 12.5px);');
    expect(surface).toContain('line-height: var(--ui-line-body, 18px);');
    expect(surface).not.toContain('backdrop-filter');
    expect(controls).not.toContain('.menu-surface::before {');
    // The hovered row is one whole ring, no open sides.
    expect(controls).not.toContain(".menu-surface__item::after {");
    expect(controls).toContain('inset: 1px 4px;');
    expect(item).toContain('min-height: var(--ui-row-height, 30px);');
    expect(item).toContain('padding: 6px 14px;');
    expect(item).toContain('border-radius: 0;');
    expect(controls).toContain(
      "html:not([data-shell-mode='mobile']) .menu-surface__item:hover:not(:disabled)::before,",
    );
    expect(separator).toContain('height: 8px;');
    expect(separator).toContain('background: transparent;');
    expect(item).toContain('overflow-wrap: anywhere;');
    expect(item).toContain('white-space: normal;');
    expect(item).not.toContain('white-space: nowrap;');
    expect(controls).toContain('.menu-surface--compact {');
    expect(controls).toContain('.menu-surface--standard {');
    expect(controls).toContain('.menu-surface--wide {');
    expect(controls).toContain('.menu-surface--panel {');
    expect(controls).toContain('.menu-surface--settings {');
    expect(controls).toContain('.menu-surface__item--danger');
    expect(controls).toContain('color: var(--menu-item-danger);');
  });

  it('automatically gives pointer-anchored React menus the shared shell', () => {
    const contextSurface = source('src/renderer/components/ui/ContextMenuSurface.tsx');

    expect(contextSurface).toContain("role === 'menu' ? 'menu-surface' : null");
    expect(contextSurface).toContain("'context-menu-surface'");
    expect(contextSurface).toContain("position: 'fixed'");
    expect(contextSurface).toContain('computePointSurfacePosition');
    expect(contextSurface).toContain('createPortal(');
  });

  it('has no right-click menus: right-click is the system menu and actions live in hover cards', () => {
    // Every desktop renderer source (the paused touch shell, tests and
    // performance fixtures aside) leaves contextmenu alone; a capture-phase
    // handler may only dismiss a hover card so the native menu is not covered.
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src/renderer'], { encoding: 'utf8' })
      .split('\n')
      .filter((path) => /\.(tsx?|mjs)$/.test(path) && existsSync(path))
      .filter((path) => !path.includes('/shells/mobile/') && !path.includes('/performance/') && !/\.test\.tsx?$/.test(path));
    const offenders: string[] = [];
    for (const path of files) {
      source(path).split('\n').forEach((line, index) => {
        if (/onContextMenu(?!Capture)\b|addEventListener\(\s*['"]contextmenu['"]/.test(line)) offenders.push(`${path}:${index + 1}`);
        if (/onContextMenuCapture=/.test(line) && !/\.dismiss\b/.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);

    for (const removed of [
      'src/renderer/components/leftBars/EntityCellContextMenu.tsx',
      'src/renderer/components/leftBars/SimpleContextMenu.tsx',
      'src/renderer/components/topBars/TopTimeline/TabContextMenu.tsx',
      'src/renderer/components/graph/TimelinePinMenu.tsx',
      'src/renderer/components/graph/TimelineRailMenu.tsx',
      'src/renderer/features/editor/editor-context-menu.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), removed)), removed).toBe(false);
    }

    // The shared card: interactive, with its actions along the bottom.
    const card = source('src/renderer/components/ui/HoverCard.tsx');
    const controls = source('src/styles/ui-controls.css');
    expect(card).toContain('export function HoverCardShell(');
    expect(card).toContain('<HoverCardActions groups={groups} onDone={onDismiss} />');
    expect(rule(controls, '.hover-card--interactive {')).toContain('pointer-events: auto;');
    expect(source('src/renderer/features/entities/hover/entity-hover-card-model.ts')).toContain('const HOVER_CARD_GRACE_MS = 220;');
    for (const owner of [
      'src/renderer/components/leftBars/ChapterPanel.tsx',
      'src/renderer/components/leftBars/ElementPanel.tsx',
      'src/renderer/components/leftBars/DriftPanel.tsx',
      'src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx',
      'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
      'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx',
    ]) {
      expect(source(owner), owner).toMatch(/entityHoverActions\(|withDriftGroupChoices\(/);
    }
    for (const owner of [
      'src/renderer/components/BottomTimeline/ActRail.tsx',
      'src/renderer/components/timeline/TimelinePin.tsx',
      'src/renderer/components/topBars/TopTimeline/TopTimeline.tsx',
      'src/renderer/features/library/LibraryItemCard.tsx',
      'src/renderer/features/library/MaterialFolderTree.tsx',
    ]) {
      expect(source(owner), owner).toContain('<HoverCardShell');
    }
    expect(source('src/renderer/features/comments/CommentSourceHoverCard.tsx')).toContain('<HoverCardActions');

    // The editor's selection actions float over the selection as one bar.
    const bar = source('src/renderer/features/editor/editor-selection-bar.ts');
    expect(bar).toContain("bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-orientation', 'horizontal');");
    expect(bar).toContain('const SETTLE_MS = 180;');
    expect(source('src/renderer/hooks/useEntityEditor.ts')).not.toContain('contextmenu:');
    expect(rule(source('src/styles/comments-review.css'), '.editor-selection-bar {')).toContain('flex-direction: row;');
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
      'src/renderer/components/leftBars/SortMenu.tsx',
    ];
    for (const path of compact) {
      expect(source(path), path).toContain('menu-surface--compact');
    }

    const standard = [
      'src/renderer/components/editor/EditorTopBar.tsx',
      'src/renderer/components/leftBars/ElementCategoryCreateMenu.tsx',
      'src/renderer/components/leftBars/ElementGroupPicker.tsx',
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

  it('drops the editor breadcrumb menus and records the native-menu boundary', () => {
    const css = source('src/styles/index.css');
    const doc = source('docs/design-system.md');

    expect(css).not.toContain('.crumb-dropdown');
    expect(css).not.toContain('.editor-crumb');
    expect(doc).toContain('## No right-click menus');
    expect(doc).toContain('三点按钮、排序按钮与窗口控件');
    expect(doc).toContain('系统原生右键菜单不属于 renderer 可定制范围');
    expect(doc).toContain('180 / 220 / 280 / 360 / 420px');
    expect(doc).toContain('桌面单行内容至少为 `32px`');
    expect(doc).toContain('不能证明不同平台上的字体栅格化、阴影观感');
  });
});
