import { useMemo } from 'react';
import { sumCanonicalChapterWordCounts } from '../../domain/book-node';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { deriveWritingStats, useWritingStatsStore } from '../../store/writing-stats-store';
import { dailyGoalProgress } from '../status-word-metric';

/**
 * Today's words: the book's net growth since the day's first record, with
 * the progress toward the daily goal (null without a goal). Shared by the
 * account cell and the immersive-writing corner.
 */
export function useTodayWords(projectId: string) {
  const { bookNodes } = useDataStoreFields('bookNodes');
  const writingHistory = useWritingStatsStore((state) => state.history[projectId]);
  const dailyWordGoal = useWritingStatsStore((state) => state.getPlan(projectId).dailyWordGoal);
  const projectWordCount = useMemo(() => sumCanonicalChapterWordCounts(bookNodes), [bookNodes]);
  const todayWords = useMemo(
    () =>
      projectWordCount.ready
        ? deriveWritingStats(writingHistory, projectWordCount.count).todayWords
        : null,
    [projectWordCount, writingHistory],
  );
  return {
    projectWordCount,
    todayWords,
    dailyWordGoal,
    progress: dailyGoalProgress(todayWords, dailyWordGoal),
  };
}
