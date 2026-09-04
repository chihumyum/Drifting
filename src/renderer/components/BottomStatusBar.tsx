import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalWordCount, isChapter, sumCanonicalChapterWordCounts } from '../domain/book-node';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { formatAccelerator } from '../lib/shortcuts';
import { useDataStore } from '../store/data-store';
import { useShortcutsStore } from '../store/shortcuts-store';
import { focusedLeafOf, tabKey, useUiStore } from '../store/ui-store';
import { deriveWritingStats, useWritingStatsStore } from '../store/writing-stats-store';
import '../../styles/bottom-status-bar.css';

type WordMetric = {
  labelKey:
    | 'bottomStatusBar.currentWords'
    | 'bottomStatusBar.storylineWords'
    | 'bottomStatusBar.projectWords';
  count: number | null;
};

// BottomStatusBar is a status-first line spanning the full application width.
// Its one structural control is the Bottom Timeline visibility toggle;
// navigation and feature menus live in AppTopbar.
export function BottomStatusBar() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const projectTabs = useUiStore((state) => state.tabsByProject[projectId]);
  const bookNodes = useDataStore((state) => state.bookNodes);
  const storylineNodeMapping = useDataStore((state) => state.storylineNodeMapping);
  const writingHistory = useWritingStatsStore((state) => state.history[projectId]);
  const toggleBottomTimelineAccelerator = useShortcutsStore(
    (state) => state.bindings.toggleBottomTimeline,
  );
  const bottomTimelineHidden = useUiStore((state) => state.bottomTimelineHidden);
  const toggleBottomTimelineHidden = useUiStore((state) => state.toggleBottomTimelineHidden);

  const activeTab = projectTabs?.openTabs.find((tab) => tabKey(tab) === projectTabs.activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;

  const projectWordCount = useMemo(() => sumCanonicalChapterWordCounts(bookNodes), [bookNodes]);

  const wordMetric = useMemo<WordMetric>(() => {
    if (activeLeaf?.entityType === 'node') {
      const node = bookNodes.find((candidate) => candidate.id === activeLeaf.id);
      if (node) {
        return { labelKey: 'bottomStatusBar.currentWords', count: canonicalWordCount(node) };
      }
    }

    if (activeLeaf?.entityType === 'storyline') {
      const nodeIds = new Set(storylineNodeMapping[activeLeaf.id] ?? []);
      const nodes = bookNodes.filter((node) => isChapter(node) && nodeIds.has(node.id));
      const counts = nodes.map(canonicalWordCount);
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
  }, [activeLeaf, bookNodes, projectWordCount, storylineNodeMapping]);

  const todayWords = useMemo(
    () =>
      projectWordCount.ready
        ? deriveWritingStats(writingHistory, projectWordCount.count).todayWords
        : null,
    [projectWordCount, writingHistory],
  );

  const toggleBottomTimelineShortcut = formatAccelerator(toggleBottomTimelineAccelerator);

  return (
    <footer className="bsb app-plane" aria-label={t('bottomStatusBar.statusLine')}>
      <div className="bsb__group">
        <span className="bsb__item">
          {wordMetric.count == null
            ? t('bottomStatusBar.metricsPending')
            : t(wordMetric.labelKey, { formatted: wordMetric.count.toLocaleString() })}
        </span>
        <span className="bsb__divider" aria-hidden="true">
          ·
        </span>
        <span className="bsb__item bsb__item--today">
          {todayWords == null
            ? t('bottomStatusBar.todayPending')
            : t('bottomStatusBar.todayWords', { formatted: todayWords.toLocaleString() })}
        </span>
      </div>
      <div className="bsb__spacer" />
      <button
        type="button"
        className="bsb__timeline-toggle"
        onClick={toggleBottomTimelineHidden}
        title={toggleBottomTimelineShortcut}
        aria-label={
          bottomTimelineHidden
            ? t('bottomStatusBar.expandTimeline')
            : t('bottomStatusBar.collapseTimeline')
        }
        aria-pressed={!bottomTimelineHidden}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
          <line x1="1.5" y1="7" x2="14.5" y2="7" />
          <line x1="4" y1="10.5" x2="9" y2="10.5" />
        </svg>
        <span>{t('bottomStatusBar.timeline')}</span>
      </button>
    </footer>
  );
}
