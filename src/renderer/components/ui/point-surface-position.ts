interface PointSurfacePositionOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportPadding: number;
}

export interface PointSurfacePosition {
  left: number;
  top: number;
}

export function computePointSurfacePosition({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  viewportPadding,
}: PointSurfacePositionOptions): PointSurfacePosition {
  const maxLeft = Math.max(viewportPadding, viewportWidth - width - viewportPadding);
  const maxTop = Math.max(viewportPadding, viewportHeight - height - viewportPadding);
  return {
    left: Math.min(Math.max(x, viewportPadding), maxLeft),
    top: Math.min(Math.max(y, viewportPadding), maxTop),
  };
}
