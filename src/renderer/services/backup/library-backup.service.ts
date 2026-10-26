// Renderer orchestration for complete `.drifting` library backups. Packaging,
// verification and the closed-library replacement are native; this module only
// settles local writes first and reloads after a restore so every store is
// rebuilt from the replaced database. See docs/library-backup.md.
import { checkpointDatabase, getDbName } from '../../lib/db';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import {
  databasePlatform,
  type LibraryBackupApi,
  type LibraryBackupExportResult,
  type LibraryBackupInspectResult,
  type LibraryRestoreOutcome,
} from '../../platform/database';

export type LibraryBackupErrorCode =
  | 'sync-connected'
  | 'invalid'
  | 'newer'
  | 'unknown';

/** Native errors carry a stable `code:` prefix ahead of their English detail. */
export function libraryBackupErrorCode(error: unknown): LibraryBackupErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('library-sync-connected')) return 'sync-connected';
  if (message.includes('backup-newer')) return 'newer';
  if (message.includes('backup-invalid')) return 'invalid';
  return 'unknown';
}

export function suggestedLibraryBackupFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Drifting-Backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.drifting`;
}

interface LibraryBackupDependencies {
  readonly platform: LibraryBackupApi;
  readonly settleLocalWrites: () => Promise<void>;
  readonly reload: () => void;
}

const defaultDependencies: LibraryBackupDependencies = {
  platform: databasePlatform,
  async settleLocalWrites() {
    await flushLocalApplicationPersistence();
    await checkpointDatabase();
  },
  reload: () => window.location.reload(),
};

export function createLibraryBackupService(
  dependencies: LibraryBackupDependencies = defaultDependencies,
) {
  const { platform, settleLocalWrites, reload } = dependencies;
  return {
    /** Package the open library; pending editor writes land first. */
    async exportBackup(now = new Date()): Promise<LibraryBackupExportResult> {
      await settleLocalWrites();
      return platform.exportLibraryBackup(suggestedLibraryBackupFileName(now));
    },

    /** Pick, verify and stage a package without touching the open library. */
    inspectBackup(userId: string, now = new Date()): Promise<LibraryBackupInspectResult> {
      return platform.inspectLibraryBackup(userId, now.toISOString());
    },

    discardBackup(restoreId: string): Promise<void> {
      return platform.discardLibraryBackup(restoreId);
    },

    /**
     * Replace the open library with a staged package, then reload. A failed
     * restore leaves the original library open, so the caller can report it.
     */
    async restoreBackup(restoreId: string, userId: string): Promise<LibraryRestoreOutcome> {
      await settleLocalWrites();
      const outcome = await platform.restoreLibraryBackup(restoreId, getDbName(userId));
      reload();
      return outcome;
    },

    openSafetyDirectory(): Promise<void> {
      return platform.openLibraryBackupSafetyDirectory();
    },
  };
}

export const libraryBackupService = createLibraryBackupService();
