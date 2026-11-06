import { useCallback, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { MobileDeskAction, MobileDrawer } from './mobile-desk-controller';

/** How much of the pushed-aside paper stays on screen, px: enough to tap or pull it back. */
export const DESK_SLIVER_PX = 52;
/** Only a pan that starts this close to an edge moves the paper while the author writes. */
const WRITING_EDGE_PX = 22;
/** A pan must declare itself this soon: a finger held first is selecting text. */
const DECIDE_WITHIN_MS = 450;
const DECIDE_PX = 10;
/** A release this fast (px/ms) carries the paper the way it was going. */
const FLICK = 0.32;

interface Pan {
  id: number;
  x: number;
  y: number;
  t: number;
  /** Where the paper rested when the finger came down, px (+ shows the left desk). */
  base: number;
  decided: 'pan' | 'no' | null;
  lastX: number;
  lastT: number;
  velocity: number;
  offset: number;
}

export function settleDrawer(base: number, offset: number, velocity: number, width: number): MobileDrawer {
  if (base > 0) return offset < width * 0.7 || velocity < -FLICK ? 'none' : 'left';
  if (base < 0) return offset > -width * 0.7 || velocity > FLICK ? 'none' : 'right';
  if (offset > width * 0.3 || velocity > FLICK) return offset > 0 ? 'left' : 'none';
  if (offset < -width * 0.3 || velocity < -FLICK) return offset < 0 ? 'right' : 'none';
  return 'none';
}

/**
 * The paper is pushed aside by hand (docs/design-system/touch.md): a sideways
 * pan on the paper carries it with the finger, a little behind, and the desk
 * on that side shows beneath; on release it settles where it was going, by
 * distance or by the flick. The desk itself, or the sliver of paper left on
 * screen, pulls it back. While the author writes only a pan from the very
 * edge moves the paper, so dragging across the prose stays the system's.
 */
export function useDeskPan({ deskRef, paperRef, drawer, writing, dispatch }: {
  deskRef: RefObject<HTMLElement | null>;
  paperRef: RefObject<HTMLElement | null>;
  drawer: MobileDrawer;
  writing: boolean;
  dispatch: Dispatch<MobileDeskAction>;
}) {
  const panRef = useRef<Pan | null>(null);
  const [panning, setPanning] = useState(false);
  const [side, setSide] = useState<'left' | 'right'>('left');

  const width = () => Math.max(120, (deskRef.current?.clientWidth ?? window.innerWidth) - DESK_SLIVER_PX);
  const restingOffset = useCallback(
    () => (drawer === 'left' ? width() : drawer === 'right' ? -width() : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- width reads the live desk
    [drawer],
  );

  const write = (offset: number, velocity: number) => {
    const desk = deskRef.current;
    const paper = paperRef.current;
    if (!desk || !paper) return;
    desk.style.setProperty('--m-paper-x', `${offset}px`);
    paper.style.setProperty('--flow', String(Math.abs(offset)));
    paper.style.setProperty('--flowa', String(Math.min(1, Math.abs(velocity) * 1.6)));
  };
  const release = () => {
    deskRef.current?.style.removeProperty('--m-paper-x');
    paperRef.current?.style.setProperty('--flowa', '0');
  };

  const start = (event: ReactPointerEvent, fromDesk: boolean) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.m-dock, .m-fore-edge, .m-kbar, .hover-card-surface, [data-desk-pan="off"]')) return;
    if (!fromDesk && writing && drawer === 'none') {
      const w = deskRef.current?.clientWidth ?? window.innerWidth;
      if (event.clientX > WRITING_EDGE_PX && event.clientX < w - WRITING_EDGE_PX) return;
    }
    if (fromDesk && drawer === 'none') return;
    const now = performance.now();
    panRef.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY, t: now,
      base: restingOffset(), decided: null, lastX: event.clientX, lastT: now, velocity: 0, offset: restingOffset(),
    };
  };

  const move = (event: ReactPointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.id !== event.pointerId || pan.decided === 'no') return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.decided) {
      if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
      const late = performance.now() - pan.t > DECIDE_WITHIN_MS;
      if (late || Math.abs(dx) < Math.abs(dy) * 1.2) {
        pan.decided = 'no';
        return;
      }
      // From rest the pan opens the side it moves toward; an open desk only closes.
      if (pan.base > 0 && dx > 0) { pan.decided = 'no'; return; }
      if (pan.base < 0 && dx < 0) { pan.decided = 'no'; return; }
      pan.decided = 'pan';
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      setPanning(true);
      setSide(pan.base > 0 || (pan.base === 0 && dx > 0) ? 'left' : 'right');
    }
    const w = width();
    const raw = pan.base + dx;
    // Past a desk's width the paper only gives a little, like a held weight.
    const offset = raw > w ? w + (raw - w) * 0.18 : raw < -w ? -w + (raw + w) * 0.18 : raw;
    const now = performance.now();
    const dt = Math.max(1, now - pan.lastT);
    pan.velocity = pan.velocity * 0.6 + ((event.clientX - pan.lastX) / dt) * 0.4;
    pan.lastX = event.clientX;
    pan.lastT = now;
    pan.offset = offset;
    if (pan.base === 0) setSide(offset >= 0 ? 'left' : 'right');
    write(offset, pan.velocity);
  };

  const end = (event: ReactPointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.id !== event.pointerId) return;
    panRef.current = null;
    if (pan.decided !== 'pan') return;
    const next = settleDrawer(pan.base, pan.offset, pan.velocity, width());
    release();
    setPanning(false);
    if (next === 'none') dispatch({ type: 'close-drawer' });
    else dispatch({ type: 'open-drawer', side: next });
  };

  const cancel = () => {
    if (panRef.current?.decided === 'pan') {
      release();
      setPanning(false);
    }
    panRef.current = null;
  };

  return {
    panning,
    side,
    paperHandlers: {
      onPointerDown: (event: ReactPointerEvent) => start(event, false),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: cancel,
    },
    drawerHandlers: {
      onPointerDown: (event: ReactPointerEvent) => start(event, true),
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: cancel,
    },
  };
}
