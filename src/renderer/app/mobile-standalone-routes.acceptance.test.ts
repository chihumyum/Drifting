import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rendererRoot = path.resolve(process.cwd(), 'src/renderer');
const stylesRoot = path.resolve(process.cwd(), 'src/styles');

function rendererSource(relativePath: string): string {
  return fs.readFileSync(path.join(rendererRoot, relativePath), 'utf8');
}

function style(name: string): string {
  return fs.readFileSync(path.join(stylesRoot, name), 'utf8');
}

describe('mobile standalone routes', () => {
  it('selects the mobile auth presentation from native platform metadata', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain('getPlatformRuntime().isMobileShell');
    expect(routes).toContain('<MobileAuthPage initialMode="signin" />');
    expect(routes).toContain('<MobileAuthPage initialMode="signup" />');
  });

  it('selects the mobile shelf and the independent mobile workspace shell', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toMatch(
      /isMobileShell \? \(\s*<MobileProjectShelfView \/>\s*\) : \(\s*<PreAlphaFirstRunGate>\s*<ProjectPickerView \/>/,
    );
    expect(rendererSource('app/project-route-components.tsx')).toContain('isMobileShell ? <MobileAppShell /> : <DesktopAppShell />');
    // The phone's shelf is the desktop's: the same first run and the same shelf.
    const mobileShelf = rendererSource('shells/mobile/standalone/MobileProjectShelfView.tsx');
    expect(mobileShelf).toContain('<PreAlphaFirstRunGate>');
    expect(mobileShelf).toContain('<ProjectPickerView />');
    const shell = rendererSource('shells/mobile/MobileAppShell.tsx');
    expect(shell).toContain('<ProjectRuntimeProvider');
    expect(shell).toContain('<MobileDesk projectId={projectId} />');
    expect(shell).not.toContain('DesktopAppShell');
    expect(shell).not.toContain('store/ui-store');
  });

  it('lays one paper over a desk: drawers under it, the Bottom Panel under its foot, layers over it', () => {
    const desk = rendererSource('shells/mobile/desk/MobileDesk.tsx');
    expect(desk).toContain('<WorkspaceNavigationProvider navigator={navigator}>');
    expect(desk).toContain('<MobileLeftDesk');
    expect(desk).toContain('<MobileRightSidebar');
    expect(desk).toContain('<BottomTimeline presentation="mobile" />');
    expect(desk).toContain('ref={setPlotPlannerSlot}');
    expect(desk).toContain('<MobileSuperViewHost');
    expect(desk).toContain('<GlobalSearchModal');
    expect(desk).toContain('<MobileProjectTrashView');
    expect(desk).toContain('<EntitySnapshotHistoryModal />');
    expect(desk).toContain('<DriftBindModal />');
    // Only the active paper mounts a full editor; Project Home is the desktop's.
    expect(desk.match(/<MobilePaperContent /g)).toHaveLength(1);
    expect(desk).toContain('<ProjectDashboard />');
    expect(desk).not.toContain('store/ui-store');
    expect(desk).not.toContain('shells/desktop');
  });

  it('reuses the desktop panels in the two desks', () => {
    const panels = rendererSource('shells/mobile/desk/MobileDeskPanels.tsx');
    for (const panel of ['<ChapterPanel />', '<ElementPanel />', '<DriftPanel />', '<LeftSidebarSubHeader panel={candidate} />',
      '<WorkspaceAccountCell />', '<ReviewPanel', '<LibraryPanel', '<MobilePaperStats', '<DesktopAgentPanel projectId={projectId} />']) {
      expect(panels).toContain(panel);
    }
    expect(panels).toContain('SidebarEditorSelectionContext.Provider');
    expect(panels).toContain('<PanelTabTray');
  });

  it('follows the shared controls that ask for the Bottom Panel and the Super Views', () => {
    const desk = rendererSource('shells/mobile/desk/MobileDesk.tsx');
    const intents = rendererSource('components/workspaceChrome/workspace-intents.ts');
    expect(desk).toContain('subscribeBottomPaneIntent(');
    expect(desk).toContain('subscribeSuperViewIntent(');
    expect(desk).toContain('setBottomPaneIntent(desk.bottom?.pane ?? null)');
    expect(desk).toContain('setSuperViewIntent(desk.superView)');
    expect(desk).toContain("events.on('settings:open', openSettings)");
    expect(intents).toContain('togglePlotPlannerOpen');
    expect(intents).toContain('setActiveSuperView');
  });

  it('keeps mobile auth in the mobile shell path and reuses the auth flow', () => {
    const mobileAuth = rendererSource('shells/mobile/standalone/MobileAuthPage.tsx');
    expect(mobileAuth).toContain(
      '<AuthFlow initialMode={initialMode} presentation="page" onComplete={returnToLibrary} />',
    );
    expect(mobileAuth).not.toContain('shells/desktop');
    expect(mobileAuth).not.toContain('store/ui-store');
  });

  it('lays the shelf out in one column for a phone', () => {
    const css = style('mobile-project-shelf.css');
    expect(css).toContain("@import './mobile-foundation.css';");
    expect(css).toContain("html[data-shell-mode='mobile'] .pp-grid");
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('env(safe-area-inset-top, 0px)');
    expect(css).toContain("html[data-shell-mode='mobile'] .pp-rail");
  });

  it('routes mobile settings outside project runtime and gates hosted account sections', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).not.toContain('<DeferredProjectRoute view="settings" />');
    expect(routes).toContain(
      'isMobileShell ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />',
    );
    const settings = rendererSource('shells/mobile/standalone/MobileSettingsView.tsx');
    expect(settings).toContain('withoutHostedAccountSettings(group.items, accountSettingsEnabled)');
    const panels = rendererSource('features/settings/StandaloneSettingsPanel.tsx');
    expect(panels).toContain("if (id === 'account' && !hostedAccountSettingsEnabled()) return null");
    expect(panels).toContain('<ModelsPanel credentialsActive registerRef={REGISTER_NOOP} />');
    expect(settings).not.toContain('TrashRailPanel');
    expect(settings).not.toContain('ProjectRuntimeProvider');
    expect(settings).toContain('useMobileAndroidBack(handleBack)');
  });

  it('opens settings from the account menu and returns to the page it came from', () => {
    const desk = rendererSource('shells/mobile/desk/MobileDesk.tsx');
    const settings = rendererSource('shells/mobile/standalone/MobileSettingsView.tsx');
    expect(desk).toContain('navigate(`/settings${panel}`, { state: { from: location.pathname } })');
    expect(settings).toContain("navigate(typeof from === 'string' && from.startsWith('/') ? from : '/', { replace: true })");
  });

  it('keeps shared overlays inside the native mobile viewport', () => {
    const modal = rendererSource('components/ui/Modal.tsx');
    const controls = style('ui-controls.css');
    expect(modal).toContain("'--modal-card-width': preferredWidth");
    expect(modal).not.toContain('style={{ width:');
    expect(controls).toContain('width: min(100%, var(--modal-card-width, 520px))');
    expect(style('mobile-foundation.css')).toContain('max-width: calc(100vw - 24px)');
  });
});
