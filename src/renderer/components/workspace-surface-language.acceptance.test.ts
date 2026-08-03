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
  it('makes the center column own the editor, optional dock and footer', () => {
    const app = source('src/renderer/App.tsx');
    const centerColumn = block(app, '<main\n          className="app-mid"', '</main>');

    expect(centerColumn).toContain('className="workspace-stage"');
    expect(centerColumn).toContain('className="workspace-dock"');
    expect(centerColumn).toContain('<BottomStatusBar />');
    expect(centerColumn.indexOf('className="workspace-stage"')).toBeLessThan(
      centerColumn.indexOf('<BottomStatusBar />'),
    );
    expect(app.indexOf('<Sidebar sidebarType="left">')).toBeLessThan(
      app.indexOf('<main\n          className="app-mid"'),
    );
    expect(app.indexOf('<BottomStatusBar />')).toBeLessThan(
      app.indexOf('<Sidebar sidebarType="right">'),
    );
  });

  it('consolidates Super navigation and keeps Timeline beside its dock', () => {
    const appTopbar = source('src/renderer/views/AppTopbar.tsx');
    const leftTopbar = source('src/renderer/components/topBars/LeftSidebarTopBar.tsx');
    const workspaceNavigation = source(
      'src/renderer/components/topBars/WorkspaceNavigationButtons.tsx',
    );
    const rightTopbar = source('src/renderer/components/topBars/RightSidebarTopBar.tsx');
    const userMenu = source('src/renderer/components/topBars/UserMenu.tsx');
    const notification = source('src/renderer/components/notifications/NotificationPill.tsx');
    const topTimeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const copilot = source('src/renderer/components/copilot/CopilotBottomMenu.tsx');
    const shadow = source('src/renderer/components/ShadowQuickMenu.tsx');
    const footer = source('src/renderer/components/BottomStatusBar.tsx');
    const footerCss = source('src/styles/bottom-status-bar.css');
    const shellCss = source('src/styles/index.css');
    const workspaceNavigationCss = source('src/styles/workspace-navigation.css');
    const nodeEditor = source('src/renderer/views/NodeEditorView.tsx');
    const storylineEditor = source('src/renderer/views/StorylineEditorView.tsx');
    const allChaptersEditor = source('src/renderer/views/AllChaptersEditorView.tsx');

    expect(leftTopbar).toContain('<WorkspaceNavigationButtons />');
    expect(workspaceNavigation.match(/<GhostIconButton/g)).toHaveLength(1);
    expect(workspaceNavigation).toContain('icon={<Home size={16}');
    expect(workspaceNavigation).toContain('<span>SUPER</span>');
    expect(workspaceNavigation).not.toContain('ChevronDown');
    expect(workspaceNavigation).toContain('label="All Chapters"');
    expect(workspaceNavigation).toContain("label: 'Elements'");
    expect(workspaceNavigation).toContain("label: 'Storylines'");
    expect(workspaceNavigation).toContain("label: 'Library'");
    expect(workspaceNavigation).toContain('role="menuitemradio"');
    expect(workspaceNavigation).not.toContain('BottomStatusBarIcons');
    expect(
      existsSync(resolve(process.cwd(), 'src/renderer/components/BottomStatusBarIcons.tsx')),
    ).toBe(false);
    expect(workspaceNavigationCss).toContain('.workspace-super-menu__group--special');
    expect(
      block(
        workspaceNavigationCss,
        '.app-topbar .ghost-icon-button:hover:not(:disabled) {',
        '.workspace-super-trigger {',
      ),
    ).toContain('background: transparent;');
    expect(
      block(
        workspaceNavigationCss,
        '.workspace-super-trigger:hover,',
        '.workspace-super-trigger:focus-visible {',
      ),
    ).not.toContain('background:');
    expect(notification).not.toContain('e.currentTarget.style.background');
    expect(topTimeline).not.toContain('event.currentTarget.style.background');
    expect(appTopbar).toContain('runtime.isMacDesktop ? 230 : 160');
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
    expect(userMenu).toContain("setActiveSettingsPage('shadow')");
    expect(userMenu).toContain('<CopilotQuickSettings');
    expect(userMenu).toContain('<ShadowQuickSettings');
    expect(userMenu).toContain('dismissOnEscape={activeSettingsPage === null}');
    expect(copilot).toContain('export function CopilotQuickSettings');
    expect(copilot).not.toContain('<GhostIconButton');
    expect(shadow).toContain('export function ShadowQuickSettings');
    expect(shadow).not.toContain('<GhostIconButton');

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

  it('uses native macOS header material with an opaque cross-platform fallback', () => {
    const nativeCss = source('src/styles/native-titlebar.css');
    const main = source('src/renderer/main.tsx');
    const macConfig = JSON.parse(source('src-tauri/tauri.macos.conf.json')) as {
      app: {
        macOSPrivateApi: boolean;
        windows: Array<{
          transparent: boolean;
          windowEffects: { effects: string[]; state: string };
        }>;
      };
    };

    expect(main).toContain("import '../styles/native-titlebar.css';");
    expect(nativeCss).toMatch(/\.app-topbar\s*\{[\s\S]*?background:\s*var\(--workspace-ui-bg\);/);
    expect(nativeCss).toContain("data-native-platform='macos'");
    expect(nativeCss).toContain('background: hsl(var(--paper-deep) / 0.68);');
    expect(macConfig.app.macOSPrivateApi).toBe(true);
    expect(macConfig.app.windows[0]?.transparent).toBe(true);
    expect(macConfig.app.windows[0]?.windowEffects.effects).toEqual(['headerView']);
    expect(macConfig.app.windows[0]?.windowEffects.state).toBe('followsWindowActiveState');
  });

  it('assigns explicit plane and edge-panel roles without legacy island shells', () => {
    const app = source('src/renderer/App.tsx');
    const topbar = source('src/renderer/views/AppTopbar.tsx');
    const nativeCss = source('src/styles/native-titlebar.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const footer = source('src/renderer/components/BottomStatusBar.tsx');
    const renderer = `${app}\n${topbar}\n${sidebar}\n${footer}`;

    expect(topbar).toContain('className="app-topbar app-plane"');
    expect(topbar).not.toContain("background: 'var(--workspace-ui-bg)'");
    expect(nativeCss).toContain('background: var(--workspace-ui-bg);');
    expect(sidebar).toContain('app-panel-plane sidebar-shell');
    expect(footer).toContain('className="bsb app-plane"');
    expect(renderer).not.toContain('app-island');
    expect(renderer).not.toContain('app-chrome');
  });

  it('keeps the desktop coplanar and the manuscript independently raised', () => {
    const css = source('src/styles/index.css');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const rightPanels = source('src/renderer/components/rightBars/RightSidebarPanels.tsx');
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
    expect(block(rightHeader, 'id="shadow"', "active={isActive('agent', 'shadow')}")).not.toContain(
      'accent',
    );
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
    const bottomTimeline = source('src/renderer/components/BottomTimeline/BottomTimeline.tsx');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const leftSubheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const elementPanel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');
    const todo = source('src/renderer/components/rightBars/TodoPanel.tsx');
    const library = source('src/renderer/components/rightBars/MemoMaterialPanel.tsx');
    const collapsibleFooter = source('src/renderer/components/ui/CollapsibleFooter.tsx');
    const timeline = block(timelineCss, '.btl {', '.btl__resize {');
    const timelineHead = block(timelineCss, '.btl__head {', '.btl__head-left {');
    const timelineRows = block(timelineCss, '.btl-row {', 'Rail (sticky left)');
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
    expect(shellCss).toContain('--workspace-card-border:');
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
    expect(timeline).toContain('--btl-rail-contrast-line: var(--btl-lane-bg);');
    expect(timelineAxis).toContain('background: var(--btl-secondary-rail-bg);');
    expect(timelineCss).toMatch(
      /\.btl \.actrail\s*\{[\s\S]*?border-bottom:\s*0;[\s\S]*?background:\s*var\(--btl-secondary-rail-bg\);/,
    );
    expect(timelineCss).toMatch(
      /\.btl \.actrail__divider::after\s*\{[\s\S]*?background:\s*var\(--btl-rail-contrast-line\);/,
    );
    expect(timelineCss).toMatch(
      /\.btl-pin__line\s*\{[\s\S]*?background:\s*var\(--btl-rail-contrast-line\);/,
    );
    expect(trackPinLine).toContain('background: hsl(var(--rule));');
    expect(bottomTimeline).not.toContain("background: 'hsl(var(--page))'");
    expect(leftHeader).toContain("background: 'var(--workspace-ui-bg)'");
    expect(leftSubheader).toContain("background: 'var(--workspace-ui-bg)'");
    expect(rightHeader).toContain("background: 'var(--workspace-ui-bg)'");
    expect(todo).toContain("background: 'var(--workspace-ui-bg)'");
    expect(library).toContain("background: 'var(--workspace-ui-bg)'");
    expect(leftHeader).toContain('className="workspace-local-divider"');
    expect(leftSubheader).toContain('className="workspace-local-divider"');
    expect(rightHeader.match(/className="workspace-local-divider"/g)).toHaveLength(2);
    expect(todo).toContain('className="workspace-local-divider"');
    expect(library).toContain('className="workspace-local-divider"');
    expect(localDivider).toContain('right: 0;');
    expect(localDivider).toContain('left: 0;');
    expect(localDivider).toContain('height: 0.5px;');
    expect(localDivider).toContain('background: var(--workspace-local-border);');
    expect(listRow).toContain('border: 1px solid var(--workspace-card-border);');
    expect(listRow).toContain('background: color-mix');
    expect(listRow).toContain('box-shadow: none;');
    expect(todo).toContain("padding: '6px 12px 12px'");
    expect(todo).toContain('gap: 6');
    expect(library).toContain("padding: '6px 12px 12px'");
    expect(library).toContain('gap: 6');
    expect(collapsibleFooter).toContain("borderTop: '1px solid var(--workspace-subtle-border)'");
    expect(elementPanel).toContain("borderTop: '1px solid var(--workspace-subtle-border)'");
  });

  it('keeps Settings and Super Views on flat edge-aligned shells', () => {
    const settingsComponent = source('src/renderer/components/modals/SettingsModal.tsx');
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
    const graphView = source('src/renderer/views/StoryGraphView.tsx');
    const graphCss = source('src/styles/graph-view.css');
    const timeline = source('src/renderer/components/BottomTimeline/BottomTimeline.tsx');
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

  it('records an honest mobile starting point without claiming touch readiness', () => {
    const readme = source('README.md');
    const mobileDoc = source('docs/mobile-ui-foundation.md');
    const css = source('src/styles/index.css');

    expect(readme).toContain('docs/mobile-ui-foundation.md');
    expect(mobileDoc).toContain(
      '具备开始开发移动端 UI 的架构基础，但不具备宣称移动端 UI 已完成的产品基础',
    );
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
    expect(doc).toContain('三方交点没有渐变、阴影或额外装饰');
    expect(doc).toContain('局部层级只使用弱于主接缝的完整 `0.5px` hairline 与相邻灰阶');
    expect(doc).toContain('不实现同时改变三个区域的三向 resize');
    expect(doc).toContain('只用暗淡文字与黑色文字的切换');
    expect(doc).toContain('footer 只占中间编辑列');
    expect(doc).toContain('`AppTopbar` 的固定顺序是搜索、左栏 toggle、项目主页、`SUPER`');
    expect(doc).toContain('hover 都只提高前景文字/图标颜色，不绘制额外底色');
    expect(doc).toContain('`BottomStatusBar` 以只读状态为主');
    expect(doc).toContain('唯一的交互例外是 Bottom Timeline');
    expect(doc).toContain('通知入口仍留在 topbar');
    expect(doc).toContain('不重新定义现有配色');
    expect(doc).toContain('通用圆角阶梯限定为 `1px / 2px / 3px`');
    expect(doc).toContain('Plot Planner 是连续的 mini-Excel');
    expect(doc).toContain('不能替代 macOS 原生材质、iOS 或 Android 上的视觉、触摸和动效验收');
  });
});
