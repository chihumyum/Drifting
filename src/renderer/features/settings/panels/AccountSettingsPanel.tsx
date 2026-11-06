import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/auth';
import { useOpenSignIn } from '../../auth/auth-dialog-store';
import { requestSignOut } from '../../auth/sign-out';
import { useProductSyncAuthority } from '../../../sync/product-authority-react';
import { productSyncCommands } from '../../../sync/product-commands';
import { useProductSyncRuntime } from '../../../sync/product-runtime-react';
import { synchronizeHostedNow } from '../../../sync/hosted/connect';
import { countHostedUnuploadedChanges, disconnectHosted } from '../../../sync/hosted/disconnect';
import { formatStorageBytes, readHostedUsage, type HostedUsage } from '../../../sync/hosted/quota';
import { HostedAccountDetails } from './HostedAccountDetails';
import { HostedRestoreMeter } from '../../sync-status/HostedRestoreProgress';
import { useHostedRestoreStatus } from '../../sync-status/hosted-restore-status';
import {
  SettingsButton,
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { useShareLinkStore } from '../../share-links/share-link-store';
import { syncConnectErrorText } from '../../../sync/hosted/connect-error-text';
import { useShareLinksDialogStore } from '../../share-links/share-links-dialog-store';

export function AccountPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t, i18n } = useTranslation();
  const openSignIn = useOpenSignIn();
  const user = useAuthStore((s) => s.hostedUser);
  const status = useAuthStore((s) => s.hostedStatus);
  const authority = useProductSyncAuthority();
  const runtime = useProductSyncRuntime();
  const generations = runtime.diagnostics?.generations ?? [];
  const failure = generations.find((item) => item.lastOutcome === 'failed');
  const waiting = generations.some((item) =>
    Object.values(item.pending).some((count) => count > 0),
  );
  const running = generations.some((item) => item.phase !== 'idle');
  const syncedAt =
    generations.length && generations.every((item) => item.lastConvergedAtMs !== null)
      ? Math.min(...generations.map((item) => item.lastConvergedAtMs!))
      : null;
  // A connect restoring this library (automatic after signing in to a new
  // account library, or started here) shows its progress instead of the button.
  const restore = useHostedRestoreStatus();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [usage, setUsage] = useState<HostedUsage | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const run = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setMessage(null);
    try {
      await action(controller.signal);
      if (!controller.signal.aborted) setMessage(t('settings.hosted.done'));
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  // Opens the sign-out dialog while this Mac holds changes the cloud lacks.
  const signOut = async () => {
    if (operation.current) return;
    setBusy(true);
    setMessage(null);
    try {
      await requestSignOut();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const connected = authority.mode === 'hosted';
  const hostedTransition = authority.targetMode === 'hosted';
  const paused = connected && authority.status === 'cloud-paused';
  const accountReady = status === 'connected';
  useEffect(() => {
    if (!connected || !accountReady) return undefined;
    const controller = new AbortController();
    void readHostedUsage({ maxAgeMs: 0, signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setUsage(value);
    });
    return () => controller.abort();
  }, [connected, accountReady, syncedAt]);
  const usageRatio = usage && usage.quotaBytes > 0 ? Math.min(1, usage.usedBytes / usage.quotaBytes) : 0;
  return (
    <section className="set-panel" ref={registerRef} id="account">
      <SettingsPanelHeader
        kicker="DRIFTING"
        title={t('settings.hosted.title')}
        sub={t('settings.hosted.description')}
      />
      <div className="set-sec">
        <SettingsRow
          label={user?.email ?? t('settings.hosted.no_account')}
          desc={t(`settings.hosted.session.${status}`)}
          control={
            accountReady ? (
              <SettingsButton disabled={busy} onClick={() => void signOut()}>
                {t('settings.hosted.sign_out')}
              </SettingsButton>
            ) : (
              <SettingsButton variant="primary" disabled={busy} onClick={() => openSignIn()}>
                {t('settings.hosted.sign_in')}
              </SettingsButton>
            )
          }
        />
        {user && <HostedAccountDetails key={user.id} user={user} disabled={busy || !accountReady} />}
        {user && accountReady && <ShareLinksRow />}
        <SettingsSectionHeader title={t('settings.hosted.sync_title')} />
        <SettingsRow
          label={t(
            restore
              ? 'settings.hosted.restore.title'
              : connected
                ? 'settings.hosted.enabled'
                : 'settings.hosted.disabled',
          )}
          desc={
            restore
              ? restore.text
              : connected
                ? t('settings.hosted.projects', { count: authority.activeSyncGenerations })
                : t('settings.hosted.connect_description')
          }
          control={
            restore ? (
              <span className="set-storage">
                <HostedRestoreMeter ratio={restore.ratio} label={t('settings.hosted.restore.title')} />
                {restore.ratio !== null && (
                  <span className="set-storage__share">{Math.round(restore.ratio * 100)}%</span>
                )}
              </span>
            ) : (
            <SettingsButton
              variant="primary"
              disabled={busy || !accountReady || paused}
              onClick={() => void run(synchronizeHostedNow)}
            >
              {t(
                busy
                  ? 'settings.hosted.working'
                  : connected
                    ? 'settings.hosted.sync_now'
                    : 'settings.hosted.connect',
              )}
            </SettingsButton>
            )
          }
        />
        {connected && authority.activeSyncGenerations > 0 && (
          <SettingsRow
            label={t(paused ? 'settings.hosted.paused' : 'settings.hosted.automatic')}
            desc={t('settings.hosted.automatic_description')}
            control={
              <SettingsButton disabled={busy} onClick={() => void run(() => productSyncCommands.setPaused(!paused))}>
                {t(paused ? 'settings.hosted.resume' : 'settings.hosted.pause')}
              </SettingsButton>
            }
          />
        )}
        {connected && (
          <SettingsRow
            label={t('settings.hosted.progress')}
            desc={
              status !== 'connected'
                ? t(`settings.hosted.session.${status}`)
                : paused
                  ? t('settings.hosted.paused')
                  : runtime.activationFailed
                    ? t('settings.hosted.not_started')
                  : failure
                    ? t('settings.hosted.retrying')
                    : running || waiting || !syncedAt
                      ? t('settings.hosted.pending')
                      : t('settings.hosted.last_synced', {
                          time: new Date(syncedAt).toLocaleString(i18n.language),
                        })
            }
            control={
              failure?.lastErrorCode ? (
                <span className="set-mono">{failure.lastErrorCode}</span>
              ) : null
            }
          />
        )}
        {connected && failure?.lastErrorCode === 'QUOTA_EXCEEDED' && (
          <p role="alert" className="set-account-message">{t('settings.hosted.quota_blocked')}</p>
        )}
        {connected && usage && (
          <SettingsRow
            label={t('settings.hosted.storage')}
            desc={t('settings.hosted.storage_description', {
              used: formatStorageBytes(usage.usedBytes),
              quota: formatStorageBytes(usage.quotaBytes),
            })}
            control={
              // The progress hairline, and the share read beneath it.
              <span className="set-storage">
                <span
                  className="ui-progress"
                  role="meter"
                  aria-label={t('settings.hosted.storage')}
                  aria-valuemin={0}
                  aria-valuemax={usage.quotaBytes}
                  aria-valuenow={Math.min(usage.usedBytes, usage.quotaBytes)}
                >
                  <span
                    className="ui-progress__fill"
                    data-full={usageRatio >= 0.9 ? 'true' : undefined}
                    style={{ width: `${Math.round(usageRatio * 100)}%` }}
                  />
                </span>
                <span className="set-storage__share">{Math.round(usageRatio * 100)}%</span>
              </span>
            }
          />
        )}
        {(connected || hostedTransition) && (
          <DisconnectRow
            run={run}
            busy={busy}
            canUpload={connected && accountReady && !paused && runtime.mounted}
          />
        )}
        {(connected || hostedTransition) && authority.errorCode && (
          <p role="alert" className="set-account-message">{syncConnectErrorText(authority.errorCode, t)}</p>
        )}
        {message && <p role="status" className="set-account-message">{message}</p>}
      </div>
    </section>
  );
}

/**
 * Disconnecting first uploads what only this Mac holds, showing how much is
 * left, and can stop waiting at any time. Signed out or paused, nothing can
 * upload: it says how many changes would stay on this Mac before going ahead.
 */
function DisconnectRow({
  run,
  busy,
  canUpload,
}: {
  run: (action: (signal: AbortSignal) => Promise<unknown>) => Promise<void>;
  busy: boolean;
  canUpload: boolean;
}) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [unuploaded, setUnuploaded] = useState<number | null>(null);
  const stopWaiting = useRef<AbortController | null>(null);
  const disconnect = (uploadFirst: boolean) => {
    const stop = new AbortController();
    stopWaiting.current = stop;
    setUnuploaded(null);
    setRemaining(null);
    setUploading(uploadFirst);
    void run((signal) =>
      disconnectHosted(signal, { uploadFirst, stopWaiting: stop.signal, onRemaining: setRemaining }),
    ).finally(() => {
      if (stopWaiting.current === stop) stopWaiting.current = null;
      setUploading(false);
    });
  };
  const start = () => {
    if (canUpload) {
      disconnect(true);
      return;
    }
    void countHostedUnuploadedChanges().then((count) =>
      count > 0 ? setUnuploaded(count) : disconnect(false),
    );
  };
  return (
    <SettingsRow
      label={t('settings.hosted.disconnect')}
      desc={
        uploading
          ? remaining === null
            ? t('settings.hosted.working')
            : t('settings.hosted.disconnect_uploading', { count: remaining })
          : unuploaded !== null
            ? t('settings.hosted.disconnect_unuploaded', { count: unuploaded })
            : t('settings.hosted.disconnect_description')
      }
      control={
        uploading ? (
          <SettingsButton onClick={() => stopWaiting.current?.abort()}>
            {t('settings.hosted.disconnect_now')}
          </SettingsButton>
        ) : unuploaded !== null ? (
          <SettingsButton disabled={busy} onClick={() => disconnect(false)}>
            {t('settings.hosted.disconnect_anyway')}
          </SettingsButton>
        ) : (
          <SettingsButton disabled={busy} onClick={start}>
            {t('settings.hosted.disconnect')}
          </SettingsButton>
        )
      }
    />
  );
}

/** The account's share links: how many, and the list (features/share-links). */
function ShareLinksRow() {
  const { t } = useTranslation();
  const count = useShareLinkStore((state) => state.shares.length);
  useEffect(() => {
    void useShareLinkStore.getState().refresh(60_000).catch(() => undefined);
  }, []);
  return (
    <SettingsRow
      label={t('shareLink.listTitle')}
      desc={t('shareLink.count', { count })}
      control={
        <SettingsButton onClick={() => useShareLinksDialogStore.getState().show()}>
          {t('shareLink.view')}
        </SettingsButton>
      }
    />
  );
}
