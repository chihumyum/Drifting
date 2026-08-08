import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Layers3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { adjacentPaper } from './mobile-workspace-session';
import { MobilePaperContent, useMobilePaperPresentation } from './MobilePaperContent';
import { MobileWorkspacePanels } from './MobileWorkspacePanels';
import { paperClusterDestination, paperClusterPreview } from './paper-cluster-gesture';
import { usePaperPinch, type PaperReveal } from './usePaperPinch';

interface PreviewState {
  target: Exclude<PaperReveal, 'focused'>;
  progress: number;
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

export function MobilePaperDeck({
  projectId,
  session,
  onActivate,
  onOpenOverview,
}: {
  projectId: string;
  session: MobileWorkspaceSessionState;
  onActivate: (paper: MobilePaper) => void;
  onOpenOverview: () => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLElement | null>(null);
  const clusterDragRef = useRef<{ y: number; start: PaperReveal } | null>(null);
  const paperSwipeRef = useRef<{ x: number; y: number } | null>(null);
  const [reveal, setReveal] = useState<PaperReveal>('focused');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [fullPanel, setFullPanel] = useState<Exclude<PaperReveal, 'focused'> | null>(null);

  const active = session.papers.find((paper) => paper.key === session.activeKey) ?? null;
  const previous = adjacentPaper(session, -1);
  const next = adjacentPaper(session, 1);
  const visualReveal = preview?.target ?? reveal;
  const progress = preview?.progress ?? (reveal === 'focused' ? 0 : 1);

  const commitReveal = useCallback((nextReveal: PaperReveal) => {
    setPreview(null);
    setFullPanel(null);
    setReveal(nextReveal);
  }, []);

  usePaperPinch(rootRef, {
    enabled: fullPanel === null,
    reveal,
    onPreview: (target, nextProgress) => setPreview({ target, progress: nextProgress }),
    onCommit: commitReveal,
  });

  const clusterMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = clusterDragRef.current;
    if (!drag) return;
    const dy = event.clientY - drag.y;
    setPreview(paperClusterPreview(drag.start, dy));
  };

  const clusterUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = clusterDragRef.current;
    if (!drag) return;
    clusterDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const destination = paperClusterDestination(drag.start, event.clientY - drag.y);
    if (destination === null) {
      setPreview(null);
      onOpenOverview();
      return;
    }
    commitReveal(destination);
  };

  const paperSwipeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = paperSwipeRef.current;
    paperSwipeRef.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy)) {
      const target = dx < 0 ? next : previous;
      if (target) onActivate(target);
      return;
    }
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) commitReveal('focused');
  };

  return (
    <main
      ref={rootRef}
      className="m-workspace"
      data-reveal={visualReveal}
      data-preview={preview ? 'true' : 'false'}
      data-full-panel={fullPanel ?? 'none'}
      style={{ '--m-paper-progress': progress } as React.CSSProperties}
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
      />

      <div className="m-paper-deck">
        {previous && <AdjacentPaperPreview paper={previous} side="left" />}
        {next && <AdjacentPaperPreview paper={next} side="right" />}

        <section
          className="m-paper-deck__paper"
          aria-label={active ? undefined : t('editorMainArea.emptyHint')}
        >
          {active ? (
            <div className="m-paper-deck__content">
              <MobilePaperContent target={active.target} />
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
          {visualReveal !== 'focused' && (
            <div
              className="m-paper-deck__gesture-layer"
              onPointerDown={(event) => {
                paperSwipeRef.current = { x: event.clientX, y: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerUp={paperSwipeUp}
              onPointerCancel={() => {
                paperSwipeRef.current = null;
              }}
            />
          )}
        </section>
      </div>

      {session.papers.length > 0 && (
        <button
          type="button"
          className="m-paper-cluster"
          aria-label={t('mobileWorkspace.paperCluster', { defaultValue: '纸张控制与总览' })}
          onPointerDown={(event) => {
            event.stopPropagation();
            clusterDragRef.current = { y: event.clientY, start: reveal };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={clusterMove}
          onPointerUp={clusterUp}
          onPointerCancel={() => {
            clusterDragRef.current = null;
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
    </main>
  );
}
