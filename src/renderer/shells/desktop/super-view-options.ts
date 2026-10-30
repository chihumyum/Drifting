export type SuperViewId = 'element' | 'graph' | 'memo-material';

/** The Super View switcher's order, left to right; a switch pushes along it. */
export const SUPER_VIEW_OPTIONS: Array<{ id: SuperViewId; labelKey: string }> = [
  { id: 'element', labelKey: 'superElement.title' },
  { id: 'graph', labelKey: 'storyGraph.title' },
  { id: 'memo-material', labelKey: 'memoMaterial.super.title' },
];
