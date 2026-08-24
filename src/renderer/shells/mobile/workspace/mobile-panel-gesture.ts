export interface MobilePanelGestureCommit {
  extent: number;
  openingVelocityVhPerSecond: number;
  travel: number;
  viewportHeightPx: number;
}

export type MobilePanelGestureResolution =
  | { state: 'closed'; extent: 0 }
  | { state: 'docked'; extent: number }
  | { state: 'full'; extent: 1 };

const CLOSE_SNAP_PX = 72;
const FULL_EDGE = 0.985;
const FLING_TRAVEL = 0.12;
const FLING_VELOCITY = 1.2;

export function resolveMobilePanelGesture(
  gesture: MobilePanelGestureCommit,
): MobilePanelGestureResolution {
  const extent = Math.max(0, Math.min(1, gesture.extent));
  const travel = Math.max(0, gesture.travel);
  const closeEdge = Math.min(
    0.18,
    CLOSE_SNAP_PX / Math.max(1, gesture.viewportHeightPx),
  );

  if (extent >= FULL_EDGE) return { state: 'full', extent: 1 };
  if (
    travel >= FLING_TRAVEL &&
    gesture.openingVelocityVhPerSecond >= FLING_VELOCITY
  ) {
    return { state: 'full', extent: 1 };
  }
  if (extent <= closeEdge) return { state: 'closed', extent: 0 };
  if (
    travel >= FLING_TRAVEL &&
    gesture.openingVelocityVhPerSecond <= -FLING_VELOCITY
  ) {
    return { state: 'closed', extent: 0 };
  }
  return { state: 'docked', extent };
}
