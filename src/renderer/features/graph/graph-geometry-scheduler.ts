export interface GraphGeometryClock {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

/** Coalesce event bursts and the bounded entry animation into one frame job. */
export function createGraphGeometryScheduler(
  measure: () => void,
  animationWindowMs: number,
  clock: GraphGeometryClock = {
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
  },
) {
  const deadline = clock.now() + animationWindowMs;
  let frame: number | null = null;
  let disposed = false;
  const invalidate = () => {
    if (disposed || frame !== null) return;
    frame = clock.requestFrame(() => {
      frame = null;
      if (disposed) return;
      measure();
      if (clock.now() < deadline) invalidate();
    });
  };
  invalidate();
  return {
    invalidate,
    dispose() {
      disposed = true;
      if (frame !== null) clock.cancelFrame(frame);
      frame = null;
    },
  };
}
