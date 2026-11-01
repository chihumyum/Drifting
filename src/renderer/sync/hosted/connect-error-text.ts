import type { TFunction } from 'i18next';

// The codes a cloud connect or disconnect leaves on the App authority
// (cloud-restore.ts, attempt-recovery.ts, cloud-disconnect.ts), in words.
// Kept free of the sync modules themselves: Settings imports it to show a
// stored code, and the restore engine must not load with it.
const CONNECT_ERROR_KEYS: Record<string, string> = {
  'local-project-sync-conflict': 'settings.hosted.connect_errors.local_project_sync_conflict',
  'blocked-update': 'settings.hosted.connect_errors.blocked_update',
  'blocked-corrupt': 'settings.hosted.connect_errors.blocked_corrupt',
  'restore-failed': 'settings.hosted.connect_errors.restore_failed',
  'interrupted-native-activation': 'settings.hosted.connect_errors.interrupted',
  CANCELLED: 'settings.hosted.connect_errors.cancelled',
  DISCONNECT_FAILED: 'settings.hosted.connect_errors.disconnect_failed',
};

/** What to tell the author about a connect or disconnect that stopped, by its stored code. */
export function syncConnectErrorText(code: string, t: TFunction, projectNames: readonly string[] = []): string {
  if (code === 'local-project-sync-conflict' && projectNames.length > 0) {
    return t('settings.hosted.connect_errors.local_project_sync_conflict_named', {
      projects: projectNames.map((name) => t('settings.hosted.connect_errors.project_name', { name })).join(
        t('settings.hosted.connect_errors.project_separator'),
      ),
    });
  }
  const key = CONNECT_ERROR_KEYS[code];
  return key ? t(key) : t('settings.hosted.connect_errors.unknown', { code });
}

/** A CloudRestoreError (restore/cloud-restore.ts), recognised without loading it. */
function cloudRestoreFailure(error: unknown): { code: string; projectIds: readonly string[] } | null {
  if (!(error instanceof Error) || error.name !== 'CloudRestoreError') return null;
  const { code, projectIds } = error as Error & { code?: unknown; projectIds?: unknown };
  if (typeof code !== 'string') return null;
  return {
    code,
    projectIds: Array.isArray(projectIds) ? projectIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

/**
 * The words for a failed sign-in connect, naming the local projects a restore
 * stopped on; null when the error is not a cloud restore failure.
 */
export async function describeSyncConnectError(error: unknown, t: TFunction): Promise<string | null> {
  const failure = cloudRestoreFailure(error);
  if (!failure) return null;
  let names: string[] = [];
  if (failure.projectIds.length > 0) {
    try {
      const [{ inArray }, { getDb }, { ProjectTable }] = await Promise.all([
        import('drizzle-orm'),
        import('../../lib/db'),
        import('../../schema/drizzle'),
      ]);
      const rows = await getDb()
        .select({ name: ProjectTable.name })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, [...failure.projectIds]));
      names = rows.map((row) => row.name);
    } catch {
      names = [];
    }
  }
  return syncConnectErrorText(failure.code, t, names);
}
