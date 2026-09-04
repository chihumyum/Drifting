import { useEffect } from 'react';
import { events } from '../lib/events';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '../store/notification-store';
import { useProjectStore } from '../store/project-store';
import { productSyncRuntimeControl } from '../sync/product-runtime-control';
import type {
  SyncGenerationRuntimeStatus,
  SyncGenerationTransferProgress,
} from '../sync/engine';

function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes.toLocaleString(locale)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${unit}`;
}

function progressValue(progress: SyncGenerationTransferProgress): number | null {
  if (!progress.totalKnown) return null;
  if (progress.totalBytes > 0) {
    return Math.min(1, progress.transferredBytes / progress.totalBytes);
  }
  return progress.totalObjects > 0
    ? Math.min(1, progress.completedObjects / progress.totalObjects)
    : null;
}

function projectName(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const state = useProjectStore.getState();
  return (
    (state.currentProject?.id === projectId ? state.currentProject.name : null) ??
    state.projects.find((project) => project.id === projectId)?.name ??
    null
  );
}

function phaseKey(status: SyncGenerationRuntimeStatus): string {
  const stage = status.transferProgress?.stage;
  if (stage === 'download') return 'downloading';
  if (stage === 'upload-assets') return 'uploadingAssets';
  if (stage === 'upload-changes') return 'uploadingChanges';
  if (status.phase === 'ingesting' || status.phase === 'applying') return 'applying';
  if (status.phase === 'checkpointing') return 'finishing';
  return 'syncing';
}

/**
 * Wires Copilot lifecycle events and sanitized Google Drive transfer progress
 * into the desktop notification store. One Drive cycle stays one row from its
 * first material transfer through completion, cancellation, or failure.
 */
export function useNotificationFeed(): void {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const ingest = useNotificationStore.getState().ingest;
    events.on('ai-task', ingest);
    return () => events.off('ai-task', ingest);
  }, []);

  useEffect(() => {
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
            id: `google-drive-sync:${generation.syncGenerationId}:${generation.cycleNumber}`,
            cycleNumber: generation.cycleNumber,
            lastProgress: progress,
          };
          active.set(generation.syncGenerationId, tracked);
        }
        if (!tracked) continue;

        const name = projectName(generation.projectId);
        const title = t(`notifications.googleDrive.${phaseKey(generation)}`);
        if (generation.phase !== 'idle') {
          if (progress) tracked.lastProgress = progress;
          const current = progress ?? tracked.lastProgress;
          const transferred = formatBytes(current.transferredBytes, i18n.language);
          const total = formatBytes(current.totalBytes, i18n.language);
          const byteProgress =
            current.totalBytes > 0
              ? current.totalKnown
                ? t('notifications.googleDrive.bytesKnown', { transferred, total })
                : t('notifications.googleDrive.bytesDiscovered', { transferred })
              : null;
          const objectProgress = current.totalKnown
            ? t('notifications.googleDrive.objectsKnown', {
                completed: current.completedObjects,
                total: current.totalObjects,
              })
            : t('notifications.googleDrive.objectsDiscovered', {
                completed: current.completedObjects,
              });
          ingest({
            id: tracked.id,
            source: 'google-drive',
            state: 'started',
            title,
            detail: [name, byteProgress, objectProgress].filter(Boolean).join(' · '),
            progress: {
              value: progressValue(current),
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
        const failed = generation.lastOutcome === 'failed';
        ingest({
          id: tracked.id,
          source: 'google-drive',
          state: failed ? 'failed' : stopped ? 'stopped' : 'completed',
          title: t(
            failed
              ? 'notifications.googleDrive.failed'
              : stopped
                ? 'notifications.googleDrive.stopped'
                : 'notifications.googleDrive.completed',
          ),
          detail: name ?? undefined,
          outcome: failed ? 'error' : 'ok',
          error: failed
            ? t('notifications.googleDrive.failureCode', {
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
  }, [i18n.language, t]);
}
