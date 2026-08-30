import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ArrowLeft, Ellipsis, Layers3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EditorRailPresentationContext } from '../../../components/editor/editor-rail-presentation';
import type { CommentTargetKind } from '../../../domain/comment';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useEntityStickyNoteRail } from '../../../hooks/useEntityStickyNoteRail';
import { getActiveEditor } from '../../../lib/active-editor';
import {
  mobileEditorLogicalScrollTop,
  mobileEditorScrollTopAfterReserveChange,
} from './mobile-keyboard-geometry';
import { MobileEntityPreviewSheet } from './MobileEntityPreviewSheet';
import { MobilePaperContent } from './MobilePaperContent';
import { MobilePaperSearchOwnerMount } from './MobilePaperSearchOwnerMount';
import { MobilePaperSnapshot } from './MobilePaperSnapshot';
import { MobilePaperStatsSheet } from './MobilePaperStatsSheet';
import { MobileUnifiedBar } from './MobileUnifiedBar';
import { MobileTabBar } from './MobileTabBar';
import { MobileRightSidebar } from './MobileRightSidebar';
import { MobilePaperTools } from './MobilePaperTools';
import { MobilePaperToolsBar } from './MobilePaperToolsBar';
import { MobileSelectionChip } from './MobileSelectionChip';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { usePaperGlyph } from './mobile-paper-glyph';
import { requestMobileWorkspaceBack } from './mobile-workspace-back';
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
  type MobileWorkspaceUiState,
} from './mobile-workspace-controller';

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

const PAPER_SWIPE_SETTLE_MS = 180;

function MobilePaperViewport({
  paper,
  outlineRailVisible,
  topScrollReserve,
  onRememberScroll,
}: {
  paper: MobilePaper;
  outlineRailVisible: boolean;
  topScrollReserve: number;
  onRememberScroll: (key: string, scrollTop: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const initialScrollTopRef = useRef(paper.scrollTop);
  const savedScrollRef = useRef(paper.scrollTop);
  const requestedTopScrollReserveRef = useRef(topScrollReserve);
  const appliedTopScrollReserveRef = useRef(0);

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
      savedScrollRef.current = mobileEditorLogicalScrollTop(
        scroller.scrollTop,
        appliedTopScrollReserveRef.current,
      );
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 140);
    };
    const attach = () => {
      const next = root.querySelector<HTMLElement>('.editor-scroll, .dash');
      if (!next || next === scroller) return;
      scroller?.removeEventListener('scroll', onScroll);
      scroller = next;
      scrollerRef.current = next;
      const reserve = next.classList.contains('editor-scroll')
        ? requestedTopScrollReserveRef.current
        : 0;
      appliedTopScrollReserveRef.current = reserve;
      scroller.scrollTop = initialScrollTopRef.current + reserve;
      savedScrollRef.current = initialScrollTopRef.current;
      scroller.addEventListener('scroll', onScroll, { passive: true });
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
      if (scrollerRef.current === scroller) scrollerRef.current = null;
      appliedTopScrollReserveRef.current = 0;
      flush();
    };
  }, [onRememberScroll, paper.key]);

  useLayoutEffect(() => {
    requestedTopScrollReserveRef.current = topScrollReserve;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const effectiveReserve = scroller.classList.contains('editor-scroll') ? topScrollReserve : 0;
    const previous = appliedTopScrollReserveRef.current;
    if (previous === effectiveReserve) return;

    // Keep WebKit's caret-preserving viewport pan visually untouched. The new
    // space belongs to the real scroll owner, and scrollTop moves by the same
    // delta before paint. The author can later scroll through that reserve to
    // bring the document-start folio into view.
    appliedTopScrollReserveRef.current = effectiveReserve;
    scroller.scrollTop = mobileEditorScrollTopAfterReserveChange(
      scroller.scrollTop,
      previous,
      effectiveReserve,
    );
    savedScrollRef.current = mobileEditorLogicalScrollTop(
      scroller.scrollTop,
      effectiveReserve,
    );
  }, [topScrollReserve]);

  return (
    <div ref={rootRef} className="m-paper-scroll-memory">
      <EditorRailPresentationContext.Provider
        value={{
          outlineVisible: outlineRailVisible,
          outlineLabelPitch: 34,
        }}
      >
        <MobilePaperContent target={paper.target} />
      </EditorRailPresentationContext.Provider>
    </div>
  );
}

function MobilePaperFolioIdentity({ paper }: { paper: MobilePaper }) {
  const presentation = useMobilePaperPresentation(paper.target);
  const glyph = usePaperGlyph(paper.target);
  return (
    <span className="m-paper-folio__identity">
      <span aria-hidden="true">{glyph}</span> {presentation.kicker} · {presentation.title}
    </span>
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
  const previousActiveKeyRef = useRef(session.activeKey);
  const [paperSwipePhase, setPaperSwipePhase] = useState<PaperSwipePhase>('idle');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [keyboardViewportOffsetTop, setKeyboardViewportOffsetTop] = useState(0);
  const [chromeScrolledAway, setChromeScrolledAway] = useState(false);

  const previewTarget =
    workspaceUi.transient.kind === 'entity-preview' ? workspaceUi.transient.target : null;
  const [openRails, setOpenRails] = useState<Record<MobilePaperRail, boolean>>({
    toc: false,
    comments: false,
  });
  const active = session.papers.find((paper) => paper.key === session.activeKey) ?? null;
  const activeRailTarget =
    active && active.target.entityType !== 'all-chapters'
      ? {
          kind: active.target.entityType as CommentTargetKind,
          id: active.target.id,
        }
      : null;
  const stickyNoteRail = useEntityStickyNoteRail(
    activeRailTarget?.kind ?? 'node',
    activeRailTarget?.id,
  );
  const effectiveOpenRails = useMemo<Record<MobilePaperRail, boolean>>(
    () => ({
      toc: openRails.toc,
      comments: stickyNoteRail.visible,
    }),
    [openRails.toc, stickyNoteRail.visible],
  );
  const activeIndex = active
    ? session.papers.findIndex((paper) => paper.key === active.key)
    : -1;
  const editorActive = workspaceUi.paperMode.kind === 'edit';
  const paperChromeVisible =
    workspaceUi.surface.kind === 'paper' &&
    workspaceUi.paperMode.kind === 'read' &&
    workspaceUi.transient.kind === 'none' &&
    (workspaceUi.overlay === 'none' || workspaceUi.overlay === 'paper-tools') &&
    workspaceUi.keyboard === 'closed';

  useLayoutEffect(() => {
    if (previousActiveKeyRef.current === session.activeKey) return;
    previousActiveKeyRef.current = session.activeKey;
    getActiveEditor()?.commands.blur();
    setKeyboardInset(0);
    setKeyboardViewportOffsetTop(0);
    setOpenRails({ toc: false, comments: false });
    onWorkspaceUiAction({ type: 'sync-editor', editing: false });
  }, [onWorkspaceUiAction, session.activeKey]);

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
        editorActive,
        openRails: effectiveOpenRails,
        paperSwipePhase,
        chromeScrolledAway,
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [chromeScrolledAway, editorActive, effectiveOpenRails, paperSwipePhase, session.activeKey]);

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
  }, [paperSwipePhase, scrollPaperIntoPlace, session.activeKey, session.papers.length]);

  // Reading slides the bottom tab bar away; scrolling back up (or switching
  // papers) recalls it. Scroll events don't bubble, so listen in capture.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- recalling the bar on paper switch is the intended reset
    setChromeScrolledAway(false);
  }, [session.activeKey]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let lastTarget: EventTarget | null = null;
    let lastTop = 0;
    let travel = 0;
    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement)) return;
      if (!el.classList.contains('editor-scroll') && !el.classList.contains('dash')) return;
      const top = el.scrollTop;
      if (lastTarget === el) {
        // Touch scrolling arrives as a high-frequency stream of 1–10px steps,
        // so a per-event threshold never fires. Accumulate travel in one
        // direction and reset when the direction flips.
        const delta = top - lastTop;
        travel = (travel >= 0) === (delta >= 0) ? travel + delta : delta;
        if (travel > 24 && top > 48) setChromeScrolledAway(true);
        else if (travel < -24 || top <= 8) setChromeScrolledAway(false);
      } else {
        travel = 0;
      }
      lastTarget = el;
      lastTop = top;
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, []);

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
        if (committed && destination.key !== session.activeKey) {
          getActiveEditor()?.commands.blur();
          onWorkspaceUiAction({ type: 'sync-editor', editing: false });
          onActivate(destination);
        }
        setPaperSwipePhase('idle');
      };
      if (reducedMotion) settle();
      else paperSwipeTimerRef.current = setTimeout(settle, PAPER_SWIPE_SETTLE_MS);
    },
    [
      active,
      onActivate,
      onWorkspaceUiAction,
      scrollPaperIntoPlace,
      session.activeKey,
      session.papers,
    ],
  );

  const beginPaperSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const row = event.currentTarget;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (session.papers.length < 2 || paperSwipePhase !== 'idle') return;
    if (
      mobilePaperSwipeTargetIsExcluded(
        event.target,
        row,
        false,
      )
    ) {
      return;
    }
    if (
      !canStartMobilePaperSwipe({
        workspace: workspaceUi,
        activeRail: effectiveOpenRails.toc
          ? 'toc'
          : effectiveOpenRails.comments
            ? 'comments'
            : null,
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

  const openSearch = useCallback(
    () =>
      onWorkspaceUiAction({
        type: 'open-search',
        scope: 'paper',
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
  const setEditorAccessoryMode = useCallback(
    (accessory: 'navigation' | 'formatting') =>
      onWorkspaceUiAction({ type: 'set-editor-accessory', accessory }),
    [onWorkspaceUiAction],
  );

  return (
    <main
      ref={rootRef}
      className="m-workspace"
      inert={workspaceUi.surface.kind !== 'paper'}
      aria-hidden={workspaceUi.surface.kind !== 'paper' ? 'true' : undefined}
      data-debug-id="mobile-workspace"
      data-paper-swipe={paperSwipePhase}
      data-editor-active={editorActive ? 'true' : 'false'}
      data-rail-toc={openRails.toc ? 'true' : 'false'}
      data-rail-comments={effectiveOpenRails.comments ? 'true' : 'false'}
      data-chrome-hidden={chromeScrolledAway ? 'true' : 'false'}
      data-controller-surface={workspaceUi.surface.kind}
      data-controller-transient={workspaceUi.transient.kind}
      data-controller-paper-mode={workspaceUi.paperMode.kind}
      data-controller-keyboard={workspaceUi.keyboard}
      style={
        {
          '--m-unified-keyboard-inset': `${keyboardInset}px`,
          '--m-editor-top-scroll-reserve': `${keyboardViewportOffsetTop}px`,
        } as CSSProperties
      }
      onCompositionStartCapture={() => {
        composingRef.current = true;
      }}
      onCompositionEndCapture={() => {
        composingRef.current = false;
      }}
    >
      {active && paperChromeVisible && (
        <header
          className="m-paper-folio"
          data-debug-id="mobile-paper-folio"
          data-hidden={chromeScrolledAway ? 'true' : 'false'}
          aria-hidden={chromeScrolledAway ? 'true' : undefined}
        >
          <button
            type="button"
            className="m-paper-folio__back"
            onClick={() => requestMobileWorkspaceBack('visible')}
            aria-label={t('navigation.back')}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <MobilePaperFolioIdentity paper={active} />
          <span className="m-paper-folio__end">
            <button
              type="button"
              className="m-paper-folio__papers"
              onClick={onOpenOverview}
              aria-label={t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}
            >
              <Layers3 size={18} aria-hidden="true" />
              <span>{session.papers.length}</span>
            </button>
            <button
              type="button"
              onClick={() => onWorkspaceUiAction({ type: 'set-overlay', overlay: 'tools' })}
              aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
            >
              <Ellipsis size={19} aria-hidden="true" />
            </button>
          </span>
        </header>
      )}

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
                          outlineRailVisible={openRails.toc}
                          topScrollReserve={
                            workspaceUi.keyboard === 'open' &&
                            (workspaceUi.paperMode.kind === 'edit' ||
                              workspaceUi.transient.kind === 'search')
                              ? keyboardViewportOffsetTop
                              : 0
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
          }}
        />
      )}

      {workspaceUi.transient.kind === 'paper-stats' && active && activeIndex >= 0 && (
        <MobilePaperStatsSheet
          target={active.target}
          onClose={() =>
            onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'none' } })
          }
        />
      )}

      {workspaceUi.overlay === 'tools' && active && (
        <MobileRightSidebar
          projectId={projectId}
          target={active.target}
          onClose={() => onWorkspaceUiAction({ type: 'set-overlay', overlay: 'none' })}
        />
      )}

      {workspaceUi.overlay === 'plot' && active && (
        <MobilePaperTools
          projectId={projectId}
          target={active.target}
          onClose={() => onWorkspaceUiAction({ type: 'set-overlay', overlay: 'none' })}
        />
      )}

      {paperChromeVisible && workspaceUi.overlay === 'paper-tools' && (
        <MobilePaperToolsBar
          hidden={chromeScrolledAway}
          openRails={effectiveOpenRails}
          onToggleRail={(rail) => {
            if (rail === 'comments') {
              stickyNoteRail.setVisible(!stickyNoteRail.visible);
              return;
            }
            setOpenRails((current) => ({ ...current, [rail]: !current[rail] }));
          }}
          onClose={() => onWorkspaceUiAction({ type: 'set-overlay', overlay: 'none' })}
          onOpenStats={() =>
            onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'paper-stats' } })
          }
          onOpenSearch={openSearch}
          onOpenPlot={() => onWorkspaceUiAction({ type: 'set-overlay', overlay: 'plot' })}
        />
      )}

      {paperChromeVisible && (
        <MobileTabBar
          hidden={chromeScrolledAway}
          onOpen={(tab) => onWorkspaceUiAction({ type: 'set-overlay', overlay: tab })}
          onOpenPaperTools={
            workspaceUi.overlay === 'paper-tools'
              ? undefined
              : () => onWorkspaceUiAction({ type: 'set-overlay', overlay: 'paper-tools' })
          }
        />
      )}

      <MobileSelectionChip
        active={
          workspaceUi.surface.kind === 'paper' && workspaceUi.transient.kind === 'none'
        }
      />

      <MobilePaperSearchOwnerMount paper={active} />
      <MobileUnifiedBar
        workspaceUi={workspaceUi}
        keyboardInset={keyboardInset}
        editorAccessoryMode={
          workspaceUi.paperMode.kind === 'edit'
            ? workspaceUi.paperMode.accessory
            : 'navigation'
        }
        onEditorAccessoryModeChange={setEditorAccessoryMode}
        onEditingStateChange={syncEditor}
        onKeyboardStateChange={syncKeyboard}
        onKeyboardInsetChange={setKeyboardInset}
        onKeyboardViewportOffsetTopChange={setKeyboardViewportOffsetTop}
      />
    </main>
  );
}
