import { useTranslation } from 'react-i18next';
import { useWholeBookEditingStore } from '../../features/editor/whole-book-editing';
import { useEditorSelectionWordCount } from '../../hooks/useEditorSelectionWordCount';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { focusedLeafOf, tabKey, useProjectTabs } from '../../store/ui-store';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { deriveStatusWordMetric } from '../status-word-metric';
import { useTodayWords } from './useTodayWords';

/**
 * The word counts in the account cell, between the account pill and Project
 * Home: flat faint text set like a cell's date, read rather than pressed. The
 * first follows the focused document (the selection first); the second is
 * today's words, with a sand stroke toward the daily goal. Whichever no
 * longer fits wraps onto a hidden second line and leaves whole, today's
 * first (desktop-shell.css).
 */
export function WorkspaceWordTally() {
  const { t, i18n } = useTranslation();
  const { projectId } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const { bookNodes, storylineNodeMapping } = useDataStoreFields('bookNodes', 'storylineNodeMapping');
  const { projectWordCount, todayWords, dailyWordGoal, progress } = useTodayWords(projectId);
  const selectedWordCount = useEditorSelectionWordCount();
  const wholeBookEditingChapterId = useWholeBookEditingStore(
    (state) => state.chapterByProject[projectId] ?? null,
  );

  const activeTab = openTabs.find((tab) => tabKey(tab) === activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;
  const metric = deriveStatusWordMetric({
    selectedWordCount,
    activeLeaf,
    wholeBookEditingChapterId,
    bookNodes,
    storylineNodeMapping,
    projectWordCount,
  });
  const label = t(`workspaceWordTally.${metric.kind}`);
  const counting = t('workspaceWordTally.counting');
  const format = (count: number | null) => (count == null ? counting : count.toLocaleString(i18n.language));
  const summary = [
    t('workspaceWordTally.part', { label, formatted: format(metric.count) }),
    todayWords == null
      ? null
      : dailyWordGoal > 0
        ? t('workspaceWordTally.todayGoalPart', {
            formatted: todayWords.toLocaleString(i18n.language),
            goal: dailyWordGoal.toLocaleString(i18n.language),
          })
        : t('workspaceWordTally.todayPart', { formatted: todayWords.toLocaleString(i18n.language) }),
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
          {todayWords == null ? counting : `+${todayWords.toLocaleString(i18n.language)}`}
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
