import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DatabaseOpenFailure,
  databasePlatform,
  type DatabaseOpenFailureData,
} from '../../platform/database';
import { publishDatabaseOpenFailure } from '../../platform/database-recovery-store';
import { platform } from '../../platform';
import { requestConfirmation } from '../../store/confirmation-store';

function diagnosticSummary(failure: DatabaseOpenFailureData): string {
  return JSON.stringify(
    {
      kind: 'drifting-database-recovery',
      code: failure.code,
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
  const { t } = useTranslation();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionId = failure.recoverySessionId;
  const backup = failure.safetyBackup;
  const created = useMemo(
    () => (backup ? new Date(backup.createdAtMs).toLocaleString() : null),
    [backup],
  );

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      if (error instanceof DatabaseOpenFailure && error.recoverySessionId) {
        publishDatabaseOpenFailure(error);
      }
      setNotice(error instanceof Error ? error.message : t('databaseRecovery.actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="database-recovery" role="alert" aria-live="assertive">
      <section className="database-recovery__card" aria-labelledby="database-recovery-title">
        <p className="database-recovery__eyebrow">Drifting Alpha · P0 Recovery</p>
        <h1 id="database-recovery-title">{t('databaseRecovery.title')}</h1>
        <p>{t('databaseRecovery.detail')}</p>
        <dl className="database-recovery__summary">
          <div>
            <dt>{t('databaseRecovery.errorCode')}</dt>
            <dd>{failure.code}</dd>
          </div>
          <div>
            <dt>{t('databaseRecovery.version')}</dt>
            <dd>
              {failure.sourceVersion ?? t('databaseRecovery.unknownVersion')} →{' '}
              {failure.targetVersion}
            </dd>
          </div>
          {backup && (
            <div>
              <dt>{t('databaseRecovery.safetyBackup')}</dt>
              <dd>
                {created} · {(backup.sizeBytes / 1024 / 1024).toFixed(1)} MiB
              </dd>
            </div>
          )}
        </dl>

        {notice && <p className="database-recovery__notice">{notice}</p>}

        <div className="database-recovery__actions">
          {sessionId && (
            <button
              ref={primaryRef}
              type="button"
              className="set-btn set-btn--primary"
              disabled={busy !== null}
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
              disabled={busy !== null}
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
              disabled={busy !== null}
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
              disabled={busy !== null}
              onClick={() =>
                void run('directory', () => databasePlatform.openBackupDirectory(sessionId))
              }
            >
              {t('databaseRecovery.openDirectory')}
            </button>
          )}
          <button
            ref={sessionId ? undefined : primaryRef}
            type="button"
            className="set-btn"
            disabled={busy !== null}
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
            disabled={busy !== null}
            onClick={() => void platform.window.close()}
          >
            {t('databaseRecovery.exit')}
          </button>
        </div>
      </section>
    </main>
  );
}
