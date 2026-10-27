import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { sumCanonicalChapterWordCounts } from '../../domain/book-node';
import { useWholeBookEditingStore } from '../../features/editor/whole-book-editing';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useEditorSelectionWordCount } from '../../hooks/useEditorSelectionWordCount';
import { useDataStore } from '../../store/data-store';
import { focusedLeafOf, tabKey, useUiStore } from '../../store/ui-store';
import { deriveWritingStats, useWritingStatsStore } from '../../store/writing-stats-store';
import { deriveStatusWordMetric } from '../status-word-metric';

// The workspace has no status line. The writing count rests as faint text in
// the desk's lower-left corner: the focused document (or selection) and today.
export function WorkspaceWordCount() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const projectTabs = useUiStore((state) => state.tabsByProject[projectId]);
  const bookNodes = useDataStore((state) => state.bookNodes);
  const storylineNodeMapping = useDataStore((state) => state.storylineNodeMapping);
  const writingHistory = useWritingStatsStore((state) => state.history[projectId]);

  const activeTab = projectTabs?.openTabs.find((tab) => tabKey(tab) === projectTabs.activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;
  const selectedWordCount = useEditorSelectionWordCount();
  const wholeBookEditingChapterId = useWholeBookEditingStore(
    (state) => state.chapterByProject[projectId] ?? null,
  );

  const projectWordCount = useMemo(() => sumCanonicalChapterWordCounts(bookNodes), [bookNodes]);

  const wordMetric = useMemo(
    () =>
      deriveStatusWordMetric({
        selectedWordCount,
        activeLeaf,
        wholeBookEditingChapterId,
        bookNodes,
        storylineNodeMapping,
        projectWordCount,
      }),
    [
      activeLeaf,
      bookNodes,
      projectWordCount,
      selectedWordCount,
      storylineNodeMapping,
      wholeBookEditingChapterId,
    ],
  );

  const todayWords = useMemo(
    () =>
      projectWordCount.ready
        ? deriveWritingStats(writingHistory, projectWordCount.count).todayWords
        : null,
    [projectWordCount, writingHistory],
  );

  return (
    <div className="workspace-word-count" aria-label={t('bottomStatusBar.statusLine')}>
      <span>
        {wordMetric.count == null
          ? t('bottomStatusBar.metricsPending')
          : t(wordMetric.labelKey, { formatted: wordMetric.count.toLocaleString() })}
      </span>
      <span className="workspace-word-count__today">
        {todayWords == null
          ? t('bottomStatusBar.todayPending')
          : t('bottomStatusBar.todayWords', { formatted: todayWords.toLocaleString() })}
      </span>
    </div>
  );
}
