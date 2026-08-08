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

  it('selects the mobile project shelf and the independent mobile workspace shell', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain('isMobile ? <MobileProjectShelfView /> : <ProjectPickerView />');
    expect(routes).toContain('isMobile ? <MobileAppShell /> : <DesktopAppShell />');
    const mobileShelf = rendererSource('shells/mobile/standalone/MobileProjectShelfView.tsx');
    expect(mobileShelf).toContain('<ProjectPickerView presentation="mobile" />');
    const mobileWorkspace = rendererSource('shells/mobile/MobileAppShell.tsx');
    expect(mobileWorkspace).toContain('<ProjectRuntimeProvider');
    expect(mobileWorkspace).toContain('<WorkspaceNavigationProvider navigator={navigator}>');
    expect(mobileWorkspace).toContain('<MobilePaperDeck');
    expect(mobileWorkspace).not.toContain('DesktopAppShell');
    expect(mobileWorkspace).not.toContain('store/ui-store');
  });

  it('keeps paper navigation, overview and gesture ownership in the mobile shell', () => {
    const paperDeck = rendererSource('shells/mobile/workspace/MobilePaperDeck.tsx');
    const panels = rendererSource('shells/mobile/workspace/MobileWorkspacePanels.tsx');
    const plotGrid = rendererSource('components/editor/PlotGrid.tsx');
    const session = rendererSource('shells/mobile/workspace/mobile-workspace-session.ts');
    const pinch = rendererSource('shells/mobile/workspace/usePaperPinch.ts');
    const cluster = rendererSource('shells/mobile/workspace/paper-cluster-gesture.ts');
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-workspace.css'), 'utf8');
    expect(session).toContain("case 'open'");
    expect(session).toContain("case 'reorder'");
    expect(session).toContain("case 'clear'");
    expect(paperDeck).toContain('<MobilePaperContent');
    expect(paperDeck).toContain('className="m-paper-cluster"');
    expect(paperDeck).toContain("data-full-panel={fullPanel ?? 'none'}");
    expect(panels).toContain('<PanelResizeHandle');
    expect(panels).toContain('<PlotGridEditor');
    expect(panels).toContain("setOrder('narrative')");
    expect(plotGrid).toContain('onPointerDown={onGripDown}');
    expect(pinch).toContain('paperRevealForMidpoint');
    expect(pinch).toContain("return 'bottom'");
    expect(pinch).toContain("return 'top'");
    expect(cluster).toContain('paperClusterDestination');
    expect(paperDeck).toContain('paperClusterDestination(drag.start, event.clientY - drag.y)');
    expect(panels).toContain('!drag.moved && Math.abs(dy) <= 5');
    expect(css).toContain('touch-action: pan-y');
    expect(css).toContain(".m-workspace[data-reveal='bottom']");
    expect(css).toContain('visibility: hidden');
    expect(css).toContain('visibility: visible');
    expect(css).toContain(".m-workspace[data-full-panel='top']");
    expect(css).toContain(".m-workspace[data-full-panel='bottom'] .m-context-workspace--tools");
    expect(css).not.toContain('touch-action: none;\n  overscroll-behavior');
  });

  it('keeps all three Super View destinations directly reachable in the mobile header', () => {
    const header = rendererSource('shells/desktop/components/DesktopSuperViewHeader.tsx');
    const memoMaterial = rendererSource('shells/desktop/views/DesktopSuperMemoMaterialView.tsx');
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-workspace.css'), 'utf8');
    expect(header).toContain("id: 'element'");
    expect(header).toContain("id: 'graph'");
    expect(header).toContain("id: 'memo-material'");
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(css).toContain('flex: 1 1 calc(100% - 32px)');
    expect(css).toContain('.m-super-view-host .super-view-head__right');
    expect(memoMaterial).toContain('className="smm-workspace-split"');
    expect(css).toContain('.super-mm-overlay .smm-workspace-split');
    expect(css).toContain('flex-direction: column');
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

  it('routes mobile settings outside the project runtime and keeps project settings deferred', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain('isMobile ? <MobileSettingsView /> : <Navigate to="/" replace />');
    const settings = rendererSource('shells/mobile/standalone/MobileSettingsView.tsx');
    expect(settings).toContain('<AccountPanel registerRef={REGISTER_NOOP} />');
    expect(settings).toContain('<ModelsPanel credentialsActive registerRef={REGISTER_NOOP} />');
    expect(settings).not.toContain('TrashRailPanel');
    expect(settings).not.toContain('AgentPanel');
    expect(settings).not.toContain('ProjectRuntimeProvider');
  });

  it('gives mobile settings safe areas, stacked content and touch-sized controls', () => {
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-settings.css'), 'utf8');
    expect(css).toContain('.m-settings__index');
    expect(css).toContain('min-height: 100dvh');
    expect(css).toContain('var(--safe-area-bottom)');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('font-size: 16px');
  });

  it('keeps shared and custom overlays inside the native mobile viewport', () => {
    const modal = rendererSource('components/ui/Modal.tsx');
    const onboarding = rendererSource('components/modals/PreAlphaOnboardingDialog.tsx');
    const patchModal = rendererSource('components/editor/PatchCreateModal.tsx');
    const nodeEditor = rendererSource('views/NodeEditorView.tsx');
    const controls = fs.readFileSync(path.join(stylesRoot, 'ui-controls.css'), 'utf8');
    const picker = fs.readFileSync(path.join(stylesRoot, 'project-picker.css'), 'utf8');
    const search = fs.readFileSync(path.join(stylesRoot, 'search.css'), 'utf8');
    const graph = fs.readFileSync(path.join(stylesRoot, 'graph-view.css'), 'utf8');

    expect(modal).toContain("'--modal-card-width': preferredWidth");
    expect(modal).not.toContain('style={{ width:');
    expect(onboarding).toContain('className="pre-alpha-guide-modal"');
    expect(onboarding).toContain('pre-alpha-guide-modal__continue');
    expect(controls).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(controls).toContain('width: min(100%, var(--modal-card-width, 520px))');
    expect(controls).toContain("html[data-platform-target='mobile'] .modal-root");
    expect(controls).toContain('max(12px, var(--safe-area-left))');
    expect(controls).toContain('min-height: 48px');
    expect(patchModal).toContain('patch-create-modal__overlay');
    expect(nodeEditor).toContain("width: 'min(360px, 100%)'");
    expect(nodeEditor).not.toContain('minWidth: 360');
    expect(picker).toContain('width: min(100%, 500px) !important');
    expect(search).toContain('width: min(620px, 100%)');
    expect(graph).toContain('width: min(360px, 100%)');
  });
});
