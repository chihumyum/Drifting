import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../../store/auth';
import { useOpenSignIn } from '../../auth/auth-dialog-store';
import { useProductSyncAuthority } from '../../../sync/product-authority-react';
import { productSyncCommands } from '../../../sync/product-commands';
import { useProductSyncRuntime } from '../../../sync/product-runtime-react';
import { synchronizeHostedNow } from '../../../sync/hosted/connect';
import { disconnectHosted } from '../../../sync/hosted/disconnect';
import { HostedAccountDetails } from './HostedAccountDetails';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';

export function AccountPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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
  const connected = authority.mode === 'hosted';
  const hostedTransition = authority.targetMode === 'hosted';
  const paused = connected && authority.status === 'cloud-paused';
  const accountReady = status === 'connected';
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
              <button
                className="set-btn"
                disabled={busy}
                onClick={() => void run(() => useAuthStore.getState().logout())}
              >
                {t('settings.hosted.sign_out')}
              </button>
            ) : (
              <button
                className="set-btn set-btn--primary"
                disabled={busy}
                onClick={() => openSignIn()}
              >
                {t('settings.hosted.sign_in')}
              </button>
            )
          }
        />
        {user && <HostedAccountDetails key={user.id} user={user} disabled={busy || !accountReady} />}
        <SettingsSectionHeader title={t('settings.hosted.sync_title')} />
        <SettingsRow
          label={t(connected ? 'settings.hosted.enabled' : 'settings.hosted.disabled')}
          desc={
            connected
              ? t('settings.hosted.projects', { count: authority.activeSyncGenerations })
              : t('settings.hosted.connect_description')
          }
          control={
            <button
              className="set-btn set-btn--primary"
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
            </button>
          }
        />
        {connected && authority.activeSyncGenerations > 0 && (
          <SettingsRow
            label={t(paused ? 'settings.hosted.paused' : 'settings.hosted.automatic')}
            desc={t('settings.hosted.automatic_description')}
            control={
              <button
                className="set-btn"
                disabled={busy}
                onClick={() => void run(() => productSyncCommands.setPaused(!paused))}
              >
                {t(paused ? 'settings.hosted.resume' : 'settings.hosted.pause')}
              </button>
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
                  : failure
                    ? t('settings.hosted.retrying')
                    : running || waiting || !syncedAt
                      ? t('settings.hosted.pending')
                      : t('settings.hosted.last_synced', {
                          time: new Date(syncedAt).toLocaleString(),
                        })
            }
            control={
              failure?.lastErrorCode ? (
                <span className="set-mono">{failure.lastErrorCode}</span>
              ) : null
            }
          />
        )}
        {(connected || hostedTransition) && (
          <SettingsRow
            label={t('settings.hosted.disconnect')}
            desc={t('settings.hosted.disconnect_description')}
            control={
              <button
                className="set-btn"
                disabled={busy || (connected && (paused || !accountReady))}
                onClick={() => void run(disconnectHosted)}
              >
                {t('settings.hosted.disconnect')}
              </button>
            }
          />
        )}
        {(connected || hostedTransition) && authority.errorCode && <p role="alert">{authority.errorCode}</p>}
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  );
}
