import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rendererRoot = path.resolve(process.cwd(), 'src/renderer');
const stylesRoot = path.resolve(process.cwd(), 'src/styles');

function rendererSource(relativePath: string): string {
  return fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');
}

describe('mobile standalone routes', () => {
  it('selects the mobile auth presentation from native platform metadata', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain('getPlatformRuntime().isMobile');
    expect(routes).toContain('<MobileAuthPage initialMode="signin" />');
    expect(routes).toContain('<MobileAuthPage initialMode="signup" />');
  });

  it('selects the mobile project shelf without changing desktop project routes', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain('isMobile ? <MobileProjectShelfView /> : <ProjectPickerView />');
    expect(routes).toContain('isMobile ? <MobileWorkspaceDeferredView /> : <DesktopAppShell />');
    const mobileShelf = rendererSource('shells/mobile/standalone/MobileProjectShelfView.tsx');
    expect(mobileShelf).toContain('<ProjectPickerView presentation="mobile" />');
    const deferredWorkspace = rendererSource('shells/mobile/MobileWorkspaceDeferredView.tsx');
    expect(deferredWorkspace).toContain('intentionally deferred');
    expect(deferredWorkspace).not.toContain('ProjectRuntimeProvider');
  });

  it('keeps mobile auth in the mobile shell path and reuses the auth flow', () => {
    const mobileAuth = rendererSource('shells/mobile/standalone/MobileAuthPage.tsx');
    expect(mobileAuth).toContain('<LoginPage initialMode={initialMode} presentation="mobile" />');
    expect(mobileAuth).not.toContain('shells/desktop');
    expect(mobileAuth).not.toContain('store/ui-store');
  });

  it('owns safe area, dynamic viewport, touch targets and mobile input sizing', () => {
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-auth.css'), 'utf8');
    expect(css).toContain('min-height: 100dvh');
    expect(css).toContain('var(--safe-area-top)');
    expect(css).toContain('min-height: 48px');
    expect(css).toContain('font-size: 16px');
  });

  it('gives the mobile shelf a single-column touch-first surface', () => {
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-project-shelf.css'), 'utf8');
    expect(css).toContain('.m-shelf-card__open');
    expect(css).toContain('min-height: 100dvh');
    expect(css).toContain('var(--safe-area-bottom)');
    expect(css).toContain('min-height: 48px');
    expect(css).toContain("html[data-platform-target='mobile'] .pp-modal");
  });
});
