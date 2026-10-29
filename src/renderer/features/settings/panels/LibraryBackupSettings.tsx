import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPlatformRuntime } from '../../../platform/runtime';
import type { LibraryBackupSummary } from '../../../platform/database';
import {
  libraryBackupErrorCode,
  libraryBackupService,
} from '../../../services/backup/library-backup.service';
import { useAuthStore } from '../../../store/auth';
import { requestConfirmation } from '../../../store/confirmation-store';
import { useProductSyncAuthority } from '../../../sync/product-authority-react';
import { SettingsButton, SettingsRow } from '../SettingsPrimitives';

type Busy = 'export' | 'inspect' | 'restore' | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Complete `.drifting` backup and restore for the local library (desktop). */
export function LibraryBackupSettings() {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user.id);
  const authority = useProductSyncAuthority();
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (getPlatformRuntime().target !== 'desktop') return null;

  const localOnly = authority.status === 'local';
  const blockedReason = !authority.loaded
    ? t('settings.sync.backup.loading')
    : localOnly
      ? null
      : t('settings.sync.backup.syncConnected');

  const describeError = (error: unknown) =>
    t(`settings.sync.backup.errors.${libraryBackupErrorCode(error)}`, {
      detail: error instanceof Error ? error.message : String(error),
    });

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setMessage('');
    try {
      await action();
    } catch (error) {
      if (mounted.current) setMessage(describeError(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const summaryText = (summary: LibraryBackupSummary) =>
    t('settings.sync.backup.summary', {
      projects: summary.projects.length,
      assets: summary.assetFileCount,
      size: formatBytes(summary.packageSizeBytes),
    });

  const exportBackup = () =>
    run('export', async () => {
      const result = await libraryBackupService.exportBackup();
      if (result.canceled || !mounted.current) return;
      const missing = result.summary.missingAssetCount > 0
        ? ` ${t('settings.sync.backup.missingAssets', { count: result.summary.missingAssetCount })}`
        : '';
      setMessage(`${t('settings.sync.backup.exported', { file: result.fileName ?? '' })} ${summaryText(result.summary)}${missing}`);
    });

  const restoreBackup = () =>
    run('inspect', async () => {
      const inspected = await libraryBackupService.inspectBackup(userId);
      if (inspected.canceled) return;
      const { summary } = inspected;
      const projectNames = summary.projects.slice(0, 5).map((project) => project.name).join('、');
      const confirmed = await requestConfirmation(
        t('settings.sync.backup.restoreConfirm', {
          file: inspected.fileName ?? '',
          date: new Date(summary.createdAtMs).toLocaleString(),
          summary: summaryText(summary),
          projects: projectNames || t('settings.sync.backup.noProjects'),
        }),
        {
          title: t('settings.sync.backup.restoreTitle'),
          confirmLabel: t('settings.sync.backup.restoreConfirmButton'),
          destructive: true,
        },
      );
      if (!confirmed) {
        await libraryBackupService.discardBackup(inspected.restoreId);
        return;
      }
      if (mounted.current) setBusy('restore');
      // Success reloads the window; failure leaves the current library open.
      await libraryBackupService.restoreBackup(inspected.restoreId, userId);
    });

  return (
    <div>
      <SettingsRow
        label={t('settings.sync.backup.exportTitle')}
        desc={blockedReason ?? t('settings.sync.backup.exportDesc')}
        control={
          <SettingsButton onClick={exportBackup} disabled={busy !== null || !localOnly}>
            {busy === 'export' ? t('settings.sync.backup.exporting') : t('settings.sync.backup.exportButton')}
          </SettingsButton>
        }
      />
      <SettingsRow
        label={t('settings.sync.backup.restoreTitle')}
        desc={blockedReason ?? t('settings.sync.backup.restoreDesc')}
        control={
          <div className="set-actions set-actions--end">
            <SettingsButton onClick={restoreBackup} disabled={busy !== null || !localOnly}>
              {busy === 'restore'
                ? t('settings.sync.backup.restoring')
                : busy === 'inspect'
                  ? t('settings.sync.backup.inspecting')
                  : t('settings.sync.backup.restoreButton')}
            </SettingsButton>
            <SettingsButton
              variant="ghost"
              onClick={() => void libraryBackupService.openSafetyDirectory().catch((error: unknown) => setMessage(describeError(error)))}
              disabled={busy !== null}
            >
              {t('settings.sync.backup.openSafety')}
            </SettingsButton>
          </div>
        }
      />
      {message && (
        <p role="status" className="set-row__desc">
          {message}
        </p>
      )}
    </div>
  );
}
