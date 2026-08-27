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
    expect(routes).toContain('getPlatformRuntime().isMobileShell');
    expect(routes).toContain('<MobileAuthPage initialMode="signin" />');
    expect(routes).toContain('<MobileAuthPage initialMode="signup" />');
  });

  it('selects the mobile project shelf and the independent mobile workspace shell', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain(
      'isMobileShell ? <MobileProjectShelfView /> : <ProjectPickerView />',
    );
    expect(routes).toContain('isMobileShell ? <MobileAppShell /> : <DesktopAppShell />');
    const mobileShelf = rendererSource('shells/mobile/standalone/MobileProjectShelfView.tsx');
    expect(mobileShelf).toContain('<ProjectPickerView presentation="mobile" />');
    const mobileWorkspace = rendererSource('shells/mobile/MobileAppShell.tsx');
    expect(mobileWorkspace).toContain('<ProjectRuntimeProvider');
    expect(mobileWorkspace).toContain('<WorkspaceNavigationProvider navigator={mobileNavigator}>');
    expect(mobileWorkspace).toContain('<MobileProjectHome');
    expect(mobileWorkspace).toContain('<MobilePaperDeck');
    expect(mobileWorkspace).toContain("dispatchWorkspaceUi({ type: 'show-project-home' })");
    expect(mobileWorkspace).not.toContain("entityType: 'dashboard'");
    expect(mobileWorkspace).not.toContain('firstChapter');
    expect(mobileWorkspace).toContain('freezeLiveMobilePaperContent(active)');
    expect(mobileWorkspace).toContain('<MobileProjectTrashView');
    expect(mobileWorkspace).toContain('onOpenTrash={() =>');
    expect(mobileWorkspace).not.toContain('DesktopAppShell');
    expect(mobileWorkspace).not.toContain('store/ui-store');
  });

  it('keeps the M3 paper workspace, unified bar and touch ownership in the mobile shell', () => {
    const paperDeck = rendererSource('shells/mobile/workspace/MobilePaperDeck.tsx');
    const overlay = rendererSource('shells/mobile/workspace/MobileStructureOverlay.tsx');
    const toolsFace = rendererSource('shells/mobile/workspace/MobileToolsFace.tsx');
    const paperTools = rendererSource('shells/mobile/workspace/MobilePaperTools.tsx');
    const unifiedBar = rendererSource('shells/mobile/workspace/MobileUnifiedBar.tsx');
    const paperSwipe = rendererSource('shells/mobile/workspace/mobile-paper-swipe.ts');
    const overview = rendererSource('shells/mobile/workspace/MobileTabOverview.tsx');
    const projectTrash = rendererSource('shells/mobile/workspace/MobileProjectTrashView.tsx');
    const plotGrid = rendererSource('components/editor/PlotGrid.tsx');
    const session = rendererSource('shells/mobile/workspace/mobile-workspace-session.ts');
    const sessionStorage = rendererSource(
      'shells/mobile/workspace/mobile-workspace-session-storage.ts',
    );
    const sessionHook = rendererSource(
      'shells/mobile/workspace/useMobileWorkspaceSession.ts',
    );
    const previewSheet = rendererSource('shells/mobile/workspace/MobileEntityPreviewSheet.tsx');
    const statsSheet = rendererSource('shells/mobile/workspace/MobilePaperStatsSheet.tsx');
    const editorAccessory = rendererSource('shells/mobile/workspace/MobileEditorAccessory.tsx');
    const railPresentation = rendererSource('components/editor/editor-rail-presentation.ts');
    const outlineRail = rendererSource('components/editor/EditorOutlineRail.tsx');
    const commentRail = rendererSource('components/editor/CommentRail.tsx');
    const marginNotes = rendererSource('hooks/useEntityMarginNotes.ts');
    const bottomTimeline = rendererSource('shells/desktop/views/DesktopBottomTimeline.tsx');
    const timelinePin = rendererSource('components/timeline/TimelinePin.tsx');
    const actRail = rendererSource('components/BottomTimeline/ActRail.tsx');
    const zoomGuard = rendererSource('shells/mobile/mobile-webview-zoom.ts');
    const nativeEntry = fs.readFileSync(
      path.resolve(process.cwd(), 'src-tauri/src/lib.rs'),
      'utf8',
    );
    const superElement = rendererSource('shells/desktop/views/DesktopSuperElementView.tsx');
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-workspace.css'), 'utf8');
    const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    expect(session).toContain("case 'open'");
    expect(session).toContain("case 'reorder'");
    expect(session).toContain("case 'clear'");
    expect(session).toContain("case 'remember-scroll'");
    expect(sessionStorage).toContain('readMobileWorkspaceSession');
    expect(sessionStorage).toContain('writeMobileWorkspaceSession');
    expect(sessionStorage).toContain('normalizeMobileWorkspaceSession(JSON.parse(raw))');
    expect(sessionHook).toContain('readMobileWorkspaceSession(');
    expect(sessionHook).toContain('writeMobileWorkspaceSession(');
    expect(paperDeck).toContain('<MobilePaperContent');
    expect(paperDeck).toContain('<MobilePaperViewport');
    expect(paperDeck).toContain('<MobilePaperSnapshot');
    expect(paperDeck).toContain('<MobileEntityPreviewSheet');
    expect(paperDeck).toContain('<MobileUnifiedBar');
    expect(paperDeck).toContain('className="m-paper-row"');
    expect(paperDeck).toContain('session.papers.map((paper)');
    expect(paperDeck).toContain('onPointerDown={beginPaperSwipe}');
    expect(paperDeck).toContain('onPointerMove={movePaperSwipe}');
    expect(paperDeck).toContain('onPointerUp={endPaperSwipe}');
    expect(paperDeck).toContain('data-paper-swipe={paperSwipePhase}');
    expect(paperDeck).toContain('canStartMobilePaperSwipe({');
    expect(paperDeck).toContain('currentSelectionIsCollapsed()');
    expect(paperDeck).toContain('composing: composingRef.current');
    expect(paperDeck).not.toContain('usePaperPinch');
    expect(paperDeck).not.toContain('paperCluster');
    expect(paperDeck).not.toContain('VITE_MOBILE_SIMULATOR_BOTTOM_PANEL_ACCEPTANCE');
    // Variable-height panels are gone: structure lives in the tab-bar
    // overlays, tools in the paper's full-screen face.
    expect(paperDeck).not.toContain('data-full-panel');
    expect(paperDeck).not.toContain('MobilePanelPullHandle');
    expect(overlay).toContain('<ChapterPanel');
    expect(overlay).toContain('<ElementPanel');
    expect(overlay).toContain('<DriftPanel');
    expect(overlay).toContain('presentation="mobile"');
    expect(toolsFace).toContain("type ToolTab = 'planning' | 'agent' | 'library'");
    expect(toolsFace).not.toContain("| 'stats'");
    expect(statsSheet).toContain('<EntityStatsContent');
    expect(statsSheet).toContain('onPointerMove={(event) =>');
    expect(paperTools).toContain('<PlotGridEditor');
    expect(toolsFace).toContain("type LibraryMode = 'todo' | 'library'");
    expect(toolsFace).toContain('className="m-tool-workspace__subtabs"');
    expect(toolsFace).not.toContain('<UserAvatar');
    expect(toolsFace).not.toContain('m-structure-shelf');
    expect(toolsFace).not.toContain('whatCanIDo');
    expect(previewSheet).toContain('这里只读预览');
    expect(previewSheet).toContain('插入一张纸');
    expect(previewSheet).toContain('event.target === event.currentTarget');
    expect(overview).toContain('className="m-ov-card__close"');
    // Papers keep their open order — the overview offers no drag reorder.
    expect(overview).not.toContain('onReorder');
    expect(overview).toContain('<MobileTabBar');
    expect(overview).toContain('onClick={onOpenTrash}');
    expect(projectTrash).toContain('<TrashRailPanel registerRef={REGISTER_NOOP} />');
    expect(projectTrash).toContain('className="m-project-trash"');
    expect(css).toContain('.m-project-trash__content');
    expect(overview).not.toContain('ArrowUp');
    expect(overview).not.toContain('ArrowDown');
    expect(toolsFace).toContain('<BottomTimeline presentation="mobile" />');
    expect(toolsFace).not.toContain('MobileTimelineWorkspace');
    expect(bottomTimeline).toContain('presentation?: BottomTimelinePresentation');
    expect(bottomTimeline).toContain('className={`btl btl--${presentation}`}');
    expect(bottomTimeline).toContain('startNodePointerDrag');
    expect(bottomTimeline).toContain('startChapterLanePointerDrag({');
    expect(bottomTimeline).not.toContain('setDragOverPosition');
    expect(bottomTimeline).not.toContain('chapterInsertionIndexForDrop');
    expect(bottomTimeline).not.toContain('moveChapterToIndex');
    expect(bottomTimeline).toContain('commitChapterLaneDrop({');
    expect(bottomTimeline).toContain('beginTouchMenu(event');
    expect(timelinePin).toContain('onPointerDown={startDrag}');
    expect(timelinePin).toContain("event.pointerType === 'touch'");
    expect(actRail).toContain('beginTouchMenu(event');
    expect(bottomTimeline).toContain("value: 'narrative'");
    expect(plotGrid).toContain('onPointerDown={onGripDown}');
    expect(paperSwipe).toContain('MOBILE_PAPER_SWIPE_AXIS_LOCK_PX = 8');
    expect(paperSwipe).toContain('MOBILE_PAPER_SWIPE_AXIS_RATIO = 1.2');
    expect(paperSwipe).toContain('MOBILE_PAPER_SWIPE_HOLD_CANCEL_MS = 180');
    expect(paperSwipe).toContain('workspace.paperMode.kind === \'read\'');
    expect(paperSwipe).toContain("workspace.overlay === 'none'");
    expect(paperSwipe).toContain("workspace.transient.kind === 'none'");
    expect(paperSwipe).toContain('targetIndex = Math.max');
    expect(paperDeck).toContain('className="m-paper-row__activate"');
    expect(paperDeck).toContain('data-editor-active={editorActive');
    expect(unifiedBar).toContain('data-debug-id="mobile-unified-bar"');
    expect(unifiedBar).toContain('selectMobileUnifiedBarProjection(workspaceUi)');
    expect(unifiedBar).toContain('<MobileEditorAccessory');
    expect(unifiedBar).not.toContain('MobilePaperRailMenu');
    expect(unifiedBar).not.toContain('MobilePanelPullHandle');
    expect(unifiedBar).not.toContain('PanelTop');
    expect(unifiedBar).not.toContain('PanelBottom');
    expect(editorAccessory).toContain('subscribeActiveEditor');
    expect(editorAccessory).toContain('window.visualViewport');
    expect(editorAccessory).toContain('getBlockFormatItems()');
    expect(editorAccessory).toContain('getInlineFormatItems()');
    expect(editorAccessory).toContain('data-mode={mode}');
    expect(editorAccessory).toContain('editorFocused && softwareKeyboardVisible');
    expect(editorAccessory).toContain('event.preventDefault()');
    expect(paperDeck).toContain('data-paper-rail={activeRail');
    expect(paperDeck).toContain('<EditorRailPresentationContext.Provider');
    expect(paperDeck).toContain('outlineLabelPitch: 34');
    // The rail menu is gone: 大纲/批注 hand off from the paper tool face into
    // the same bar sheets over the live paper.
    expect(paperTools).toContain("onOpenSheet('outline')");
    expect(paperTools).toContain("onOpenSheet('comments')");
    expect(railPresentation).toContain('createContext<EditorRailPresentationValue');
    expect(outlineRail).toContain('presentation?.outlineVisible');
    expect(outlineRail).toContain('presentation?.outlineLabelPitch');
    expect(commentRail).toContain("event.pointerType === 'touch'");
    expect(commentRail).toContain("closest('[data-comment-id]')");
    expect(marginNotes).toContain('marginNotesListeners');
    expect(nativeEntry).toContain('main_window.create = false');
    expect(nativeEntry).toContain('tauri::WebviewWindowBuilder::from_config');
    expect(nativeEntry).toContain('.with_input_accessory_view_builder(|_| None)');
    expect(nativeEntry).toContain('.build(context)');
    expect(css).toContain('touch-action: pan-y');
    expect(css).toContain('visibility: hidden');
    expect(css).toContain('visibility: visible');
    expect(css).toContain('--m-unified-bar-height: 56px');
    expect(css).toContain('.m-unified-bar');
    expect(css).toContain(".m-unified-bar[data-keyboard='open']");
    expect(css).toContain(".m-workspace[data-paper-swipe='dragging'] .m-paper-row__page");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('--m-paper-scale');
    // The live paper row swipes under JS ownership — CSS snap belongs only to
    // the overview's card deck.
    const paperRowCss = css.slice(
      css.indexOf('.m-paper-row {'),
      css.indexOf('.m-paper-row__page'),
    );
    expect(paperRowCss).not.toContain('scroll-snap-type');
    expect(css).not.toContain('.m-paper-cluster');
    expect(css).not.toContain('.m-paper-rail-toggle');
    expect(css).toContain('display: flex');
    expect(css).toContain('.m-paper-row__activate');
    expect(css).toContain(".m-workspace[data-bar-sheet='outline'] .editor__toc-rail");
    expect(css).toContain(
      ".m-workspace[data-bar-sheet='comments'] #mobile-comments-sheet-content > .editor__margin",
    );
    expect(css).toContain('.m-bottom-timeline');
    expect(css).toContain('.btl--mobile .btl__scroll');
    expect(css).toContain('touch-action: pan-x pan-y pinch-zoom');
    expect(css).not.toContain('touch-action: none;\n  overscroll-behavior');
    expect(zoomGuard).toContain("'gesturestart'");
    expect(zoomGuard).toContain('user-scalable=no');
    expect(html).toContain('maximum-scale=1.0, user-scalable=no');
    expect(superElement).toContain('const pinchRef = useRef');
    expect(superElement).toContain('beginSuperViewPinch({');
    expect(superElement).toContain('updateSuperViewPinch({');
  });

  it('keeps all three Super View destinations directly reachable in the mobile header', () => {
    const header = rendererSource('shells/desktop/components/DesktopSuperViewHeader.tsx');
    const memoMaterial = rendererSource('shells/desktop/views/DesktopSuperMemoMaterialView.tsx');
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-workspace.css'), 'utf8');
    expect(header).toContain("id: 'element'");
    expect(header).toContain("id: 'graph'");
    expect(header).toContain("id: 'memo-material'");
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(css).toContain('flex: 1 1 calc(100% - 50px)');
    expect(css).toContain('.m-super-view-host .super-view-head__meta');
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
    expect(css).toContain("html[data-shell-mode='mobile'] .pp-modal");
  });

  it('routes mobile settings outside project runtime and gates hosted account sections', () => {
    const routes = rendererSource('app/AppRoutes.tsx');
    expect(routes).toContain(
      'isMobileShell ? <MobileSettingsView /> : <DesktopStandaloneSettingsView />',
    );
    const settings = rendererSource('shells/mobile/standalone/MobileSettingsView.tsx');
    expect(settings).toContain('withoutHostedAccountSettings(group.items, accountSettingsEnabled)');
    expect(settings).toContain(
      'accountSettingsEnabled ? <AccountPanel registerRef={REGISTER_NOOP} /> : null',
    );
    expect(settings).toContain('<ModelsPanel credentialsActive registerRef={REGISTER_NOOP} />');
    expect(settings).not.toContain('TrashRailPanel');
    expect(settings).not.toContain('AgentPanel');
    expect(settings).not.toContain('ProjectRuntimeProvider');
    expect(settings).toContain('className="m-settings set-overlay"');
    expect(settings).toContain('className="m-settings__content set-main"');
    expect(settings).toContain('useMobileAndroidBack(handleBack)');
    expect(settings).not.toContain('LucideIcon');
  });

  it('gives mobile settings safe areas, stacked content and touch-sized controls', () => {
    const css = fs.readFileSync(path.join(stylesRoot, 'mobile-settings.css'), 'utf8');
    expect(css).toContain('.m-settings__index');
    expect(css).toContain('min-height: 100dvh');
    expect(css).toContain('var(--safe-area-bottom)');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('font-size: 16px');
    expect(css).toContain('overflow-y: auto');
    expect(css).toContain('touch-action: pan-y');
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
    expect(controls).toContain("html[data-shell-mode='mobile'] .modal-root");
    expect(controls).toContain("html[data-shell-mode='mobile'] .modal-root__dialog");
    expect(controls).toContain('height: 100%');
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
