import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WorkspaceNavigationProvider } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { workspaceTargetFromPathname } from '../../../features/workspace/navigation/workspace-route';
import type { WorkspaceNavigator, WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { EntitySnapshotHistoryModal } from '../../../components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from '../../../components/modals/DriftBindModal';
import { GlobalSearchModal } from '../../../components/search/GlobalSearchModal';
import { setPlotPlannerSlot } from '../../../components/editor/plot-grid/plot-planner-slot';
import { BottomTimeline } from '../../../components/BottomTimeline/BottomTimeline';
import { TrailingEditorPaneContext } from '../../../components/editor/editor-corner';
import {
  markProjectHomeArrival,
  readBottomPaneIntent,
  readSuperViewIntent,
  setBottomPaneIntent,
  setSuperViewIntent,
  subscribeBottomPaneIntent,
  subscribeSuperViewIntent,
} from '../../../components/workspaceChrome/workspace-intents';
import { setSelectionBarDocked } from '../../../features/editor/editor-selection-bar';
import { ProjectDashboard } from '../../../views/ProjectDashboard';
import { useNotificationFeed } from '../../../hooks/useNotificationFeed';
import { getActiveEditor } from '../../../lib/active-editor';
import { events } from '../../../lib/events';
import { useAgentChatStore } from '../../../store/agent-chat-store';
import { useMobileWorkspaceSession } from '../workspace/useMobileWorkspaceSession';
import { MobilePaperContent } from '../workspace/MobilePaperContent';
import { MobileSuperViewHost } from '../workspace/MobileSuperViewHost';
import { MobileProjectTrashView } from '../workspace/MobileProjectTrashView';
import { mobilePaperKey } from '../workspace/mobile-workspace-session';
import {
  createMobileDeskState,
  mobileDeskReducer,
  readMobileDeskPreferences,
  writeMobileDeskPreferences,
  type MobileDeskState,
} from './mobile-desk-controller';
import { useMobileDeskBack } from './useMobileDeskBack';
import { useMobileWriting } from './useMobileWriting';
import { installTouchHold } from './mobile-touch-hold';
import { MobileDock } from './MobileDock';
import { MobileKeyboardBar } from './MobileKeyboardBar';
import { MobileLeftDesk, MobileRightSidebar } from './MobileDeskPanels';
import { MobileForeEdge } from './MobileForeEdge';
import { MobileProseNameCard } from './MobileProseNameCard';
import { useDeskPan, DESK_SLIVER_PX } from './useDeskPan';
import { capturePageTurn, usePaperScrollMemory, usePageTurn, useReadingAway } from './mobile-paper-continuity';
import '../../../../styles/mobile-desk.css';
// The book's trash wears the settings section's head.
import '../../../../styles/mobile-settings.css';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Heights of the Bottom Panel under the lifted paper, as shares of the screen. */
const BOTTOM_SHARE: Record<'half' | 'full', number> = { half: 0.46, full: 0.84 };

/**
 * The phone's workspace: one raised paper over a desk (docs/mobile-ui-foundation.md).
 */
export function MobileDesk({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  useNotificationFeed();
  const navigate = useNavigate();
  const location = useLocation();
  const root = `/project/${projectId}`;
  const session = useMobileWorkspaceSession(projectId);
  const papers = session.state;
  const activePaper = papers.papers.find((paper) => paper.key === papers.activeKey) ?? null;

  // Opening the book at its root picks up the paper the author left.
  const [resumeTarget] = useState<WorkspaceTarget | null>(() =>
    workspaceTargetFromPathname(projectId, location.pathname) ? null : activePaper?.target ?? null,
  );
  const resumingRef = useRef(Boolean(resumeTarget));
  const [desk, dispatch] = useReducer(mobileDeskReducer, undefined, (): MobileDeskState =>
    createMobileDeskState(
      readMobileDeskPreferences(storage(), projectId),
      workspaceTargetFromPathname(projectId, location.pathname) || resumeTarget ? 'paper' : 'home',
    ),
  );
  useEffect(() => writeMobileDeskPreferences(storage(), projectId, desk), [desk, projectId]);

  const deskRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  // Project Home floats its create row after the plus and its Agent otherwise.
  // It reads the arrival once it is on screen, so the arrival is marked after
  // the stage has turned to it.
  const homeIntentRef = useRef<'new' | 'home' | null>(null);
  const [homeArrival, setHomeArrival] = useState(0);
  // The page on screen, kept still under the next one for the page turn.
  const leavingPageRef = useRef<HTMLElement | null>(null);
  const activeKeyRef = useRef(papers.activeKey);
  const stageRef = useRef(desk.stage);
  useEffect(() => {
    activeKeyRef.current = papers.activeKey;
    stageRef.current = desk.stage;
  }, [desk.stage, papers.activeKey]);
  const turnPageTo = useCallback((target: WorkspaceTarget | 'home') => {
    const next = target === 'home' ? 'home' : mobilePaperKey(target);
    const current = stageRef.current === 'home' ? 'home' : activeKeyRef.current;
    if (next !== current) capturePageTurn(pageRef, leavingPageRef);
  }, []);

  useEffect(() => {
    if (!resumeTarget) return;
    session.activate(resumeTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening the book
  }, []);

  // The address is the paper in front; the book's root is Project Home.
  useEffect(() => {
    if (location.pathname === `${root}/home` || location.pathname === `${root}/new`) {
      homeIntentRef.current = location.pathname.endsWith('/new') ? 'new' : 'home';
      setHomeArrival((n) => n + 1);
      dispatch({ type: 'show-home' });
      navigate(root, { replace: true });
      return;
    }
    const target = workspaceTargetFromPathname(projectId, location.pathname);
    if (target) {
      resumingRef.current = false;
      dispatch({ type: 'show-paper' });
      return;
    }
    if ((location.pathname === root || location.pathname === `${root}/`) && !resumingRef.current) {
      dispatch({ type: 'show-home' });
    }
  }, [location.pathname, navigate, projectId, root]);

  const showHome = useCallback(
    (options?: { replace?: boolean; intent?: 'new' | 'home' }) => {
      turnPageTo('home');
      homeIntentRef.current = options?.intent ?? 'home';
      setHomeArrival((n) => n + 1);
      dispatch({ type: 'show-home' });
      navigate(root, { replace: options?.replace ?? false });
    },
    [navigate, root, turnPageTo],
  );
  useEffect(() => {
    if (desk.stage !== 'home' || !homeIntentRef.current) return;
    markProjectHomeArrival(homeIntentRef.current);
    homeIntentRef.current = null;
  }, [desk.stage, homeArrival]);
  const leaveBook = useCallback(() => {
    navigate('/', { replace: true });
  }, [navigate]);

  const { navigator: sessionNavigator, open: openPaper, activate: activatePaper } = session;
  const navigator = useMemo<WorkspaceNavigator>(
    () => ({
      ...sessionNavigator,
      open: (target) => {
        turnPageTo(target);
        openPaper(target);
        dispatch({ type: 'show-paper' });
      },
      activate: (target) => {
        turnPageTo(target);
        activatePaper(target);
        dispatch({ type: 'show-paper' });
      },
      showProjectHome: showHome,
    }),
    [activatePaper, openPaper, sessionNavigator, showHome, turnPageTo],
  );

  // Writing: the editor holds the caret. Whatever is laid over the paper
  // takes the caret away again.
  const writing = useMobileWriting();
  // Only the paper's own editor writes on the paper: an editor that grows
  // inside a Super View or a desk keeps its layer where it is.
  const editorDom = writing.editor && !writing.editor.isDestroyed ? writing.editor.view.dom : null;
  const writingOnPaper = writing.writing && Boolean(editorDom?.closest('.m-paper__page'));
  useEffect(() => {
    dispatch({ type: 'sync-writing', writing: writingOnPaper });
  }, [writingOnPaper]);
  const covered = desk.drawer !== 'none' || desk.bottom !== null || desk.superView !== null || desk.sheet !== 'none';
  useEffect(() => {
    if (covered && writingOnPaper) getActiveEditor()?.commands.blur();
  }, [covered, writingOnPaper]);

  // Shared controls ask for the Bottom Panel and the Super Views through the
  // desktop's UI store; the desk follows them and writes back what it shows.
  useEffect(() => {
    setSelectionBarDocked(true);
    setBottomPaneIntent(null);
    setSuperViewIntent(null);
    const stopBottom = subscribeBottomPaneIntent((pane) =>
      dispatch(pane ? { type: 'open-bottom', pane } : { type: 'close-bottom' }),
    );
    const stopSuper = subscribeSuperViewIntent((view) =>
      dispatch(view ? { type: 'open-super-view', view } : { type: 'close-super-view' }),
    );
    return () => {
      stopBottom();
      stopSuper();
      setSelectionBarDocked(false);
    };
  }, []);
  useEffect(() => setBottomPaneIntent(desk.bottom?.pane ?? null), [desk.bottom?.pane]);
  useEffect(() => setSuperViewIntent(desk.superView), [desk.superView]);
  const target = desk.stage === 'paper' ? activePaper?.target ?? null : null;
  // The planner belongs to a chapter or drift in front; elsewhere it lies down.
  useEffect(() => {
    if (desk.bottom?.pane === 'planner' && target?.entityType !== 'node') dispatch({ type: 'close-bottom' });
  }, [desk.bottom?.pane, target?.entityType]);

  useEffect(() => {
    const openSettings = (payload?: { railId?: string }) => {
      // The phone's settings open at a section (MobileSettingsView reads `section`).
      const panel = payload?.railId ? `?section=${encodeURIComponent(payload.railId)}` : '';
      navigate(`/settings${panel}`, { state: { from: location.pathname } });
    };
    const openSearch = () => dispatch({ type: 'open-sheet', sheet: 'search' });
    // A Project Home card or a hand-off from Review routed a task to the Agent.
    const revealAgent = () => dispatch({ type: 'open-drawer', side: 'right', panel: 'companion' });
    events.on('settings:open', openSettings);
    events.on('search:open', openSearch);
    events.on('agent:reveal', revealAgent);
    return () => {
      events.off('settings:open', openSettings);
      events.off('search:open', openSearch);
      events.off('agent:reveal', revealAgent);
    };
  }, [location.pathname, navigate]);

  // A held finger brings up a thing's card; :active needs a touch listener on iOS.
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return undefined;
    const noop = () => {};
    document.addEventListener('touchstart', noop, { passive: true });
    const uninstall = installTouchHold(el);
    return () => {
      uninstall();
      document.removeEventListener('touchstart', noop);
    };
  }, []);

  useMobileDeskBack({ state: desk, dispatch, onShowHome: () => showHome({ replace: true }), onLeaveBook: leaveBook });

  // Frontend Debug (development only): the desk's state for acceptance runs.
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG !== '1') return undefined;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import('../../../lib/frontend-debug/registry').then(({ registerFrontendDebugSlice }) => {
      if (cancelled) return;
      dispose = registerFrontendDebugSlice('mobile.workspace', () => ({
        projectId,
        papers: papers.papers.map((paper) => ({ key: paper.key, target: paper.target, scrollTop: paper.scrollTop })),
        activeKey: papers.activeKey,
        desk,
        intents: { bottom: readBottomPaneIntent(), superView: readSuperViewIntent() },
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [desk, papers, projectId]);

  const pan = useDeskPan({ deskRef, paperRef, drawer: desk.drawer, writing: desk.writing, dispatch });
  usePaperScrollMemory(pageRef, activePaper, session.rememberScroll, desk.stage === 'paper');
  const pageKey = desk.stage === 'home' ? 'home' : activePaper?.key ?? 'empty';
  usePageTurn(pageRef, pageKey, leavingPageRef);
  const readingAway = useReadingAway(pageRef, pageKey);

  // The Bottom Panel's height lifts the paper's foot.
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useLayoutEffect(() => {
    const sync = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  const bottomHeight = desk.bottom ? Math.round(viewportHeight * BOTTOM_SHARE[desk.bottom.detent]) : 0;

  const showPaper = desk.stage === 'paper' && activePaper;
  const deskStyle = {
    '--m-bottom-h': `${bottomHeight}px`,
    '--m-sliver': `${DESK_SLIVER_PX}px`,
  } as CSSProperties;

  return (
    <WorkspaceNavigationProvider navigator={navigator}>
      <div
        ref={deskRef}
        className="m-root"
        data-debug-id="mobile-workspace"
        data-drawer={desk.drawer}
        data-panning={pan.panning ? pan.side : undefined}
        data-writing={desk.writing ? 'true' : undefined}
        data-bottom={desk.bottom ? desk.bottom.detent : undefined}
        data-stage={desk.stage}
        data-reading={readingAway ? 'away' : undefined}
        data-super-view={desk.superView ?? undefined}
        style={deskStyle}
      >
        <div className="m-under" aria-hidden={desk.drawer === 'none' && !pan.panning ? 'true' : undefined}>
          <div className="m-under__side m-under__side--left" inert={desk.drawer !== 'left' || undefined} {...pan.drawerHandlers}>
            <MobileLeftDesk
              panel={desk.left}
              target={target}
              onPanelChange={(panel) => dispatch({ type: 'set-left-panel', panel })}
              onLeaveBook={leaveBook}
              onSearch={() => dispatch({ type: 'open-sheet', sheet: 'search' })}
              onOpenTrash={() => dispatch({ type: 'open-sheet', sheet: 'trash' })}
            />
          </div>
          <div className="m-under__side m-under__side--right" inert={desk.drawer !== 'right' || undefined} {...pan.drawerHandlers}>
            <MobileRightSidebar
              projectId={projectId}
              panel={desk.right}
              target={target}
              onPanelChange={(panel) => dispatch({ type: 'set-right-panel', panel })}
              onOpenWorkbench={() => dispatch({ type: 'open-super-view', view: 'memo-material' })}
            />
          </div>
          <div className="m-under__bottom" data-pane={desk.bottom?.pane ?? desk.lastBottomPane} inert={!desk.bottom || undefined}>
            {desk.bottom?.pane === 'timeline' && <BottomTimeline presentation="mobile" />}
            <div className="m-under__planner" ref={setPlotPlannerSlot} hidden={desk.bottom?.pane !== 'planner'} />
          </div>
        </div>

        <div ref={paperRef} className="m-paper" {...pan.paperHandlers}>
          <span className="flow-line flow-line--v m-paper__edge m-paper__edge--left" aria-hidden="true" />
          <span className="flow-line flow-line--v m-paper__edge m-paper__edge--right" aria-hidden="true" />
          <div ref={pageRef} className="m-paper__page" data-debug-id="mobile-paper">
            <TrailingEditorPaneContext.Provider value>
              {showPaper ? (
                <MobilePaperContent key={mobilePaperKey(activePaper.target)} target={activePaper.target} />
              ) : (
                <ProjectDashboard />
              )}
            </TrailingEditorPaneContext.Provider>
          </div>
          {showPaper && !desk.writing && (
            <MobileForeEdge
              target={target}
              paperRef={pageRef}
              onOpenChapter={(id) => navigator.open({ entityType: 'node', id })}
            />
          )}
          <MobileDock
            papers={papers.papers}
            activeKey={papers.activeKey}
            homeShown={desk.stage === 'home'}
            drawer={desk.drawer}
            bottomOpen={desk.bottom !== null}
            onActivate={(paper) => navigator.activate(paper.target)}
            onClose={(paper) => {
              const last = papers.papers.length === 1;
              session.close(paper.key);
              if (last) dispatch({ type: 'show-home' });
            }}
            onNew={() => showHome({ intent: 'new' })}
            onToggleDrawer={(side) =>
              dispatch(desk.drawer === side ? { type: 'close-drawer' } : { type: 'open-drawer', side })
            }
            // A flick up lifts the paper's foot to half, then to nearly the
            // top; a flick down steps it back the same way.
            onLift={() => dispatch(desk.bottom ? { type: 'set-bottom-detent', detent: 'full' } : { type: 'open-bottom', detent: 'half' })}
            onLower={() => dispatch(desk.bottom?.detent === 'full' ? { type: 'set-bottom-detent', detent: 'half' } : { type: 'close-bottom' })}
          />
          {desk.drawer !== 'none' && (
            <button
              type="button"
              className="m-paper__shield"
              data-debug-id="mobile-paper-shield"
              aria-label={t('mobileDesk.paper.back')}
              onClick={() => dispatch({ type: 'close-drawer' })}
            />
          )}
        </div>

        {showPaper && (
          <MobileProseNameCard paperRef={pageRef} writing={desk.writing} onOpen={(next) => navigator.open(next)} />
        )}

        {desk.writing && writing.editor && !writing.editor.isDestroyed && (
          <MobileKeyboardBar
            projectId={projectId}
            editor={writing.editor}
            mode={desk.keyboardBar}
            keyboardInset={writing.keyboardInset}
            revision={writing.revision}
            onModeChange={(bar) => dispatch({ type: 'set-keyboard-bar', bar })}
            onAskAgent={() => {
              // A selected passage goes along as a quote in the Agent's box,
              // where the author can see it and say what to do with it.
              const editor = writing.editor;
              if (editor && !editor.isDestroyed && !editor.state.selection.empty) {
                const { from, to } = editor.state.selection;
                const passage = editor.state.doc.textBetween(from, to, '\n').trim();
                if (passage) {
                  const chat = useAgentChatStore.getState();
                  const quote = passage.split('\n').map((line) => `> ${line}`).join('\n');
                  const current = chat.prompt.replace(/\s+$/u, '');
                  chat.setPrompt(current ? `${current}\n\n${quote}\n\n` : `${quote}\n\n`);
                }
              }
              dispatch({ type: 'open-drawer', side: 'right', panel: 'companion' });
            }}
            onDone={() => getActiveEditor()?.commands.blur()}
          />
        )}

        <MobileSuperViewHost
          active={desk.superView}
          onActiveChange={(view) => dispatch(view ? { type: 'open-super-view', view } : { type: 'close-super-view' })}
          returnPointCaptured={desk.superView !== null}
        />
        <GlobalSearchModal isOpen={desk.sheet === 'search'} onClose={() => dispatch({ type: 'close-sheet' })} />
        {desk.sheet === 'trash' && <MobileProjectTrashView onClose={() => dispatch({ type: 'close-sheet' })} />}
        <EntitySnapshotHistoryModal />
        <DriftBindModal />
      </div>
    </WorkspaceNavigationProvider>
  );
}
