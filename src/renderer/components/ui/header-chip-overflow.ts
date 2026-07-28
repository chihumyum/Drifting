const FIT_TOLERANCE_PX = 1;

export function countFittingHeaderChips(
  itemRightEdges: readonly number[],
  availableWidth: number,
): number {
  const lastFittingIndex = itemRightEdges.findIndex(
    (rightEdge) => rightEdge > availableWidth + FIT_TOLERANCE_PX,
  );
  return lastFittingIndex === -1 ? itemRightEdges.length : lastFittingIndex;
}
