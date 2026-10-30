import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { designSystemDocs } from './design-system-docs.test-support';

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
  it('composes three full-height columns with no bar across them', () => {
    const workspace = source('src/renderer/shells/desktop/DesktopWorkspace.tsx');
    const centerColumn = block(
      workspace,
      '<main className="app-mid desktop-workspace-main">',
      '</main>',
    );

    expect(workspace).toContain('<Sidebar sidebarType="left">');
    expect(workspace).toContain('<Sidebar sidebarType="right">');
    expect(centerColumn).toContain('<WorkspaceCornerControls />');
    // The dock runs along the paper's top; the timeline toggle rests in the
    // paper's lower-right corner, so it rides above the one optional dock
    // under the paper, which slides in its own drawer and holds the Bottom
    // Timeline or the plot planner, never both. The word count is gone.
    const stage = block(centerColumn, 'className="workspace-stage desktop-workspace-stage"', '</div>');
    expect(stage).toContain('<WorkspaceTabDock />');
    expect(stage).toContain('<StageTimelineToggle />');
    expect(workspace).not.toContain('WorkspaceWordCount');
    expect(centerColumn).toContain('<TimelineDrawer open={dockPane !== null}>');
    expect(centerColumn).toContain('<BottomPanel show={dockPane ?? lastPane}>');
    expect(centerColumn).toContain('{{ timeline: <DesktopBottomTimeline />, planner: <PlotPlannerSlot /> }}');
    // The sidebar toggles are fixed above all three columns.
    expect(workspace).toContain('<WorkspaceSidebarToggles />');
    for (const removed of ['AppTopbar', 'BottomStatusBar']) {
      expect(workspace).not.toContain(removed);
    }
    for (const path of [
      'src/renderer/components/workspaceChrome/WorkspaceWordCount.tsx',
      'src/renderer/views/AppTopbar.tsx',
      'src/renderer/components/topBars/MainTopBar.tsx',
      'src/renderer/components/topBars/LeftSidebarTopBar.tsx',
      'src/renderer/components/topBars/RightSidebarTopBar.tsx',
      'src/renderer/components/topBars/WorkspaceNavigationButtons.tsx',
      'src/renderer/components/BottomStatusBar.tsx',
      'src/styles/bottom-status-bar.css',
      'src/styles/workspace-navigation.css',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }

    // The drag strip floats over the paper instead of reserving a title-bar band.
    const shellCss = source('src/styles/desktop-shell.css');
    expect(block(shellCss, '.workspace-window-strip {', '}')).toContain('position: absolute;');
    expect(block(shellCss, '.workspace-window-strip {', '}')).toContain(
      'height: var(--window-titlebar-height);',
    );
  });

  it('keeps each sidebar toggle in its corner and the account at the left sidebar foot', () => {
    const corners = source('src/renderer/components/workspaceChrome/WorkspaceCornerControls.tsx');
    const buttons = source('src/renderer/components/workspaceChrome/WindowControlButtons.tsx');
    const account = source('src/renderer/components/workspaceChrome/WorkspaceAccountControls.tsx');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const leftSidebar = source('src/renderer/shells/desktop/DesktopLeftSidebar.tsx');
    const rightSidebar = source('src/renderer/shells/desktop/DesktopRightSidebar.tsx');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const minimum = source('src/renderer/hooks/useSidebarTabMinimumWidth.ts');
    const userMenu = source('src/renderer/components/topBars/UserMenu.tsx');
    const notification = source('src/renderer/components/notifications/NotificationPill.tsx');
    const copilot = source('src/renderer/components/copilot/CopilotBottomMenu.tsx');

    // Each toggle is one round glass button fixed in its window corner; the
    // sidebar slides in and out underneath it. The desk strip only drags.
    expect(buttons).toContain('<SidebarToggleButton side="left" />');
    expect(buttons).toContain('<SidebarToggleButton side="right" />');
    expect(buttons).toContain('glass="round"');
    // The crescent is inked while its sidebar is open and hollow while it is closed.
    expect(buttons).toContain("name={`moon-${side}${isOpen ? '' : '-hollow'}`}");
    expect(corners).not.toContain('SidebarToggleButton');
    expect(corners).not.toContain('Account');
    // An open sidebar's tab row keeps an empty slot under its toggle.
    expect(leftSidebar).toContain('windowChrome={index === 0}');
    expect(rightSidebar).toContain('windowChrome={index === panes.length - 1}');
    expect(leftHeader).toContain('<SidebarHeaderChrome side="left"><SidebarToggleSlot /></SidebarHeaderChrome>');
    expect(rightHeader).toContain('<SidebarHeaderChrome side="right"><SidebarToggleSlot /></SidebarHeaderChrome>');
    expect(buttons).toContain('data-sidebar-header-chrome={side}');
    expect(buttons).toContain("`${side === 'left' ? 'leftSidebar' : 'rightSidebar'}.top.${isOpen ? 'close' : 'open'}`");
    expect(minimum).toContain(':scope > [data-sidebar-header-chrome]');
    expect(sidebar).not.toContain('sidebar-collapse-handle');
    // Global search is keyboard-only.
    expect(buttons).not.toContain('search:open');
    expect(corners).not.toContain('Search');

    // Account, notifications and the account menu live at the left sidebar foot.
    expect(leftSidebar).toContain('<WorkspaceAccountCell />');
    expect(rightHeader).not.toContain('Account');
    expect(account).toContain('<NotificationPill opens="up" />');
    expect(account).toContain('placement="top-start"');
    expect(userMenu).toContain("placement = 'bottom-end'");
    expect(notification).toContain("opens === 'up'");

    expect(userMenu).toContain("setActiveSettingsPage('copilot')");
    expect(userMenu).not.toContain("setActiveSettingsPage('shadow')");
    expect(userMenu).toContain('<CopilotQuickSettings');
    expect(userMenu).not.toContain('<ShadowQuickSettings');
    expect(userMenu).toContain('dismissOnEscape={activeSettingsPage === null}');
    expect(copilot).toContain('export function CopilotQuickSettings');
    expect(copilot).not.toContain('<GhostIconButton');
    expect(notification).not.toContain('e.currentTarget.style.background');
    expect(existsSync(resolve(process.cwd(), 'src/renderer/components/ShadowQuickMenu.tsx'))).toBe(
      false,
    );
  });

  it('docks open documents above the timeline toggle and opens whole-book views beside their entities', () => {
    const dock = source('src/renderer/components/workspaceChrome/WorkspaceTabDock.tsx');
    const topTimeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const subheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const library = source('src/renderer/features/library/LibraryPanel.tsx');
    const timeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    const account = source('src/renderer/components/workspaceChrome/WorkspaceAccountControls.tsx');
    const shortcuts = source('src/renderer/store/shortcuts-store.ts');
    const sharedSuperHeader = source('src/renderer/components/SuperViewHeader.tsx');
    const superHeader = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');

    expect(dock).toContain('expanded={hovered || focused || locked}');
    expect(dock).toContain('export function TimelineToggle({ stage = false }: { stage?: boolean })');
    // The toggle sits to the left of the right-hand pane's toolbar; the stage
    // shows its own only while no visible editor corner carries it.
    expect(dock).toContain('return hostedByEditor ? null : <TimelineToggle stage />;');
    // A preview tab's mark is hollow.
    expect(topTimeline).toContain("hollow={isPreview}");
    expect(dock).toContain('className="workspace-tab-dock__lock glass glass--rest glass--round"');
    expect(dock).toContain('aria-pressed={locked}');
    expect(dock).toContain('aria-pressed={!hidden}');
    expect(dock).toContain('onClick={toggle}');
    expect(dock).not.toContain('setActiveSuperView');
    expect(shortcuts).toContain("id: 'toggleBottomTimeline'");
    expect(shortcuts).toContain("defaultAccelerator: 'Mod+J'");
    expect(topTimeline).toContain('if (!expanded) {');
    expect(topTimeline).toContain("data-preview={isPreview ? 'true' : undefined}");
    expect(topTimeline).not.toContain('event.currentTarget.style.background');

    // All Chapters and the element overview open from the left panel headers.
    expect(subheader).toContain("title={t('bottomStatusBar.allChapters')}");
    expect(subheader).toContain('navigateToAllChapters();');
    expect(subheader).toContain("title={t('bottomStatusBar.elements')}");
    expect(subheader).toContain("onClick={() => setActiveSuperView('element')}");
    // Entries to whole-book views are round glass with brush icons.
    expect(subheader).toContain('<BrushIcon name="ov-folding" size={15} />');
    expect(subheader).toContain('<BrushIcon name="ov-iceberg" size={15} />');
    // No icon from an outside set is left on the desktop: Iconoir's page-flip
    // was the last, and nothing used it.
    expect(existsSync(resolve(process.cwd(), 'src/renderer/components/ui/icons/IconoirPageFlip.tsx'))).toBe(false);
    // TODO & Materials from the material panel; the story graph from the timeline head.
    expect(source('src/renderer/shells/desktop/DesktopRightSidebar.tsx')).toContain(
      "setActiveSuperView('memo-material')",
    );
    expect(library).toContain('onOpenWorkbench={onOpenWorkbench}');
    expect(library).toContain("title={t('bottomStatusBar.todoLibrary')}");
    expect(timeline).toContain("onClick={() => setActiveSuperView('graph')}");
    expect(timeline).toContain("title={t('bottomStatusBar.storyGraph')}");
    // Project Home from the account cell.
    expect(account).toContain("title={t('bottomStatusBar.projectHome')}");
    expect(account).toContain('navigateToHome();');

    expect(superHeader).toContain("{ id: 'element', labelKey: 'superElement.title' }");
    expect(superHeader).toContain("{ id: 'graph', labelKey: 'storyGraph.title' }");
    expect(superHeader).toContain("{ id: 'memo-material', labelKey: 'memoMaterial.super.title' }");
    expect(superHeader).toContain('className="super-view-head__switcher-option"');
    expect(superHeader).toContain('navigationSlot={');
    const superHeaderLeft = block(
      sharedSuperHeader,
      '<div className="super-view-head__left">',
      '{leftSlot}',
    );
    expect(superHeaderLeft.indexOf('{navigationSlot}')).toBeGreaterThan(
      superHeaderLeft.indexOf('{onBack && ('),
    );
    expect(sharedSuperHeader).not.toContain('super-view-head__title');
  });

  it('keeps document actions on each paper as one horizontal glass pill', () => {
    const topBar = source('src/renderer/components/editor/EditorTopBar.tsx');
    const indexCss = source('src/styles/index.css');

    expect(topBar).toContain('<div className="editor-bar glass glass--rest" role="toolbar" aria-orientation="horizontal">');
    // The corner: the timeline toggle (right-hand pane only), then the pill.
    const corner = block(topBar, '<div className="editor-corner">', '<div className="editor-bar');
    expect(corner).toContain('{hostsTimelineToggle && <TimelineToggle />}');
    expect(block(indexCss, '.editor-corner {', '}')).toContain('position: absolute;');
    const mainArea = source('src/renderer/components/editor/EditorMainArea.tsx');
    expect(mainArea.match(/<TrailingEditorPaneContext\.Provider value>/g)).toHaveLength(2);
    expect(topBar).not.toContain('EditorCrumb');
    expect(topBar).not.toContain('editor-crumbs');
    expect(topBar).toContain('placement="top-end"');
    const bar = block(indexCss, '.editor-bar {', '}');
    expect(bar).toContain('position: relative;');
    expect(bar).toContain('flex-direction: row;');
    expect(bar).toContain('background: var(--glass-fill);');
    for (const view of ['NodeEditorView', 'ElementEditorView', 'CategoryEditorView', 'StorylineEditorView', 'AllChaptersEditorView', 'MaterialEditorView']) {
      const text = source(`src/renderer/views/${view}.tsx`);
      expect(text, view).not.toContain('EditorCrumb');
      expect(text, view).not.toContain('</EditorTopBar>');
    }
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
    const shellCss = source('src/styles/index.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const renderer = `${app}\n${sidebar}`;

    expect(shellCss).toMatch(
      /\.app-plane,[\s\S]*?\.workspace-dock\s*\{\s*background:\s*var\(--workspace-ui-bg\);/,
    );
    expect(sidebar).toContain('app-panel-plane sidebar-shell');
    expect(renderer).not.toContain('app-island');
    expect(renderer).not.toContain('app-chrome');
  });

  it('keeps the desktop coplanar and the manuscript independently raised', () => {
    const css = source('src/styles/index.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const rightPanels = source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx');
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

  it('lays one glass block under the chosen panel tab that rides the pane push', () => {
    const tabs = source('src/renderer/components/ui/PanelTabs.tsx');
    const layout = source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx');
    const controls = source('src/styles/ui-controls.css');
    const shell = source('src/styles/desktop-shell.css');
    const block_ = block(controls, '.panel-tab-tray > .panel-tab-tray__block.glass {', '}');

    // The block and the panel share one push, so they land together.
    expect(tabs).toContain('className="panel-tab-tray__block glass is-on"');
    expect(tabs).toContain('${PUSH_MS}ms ${PUSH_EASING}');
    expect(tabs).toContain('trackGlassFlow(tray');
    expect(layout).toContain("{ duration: PUSH_MS, easing: PUSH_EASING, fill: 'forwards' }");
    // Square, the tab's whole share of the row, 2px short of top and bottom;
    // its glass runs only with its own travel.
    expect(block_).toContain('border-radius: 0;');
    expect(block_).toMatch(/top: 2px;[\s\S]*bottom: 2px;/);
    expect(block_).toContain('--glass-gx: calc(var(--flow, 0) * 1.2px + var(--glass-dense-gx));');
    expect(block_).toContain('pointer-events: none;');
    // The tabs stay words; hovering any tab stirs the header region's edges.
    expect(source('src/renderer/components/leftBars/LeftSidebarHeader.tsx')).toContain('<PanelTabRowEdges />');
    expect(source('src/renderer/components/rightBars/RightSidebarHeader.tsx')).toContain('<PanelTabRowEdges />');
    expect(shell).toContain('.workspace-panel-tab-row:has(.app-panel-tab:hover) .panel-tab-row__edge::after {');
    expect(block(shell, '.workspace-panel-tab-row:has(.app-panel-tab:hover)', '}')).toContain('animation-play-state: running;');
    expect(controls).not.toMatch(/\.app-panel-tab[^{]*\{[^}]*\bglass\b/);
  });

  it('keeps sidebar chrome compact and rules only below the tab strips', () => {
    const controls = source('src/styles/ui-controls.css');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const leftSubheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const review = source('src/renderer/components/rightBars/ReviewPanel.tsx');
    const library = source('src/renderer/features/library/LibraryPanel.tsx');
    const agentPanel = source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    const agentCss = source('src/styles/agent-panel.css');
    const compactChrome = block(controls, '/* Sidebar chrome', '.panel-tab-tray {');

    expect(compactChrome).toContain('height: var(--ui-row-height, 28px);');
    expect(compactChrome).toContain('min-height: var(--ui-control-height, 26px);');
    expect(compactChrome).toContain('padding-block: 3px;');
    // Desktop panel headers are a quarter roomier; words keep their size.
    // Every icon button in a panel header is the shared GhostIconButton, so
    // the header's scale reaches all of them.
    expect(leftSubheader).toContain('    <GhostIconButton\n      {...intent}\n      ref={buttonRef}\n      size="sm"');
    expect(library).not.toContain('ToolbarIconButton');
    expect(library).not.toContain('onMouseEnter={(e) => {');
    expect(compactChrome).toContain('--panel-header-scale: 1.25;');
    // Tall enough for the round glass whole-book entry, so 章节 and 要素 (which
    // carry one) are no taller than 构想; every row centres its contents.
    expect(compactChrome).toContain('min-height: calc((var(--ui-control-height, 26px) + 4px) * var(--panel-header-scale));');
    expect(block(controls, '.workspace-panel-header-row {', '/* On desktop')).toContain('align-items: center;');
    // Agent's text actions fill only the room inside the row's padding, so its
    // header is no taller than the others.
    expect(compactChrome).toContain('.workspace-panel-header-row .agt-toolbar-action {\n  min-height: calc((var(--ui-control-height) - 2px) * var(--panel-header-scale));');
    // One inset for every panel header, so the last button never shifts when
    // switching panels on either side.
    expect(block(controls, '.workspace-panel-header-row {', '/* On desktop')).toContain('padding-inline: 12px 10px;');
    expect(leftSubheader).not.toContain('paddingInline');
    expect(library).not.toContain("paddingInline: '12px");
    expect(block(agentCss, '.agt-panel-toolbar {', '.agt-panel-toolbar__right {')).not.toContain('padding-inline');
    expect(
      block(source('src/styles/comments-review.css'), '.review-panel__toolbar {', '.review-panel__create-actions {'),
    ).not.toContain('padding-inline');
    expect(compactChrome).toContain('.workspace-panel-header-row .ghost-icon-button {\n  zoom: var(--panel-header-scale);');
    expect(leftHeader).toContain('workspace-local-divider workspace-panel-tab-row');
    expect(rightHeader).toContain('workspace-local-divider workspace-panel-tab-row');
    expect(leftSubheader).toContain('className="workspace-panel-header-row"');
    expect(review).toContain('className="review-panel__toolbar workspace-panel-header-row"');
    expect(library).toContain('className="workspace-panel-header-row"');
    expect(
      agentPanel.match(/className="agt-panel-toolbar workspace-panel-header-row"/g),
    ).toHaveLength(1);
    expect(agentPanel).not.toContain('style={toolbar}');
    expect(
      block(agentCss, '.agt-panel-toolbar {', '.agt-panel-toolbar__right {'),
    ).toContain('font-size: var(--ui-font-caption, 9.5px);');
    expect(block(agentCss, '.agt-toolbar-action {', '.agt-toolbar-action:hover,')).toContain(
      'min-height: 20px;',
    );
    expect(block(agentCss, '.agt-toolbar-action {', '.agt-toolbar-action:hover,')).toContain(
      'font: var(--ui-font-secondary, 9.5px)/var(--ui-line-caption, 1) var(--font-mono);',
    );
    expect(agentCss).toContain('font: var(--ui-font-secondary, 11.5px)/var(--ui-line-caption, 1.5) var(--font-sans);');
    // Stats' title is the same one-row header as every other panel's.
    expect(rightHeader).toContain('className="workspace-panel-header-row"');
    expect(rightHeader).not.toContain('workspace-panel-title-block');
    expect(controls).not.toContain('.workspace-panel-title-block');
    expect(leftSubheader).not.toContain('workspace-local-divider');
    expect(review).not.toContain('workspace-local-divider');
    expect(library).not.toContain('workspace-local-divider');
    expect(agentPanel).not.toContain('workspace-local-divider');
    expect(rightHeader.match(/workspace-local-divider/g)).toHaveLength(1);
  });

  it('keeps independent sidebar panes separated by a local hairline', () => {
    const rightPanels = source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx');
    const columnDivider = rightPanels.slice(rightPanels.indexOf('function ColumnDivider({'));

    expect(rightPanels).toContain('node.clientWidth >= sidebarSplitMinWidth(minimumWidth)');
    expect(rightPanels).toContain('const split = panels.length === 2;');
    expect(rightPanels).toContain('<ColumnDivider');
    expect(columnDivider).toContain("position: 'relative'");
    expect(columnDivider).toContain('zIndex: 1');
    expect(columnDivider).toContain(
      "width: 0.5, height: '100%', background: 'var(--workspace-local-border)'",
    );
  });

  it('bleeds glass along the cross of the seam and the tab lines while the seam is dragged', () => {
    const layout = source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx');
    const shell = source('src/styles/desktop-shell.css');
    const drag = block(layout, 'const onDividerMouseDown = ', 'const preventSelection');

    // Run by the distance the seam actually moves (clamped), on the layout
    // root: the inner pair, so the sidebar's outer edge and account line stay
    // still and the shell's own moves still reach these lines.
    expect(drag).toContain('const moved = Math.abs(clamped - seam) * (rect.width - SIDEBAR_DIVIDER_WIDTH);');
    expect(drag).toContain('if (rootRef.current) stepInnerGlassFlow(rootRef.current, moved);');
    expect(drag).not.toContain('stepGlassFlow(');
    // The cross: the seam's own line, and the line under each column's tabs,
    // both inside the layout (each pane renders its tab row).
    expect(layout).toContain('<span className="flow-line flow-line--v sidebar-pane-divider__flow" aria-hidden="true" />');
    expect(layout).toContain('{panel.header}');
    for (const header of ['src/renderer/components/leftBars/LeftSidebarHeader.tsx', 'src/renderer/components/rightBars/RightSidebarHeader.tsx']) {
      expect(source(header)).toContain('<span className="flow-line flow-line--h workspace-panel-tab-row__flow" aria-hidden="true" />');
    }
    expect(block(shell, '.workspace-panel-tab-row__flow {', '}')).toContain('bottom: 0;');
    // No per-frame variables on the root element.
    expect(layout).not.toContain('documentElement.style');
    expect(designSystemDocs()).toContain('拖动双栏中缝时');
  });

  it('pushes the pane divider in and out with glass when a sidebar splits or merges', () => {
    const layout = source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx');
    const shell = source('src/styles/desktop-shell.css');

    expect(layout).toContain("className={panel.id === entering ? 'sidebar-pane--entering' : undefined}");
    expect(layout).toContain('<SidebarPaneGhost grow={leaving.grow} />');
    expect(layout).toContain('trackGlassFlow(shell, () => divider.getBoundingClientRect().left);');
    // Grow factors never sum below 1 mid-animation, or flexbox leaves a gap.
    expect(layout).toContain('flex: `${grow * GROW_SCALE} 1 0`,');
    expect(block(shell, '@keyframes sidebar-pane-in {', '}')).toContain('flex-grow: 0;');
    expect(block(shell, '@keyframes sidebar-pane-out {', '}')).toContain('flex-grow: 0;');
    // The split button rides in with the remaining half's tab row.
    expect(layout).not.toContain('SidebarSplitButton');
    expect(shell).not.toContain('data-split-leaving');
    // The split button sits at the end of the tab row where the next half
    // arrives: the side of the half last closed.
    for (const [header, side] of [
      [source('src/renderer/components/leftBars/LeftSidebarHeader.tsx'), 'left'],
      [source('src/renderer/components/rightBars/RightSidebarHeader.tsx'), 'right'],
    ] as const) {
      expect(header).toContain(`<SidebarSplitButton side="${side}" edge="start" />`);
      expect(header).toContain(`<SidebarSplitButton side="${side}" edge="end" />`);
    }
    expect(source('src/renderer/components/SidebarSplitButton.tsx')).toContain(
      "(layout.splitEdge ?? 'end') === edge",
    );
  });

  it('pushes a pane body away like heavy ice when its tab changes', () => {
    const layout = source('src/renderer/shells/desktop/DesktopSidebarLayout.tsx');
    const shell = source('src/styles/desktop-shell.css');

    expect(layout).toContain('dir: order.indexOf(tab) < order.indexOf(shown.tab) ? 1 : -1');
    expect(layout).toContain("aria-hidden={slide.role === 'out' ? true : undefined}");
    // One strip of panels, moved from where each panel is right now
    // (planSidebarPush), 265 ms on the slow-then-fast ice curve.
    const motion = source('src/renderer/lib/motion.ts');
    expect(motion).toContain('export const PUSH_MS = 265;');
    expect(motion).toContain("export const PUSH_EASING = 'cubic-bezier(0.8, 0, 0.66, 1)';");
    expect(layout).toContain("import { PUSH_EASING, PUSH_MS, PUSH_OUTLINE_FADE_MS, STRUCTURAL_MS } from '../../lib/motion';");
    expect(layout).toContain('const moves = planSidebarPush(now, target, strip.clientWidth, push.dir);');
    expect(layout).toContain("{ duration: PUSH_MS, easing: PUSH_EASING, fill: 'forwards' }");
    expect(shell).not.toContain('@keyframes sidebar-push-');
    // The arriving panel alone is outlined on all four sides (its shared
    // edge included) by lines that bleed glass with the push.
    for (const edge of ['h sidebar-pane__outline-top', 'h sidebar-pane__outline-bottom', 'v sidebar-pane__outline-start', 'v sidebar-pane__outline-end']) {
      expect(layout).toContain(`flow-line flow-line--${edge}`);
    }
    expect(layout).toContain("slide.role === 'in' && (");
    expect(layout).toContain('trackGlassFlow(strip, () => panels.get(target)?.getBoundingClientRect().left ?? 0);');
  });

  it('shows only the chapter count until the first storyline exists', () => {
    const subheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const controls = source('src/styles/ui-controls.css');
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')) as {
      leftSidebar: { viewMode: Record<string, string> };
    };
    const textControl = block(controls, '.left-panel-view-mode-text {', '.panel-tab-tray {');
    const hoverState = block(controls, '.left-panel-view-mode-text:hover,', '.panel-tab-tray {');
    const meta = block(subheader, 'const meta =', '// Effective chapter view mode');

    expect(subheader).not.toContain("from '../ui/Switch'");
    expect(subheader).not.toContain('<Switch');
    expect(subheader).not.toContain('ViewModeSwitch');
    expect(subheader).toContain('className="left-panel-view-mode-text"');
    expect(subheader).toContain('onClick={handleToggleChapterViewMode}');
    expect(meta).toContain("t('leftSidebar.viewMode.chapterSummary'");
    expect(meta).toContain('storylines.length > 0');
    expect(meta).toContain('storylines: storylines.length');
    expect(meta).toContain('chapters: storylineNodeCount');
    expect(meta).toContain("t('leftSidebar.meta.chapters', { count: storylineNodeCount })");
    expect(meta).not.toContain('isStorylineView');
    expect(subheader).not.toContain("t('leftSidebar.viewMode.globalSummary'");
    expect(textControl).toContain('border: 0;');
    expect(textControl).toContain('background: transparent;');
    expect(hoverState).toContain('color: hsl(var(--ink-1));');
    expect(hoverState).not.toContain('background:');
    expect(hoverState).not.toContain('border:');
    expect(zh.leftSidebar.viewMode.chapterSummary).toBe(
      '{{storylines}} 条故事线 · {{chapters}} 章',
    );
    expect(zh.leftSidebar.viewMode.storylineSummary).toBeUndefined();
    expect(zh.leftSidebar.viewMode.globalSummary).toBeUndefined();
  });

  it('selects left-panel cells in sand, not with an accent or surface wash', () => {
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
    // Every cell is a SandCell: its kind mark, a hairline glass ring under
    // the pointer and a frame drawn beside the mark when selected.
    const sandCell = source('src/renderer/components/ui/SandCell.tsx');
    const materials = source('src/styles/materials.css');
    expect(sandCell).toContain("selected ? 'is-selected' : ''");
    expect(sandCell).toContain('<i className="cell-ring" aria-hidden="true" />');
    expect(sandCell).toContain('<SandFrame selected={selected} />');
    expect(materials).toContain('.sand-cell:hover > .cell-ring { opacity: 1; animation-play-state: running; }');
    expect(materials).toContain('.sand-cell.is-selected > .cell-frame {');
    expect(chapterPanel).toContain('<KindMark\n          kind="chapter"');
    expect(elementPanel).toContain('<KindMark\n            kind="element"');
    expect(driftPanel).toContain('<KindMark\n            kind="drift"');
    for (const panel of panels) {
      expect(panel).toContain('<SandCell');
      expect(panel).not.toContain("background: selected ? 'hsl(var(--surface))' : 'transparent'");
      expect(panel).not.toContain(
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
    const designSystem = designSystemDocs();
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
      "const [collapsedGroupIds, setCollapsedGroupIds] = useSidebarPanelState<Set<string>>('collapsed', () => new Set());",
    );
    expect(unaffiliatedGroup).toContain('<GroupHeaderCell');
    expect(unaffiliatedGroup).toContain("name={t('leftSidebar.groups.unaffiliated')}");
    expect(unaffiliatedGroup).toContain('collapsed={collapsedGroupIds.has(UNAFFILIATED_GROUP_ID)}');
    expect(unaffiliatedGroup).toContain(
      'onToggleCollapsed={() => toggleGroupCollapsed(UNAFFILIATED_GROUP_ID)}',
    );
    expect(unaffiliatedGroup).toContain('onAdd={() => void handleCreateNode(null)}');
    expect(unaffiliatedGroup).toContain('unaffiliatedChapters.map((node) => renderNodeCard(node))');
    expect(chapterPanel).toContain("const UNAFFILIATED_STRIPE_COLOR = 'hsl(var(--ink-4))';");
    expect(chapterPanel).toContain(
      'const stripeColor = storyline?.color ?? UNAFFILIATED_STRIPE_COLOR;',
    );
    expect(chapterPanel).not.toContain("const stripeColor = storyline?.color ?? 'transparent';");
    expect(store).not.toContain('chapterUnaffiliatedFooterHeight');
    expect(designSystem).toContain('“未归属”复用普通故事线组的 header、计数、折叠与新增章节交互');
    expect(designSystem).toContain('固定追加在全部真实故事线之后');
    expect(designSystem).toContain('左侧 label 使用与组头一致的 `--ink-4` 中性灰');
  });

  it('gives entity and comment-source hover cards the menus\' surface', () => {
    const css = source('src/styles/index.css');
    const hoverCard = source('src/renderer/features/entities/hover/EntityHoverCard.tsx');
    const consumers = [
      source('src/renderer/components/leftBars/ChapterPanel.tsx'),
      source('src/renderer/components/leftBars/ElementPanel.tsx'),
      source('src/renderer/components/leftBars/DriftPanel.tsx'),
      source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx'),
    ];

    const sourceCard = block(source('src/styles/comments-review.css'), '.comment-source-hover {', '.comment-source-hover__content {');

    const shell = block(source('src/styles/ui-controls.css'), '.hover-card {', '}');

    expect(css).not.toContain('--entity-hover-card-shadow');
    expect(hoverCard).toContain('<HoverCardShell');
    expect(shell).toContain('background: var(--menu-surface-bg);');
    expect(shell).toContain('box-shadow: var(--menu-surface-shadow);');
    expect(shell).toContain('border-radius: var(--menu-surface-radius);');
    expect(hoverCard).not.toContain("border: '1px solid");
    expect(sourceCard).toContain('background: var(--menu-surface-bg);');
    expect(sourceCard).toContain('box-shadow: var(--menu-surface-shadow);');
    for (const consumer of consumers) {
      expect(consumer).toContain('<EntityHoverCard');
    }
  });

  it('keeps edge slabs collapsed by default and preserves only their structural motion', () => {
    const store = source('src/renderer/store/ui-store.ts');
    const css = source('src/styles/index.css');
    const defaults = block(store, 'sidebars: {', 'setTheme:');

    expect(defaults.match(/isOpen:\s*false/g)).toHaveLength(2);
    expect(css).toContain('transition: width var(--motion-structural) var(--motion-structural-ease);');
    expect(source('src/renderer/components/Sidebar.tsx')).toContain('setTimeout(() => setMountChildren(false), STRUCTURAL_MS);');
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
    const reviewCss = source('src/styles/comments-review.css');
    const bottomTimeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const leftSubheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const elementPanel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const review = source('src/renderer/components/rightBars/ReviewPanel.tsx');
    const library = source('src/renderer/features/library/LibraryPanel.tsx');
    const timeline = block(timelineCss, '.btl {', '/* ---------------- Head bar');
    const desktopShellCss = source('src/styles/desktop-shell.css');
    const bottomPanel = block(desktopShellCss, '.bottom-panel {', '.bottom-panel__resize {');
    const timelineHead = block(desktopShellCss, '.bottom-panel-head {', '.bottom-panel-head__start {');
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
    const reviewList = block(reviewCss, '.review-panel__list {', '.review-panel__resolved {');
    const materialTreeRows = block(source('src/styles/material-workbench.css'), '.material-tree__rows {', '.material-tree__rows--drop {');
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
    // The Bottom Panel's shell draws the border the timeline and planner share.
    expect(timeline).not.toContain('border-top');
    expect(bottomPanel).toContain('border-top: 1px solid var(--workspace-border);');
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
    expect(review).toContain('className="review-panel"');
    expect(library).toContain("background: 'var(--workspace-ui-bg)'");
    expect(leftHeader).toContain('className="workspace-local-divider');
    expect(leftSubheader).not.toContain('workspace-local-divider');
    expect(rightHeader.match(/className="workspace-local-divider/g)).toHaveLength(1);
    expect(review).not.toContain('workspace-local-divider');
    expect(library).not.toContain('workspace-local-divider');
    expect(localDivider).toContain('right: 0;');
    expect(localDivider).toContain('left: 0;');
    expect(localDivider).toContain('height: 0.5px;');
    expect(localDivider).toContain('background: var(--workspace-local-border);');
    expect(listRow).toContain('border: 0;');
    expect(listRow).not.toContain('workspace-card-border');
    expect(listRow).toContain('background: color-mix');
    expect(listRow).toContain('box-shadow: none;');
    expect(review).toContain('className="review-panel__list scroll-no-bar workspace-list"');
    expect(reviewList).toContain('padding: 6px 12px 12px;');
    expect(reviewList).toContain('gap: 6px;');
    expect(library).toContain('className="scroll-no-bar workspace-list"');
    expect(library).toContain('<MaterialFolderTree');
    expect(materialTreeRows).toContain('padding: 6px 12px 12px;');
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
    const relationTypeField = source('src/renderer/components/ui/RelationTypeField.tsx');
    const relationKindMenu = source('src/renderer/components/ui/RelationKindMenu.tsx');
    const superElement = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    const storyGraph = source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx');
    const edgePopover = source('src/renderer/components/graph/RelationEdgePopover.tsx');
    const edgePopoverCss = source('src/styles/relation-edge-popover.css');
    const libraryCard = source('src/renderer/features/library/LibraryItemCard.tsx');

    expect(sharedHeader).toContain('<BrushIcon name="arrow-back" size={16} />');
    expect(sharedHeader).not.toContain('super-view-head__back-glyph');
    expect(settings).toContain('<BrushIcon name="arrow-back" size={16} />');
    expect(settings).not.toContain("t('settings.title_en')");
    expect(settings).not.toContain("t('settings.esc_close')");
    expect(driftPanel).toContain('<BrushIcon name="close" size={14} />');
    expect(driftPanel).not.toContain('>×<');
    expect(block(driftCss, '.drift-panel__close {', '.drift-panel.is-open')).toContain(
      'border-radius: 50%;',
    );

    expect(relationTypeField).toContain('<AnchoredPopover');
    // Modal-safe suggestions; on the desktop they sit on the menu shell.
    expect(relationTypeField).toContain(
      "'menu-surface relation-kind-suggestions relation-type-suggestions'",
    );
    expect(relationTypeField).toContain("'relation-kind-suggestions relation-type-suggestions'");
    expect(relationTypeField).not.toContain("position: 'absolute'");
    expect(relationKindMenu).toContain('setRelationTypeColor(type.id, paletteColor)');
    expect(relationKindMenu).toContain('removeRelationTypeMeta(type.id)');
    expect(relationKindMenu).toContain('disabled={type.locked}');
    expect(relationKindMenu).not.toContain('reassignMeta');
    expect(relationKindMenu).not.toContain('updateRelationKind');
    expect(relationKindMenu).toContain('export function RelationTypeEditor');
    expect(superElement).toContain('<RelationTypeField');
    expect(superElement).toContain('<RelationTypeEditor');
    expect(superElement).toContain('setPendingLinkTypeId(created.id)');
    expect(superElement).toContain('<RelationEdgePopover');
    expect(superElement).toContain('<RelationArrowMarker');
    expect(superElement).toContain('markerEnd={edge.directed');
    expect(superElement).not.toContain('data-super-edge-delete');
    expect(storyGraph).toContain('<RelationTypeField');
    expect(storyGraph).toContain('<RelationTypeEditor');
    expect(storyGraph).toContain('setNewEdgeTypeId(created.id)');
    expect(storyGraph).toContain('<RelationEdgePopover');
    expect(storyGraph).toContain('<RelationArrowMarker');
    expect(storyGraph).toContain('markerEnd={directed');
    expect(storyGraph).not.toContain('graph-edge-delete');
    expect(edgePopover).toContain("import { createPortal } from 'react-dom'");
    expect(edgePopover).toContain('data-relation-edge-popover');
    expect(edgePopover).toContain('relation.fromKind');
    expect(edgePopover).toContain('relation.toKind');
    expect(edgePopoverCss).toContain('z-index: 286;');
    expect(edgePopoverCss).not.toContain('border-left');
    expect(libraryCard).toContain("maxHeight: isTextExpanded || pickerOpen ? 'none' : 320");
    expect(libraryCard).toContain("overflow: isTextExpanded || pickerOpen ? 'visible' : 'hidden'");
  });

  it('owns one trailing relation menu across graph-style Super Views', () => {
    const header = source('src/renderer/shells/desktop/components/DesktopSuperViewHeader.tsx');
    const relationControl = source(
      'src/renderer/shells/desktop/components/DesktopSuperViewRelationControl.tsx',
    );
    const storyGraph = source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx');
    const superElement = source('src/renderer/shells/desktop/views/DesktopSuperElementView.tsx');
    const memoMaterial = source(
      'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx',
    );

    expect(header).toContain("activeSuperView === 'element' || activeSuperView === 'graph'");
    expect(header).toContain('<DesktopSuperViewRelationControl canvas={relationCanvas} />');
    expect(relationControl).toContain('<RelationKindMenu');
    expect(relationControl).toContain('relationTypeGroups={{');
    expect(storyGraph).not.toContain('<RelationKindMenu');
    expect(superElement).not.toContain('<RelationKindMenu');
    expect(memoMaterial).not.toContain('<RelationKindMenu');
  });

  it('keeps shared controls and high-exposure cards on the compact radius ladder', () => {
    const index = source('src/styles/index.css');
    const controls = source('src/styles/ui-controls.css');
    const dashboard = source('src/styles/dashboard.css');
    const picker = source('src/styles/project-picker.css');
    const agent = source('src/styles/agent-panel.css');
    const search = source('src/styles/search.css');
    const review = source('src/styles/comments-review.css');

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
    expect(block(picker, '.pp-card {', '.pp-card__body {')).toMatch(
      /border-radius:\s*2px;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(block(agent, '.agt-composer {', '.agt-composer:focus-within {')).toContain(
      'border-radius: 2px;',
    );
    // Global search is a floating layer: the menu shell's square corner and shadow.
    expect(block(search, '.gsearch-modal {', '.gsearch-header {')).toContain(
      'border-radius: var(--menu-surface-radius);',
    );
    expect(block(review, '.review-card--sticky {', '.review-card--manual')).toMatch(
      /border-radius:\s*var\(--radius-sm\);[\s\S]*?box-shadow:\s*none;/,
    );
    expect(block(review, '.sticky-note-stack {', '.sticky-note-stack__layers {')).toMatch(
      /border-radius:\s*var\(--radius-sm\);[\s\S]*?box-shadow:\s*none;/,
    );
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
    // The phone keeps its hairline table; desktop draws the grid as lanes of
    // paper slips (paper-tools-sand-glass.acceptance.test.ts).
    expect(
      block(planner, ".planner-wrap[data-presentation='mobile'] .pl-cell {", '}'),
    ).toMatch(/border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/);
  });

  it('records the shipped mobile product path without claiming touch readiness', () => {
    const readme = source('README.md');
    const docsIndex = source('docs/README.md');
    const mobileDoc = source('docs/mobile-ui-foundation.md');
    const css = source('src/styles/index.css');

    expect(readme).toContain('docs/README.md');
    expect(docsIndex).toContain('mobile-ui-foundation.md');
    expect(mobileDoc).toContain('Drifting has a distinct mobile product path');
    expect(mobileDoc).toContain('Opening a project mounts `MobileAppShell`');
    expect(mobileDoc).toContain('Only the active paper mounts a full editor');
    expect(mobileDoc).toContain('visualViewport');
    expect(mobileDoc).toContain('physical-device appearance or feel');
    expect(css).toContain("html[data-platform-target='mobile'] .app-root");
    expect(css).toContain('height: 100dvh !important;');
    expect(css).toContain("html[data-shell-mode='mobile'] .sidebar-shell");
  });

  it('records the palette boundary and manual visual acceptance boundary', () => {
    const doc = designSystemDocs();

    expect(doc).toContain('单层桌面，只有一张抬起的稿纸');
    expect(doc).toContain('它们全部使用从 editor 稿纸外侧提取的');
    expect(doc).toContain('macOS 也不再启用透明窗口、`windowEffects` 或 `macOSPrivateApi`');
    expect(doc).toContain('只表达左右栏与 Bottom Timeline 的一级模块边界');
    expect(doc).toContain('三方交点没有渐变、阴影或额外装饰');
    expect(doc).toContain(
      '侧栏局部层级只在 Tabs 与 panel header 之间保留一条完整的 `0.5px` hairline',
    );
    expect(doc).toContain('panel header 直接衔接 content，不再重复画第二条线');
    expect(doc).toContain('Tab 本身只是文字，没有玻璃框，也没有按压态');
    expect(doc).toContain('两者同一刻落地');
    expect(doc).toContain('三栏从窗口顶边贯通到底边');
    expect(doc).toContain('**侧栏开关常驻两角**');
    expect(doc).toContain('**账户在左栏底部**');
    expect(doc).toContain('**标签页在稿纸顶部**');
    expect(doc).toContain('**时间线开关在稿纸右下角**');
    expect(doc).toContain('**全书视图在对应实体旁边**');
    expect(doc).toContain('**稿纸的操作留在稿纸上**');
    expect(doc).toContain('**字数暂时移除**');
    expect(doc).toContain('## Sand and glass');
    expect(doc).toContain('**玻璃是手按的东西**');
    expect(doc).toContain('**砂笔是作者留下的痕迹**');
    expect(doc).toContain('**红灯关闭项目**');
    expect(doc).toContain('不重新定义现有配色');
    expect(doc).toContain('通用圆角阶梯限定为 `1px / 2px / 3px`');
    expect(doc).toContain('Plot Planner 是一张连续的网格，不是带 gap、阴影和 hover lift 的卡片集合');
    expect(doc).toContain('不能替代 macOS 窗口控件几何、iOS 或 Android 上的视觉、触摸和动效验收');
  });

  it('draws the chapter end, dock and user menu icons with the sand brush', () => {
    const chapterEnd = source('src/renderer/components/editor/ChapterEndOrnament.tsx');
    const dock = source('src/renderer/components/workspaceChrome/WorkspaceTabDock.tsx');
    const topTimeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const userMenu = source('src/renderer/components/topBars/UserMenu.tsx');
    const brushIcon = source('src/renderer/components/ui/BrushIcon.tsx');
    const materials = source('src/styles/materials.css');
    const generator = source('scripts/design-assets/brushicons.py');

    // ⁂ is three stones, on chapter pages and on drift pages alike; its three
    // actions each lead with an icon.
    expect(chapterEnd).not.toContain('>⁂<');
    expect(chapterEnd.match(/<BrushIcon name="stones-triad" size=\{20\} \/>/g)).toHaveLength(2);
    expect(chapterEnd).toContain("icon: finished ? 'brush-lifted' : 'brush-laid'");
    expect(chapterEnd).toContain("icon: 'sprout'");
    expect(chapterEnd).toContain("icon: 'shikigami'");
    expect(chapterEnd).toContain('<BrushIcon name={item.icon} size={14} />');
    expect(dock).toContain("<BrushIcon name={locked ? 'lock-shut' : 'lock-open'} size={14} />");
    expect(dock).not.toContain('<svg');
    expect(topTimeline).toContain('<BrushIcon name="plus" />');
    expect(userMenu).not.toContain("from 'lucide-react'");
    for (const name of ['jizo', 'wen', 'dharma-wheel', 'movable-type', 'case-dew', 'books']) {
      expect(userMenu).toContain(`<BrushIcon name="${name}" size={13} />`);
    }
    expect(userMenu).toContain("name={themeMode === 'light' ? 'enso' : themeMode === 'dark' ? 'ink-disc' : 'taiji'}");
    expect(userMenu).toContain("<BrushIcon name={canSignOut ? 'gate-out' : 'gate-in'} size={13} />");

    // Every icon is registered, masked and generated from a fixed seed.
    const names = [
      'stones-triad', 'brush-laid', 'brush-lifted', 'sprout', 'shikigami', 'lock-open', 'lock-shut', 'plus',
      'jizo', 'enso', 'ink-disc', 'taiji', 'wen', 'dharma-wheel', 'movable-type', 'case-dew', 'books',
      'gate-in', 'gate-out',
      // Small glyphs, finished with fine grain.
      'close', 'arrow-back', 'arrow-forward', 'chevron-down', 'chevron-right', 'chevron-up', 'chevron-left',
      'check', 'minus', 'loader', 'trash', 'edit', 'search', 'copy', 'stop', 'folder', 'folder-open', 'folder-plus',
      // Objects and states.
      'file-text', 'comment-plus', 'rotate', 'sort', 'status-done', 'status-warning', 'status-stopped', 'cloud',
      'checklist', 'checklist-plus', 'sticky-note', 'mic', 'image', 'image-plus', 'eraser', 'share', 'layers', 'branch',
      'view-grid', 'view-list', 'open-book', 'knots', 'case-rise', 'tea', 'spread', 'locate', 'new-storyline',
      'new-category', 'folding-fan',
      // A closed sidebar's crescent, cleared from the committed solid one.
      'moon-left-hollow', 'moon-right-hollow',
      // The Agent composer's send and steer, a weight heavier.
      'lift', 'lift-bent',
    ];
    for (const name of names) {
      expect(brushIcon).toContain(`| '${name}'`);
      expect(materials).toContain(`.brush-icon--${name} { -webkit-mask-image: url('../assets/design/icons/${name}.png');`);
      expect(existsSync(resolve(process.cwd(), `src/assets/design/icons/${name}.png`))).toBe(true);
      // Drawn from a fixed seed, turned/mirrored from one that is, or (the
      // hollow moons) cleared out of a committed solid one.
      if (name.endsWith('-hollow')) continue;
      expect(generator).toMatch(new RegExp(`"${name}": \\(\\w+, \\d+\\)|masks\\["${name}"\\] =|\\(\\d, "${name}"\\)`));
    }
    expect(generator).toContain('masks[f"moon-{side}-hollow"] = np.where(body, np.maximum(grains, trace), rim)');
    expect(designSystemDocs()).toContain('- **砂笔图标**（`BrushIcon`）');

    // The last hand-drawn SVG icons are brush icons too.
    expect(source('src/renderer/shells/desktop/views/DesktopStoryGraphView.tsx')).toContain('<BrushIcon name="spread" size={11} />');
    const bottomTimeline = source('src/renderer/shells/desktop/views/DesktopBottomTimeline.tsx');
    expect(bottomTimeline).toContain('<BrushIcon name="spread" size={12} />');
    expect(bottomTimeline).toContain('<BrushIcon name="locate" size={12} />');
    const subHeader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    expect(subHeader).toContain('icon = <BrushIcon name="new-storyline" size={12} />;');
    expect(subHeader).toContain('icon = <BrushIcon name="new-category" size={12} />;');
    expect(source('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx')).toContain('<BrushIcon name="search" size={13} />');
    expect(source('src/renderer/features/agent/AgentComposerConfig.tsx')).toContain('<BrushIcon name="dharma-wheel" size={16} />');
    expect(source('src/renderer/components/leftBars/AgentChangeIndicator.tsx')).toContain('<BrushIcon name="check" size={10} />');
  });

  it('keeps lucide out of the desktop renderer outside the paused mobile shell', () => {
    const files = (readdirSync(resolve(process.cwd(), 'src/renderer'), { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.') && !file.startsWith('shells/mobile/'));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      expect(source(`src/renderer/${file}`), file).not.toContain("from 'lucide-react'");
    }
    // The shared generator draws them with fine grain; the spinner turns in CSS.
    const generator = source('scripts/design-assets/brushicons.py');
    expect(generator).toContain('masks[name] = grain_fine(draw(rng), rng)');
    expect(source('src/renderer/components/notifications/NotificationPill.tsx')).toContain(
      '<BrushIcon name="loader" size={size} className="ui-spin" />',
    );
  });

  it('keeps characters from standing in for icons on the desktop', () => {
    // Characters that only ever serve as icons: chevrons, ticks and crosses,
    // list, kind and status glyphs, swap and turn arrows.
    const iconOnly = /[▸▾▴▶◀◂►▹▿◃▵✓✔✗✘☑☐☒✕✖＋☰◌●○◉◆◇◈▣❦¶⚓⚠✦✎✏⇄⇅↔↗↘↙↖↳↺↻⌫☀⚷⌁⌨💭›‹]/u;
    // Characters that are an icon when they stand alone as a node's whole
    // text or a one-character string; inside a sentence they are punctuation.
    const lone = /^\s*[×+→←↑↓…]\s*$|>\s*[×+→←↑↓…]\s*<|['"`][×→←↓§⌘]['"`]/u;
    const allowed: [string, RegExp][] = [
      // Project Home's 「全部章节」 waits for the Home page rework.
      ['views/ProjectDashboard.tsx', /☰/u],
      // Only rendered in the paused mobile shell (`mobileActions={mobileShell}`).
      ['features/library/LibraryItemCard.tsx', /^\s*\w+: '[＋→↗×]',$/u],
      // Shortcut text: the plus between two keys.
      ['features/settings/panels/ControlSettingsPanels.tsx', /kbd--plus/],
    ];
    const withoutComments = (text: string) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const files = (readdirSync(resolve(process.cwd(), 'src/renderer'), { recursive: true }) as string[]).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !file.includes('.test.') &&
        !file.startsWith('shells/mobile/') &&
        !file.startsWith('performance/') &&
        (!file.startsWith('lib/') || /^lib\/(extensions|slash-menu)\//.test(file)),
    );
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      withoutComments(source(`src/renderer/${file}`)).split('\n').forEach((line, index) => {
        if (!iconOnly.test(line) && !lone.test(line)) return;
        if (allowed.some(([path, pattern]) => path === file && pattern.test(line))) return;
        found.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);

    // Nor in generated content: the drift a time marker is bound to shows as
    // the drift's sand eddy, a deep link carries the brush hook.
    const stylesheets = (readdirSync(resolve(process.cwd(), 'src/styles')) as string[]).filter(
      (file) => file.endsWith('.css') && file !== 'mobile-workspace.css',
    );
    const generated: string[] = [];
    for (const file of stylesheets) {
      for (const match of withoutComments(source(`src/styles/${file}`)).matchAll(/content:\s*(['"])(.*?)\1/g)) {
        if (iconOnly.test(match[2]) || /^[×+→←↑↓]$/u.test(match[2])) generated.push(`${file}: ${match[0]}`);
      }
    }
    expect(generated).toEqual([]);
    expect(source('src/styles/bottom-timeline.css')).toContain("mask: url('../assets/design/sand/mark-spiral.png')");
    expect(source('src/styles/index.css')).toContain("mask: url('../assets/design/icons/hook.png')");

    // Nor folded into a label: the button draws the icon, the string keeps the words.
    const labels: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (/^[＋+✓●○↓↑→↗⇄☰⚓]\s|\s[↗→]$/u.test(value) && !/^(agentPanel\.mobile|mobileTimeline)\./.test(path)) {
          labels.push(`${path}: ${value}`);
        }
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
      }
    };
    for (const locale of ['en', 'zh-CN']) walk(JSON.parse(source(`src/renderer/locales/${locale}.json`)), '');
    expect(labels).toEqual([]);

    // The places the author picked brush icons for.
    const settingsModal = source('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    expect(settingsModal).toContain("icon: 'name-seal'");
    expect(settingsModal).toContain("icon: 'inkstone'");
    // About carries no icon, and nothing calls Drifting 「渡」.
    expect(block(settingsModal, "id: 'about'", '}')).toContain('icon: null');
    expect(settingsModal).not.toContain('渡');
    expect(source('src/renderer/locales/zh-CN.json')).not.toMatch(/渡口|渡舟/u);
    const messages = source('src/renderer/features/agent/AgentMessageViews.tsx');
    expect(messages).toContain(
      "<BrushIcon name=\"thinking\" size={12} inline className={msg.streaming ? undefined : 'brush-icon--still'} />",
    );
    expect(messages).toContain("t.status === 'completed' ? 'task-done' : t.status === 'in_progress' ? 'task-doing' : 'task-todo'");
    expect(messages).toContain("msg.status === 'running' ? 'loader' : msg.status === 'ok' ? 'status-done' : 'status-stopped'");
    expect(source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx')).toContain('<BrushIcon name="stitched" size={11} />');
    expect(source('src/renderer/components/graph/RelationEdgePopover.tsx')).toContain(
      "const flowIcon = orientation === 'symmetric' ? 'both-ways' : 'arrow-forward';",
    );
    expect(source('src/renderer/components/editor/PlotGrid.tsx')).toContain('<BrushIcon name="grip" size={12} />');
    expect(source('src/renderer/components/BottomTimeline/ActRail.tsx')).toContain(
      '<KindMark kind="drift" color="hsl(var(--accent))" />',
    );
    const css = source('src/styles/materials.css');
    expect(css).toContain('animation: brush-thinking 720ms steps(6, jump-none) infinite alternate;');
    expect(source('scripts/design-assets/brushicons.py')).toContain('STRIPS = {"thinking": (thinking, 4102)}');
  });

  it('wears sand and glass in the desktop Agent panel', () => {
    const panel = source('src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    const transcript = source('src/renderer/features/agent/desktop/DesktopAgentTranscript.tsx');
    const views = source('src/renderer/features/agent/AgentMessageViews.tsx');
    const agentCss = source('src/styles/agent-panel.css');
    const materials = source('src/styles/materials.css');

    // The composer: a rounded slip with the resting line, its menus in a
    // glass tray, stop / steer / send as single round glass buttons.
    expect(panel).toContain('className="agt-composer agt-composer--glass glass glass--rest glass--field"');
    expect(panel).toContain('className="agt-composer__tray glass glass--rest"');
    expect(panel).toContain('<AgentComposerConfig glass />');
    expect(panel).toContain('part="button"');
    expect(panel).toContain('part="status"');
    expect(panel).toContain('className="agt-round glass glass--rest glass--round"');
    expect(panel).toContain('<BrushIcon name="stop" size={12} />');
    expect(panel).toContain("<BrushIcon name={pendingControl?.status === 'waiting_user' ? 'lift' : 'lift-bent'} size={17} />");
    expect(panel).toContain('<BrushIcon name="lift" size={17} />');
    expect(panel).not.toContain('agt-send');
    expect(block(agentCss, '.agt-composer.agt-composer--glass {', '}')).toContain('border-radius: 16px;');
    expect(block(agentCss, '.agt-composer--glass .agt-composer__bar {', '}')).toContain('border-top: 0;');

    // Only the desktop transcript opens the glass; the mobile shell keeps its look.
    expect(transcript).toContain('<AgentGlassContext.Provider value>');
    expect(transcript).toContain('className="agt-control-card agt-control-card--glass glass glass--waiting"');
    expect(views).toContain("const [arriving] = useState(() => msg.status === 'running');");
    expect(views).toContain('className="agt-user-bubble glass glass--rest glass--still"');
    expect(block(agentCss, '.agt-user-bubble {', '}')).toContain('border-radius: 16px;');

    // The materials: read-only stays still, a field is selected while it holds
    // the caret, the primary is the accent's glass, waiting glass runs the other
    // way, and an arriving step is swept before its line comes in.
    expect(block(materials, '.glass--still:hover,', '.glass--field')).toContain('animation-play-state: paused;');
    expect(materials).toContain('.glass--field:focus-within { --glass-g: 1; --glass-sp: 1; }');
    expect(block(materials, '.glass--primary {', '}')).toContain('--glass-cc: hsl(var(--accent));');
    expect(materials).toContain('.glass--primary:disabled::before { animation: none; }');
    expect(materials).toContain('.glass--waiting::before { opacity: 1; animation-play-state: running; }');
    expect(materials).toContain('.glass--waiting:hover::before { animation-play-state: paused; }');
    expect(materials).toContain('animation: glass-sweep var(--motion-sweep) var(--motion-sweep-ease) both;');
    expect(block(materials, '.glass-sweep.glass--rest::before {', '}')).toContain('glass-sweep-line var(--motion-sweep) ease-out backwards;');
    expect(block(materials, '@keyframes glass-sweep-line {', '100%')).toContain('0%, 40% { opacity: 0; }');

    // Glass with no colour of its own is the clear glass, the dock's pills too.
    const dock = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    expect(dock).toContain("const accent = color || 'var(--glass-clear)';");
    expect(dock).not.toContain("|| 'hsl(var(--ink-3))',");

    const docs = designSystemDocs();
    expect(docs).toContain('## 主按钮');
    expect(docs).toContain('## 多行输入框');
    expect(docs).toContain('## 等你处理');
    expect(docs).toContain('没有归属的玻璃一律用 `--glass-clear`（浅灰）');
    expect(docs).toContain('| 推波 | 一个刚到的步骤被推进来 | `1.125s`');
  });

  it('dresses Review cards, sticky notes and the stats panel in sand and glass on the desktop', () => {
    const review = source('src/styles/comments-review.css');
    const stats = source('src/styles/stats-panel.css');
    const materials = source('src/styles/materials.css');
    const card = source('src/renderer/features/comments/ReviewItemCard.tsx');
    const sourceCard = source('src/renderer/features/comments/CommentSourceHoverCard.tsx');
    const rail = source('src/renderer/components/editor/StickyNoteRail.tsx');
    const primitives = source('src/renderer/features/stats/StatsPrimitives.tsx');
    const desktopReview = review.slice(review.indexOf('Desktop: sand and glass'));

    // Every material change is desktop-only; the paused mobile shell keeps its look.
    for (const file of [card, sourceCard, rail, primitives]) expect(file).toContain('getPlatformRuntime().isMobileShell');

    // A Review card lays no plate: the resting glass line, drifting under the pointer.
    expect(card).toContain("' review-card--glass glass glass--rest glass--surface'");
    const plate = block(desktopReview, '.review-card.review-card--glass,', '}');
    expect(plate).toContain('background: transparent;');
    expect(plate).toContain('box-shadow: none;');
    // A sticky note floats over the prose: the page at 80% and a faint blur.
    const sticky = block(desktopReview, '.review-card--sticky.review-card--glass,', '}');
    expect(sticky).toContain('background: var(--glass-fill);');
    expect(sticky).toContain('backdrop-filter: blur(1.6px);');
    // Quotes and evidence are flat; the Agent hint is a text button with no tail.
    expect(block(desktopReview, '.review-card--glass :is(.review-card__meta', '}')).toContain('background: transparent;');
    expect(block(desktopReview, '.review-card--glass .review-card__agent-hint::after {', '}')).toContain('content: none;');
    // Done draws the brush tick into its selected round glass.
    expect(block(desktopReview, '.todo-status-toggle__tick {', '}')).toContain('transition: clip-path 0.38s');
    expect(desktopReview).toContain(".todo-status-toggle--glass[aria-pressed='true'] .todo-status-toggle__tick {");
    // The source card names its sources by their sand marks.
    expect(sourceCard).toContain('<KindMark kind={kindMarkOfTarget(entity.targetKind, entity.isDrift)}');
    // The rail keeps clear of the window-control row and the paper's toolbar,
    // so neither the drag strip nor a sidebar toggle covers its buttons.
    const railPlace = block(desktopReview, '.editor-body > .sticky-note-rail.sticky-note-rail--glass {', '}');
    expect(railPlace).toContain('top: calc(var(--window-titlebar-height) + 4px);');
    expect(railPlace).toContain('bottom: calc(16px + 36px + 8px);');
    // The rail's stacking switch keeps one word; stacked is its selected glass.
    expect(rail).toContain('aria-pressed={stacked}');
    expect(rail).toContain('glass="round"');
    // The retired margin notes and chips left no styles behind.
    expect(review).not.toContain('.mnote');
    expect(review).not.toContain('.comment-chip');

    // The stats panel: flat type and space, rows with the cell ring, sand readouts.
    expect(primitives).toContain('className="stats-link sand-cell"');
    expect(primitives).toContain('<i className="cell-ring" aria-hidden="true" />');
    expect(primitives).toContain('<KindMark kind={kind}');
    expect(primitives).toContain('className="sand-stroke"');
    expect(block(stats, '.stats-section {', '}')).not.toContain('border');
    expect(stats).not.toMatch(/background: (?!transparent)/);
    const stroke = block(materials, '.sand-stroke {', '}');
    expect(stroke).toContain("url('../assets/design/sand/ul.png')");
    expect(stroke).toContain('max(100%, calc(var(--sand-stroke-h, 7px) * 27.7)) 100%');
    expect(stroke).toContain('mix-blend-mode: var(--pigment-blend);');
    expect(materials).toContain('.sand-stroke { animation: none; transition: none; }');

    const docs = designSystemDocs();
    expect(docs).toContain('## Review 卡');
    expect(docs).toContain('## 批注便笺');
    expect(docs).toContain('## 统计面板');
    expect(docs).toContain('- **砂笔读数**（`.sand-stroke`）');
  });
});
