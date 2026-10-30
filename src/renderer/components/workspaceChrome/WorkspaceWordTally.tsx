import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { sumCanonicalChapterWordCounts } from '../../domain/book-node';
import { useWholeBookEditingStore } from '../../features/editor/whole-book-editing';
import { useEditorSelectionWordCount } from '../../hooks/useEditorSelectionWordCount';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { focusedLeafOf, tabKey, useProjectTabs } from '../../store/ui-store';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { deriveWritingStats, useWritingStatsStore } from '../../store/writing-stats-store';
import { dailyGoalProgress, deriveStatusWordMetric } from '../status-word-metric';

/**
 * The word counts in the account cell, between the account pill and Project
 * Home: flat faint text set like a cell's date, read rather than pressed. The
 * first follows the focused document (the selection first); the second is
 * today's words, with a sand stroke toward the daily goal. Whichever no
 * longer fits wraps onto a hidden second line and leaves whole, today's
 * first (desktop-shell.css).
 */
export function WorkspaceWordTally() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const { bookNodes, storylineNodeMapping } = useDataStoreFields('bookNodes', 'storylineNodeMapping');
  const writingHistory = useWritingStatsStore((state) => state.history[projectId]);
  const dailyWordGoal = useWritingStatsStore((state) => state.getPlan(projectId).dailyWordGoal);
  const selectedWordCount = useEditorSelectionWordCount();
  const wholeBookEditingChapterId = useWholeBookEditingStore(
    (state) => state.chapterByProject[projectId] ?? null,
  );

  const activeTab = openTabs.find((tab) => tabKey(tab) === activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;
  const projectWordCount = useMemo(() => sumCanonicalChapterWordCounts(bookNodes), [bookNodes]);
  const metric = deriveStatusWordMetric({
    selectedWordCount,
    activeLeaf,
    wholeBookEditingChapterId,
    bookNodes,
    storylineNodeMapping,
    projectWordCount,
  });
  const todayWords = useMemo(
    () =>
      projectWordCount.ready
        ? deriveWritingStats(writingHistory, projectWordCount.count).todayWords
        : null,
    [projectWordCount, writingHistory],
  );
  const progress = dailyGoalProgress(todayWords, dailyWordGoal);

  const label = t(`workspaceWordTally.${metric.kind}`);
  const counting = t('workspaceWordTally.counting');
  const format = (count: number | null) => (count == null ? counting : count.toLocaleString());
  const summary = [
    t('workspaceWordTally.part', { label, formatted: format(metric.count) }),
    todayWords == null
      ? null
      : dailyWordGoal > 0
        ? t('workspaceWordTally.todayGoalPart', {
            formatted: todayWords.toLocaleString(),
            goal: dailyWordGoal.toLocaleString(),
          })
        : t('workspaceWordTally.todayPart', { formatted: todayWords.toLocaleString() }),
    metric.kind === 'book'
      ? null
      : t('workspaceWordTally.part', {
          label: t('workspaceWordTally.book'),
          formatted: format(projectWordCount.ready ? projectWordCount.count : null),
        }),
  ].filter(Boolean).join(' · ');

  return (
    <div className="sidebar-account-cell__tally" title={summary}>
      {/* Keyed by kind: another kind of count fades in; the same kind only changes its digits. */}
      <span key={metric.kind} className="sidebar-account-cell__count">
        <span>{label}</span>
        <span className="sidebar-account-cell__figure">{format(metric.count)}</span>
      </span>
      <span className="sidebar-account-cell__count sidebar-account-cell__count--today">
        <span>{t('workspaceWordTally.today')}</span>
        <span className="sidebar-account-cell__figure">
          {todayWords == null ? counting : `+${todayWords.toLocaleString()}`}
        </span>
        {progress != null && (
          <span
            className="sand-stroke sidebar-account-cell__goal"
            style={{ width: `${progress * 100}%` }}
          />
        )}
      </span>
    </div>
  );
}
