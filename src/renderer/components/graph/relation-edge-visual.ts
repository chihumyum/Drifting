export interface RelationEdgePathInput {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  directed: boolean;
  targetInsetX?: number;
  targetInsetY?: number;
}

/**
 * Preserve the existing vertical S-curve for symmetric/legacy relations.
 * Directed relations stop at the target card boundary so their arrowhead is
 * visible instead of being buried beneath the card centre.
 */
export function relationEdgePath({
  x1,
  y1,
  x2,
  y2,
  directed,
  targetInsetX = 0,
  targetInsetY = 0,
}: RelationEdgePathInput): string {
  if (!directed) {
    const midY = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
  }

  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const endX = x2 - Math.sign(dx || 1) * targetInsetX;
    const midX = (x1 + endX) / 2;
    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${endX} ${y2}`;
  }

  const endY = y2 - Math.sign(dy || 1) * targetInsetY;
  const midY = (y1 + endY) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${endY}`;
}

export function relationArrowMarkerId(scope: string, relationId: string): string {
  return `${scope}-${relationId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}
