import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Mobile V2 M1 platform and appearance foundation', () => {
  it('separates immutable native capability target from immutable presentation shell mode', () => {
    const runtime = source('src/renderer/platform/runtime.ts');
    const routes = source('src/renderer/app/AppRoutes.tsx');
    const app = source('src/renderer/App.tsx');

    expect(runtime).toContain("isMobile: capabilities.target === 'mobile'");
    expect(runtime).toContain("isMobileShell: uiShell.shellMode === 'mobile'");
    expect(runtime).toContain('screenWidth: window.screen.width');
    expect(runtime).toContain('document.documentElement.dataset.shellMode = next.shellMode');
    expect(routes).toContain('getPlatformRuntime().isMobileShell');
    expect(routes).toContain('isMobileShell ? <MobileAppShell /> : <DesktopAppShell />');
    expect(app).toContain('if (!getPlatformRuntime().isMobile) return;');
  });

  it('keys safe-area ownership to the native target and presentation layout to shell mode', () => {
    const indexCss = source('src/styles/index.css');
    const controlCss = source('src/styles/ui-controls.css');

    expect(indexCss).toContain("html[data-platform-target='mobile'] .app-root");
    expect(indexCss).toContain("html[data-shell-mode='mobile'] .sidebar-shell");
    expect(indexCss).not.toContain("html[data-platform-target='mobile'] .sidebar-shell");
    expect(controlCss).toContain("html[data-shell-mode='mobile'] .modal-root");
    expect(controlCss).not.toContain("html[data-platform-target='mobile'] .modal-root");
  });

  it('locks native mobile builds to portrait without restoring landscape declarations', () => {
    const appleProject = source('src-tauri/gen/apple/project.yml');
    const applePlist = source('src-tauri/gen/apple/drifting_iOS/Info.plist');
    const androidManifest = source('src-tauri/gen/android/app/src/main/AndroidManifest.xml');

    expect(appleProject).toContain('UISupportedInterfaceOrientations~ipad:');
    expect(appleProject).toContain('UIInterfaceOrientationPortraitUpsideDown');
    expect(appleProject).not.toContain('UIInterfaceOrientationLandscape');
    expect(applePlist).not.toContain('UIInterfaceOrientationLandscape');
    expect(androidManifest).toContain('android:screenOrientation="portrait"');
  });

  it('restores appearance before React mounts and defines semantic V2 roles for both schemes', () => {
    const main = source('src/renderer/main.tsx');
    const theme = source('src/renderer/lib/initial-theme.ts');
    const css = source('src/styles/index.css');

    expect(main.indexOf('applyInitialThemeBeforeRender();')).toBeLessThan(
      main.indexOf('await Promise.all'),
    );
    expect(theme).toContain("window.localStorage.getItem('settings-storage')");
    expect(theme).toContain("window.matchMedia('(prefers-color-scheme: dark)')");
    expect(theme).toContain("root.style.colorScheme = scheme");
    expect(css).toContain('--mobile-v2-desk:');
    expect(css).toContain('--mobile-v2-search-current:');
    expect(css).toContain('--mobile-v2-drag-ghost:');
    expect(css.match(/--mobile-v2-backdrop:/g)).toHaveLength(2);
  });
});
