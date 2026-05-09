import type { BookElement, BookElementCategory } from '../../../domain/book-element';

export type ElementTimelineSortMode = 'category-then-created-at';

function buildCategoryOrderMap(categories: BookElementCategory[]): Map<string, number> {
  const sortedCategories = categories.slice().sort((a, b) => {
    const createdAtCompare = a.createdAt.localeCompare(b.createdAt);
    if (createdAtCompare !== 0) {
      return createdAtCompare;
    }
    return a.id.localeCompare(b.id);
  });

  const orderMap = new Map<string, number>();
  sortedCategories.forEach((category, index) => {
    orderMap.set(category.id, index);
  });
  return orderMap;
}

function compareByCategoryThenCreatedAt(
  a: BookElement,
  b: BookElement,
  categoryOrderMap: Map<string, number>,
): number {
  const categoryOrderA = categoryOrderMap.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER;
  const categoryOrderB = categoryOrderMap.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER;
  if (categoryOrderA !== categoryOrderB) {
    return categoryOrderA - categoryOrderB;
  }

  const createdAtCompare = a.createdAt.localeCompare(b.createdAt);
  if (createdAtCompare !== 0) {
    return createdAtCompare;
  }

  return a.id.localeCompare(b.id);
}

export function sortElementsForTimeline(
  elements: BookElement[],
  categories: BookElementCategory[],
  mode: ElementTimelineSortMode = 'category-then-created-at',
): BookElement[] {
  const categoryOrderMap = buildCategoryOrderMap(categories);

  switch (mode) {
    case 'category-then-created-at':
    default:
      return elements
        .slice()
        .sort((a, b) => compareByCategoryThenCreatedAt(a, b, categoryOrderMap));
  }
}
