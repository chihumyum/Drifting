import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DatabaseOpenFailure,
  databaseOpenFailureCause,
  databasePlatform,
  type DatabaseOpenFailureData,
} from '../../platform/database';
import { publishDatabaseOpenFailure } from '../../platform/database-recovery-store';
import { platform } from '../../platform';
import { requestConfirmation } from '../../store/confirmation-store';
import { reportCrash } from '../../services/diagnostics/crash-reporter';
import { redactHomePaths } from '../../services/diagnostics/crash-sanitize';
import { UpdateService } from '../../services/update/update-service';
import { useFeedbackDialogStore } from '../../features/feedback/feedback-dialog-store';

function diagnosticSummary(failure: DatabaseOpenFailureData): string {
  return JSON.stringify(
    {
      kind: 'drifting-database-recovery',
      code: failure.code,
      detail: failure.detail ? redactHomePaths(failure.detail) : null,
      recoverySessionId: failure.recoverySessionId,
      sourceVersion: failure.sourceVersion,
      targetVersion: failure.targetVersion,
      safetyBackup: failure.safetyBackup
        ? {
            backupId: failure.safetyBackup.backupId,
            sha256: failure.safetyBackup.sha256,
            sizeBytes: failure.safetyBackup.sizeBytes,
            createdAtMs: failure.safetyBackup.createdAtMs,
          }
        : null,
    },
    null,
    2,
  );
}

export function DatabaseRecoveryBoundary({ failure }: { failure: DatabaseOpenFailure }) {
  const { t, i18n } = useTranslation();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionId = failure.recoverySessionId;
  const backup = failure.safetyBackup;
  const update = useSyncExternalStore(
    UpdateService.subscribe,
    UpdateService.getState,
    UpdateService.getState,
  );
  const offered = update.update;
  const updating = update.phase === 'downloading' || update.phase === 'installing';
  const progress =
    update.totalBytes && update.totalBytes > 0
      ? Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100))
      : null;
  // One thing at a time: no restore while an update installs, and the reverse.
  const locked = busy !== null || updating;
  const created = useMemo(
    () => (backup ? new Date(backup.createdAtMs).toLocaleString(i18n.language) : null),
    [backup, i18n.language],
  );

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    // The ordinary check waits for a library that may never open, and a newer
    // release can be the only way back in: look for one from here.
    void UpdateService.check({ manual: true });
  }, []);

  useEffect(() => {
    // The library could not be opened or migrated; the author may lose access.
    reportCrash({
      kind: 'integrity',
      severity: 'fatal',
      code: `database-open-failed:${failure.code}`,
      name: failure.name,
      message: failure.message,
      context: {
        sourceVersion: failure.sourceVersion ?? 'unknown',
        targetVersion: failure.targetVersion,
        safetyBackup: Boolean(failure.safetyBackup),
        // `code` names the step; this is what SQLite or the system said.
        cause: databaseOpenFailureCause(failure.detail) ?? 'unknown',
      },
    });
  }, [failure]);

  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      if (error instanceof DatabaseOpenFailure && error.recoverySessionId) {
        publishDatabaseOpenFailure(error);
      }
      setNotice(
        error instanceof DatabaseOpenFailure && error.detail
          ? error.detail
          : error instanceof Error
            ? error.message
            : t('databaseRecovery.actionFailed'),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="database-recovery" role="alert" aria-live="assertive">
      <section className="database-recovery__card" aria-labelledby="database-recovery-title">
        <p className="database-recovery__eyebrow">Drifting Alpha · P0 Recovery</p>
        <h1 id="database-recovery-title">
          {t(sessionId ? 'databaseRecovery.title' : 'databaseRecovery.openTitle')}
        </h1>
        <p>{t(sessionId ? 'databaseRecovery.detail' : 'databaseRecovery.openDetail')}</p>
        <dl className="database-recovery__summary">
          <div>
            <dt>{t('databaseRecovery.errorCode')}</dt>
            <dd>{failure.code}</dd>
          </div>
          {failure.detail && (
            <div>
              <dt>{t('databaseRecovery.reason')}</dt>
              <dd>{failure.detail}</dd>
            </div>
          )}
          {sessionId && (
            <div>
              <dt>{t('databaseRecovery.version')}</dt>
              <dd>
                {failure.sourceVersion ?? t('databaseRecovery.unknownVersion')} →{' '}
                {failure.targetVersion}
              </dd>
            </div>
          )}
          {backup && (
            <div>
              <dt>{t('databaseRecovery.safetyBackup')}</dt>
              <dd>
                {created} · {(backup.sizeBytes / 1024 / 1024).toFixed(1)} MiB
              </dd>
            </div>
          )}
          {offered && (
            <div>
              <dt>{t('settings.update.check')}</dt>
              <dd>
                {offered.version}
                {update.phase !== 'available' && ` · ${t(`settings.update.states.${update.phase}`)}`}
              </dd>
            </div>
          )}
        </dl>

        {notice && <p className="database-recovery__notice">{notice}</p>}

        <div className="database-recovery__actions">
          {offered && (
            <button
              type="button"
              className="set-btn set-btn--primary"
              disabled={locked}
              onClick={() => void UpdateService.install().catch(() => undefined)}
            >
              {update.phase === 'installing'
                ? t('settings.update.installing')
                : update.phase === 'downloading'
                  ? progress === null
                    ? t('settings.update.downloading')
                    : t('settings.update.downloading_progress', { progress })
                  : t('settings.update.install')}
            </button>
          )}
          {!sessionId && (
            <button
              ref={primaryRef}
              type="button"
              className={offered ? 'set-btn' : 'set-btn set-btn--primary'}
              disabled={locked}
              onClick={() => window.location.reload()}
            >
              {t('databaseRecovery.retryOpen')}
            </button>
          )}
          {sessionId && (
            <button
              ref={primaryRef}
              type="button"
              className={offered ? 'set-btn' : 'set-btn set-btn--primary'}
              disabled={locked}
              onClick={() =>
                void run('retry', async () => {
                  await databasePlatform.retryMigration(sessionId);
                  window.location.reload();
                })
              }
            >
              {busy === 'retry'
                ? t('databaseRecovery.retrying')
                : t('databaseRecovery.retry')}
            </button>
          )}
          {backup && sessionId && (
            <button
              type="button"
              className="set-btn"
              disabled={locked}
              onClick={() =>
                void (async () => {
                  const confirmed = await requestConfirmation(
                    t('databaseRecovery.restoreConfirm'),
                  );
                  if (!confirmed) return;
                  await run('restore', async () => {
                    await databasePlatform.restoreSafetyBackup(sessionId, backup.backupId);
                    window.location.reload();
                  });
                })()
              }
            >
              {busy === 'restore'
                ? t('databaseRecovery.restoring')
                : t('databaseRecovery.restore')}
            </button>
          )}
          {backup && sessionId && (
            <button
              type="button"
              className="set-btn"
              disabled={locked}
              onClick={() =>
                void run('export', async () => {
                  const result = await databasePlatform.exportSafetyBackup(
                    sessionId,
                    backup.backupId,
                  );
                  if (result.ok) setNotice(t('databaseRecovery.exported'));
                })
              }
            >
              {t('databaseRecovery.export')}
            </button>
          )}
          {sessionId && (
            <button
              type="button"
              className="set-btn"
              disabled={locked}
              onClick={() =>
                void run('directory', () => databasePlatform.openBackupDirectory(sessionId))
              }
            >
              {t('databaseRecovery.openDirectory')}
            </button>
          )}
          {!sessionId && (
            <button
              type="button"
              className="set-btn"
              disabled={locked}
              onClick={() => void run('directory', () => databasePlatform.openDatabaseDirectory())}
            >
              {t('databaseRecovery.openDataDirectory')}
            </button>
          )}
          <button
            type="button"
            className="set-btn"
            disabled={locked}
            onClick={() => useFeedbackDialogStore.getState().show()}
          >
            {t('feedback.title')}
          </button>
          <button
            type="button"
            className="set-btn"
            disabled={locked}
            onClick={() =>
              void run('copy', async () => {
                await navigator.clipboard.writeText(diagnosticSummary(failure));
                setNotice(t('databaseRecovery.copied'));
              })
            }
          >
            {t('databaseRecovery.copyDiagnostics')}
          </button>
          <button
            type="button"
            className="set-btn database-recovery__exit"
            disabled={locked}
            onClick={() => void platform.window.close()}
          >
            {t('databaseRecovery.exit')}
          </button>
        </div>
      </section>
    </main>
  );
}
