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

describe('workspace titlebar centerline', () => {
  it('keeps native traffic lights and renderer controls on the calibrated macOS row', () => {
    const appEffects = source('src/renderer/app/effects/AppEffects.tsx');
    const topbar = source('src/renderer/views/AppTopbar.tsx');
    const leftTopbar = source('src/renderer/components/topBars/LeftSidebarTopBar.tsx');
    const shellCss = source('src/styles/index.css');
    const controlCss = source('src/styles/ui-controls.css');
    const navigationCss = source('src/styles/workspace-navigation.css');
    const doc = source('docs/design-system.md');
    const baseConfig = JSON.parse(source('src-tauri/tauri.conf.json')) as {
      app: { windows: Array<{ trafficLightPosition?: { x: number; y: number } }> };
    };
    const macConfig = JSON.parse(source('src-tauri/tauri.macos.conf.json')) as {
      app: { windows: Array<{ trafficLightPosition?: { x: number; y: number } }> };
    };

    expect(shellCss).toContain('--window-titlebar-height: 42px;');
    expect(topbar).toContain("height: 'var(--window-titlebar-height)'");
    expect(leftTopbar).toContain("height: 'var(--window-titlebar-height)'");
    expect(leftTopbar).toContain("alignItems: 'center'");
    expect(leftTopbar).toContain(
      "useProjectStore((state) => state.currentProject?.name.trim() ?? '')",
    );
    expect(leftTopbar).toContain('!runtime.isMobile && projectName');
    expect(leftTopbar).toContain('className="app-topbar__project-name"');
    expect(leftTopbar).toContain('data-tauri-drag-region="false"');
    expect(leftTopbar).toContain('title={projectName}');
    expect(leftTopbar.indexOf('className="app-topbar__project-name"')).toBeLessThan(
      leftTopbar.indexOf('className="app-topbar__left-actions"'),
    );
    expect(shellCss).toContain('--window-header-leading-inset: 94px;');
    expect(leftTopbar).toContain(
      "paddingLeft: runtime.isMacDesktop ? 'var(--window-header-leading-inset)' : 8",
    );
    expect(topbar).toContain("const leftWidth = runtime.isMobile ? 72 : 'max-content';");
    expect(cssBlock(controlCss, '.ghost-icon-button--md {')).toMatch(
      /width:\s*26px;[\s\S]*height:\s*26px;/,
    );
    expect(cssBlock(navigationCss, '.workspace-all-chapters-trigger,')).toContain('height: 26px;');
    expect(cssBlock(navigationCss, '.app-topbar__project-name {')).toMatch(
      /min-width:\s*0;[\s\S]*max-width:\s*min\(220px, 22vw\);[\s\S]*flex:\s*0 1 auto;[\s\S]*overflow:\s*hidden;[\s\S]*cursor:\s*text;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*user-select:\s*text;[\s\S]*white-space:\s*nowrap;/,
    );
    expect(cssBlock(navigationCss, '.app-topbar__left-actions {')).toMatch(
      /flex:\s*0 0 auto;/,
    );

    const expectedPosition = { x: 18, y: 22 };
    expect(baseConfig.app.windows[0]?.trafficLightPosition).toEqual(expectedPosition);
    expect(macConfig.app.windows[0]?.trafficLightPosition).toEqual(expectedPosition);
    expect(appEffects).toContain('.setTrafficLightPosition({ x: 18, y: 22 })');
    expect(doc).toContain('macOS 红绿灯固定为 `x: 18, y: 22`');
  });
});
