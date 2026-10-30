import { canonicalWordCount, isChapter, isDrift, type BookNode } from '../domain/book-node';

export type StatusWordMetricKind = 'selection' | 'chapter' | 'drift' | 'storyline' | 'book';

export type StatusWordMetric = {
  kind: StatusWordMetricKind;
  count: number | null;
};

/**
 * The account cell's word count, most specific first: the selection, the
 * open chapter or idea — in 通览全书, the chapter being edited — the open
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
    return { kind: 'selection', count: selectedWordCount };
  }

  const nodeId =
    activeLeaf?.entityType === 'node'
      ? activeLeaf.id
      : activeLeaf?.entityType === 'all-chapters'
        ? wholeBookEditingChapterId
        : null;
  const node = nodeId ? bookNodes.find((candidate) => candidate.id === nodeId) : undefined;
  if (node) {
    return { kind: isDrift(node) ? 'drift' : 'chapter', count: canonicalWordCount(node) };
  }

  if (activeLeaf?.entityType === 'storyline') {
    const nodeIds = new Set(storylineNodeMapping[activeLeaf.id] ?? []);
    const counts = bookNodes
      .filter((candidate) => isChapter(candidate) && nodeIds.has(candidate.id))
      .map(canonicalWordCount);
    return {
      kind: 'storyline',
      count: counts.every((count) => count != null)
        ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
        : null,
    };
  }

  return {
    kind: 'book',
    count: projectWordCount.ready ? projectWordCount.count : null,
  };
}

/**
 * How far today's words have gone toward the daily goal, 0–1; null when
 * there is no goal (0 turns it off) or today is still being counted.
 */
export function dailyGoalProgress(todayWords: number | null, dailyWordGoal: number): number | null {
  if (todayWords == null || !(dailyWordGoal > 0)) return null;
  return Math.min(1, Math.max(0, todayWords / dailyWordGoal));
}
