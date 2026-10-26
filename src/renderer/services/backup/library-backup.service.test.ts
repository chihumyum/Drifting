import { describe, expect, it, vi } from 'vitest';
import type { LibraryBackupApi } from '../../platform/database';
import {
  createLibraryBackupService,
  libraryBackupErrorCode,
  suggestedLibraryBackupFileName,
} from './library-backup.service';

function platform(overrides: Partial<LibraryBackupApi> = {}): LibraryBackupApi {
  return {
    exportLibraryBackup: vi.fn(async () => ({ canceled: true as const })),
    inspectLibraryBackup: vi.fn(async () => ({ canceled: true as const })),
    restoreLibraryBackup: vi.fn(async () => ({ preRestorePackage: null, restoredProjectCount: 0 })),
    discardLibraryBackup: vi.fn(async () => undefined),
    openLibraryBackupSafetyDirectory: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('library backup orchestration', () => {
  it('settles local writes before exporting and names the file by local date', async () => {
    const order: string[] = [];
    const api = platform({
      exportLibraryBackup: vi.fn(async (name: string) => {
        order.push(`export:${name}`);
        return { canceled: true as const };
      }),
    });
    const service = createLibraryBackupService({
      platform: api,
      settleLocalWrites: async () => { order.push('settle'); },
      reload: () => order.push('reload'),
    });
    await service.exportBackup(new Date(2026, 9, 8));
    expect(order).toEqual(['settle', 'export:Drifting-Backup-2026-10-08.drifting']);
    expect(suggestedLibraryBackupFileName(new Date(2026, 0, 2))).toBe('Drifting-Backup-2026-01-02.drifting');
  });

  it('restores into the signed-in library database and reloads only on success', async () => {
    const order: string[] = [];
    const restoreLibraryBackup = vi.fn(async () => {
      order.push('restore');
      return { preRestorePackage: 'p.drifting', restoredProjectCount: 2 };
    });
    const service = createLibraryBackupService({
      platform: platform({ restoreLibraryBackup }),
      settleLocalWrites: async () => { order.push('settle'); },
      reload: () => order.push('reload'),
    });
    await service.restoreBackup('ab'.repeat(16), 'drifting-library.db');
    expect(restoreLibraryBackup).toHaveBeenCalledWith('ab'.repeat(16), 'drifting-library.db');
    expect(order).toEqual(['settle', 'restore', 'reload']);

    const failing = createLibraryBackupService({
      platform: platform({ restoreLibraryBackup: vi.fn(async () => { throw new Error('library-sync-connected: x'); }) }),
      settleLocalWrites: async () => undefined,
      reload: () => order.push('unexpected-reload'),
    });
    await expect(failing.restoreBackup('ab'.repeat(16), 'account-1')).rejects.toThrow();
    expect(order).not.toContain('unexpected-reload');
  });

  it('maps native error prefixes to stable codes', () => {
    expect(libraryBackupErrorCode(new Error('library-sync-connected: disconnect'))).toBe('sync-connected');
    expect(libraryBackupErrorCode(new Error('backup-invalid: checksum'))).toBe('invalid');
    expect(libraryBackupErrorCode('backup-newer: update')).toBe('newer');
    expect(libraryBackupErrorCode(new Error('disk full'))).toBe('unknown');
  });
});
