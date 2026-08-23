export interface SuperViewPoint {
  x: number;
  y: number;
}

export interface SuperViewPinchOrigin {
  startDistance: number;
  startZoom: number;
  world: SuperViewPoint;
}

function midpoint(a: SuperViewPoint, b: SuperViewPoint): SuperViewPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function beginSuperViewPinch(input: {
  points: readonly [SuperViewPoint, SuperViewPoint];
  viewportOrigin: SuperViewPoint;
  pan: SuperViewPoint;
  zoom: number;
}): SuperViewPinchOrigin {
  const [a, b] = input.points;
  const localMidpoint = midpoint(a, b);
  localMidpoint.x -= input.viewportOrigin.x;
  localMidpoint.y -= input.viewportOrigin.y;
  const zoom = Math.max(Number.EPSILON, input.zoom);
  return {
    startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    startZoom: zoom,
    world: {
      x: (localMidpoint.x - input.pan.x) / zoom,
      y: (localMidpoint.y - input.pan.y) / zoom,
    },
  };
}
/** Keeps the same authored world point beneath the moving two-finger midpoint. */
export function updateSuperViewPinch(input: {
  origin: SuperViewPinchOrigin;
  points: readonly [SuperViewPoint, SuperViewPoint];
  viewportOrigin: SuperViewPoint;
  minZoom: number;
  maxZoom: number;
}): { pan: SuperViewPoint; zoom: number } {
  const [a, b] = input.points;
  const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  const zoom = Math.max(
    input.minZoom,
    Math.min(input.maxZoom, input.origin.startZoom * (distance / input.origin.startDistance)),
  );
  const localMidpoint = midpoint(a, b);
  localMidpoint.x -= input.viewportOrigin.x;
  localMidpoint.y -= input.viewportOrigin.y;
  return {
    zoom,
    pan: {
      x: localMidpoint.x - input.origin.world.x * zoom,
      y: localMidpoint.y - input.origin.world.y * zoom,
    },
  };
}
