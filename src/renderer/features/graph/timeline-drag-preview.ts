export interface TimelineDragSnapshot {
  readonly markerXs: Readonly<Record<string, number>>;
  readonly actX: number | null;
}

interface FrameClock {
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

const EMPTY: TimelineDragSnapshot = Object.freeze({
  markerXs: Object.freeze(Object.create(null) as Record<string, number>), actX: null,
});

/** Per-surface presentation only. The pointer owner commits its exact coordinate. */
export function createTimelineDragPreview(clock: FrameClock = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
}) {
  const listeners = new Set<() => void>();
  const markerXs = new Map<string, number>();
  let actX: number | null = null;
  let snapshot = EMPTY;
  let frame: number | null = null;
  const cancelFrame = () => {
    if (frame !== null) clock.cancelFrame(frame);
    frame = null;
  };
  const publish = () => {
    cancelFrame();
    const previous = snapshot.markerXs;
    if (snapshot.actX === actX && Object.keys(previous).length === markerXs.size &&
      [...markerXs].every(([id, x]) => previous[id] === x)) return;
    snapshot = markerXs.size === 0 && actX === null ? EMPTY : Object.freeze({
      markerXs: Object.freeze(Object.assign(Object.create(null), Object.fromEntries(markerXs))) as Readonly<Record<string, number>>,
      actX,
    });
    for (const listener of [...listeners]) listener();
  };
  const schedule = (ending: boolean) => {
    // End/cancel must clear even when the WebView has suspended animation frames.
    if (ending || listeners.size === 0) { publish(); return; }
    if (frame === null) frame = clock.requestFrame(publish);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cancelFrame(); markerXs.clear(); actX = null; snapshot = EMPTY;
        }
      };
    },
    setMarker(id: string, x: number | null) {
      if (x === null ? !markerXs.has(id) : markerXs.get(id) === x) return;
      if (x === null) markerXs.delete(id); else markerXs.set(id, x);
      schedule(x === null);
    },
    setAct(x: number | null) {
      if (actX === x) return;
      actX = x; schedule(x === null);
    },
  };
}

export type TimelineDragPreview = ReturnType<typeof createTimelineDragPreview>;
