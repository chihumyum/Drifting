import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('workspace surface language acceptance', () => {
  it('places the full-width footer below the three-column workspace row', () => {
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const centerColumn = block(
      workspace,
      '<main className="app-mid desktop-workspace-main">',
      '</main>',
    );

    expect(centerColumn).toContain('className="workspace-stage desktop-workspace-stage"');
    expect(centerColumn).toContain('className="workspace-dock desktop-workspace-dock"');
    expect(centerColumn).not.toContain('<BottomStatusBar />');
    expect(workspace).toContain('<Sidebar sidebarType="left">');
    expect(workspace).toContain('<main className="app-mid desktop-workspace-main">');
    expect(workspace).toContain('<Sidebar sidebarType="right">');
    expect(workspace.indexOf('<BottomStatusBar />')).toBeGreaterThan(
      workspace.indexOf('<Sidebar sidebarType="right">'),
    );
  });

  it('uses Page Flip for All Chapters and moves Super switching into each Super header', () => {
    const appTopbar = source('src/renderer/views/AppTopbar.tsx');
    const leftTopbar = source('src/renderer/components/topBars/LeftSidebarTopBar.tsx');
    const workspaceNavigation = source(
      'src/renderer/components/topBars/WorkspaceNavigationButtons.tsx',
    );
    const superHeader = source(
      'src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx',
    );
    const rightTopbar = source('src/renderer/components/topBars/RightSidebarTopBar.tsx');
    const userMenu = source('src/renderer/components/topBars/UserMenu.tsx');
    const notification = source('src/renderer/components/notifications/NotificationPill.tsx');
    const topTimeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const copilot = source('src/renderer/components/copilot/CopilotBottomMenu.tsx');
    const footer = source('src/renderer/components/BottomStatusBar.tsx');
    const footerCss = source('src/styles/bottom-status-bar.css');
    const shellCss = source('src/styles/index.css');
    const workspaceNavigationCss = source('src/styles/workspace-navigation.css');
    const nodeEditor = source('src/renderer/views/NodeEditorView.tsx');
    const storylineEditor = source('src/renderer/views/StorylineEditorView.tsx');
    const allChaptersEditor = source('src/renderer/views/AllChaptersEditorView.tsx');

    expect(leftTopbar).toContain('<WorkspaceNavigationButtons />');
    expect(workspaceNavigation.match(/<GhostIconButton/g)).toHaveLength(2);
    expect(workspaceNavigation).toContain('icon={<Home size={16}');
    expect(workspaceNavigation).toContain("import { IconoirPageFlip } from '../ui/icons/IconoirPageFlip'");
    expect(workspaceNavigation).toContain('icon={<IconoirPageFlip width={16} height={16}');
    expect(source('src/renderer/components/ui/icons/IconoirPageFlip.tsx')).toContain(
      'Iconoir `page-flip`, MIT licensed',
    );
    expect(workspaceNavigation).toContain(
      "aria-pressed={baseViewVisible && activeLeaf?.entityType === 'dashboard'}",
    );
    expect(workspaceNavigation).toContain(
      'className="workspace-all-chapters-trigger workspace-header-action"',
    );
    expect(workspaceNavigation).toContain('const superDestinationActive = activeSuperView !==');
    expect(workspaceNavigation).toContain('state.lastActiveSuperView');
    expect(workspaceNavigation).toContain("lastActiveSuperView ?? ('element' satisfies SuperViewId)");
    expect(workspaceNavigation).toContain('<span>SUPER</span>');
    expect(workspaceNavigation).not.toContain('ChevronDown');
    expect(workspaceNavigation).not.toContain('<AnchoredPopover');
    expect(workspaceNavigation).not.toContain('role="menuitemradio"');
    expect(superHeader).toContain("{ id: 'element', labelKey: 'superElement.title' }");
    expect(superHeader).toContain("{ id: 'graph', labelKey: 'storyGraph.title' }");
    expect(superHeader).toContain("{ id: 'memo-material', labelKey: 'memoMaterial.super.title' }");
    expect(superHeader).toContain('className="super-view-head__switcher-option"');
    expect(workspaceNavigation.indexOf('className="workspace-all-chapters-trigger')).toBeLessThan(
      workspaceNavigation.indexOf('className="workspace-super-trigger"'),
    );
    expect(workspaceNavigation).not.toContain('BottomStatusBarIcons');
    expect(
      existsSync(resolve(process.cwd(), 'src/renderer/components/BottomStatusBarIcons.tsx')),
    ).toBe(false);
    expect(workspaceNavigationCss).not.toContain('.workspace-super-menu');
    expect(
      block(
        workspaceNavigationCss,
        '.app-topbar .ghost-icon-button:hover:not(:disabled) {',
        '.workspace-super-trigger {',
      ),
    ).toContain('background: transparent;');
    expect(source('src/styles/ui-controls.css')).not.toContain(
      ".workspace-header-action[aria-pressed='true']",
    );
    expect(workspaceNavigationCss).not.toContain('workspace-super-trigger[aria-expanded');
    expect(notification).not.toContain('e.currentTarget.style.background');
    expect(topTimeline).not.toContain('event.currentTarget.style.background');
    expect(appTopbar).toContain('runtime.isMacDesktop ? 288 : 216');
    expect(appTopbar).not.toContain("background: 'var(--workspace-ui-bg)'");

    expect(rightTopbar).not.toContain('CopilotQuickMenu');
    expect(rightTopbar).not.toContain('ShadowQuickMenu');
    expect(rightTopbar).not.toContain('toggleBottomTimelineHidden');
    expect(rightTopbar.indexOf('<NotificationPill />')).toBeLessThan(
      rightTopbar.indexOf('<GhostIconButton'),
    );
    expect(rightTopbar.indexOf('<GhostIconButton')).toBeLessThan(
      rightTopbar.indexOf('<UserAvatar'),
    );
    expect(userMenu).toContain("setActiveSettingsPage('copilot')");
    expect(userMenu).not.toContain("setActiveSettingsPage('shadow')");
    expect(userMenu).toContain('<CopilotQuickSettings');
    expect(userMenu).not.toContain('<ShadowQuickSettings');
    expect(userMenu).toContain('dismissOnEscape={activeSettingsPage === null}');
    expect(copilot).toContain('export function CopilotQuickSettings');
    expect(copilot).not.toContain('<GhostIconButton');
    expect(
      existsSync(resolve(process.cwd(), 'src/renderer/components/ShadowQuickMenu.tsx')),
    ).toBe(false);

    expect(footer).toContain('<footer className="bsb app-plane"');
    expect(footer.match(/<button/g)).toHaveLength(1);
    expect(footer).toContain('className="bsb__timeline-toggle"');
    expect(footer).toContain('onClick={toggleBottomTimelineHidden}');
    expect(footer).not.toContain('CopilotQuickMenu');
    expect(footer).not.toContain('ShadowQuickMenu');
    expect(footer).toContain('deriveWritingStats');
    expect(footer).toContain('useSyncObserver');
    expect(footerCss).toContain('.bsb__timeline-toggle {');
    expect(footerCss).toContain('cursor: pointer;');
    expect(footerCss).toContain('background: transparent;');
    expect(footerCss).not.toContain('.bsb__seg');

    expect(
      block(nodeEditor, '<EditorTopBar\n            editorType="node"', '</EditorTopBar>'),
    ).not.toContain('nodeEditor.meta.words');
    expect(
      block(storylineEditor, '<EditorTopBar\n        editorType="storyline"', '</EditorTopBar>'),
    ).not.toContain('storylineEditor.meta.kWords');
    expect(
      block(
        allChaptersEditor,
        '<EditorTopBar\n        editorType="node"\n        onMenuAction={handleChapterMenuAction}',
        '</EditorTopBar>',
      ),
    ).not.toContain('storylineEditor.meta.kWords');

    expect(shellCss).toContain("html[data-platform-target='mobile'] .app-topbar__workspace-nav");
  });

  it('keeps macOS and cross-platform workspace chrome on one opaque grey plane', () => {
    const shellCss = source('src/styles/index.css');
    const main = source('src/renderer/main.tsx');
    const macConfig = JSON.parse(source('src-tauri/tauri.macos.conf.json')) as {
      app: {
        macOSPrivateApi: boolean;
        windows: Array<{
          transparent: boolean;
          windowEffects?: unknown;
        }>;
      };
    };

    expect(main).not.toContain('native-titlebar.css');
    expect(shellCss).toMatch(/\.app-root\s*\{[\s\S]*?background:\s*var\(--workspace-ui-bg\);/);
    expect(shellCss).toMatch(/\.app-row\s*\{[\s\S]*?background:\s*var\(--workspace-ui-bg\);/);
    expect(shellCss).toMatch(/\.app-mid\s*\{[\s\S]*?background:\s*var\(--workspace-ui-bg\);/);
    expect(shellCss).toMatch(
      /\.app-plane,[\s\S]*?\.workspace-dock\s*\{\s*background:\s*var\(--workspace-ui-bg\);/,
    );
    expect(shellCss).toMatch(
      /\.app-panel-plane\s*\{[\s\S]*?background:\s*var\(--workspace-ui-bg\);/,
    );
    expect(macConfig.app.macOSPrivateApi).toBe(false);
    expect(macConfig.app.windows[0]?.transparent).toBe(false);
    expect(macConfig.app.windows[0]?.windowEffects).toBeUndefined();
  });

  it('assigns explicit plane and edge-panel roles without legacy island shells', () => {
    const app = source('src/renderer/App.tsx');
    const topbar = source('src/renderer/views/AppTopbar.tsx');
    const shellCss = source('src/styles/index.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const footer = source('src/renderer/components/BottomStatusBar.tsx');
    const renderer = `${app}\n${topbar}\n${sidebar}\n${footer}`;

    expect(topbar).toContain('className="app-topbar app-plane"');
    expect(topbar).not.toContain("background: 'var(--workspace-ui-bg)'");
    expect(shellCss).toMatch(
      /\.app-plane,[\s\S]*?\.workspace-dock\s*\{\s*background:\s*var\(--workspace-ui-bg\);/,
    );
    expect(sidebar).toContain('app-panel-plane sidebar-shell');
    expect(footer).toContain('className="bsb app-plane"');
    expect(renderer).not.toContain('app-island');
    expect(renderer).not.toContain('app-chrome');
  });

  it('keeps the desktop coplanar and the manuscript independently raised', () => {
    const css = source('src/styles/index.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const rightPanels = source('src/renderer/shells/desktop/DesktopRightSidebar.tsx');
    const shell = block(
      css,
      'Coplanar workspace + manuscript elevation',
      'Static document and panel tabs',
    );
    const page = block(css, '.page {', '.page__folio {');

    expect(shell).toMatch(/\.app-root\s*\{[\s\S]*?padding:\s*0;[\s\S]*?gap:\s*0;/);
    expect(shell).toMatch(
      /\.workspace-stage\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(shell).toMatch(
      /\.app-panel-plane\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(shell).toMatch(
      /\.sidebar-shell--left\s*\{[\s\S]*?border-right:[\s\S]*?box-shadow:\s*none;/,
    );
    expect(shell).toMatch(
      /\.sidebar-shell--right\s*\{[\s\S]*?border-left:[\s\S]*?box-shadow:\s*none;/,
    );
    expect(css).toContain('--workspace-ui-bg: hsl(var(--paper-deep));');
    expect(css).toContain('--chrome-bg: var(--workspace-ui-bg);');
    expect(shell).toMatch(/\.app-panel-plane\s*\{[\s\S]*?background:\s*var\(--workspace-ui-bg\);/);
    expect(sidebar).not.toContain("background: 'var(--chrome-bg)'");
    expect(rightPanels).toContain("background: 'var(--workspace-ui-bg)'");
    expect(page).toContain('background: hsl(var(--page));');
    expect(page).toContain('border-radius: var(--workspace-corner-radius);');
    expect(page).toContain('box-shadow: var(--page-elevation);');
    expect(css).not.toContain('.app-island');
    expect(css).not.toContain('.tab-indicator');
  });

  it('uses static rectangular tabs and removes the selection-indicator hook', () => {
    const tabs = source('src/renderer/components/ui/PanelTabs.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const controls = source('src/styles/ui-controls.css');

    expect(tabs).not.toContain('indicatorStyle');
    expect(tabs).not.toContain('tab-indicator');
    expect(tabs).not.toContain('is-accent');
    expect(rightHeader).not.toContain('id="shadow"');
    expect(timeline).not.toContain('useSlidingIndicator');
    expect(timeline).toContain("behavior: 'auto'");
    expect(timeline).not.toContain("transition: 'background");
    expect(controls).toMatch(
      /\.app-panel-tab\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?transition:\s*none;/,
    );
    const panelTabStates = block(
      controls,
      '.app-panel-tab:hover:not(:disabled),',
      '.segmented-control {',
    );
    expect(panelTabStates).toContain('color: hsl(var(--ink-1));');
    expect(panelTabStates).not.toContain('background:');
    expect(panelTabStates).not.toContain('box-shadow:');
    expect(panelTabStates).not.toContain('border-bottom');
    expect(panelTabStates).not.toContain('inset');
    expect(existsSync(resolve(process.cwd(), 'src/renderer/hooks/useSlidingIndicator.ts'))).toBe(
      false,
    );
  });

  it('keeps sidebar chrome compact and rules only below the tab strips', () => {
    const controls = source('src/styles/ui-controls.css');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const leftSubheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const todo = source('src/renderer/components/rightBars/TodoPanel.tsx');
    const library = source('src/renderer/features/library/LibraryPanel.tsx');
    const compactChrome = block(controls, '/* Sidebar chrome', '.panel-tab-tray {');

    expect(compactChrome).toContain('height: 28px;');
    expect(compactChrome).toContain('min-height: 26px;');
    expect(compactChrome).toContain('padding-block: 3px;');
    expect(leftHeader).toContain('workspace-local-divider workspace-panel-tab-row');
    expect(rightHeader).toContain('workspace-local-divider workspace-panel-tab-row');
    expect(leftSubheader).toContain('className="workspace-panel-header-row"');
    expect(todo).toContain('className="workspace-panel-header-row"');
    expect(library).toContain('className="workspace-panel-header-row"');
    expect(rightHeader).toContain('className="workspace-panel-title-block"');
    expect(leftSubheader).not.toContain('workspace-local-divider');
    expect(todo).not.toContain('workspace-local-divider');
    expect(library).not.toContain('workspace-local-divider');
    expect(rightHeader.match(/workspace-local-divider/g)).toHaveLength(1);
  });

  it('uses a text-only chapter view-mode summary instead of a switch', () => {
    const subheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const controls = source('src/styles/ui-controls.css');
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')) as {
      leftSidebar: { viewMode: Record<string, string> };
    };
    const textControl = block(controls, '.left-panel-view-mode-text {', '.panel-tab-tray {');
    const hoverState = block(controls, '.left-panel-view-mode-text:hover,', '.panel-tab-tray {');

    expect(subheader).not.toContain("from '../ui/Switch'");
    expect(subheader).not.toContain('<Switch');
    expect(subheader).not.toContain('ViewModeSwitch');
    expect(subheader).toContain('className="left-panel-view-mode-text"');
    expect(subheader).toContain('onClick={handleToggleChapterViewMode}');
    expect(subheader).toContain("t('leftSidebar.viewMode.storylineSummary'");
    expect(subheader).toContain("t('leftSidebar.viewMode.globalSummary'");
    expect(textControl).toContain('border: 0;');
    expect(textControl).toContain('background: transparent;');
    expect(hoverState).toContain('color: hsl(var(--ink-1));');
    expect(hoverState).not.toContain('background:');
    expect(hoverState).not.toContain('border:');
    expect(zh.leftSidebar.viewMode.storylineSummary).toBe(
      '{{storylines}} 条故事线 · {{chapters}} 章',
    );
    expect(zh.leftSidebar.viewMode.globalSummary).toBe('共 {{count}} 章');
  });

  it('uses the document-tab surface instead of an accent wash for left-panel selection', () => {
    const css = source('src/styles/index.css');
    const controls = source('src/styles/ui-controls.css');
    const chapterPanel = source('src/renderer/components/leftBars/ChapterPanel.tsx');
    const elementPanel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const driftPanel = source('src/renderer/components/leftBars/DriftPanel.tsx');
    const panels = [chapterPanel, elementPanel, driftPanel];

    expect(block(css, '.app-tab.is-active {', '/* Container-level drag-and-drop')).toContain(
      'background: hsl(var(--surface));',
    );
    expect(css).toContain('--workspace-cell-hover-bg: color-mix(');
    expect(block(controls, '.workspace-list-row:hover,', '.label-mono {')).toContain(
      'background: var(--workspace-cell-hover-bg);',
    );
    for (const panel of panels) {
      expect(panel).toContain("background: selected ? 'hsl(var(--surface))' : 'transparent'");
      expect(panel).toContain(
        "event.currentTarget.style.background = 'var(--workspace-cell-hover-bg)'",
      );
      expect(panel).not.toContain(
        "event.currentTarget.style.background = 'hsl(var(--ink-1) / 0.03)'",
      );
      expect(panel).not.toContain(
        "background: selected ? 'hsl(var(--accent) / 0.10)' : 'transparent'",
      );
    }
  });

  it('keeps unaffiliated chapters as the final storyline-style group instead of a footer', () => {
    const chapterPanel = source('src/renderer/components/leftBars/ChapterPanel.tsx');
    const store = source('src/renderer/store/ui-store.ts');
    const designSystem = source('docs/design-system.md');
    const unaffiliatedGroup = block(
      chapterPanel,
      '{/* Unaffiliated is deliberately appended after every persisted',
      '{!hasStorylines && (',
    );
    const realGroupsIndex = chapterPanel.indexOf('{sortedStorylines.map((storyline) => {');
    const unaffiliatedGroupIndex = chapterPanel.indexOf('key={UNAFFILIATED_GROUP_ID}');

    expect(realGroupsIndex).toBeGreaterThanOrEqual(0);
    expect(unaffiliatedGroupIndex).toBeGreaterThan(realGroupsIndex);
    expect(chapterPanel).not.toContain("from '../ui/CollapsibleFooter'");
    expect(chapterPanel).not.toContain('<CollapsibleFooter');
    expect(chapterPanel).toContain(
      'return new Set([...storylines.map((s) => s.id), UNAFFILIATED_GROUP_ID]);',
    );
    expect(chapterPanel).toContain(
      'const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());',
    );
    expect(unaffiliatedGroup).toContain('<GroupHeaderCell');
    expect(unaffiliatedGroup).toContain("name={t('leftSidebar.groups.unaffiliated')}");
    expect(unaffiliatedGroup).toContain(
      'collapsed={collapsedGroupIds.has(UNAFFILIATED_GROUP_ID)}',
    );
    expect(unaffiliatedGroup).toContain(
      'onToggleCollapsed={() => toggleGroupCollapsed(UNAFFILIATED_GROUP_ID)}',
    );
    expect(unaffiliatedGroup).toContain('onAdd={() => void handleCreateNode(null)}');
    expect(unaffiliatedGroup).toContain('unaffiliatedChapters.map((node) => renderNodeCard(node))');
    expect(chapterPanel).toContain(
      "const UNAFFILIATED_STRIPE_COLOR = 'hsl(var(--ink-4))';",
    );
    expect(chapterPanel).toContain(
      'const stripeColor = storyline?.color ?? UNAFFILIATED_STRIPE_COLOR;',
    );
    expect(chapterPanel).not.toContain("const stripeColor = storyline?.color ?? 'transparent';");
    expect(store).not.toContain('chapterUnaffiliatedFooterHeight');
    expect(designSystem).toContain(
      '“未归属”复用普通故事线组的 header、计数、折叠与新增章节交互',
    );
    expect(designSystem).toContain('固定追加在全部真实故事线之后');
    expect(designSystem).toContain('左侧 label 使用与组头一致的 `--ink-4` 中性灰');
  });

  it('keeps the shared entity hover preview shadow clear of its hovered cell', () => {
    const css = source('src/styles/index.css');
    const hoverCard = source('src/renderer/features/entities/hover/EntityHoverCard.tsx');
    const consumers = [
      source('src/renderer/components/leftBars/ChapterPanel.tsx'),
      source('src/renderer/components/leftBars/ElementPanel.tsx'),
      source('src/renderer/components/leftBars/DriftPanel.tsx'),
      source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx'),
    ];

    expect(css).toContain(
      '--entity-hover-card-shadow: 0 1px 4px -3px hsl(var(--ink-1) / 0.14);',
    );
    expect(hoverCard).toContain("boxShadow: 'var(--entity-hover-card-shadow)'");
    expect(hoverCard).not.toContain('0 12px 28px -14px');
    for (const consumer of consumers) {
      expect(consumer).toContain('<EntityHoverCard');
    }
  });

  it('keeps edge slabs collapsed by default and preserves only their structural motion', () => {
    const store = source('src/renderer/store/ui-store.ts');
    const css = source('src/styles/index.css');
    const defaults = block(store, 'sidebars: {', 'setTheme:');

    expect(defaults.match(/isOpen:\s*false/g)).toHaveLength(2);
    expect(css).toContain('transition: width 220ms cubic-bezier(0.32, 0.72, 0, 1);');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-shell\s*\{\s*transition:\s*none;/,
    );
  });

  it('hides the dashboard scrollbar and blocks native selection during sidebar resizing', () => {
    const dashboard = source('src/styles/dashboard.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const dash = block(dashboard, '.dash {', '.dash *,');
    const webkitScrollbar = block(dashboard, '.dash::-webkit-scrollbar {', '.dash__inner {');

    expect(dash).toContain('overflow-y: auto;');
    expect(dash).toContain('scrollbar-width: none;');
    expect(webkitScrollbar).toContain('display: none;');
    expect(sidebar).toContain('event.preventDefault();');
    expect(sidebar).toContain("document.addEventListener('selectstart', preventSelection, true);");
    expect(sidebar).toContain("root.style.userSelect = 'none';");
    expect(sidebar).toContain("body.style.userSelect = 'none';");
    expect(sidebar).toContain("window.addEventListener('blur', stopResizing);");
  });

  it('uses plain outer seams with restrained local hierarchy and no junction decoration', () => {
    const app = source('src/renderer/App.tsx');
    const shellCss = source('src/styles/index.css');
    const timelineCss = source('src/styles/bottom-timeline.css');
    const controls = source('src/styles/ui-controls.css');
    const bottomTimeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const leftSubheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const elementPanel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const todo = source('src/renderer/components/rightBars/TodoPanel.tsx');
    const library = source('src/renderer/features/library/LibraryPanel.tsx');
    const collapsibleFooter = source('src/renderer/components/ui/CollapsibleFooter.tsx');
    const timeline = block(timelineCss, '.btl {', '.btl__resize {');
    const timelineHead = block(timelineCss, '.btl__head {', '.btl__head-left {');
    const timelineRows = block(timelineCss, '.btl-row {', 'Rail (sticky left)');
    const storylineSeparator = block(
      timelineCss,
      '.btl-row + .btl-row .btl-track::before {',
      '/* ---------------- Rail (sticky left)',
    );
    const timelineAxis = block(timelineCss, '.btl-axis {', '.btl-axis__rail-add {');
    const localDivider = block(
      controls,
      '.workspace-local-divider {',
      '/* Dense sidebar collections',
    );
    const listRow = block(controls, '.workspace-list-row {', '.workspace-list-row:hover,');
    const trackPinLine = block(timelineCss, '.btl-pin-line {', '.btl-pin-line.is-dragging {');
    const shell = block(
      shellCss,
      'Coplanar workspace + manuscript elevation',
      'Static document and panel tabs',
    );

    expect(shellCss).toContain('--workspace-border:');
    expect(shellCss).toContain('--workspace-local-border:');
    expect(shellCss).not.toContain('--workspace-card-border:');
    expect(shellCss).toContain('--workspace-subtle-border:');
    expect(shellCss).not.toContain('--workspace-level-1-bg:');
    expect(shellCss).not.toContain('--workspace-level-2-bg:');
    expect(shell).not.toContain('radial-gradient');
    expect(shellCss).not.toContain('workspace-junction');
    expect(shellCss).not.toContain('.app-root.has-left-panel::before');
    expect(shellCss).not.toContain('.workspace-dock::before');
    expect(app).not.toContain('workspace-left-panel-width');
    expect(app).not.toContain('workspace-right-panel-width');
    expect(timeline).toContain('box-shadow: none;');
    expect(timeline).toContain('border-top: 1px solid var(--workspace-border);');
    expect(timelineHead).toContain('background: var(--workspace-ui-bg);');
    expect(timelineHead).not.toContain('border-bottom');
    expect(timelineRows).not.toContain('border-top');
    expect(timeline).toContain('--btl-lane-bg: hsl(var(--page));');
    expect(timeline).toContain('--btl-secondary-rail-bg: hsl(var(--paper));');
    expect(timeline).toContain('--btl-guide-line: var(--workspace-ui-bg);');
    expect(timeline).not.toContain('--btl-rail-contrast-line');
    expect(timelineAxis).toContain('background: var(--btl-secondary-rail-bg);');
    expect(timelineCss).toMatch(
      /\.btl \.actrail\s*\{[\s\S]*?border-bottom:\s*0;[\s\S]*?background:\s*var\(--btl-secondary-rail-bg\);/,
    );
    expect(timelineCss).toMatch(
      /\.btl \.actrail__divider::after\s*\{[\s\S]*?width:\s*0\.5px;[\s\S]*?background:\s*var\(--btl-guide-line\);/,
    );
    expect(timelineCss).toMatch(
      /\.btl-pin__line\s*\{[\s\S]*?width:\s*0\.5px;[\s\S]*?background:\s*var\(--btl-guide-line\);/,
    );
    expect(trackPinLine).toContain('width: 0.5px;');
    expect(trackPinLine).toContain('background: var(--btl-guide-line);');
    expect(storylineSeparator).toContain('height: 0.5px;');
    expect(storylineSeparator).toContain('background: var(--btl-guide-line);');
    expect(bottomTimeline).not.toContain("background: 'hsl(var(--page))'");
    expect(leftHeader).toContain("background: 'var(--workspace-ui-bg)'");
    expect(leftSubheader).toContain("background: 'var(--workspace-ui-bg)'");
    expect(rightHeader).toContain("background: 'var(--workspace-ui-bg)'");
    expect(todo).toContain("background: 'var(--workspace-ui-bg)'");
    expect(library).toContain("background: 'var(--workspace-ui-bg)'");
    expect(leftHeader).toContain('className="workspace-local-divider');
    expect(leftSubheader).not.toContain('workspace-local-divider');
    expect(rightHeader.match(/className="workspace-local-divider/g)).toHaveLength(1);
    expect(todo).not.toContain('workspace-local-divider');
    expect(library).not.toContain('workspace-local-divider');
    expect(localDivider).toContain('right: 0;');
    expect(localDivider).toContain('left: 0;');
    expect(localDivider).toContain('height: 0.5px;');
    expect(localDivider).toContain('background: var(--workspace-local-border);');
    expect(listRow).toContain('border: 0;');
    expect(listRow).not.toContain('workspace-card-border');
    expect(listRow).toContain('background: color-mix');
    expect(listRow).toContain('box-shadow: none;');
    expect(todo).toContain("padding: '6px 12px 12px'");
    expect(todo).toContain('gap: 6');
    expect(library).toContain("padding: '6px 12px 12px'");
    expect(library).toContain('gap: 6');
    expect(collapsibleFooter).toContain("borderTop: '1px solid var(--workspace-subtle-border)'");
    expect(elementPanel).not.toContain('left-panel-cat-footer');
    expect(elementPanel).not.toContain("borderTop: '1px solid var(--workspace-subtle-border)'");
  });

  it('keeps Settings and Super Views on flat edge-aligned shells', () => {
    const settingsComponent = source(
      'src/renderer/features/settings/desktop/DesktopSettingsModal.tsx',
    );
    const settingsCss = source('src/styles/settings.css');
    const superCss = source('src/styles/super-view-header.css');

    expect(settingsComponent).not.toContain('app-island');
    expect(settingsCss).toMatch(/\.set-overlay\s*\{[\s\S]*?padding:\s*0;[\s\S]*?gap:\s*0;/);
    expect(settingsCss).toMatch(/\.set-main\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(superCss).toMatch(/\.super-view-overlay\s*\{[\s\S]*?padding:\s*0;[\s\S]*?gap:\s*0;/);
    expect(superCss).toMatch(
      /\.super-view-head,[\s\S]*?\.super-view-body\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/,
    );
  });

  it('keeps desktop headers icon-only and lets relation surfaces escape clipping', () => {
    const sharedHeader = source('src/renderer/components/SuperViewHeader.tsx');
    const settings = source('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const driftPanel = source('src/renderer/components/DriftPanel.tsx');
    const driftCss = source('src/styles/drift-panel.css');
    const relationKindField = source('src/renderer/components/ui/RelationKindField.tsx');
    const superElement = source(
      'src/renderer/shells/desktop/views/DesktopSuperElementView.tsx',
    );
    const storyGraph = source(
      'src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx',
    );
    const libraryCard = source('src/renderer/features/library/LibraryItemCard.tsx');

    expect(sharedHeader).toContain("import { ArrowLeft } from 'lucide-react'");
    expect(sharedHeader).toContain('<ArrowLeft size={16}');
    expect(sharedHeader).not.toContain('super-view-head__back-glyph');
    expect(settings).toContain('<ArrowLeft size={16}');
    expect(settings).not.toContain("t('settings.title_en')");
    expect(settings).not.toContain("t('settings.esc_close')");
    expect(driftPanel).toContain('<X size={14}');
    expect(driftPanel).not.toContain('>×<');
    expect(block(driftCss, '.drift-panel__close {', '.drift-panel.is-open')).toContain(
      'border-radius: 50%;',
    );

    expect(relationKindField).toContain('<AnchoredPopover');
    expect(relationKindField).toContain('className="relation-kind-suggestions"');
    expect(relationKindField).not.toContain("position: 'absolute'");
    expect(superElement).toContain('<RelationKindField');
    expect(storyGraph).toContain('<RelationKindField');
    expect(libraryCard).toContain("maxHeight: isTextExpanded || pickerOpen ? 'none' : 320");
    expect(libraryCard).toContain(
      "overflow: isTextExpanded || pickerOpen ? 'visible' : 'hidden'",
    );
  });

  it('keeps shared controls and high-exposure cards on the compact radius ladder', () => {
    const index = source('src/styles/index.css');
    const controls = source('src/styles/ui-controls.css');
    const dashboard = source('src/styles/dashboard.css');
    const picker = source('src/styles/project-picker.css');
    const agent = source('src/styles/agent-panel.css');
    const search = source('src/styles/search.css');

    expect(index).toContain('--radius: 2px;');
    expect(index).toContain('--radius-xs: 1px;');
    expect(index).toContain('--radius-sm: 2px;');
    expect(index).toContain('--radius-md: 2px;');
    expect(index).toContain('--radius-lg: 3px;');
    expect(block(controls, '.filter-chip--pill {', '.filter-chip--square {')).toContain(
      'border-radius: var(--radius-xs);',
    );
    expect(block(dashboard, '.dash-hero {', '.dash-hero__kicker {')).toMatch(
      /border-radius:\s*2px;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(block(picker, '.pp-card {', '.pp-card:hover {')).toMatch(
      /border-radius:\s*2px;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(block(agent, '.agt-composer {', '.agt-composer:focus-within {')).toContain(
      'border-radius: 2px;',
    );
    expect(block(search, '.gsearch-modal {', '.gsearch-header {')).toContain('border-radius: 2px;');
    expect(search).not.toContain('backdrop-filter');
  });

  it('replaces decorative left color bars and card grids with wash and hairlines', () => {
    const graphView = source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx');
    const graphCss = source('src/styles/graph-view.css');
    const timeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    const timelineCss = source('src/styles/bottom-timeline.css');
    const planner = source('src/styles/plot-planner.css');

    expect(graphView).not.toContain('graph-tile__stripe');
    expect(graphCss).not.toContain('.graph-tile__stripe');
    expect(block(graphCss, '.graph-tile {', '.graph-tile:hover {')).toMatch(
      /background:\s*color-mix[\s\S]*?border-radius:\s*1px;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(timeline).not.toContain('btl-rail__stripe');
    expect(timelineCss).not.toContain('.btl-rail__stripe');
    const timelineRail = block(timelineCss, '.btl-rail {', '.btl-rail__main {');
    expect(timelineRail).toContain('background: var(--workspace-ui-bg);');
    expect(timelineRail).not.toContain('color-mix');
    expect(block(planner, '.pl-table {', '.pl-corner {')).toMatch(
      /border-collapse:\s*collapse;[\s\S]*?border-spacing:\s*0;/,
    );
    expect(
      block(planner, '.pl-cell {\n  background: hsl(var(--page));', '.pl-cell:hover {'),
    ).toMatch(/border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/);
  });

  it('records the shipped mobile product path without claiming touch readiness', () => {
    const readme = source('README.md');
    const mobileDoc = source('docs/mobile-ui-foundation.md');
    const css = source('src/styles/index.css');

    expect(readme).toContain('docs/mobile-ui-foundation.md');
    expect(mobileDoc).toContain('当前代码已经具备独立的移动端产品路径');
    expect(mobileDoc).toContain('不得把当前状态描述为 mobile-ready');
    expect(mobileDoc).toContain('44/48px');
    expect(mobileDoc).toContain('visualViewport');
    expect(mobileDoc).toContain('真实 iOS 与 Android 设备完成手工验收');
    expect(css).toContain("html[data-platform-target='mobile'] .app-root");
    expect(css).toContain('height: 100dvh !important;');
    expect(css).toContain("html[data-platform-target='mobile'] .sidebar-shell");
  });

  it('records the palette boundary and manual visual acceptance boundary', () => {
    const doc = source('docs/design-system.md');

    expect(doc).toContain('单层桌面，只有一张抬起的稿纸');
    expect(doc).toContain('它们全部使用从 editor 稿纸外侧提取的');
    expect(doc).toContain('macOS 也不再启用透明窗口、`windowEffects` 或 `macOSPrivateApi`');
    expect(doc).toContain('三方交点没有渐变、阴影或额外装饰');
    expect(doc).toContain(
      '侧栏局部层级只在 Tabs 与 panel header 之间保留一条完整的 `0.5px` hairline',
    );
    expect(doc).toContain('panel header 直接衔接 content，不再重复画第二条线');
    expect(doc).toContain('不实现同时改变三个区域的三向 resize');
    expect(doc).toContain('只用暗淡文字与黑色文字的切换');
    expect(doc).toContain('footer 横跨整个窗口底部');
    expect(doc).toContain(
      '`AppTopbar` 的固定顺序是搜索、左栏 toggle、项目主页、通览全书、`SUPER`',
    );
    expect(doc).toContain('hover 都只提高前景文字/图标颜色，不绘制额外底色');
    expect(doc).toContain('`BottomStatusBar` 以只读状态为主');
    expect(doc).toContain('唯一的交互例外是 Bottom Timeline');
    expect(doc).toContain('通知入口仍留在 topbar');
    expect(doc).toContain('不重新定义现有配色');
    expect(doc).toContain('通用圆角阶梯限定为 `1px / 2px / 3px`');
    expect(doc).toContain('Plot Planner 是连续的 mini-Excel');
    expect(doc).toContain('不能替代 macOS titlebar 几何、iOS 或 Android 上的视觉、触摸和动效验收');
  });
});
