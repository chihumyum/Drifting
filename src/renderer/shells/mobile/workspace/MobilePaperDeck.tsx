import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Layers3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EditorRailPresentationContext } from '../../../components/editor/editor-rail-presentation';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { MobilePaperContent } from './MobilePaperContent';
import { MobilePaperSnapshot } from './MobilePaperSnapshot';
import { MobileEntityPreviewSheet } from './MobileEntityPreviewSheet';
import { MobileEditorAccessory } from './MobileEditorAccessory';
import { MobilePaperRailMenu } from './MobilePaperRailMenu';
import { MobileWorkspacePanels } from './MobileWorkspacePanels';
import type { MobilePaperRail } from './mobile-paper-rail';
import {
  paperClusterDestination,
  paperClusterPreview,
  paperClusterQuickSwitchIndex,
} from './paper-cluster-gesture';
import { usePaperPinch, type PaperReveal } from './usePaperPinch';

interface PreviewState {
  target: Exclude<PaperReveal, 'focused'>;
  progress: number;
}

interface ClusterGestureState {
  x: number;
  y: number;
  start: PaperReveal;
  originIndex: number;
  pointerId: number;
  timer: ReturnType<typeof setTimeout> | null;
  armed: boolean;
  moved: boolean;
  cancelled: boolean;
  axis: 'horizontal' | 'vertical' | null;
  previewKey: string | null;
  frozenContentJson: string | undefined;
}

interface QuickSwitchState {
  paperKey: string;
  frozenPaperKey: string;
  frozenContentJson: string | undefined;
}

const DEFAULT_PANEL_EXTENT = 0.3;
const CLUSTER_ARM_DELAY_MS = 160;
const CLUSTER_PREARM_SLOP = 14;
const CLUSTER_DIRECTION_SLOP = 6;
const SIMULATOR_BOTTOM_PANEL_ACCEPTANCE =
  import.meta.env.VITE_MOBILE_SIMULATOR_BOTTOM_PANEL_ACCEPTANCE === 'true';

function MobilePaperViewport({
  paper,
  outlineRailVisible,
  onRememberScroll,
}: {
  paper: MobilePaper;
  outlineRailVisible: boolean;
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
        value={{ outlineVisible: outlineRailVisible, outlineLabelPitch: 34 }}
      >
        <MobilePaperContent target={paper.target} />
      </EditorRailPresentationContext.Provider>
    </div>
  );
}

export function MobilePaperDeck({
  projectId,
  session,
  frozenProseByKey,
  onFreezeActivePaper,
  onActivate,
  onOpenPaper,
  onRememberScroll,
  onOpenOverview,
}: {
  projectId: string;
  session: MobileWorkspaceSessionState;
  frozenProseByKey: Readonly<Record<string, string>>;
  onFreezeActivePaper: () => string | undefined;
  onActivate: (paper: MobilePaper) => void;
  onOpenPaper: (target: WorkspaceTarget) => void;
  onRememberScroll: (key: string, scrollTop: number) => void;
  onOpenOverview: () => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement | null>(null);
  const paperRowRef = useRef<HTMLDivElement | null>(null);
  const clusterDragRef = useRef<ClusterGestureState | null>(null);
  const rowScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticRowScrollRef = useRef(false);
  const [reveal, setReveal] = useState<PaperReveal>('focused');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [panelExtent, setPanelExtent] = useState(0);
  const [panelResizing, setPanelResizing] = useState(false);
  const [fullPanel, setFullPanel] = useState<Exclude<PaperReveal, 'focused'> | null>(null);
  const [previewTarget, setPreviewTarget] = useState<WorkspaceTarget | null>(null);
  const [clusterArmed, setClusterArmed] = useState(false);
  const [clusterAxis, setClusterAxis] = useState<'horizontal' | 'vertical' | null>(null);
  const [quickSwitch, setQuickSwitch] = useState<QuickSwitchState | null>(null);
  const [editorActive, setEditorActive] = useState(false);
  const [railByPaper, setRailByPaper] = useState<Record<string, MobilePaperRail | undefined>>({});

  const active = session.papers.find((paper) => paper.key === session.activeKey) ?? null;
  const activeRail = active ? (railByPaper[active.key] ?? null) : null;
  const visualActiveKey = quickSwitch?.paperKey ?? session.activeKey;
  const visualReveal = preview?.target ?? reveal;
  const visibleExtent = preview
    ? preview.progress * (reveal === 'focused' ? 0.3 : panelExtent)
    : reveal === 'focused'
      ? 0
      : panelExtent;

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
        visualActiveKey,
        reveal,
        visualReveal,
        preview,
        panelExtent,
        visibleExtent,
        panelResizing,
        fullPanel,
        quickSwitch: quickSwitch
          ? { paperKey: quickSwitch.paperKey, frozenPaperKey: quickSwitch.frozenPaperKey }
          : null,
        editorActive,
        activeRail,
        clusterArmed,
        clusterAxis,
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [
    activeRail,
    clusterArmed,
    clusterAxis,
    editorActive,
    fullPanel,
    panelExtent,
    panelResizing,
    preview,
    quickSwitch,
    reveal,
    session.activeKey,
    visibleExtent,
    visualActiveKey,
    visualReveal,
  ]);

  useEffect(
    () => () => {
      if (clusterDragRef.current?.timer) clearTimeout(clusterDragRef.current.timer);
      if (rowScrollTimerRef.current) clearTimeout(rowScrollTimerRef.current);
    },
    [],
  );

  const centerPaper = useCallback((paperKey: string, releaseOnNextFrame = true) => {
    const row = paperRowRef.current;
    if (!row) return;
    const page = row.querySelector<HTMLElement>(`[data-paper-key="${CSS.escape(paperKey)}"]`);
    if (!page) return;
    programmaticRowScrollRef.current = true;
    row.scrollTo({
      left: page.offsetLeft - (row.clientWidth - page.offsetWidth) / 2,
      behavior: 'auto',
    });
    if (releaseOnNextFrame) {
      requestAnimationFrame(() => {
        programmaticRowScrollRef.current = false;
      });
    }
  }, []);

  const alignActivePaper = useCallback(() => {
    if (!session.activeKey) return;
    centerPaper(session.activeKey);
  }, [centerPaper, session.activeKey]);

  const setActivePaperRail = useCallback(
    (rail: MobilePaperRail | null) => {
      if (!active) return;
      setRailByPaper((current) => {
        if ((current[active.key] ?? null) === rail) return current;
        const next = { ...current };
        if (rail === null) delete next[active.key];
        else next[active.key] = rail;
        return next;
      });
    },
    [active],
  );

  useLayoutEffect(() => {
    alignActivePaper();
  }, [alignActivePaper, session.papers.length, visibleExtent]);

  const activateNearestPaper = useCallback(() => {
    const row = paperRowRef.current;
    if (!row || programmaticRowScrollRef.current) return;
    const center = row.scrollLeft + row.clientWidth / 2;
    let nearest: { paper: MobilePaper; distance: number } | null = null;
    for (const paper of session.papers) {
      const page = row.querySelector<HTMLElement>(`[data-paper-key="${CSS.escape(paper.key)}"]`);
      if (!page) continue;
      const distance = Math.abs(page.offsetLeft + page.offsetWidth / 2 - center);
      if (!nearest || distance < nearest.distance) nearest = { paper, distance };
    }
    if (nearest && nearest.paper.key !== session.activeKey) onActivate(nearest.paper);
  }, [onActivate, session.activeKey, session.papers]);

  const commitReveal = useCallback((nextReveal: PaperReveal, extent = DEFAULT_PANEL_EXTENT) => {
    setPreview(null);
    setPanelResizing(false);
    setFullPanel(null);
    setReveal(nextReveal);
    setPanelExtent(nextReveal === 'focused' ? 0 : Math.max(0.08, Math.min(0.48, extent)));
  }, []);

  usePaperPinch(rootRef, {
    enabled: fullPanel === null && previewTarget === null,
    reveal,
    onPreview: (target, progress) => setPreview({ target, progress }),
    onCommit: commitReveal,
    onOverview: onOpenOverview,
  });

  const setExtentFromHandle = (panel: Exclude<PaperReveal, 'focused'>, extent: number) => {
    setPreview(null);
    setPanelResizing(true);
    setReveal(panel);
    setFullPanel(null);
    setPanelExtent(extent);
  };

  const commitExtentFromHandle = (panel: Exclude<PaperReveal, 'focused'>, extent: number) => {
    setPanelResizing(false);
    if (extent <= 0.08) {
      commitReveal('focused');
      return;
    }
    setPreview(null);
    setReveal(panel);
    if (extent >= 0.5) {
      setFullPanel(panel);
      setPanelExtent(1);
      return;
    }
    setFullPanel(null);
    setPanelExtent(extent);
  };

  const clusterMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = clusterDragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.armed) {
      if (Math.hypot(dx, dy) > CLUSTER_PREARM_SLOP) {
        drag.cancelled = true;
        if (drag.timer) clearTimeout(drag.timer);
      }
      return;
    }
    if (!drag.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= CLUSTER_DIRECTION_SLOP) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      setClusterAxis(drag.axis);
      if (drag.axis === 'horizontal') {
        drag.frozenContentJson = onFreezeActivePaper();
        const originPaper = session.papers[drag.originIndex];
        if (originPaper) {
          setQuickSwitch({
            paperKey: originPaper.key,
            frozenPaperKey: session.activeKey ?? originPaper.key,
            frozenContentJson: drag.frozenContentJson,
          });
        }
      }
    }
    drag.moved = true;
    if (drag.axis === 'horizontal') {
      const nextIndex = paperClusterQuickSwitchIndex(drag.originIndex, dx, session.papers.length);
      const paper = session.papers[nextIndex];
      if (!paper || paper.key === drag.previewKey) return;
      drag.previewKey = paper.key;
      setQuickSwitch({
        paperKey: paper.key,
        frozenPaperKey: session.activeKey ?? paper.key,
        frozenContentJson: drag.frozenContentJson,
      });
      centerPaper(paper.key, false);
      return;
    }
    setPreview(
      paperClusterPreview(
        drag.start,
        dy,
        rootRef.current?.clientHeight ?? window.innerHeight,
        panelExtent,
      ),
    );
  };

  const clusterUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = clusterDragRef.current;
    if (!drag) return;
    clusterDragRef.current = null;
    if (drag.timer) clearTimeout(drag.timer);
    setClusterArmed(false);
    setClusterAxis(null);
    if (drag.armed) event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!drag.armed) {
      setPreview(null);
      if (!drag.cancelled && Math.abs(event.clientY - drag.y) <= CLUSTER_PREARM_SLOP) {
        if (SIMULATOR_BOTTOM_PANEL_ACCEPTANCE) {
          commitExtentFromHandle('bottom', 1);
          return;
        }
        // Let the native button's synthesized click finish before replacing it
        // with the full-screen overview; otherwise Android can retarget that
        // click to the overview footer directly underneath the pill.
        window.setTimeout(onOpenOverview, 0);
      }
      return;
    }
    if (!drag.moved) {
      setPreview(null);
      setQuickSwitch(null);
      return;
    }
    if (drag.axis === 'horizontal') {
      const selected = session.papers.find((paper) => paper.key === drag.previewKey);
      if (selected && selected.key !== session.activeKey) onActivate(selected);
      setQuickSwitch(null);
      requestAnimationFrame(() => {
        programmaticRowScrollRef.current = false;
        if (!selected) alignActivePaper();
      });
      return;
    }
    const deltaY = event.clientY - drag.y;
    const viewportHeight = rootRef.current?.clientHeight ?? window.innerHeight;
    const settledPreview = paperClusterPreview(drag.start, deltaY, viewportHeight, panelExtent);
    const destination = paperClusterDestination(drag.start, deltaY, viewportHeight, panelExtent);
    if (destination === null) setPreview(null);
    else {
      const extent =
        settledPreview.progress * (drag.start === 'focused' ? DEFAULT_PANEL_EXTENT : panelExtent);
      commitReveal(destination, extent);
    }
  };

  return (
    <main
      ref={rootRef}
      className="m-workspace"
      data-debug-id="mobile-workspace"
      data-reveal={visualReveal}
      data-preview={preview || panelResizing ? 'true' : 'false'}
      data-full-panel={fullPanel ?? 'none'}
      data-paper-switch={quickSwitch ? 'true' : 'false'}
      data-editor-active={editorActive ? 'true' : 'false'}
      data-paper-rail={activeRail ?? 'none'}
      style={{ '--m-panel-extent': visibleExtent } as React.CSSProperties}
    >
      <MobileWorkspacePanels
        projectId={projectId}
        target={active?.target ?? null}
        panelExtent={panelExtent}
        onPanelExtentChange={setExtentFromHandle}
        onPanelExtentCommit={commitExtentFromHandle}
        onOpenDashboard={() => {
          onOpenPaper({ entityType: 'dashboard', id: 'self' });
          commitReveal('focused');
        }}
        onPreviewTarget={setPreviewTarget}
      />

      <div className="m-paper-deck">
        {session.papers.length > 0 ? (
          <div
            ref={paperRowRef}
            className="m-paper-row"
            data-debug-id="mobile-paper-row"
            onScroll={() => {
              if (programmaticRowScrollRef.current) return;
              if (clusterDragRef.current?.axis === 'horizontal') return;
              if (rowScrollTimerRef.current) clearTimeout(rowScrollTimerRef.current);
              rowScrollTimerRef.current = setTimeout(activateNearestPaper, 100);
            }}
          >
            {session.papers.map((paper) => {
              const isActive = paper.key === session.activeKey && quickSwitch === null;
              const isVisuallyActive = paper.key === visualActiveKey;
              return (
                <section
                  key={paper.key}
                  className="m-paper-row__page"
                  data-paper-key={paper.key}
                  data-active={isVisuallyActive ? 'true' : 'false'}
                  aria-current={isVisuallyActive ? 'page' : undefined}
                >
                  <div className="m-paper-row__paper">
                    {isActive ? (
                      <div className="m-paper-deck__content">
                        <MobilePaperViewport
                          paper={paper}
                          outlineRailVisible={activeRail === 'toc'}
                          onRememberScroll={onRememberScroll}
                        />
                      </div>
                    ) : (
                      <MobilePaperSnapshot
                        projectId={projectId}
                        paper={paper}
                        frozenContentJson={
                          quickSwitch?.frozenPaperKey === paper.key
                            ? quickSwitch.frozenContentJson
                            : frozenProseByKey[paper.key]
                        }
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

      {session.papers.length > 0 && fullPanel === null && (
        <button
          type="button"
          className="m-paper-cluster"
          data-debug-id="mobile-paper-cluster"
          data-armed={clusterArmed ? 'true' : 'false'}
          data-axis={clusterAxis ?? 'none'}
          aria-label={t('mobileWorkspace.paperCluster', { defaultValue: '纸张控制与总览' })}
          onPointerDown={(event) => {
            event.stopPropagation();
            const button = event.currentTarget;
            const pointerArmsImmediately = event.pointerType === 'mouse';
            const gesture: ClusterGestureState = {
              x: event.clientX,
              y: event.clientY,
              start: reveal,
              originIndex: Math.max(
                0,
                session.papers.findIndex((paper) => paper.key === session.activeKey),
              ),
              pointerId: event.pointerId,
              timer: null,
              armed: pointerArmsImmediately,
              moved: false,
              cancelled: false,
              axis: null,
              previewKey: session.activeKey,
              frozenContentJson: undefined,
            };
            clusterDragRef.current = gesture;
            if (pointerArmsImmediately) {
              button.setPointerCapture?.(gesture.pointerId);
              setClusterArmed(true);
            } else {
              gesture.timer = setTimeout(() => {
                if (clusterDragRef.current !== gesture || gesture.cancelled) return;
                gesture.armed = true;
                button.setPointerCapture?.(gesture.pointerId);
                setClusterArmed(true);
              }, CLUSTER_ARM_DELAY_MS);
            }
          }}
          onPointerMove={clusterMove}
          onPointerUp={clusterUp}
          onPointerCancel={() => {
            if (clusterDragRef.current?.timer) clearTimeout(clusterDragRef.current.timer);
            clusterDragRef.current = null;
            setClusterArmed(false);
            setClusterAxis(null);
            setPreview(null);
            setQuickSwitch(null);
            alignActivePaper();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {session.papers.map((paper) => (
            <span key={paper.key} data-active={paper.key === visualActiveKey ? 'true' : 'false'} />
          ))}
        </button>
      )}

      {previewTarget && (
        <MobileEntityPreviewSheet
          target={previewTarget}
          paperOpen={session.papers.some(
            (paper) =>
              paper.target.entityType === previewTarget.entityType &&
              paper.target.id === previewTarget.id,
          )}
          onClose={() => setPreviewTarget(null)}
          onInsert={() => {
            onOpenPaper(previewTarget);
            setPreviewTarget(null);
            commitReveal('focused');
          }}
        />
      )}

      {active && visualReveal === 'focused' && fullPanel === null && !quickSwitch && (
        <MobilePaperRailMenu
          key={active.key}
          target={active.target}
          activeRail={activeRail}
          onActiveRailChange={setActivePaperRail}
        />
      )}

      <MobileEditorAccessory onEditingStateChange={setEditorActive} />
    </main>
  );
}
