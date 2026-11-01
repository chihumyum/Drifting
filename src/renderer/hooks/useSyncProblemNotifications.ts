import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { syncProblemRowText } from '../features/sync-status/sync-status-text';
import { useNotificationStore } from '../store/notification-store';
import { syncProblemsOf, type SyncProblemReport } from '../sync/sync-health';
import { useSyncHealth } from '../sync/sync-health-store';
import { projectName } from './useNotificationFeed';

const rowId = (report: SyncProblemReport) => `sync-problem:${report.projectId ?? 'all'}`;

/**
 * The problems already on the bell, by row. Module-wide like the notification
 * store, so a problem that resolves while the author is on the shelf still
 * releases its row when they open a book again.
 */
const shown = new Map<string, string>();

/**
 * Puts every sync problem (sync/sync-health.ts) on the bell: one row per book,
 * or one for a problem that stops every book. The row stays first and cannot
 * be removed while the problem lasts; once it resolves the same row says sync
 * resumed and becomes an ordinary one. Leaving Hosted sync takes the rows away
 * without saying sync resumed.
 */
export function useSyncProblemNotifications(): void {
  const { t } = useTranslation();
  const health = useSyncHealth();

  useEffect(() => {
    if (!health.observed) return;
    const { ingest, remove } = useNotificationStore.getState();
    const at = Date.now();
    const next = new Map<string, string>();
    for (const report of syncProblemsOf(health)) {
      const id = rowId(report);
      const key = JSON.stringify(report);
      next.set(id, key);
      if (shown.get(id) === key) continue;
      const text = syncProblemRowText(report, t, projectName(report.projectId));
      ingest({
        id,
        source: 'hosted-sync',
        state: 'failed',
        outcome: 'error',
        at,
        ...text,
        syncProblem: report,
      });
    }
    for (const id of shown.keys()) {
      if (next.has(id)) continue;
      const projectId = id === 'sync-problem:all' ? null : id.slice('sync-problem:'.length);
      ingest({
        id,
        source: 'hosted-sync',
        state: 'completed',
        outcome: 'ok',
        title: t('paperSync.restored'),
        detail: projectName(projectId) ?? undefined,
        error: undefined,
        at,
        syncProblem: null,
      });
      if (!health.hosted) remove(id);
    }
    shown.clear();
    for (const [id, key] of next) shown.set(id, key);
  }, [health, t]);
}
