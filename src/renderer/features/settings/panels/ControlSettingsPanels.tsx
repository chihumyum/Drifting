import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { exportAllProjectsAsRelationalMarkdown } from '../../../services/export/relational-markdown.service';
import { UpdateService } from '../../../services/update/update-service';
import { createSanitizedDiagnosticSummary } from '../../../services/diagnostics/sanitized-summary';
import { getSanitizedGoogleDriveOperationTraces } from '../../../services/diagnostics/google-drive-operation-trace';
import {
  SHORTCUT_ACTIONS,
  useShortcutsStore,
  type ShortcutActionId,
} from '../../../store/shortcuts-store';
import { acceleratorFromEvent, formatAccelerator } from '../../../lib/shortcuts';
import { events } from '../../../lib/events';
import { platform } from '../../../platform';
import { getPlatformRuntime } from '../../../platform/runtime';
import { productSyncCommands } from '../../../sync/product-commands';
import { useProductSyncAuthority } from '../../../sync/product-authority-react';
import { useProductSyncRuntime } from '../../../sync/product-runtime-react';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { hostedAccountSettingsEnabled } from '../hosted-settings-policy';
import {
  resolveGoogleDriveSettingsIssue,
  resolveGoogleDriveSettingsReadiness,
  type GoogleDriveSettingsIssue,
} from '../google-drive-settings-presentation';

export function KeysPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const bindings = useShortcutsStore((s) => s.bindings);
  const setBinding = useShortcutsStore((s) => s.setBinding);
  const resetBinding = useShortcutsStore((s) => s.resetBinding);
  const resetAll = useShortcutsStore((s) => s.resetAll);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setError(null);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;
      const conflict = (Object.entries(bindings) as [ShortcutActionId, string][]).find(
        ([id, accel]) => id !== recording && accel === accelerator,
      );
      if (conflict) {
        const def = SHORTCUT_ACTIONS.find((a) => a.id === conflict[0]);
        setError(
          t('settings.keys.conflict', {
            accelerator: formatAccelerator(accelerator),
            action: def ? t(`settings.keys.actions.${def.id}.label`) : conflict[0],
          }),
        );
        return;
      }
      setBinding(recording, accelerator);
      setRecording(null);
      setError(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, bindings, setBinding, t]);

  return (
    <section className="set-panel" ref={registerRef} id="keys">
      <SettingsPanelHeader
        kicker={t('settings.keys.kicker')}
        title={t('settings.keys.title')}
        sub={t('settings.keys.sub')}
      />

      {error && (
        <div className="set-note" style={{ marginBottom: 14, color: 'hsl(var(--accent))' }}>
          {error}
        </div>
      )}

      <div className="set-keys">
        <div className="set-keys__group-head">
          {t('settings.keys.allActions', { count: SHORTCUT_ACTIONS.length })}
        </div>
        {SHORTCUT_ACTIONS.map((action) => {
          const accel = bindings[action.id];
          const isRecording = recording === action.id;
          return (
            <div className="set-keys__row" key={action.id}>
              <div>
                <div className="set-keys__label">
                  {t(`settings.keys.actions.${action.id}.label`)}
                </div>
                <div className="set-row__desc" style={{ marginTop: 2 }}>
                  {t(`settings.keys.actions.${action.id}.desc`)}
                </div>
              </div>
              <span className="set-keys__cat">
                {isRecording ? t('settings.keys.recording') : ''}
              </span>
              <button
                className="set-keys__combo"
                onClick={() => {
                  setError(null);
                  setRecording(isRecording ? null : action.id);
                }}
                onDoubleClick={() => resetBinding(action.id)}
                style={{ background: 'transparent', border: 0, padding: 0 }}
                title={t('settings.keys.resetOneTitle')}
              >
                {(isRecording ? t('settings.keys.pressNewCombo') : formatAccelerator(accel))
                  .split('+')
                  .map((part, i, arr) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <span className="kbd">{part}</span>
                      {i < arr.length - 1 && <span className="kbd kbd--plus">+</span>}
                    </span>
                  ))}
              </button>
            </div>
          );
        })}
      </div>

      <SettingsRow
        label={t('settings.keys.resetAll')}
        desc={t('settings.keys.resetAllDesc')}
        control={
          <button className="set-btn" onClick={resetAll}>
            {t('settings.keys.reset')}
          </button>
        }
      />
    </section>
  );
}

export function SyncPanel({
  registerRef,
  projectImportEnabled,
}: {
  registerRef: SettingsRegisterRef;
  /** The caller owns a mounted project runtime and an ImportDialog host. */
  projectImportEnabled: boolean;
}) {
  const { t } = useTranslation();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [cloudBusy, setCloudBusy] = useState<
    | 'connect'
    | 'cancel-transition'
    | 'reauthorize'
    | 'pause'
    | 'disconnect'
    | null
  >(null);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [cloudIssue, setCloudIssue] = useState<GoogleDriveSettingsIssue | null>(null);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [transitionCancelArmed, setTransitionCancelArmed] = useState(false);
  const operationRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const authority = useProductSyncAuthority();
  const runtime = useProductSyncRuntime();
  const capabilities = getPlatformRuntime().capabilities;
  const googleDriveReadiness = resolveGoogleDriveSettingsReadiness(capabilities);
  const runtimePending = runtime.diagnostics?.generations.reduce(
    (total, generation) => ({
      changeSets: total.changeSets + generation.pending.pendingChangeSets,
      segments: total.segments + generation.pending.pendingSegments,
      transfers: total.transfers + generation.pending.pendingTransfers,
      gaps: total.gaps + generation.pending.openGaps,
      conflicts: total.conflicts + generation.pending.openConflicts,
      quarantined: total.quarantined + generation.pending.quarantinedObjects,
    }),
    { changeSets: 0, segments: 0, transfers: 0, gaps: 0, conflicts: 0, quarantined: 0 },
  );
  const runtimeFailure = runtime.diagnostics?.generations.find(
    (generation) => generation.lastOutcome === 'failed' && generation.lastErrorCode,
  );
  const isReadyInternalPublishRequestFailure =
    authority.status === 'cloud-ready' &&
    runtimeFailure?.lastErrorCode === 'invalid-request' &&
    (runtimeFailure.lastFailedPhase === 'publishing-blobs' ||
      runtimeFailure.lastFailedPhase === 'publishing-segments');
  const durableCloudOperation =
    authority.status === 'transitioning' ? authority.transitionKind : null;
  const visibleCloudOperation = cloudBusy ?? durableCloudOperation;
  const cloudProgressKind =
    visibleCloudOperation === 'disconnect'
      ? 'disconnect'
      : visibleCloudOperation === 'reauthorize'
        ? 'reauthorize'
        : visibleCloudOperation === 'cancel-transition'
          ? 'cancel'
          : visibleCloudOperation === 'pause'
            ? 'settings'
            : visibleCloudOperation
              ? 'connect'
              : null;
  const authorityStatusKey =
    authority.status === 'transitioning' && authority.transitionKind
      ? `settings.sync.transition_states.${authority.transitionKind}`
      : `settings.sync.cloud_states.${authority.status}`;
  const authorityIssue = resolveGoogleDriveSettingsIssue(authority.errorCode);
  const runtimeIssue = resolveGoogleDriveSettingsIssue(runtimeFailure?.lastErrorCode ?? null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.abort(new DOMException('Sync Settings closed', 'AbortError'));
    };
  }, []);

  const runCloudAction = async (
    action: NonNullable<typeof cloudBusy>,
    work: (signal: AbortSignal) => Promise<void>,
    successKey: string | null,
  ) => {
    // State updates are asynchronous; the ref closes the same-frame double-tap
    // window before a second native OAuth or revoke operation can begin.
    if (cloudBusy || operationRef.current) return;
    const controller = new AbortController();
    operationRef.current = controller;
    setCloudBusy(action);
    setCloudMessage(null);
    setCloudIssue(null);
    try {
      await work(controller.signal);
      if (mountedRef.current && successKey) setCloudMessage(t(successKey));
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) {
        setCloudIssue(resolveGoogleDriveSettingsIssue(error));
      }
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      if (mountedRef.current) setCloudBusy(null);
    }
  };

  const handleMarkdownExport = async () => {
    setExportBusy(true);
    setExportMessage(null);
    try {
      const result = await exportAllProjectsAsRelationalMarkdown();
      if (!result.canceled) {
        setExportMessage(t('settings.account.export_done', { count: result.documentCount }));
      }
    } catch (error) {
      setExportMessage(
        t('settings.account.export_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <section className="set-panel" ref={registerRef} id="sync">
      <SettingsPanelHeader
        kicker={t(authority.mode === 'local' ? 'settings.sync.local_kicker' : 'settings.sync.cloud_kicker')}
        title={t(authority.mode === 'local' ? 'settings.sync.local_title' : 'settings.sync.cloud_title')}
        sub={t(authority.mode === 'local' ? 'settings.sync.local_sub' : 'settings.sync.cloud_sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.sync.google_drive')} hint="GOOGLE" />
        <SettingsRow
          label={t('settings.sync.cloud_status')}
          desc={t('settings.sync.cloud_status_desc', {
            active: authority.activeSyncGenerations,
            ready: authority.readySyncGenerations,
          })}
          control={
            <span className="set-mono" style={{ color: 'hsl(var(--ink-3))' }}>
              {t(authorityStatusKey)}
            </span>
          }
        />
        <SettingsRow
          label={t('settings.sync.device_readiness')}
          desc={t(googleDriveReadiness.descriptionKey)}
          control={
            <span
              className="set-sync-readiness"
              data-state={googleDriveReadiness.available ? 'ready' : 'setup-required'}
              data-missing={googleDriveReadiness.missing.join(',') || undefined}
            >
              {t(
                googleDriveReadiness.available
                  ? 'settings.sync.device_readiness_ready'
                  : 'settings.sync.device_readiness_required',
              )}
            </span>
          }
        />

        {cloudProgressKind && (
          <div
            className="set-operation-feedback"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <Loader2 className="control-spinner" aria-hidden />
            <div>
              <div className="set-operation-feedback__title">
                {t(`settings.sync.operation_progress.${cloudProgressKind}.title`)}
              </div>
              <div className="set-operation-feedback__desc">
                {t(`settings.sync.operation_progress.${cloudProgressKind}.desc`)}
              </div>
            </div>
          </div>
        )}
        {cloudIssue && (
          <div
            className="set-sync-issue"
            role="alert"
            data-google-drive-issue={cloudIssue.id}
          >
            <div className="set-sync-issue__title">{t(cloudIssue.titleKey)}</div>
            <div className="set-sync-issue__desc">{t(cloudIssue.descriptionKey)}</div>
            <code>{cloudIssue.code}</code>
          </div>
        )}

        {authority.mode === 'local' &&
          (authority.status === 'local' ||
            authority.status === 'transitioning' ||
            authority.status === 'cloud-attention') && (
          <>
            {(authority.status === 'local' || authority.transitionKind === 'connect') && (
              <SettingsRow
                label={t('settings.sync.connect_google_drive')}
                desc={
                  !googleDriveReadiness.available
                    ? t(googleDriveReadiness.descriptionKey)
                    : t('settings.sync.connect_google_drive_desc')
                }
                control={
                  <button
                    type="button"
                    className="set-btn set-btn--primary"
                    disabled={!googleDriveReadiness.available || cloudBusy !== null}
                    onClick={() =>
                      void runCloudAction(
                        'connect',
                        async (signal) => {
                          await productSyncCommands.connectGoogleDrive(signal);
                        },
                        'settings.sync.connect_done',
                      )
                    }
                  >
                    {cloudBusy === 'connect' && (
                      <Loader2 className="control-spinner" aria-hidden />
                    )}
                    {cloudBusy === 'connect'
                      ? t('settings.sync.connecting')
                      : authority.transitionKind === 'connect'
                        ? t('settings.sync.retry_google_sign_in')
                        : t('settings.sync.connect')}
                  </button>
                }
              />
            )}
            {authority.transitionKind === 'connect' && (
              <SettingsRow
                label={t('settings.sync.cancel_pending_cloud')}
                desc={t('settings.sync.cancel_pending_cloud_desc')}
                control={
                  transitionCancelArmed ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="set-btn set-btn--danger"
                        disabled={cloudBusy !== null}
                        onClick={() =>
                          void runCloudAction(
                            'cancel-transition',
                            async (signal) => {
                              await productSyncCommands.cancelPendingGoogleDrive(signal);
                              setTransitionCancelArmed(false);
                            },
                            'settings.sync.cancel_pending_cloud_done',
                          )
                        }
                      >
                        {cloudBusy === 'cancel-transition' && (
                          <Loader2 className="control-spinner" aria-hidden />
                        )}
                        {cloudBusy === 'cancel-transition'
                          ? t('settings.sync.cancelling')
                          : t('settings.sync.confirm_cancel_pending_cloud')}
                      </button>
                      <button
                        type="button"
                        className="set-btn"
                        disabled={cloudBusy !== null}
                        onClick={() => setTransitionCancelArmed(false)}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="set-btn"
                      disabled={cloudBusy !== null}
                      onClick={() => setTransitionCancelArmed(true)}
                    >
                      {t('settings.sync.cancel_pending_cloud_action')}
                    </button>
                  )
                }
              />
            )}
          </>
        )}

        {authority.mode === 'google-drive' && authority.status !== 'transitioning' && (
          <>
            {authority.status === 'cloud-provisioning' && (
              <SettingsRow
                label={t('settings.sync.finish_provisioning')}
                desc={t('settings.sync.finish_provisioning_desc', {
                  count: authority.provisioningSyncGenerations,
                })}
                control={
                  <button
                    type="button"
                    className="set-btn"
                    disabled={cloudBusy !== null}
                    onClick={() => {
                      const requested = productSyncCommands.retryProvisioning();
                      setCloudMessage(
                        t(
                          requested
                            ? 'settings.sync.retry_requested'
                            : 'settings.sync.runtime_unavailable',
                        ),
                      );
                    }}
                  >
                    {t('settings.sync.retry')}
                  </button>
                }
              />
            )}
            {authority.status === 'cloud-attention' &&
              authority.errorCode === 'needs-reauth' && (
                <SettingsRow
                  label={t(
                    authority.transitionKind === 'disconnect'
                      ? 'settings.sync.reauthorize_disconnect_google_drive'
                      : 'settings.sync.reauthorize_google_drive',
                  )}
                  desc={t(
                    authority.transitionKind === 'disconnect'
                      ? 'settings.sync.reauthorize_disconnect_google_drive_desc'
                      : 'settings.sync.reauthorize_google_drive_desc',
                  )}
                  control={
                    <button
                      type="button"
                      className="set-btn set-btn--primary"
                      disabled={!googleDriveReadiness.available || cloudBusy !== null}
                      onClick={() =>
                        void runCloudAction(
                          'reauthorize',
                          async (signal) => {
                            await productSyncCommands.reauthorizeGoogleDrive();
                            if (authority.transitionKind === 'disconnect') {
                              await productSyncCommands.disconnectGoogleDrive(signal);
                              setDisconnectArmed(false);
                            }
                          },
                          authority.transitionKind === 'disconnect'
                            ? 'settings.sync.disconnect_done'
                            : 'settings.sync.reauthorize_done',
                        )
                      }
                    >
                      {cloudBusy === 'reauthorize' && (
                        <Loader2 className="control-spinner" aria-hidden />
                      )}
                      {cloudBusy === 'reauthorize'
                        ? t('settings.sync.reauthorizing')
                        : t(
                            authority.transitionKind === 'disconnect'
                              ? 'settings.sync.reauthorize_and_disconnect'
                              : 'settings.sync.reauthorize',
                          )}
                    </button>
                  }
                />
              )}
            {authority.status === 'cloud-ready' && (
              <SettingsRow
                label={t('settings.sync.sync_now')}
                desc={t('settings.sync.sync_now_desc')}
                control={
                  <button
                    type="button"
                    className="set-btn"
                    disabled={cloudBusy !== null || !runtime.mounted}
                    onClick={() => {
                      try {
                        setCloudIssue(null);
                        productSyncCommands.triggerManualSync();
                        setCloudMessage(t('settings.sync.sync_requested'));
                      } catch (error) {
                        setCloudMessage(null);
                        setCloudIssue(resolveGoogleDriveSettingsIssue(error));
                      }
                    }}
                  >
                    {t('settings.sync.sync_now')}
                  </button>
                }
              />
            )}
            {(authority.status === 'cloud-ready' || authority.status === 'cloud-paused') && (
              <SettingsRow
                label={
                  authority.status === 'cloud-paused'
                    ? t('settings.sync.resume_sync')
                    : t('settings.sync.pause_sync')
                }
                desc={t('settings.sync.pause_sync_desc')}
                control={
                  <button
                    type="button"
                    className="set-btn"
                    disabled={cloudBusy !== null}
                    onClick={() =>
                      void runCloudAction(
                        'pause',
                        async () => {
                          await productSyncCommands.setPaused(
                            authority.status !== 'cloud-paused',
                          );
                        },
                        authority.status === 'cloud-paused'
                          ? 'settings.sync.resume_done'
                          : 'settings.sync.pause_done',
                      )
                    }
                  >
                    {cloudBusy === 'pause' && (
                      <Loader2 className="control-spinner" aria-hidden />
                    )}
                    {authority.status === 'cloud-paused'
                      ? t('settings.sync.resume')
                      : t('settings.sync.pause')}
                  </button>
                }
              />
            )}
            <SettingsRow
              label={t('settings.sync.disconnect_google_drive')}
              desc={t(
                disconnectArmed
                  ? 'settings.sync.disconnect_confirm_desc'
                  : 'settings.sync.disconnect_google_drive_desc',
              )}
              control={
                disconnectArmed ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="set-btn set-btn--danger"
                      disabled={cloudBusy !== null}
                      onClick={() =>
                        void runCloudAction(
                          'disconnect',
                          async (signal) => {
                            await productSyncCommands.disconnectGoogleDrive(signal);
                            setDisconnectArmed(false);
                          },
                          'settings.sync.disconnect_done',
                        )
                      }
                    >
                      {cloudBusy === 'disconnect' && (
                        <Loader2 className="control-spinner" aria-hidden />
                      )}
                      {cloudBusy === 'disconnect'
                        ? t('settings.sync.disconnecting')
                        : t('settings.sync.confirm_disconnect')}
                    </button>
                    <button
                      type="button"
                      className="set-btn"
                      disabled={cloudBusy !== null}
                      onClick={() => setDisconnectArmed(false)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="set-btn"
                    disabled={cloudBusy !== null}
                    onClick={() => setDisconnectArmed(true)}
                  >
                    {authority.transitionKind === 'disconnect'
                      ? t('settings.sync.retry_disconnect')
                      : t('settings.sync.disconnect')}
                  </button>
                )
              }
            />
          </>
        )}

        {authority.errorCode && (
          <SettingsRow
            label={t(authorityIssue?.titleKey ?? 'settings.sync.attention_reason')}
            desc={t(authorityIssue?.descriptionKey ?? 'settings.sync.attention_reason_desc')}
            control={<span className="set-mono">{authorityIssue?.code ?? 'unexpected'}</span>}
          />
        )}
        {runtimeFailure?.lastErrorCode && (
          <SettingsRow
            label={t(
              isReadyInternalPublishRequestFailure
                ? 'settings.sync.last_sync_error'
                : (runtimeIssue?.titleKey ?? 'settings.sync.last_sync_error'),
            )}
            desc={t(
              isReadyInternalPublishRequestFailure
                ? 'settings.sync.last_sync_error_publish_invalid_desc'
                : (runtimeIssue?.descriptionKey ?? 'settings.sync.last_sync_error_desc'),
            )}
            control={
              <span className="set-mono">
                {[runtimeIssue?.code ?? 'unexpected', runtimeFailure.lastFailedPhase]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            }
          />
        )}
        {authority.mode === 'google-drive' && runtimePending && (
          <SettingsRow
            label={t('settings.sync.diagnostics')}
            desc={t('settings.sync.diagnostics_desc')}
            control={
              <span className="set-mono">
                {t('settings.sync.diagnostics_value', runtimePending)}
              </span>
            }
          />
        )}
        {cloudMessage && (
          <div className="set-sync-message" role="status">
            {cloudMessage}
          </div>
        )}
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.sync.local_data')} hint="LOCAL" />
        <SettingsRow
          label={t('settings.account.export_all')}
          desc={t('settings.account.export_all_desc')}
          control={
            <button className="set-btn" onClick={handleMarkdownExport} disabled={exportBusy}>
              {exportBusy
                ? t('settings.account.exporting')
                : t('settings.account.export_all_btn')}
            </button>
          }
        />
        {exportMessage && <div className="set-row__desc">{exportMessage}</div>}
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.sync.history')} hint="SNAPSHOTS" />
        <SettingsRow
          label={t('settings.sync.auto_snapshot')}
          desc={<>{t('settings.sync.auto_snapshot_desc')}</>}
          control={
            <span className="set-mono" style={{ color: 'hsl(var(--ink-3))' }}>
              {t('settings.sync.auto_snapshot_active')}
            </span>
          }
        />
      </div>

      {projectImportEnabled && (
        <div className="set-sec">
          <SettingsSectionHeader title={t('settings.sync.import_files')} hint="IMPORT" />
          <SettingsRow
            label={t('settings.sync.import_files')}
            desc={t('settings.sync.import_files_desc')}
            control={
              <button
                className="set-btn"
                onClick={() => {
                  events.emit('import:open');
                }}
              >
                {t('settings.sync.select_file')}
              </button>
            }
          />
        </div>
      )}
    </section>
  );
}

export function UpdatePanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const update = useSyncExternalStore(
    UpdateService.subscribe,
    UpdateService.getState,
    UpdateService.getState,
  );
  const [installArmed, setInstallArmed] = useState(false);
  const updaterAvailable =
    getPlatformRuntime().capabilities?.featureStatus.appUpdater === 'available';
  const busy = update.phase === 'checking' || update.phase === 'downloading';
  const progress =
    update.totalBytes && update.totalBytes > 0
      ? Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100))
      : null;

  return (
    <section className="set-panel" ref={registerRef} id="updates">
      <SettingsPanelHeader
        kicker={t('settings.update.kicker')}
        title={t('settings.update.title')}
        sub={t('settings.update.sub')}
      />

      <SettingsRow
        label={t('settings.update.current_version')}
        desc={t('settings.update.channel_desc')}
        control={
          <span className="set-mono">
            {getPlatformRuntime().appInfo?.version ?? '0.1.0-alpha.1'} · Alpha
          </span>
        }
      />

      {!updaterAvailable ? (
        <div className="set-note">{t('settings.update.unavailable')}</div>
      ) : (
        <>
          <SettingsRow
            label={
              update.update
                ? t('settings.update.available_version', { version: update.update.version })
                : t('settings.update.check')
            }
            desc={
              update.update?.notes ||
              (update.phase === 'idle'
                ? t('settings.update.no_update')
                : t(`settings.update.states.${update.phase}`))
            }
            control={
              update.phase === 'available' ? (
                <button
                  type="button"
                  className="set-btn set-btn--primary"
                  onClick={() => void UpdateService.download()}
                >
                  {t('settings.update.download')}
                </button>
              ) : update.phase === 'ready' ? (
                installArmed ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="set-btn set-btn--primary"
                      onClick={() => void UpdateService.install()}
                    >
                      {t('settings.update.confirm_install')}
                    </button>
                    <button
                      type="button"
                      className="set-btn"
                      onClick={() => setInstallArmed(false)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="set-btn set-btn--primary"
                    onClick={() => setInstallArmed(true)}
                  >
                    {t('settings.update.install')}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="set-btn"
                  disabled={busy}
                  onClick={() => void UpdateService.check({ manual: true })}
                >
                  {update.phase === 'checking'
                    ? t('settings.update.checking')
                    : t('settings.update.check_action')}
                </button>
              )
            }
          />
          {update.phase === 'downloading' && (
            <div className="set-row__desc">
              {progress === null
                ? t('settings.update.downloading')
                : t('settings.update.downloading_progress', { progress })}
            </div>
          )}
          {update.phase === 'ready' && (
            <div className="set-note">{t('settings.update.install_migration_safety')}</div>
          )}
          {update.error && (
            <div className="set-note" style={{ color: 'hsl(var(--accent))' }}>
              {t('settings.update.error', { error: update.error })}
            </div>
          )}
          {update.update && update.phase !== 'downloading' && (
            <button
              type="button"
              className="set-btn"
              disabled={busy}
              style={{ marginTop: 12 }}
              onClick={() => {
                setInstallArmed(false);
                void UpdateService.dismiss();
              }}
            >
              {t('settings.update.dismiss')}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function PrivacyPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const hostedSettings = hostedAccountSettingsEnabled();
  const authority = useProductSyncAuthority();
  const runtime = useProductSyncRuntime();
  const update = useSyncExternalStore(UpdateService.subscribe, UpdateService.getState);
  const [diagnosticMessage, setDiagnosticMessage] = useState<string | null>(null);

  const copyDiagnostics = async () => {
    setDiagnosticMessage(null);
    try {
      const summary = createSanitizedDiagnosticSummary({
        runtime: getPlatformRuntime(),
        authority,
        sync: runtime,
        update,
        googleDriveOperationTraces: getSanitizedGoogleDriveOperationTraces(),
      });
      await navigator.clipboard.writeText(summary);
      setDiagnosticMessage(t('settings.privacy.diagnosticsCopied'));
    } catch {
      setDiagnosticMessage(t('settings.privacy.diagnosticsCopyFailed'));
    }
  };

  return (
    <section className="set-panel" ref={registerRef} id="privacy">
      <SettingsPanelHeader
        kicker={t('settings.privacy.kicker')}
        title={t('settings.privacy.title')}
        sub={t('settings.privacy.sub')}
      />

      <div className="set-note">
        {t('settings.privacy.noteA')}
        <br />
        <span className="set-mono" style={{ display: 'inline-block', marginTop: 6 }}>
          {t('settings.privacy.noteBPrefix')} <b>{t('settings.privacy.noteBStrong')}</b>{' '}
          {t('settings.privacy.noteBSuffix')}
        </span>
      </div>

      {hostedSettings && (
        <div className="set-sec" style={{ marginTop: 18 }}>
          <SettingsSectionHeader title={t('settings.privacy.dataUsage')} hint="YOUR CONTROL" />
          <SettingsRow
            label={t('settings.privacy.improveModels')}
            desc={t('settings.privacy.improveModelsDesc')}
            control={
              <span title={t('settings.common.not_available_yet')}>
                <SettingsToggle on={false} onChange={() => undefined} disabled />
              </span>
            }
          />
          <SettingsRow
            label={t('settings.privacy.usageStats')}
            desc={t('settings.privacy.usageStatsDesc')}
            control={
              <span title={t('settings.common.not_available_yet')}>
                <SettingsToggle on={false} onChange={() => undefined} disabled />
              </span>
            }
          />
          <SettingsRow
            label={t('settings.privacy.crashLogs')}
            desc={t('settings.privacy.crashLogsDesc')}
            control={
              <span title={t('settings.common.not_available_yet')}>
                <SettingsToggle on={false} onChange={() => undefined} disabled />
              </span>
            }
          />
        </div>
      )}

      <SettingsRow
        label={t('settings.privacy.fullPolicy')}
        desc={<span className="set-mono">{t('settings.privacy.lastUpdated')}</span>}
        control={
          <button
            className="set-btn"
            onClick={() =>
              void platform.material.openExternal(
                'https://drifting.app/privacy',
              )
            }
          >
            {t('settings.common.open_in_browser')}
          </button>
        }
      />
      <SettingsRow
        label={t('settings.privacy.diagnostics')}
        desc={t('settings.privacy.diagnosticsDesc')}
        control={
          <button className="set-btn" onClick={() => void copyDiagnostics()}>
            {t('settings.privacy.copyDiagnostics')}
          </button>
        }
      />
      {diagnosticMessage && <div className="set-note">{diagnosticMessage}</div>}
    </section>
  );
}

export function AboutPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const appVersion = getPlatformRuntime().appInfo?.version ?? '0.1.0';
  return (
    <section className="set-panel" ref={registerRef} id="about">
      <SettingsPanelHeader
        kicker={t('settings.about.kicker')}
        title={t('settings.about.title')}
        sub={t('settings.about.sub')}
      />

      <div className="set-about">
        <div className="set-about__glyph">D</div>
        <div className="set-about__main">
          <div className="set-about__name">
            Drifting <em>{t('settings.about.cnName')}</em>
          </div>
          <div className="set-about__meta">
            <span>
              {t('settings.about.version')} <b>{appVersion}</b>
            </span>
            <span>
              {t('settings.about.channel')} <b>{t('settings.about.channelPreAlpha')}</b>
            </span>
            <span>
              {t('settings.about.engine')} <b>Tiptap + SQLite</b>
            </span>
          </div>
        </div>
      </div>

      <div className="set-sec" style={{ marginTop: 24 }}>
        <SettingsSectionHeader title={t('settings.about.credits')} hint="CREDITS" />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.fonts')}</span>}
          desc={t('settings.about.fontsDesc')}
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.openSource')}</span>}
          desc="Tiptap · Yjs · Drizzle · React · Tauri 2"
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal(
                  'https://github.com/chihumyum/Drifting/blob/main/THIRD_PARTY_NOTICES.md',
                )
              }
            >
              {t('settings.about.viewList')}
            </button>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.sourceCode')}</span>}
          desc={t('settings.about.sourceCodeDesc')}
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal('https://github.com/chihumyum/Drifting')
              }
            >
              {t('settings.about.viewSource')}
            </button>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.license')}</span>}
          desc={t('settings.about.licenseDesc')}
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal(
                  'https://github.com/chihumyum/Drifting/blob/main/LICENSE',
                )
              }
            >
              {t('settings.about.viewLicense')}
            </button>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.driveDataUse')}</span>}
          desc={t('settings.about.driveDataUseDesc')}
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal(
                  'https://drifting.app/google-drive-data-use',
                )
              }
            >
              {t('settings.common.open_in_browser')}
            </button>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.knownIssues')}</span>}
          desc={t('settings.about.knownIssuesDesc')}
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal('https://drifting.app/known-issues')
              }
            >
              {t('settings.common.open_in_browser')}
            </button>
          }
        />
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.about.contact')} hint="HELLO" />
        <SettingsRow
          label={t('settings.about.support')}
          desc={t('settings.about.supportDesc')}
          control={
            <button
              className="set-btn"
              onClick={() => void platform.material.openExternal('https://drifting.app/support')}
            >
              {t('settings.common.open_in_browser')}
            </button>
          }
        />
        <SettingsRow
          label={t('settings.about.emailTeam')}
          desc={<span className="set-mono">hi@drifting.app</span>}
          control={
            <button
              className="set-btn"
              onClick={() => void platform.material.openExternal('mailto:hi@drifting.app')}
            >
              {t('settings.about.writeEmail')}
            </button>
          }
        />
        <SettingsRow
          label={t('settings.about.submitFeedback')}
          desc={t('settings.about.submitFeedbackDesc')}
          control={
            <button
              className="set-btn"
              onClick={() =>
                void platform.material.openExternal(
                  'mailto:hi@drifting.app?subject=Drifting%20Alpha%20Feedback',
                )
              }
            >
              {t('settings.about.feedback')}
            </button>
          }
        />
      </div>

      <p
        style={{
          margin: '48px 0 0',
          fontFamily: 'var(--font-sans)',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'hsl(var(--ink-4))',
          textAlign: 'center',
          lineHeight: 1.6,
        }}
      >
        {t('settings.about.tagline')}
      </p>
    </section>
  );
}
