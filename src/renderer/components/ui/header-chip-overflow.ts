const FIT_TOLERANCE_PX = 1;

export function countFittingHeaderChips(
  itemWidths: readonly number[],
  availableWidth: number,
  gap: number,
): number {
  let occupiedWidth = 0;

  for (let index = 0; index < itemWidths.length; index += 1) {
    occupiedWidth += itemWidths[index] + (index === 0 ? 0 : gap);
    if (occupiedWidth > availableWidth + FIT_TOLERANCE_PX) return index;
  }

  return itemWidths.length;
}
