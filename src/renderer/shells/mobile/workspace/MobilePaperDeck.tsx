import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Layers3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EditorRailPresentationContext } from '../../../components/editor/editor-rail-presentation';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { MobileEntityPreviewSheet } from './MobileEntityPreviewSheet';
import { MobilePaperContent } from './MobilePaperContent';
import { MobileBarSheet } from './MobileBarSheet';
import { MobilePaperSearchOwnerMount } from './MobilePaperSearchOwnerMount';
import { MobilePaperSnapshot } from './MobilePaperSnapshot';
import { MobileUnifiedBar } from './MobileUnifiedBar';
import { MobileWorkspacePanels } from './MobileWorkspacePanels';
import {
  canStartMobilePaperSwipe,
  MOBILE_PAPER_SWIPE_HOLD_CANCEL_MS,
  mobilePaperSwipeTargetIsExcluded,
  resolveMobilePaperSwipe,
} from './mobile-paper-swipe';
import type { MobilePaperRail } from './mobile-paper-rail';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import {
  type MobileWorkspaceAction,
  type MobileWorkspacePanel,
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';

type PanelPosition = 'top' | 'bottom';
type PaperSwipePhase = 'idle' | 'tracking' | 'dragging' | 'settling';

interface PaperSwipeState {
  pointerId: number;
  x: number;
  y: number;
  time: number;
  originIndex: number;
  originScrollLeft: number;
  axis: 'horizontal' | null;
  cancelled: boolean;
}

const DEFAULT_PANEL_EXTENT = 0.3;
const PAPER_SWIPE_SETTLE_MS = 180;

function MobilePaperViewport({
  paper,
  outlineRailVisible,
  outlinePortalTargetId,
  commentPortalTargetId,
  onRememberScroll,
}: {
  paper: MobilePaper;
  outlineRailVisible: boolean;
  outlinePortalTargetId?: string;
  commentPortalTargetId?: string;
  onRememberScroll: (key: string, scrollTop: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const initialScrollTopRef = useRef(paper.scrollTop);
  const savedScrollRef = useRef(paper.scrollTop);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let scroller: HTMLElement | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      onRememberScroll(paper.key, savedScrollRef.current);
    };
    const onScroll = () => {
      if (!scroller) return;
      savedScrollRef.current = scroller.scrollTop;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 140);
    };
    const attach = () => {
      const next = root.querySelector<HTMLElement>('.editor-scroll, .dash');
      if (!next || next === scroller) return;
      scroller?.removeEventListener('scroll', onScroll);
      scroller = next;
      scroller.scrollTop = initialScrollTopRef.current;
      savedScrollRef.current = initialScrollTopRef.current;
      scroller.addEventListener('scroll', onScroll, { passive: true });
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
      flush();
    };
  }, [onRememberScroll, paper.key]);

  return (
    <div ref={rootRef} className="m-paper-scroll-memory">
      <EditorRailPresentationContext.Provider
        value={{
          outlineVisible: outlineRailVisible,
          outlineLabelPitch: 34,
          outlinePortalTargetId,
          commentPortalTargetId,
        }}
      >
        <MobilePaperContent target={paper.target} />
      </EditorRailPresentationContext.Provider>
    </div>
  );
}

function currentSelectionIsCollapsed(): boolean {
  const selection = window.getSelection?.();
  return !selection || selection.isCollapsed;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function MobilePaperDeck({
  projectId,
  session,
  frozenProseByKey,
  onActivate,
  onOpenPaper,
  onRememberScroll,
  onOpenOverview,
  onProjectSearch,
  workspaceUi,
  onWorkspaceUiAction,
}: {
  projectId: string;
  session: MobileWorkspaceSessionState;
  frozenProseByKey: Readonly<Record<string, string>>;
  onActivate: (paper: MobilePaper) => void;
  onOpenPaper: (target: WorkspaceTarget) => void;
  onRememberScroll: (key: string, scrollTop: number) => void;
  onOpenOverview: () => void;
  onProjectSearch: (query: string) => void;
  workspaceUi: MobileWorkspaceUiState;
  onWorkspaceUiAction: Dispatch<MobileWorkspaceAction>;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement | null>(null);
  const paperRowRef = useRef<HTMLDivElement | null>(null);
  const paperSwipeRef = useRef<PaperSwipeState | null>(null);
  const paperSwipeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [paperSwipePhase, setPaperSwipePhase] = useState<PaperSwipePhase>('idle');
  const [panelExtentOverride, setPanelExtentOverride] = useState<number | null>(null);
  const [dockedExtent, setDockedExtent] = useState({
    top: DEFAULT_PANEL_EXTENT,
    bottom: DEFAULT_PANEL_EXTENT,
  });
  const [panelResizing, setPanelResizing] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const reveal: PanelPosition | 'focused' = workspaceUi.panel.startsWith('top-')
    ? 'top'
    : workspaceUi.panel.startsWith('bottom-')
      ? 'bottom'
      : 'focused';
  const fullPanel: PanelPosition | null = workspaceUi.panel.endsWith('-full')
    ? reveal === 'focused'
      ? null
      : reveal
    : null;
  const previewTarget =
    workspaceUi.transient.kind === 'entity-preview' ? workspaceUi.transient.target : null;
  const activeRail: MobilePaperRail | null =
    workspaceUi.transient.kind === 'bar-sheet' && workspaceUi.transient.sheet === 'outline'
      ? 'toc'
      : workspaceUi.transient.kind === 'bar-sheet' &&
          workspaceUi.transient.sheet === 'comments'
        ? 'comments'
        : null;
  const activeBarSheet =
    workspaceUi.transient.kind === 'bar-sheet' ? workspaceUi.transient.sheet : null;
  const settledPanelExtent =
    workspaceUi.panel === 'none'
      ? 0
      : workspaceUi.panel.endsWith('-full')
        ? 1
        : workspaceUi.panel.startsWith('top-')
          ? dockedExtent.top
          : dockedExtent.bottom;
  const panelExtent = panelExtentOverride ?? settledPanelExtent;
  const visibleExtent = reveal === 'focused' ? 0 : panelExtent;
  const active = session.papers.find((paper) => paper.key === session.activeKey) ?? null;
  const editorActive = workspaceUi.paperMode.kind === 'edit';

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG !== '1') {
      return undefined;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import('../../../lib/frontend-debug/registry').then(({ registerFrontendDebugSlice }) => {
      if (cancelled) return;
      dispose = registerFrontendDebugSlice('mobile.paper-deck', () => ({
        activeKey: session.activeKey,
        reveal,
        panelExtent,
        visibleExtent,
        panelResizing,
        fullPanel,
        editorActive,
        activeRail,
        paperSwipePhase,
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [
    activeRail,
    editorActive,
    fullPanel,
    panelExtent,
    panelResizing,
    paperSwipePhase,
    reveal,
    session.activeKey,
    visibleExtent,
  ]);

  useEffect(
    () => () => {
      if (paperSwipeTimerRef.current) clearTimeout(paperSwipeTimerRef.current);
    },
    [],
  );

  const scrollPaperIntoPlace = useCallback(
    (paperKey: string, behavior: ScrollBehavior = 'auto') => {
      const row = paperRowRef.current;
      if (!row) return;
      const page = row.querySelector<HTMLElement>(`[data-paper-key="${CSS.escape(paperKey)}"]`);
      if (!page) return;
      row.scrollTo({ left: page.offsetLeft, behavior });
    },
    [],
  );

  useLayoutEffect(() => {
    if (session.activeKey && paperSwipePhase === 'idle') {
      scrollPaperIntoPlace(session.activeKey);
    }
  }, [paperSwipePhase, scrollPaperIntoPlace, session.activeKey, session.papers.length, visibleExtent]);

  const finishPaperSwipe = useCallback(
    (targetIndex: number, committed: boolean) => {
      const target = session.papers[targetIndex];
      const origin = paperSwipeRef.current
        ? session.papers[paperSwipeRef.current.originIndex]
        : active;
      const destination = committed && target ? target : origin;
      paperSwipeRef.current = null;
      if (!destination) {
        setPaperSwipePhase('idle');
        return;
      }

      const reducedMotion = prefersReducedMotion();
      setPaperSwipePhase('settling');
      scrollPaperIntoPlace(destination.key, reducedMotion ? 'auto' : 'smooth');
      if (paperSwipeTimerRef.current) clearTimeout(paperSwipeTimerRef.current);
      const settle = () => {
        paperSwipeTimerRef.current = null;
        if (committed && destination.key !== session.activeKey) onActivate(destination);
        setPaperSwipePhase('idle');
      };
      if (reducedMotion) settle();
      else paperSwipeTimerRef.current = setTimeout(settle, PAPER_SWIPE_SETTLE_MS);
    },
    [active, onActivate, scrollPaperIntoPlace, session.activeKey, session.papers],
  );

  const beginPaperSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const row = event.currentTarget;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (session.papers.length < 2 || paperSwipePhase !== 'idle') return;
    if (mobilePaperSwipeTargetIsExcluded(event.target, row)) return;
    if (
      !canStartMobilePaperSwipe({
        workspace: workspaceUi,
        activeRail,
        selectionCollapsed: currentSelectionIsCollapsed(),
        composing: composingRef.current,
      })
    ) {
      return;
    }
    const originIndex = session.papers.findIndex((paper) => paper.key === session.activeKey);
    if (originIndex < 0) return;
    paperSwipeRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
      originIndex,
      originScrollLeft: row.scrollLeft,
      axis: null,
      cancelled: false,
    };
    setPaperSwipePhase('tracking');
  };

  const movePaperSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = paperSwipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return;
    const durationMs = Math.max(0, event.timeStamp - gesture.time);
    if (gesture.axis === null && durationMs > MOBILE_PAPER_SWIPE_HOLD_CANCEL_MS) {
      gesture.cancelled = true;
      setPaperSwipePhase('idle');
      return;
    }

    const deltaX = event.clientX - gesture.x;
    const deltaY = event.clientY - gesture.y;
    const decision = resolveMobilePaperSwipe({
      deltaX,
      deltaY,
      durationMs,
      viewportWidth: event.currentTarget.clientWidth,
      originIndex: gesture.originIndex,
      paperCount: session.papers.length,
    });
    if (decision.axis === 'pending') return;
    if (decision.axis === 'vertical') {
      gesture.cancelled = true;
      setPaperSwipePhase('idle');
      return;
    }

    if (gesture.axis === null) {
      gesture.axis = 'horizontal';
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setPaperSwipePhase('dragging');
    }
    event.preventDefault();
    const row = event.currentTarget;
    row.scrollLeft = Math.max(
      0,
      Math.min(row.scrollWidth - row.clientWidth, gesture.originScrollLeft - deltaX),
    );
  };

  const endPaperSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = paperSwipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.axis !== 'horizontal' || gesture.cancelled) {
      paperSwipeRef.current = null;
      setPaperSwipePhase('idle');
      return;
    }
    event.preventDefault();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    const decision = resolveMobilePaperSwipe({
      deltaX: event.clientX - gesture.x,
      deltaY: event.clientY - gesture.y,
      durationMs: Math.max(0, event.timeStamp - gesture.time),
      viewportWidth: event.currentTarget.clientWidth,
      originIndex: gesture.originIndex,
      paperCount: session.papers.length,
    });
    finishPaperSwipe(decision.targetIndex, decision.committed);
  };

  const cancelPaperSwipe = () => {
    const gesture = paperSwipeRef.current;
    paperSwipeRef.current = null;
    setPaperSwipePhase('idle');
    const origin = gesture ? session.papers[gesture.originIndex] : active;
    if (origin) scrollPaperIntoPlace(origin.key);
  };

  const commitPanel = useCallback(
    (nextReveal: PanelPosition | 'focused', extent = DEFAULT_PANEL_EXTENT) => {
      setPanelResizing(false);
      if (nextReveal !== 'focused') {
        const nextExtent = Math.max(0.08, Math.min(0.48, extent));
        setDockedExtent((current) =>
          current[nextReveal] === nextExtent
            ? current
            : { ...current, [nextReveal]: nextExtent },
        );
      }
      setPanelExtentOverride(null);
      onWorkspaceUiAction({
        type: 'set-panel',
        panel: nextReveal === 'focused' ? 'none' : `${nextReveal}-docked`,
      });
    },
    [onWorkspaceUiAction],
  );

  const setExtentFromHandle = (panel: PanelPosition, extent: number) => {
    setPanelResizing(true);
    setPanelExtentOverride(extent);
    const nextPanel = `${panel}-docked` as MobileWorkspacePanel;
    if (workspaceUi.panel !== nextPanel) {
      onWorkspaceUiAction({ type: 'set-panel', panel: nextPanel });
    }
  };

  const commitExtentFromHandle = (panel: PanelPosition, extent: number) => {
    setPanelResizing(false);
    if (extent <= 0.08) {
      commitPanel('focused');
      return;
    }
    if (extent >= 0.5) {
      setPanelExtentOverride(null);
      onWorkspaceUiAction({ type: 'set-panel', panel: `${panel}-full` });
      return;
    }
    setDockedExtent((current) =>
      current[panel] === extent ? current : { ...current, [panel]: extent },
    );
    setPanelExtentOverride(null);
    onWorkspaceUiAction({ type: 'set-panel', panel: `${panel}-docked` });
  };

  const setActivePaperRail = useCallback(
    (rail: MobilePaperRail | null) =>
      onWorkspaceUiAction({
        type: 'set-transient',
        transient:
          rail === 'toc'
            ? { kind: 'bar-sheet', sheet: 'outline' }
            : rail === 'comments'
              ? { kind: 'bar-sheet', sheet: 'comments' }
              : { kind: 'none' },
      }),
    [onWorkspaceUiAction],
  );
  const openSearch = useCallback(
    () =>
      onWorkspaceUiAction({
        type: 'set-transient',
        transient: { kind: 'search', scope: 'paper' },
      }),
    [onWorkspaceUiAction],
  );
  const syncEditor = useCallback(
    (editing: boolean) => onWorkspaceUiAction({ type: 'sync-editor', editing }),
    [onWorkspaceUiAction],
  );
  const syncKeyboard = useCallback(
    (keyboard: 'closed' | 'open') =>
      onWorkspaceUiAction({ type: 'sync-keyboard', keyboard }),
    [onWorkspaceUiAction],
  );
  const setEditorAccessoryExpanded = useCallback(
    (expanded: boolean) =>
      onWorkspaceUiAction({
        type: 'set-transient',
        transient: expanded
          ? { kind: 'bar-sheet', sheet: 'formatting' }
          : { kind: 'none' },
      }),
    [onWorkspaceUiAction],
  );

  return (
    <main
      ref={rootRef}
      className="m-workspace"
      data-debug-id="mobile-workspace"
      data-reveal={reveal}
      data-preview={panelResizing ? 'true' : 'false'}
      data-full-panel={fullPanel ?? 'none'}
      data-paper-swipe={paperSwipePhase}
      data-editor-active={editorActive ? 'true' : 'false'}
      data-paper-rail={activeRail ?? 'none'}
      data-bar-sheet={activeBarSheet ?? 'none'}
      data-controller-surface={workspaceUi.surface.kind}
      data-controller-panel={workspaceUi.panel}
      data-controller-transient={workspaceUi.transient.kind}
      data-controller-paper-mode={workspaceUi.paperMode.kind}
      data-controller-keyboard={workspaceUi.keyboard}
      style={
        {
          '--m-panel-extent': visibleExtent,
          '--m-unified-keyboard-inset': `${keyboardInset}px`,
        } as CSSProperties
      }
      onCompositionStartCapture={() => {
        composingRef.current = true;
      }}
      onCompositionEndCapture={() => {
        composingRef.current = false;
      }}
    >
      <MobileWorkspacePanels
        projectId={projectId}
        target={active?.target ?? null}
        panelExtent={panelExtent}
        onPanelExtentChange={setExtentFromHandle}
        onPanelExtentCommit={commitExtentFromHandle}
        onPreviewTarget={(target) =>
          onWorkspaceUiAction({
            type: 'set-transient',
            transient: { kind: 'entity-preview', target },
          })
        }
      />

      <div className="m-paper-deck">
        {session.papers.length > 0 ? (
          <div
            ref={paperRowRef}
            className="m-paper-row"
            data-debug-id="mobile-paper-row"
            onPointerDown={beginPaperSwipe}
            onPointerMove={movePaperSwipe}
            onPointerUp={endPaperSwipe}
            onPointerCancel={cancelPaperSwipe}
            onClickCapture={(event) => {
              if (!suppressClickRef.current) return;
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {session.papers.map((paper) => {
              const isActive = paper.key === session.activeKey;
              return (
                <section
                  key={paper.key}
                  className="m-paper-row__page"
                  data-paper-key={paper.key}
                  data-active={isActive ? 'true' : 'false'}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <div className="m-paper-row__paper">
                    {isActive ? (
                      <div className="m-paper-deck__content">
                        <MobilePaperViewport
                          paper={paper}
                          outlineRailVisible={activeRail === 'toc'}
                          outlinePortalTargetId={
                            activeRail === 'toc' ? 'mobile-outline-sheet-content' : undefined
                          }
                          commentPortalTargetId={
                            activeRail === 'comments'
                              ? 'mobile-comments-sheet-content'
                              : undefined
                          }
                          onRememberScroll={onRememberScroll}
                        />
                      </div>
                    ) : (
                      <MobilePaperSnapshot
                        projectId={projectId}
                        paper={paper}
                        frozenContentJson={frozenProseByKey[paper.key]}
                      />
                    )}
                    {!isActive && (
                      <button
                        type="button"
                        className="m-paper-row__activate"
                        aria-label={t('mobileWorkspace.activatePaper', {
                          defaultValue: '切换到这张纸',
                        })}
                        onClick={() => onActivate(paper)}
                      />
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <section className="m-paper-row__empty" aria-label={t('editorMainArea.emptyHint')}>
            <div className="m-paper-empty">
              <Layers3 size={24} aria-hidden="true" />
              <strong>{t('mobileWorkspace.noPapers', { defaultValue: '没有打开的纸张' })}</strong>
              <button type="button" onClick={onOpenOverview}>
                {t('mobileWorkspace.openOverview', { defaultValue: '打开纸张总览' })}
              </button>
            </div>
          </section>
        )}
      </div>

      {previewTarget && (
        <MobileEntityPreviewSheet
          target={previewTarget}
          paperOpen={session.papers.some(
            (paper) =>
              paper.target.entityType === previewTarget.entityType &&
              paper.target.id === previewTarget.id,
          )}
          onClose={() =>
            onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'none' } })
          }
          onInsert={() => {
            onOpenPaper(previewTarget);
            onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'none' } });
            commitPanel('focused');
          }}
        />
      )}

      {activeBarSheet && (
        <MobileBarSheet
          sheet={activeBarSheet}
          onClose={() =>
            onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'none' } })
          }
        />
      )}

      <MobilePaperSearchOwnerMount paper={active} />
      <MobileUnifiedBar
        workspaceUi={workspaceUi}
        activePaper={active}
        paperCount={session.papers.length}
        activeRail={activeRail}
        keyboardInset={keyboardInset}
        onWorkspacePanelChange={(panel) =>
          onWorkspaceUiAction({ type: 'set-panel', panel })
        }
        onOpenOverview={onOpenOverview}
        onOpenSearch={openSearch}
        onProjectSearch={onProjectSearch}
        onActiveRailChange={setActivePaperRail}
        editorAccessoryExpanded={
          workspaceUi.transient.kind === 'bar-sheet' &&
          workspaceUi.transient.sheet === 'formatting'
        }
        onEditorAccessoryExpandedChange={setEditorAccessoryExpanded}
        onEditingStateChange={syncEditor}
        onKeyboardStateChange={syncKeyboard}
        onKeyboardInsetChange={setKeyboardInset}
      />
    </main>
  );
}
