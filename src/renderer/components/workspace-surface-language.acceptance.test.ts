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

  it('assigns explicit plane and tool-slab roles without legacy island shells', () => {
    const app = source('src/renderer/App.tsx');
    const topbar = source('src/renderer/views/AppTopbar.tsx');
    const sidebar = source('src/renderer/components/Sidebar.tsx');
    const footer = source('src/renderer/components/BottomStatusBar.tsx');
    const renderer = `${app}\n${topbar}\n${sidebar}\n${footer}`;

    expect(topbar).toContain('className="app-topbar app-plane"');
    expect(sidebar).toContain('app-tool-slab sidebar-shell');
    expect(footer).toContain('className="bsb app-plane"');
    expect(renderer).not.toContain('app-island');
    expect(renderer).not.toContain('app-chrome');
  });

  it('keeps first-class geometry sharp and the manuscript independently raised', () => {
    const css = source('src/styles/index.css');
    const shell = block(
      css,
      'Workspace plane + raised work surfaces',
      'Static document and panel tabs',
    );
    const page = block(css, '.page {', '.page__folio {');

    expect(shell).toMatch(/\.app-root\s*\{[\s\S]*?padding:\s*0;[\s\S]*?gap:\s*0;/);
    expect(shell).toMatch(
      /\.workspace-stage\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(shell).toMatch(/\.app-tool-slab\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(page).toContain('background: hsl(var(--page));');
    expect(page).toContain('border-radius: var(--workspace-corner-radius);');
    expect(page).toContain('box-shadow: var(--page-elevation);');
    expect(css).not.toContain('.app-island');
    expect(css).not.toContain('.tab-indicator');
  });

  it('uses static rectangular tabs and removes the selection-indicator hook', () => {
    const tabs = source('src/renderer/components/ui/PanelTabs.tsx');
    const timeline = source('src/renderer/components/topBars/TopTimeline/TopTimeline.tsx');
    const controls = source('src/styles/ui-controls.css');

    expect(tabs).not.toContain('indicatorStyle');
    expect(tabs).not.toContain('tab-indicator');
    expect(timeline).not.toContain('useSlidingIndicator');
    expect(timeline).toContain("behavior: 'auto'");
    expect(timeline).not.toContain("transition: 'background");
    expect(controls).toMatch(
      /\.app-panel-tab\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?transition:\s*none;/,
    );
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
    expect(block(timelineCss, '.btl-rail {', '.btl-rail.is-active {')).toContain(
      'background: color-mix',
    );
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

    expect(doc).toContain('一个平面，最多三块抬起的工作面');
    expect(doc).toContain('footer 只占中间编辑列');
    expect(doc).toContain('不重新定义现有配色');
    expect(doc).toContain('通用圆角阶梯限定为 `1px / 2px / 3px`');
    expect(doc).toContain('Plot Planner 是连续的 mini-Excel');
    expect(doc).toContain('不能替代 macOS、iOS 或 Android 上的视觉、触摸和动效验收');
  });
});
