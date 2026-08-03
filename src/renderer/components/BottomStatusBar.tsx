import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isChapter } from '../domain/book-node';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { isSyncEnabled } from '../lib/config';
import { useSyncObserver } from '../services/sync-observer.service';
import { useDataStore } from '../store/data-store';
import { focusedLeafOf, tabKey, useUiStore } from '../store/ui-store';
import { deriveWritingStats, useWritingStatsStore } from '../store/writing-stats-store';
import '../../styles/bottom-status-bar.css';

type WordMetric = {
  labelKey:
    | 'bottomStatusBar.currentWords'
    | 'bottomStatusBar.storylineWords'
    | 'bottomStatusBar.projectWords';
  count: number;
};

// BottomStatusBar is a status-first line owned by the center editor column.
// Its one structural control is the adjacent Bottom Timeline visibility
// toggle; navigation and feature menus live in AppTopbar.
export function BottomStatusBar() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const projectTabs = useUiStore((state) => state.tabsByProject[projectId]);
  const bookNodes = useDataStore((state) => state.bookNodes);
  const storylineNodeMapping = useDataStore((state) => state.storylineNodeMapping);
  const writingHistory = useWritingStatsStore((state) => state.history[projectId]);
  const syncMetrics = useSyncObserver((state) => state.metrics);
  const bottomTimelineHidden = useUiStore((state) => state.bottomTimelineHidden);
  const toggleBottomTimelineHidden = useUiStore((state) => state.toggleBottomTimelineHidden);

  const activeTab = projectTabs?.openTabs.find((tab) => tabKey(tab) === projectTabs.activeTabKey);
  const activeLeaf = activeTab ? focusedLeafOf(activeTab) : null;

  const projectWordCount = useMemo(
    () => bookNodes.filter(isChapter).reduce((sum, node) => sum + (node.wordCount || 0), 0),
    [bookNodes],
  );

  const wordMetric = useMemo<WordMetric>(() => {
    if (activeLeaf?.entityType === 'node') {
      const node = bookNodes.find((candidate) => candidate.id === activeLeaf.id);
      if (node) {
        return { labelKey: 'bottomStatusBar.currentWords', count: node.wordCount || 0 };
      }
    }

    if (activeLeaf?.entityType === 'storyline') {
      const nodeIds = new Set(storylineNodeMapping[activeLeaf.id] ?? []);
      const count = bookNodes.reduce(
        (sum, node) => sum + (nodeIds.has(node.id) ? node.wordCount || 0 : 0),
        0,
      );
      return { labelKey: 'bottomStatusBar.storylineWords', count };
    }

    return { labelKey: 'bottomStatusBar.projectWords', count: projectWordCount };
  }, [activeLeaf, bookNodes, projectWordCount, storylineNodeMapping]);

  const todayWords = useMemo(
    () => deriveWritingStats(writingHistory, projectWordCount).todayWords,
    [projectWordCount, writingHistory],
  );

  const syncEnabled = isSyncEnabled();
  const syncState = !syncEnabled
    ? 'local'
    : syncMetrics.inflight > 0
      ? 'syncing'
      : syncMetrics.lastFailureAt !== null &&
          (syncMetrics.lastSuccessAt === null ||
            syncMetrics.lastFailureAt > syncMetrics.lastSuccessAt)
        ? 'error'
        : 'synced';
  const lastSyncTime = syncMetrics.lastSuccessAt
    ? new Date(syncMetrics.lastSuccessAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  const syncLabel =
    syncState === 'local'
      ? t('bottomStatusBar.syncLocal')
      : syncState === 'syncing'
        ? t('bottomStatusBar.syncing')
        : syncState === 'error'
          ? t('bottomStatusBar.syncError')
          : lastSyncTime
            ? t('bottomStatusBar.syncedAt', { time: lastSyncTime })
            : t('bottomStatusBar.syncReady');

  return (
    <footer className="bsb app-plane" aria-label={t('bottomStatusBar.statusLine')}>
      <div className="bsb__group">
        <span className="bsb__item">
          {t(wordMetric.labelKey, { formatted: wordMetric.count.toLocaleString() })}
        </span>
        <span className="bsb__divider" aria-hidden="true">
          ·
        </span>
        <span className="bsb__item bsb__item--today">
          {t('bottomStatusBar.todayWords', { formatted: todayWords.toLocaleString() })}
        </span>
      </div>
      <div className="bsb__spacer" />
      <div className={`bsb__sync bsb__sync--${syncState}`} aria-live="polite">
        <span className="bsb__sync-dot" aria-hidden="true" />
        <span>{syncLabel}</span>
      </div>
      <button
        type="button"
        className="bsb__timeline-toggle"
        onClick={toggleBottomTimelineHidden}
        title={
          bottomTimelineHidden
            ? t('bottomStatusBar.expandTimeline')
            : t('bottomStatusBar.collapseTimeline')
        }
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
