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
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { MobilePaperContent, useMobilePaperPresentation } from './MobilePaperContent';
import { MobileEntityPreviewSheet } from './MobileEntityPreviewSheet';
import { MobileWorkspacePanels } from './MobileWorkspacePanels';
import { paperClusterDestination, paperClusterPreview } from './paper-cluster-gesture';
import { usePaperPinch, type PaperReveal } from './usePaperPinch';

interface PreviewState {
  target: Exclude<PaperReveal, 'focused'>;
  progress: number;
}

interface ClusterGestureState {
  y: number;
  start: PaperReveal;
  pointerId: number;
  timer: ReturnType<typeof setTimeout> | null;
  armed: boolean;
  moved: boolean;
  cancelled: boolean;
}

function MobilePaperPreview({ paper }: { paper: MobilePaper }) {
  const presentation = useMobilePaperPresentation(paper.target);
  return (
    <div className="m-paper-preview" aria-hidden="true">
      <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
      <small>{presentation.kicker}</small>
      <strong>{presentation.title}</strong>
      <p>{presentation.preview}</p>
    </div>
  );
}

function MobilePaperViewport({
  paper,
  onRememberScroll,
}: {
  paper: MobilePaper;
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
      <MobilePaperContent target={paper.target} />
    </div>
  );
}

export function MobilePaperDeck({
  projectId,
  session,
  onActivate,
  onOpenPaper,
  onRememberScroll,
  onOpenOverview,
}: {
  projectId: string;
  session: MobileWorkspaceSessionState;
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

  const active = session.papers.find((paper) => paper.key === session.activeKey) ?? null;
  const visualReveal = preview?.target ?? reveal;
  const visibleExtent = preview
    ? preview.progress * (reveal === 'focused' ? 0.3 : panelExtent)
    : reveal === 'focused'
      ? 0
      : panelExtent;

  useEffect(
    () => () => {
      if (clusterDragRef.current?.timer) clearTimeout(clusterDragRef.current.timer);
      if (rowScrollTimerRef.current) clearTimeout(rowScrollTimerRef.current);
    },
    [],
  );

  const alignActivePaper = useCallback(() => {
    const row = paperRowRef.current;
    if (!row || !session.activeKey) return;
    const page = row.querySelector<HTMLElement>(
      `[data-paper-key="${CSS.escape(session.activeKey)}"]`,
    );
    if (!page) return;
    programmaticRowScrollRef.current = true;
    row.scrollTo({
      left: page.offsetLeft - (row.clientWidth - page.offsetWidth) / 2,
      behavior: 'auto',
    });
    requestAnimationFrame(() => {
      programmaticRowScrollRef.current = false;
    });
  }, [session.activeKey]);

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

  const commitReveal = useCallback((nextReveal: PaperReveal) => {
    setPreview(null);
    setPanelResizing(false);
    setFullPanel(null);
    setReveal(nextReveal);
    setPanelExtent(nextReveal === 'focused' ? 0 : 0.3);
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
    setFullPanel(extent >= 0.5 ? panel : null);
    setPanelExtent(extent >= 0.5 ? 1 : extent);
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
    const dy = event.clientY - drag.y;
    if (!drag.armed) {
      if (Math.abs(dy) > 8) {
        drag.cancelled = true;
        if (drag.timer) clearTimeout(drag.timer);
      }
      return;
    }
    if (Math.abs(dy) > 4) drag.moved = true;
    setPreview(paperClusterPreview(drag.start, dy));
  };

  const clusterUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = clusterDragRef.current;
    if (!drag) return;
    clusterDragRef.current = null;
    if (drag.timer) clearTimeout(drag.timer);
    setClusterArmed(false);
    if (drag.armed) event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!drag.armed) {
      setPreview(null);
      if (!drag.cancelled && Math.abs(event.clientY - drag.y) <= 8) onOpenOverview();
      return;
    }
    if (!drag.moved) {
      setPreview(null);
      return;
    }
    const destination = paperClusterDestination(drag.start, event.clientY - drag.y);
    if (destination === null) setPreview(null);
    else commitReveal(destination);
  };

  return (
    <main
      ref={rootRef}
      className="m-workspace"
      data-reveal={visualReveal}
      data-preview={preview || panelResizing ? 'true' : 'false'}
      data-full-panel={fullPanel ?? 'none'}
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
            onScroll={() => {
              if (programmaticRowScrollRef.current) return;
              if (rowScrollTimerRef.current) clearTimeout(rowScrollTimerRef.current);
              rowScrollTimerRef.current = setTimeout(activateNearestPaper, 100);
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
                  aria-hidden={isActive ? undefined : 'true'}
                >
                  <div className="m-paper-row__paper">
                    {isActive ? (
                      <div className="m-paper-deck__content">
                        <MobilePaperViewport paper={paper} onRememberScroll={onRememberScroll} />
                      </div>
                    ) : (
                      <MobilePaperPreview paper={paper} />
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
          data-armed={clusterArmed ? 'true' : 'false'}
          aria-label={t('mobileWorkspace.paperCluster', { defaultValue: '纸张控制与总览' })}
          onPointerDown={(event) => {
            event.stopPropagation();
            const button = event.currentTarget;
            const gesture: ClusterGestureState = {
              y: event.clientY,
              start: reveal,
              pointerId: event.pointerId,
              timer: null,
              armed: false,
              moved: false,
              cancelled: false,
            };
            gesture.timer = setTimeout(() => {
              if (clusterDragRef.current !== gesture || gesture.cancelled) return;
              gesture.armed = true;
              button.setPointerCapture?.(gesture.pointerId);
              setClusterArmed(true);
            }, 280);
            clusterDragRef.current = gesture;
          }}
          onPointerMove={clusterMove}
          onPointerUp={clusterUp}
          onPointerCancel={() => {
            if (clusterDragRef.current?.timer) clearTimeout(clusterDragRef.current.timer);
            clusterDragRef.current = null;
            setClusterArmed(false);
            setPreview(null);
          }}
        >
          {session.papers.map((paper) => (
            <span
              key={paper.key}
              data-active={paper.key === session.activeKey ? 'true' : 'false'}
            />
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
    </main>
  );
}
