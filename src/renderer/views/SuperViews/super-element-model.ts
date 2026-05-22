import type { BookElement, BookElementCategory } from '../../domain/book-element';
import {
  CELL_H,
  GROUP_HEADER_PX,
  CATEGORY_INNER_PAD_Y_TOP,
  CATEGORY_INNER_PAD_Y_BOTTOM,
} from './super-element-constants';

export interface GroupInternalLayout {
  groupName: string | null;
  items: BookElement[];
  /** Y offset of the group's first card row, in pixels relative to box top. */
  cardRowsTopPx: number;
  /** Number of card rows this group occupies (1 if items.length === 0). */
  cardRows: number;
  /** Y offset of the group's header strip, in pixels. -1 if no header. */
  headerTopPx: number;
}

export interface CategoryRenderModel {
  /** null for fallback (e.g. orphan elements referencing a missing category). */
  category: BookElementCategory | null;
  categoryId: string;
  groups: GroupInternalLayout[];
  widthCells: number;
  heightCells: number;
  /** Exact rendered height of the box in pixels, before snapping to cells. */
  contentHeightPx: number;
  totalElements: number;
}

/**
 * Compute the in-cell layout for one category. No dedicated header row —
 * the category name/count is drawn ON the box's top border via a legend
 * label. Group separators are pixel-sized strips (GROUP_HEADER_PX),
 * inserted BETWEEN groups, so a category with one group has zero group
 * chrome.
 *
 * The box's outer height is snapped UP to the next CELL_H boundary so the
 * skyline solver can keep its integer cell coordinates.
 */
export function buildCategoryRenderModel(
  categoryId: string,
  category: BookElementCategory | null,
  elements: BookElement[],
): CategoryRenderModel {
  // Bucket elements by groupName; null group goes last with no header.
  const buckets = new Map<string | null, BookElement[]>();
  for (const el of elements) {
    const key = el.groupName?.trim() || null;
    const list = buckets.get(key) ?? [];
    list.push(el);
    buckets.set(key, list);
  }
  const named: { groupName: string; items: BookElement[] }[] = [];
  let ungrouped: BookElement[] = [];
  buckets.forEach((items, key) => {
    if (key === null) ungrouped = items;
    else named.push({ groupName: key, items });
  });
  named.sort((a, b) => a.groupName.localeCompare(b.groupName));

  const orderedGroups: { groupName: string | null; items: BookElement[] }[] = [
    ...named,
    ...(ungrouped.length > 0 ? [{ groupName: null, items: ungrouped }] : []),
  ];

  const totalElements = elements.length;

  // Empty category: a single empty placeholder cell, per design decision 13.
  if (totalElements === 0) {
    return {
      category,
      categoryId,
      groups: [],
      widthCells: 2,
      heightCells: 1,
      contentHeightPx: CELL_H,
      totalElements: 0,
    };
  }

  // Width formula picks the tightest grid that's still wider than tall, so
  // cards dominate the box. Multi-group categories enforce a min of 2 so
  // group headers have room to read; single-group categories can go down
  // to 1 cell wide.
  const minWidth = orderedGroups.length > 1 ? 2 : 1;
  const widthCells = Math.max(minWidth, Math.min(6, Math.ceil(Math.sqrt(totalElements))));
  // Show group dividers only when there's something to disambiguate from.
  const showGroupHeaders = orderedGroups.length > 1;

  // Internal layout pass — pixels, top-down.
  let cursorPx = CATEGORY_INNER_PAD_Y_TOP;
  const groups: GroupInternalLayout[] = [];
  orderedGroups.forEach((g, idx) => {
    let headerTopPx = -1;
    if (showGroupHeaders && g.groupName !== null) {
      headerTopPx = cursorPx;
      cursorPx += GROUP_HEADER_PX;
    } else if (showGroupHeaders && idx > 0) {
      // Anonymous "ungrouped" bucket after named groups still needs a
      // visual divide — a small breathing strip with no label.
      cursorPx += 6;
    }
    const cardRows = Math.max(1, Math.ceil(g.items.length / widthCells));
    const cardRowsTopPx = cursorPx;
    cursorPx += cardRows * CELL_H;
    groups.push({
      groupName: g.groupName,
      items: g.items,
      cardRowsTopPx,
      cardRows,
      headerTopPx,
    });
  });

  const contentHeightPx = cursorPx + CATEGORY_INNER_PAD_Y_BOTTOM;
  const heightCells = Math.max(1, Math.ceil(contentHeightPx / CELL_H));

  return {
    category,
    categoryId,
    groups,
    widthCells,
    heightCells,
    contentHeightPx,
    totalElements,
  };
}
