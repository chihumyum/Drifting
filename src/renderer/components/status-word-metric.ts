import { canonicalWordCount, isChapter, type BookNode } from '../domain/book-node';

export type StatusWordMetric = {
  labelKey:
    | 'bottomStatusBar.selectedWords'
    | 'bottomStatusBar.currentWords'
    | 'bottomStatusBar.storylineWords'
    | 'bottomStatusBar.projectWords';
  count: number | null;
};

/**
 * The footer's word count, most specific first: the selection, the open
 * chapter or drift — in 通览全书, the chapter being edited — the open
 * storyline, then the whole book.
 */
export function deriveStatusWordMetric({
  selectedWordCount,
  activeLeaf,
  wholeBookEditingChapterId,
  bookNodes,
  storylineNodeMapping,
  projectWordCount,
}: {
  selectedWordCount: number | null;
  activeLeaf: { entityType: string; id: string } | null;
  wholeBookEditingChapterId: string | null;
  bookNodes: readonly BookNode[];
  storylineNodeMapping: Readonly<Record<string, readonly string[] | undefined>>;
  projectWordCount: { count: number; ready: boolean };
}): StatusWordMetric {
  if (selectedWordCount !== null) {
    return { labelKey: 'bottomStatusBar.selectedWords', count: selectedWordCount };
  }

  const nodeId =
    activeLeaf?.entityType === 'node'
      ? activeLeaf.id
      : activeLeaf?.entityType === 'all-chapters'
        ? wholeBookEditingChapterId
        : null;
  const node = nodeId ? bookNodes.find((candidate) => candidate.id === nodeId) : undefined;
  if (node) {
    return { labelKey: 'bottomStatusBar.currentWords', count: canonicalWordCount(node) };
  }

  if (activeLeaf?.entityType === 'storyline') {
    const nodeIds = new Set(storylineNodeMapping[activeLeaf.id] ?? []);
    const counts = bookNodes
      .filter((candidate) => isChapter(candidate) && nodeIds.has(candidate.id))
      .map(canonicalWordCount);
    return {
      labelKey: 'bottomStatusBar.storylineWords',
      count: counts.every((count) => count != null)
        ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
        : null,
    };
  }

  return {
    labelKey: 'bottomStatusBar.projectWords',
    count: projectWordCount.ready ? projectWordCount.count : null,
  };
}
