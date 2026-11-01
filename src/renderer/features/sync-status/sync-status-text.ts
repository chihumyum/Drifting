import type { TFunction } from 'i18next';

import type { SyncGenerationCyclePhase, SyncGenerationTransferProgress } from '../../sync/engine';
import type { SyncCornerState, SyncProblem, SyncProblemReport, SyncTransferView } from '../../sync/sync-health';

export function formatTransferBytes(bytes: number, locale: string): string {
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

/** 0–1 when the total is known, else null. */
export function transferRatio(progress: SyncGenerationTransferProgress): number | null {
  if (!progress.totalKnown) return null;
  if (progress.totalBytes > 0) return Math.min(1, progress.transferredBytes / progress.totalBytes);
  return progress.totalObjects > 0 ? Math.min(1, progress.completedObjects / progress.totalObjects) : null;
}

/** The `notifications.cloudSync.*` key for what a cycle is doing. */
export function transferPhaseKey(
  phase: SyncGenerationCyclePhase,
  progress: SyncGenerationTransferProgress | null,
): string {
  const stage = progress?.stage;
  if (stage === 'download') return 'downloading';
  if (stage === 'upload-assets') return 'uploadingAssets';
  if (stage === 'upload-changes') return 'uploadingChanges';
  if (phase === 'ingesting' || phase === 'applying') return 'applying';
  if (phase === 'checkpointing') return 'finishing';
  return 'syncing';
}

/** Items and bytes, joined as the notification center writes them. */
export function transferReading(progress: SyncGenerationTransferProgress, t: TFunction, locale: string): string {
  const transferred = formatTransferBytes(progress.transferredBytes, locale);
  const total = formatTransferBytes(progress.totalBytes, locale);
  const objects = progress.totalKnown
    ? t('notifications.cloudSync.objectsKnown', { completed: progress.completedObjects, total: progress.totalObjects })
    : t('notifications.cloudSync.objectsDiscovered', { completed: progress.completedObjects });
  const bytes =
    progress.totalBytes > 0
      ? progress.totalKnown
        ? t('notifications.cloudSync.bytesKnown', { transferred, total })
        : t('notifications.cloudSync.bytesDiscovered', { transferred })
      : null;
  return [objects, bytes].filter(Boolean).join(' · ');
}

export interface SyncStatusText {
  readonly title: string;
  readonly detail?: string;
  /** A monospaced reading (items, bytes, what is still to send). */
  readonly reading?: string;
  /** A failure's code, in the danger ink. */
  readonly code?: string;
  /** How far the transfer is (0–1); null while the total is still being discovered. */
  readonly ratio?: number | null;
}

function syncingText(transfer: SyncTransferView | null, t: TFunction, locale: string): SyncStatusText {
  const title = t(`notifications.cloudSync.${transferPhaseKey(transfer?.phase ?? 'preparing', transfer?.progress ?? null)}`);
  const progress = transfer?.progress;
  if (!progress || progress.totalObjects === 0) return { title };
  return { title, reading: transferReading(progress, t, locale), ratio: transferRatio(progress) };
}

export function syncProblemText(
  problem: SyncProblem,
  t: TFunction,
  failure: { readonly errorCode: string | null; readonly failures: number } = { errorCode: null, failures: 0 },
): SyncStatusText {
  switch (problem) {
    case 'not-started':
      return { title: t('paperSync.notStarted'), detail: t('paperSync.notStartedDetail') };
    case 'reauth':
      return { title: t('paperSync.reauth'), detail: t('paperSync.reauthDetail') };
    case 'quota':
      return { title: t('paperSync.quota'), detail: t('settings.hosted.quota_blocked') };
    case 'failing':
      return {
        title: t('paperSync.failing'),
        code: t('paperSync.failingCode', { code: failure.errorCode ?? 'SYNC_CYCLE_FAILED', count: failure.failures }),
      };
  }
}

/** What the paper's sync card says; null when the corner is empty. */
export function syncCornerText(state: SyncCornerState, t: TFunction, locale: string): SyncStatusText | null {
  switch (state.kind) {
    case 'none':
      return null;
    case 'syncing':
      return syncingText(state.transfer, t, locale);
    case 'retrying':
      return { title: t('paperSync.retrying'), detail: t('paperSync.retryingDetail') };
    case 'offline':
      return {
        title: t('paperSync.offline'),
        detail: t('paperSync.offlineDetail'),
        ...(state.pendingChanges > 0
          ? { reading: t('paperSync.offlinePending', { count: state.pendingChanges }) }
          : {}),
      };
    case 'problem':
      return syncProblemText(state.problem, t, state);
  }
}

/** The bell's pinned row: the problem's title, the book's name and the code or the reason. */
export function syncProblemRowText(
  report: SyncProblemReport,
  t: TFunction,
  projectName: string | null,
): { title: string; detail?: string; error?: string } {
  const text = syncProblemText(report.problem, t, report);
  const detail = report.projectId ? projectName ?? undefined : text.detail;
  return { title: text.title, ...(detail ? { detail } : {}), ...(text.code ? { error: text.code } : {}) };
}
