import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const coreRoot = path.resolve(__dirname, '../../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(coreRoot, relativePath), 'utf8');
}

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing selector: ${selector}`);
  const end = css.indexOf('}', start);
  if (end < 0) throw new Error(`Unclosed selector: ${selector}`);
  return css.slice(start, end + 1);
}

describe('workspace window-control row', () => {
  it('keeps native traffic lights and renderer controls on the calibrated macOS row', () => {
    const appEffects = source('src/renderer/app/effects/AppEffects.tsx');
    const shellCss = source('src/styles/index.css');
    const desktopCss = source('src/styles/desktop-shell.css');
    const controlCss = source('src/styles/ui-controls.css');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const corners = source('src/renderer/components/workspaceChrome/WorkspaceCornerControls.tsx');
    const doc = source('docs/design-system.md');
    const baseConfig = JSON.parse(source('src-tauri/tauri.conf.json')) as {
      app: { windows: Array<{ trafficLightPosition?: { x: number; y: number } }> };
    };
    const macConfig = JSON.parse(source('src-tauri/tauri.macos.conf.json')) as {
      app: { windows: Array<{ trafficLightPosition?: { x: number; y: number } }> };
    };

    expect(shellCss).toContain('--window-titlebar-height: 42px;');
    expect(shellCss).toContain('--window-header-leading-inset: 94px;');
    // Open left sidebar: its first tab row starts after the traffic lights.
    expect(leftHeader).toContain(
      "data-leading-inset={windowChrome && runtime.isMacDesktop ? 'true' : undefined}",
    );
    expect(cssBlock(desktopCss, '.workspace-panel-tab-row.workspace-panel-tab-row--window {')).toContain(
      'height: var(--window-titlebar-height);',
    );
    expect(
      cssBlock(desktopCss, '.workspace-panel-tab-row.workspace-panel-tab-row--window[data-leading-inset] {'),
    ).toContain('padding-left: var(--window-header-leading-inset);');
    // Closed left sidebar: the corner controls start after them instead.
    expect(corners).toContain("data-leading-inset={runtime.isMacDesktop ? 'true' : undefined}");
    expect(cssBlock(desktopCss, '.workspace-corner-controls--left[data-leading-inset] {')).toContain(
      'margin-left: calc(var(--window-header-leading-inset) - 8px);',
    );
    expect(cssBlock(desktopCss, '.workspace-window-strip {')).toMatch(
      /height:\s*var\(--window-titlebar-height\);[\s\S]*align-items:\s*center;|align-items:\s*center;[\s\S]*height:\s*var\(--window-titlebar-height\);/,
    );
    expect(cssBlock(controlCss, '.ghost-icon-button--md {')).toMatch(
      /width:\s*26px;[\s\S]*height:\s*26px;/,
    );

    const expectedPosition = { x: 18, y: 22 };
    expect(baseConfig.app.windows[0]?.trafficLightPosition).toEqual(expectedPosition);
    expect(macConfig.app.windows[0]?.trafficLightPosition).toEqual(expectedPosition);
    expect(appEffects).toContain('.setTrafficLightPosition({ x: 18, y: 22 })');
    expect(doc).toContain('macOS 红绿灯固定为 `x: 18, y: 22`');
  });

  it('keeps the window draggable without a title bar', () => {
    const corners = source('src/renderer/components/workspaceChrome/WorkspaceCornerControls.tsx');
    const leftHeader = source('src/renderer/components/leftBars/LeftSidebarHeader.tsx');
    const rightHeader = source('src/renderer/components/rightBars/RightSidebarHeader.tsx');

    for (const text of [corners, leftHeader, rightHeader]) {
      expect(text).toContain("data-tauri-drag-region={runtime.desktopWindowControls ? 'deep' : undefined}");
    }
  });

  it('returns to the bookshelf from the close button while a project is open', () => {
    const lib = source('src-tauri/src/lib.rs');
    const commands = source('src-tauri/src/commands.rs');
    const state = source('src-tauri/src/state.rs');
    const hook = source('src/renderer/shells/desktop/navigation/useCloseButtonReturnsToShelf.ts');
    const boundary = source('src/renderer/shells/desktop/navigation/DesktopWorkspaceNavigationBoundary.tsx');
    const shortcuts = source('src/renderer/store/shortcuts-store.ts');

    expect(state).toContain('close_returns_to_shelf: AtomicBool');
    expect(commands).toContain('pub fn window_set_close_returns_to_shelf(');
    expect(lib).toContain('commands::window_set_close_returns_to_shelf,');
    // The project check runs after an already-permitted close and before the
    // flush-and-close path, so the shelf keeps the original close behaviour.
    const closeRequested = lib.slice(lib.indexOf('WindowEvent::CloseRequested'));
    expect(closeRequested.indexOf('consume_close_permission()')).toBeLessThan(
      closeRequested.indexOf('close_returns_to_shelf()'),
    );
    expect(closeRequested.indexOf('close_returns_to_shelf()')).toBeLessThan(
      closeRequested.indexOf('coordinator.begin(ShutdownAction::CloseWindow)'),
    );
    expect(closeRequested).toContain('_window.emit(CLOSE_TO_SHELF_EVENT, ())');
    expect(hook).toContain('setEnabled(true);');
    expect(hook).toContain("platform.window.onCloseToShelf(() => navigate('/'))");
    expect(hook).toContain('setEnabled(false);');
    expect(boundary).toContain('useCloseButtonReturnsToShelf(navigate);');
    expect(shortcuts).toContain("id: 'closeProject'");
    expect(shortcuts).toContain("defaultAccelerator: 'Mod+Shift+W'");
  });
});
