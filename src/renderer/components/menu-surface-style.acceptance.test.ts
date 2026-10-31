import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from './design-system-docs.test-support';

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
  it('defines one rounded action-menu shell, inset rows and hairline groups', () => {
    const tokens = source('src/styles/index.css');
    const materials = source('src/styles/materials.css');
    const controls = source('src/styles/ui-controls.css');
    const surface = block(controls, '.menu-surface {', '.menu-surface--rich {');
    const item = block(controls, '.menu-surface__item {', '.menu-surface__item:hover');
    const separator = block(controls, '.menu-surface__divider,', '.user-menu__group {');

    // Menus are a lifted piece of the desk: the sidebar's opaque colour and the
    // floating shadow. On the desktop a dropdown menu is a 16px rounded
    // rectangle whose rim is the resting glass line; its rows stand 6px in from
    // the edge, and only the row under the pointer shows its ring of hairline
    // glass (red on a destructive row); rows carry no fill; groups are parted
    // by a hairline.
    expect(tokens).toContain('--menu-surface-bg: var(--workspace-ui-bg);');
    expect(tokens).toContain('--menu-surface-border: transparent;');
    // Dialogs, search and hover cards keep the square shell and its hairline.
    expect(tokens).toContain('--menu-surface-radius: 0;');
    expect(tokens).toContain('0 0 0 0.5px hsl(var(--ink-1) / 0.16),');
    expect(tokens).toContain('--menu-radius: 16px;');
    expect(tokens).toContain('--menu-shadow: 0 16px 30px -16px hsl(var(--shadow-ink) / 0.38);');
    expect(tokens).toContain('--menu-shadow: 0 16px 30px -16px hsl(var(--shadow-ink) / 0.62);');
    expect(tokens).toContain('--menu-row-inset: 6px;');
    expect(tokens).toContain('--menu-separator: hsl(var(--ink-1) / 0.14);');
    expect(tokens).toContain('--menu-item-hover-bg: hsl(var(--ink-1) / 0.05);');
    expect(tokens).toContain('--menu-item-danger: hsl(var(--destructive));');
    // Two widths for menus (the older class names alias them) and one for settings panels.
    expect(tokens).toContain('--menu-width-compact: 240px;');
    expect(tokens).toContain('--menu-width-standard: 240px;');
    expect(tokens).toContain('--menu-width-wide: 320px;');
    expect(tokens).toContain('--menu-width-panel: 320px;');
    expect(tokens).toContain('--menu-width-settings: 420px;');
    expect(surface).toContain('border: 1px solid var(--menu-surface-border);');
    expect(surface).toContain('padding: 6px 0;');
    expect(surface).toContain('width: var(--menu-width-standard);');
    expect(surface).toContain('font-size: var(--ui-font-body, 12.5px);');
    expect(surface).toContain('line-height: var(--ui-line-body, 18px);');
    expect(surface).not.toContain('backdrop-filter');
    // The rim is the resting glass line drawn as a background in the 1px
    // border: a pseudo-element would scroll away with the rows.
    expect(surface).toContain('border-radius: var(--menu-radius);');
    expect(surface).toContain('linear-gradient(var(--menu-surface-bg), var(--menu-surface-bg)) padding-box,');
    expect(surface).toContain('var(--menu-ring-texture) -14px -46px / 150px 150px border-box var(--menu-surface-bg);');
    expect(surface).toContain('box-shadow: var(--menu-shadow);');
    expect(materials).toContain("--menu-ring-texture: url('../assets/design/glass-ring.png');");
    expect(materials).toContain("--menu-ring-texture: url('../assets/design/glass-ring-dark.png');");
    for (const ring of ['glass-ring.png', 'glass-ring-dark.png']) {
      expect(existsSync(resolve(process.cwd(), `src/assets/design/${ring}`)), ring).toBe(true);
    }
    expect(source('scripts/design-assets/ringgen.py')).toContain('STRENGTH = 0.33 * 1.8 * 0.85');
    expect(controls).not.toContain('.menu-surface::before {');
    expect(controls).not.toContain('.menu-surface::after {');
    // The hovered row is one whole ring, no open sides.
    expect(controls).not.toContain(".menu-surface__item::after {");
    // Rows outside a menu (search results, lists in dialogs) keep their own geometry.
    expect(controls).toContain('inset: 1px 4px;');
    expect(item).toContain('min-height: var(--ui-row-height, 30px);');
    expect(item).toContain('padding: 6px 14px;');
    expect(item).toContain('border-radius: 0;');
    // Inside a menu a row stands in from the edge and leads with its icon.
    expect(item).toContain(':where(.menu-surface) .menu-surface__item {');
    expect(item).toContain('width: calc(100% - 2 * var(--menu-row-inset));');
    expect(item).toContain('margin-inline: var(--menu-row-inset);');
    expect(item).toContain('min-height: calc(30px + var(--ui-text-increment, 0px));');
    expect(item).toContain('padding: 5px 10px;');
    expect(item).toContain('gap: 10px;');
    expect(item).toContain('border-radius: 4px;');
    expect(item).toContain('.menu-surface__check {');
    expect(controls).toContain(
      "html:not([data-shell-mode='mobile']) :where(.menu-surface) .menu-surface__item::before {\n  inset: 0;",
    );
    expect(controls).toContain(
      "html:not([data-shell-mode='mobile']) .menu-surface__item:hover:not(:disabled)::before,",
    );
    expect(controls).toContain("html:not([data-shell-mode='mobile']) .menu-surface__item--danger::before,");
    expect(controls).toContain('  --menu-line: var(--menu-item-danger);');
    expect(separator).toContain('height: 0.5px;');
    expect(separator).toContain('margin: 5px 16px;');
    expect(separator).toContain('background: var(--menu-separator);');
    const label = rule(controls, '.menu-surface__section-label {');
    expect(label).toContain('padding: 6px 16px 4px;');
    expect(label).toContain('text-transform: none;');
    expect(label).toContain('letter-spacing: normal;');
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
    expect(source('src/renderer/features/entities/hover/entity-hover-card-model.ts')).toContain('}, HOVER_CARD_GRACE_MS);');
    expect(source('src/renderer/lib/motion.ts')).toContain('export const HOVER_CARD_GRACE_MS = 220;');
    // Scrolling the list under a card closes it instead of carrying it along,
    // and rows that slide under a resting pointer do not open theirs.
    expect(card).toContain('scroller.contains(anchor)');
    expect(card).toContain('if (onDismiss) onDismiss();');
    expect(source('src/renderer/features/entities/hover/entity-hover-card-model.ts')).toContain('if (lastScrollAt > enteredAt - SCROLL_REST_MS) return;');
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
      'src/renderer/features/library/LibraryItemCard.tsx',
      'src/renderer/features/library/MaterialFolderTree.tsx',
    ]) {
      expect(source(owner), owner).toContain('<HoverCardShell');
    }
    expect(source('src/renderer/features/comments/CommentSourceHoverCard.tsx')).toContain('<HoverCardActions');
    // Plain tab pills have no card; a split's own operations unfold from the
    // grip on the editors' seam.
    expect(source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx')).not.toContain('HoverCard');
    const seam = source('src/renderer/components/editor/EditorMainArea.tsx');
    expect(seam).toContain('className="editor-split-seam__grip"');
    expect(seam).toContain("t('topTimeline.menu.swapPanes')");
    expect(seam).toContain("t('topTimeline.menu.unsplit')");

    // The editor's selection actions float over the selection as one bar.
    const bar = source('src/renderer/features/editor/editor-selection-bar.ts');
    expect(bar).toContain("bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-orientation', 'horizontal');");
    expect(bar).toContain('}, SELECTION_BAR_SETTLE_MS);');
    expect(source('src/renderer/hooks/useEntityEditor.ts')).not.toContain('contextmenu:');
    expect(rule(source('src/styles/comments-review.css'), '.editor-selection-bar {')).toContain('flex-direction: row;');
  });

  it('leads every dropdown row with its icon, the editor suggestions included', () => {
    // Sort options cannot be declared without an icon; the tick of the chosen one sits at the far end.
    const sortMenu = source('src/renderer/components/leftBars/SortMenu.tsx');
    expect(sortMenu).toContain('  icon: BrushIconName;');
    expect(sortMenu).toContain('<BrushIcon name={icon} size={16} />');
    expect(sortMenu).toContain('<BrushIcon name="check" size={12} className="menu-surface__check" />');
    const subHeader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const sortOptions = subHeader.match(/\{ value: '\w+', label: t\('leftSidebar\.sort\.\w+'\)[^}]*\}/g) ?? [];
    expect(sortOptions.length).toBeGreaterThan(15);
    for (const option of sortOptions) expect(option, option).toMatch(/icon: '[a-z-]+'/);
    for (const [key, icon] of [
      ['createdAt', 'sprout'], ['updatedAt', 'brush-writing'], ['alphabet', 'alpha-down'],
      ['storylineOrder', 'lanes-stagger'], ['showDate', 'ri'], ['showNone', 'wu'], ['duplicatesAll', 'seal-fork'],
    ]) {
      expect(subHeader).toContain(`label: t('leftSidebar.sort.${key}'), icon: '${icon}' }`);
    }

    // The editor's ⋯ menu: plain actions, the writing status, then what destroys.
    const topBar = source('src/renderer/components/editor/EditorTopBar.tsx');
    expect(topBar).toContain('  icon: MenuRowIconSpec;');
    expect(topBar).toContain('<MenuRowIcon icon={item.icon} />');
    expect(topBar).toContain("discarded: 'brush-broken',");
    expect(topBar).toContain("drifting: 'fluff',");
    expect(topBar).toContain("icon: { kind: 'chapter' },");
    expect(topBar).toContain("groups.push({ key: 'destructive'");
    // Every action's label is followed by its icon.
    const actionLabels = topBar.match(/label: label\('editorTopBar\.menu\.\w+', '[^']*'\),\n\s+\S+/g) ?? [];
    expect(actionLabels.length).toBe(16);
    for (const action of actionLabels) expect(action, action).toMatch(/\n\s+icon:$/);
    expect(source('src/renderer/components/ui/MenuRowIcon.tsx')).toContain('<KindMark kind={icon.kind} />');

    // The other menus of rows.
    expect(source('src/renderer/components/leftBars/ElementCategoryCreateMenu.tsx')).toContain('<BrushIcon name="folder-plus" size={16} />');
    expect(source('src/renderer/components/leftBars/ElementGroupPicker.tsx')).toContain('<BrushIcon name="folder-none" size={16} />');
    const plotGrid = source('src/renderer/components/editor/PlotGrid.tsx');
    expect(plotGrid).toContain("icon: isRow ? 'insert-row' as const : 'insert-col' as const,");
    expect(plotGrid).toContain("const HEADER_MENU_GROUP_STARTS = new Set(['move-back', 'insert-before', 'delete']);");
    const imageEntry = source('src/renderer/features/element-images/ElementImageEntry.tsx');
    expect(imageEntry).toContain('className="menu-surface menu-surface--rich menu-surface--wide elem-image-menu"');
    expect(imageEntry).toContain('className="menu-surface__item menu-surface__item--danger"');
    expect(rule(source('src/styles/comments-review.css'), '.elem-image-menu {')).not.toContain('border-radius');

    // `/` and `@` open the same menu at the caret, built with the DOM.
    const suggestionMenu = source('src/renderer/lib/editor-suggestion-menu.ts');
    expect(suggestionMenu).toContain("root.className = 'menu-surface editor-suggestion-menu';");
    expect(suggestionMenu).toContain("rule.className = 'menu-surface__divider';");
    expect(suggestionMenu).toContain("button.classList.toggle('is-current', current);");
    for (const path of ['src/renderer/lib/slash-menu/default-slash-menu.ts', 'src/renderer/lib/extensions/entity-mention-suggestion.ts']) {
      const menu = source(path);
      expect(menu, path).toContain('createSuggestionMenu(');
      expect(menu, path).not.toContain('#fefdfb');
      expect(menu, path).not.toContain('style.background');
    }
    expect(source('src/renderer/lib/slash-menu/default-slash-menu.ts')).toContain("  icon: BrushIconName;");
    expect(source('src/renderer/views/MaterialNotePage.tsx')).toContain("icon: 'list-bullet'");
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
      'src/renderer/components/notifications/NotificationPill.tsx',
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
      'menu-surface menu-surface--rich menu-surface--wide user-menu',
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
    expect(source('src/renderer/components/notifications/NotificationPill.tsx')).toContain(
      'menu-surface--panel notification-center',
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
    const doc = designSystemDocs();

    expect(css).not.toContain('.crumb-dropdown');
    expect(css).not.toContain('.editor-crumb');
    expect(doc).toContain('## No right-click menus');
    expect(doc).toContain('三点按钮、排序按钮与窗口控件');
    expect(doc).toContain('系统原生右键菜单不属于 renderer 可定制范围');
    expect(doc).toContain('240 / 320 / 420px');
    expect(doc).toContain('桌面单行 `30px`');
    expect(doc).toContain('同一个菜单里不混用有图标和没图标的行');
    expect(doc).toContain('不能证明不同平台上的字体栅格化、阴影观感');
  });
});

describe('floating layers, dialogs and the controls inside them', () => {
  const desktop = ":where(html:not([data-shell-mode='mobile']))";

  it('lifts dialogs, global search, the find bar and the notification center out of the desk like a menu', () => {
    const controls = source('src/styles/ui-controls.css');
    const search = source('src/styles/search.css');
    const notifications = source('src/renderer/components/notifications/NotificationPill.tsx');
    const card = rule(controls, `${desktop} .modal-card {`);

    expect(card).toContain('background: var(--menu-surface-bg);');
    expect(card).toContain('border-radius: var(--menu-surface-radius);');
    expect(card).toContain('box-shadow: var(--menu-surface-shadow);');
    expect(card).toContain('border: 0;');
    // A thin mist of the desk's own colour instead of a dark scrim.
    expect(rule(controls, `${desktop} .modal-root {`)).toContain(
      'color-mix(in srgb, var(--workspace-ui-bg) 58%, transparent)',
    );
    expect(rule(search, '.gsearch-overlay {')).toContain(
      'color-mix(in srgb, var(--workspace-ui-bg) 58%, transparent)',
    );
    // Head, body and actions are parted by space, never by rules.
    expect(rule(controls, `${desktop} .modal-header {`)).toContain('border-bottom: 0;');
    expect(rule(controls, `${desktop} .modal-actions {`)).toContain('border-top: 0;');
    expect(rule(controls, `${desktop} .modal-header__kicker {`)).toContain('text-transform: none;');

    for (const selector of ['.gsearch-modal {', '.editor-find-panel {', '.find-list {']) {
      const shell = rule(search, selector);
      expect(shell, selector).toContain('box-shadow: var(--menu-surface-shadow);');
      expect(shell, selector).toContain('var(--menu-surface-radius)');
      expect(shell, selector).toContain('var(--menu-surface-bg)');
    }
    // Those three are the only shadows left in search.css: no washes either.
    expect(search.match(/box-shadow:/g)).toHaveLength(3);
    expect(search).not.toContain('--search-row-active-bg');
    expect(search).not.toContain('--search-group-bg');
    expect(search).not.toContain('--search-count-bg');
    expect(search).not.toContain('--search-tag-bg');

    expect(notifications).toContain('menu-surface menu-surface--rich menu-surface--panel notification-center');
    expect(notifications).toContain('<EmptyState icon="furin"');
    expect(notifications).toContain('ui-progress');
    expect(notifications).not.toContain('boxShadow');
    expect(notifications).not.toContain('borderBottom');
  });

  it('keeps the arrow keys on a still ring and marks hits with ink, not a wash', () => {
    const controls = source('src/styles/ui-controls.css');
    const search = source('src/styles/search.css');
    const current = rule(
      controls,
      "html:not([data-shell-mode='mobile']) .menu-surface__item.is-current:not(:hover)::before {",
    );

    expect(current).toContain('opacity: 1;');
    expect(current).toContain('animation-play-state: paused;');
    expect(source('src/renderer/components/search/GlobalSearchModal.tsx')).toContain(
      "gsearch-row menu-surface__item${row.flatIdx === selectedIdx ? ' is-current' : ''}",
    );
    expect(source('src/renderer/components/search/FindResultsList.tsx')).toContain(
      "find-list-row menu-surface__item${isActive ? ' is-current' : ''}",
    );
    const hit = rule(search, '.search-hit {');
    expect(hit).toContain('background: transparent;');
    expect(hit).toContain('font-weight: 600;');
    // Matches in the manuscript follow the accent rather than a fixed blue.
    expect(search).toContain('--search-find-match-bg:        hsl(var(--accent) / 0.16);');
  });

  it('parts the account menu by hairlines and sets theme and language with GlassSliders', () => {
    const menu = source('src/renderer/components/topBars/UserMenu.tsx');
    const controls = source('src/styles/ui-controls.css');

    expect(menu.match(/<GlassSlider/g)).toHaveLength(2);
    expect(menu).not.toContain("borderBottom: last ? 'none'");
    // The mobile shelf keeps its older switch; the desktop has the sliders.
    expect(menu).toContain('const desktop = !getPlatformRuntime().isMobileShell;');
    expect(rule(controls, "html:not([data-shell-mode='mobile']) .user-menu__group {")).toContain(
      'border-bottom: 0;',
    );
    // Like every menu, its groups are parted by a hairline; its icons are 16px.
    const hairline = rule(controls, "html:not([data-shell-mode='mobile']) .user-menu__group + .user-menu__group::before {");
    expect(hairline).toContain('height: 0.5px;');
    expect(hairline).toContain('background: var(--menu-separator);');
    expect(menu).not.toContain('size={13}');
    expect(rule(controls, "html:not([data-shell-mode='mobile']) .user-menu__name {")).toContain(
      'font-style: normal;',
    );
  });

  it('makes the shared Button glass on the desktop and draws danger in its own red line', () => {
    const button = source('src/renderer/components/ui/Button.tsx');
    const controls = source('src/styles/ui-controls.css');
    const confirm = source('src/renderer/components/modals/ConfirmationDialog.tsx');

    expect(button).toContain("default: 'glass glass--rest glass--small',");
    expect(button).toContain("primary: 'glass glass--primary glass--small',");
    expect(button).toContain("danger: 'glass glass--rest glass--small',");
    expect(button).toContain("ghost: '',");
    expect(button).toContain('!getPlatformRuntime().isMobileShell');
    const glassButton = rule(controls, "html:not([data-shell-mode='mobile']) .ui-button.ui-button--glass {");
    expect(glassButton).toContain('background: transparent;');
    expect(glassButton).toContain('border: 0;');
    const danger = rule(controls, "html:not([data-shell-mode='mobile']) .ui-button.ui-button--glass.ui-button--danger,");
    expect(danger).toContain('--glass-cc: hsl(var(--destructive));');
    expect(danger).toContain('color: hsl(var(--destructive));');
    // A destructive confirmation opens on Cancel; Enter never deletes.
    expect(confirm).toContain('autoFocus={destructive}');
    expect(confirm).toContain('autoFocus={!destructive}');
  });

  it('defines the field, select, toggle row, empty state, loading and progress once', () => {
    const controls = source('src/styles/ui-controls.css');
    const select = source('src/renderer/components/ui/GlassSelect.tsx');
    const loading = source('src/styles/loading-status.css');

    expect(rule(controls, '.ui-field {')).toContain('background: hsl(var(--page));');
    expect(rule(controls, '.ui-field--area {')).toContain('border-radius: 16px;');
    expect(select).toContain('ui-select glass glass--rest glass--field');
    expect(select).toContain('className="menu-surface menu-surface--rich ui-select__menu"');
    expect(select).toContain('role="listbox"');
    expect(select).toContain('const SEARCH_THRESHOLD = 8;');
    expect(rule(controls, '.ui-toggle-row {')).toContain('--glass-cc: var(--toggle-color, var(--glass-clear));');
    expect(rule(controls, '.ui-progress__fill {')).toContain('height: 2px;');
    expect(rule(controls, "html:not([data-shell-mode='mobile']) .empty-state {")).toContain('font-style: normal;');
    expect(source('src/renderer/components/ui/EmptyState.tsx')).toContain('hollow');
    expect(source('src/renderer/components/ui/LoadingStatus.tsx')).toContain('name="loader"');
    expect(loading).toContain('animation: loading-status-appear 0.16s ease-out var(--motion-loading-delay) both;');
  });

  it('builds every dialog in scope from the shared shell and controls', () => {
    const importDialog = source('src/renderer/components/modals/ImportDialog.tsx');
    const storyline = source('src/renderer/components/modals/EditChapterStorylineModal.tsx');
    const patch = source('src/renderer/components/editor/PatchCreateModal.tsx');
    const debug = source('src/renderer/components/modals/DebugModal.tsx');
    const drift = source('src/renderer/components/modals/DriftBindModal.tsx');
    const snapshots = source('src/renderer/components/modals/EntitySnapshotHistoryModal.tsx');

    for (const borrowed of ['set-tier', 'set-btn', 'set-input', 'set-sec__title']) {
      expect(importDialog).not.toContain(borrowed);
    }
    expect(importDialog).toContain('<GlassSlider');
    expect(importDialog).toContain('<GlassSelect');
    expect(storyline).toContain('ui-toggle-row glass');
    expect(storyline).toContain('scope-toggle glass glass--rest');
    expect(storyline).not.toContain('type="checkbox"');
    expect(patch).toContain('<ModalRoot');
    expect(patch).not.toContain('createPortal');
    expect(patch).not.toContain('bg-primary');
    expect(debug).toContain('<ModalRoot');
    expect(debug).not.toContain('bg-white');
    expect(debug).not.toContain('<BrushIcon');
    expect(drift).toContain('<EmptyState');
    expect(drift).not.toContain('onMouseEnter');
    expect(snapshots).toContain('<LoadingStatus');
    expect(snapshots).not.toContain('function rowBtn');
  });

  it('records the definitions in the design-system docs', () => {
    const doc = designSystemDocs();

    expect(doc).toContain('## 对话框');
    expect(doc).toContain('## 危险操作的按钮');
    expect(doc).toContain('## 下拉选择');
    expect(doc).toContain('## 空状态');
    expect(doc).toContain('## 加载与进度');
    expect(doc).toContain('`GlassSelect`');
    expect(doc).toContain('超过 `240ms` 才出现');
  });
});
