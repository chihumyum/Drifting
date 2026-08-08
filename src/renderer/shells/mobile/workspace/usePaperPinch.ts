import { useEffect, useRef, type RefObject } from 'react';

export type PaperReveal = 'focused' | 'top' | 'bottom';

interface Point {
  x: number;
  y: number;
}

interface PinchGesture {
  startDistance: number;
  target: Exclude<PaperReveal, 'focused'>;
  startedFromReveal: boolean;
  progress: number;
}

interface PaperPinchOptions {
  enabled?: boolean;
  reveal: PaperReveal;
  onPreview: (target: Exclude<PaperReveal, 'focused'>, progress: number) => void;
  onCommit: (next: PaperReveal) => void;
}

export function paperRevealForMidpoint(midpointY: number, height: number): 'top' | 'bottom' | null {
  if (height <= 0) return null;
  const fraction = midpointY / height;
  if (fraction < 0.45) return 'bottom';
  if (fraction > 0.55) return 'top';
  return null;
}

export function pinchProgress(
  startDistance: number,
  currentDistance: number,
  startedFromReveal: boolean,
): number {
  if (startDistance <= 0) return startedFromReveal ? 1 : 0;
  const delta = (startDistance - currentDistance) / (startDistance * 0.3);
  const raw = startedFromReveal ? 1 + delta : delta;
  return Math.max(0, Math.min(1, raw));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function usePaperPinch(
  ref: RefObject<HTMLElement | null>,
  { enabled = true, reveal, onPreview, onCommit }: PaperPinchOptions,
) {
  const optionsRef = useRef({ enabled, reveal, onPreview, onCommit });

  useEffect(() => {
    optionsRef.current = { enabled, reveal, onPreview, onCommit };
  }, [enabled, onCommit, onPreview, reveal]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const points = new Map<number, Point>();
    let gesture: PinchGesture | null = null;

    const beginIfReady = () => {
      if (points.size !== 2 || gesture) return;
      const [a, b] = [...points.values()];
      const rect = root.getBoundingClientRect();
      const currentReveal = optionsRef.current.reveal;
      const target =
        currentReveal === 'focused'
          ? paperRevealForMidpoint((a.y + b.y) / 2 - rect.top, rect.height)
          : currentReveal;
      if (!target) return;
      gesture = {
        startDistance: distance(a, b),
        target,
        startedFromReveal: currentReveal !== 'focused',
        progress: currentReveal === 'focused' ? 0 : 1,
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!optionsRef.current.enabled) return;
      if (event.pointerType !== 'touch') return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      beginIfReady();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      beginIfReady();
      if (!gesture || points.size !== 2) return;
      const [a, b] = [...points.values()];
      gesture.progress = pinchProgress(
        gesture.startDistance,
        distance(a, b),
        gesture.startedFromReveal,
      );
      if (Math.abs(gesture.progress - (gesture.startedFromReveal ? 1 : 0)) > 0.035) {
        event.preventDefault();
      }
      optionsRef.current.onPreview(gesture.target, gesture.progress);
    };
    const finish = (event: PointerEvent) => {
      points.delete(event.pointerId);
      if (!gesture || points.size > 1) return;
      const threshold = gesture.startedFromReveal ? 0.62 : 0.38;
      optionsRef.current.onCommit(gesture.progress >= threshold ? gesture.target : 'focused');
      gesture = null;
    };

    root.addEventListener('pointerdown', onPointerDown, { passive: true });
    root.addEventListener('pointermove', onPointerMove, { passive: false });
    root.addEventListener('pointerup', finish, { passive: true });
    root.addEventListener('pointercancel', finish, { passive: true });
    return () => {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', finish);
      root.removeEventListener('pointercancel', finish);
    };
  }, [ref]);
}
