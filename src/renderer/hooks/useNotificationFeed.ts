import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '../store/notification-store';
import { useProjectStore } from '../store/project-store';
import { productSyncRuntimeControl } from '../sync/product-runtime-control';
import type { SyncGenerationTransferProgress } from '../sync/engine';
import {
  formatTransferBytes,
  transferPhaseKey,
  transferRatio,
} from '../features/sync-status/sync-status-text';

/** A book's name for a sync row, from the open project or the shelf list. */
export function projectName(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const state = useProjectStore.getState();
  return (
    (state.currentProject?.id === projectId ? state.currentProject.name : null) ??
    state.projects.find((project) => project.id === projectId)?.name ??
    null
  );
}

/**
 * Wires sanitized Hosted transfer progress into the shared notification
 * store. One sync cycle stays one row from its
 * first material transfer through completion, cancellation, or failure.
 * The desktop leaves transfers to the paper's sync mark and puts only
 * problems on the bell (useSyncProblemNotifications); the paused mobile shell
 * keeps a row per transfer.
 */
export function useNotificationFeed({ transfers = true }: { transfers?: boolean } = {}): void {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    if (!transfers) return undefined;
    const active = new Map<
      string,
      { id: string; cycleNumber: number; lastProgress: SyncGenerationTransferProgress }
    >();
    const ingest = useNotificationStore.getState().ingest;

    const inspect = () => {
      const diagnostics = productSyncRuntimeControl.getSnapshot().diagnostics;
      if (!diagnostics) return;

      for (const generation of diagnostics.generations) {
        const progress = generation.transferProgress;
        let tracked = active.get(generation.syncGenerationId);
        if (
          generation.phase !== 'idle' &&
          progress &&
          progress.totalObjects > 0 &&
          (!tracked || tracked.cycleNumber !== generation.cycleNumber)
        ) {
          tracked = {
            id: `hosted-sync:${generation.syncGenerationId}:${generation.cycleNumber}`,
            cycleNumber: generation.cycleNumber,
            lastProgress: progress,
          };
          active.set(generation.syncGenerationId, tracked);
        }
        if (!tracked) continue;

        const chat = generation.syncGenerationId.endsWith(':agent-chat');
        const name = [projectName(generation.projectId), chat ? t('notifications.cloudSync.agentChat') : null].filter(Boolean).join(' · ') || null;
        const title = t(`notifications.cloudSync.${transferPhaseKey(generation.phase, generation.transferProgress)}`);
        if (generation.phase !== 'idle') {
          if (progress) tracked.lastProgress = progress;
          const current = progress ?? tracked.lastProgress;
          const transferred = formatTransferBytes(current.transferredBytes, i18n.language);
          const total = formatTransferBytes(current.totalBytes, i18n.language);
          const byteProgress =
            current.totalBytes > 0
              ? current.totalKnown
                ? t('notifications.cloudSync.bytesKnown', { transferred, total })
                : t('notifications.cloudSync.bytesDiscovered', { transferred })
              : null;
          const objectProgress = current.totalKnown
            ? t('notifications.cloudSync.objectsKnown', {
                completed: current.completedObjects,
                total: current.totalObjects,
              })
            : t('notifications.cloudSync.objectsDiscovered', {
                completed: current.completedObjects,
              });
          ingest({
            id: tracked.id,
            source: 'hosted-sync',
            state: 'started',
            title,
            detail: [name, byteProgress, objectProgress].filter(Boolean).join(' · '),
            progress: {
              value: transferRatio(current),
              transferredBytes: current.transferredBytes,
              totalBytes: current.totalBytes,
              completedObjects: current.completedObjects,
              totalObjects: current.totalObjects,
            },
            at: diagnostics.generatedAtMs,
          });
          continue;
        }

        const stopped = generation.lastOutcome === 'cancelled';
        const failed = generation.lastOutcome === 'failed' || (chat && (generation.pending.openConflicts > 0 || generation.pending.quarantinedObjects > 0));
        const pending = chat && (generation.pending.openGaps > 0 || generation.pending.pendingChangeSets > 0 || generation.pending.pendingTransfers > 0);
        ingest({
          id: tracked.id,
          source: 'hosted-sync',
          state: failed ? 'failed' : stopped ? 'stopped' : 'completed',
          title: t(
            failed
              ? 'notifications.cloudSync.failed'
              : stopped
                ? 'notifications.cloudSync.stopped'
                : pending ? 'notifications.cloudSync.pending' : 'notifications.cloudSync.completed',
          ),
          detail: name ?? undefined,
          outcome: failed ? 'error' : 'ok',
          error: failed
            ? t('notifications.cloudSync.failureCode', {
                code: generation.lastErrorCode ?? 'SYNC_CYCLE_FAILED',
              })
            : undefined,
          at: diagnostics.generatedAtMs,
        });
        active.delete(generation.syncGenerationId);
      }
    };

    const unsubscribe = productSyncRuntimeControl.subscribe(inspect);
    inspect();
    return unsubscribe;
  }, [i18n.language, t, transfers]);
}
