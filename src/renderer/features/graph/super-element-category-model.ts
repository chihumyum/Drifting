import type { BookElement, BookElementCategory } from '../../domain/book-element';

export interface SuperElementGroupLayout {
  groupName: string | null;
  items: BookElement[];
  cardRowsTopPx: number;
  cardRows: number;
  headerTopPx: number;
}

export interface SuperElementCategoryModel {
  category: BookElementCategory | null;
  categoryId: string;
  groups: SuperElementGroupLayout[];
  widthCells: number;
  heightCells: number;
  contentHeightPx: number;
  totalElements: number;
}

interface SuperElementCategoryMetrics {
  cellHeight: number;
  groupHeaderHeight: number;
  paddingTop: number;
  paddingBottom: number;
}

export function buildSuperElementCategoryModel(
  categoryId: string,
  category: BookElementCategory | null,
  elements: BookElement[],
  metrics: SuperElementCategoryMetrics,
): SuperElementCategoryModel {
  const buckets = new Map<string | null, BookElement[]>();
  for (const element of elements) {
    const key = element.groupName?.trim() || null;
    const list = buckets.get(key) ?? [];
    list.push(element);
    buckets.set(key, list);
  }
  const named: { groupName: string; items: BookElement[] }[] = [];
  let ungrouped: BookElement[] = [];
  buckets.forEach((items, key) => {
    if (key === null) ungrouped = items;
    else named.push({ groupName: key, items });
  });
  named.sort((left, right) => left.groupName.localeCompare(right.groupName));
  const orderedGroups = [
    ...named,
    ...(ungrouped.length > 0 ? [{ groupName: null, items: ungrouped }] : []),
  ];

  if (elements.length === 0) {
    return {
      category,
      categoryId,
      groups: [],
      widthCells: 2,
      heightCells: 1,
      contentHeightPx: metrics.cellHeight,
      totalElements: 0,
    };
  }

  const minimumWidth = orderedGroups.length > 1 ? 2 : 1;
  const widthCells = Math.max(minimumWidth, Math.min(6, Math.ceil(Math.sqrt(elements.length))));
  const showGroupHeaders = orderedGroups.length > 1;
  let cursor = metrics.paddingTop;
  const groups: SuperElementGroupLayout[] = [];
  orderedGroups.forEach((group, index) => {
    let headerTopPx = -1;
    if (showGroupHeaders && group.groupName !== null) {
      headerTopPx = cursor;
      cursor += metrics.groupHeaderHeight;
    } else if (showGroupHeaders && index > 0) {
      cursor += 6;
    }
    const cardRows = Math.max(1, Math.ceil(group.items.length / widthCells));
    const cardRowsTopPx = cursor;
    cursor += cardRows * metrics.cellHeight;
    groups.push({
      groupName: group.groupName,
      items: group.items,
      cardRowsTopPx,
      cardRows,
      headerTopPx,
    });
  });
  const contentHeightPx = cursor + metrics.paddingBottom;
  return {
    category,
    categoryId,
    groups,
    widthCells,
    heightCells: Math.max(1, Math.ceil(contentHeightPx / metrics.cellHeight)),
    contentHeightPx,
    totalElements: elements.length,
  };
}
