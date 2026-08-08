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
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { adjacentPaper } from './mobile-workspace-session';
import { MobilePaperContent, useMobilePaperPresentation } from './MobilePaperContent';
import { MobileEntityPreviewSheet } from './MobileEntityPreviewSheet';
import { MobileWorkspacePanels } from './MobileWorkspacePanels';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { paperClusterDestination, paperClusterPreview } from './paper-cluster-gesture';
import { usePaperPinch, type PaperReveal } from './usePaperPinch';

interface PreviewState {
  target: Exclude<PaperReveal, 'focused'>;
  progress: number;
}

interface PaperSlideState {
  target: MobilePaper;
  direction: -1 | 1;
  phase: 'exit' | 'entry' | 'settle';
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

function AdjacentPaperPreview({ paper, side }: { paper: MobilePaper; side: 'left' | 'right' }) {
  const presentation = useMobilePaperPresentation(paper.target);
  return (
    <div className={`m-paper-preview m-paper-preview--${side}`} aria-hidden="true">
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
  const clusterDragRef = useRef<ClusterGestureState | null>(null);
  const paperSwipeRef = useRef<{ x: number; y: number } | null>(null);
  const slideFrameRef = useRef<number | null>(null);
  const [reveal, setReveal] = useState<PaperReveal>('focused');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [fullPanel, setFullPanel] = useState<Exclude<PaperReveal, 'focused'> | null>(null);
  const [previewTarget, setPreviewTarget] = useState<WorkspaceTarget | null>(null);
  const [clusterArmed, setClusterArmed] = useState(false);
  const [slide, setSlide] = useState<PaperSlideState | null>(null);

  const active = session.papers.find((paper) => paper.key === session.activeKey) ?? null;
  const previous = adjacentPaper(session, -1);
  const next = adjacentPaper(session, 1);
  const visualReveal = preview?.target ?? reveal;
  const progress = preview?.progress ?? (reveal === 'focused' ? 0 : 1);

  useEffect(
    () => () => {
      if (clusterDragRef.current?.timer) clearTimeout(clusterDragRef.current.timer);
      if (slideFrameRef.current !== null) cancelAnimationFrame(slideFrameRef.current);
    },
    [],
  );

  const commitReveal = useCallback((nextReveal: PaperReveal) => {
    setPreview(null);
    setFullPanel(null);
    setReveal(nextReveal);
  }, []);

  usePaperPinch(rootRef, {
    enabled: fullPanel === null && previewTarget === null && slide === null,
    reveal,
    onPreview: (target, nextProgress) => setPreview({ target, progress: nextProgress }),
    onCommit: commitReveal,
  });

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

  const beginPaperSlide = useCallback((target: MobilePaper, direction: -1 | 1) => {
    setSlide((current) => current ?? { target, direction, phase: 'exit' });
  }, []);

  const paperSwipeUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = paperSwipeRef.current;
    paperSwipeRef.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy)) {
      const target = dx < 0 ? next : previous;
      if (target) beginPaperSlide(target, dx < 0 ? 1 : -1);
    }
  };

  const slideX = slide
    ? slide.phase === 'exit'
      ? `${slide.direction * -110}dvw`
      : slide.phase === 'entry'
        ? `${slide.direction * 110}dvw`
        : '0dvw'
    : '0dvw';

  return (
    <main
      ref={rootRef}
      className="m-workspace"
      data-reveal={visualReveal}
      data-preview={preview ? 'true' : 'false'}
      data-full-panel={fullPanel ?? 'none'}
      data-paper-slide={slide?.phase ?? 'none'}
      style={
        {
          '--m-paper-progress': progress,
          '--m-paper-slide-x': slideX,
        } as React.CSSProperties
      }
    >
      <MobileWorkspacePanels
        projectId={projectId}
        target={active?.target ?? null}
        fullPanel={fullPanel}
        onFullPanelChange={(panel, full) => {
          setPreview(null);
          setReveal(panel);
          setFullPanel(full ? panel : null);
        }}
        onClosePanel={() => commitReveal('focused')}
        onPreviewTarget={setPreviewTarget}
      />

      <div className="m-paper-deck">
        {previous && <AdjacentPaperPreview paper={previous} side="left" />}
        {next && <AdjacentPaperPreview paper={next} side="right" />}

        <section
          className="m-paper-deck__paper"
          aria-label={active ? undefined : t('editorMainArea.emptyHint')}
          onPointerDown={(event) => {
            if (visualReveal === 'focused' || slide) return;
            paperSwipeRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={paperSwipeUp}
          onPointerCancel={() => {
            paperSwipeRef.current = null;
          }}
          onTransitionEnd={(event) => {
            if (
              event.target !== event.currentTarget ||
              event.propertyName !== 'transform' ||
              !slide
            ) {
              return;
            }
            if (slide.phase === 'exit') {
              onActivate(slide.target);
              setSlide({ ...slide, phase: 'entry' });
              slideFrameRef.current = requestAnimationFrame(() => {
                slideFrameRef.current = requestAnimationFrame(() => {
                  setSlide((current) =>
                    current?.phase === 'entry' ? { ...current, phase: 'settle' } : current,
                  );
                });
              });
            } else if (slide.phase === 'settle') {
              setSlide(null);
            }
          }}
        >
          {active ? (
            <div className="m-paper-deck__content">
              <MobilePaperViewport
                key={active.key}
                paper={active}
                onRememberScroll={onRememberScroll}
              />
            </div>
          ) : (
            <div className="m-paper-empty">
              <Layers3 size={24} aria-hidden="true" />
              <strong>{t('mobileWorkspace.noPapers', { defaultValue: '没有打开的纸张' })}</strong>
              <button type="button" onClick={onOpenOverview}>
                {t('mobileWorkspace.openOverview', { defaultValue: '打开纸张总览' })}
              </button>
            </div>
          )}
        </section>
      </div>

      {session.papers.length > 0 && (
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
