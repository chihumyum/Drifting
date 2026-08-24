export interface MobilePanelGestureCommit {
  extent: number;
  openingVelocityVhPerSecond: number;
  travel: number;
}

export type MobilePanelGestureResolution =
  | { state: 'closed'; extent: 0 }
  | { state: 'docked'; extent: number }
  | { state: 'full'; extent: 1 };

const CLOSE_EDGE = 0.04;
const FULL_EDGE = 0.985;
const FLING_TRAVEL = 0.12;
const FLING_VELOCITY = 1.2;

export function resolveMobilePanelGesture(
  gesture: MobilePanelGestureCommit,
): MobilePanelGestureResolution {
  const extent = Math.max(0, Math.min(1, gesture.extent));
  const travel = Math.max(0, gesture.travel);

  if (extent >= FULL_EDGE) return { state: 'full', extent: 1 };
  if (
    travel >= FLING_TRAVEL &&
    gesture.openingVelocityVhPerSecond >= FLING_VELOCITY
  ) {
    return { state: 'full', extent: 1 };
  }
  if (extent <= CLOSE_EDGE) return { state: 'closed', extent: 0 };
  if (
    travel >= FLING_TRAVEL &&
    gesture.openingVelocityVhPerSecond <= -FLING_VELOCITY
  ) {
    return { state: 'closed', extent: 0 };
  }
  return { state: 'docked', extent };
}
