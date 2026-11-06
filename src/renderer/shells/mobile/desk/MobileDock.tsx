import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MobilePaper } from '../workspace/mobile-workspace-session';
import { KindMark } from '../../../components/ui/KindMark';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';
import { useMobilePaperMarks } from './mobile-paper-marks';

/** One open paper further along the dock for every this many px the thumb travels. */
const SCRUB_STEP_PX = 40;
/** A flick up the dock this far lifts the paper's foot onto the Bottom Panel. */
const LIFT_PX = 36;

interface MobileDockProps {
  papers: readonly MobilePaper[];
  activeKey: string | null;
  /** Project Home is in front: no pill is current, and the plus stands selected. */
  homeShown: boolean;
  drawer: 'none' | 'left' | 'right';
  bottomOpen: boolean;
  onActivate: (paper: MobilePaper) => void;
  onClose: (paper: MobilePaper) => void;
  onNew: () => void;
  onToggleDrawer: (side: 'left' | 'right') => void;
  onLift: () => void;
  onLower: () => void;
}

/**
 * The paper's foot, under the thumb (docs/mobile-ui-foundation.md). The two
 * moons open the desk on either side; between them every open paper is its
 * sand mark and the one in front is a glass pill with its name. Sliding the
 * thumb along the marks runs the selection across them like water and turns
 * to the paper under it when the thumb lifts; a tap on a mark turns straight
 * to it. Tapping the pill in front spreads every mark into its pill, each
 * with its own close, as the desktop dock does under the pointer. A flick up
 * lifts the paper onto the Bottom Panel, a flick down lowers it.
 */
export function MobileDock({
  papers,
  activeKey,
  homeShown,
  drawer,
  bottomOpen,
  onActivate,
  onClose,
  onNew,
  onToggleDrawer,
  onLift,
  onLower,
}: MobileDockProps) {
  const { t } = useTranslation();
  const targets = useMemo(() => papers.map((paper) => paper.target), [papers]);
  const marks = useMobilePaperMarks(targets);
  const activeIndex = homeShown ? -1 : papers.findIndex((paper) => paper.key === activeKey);
  const [preview, setPreview] = useState<number | null>(null);
  const [spread, setSpread] = useState(false);
  const gestureRef = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null; start: number; moved: boolean } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const shown = preview ?? activeIndex;

  // A spread dock folds back once the author turns elsewhere.
  useEffect(() => {
    if (!spread) return undefined;
    const fold = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !trackRef.current?.contains(event.target)) setSpread(false);
    };
    window.addEventListener('pointerdown', fold, true);
    return () => window.removeEventListener('pointerdown', fold, true);
  }, [spread]);
  useEffect(() => {
    if (papers.length === 0) setSpread(false);
  }, [papers.length]);

  // Keep the pill in front in view as the selection travels.
  useEffect(() => {
    const track = trackRef.current;
    const pill = track?.querySelector<HTMLElement>('[data-dock-current="true"]');
    if (!track || !pill) return;
    const left = pill.offsetLeft - track.clientWidth / 2 + pill.offsetWidth / 2;
    track.scrollTo({ left, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [shown, spread, papers.length]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (spread) return;
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, start: Math.max(0, activeIndex), moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    gesture.moved = true;
    if (gesture.axis === 'x' && papers.length > 1) {
      const next = Math.min(papers.length - 1, Math.max(0, gesture.start + Math.round(dx / SCRUB_STEP_PX)));
      setPreview(next);
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (gesture.axis === 'y') {
      const dy = event.clientY - gesture.y;
      if (dy < -LIFT_PX) onLift();
      if (dy > LIFT_PX && bottomOpen) onLower();
    }
    if (gesture.axis === 'x' && preview !== null) {
      const paper = papers[preview];
      setPreview(null);
      if (paper && paper.key !== activeKey) onActivate(paper);
    }
  };
  const onPointerCancel = () => {
    gestureRef.current = null;
    setPreview(null);
  };

  const scrubbing = preview !== null;
  return (
    <nav
      className="m-dock"
      data-debug-id="mobile-dock"
      data-spread={spread ? 'true' : undefined}
      data-scrubbing={scrubbing ? 'true' : undefined}
      aria-label={t('mobileDesk.dock.label')}
    >
      <GhostIconButton
        glass="round"
        className="m-dock__moon glass--rest"
        data-debug-id="mobile-open-left-desk"
        aria-pressed={drawer === 'left'}
        aria-label={t('mobileDesk.dock.leftDesk')}
        icon={<BrushIcon name={drawer === 'left' ? 'moon-left' : 'moon-left-hollow'} />}
        onClick={() => onToggleDrawer('left')}
      />
      <div
        ref={trackRef}
        className="m-dock__track glass glass--rest glass--surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div className="m-dock__row" role="tablist">
          {papers.map((paper, index) => {
            const mark = marks[index];
            const current = index === shown;
            const pill = current || spread;
            return (
              <span
                key={paper.key}
                className={`m-dock__item${pill ? ' is-pill' : ''}`}
                data-dock-current={current ? 'true' : undefined}
                style={mark?.color ? ({ '--glass-cc': mark.color } as CSSProperties) : undefined}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={index === activeIndex}
                  className={`m-dock__mark${pill ? ' glass glass--small' : ''}${current ? ' is-on' : ''}`}
                  data-debug-id={`mobile-dock-paper-${index}`}
                  aria-label={mark?.title}
                  onClick={() => {
                    if (gestureRef.current?.moved) return;
                    if (index === activeIndex && !spread) setSpread(true);
                    else onActivate(paper);
                  }}
                >
                  {mark && <KindMark kind={mark.kind} color={mark.color} seed={mark.seed} />}
                  {pill && <span className="m-dock__title">{mark?.title}</span>}
                </button>
                {spread && (
                  <button
                    type="button"
                    className="m-dock__close"
                    aria-label={t('common.close')}
                    onClick={() => onClose(paper)}
                  >
                    <BrushIcon name="close" size={14} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
        <GhostIconButton
          glass="round"
          className="m-dock__new"
          data-debug-id="mobile-dock-new"
          aria-pressed={homeShown}
          aria-label={t('mobileDesk.dock.new')}
          icon={<BrushIcon name="plus" />}
          onClick={onNew}
        />
      </div>
      <GhostIconButton
        glass="round"
        className="m-dock__moon glass--rest"
        data-debug-id="mobile-open-right-desk"
        aria-pressed={drawer === 'right'}
        aria-label={t('mobileDesk.dock.rightDesk')}
        icon={<BrushIcon name={drawer === 'right' ? 'moon-right' : 'moon-right-hollow'} />}
        onClick={() => onToggleDrawer('right')}
      />
    </nav>
  );
}
