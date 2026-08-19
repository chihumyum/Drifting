import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exportAllProjectsAsRelationalMarkdown } from '../../../services/export/relational-markdown.service';
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
  const [cloudBusy, setCloudBusy] = useState<string | null>(null);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const [transitionCancelArmed, setTransitionCancelArmed] = useState(false);
  const operationRef = useRef<AbortController | null>(null);
  const authority = useProductSyncAuthority();
  const runtime = useProductSyncRuntime();
  const capabilities = getPlatformRuntime().capabilities;
  const googleDriveOAuthAvailable =
    capabilities?.featureStatus.googleDriveOAuth === 'available';
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
  useEffect(
    () => () => {
      operationRef.current?.abort(new DOMException('Sync Settings closed', 'AbortError'));
    },
    [],
  );

  const runCloudAction = async (
    action: string,
    work: (signal: AbortSignal) => Promise<void>,
    successKey: string | null,
  ) => {
    if (cloudBusy) return;
    const controller = new AbortController();
    operationRef.current = controller;
    setCloudBusy(action);
    setCloudMessage(null);
    try {
      await work(controller.signal);
      if (successKey) setCloudMessage(t(successKey));
    } catch (error) {
      if (!controller.signal.aborted) {
        setCloudMessage(
          t('settings.sync.operation_failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      setCloudBusy(null);
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
              {t(`settings.sync.cloud_states.${authority.status}`)}
            </span>
          }
        />

        {authority.mode === 'local' &&
          (authority.status === 'local' ||
            authority.status === 'transitioning' ||
            authority.status === 'cloud-attention') && (
          <>
            {(authority.status === 'local' || authority.transitionKind === 'connect') && (
              <SettingsRow
                label={t('settings.sync.connect_google_drive')}
                desc={
                  !googleDriveOAuthAvailable
                    ? t('settings.sync.google_drive_unavailable_target')
                    : t('settings.sync.connect_google_drive_desc')
                }
                control={
                  <button
                    type="button"
                    className="set-btn set-btn--primary"
                    disabled={!googleDriveOAuthAvailable || cloudBusy !== null}
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
                  label={t('settings.sync.reauthorize_google_drive')}
                  desc={t('settings.sync.reauthorize_google_drive_desc')}
                  control={
                    <button
                      type="button"
                      className="set-btn set-btn--primary"
                      disabled={!googleDriveOAuthAvailable || cloudBusy !== null}
                      onClick={() =>
                        void runCloudAction(
                          'reauthorize',
                          async () => {
                            await productSyncCommands.reauthorizeGoogleDrive();
                          },
                          'settings.sync.reauthorize_done',
                        )
                      }
                    >
                      {cloudBusy === 'reauthorize'
                        ? t('settings.sync.reauthorizing')
                        : t('settings.sync.reauthorize')}
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
                        productSyncCommands.triggerManualSync();
                        setCloudMessage(t('settings.sync.sync_requested'));
                      } catch (error) {
                        setCloudMessage(
                          t('settings.sync.operation_failed', {
                            error: error instanceof Error ? error.message : String(error),
                          }),
                        );
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
                    {authority.status === 'cloud-paused'
                      ? t('settings.sync.resume')
                      : t('settings.sync.pause')}
                  </button>
                }
              />
            )}
            <SettingsRow
              label={t('settings.sync.disconnect_google_drive')}
              desc={t('settings.sync.disconnect_google_drive_desc')}
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
            label={t('settings.sync.attention_reason')}
            desc={t('settings.sync.attention_reason_desc')}
            control={<span className="set-mono">{authority.errorCode}</span>}
          />
        )}
        {runtimeFailure?.lastErrorCode && (
          <SettingsRow
            label={t('settings.sync.last_sync_error')}
            desc={t(
              isReadyInternalPublishRequestFailure
                ? 'settings.sync.last_sync_error_publish_invalid_desc'
                : 'settings.sync.last_sync_error_desc',
            )}
            control={
              <span className="set-mono">
                {[runtimeFailure.lastErrorCode, runtimeFailure.lastFailedPhase]
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
        {cloudMessage && <div className="set-row__desc">{cloudMessage}</div>}
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

export function PrivacyPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const hostedSettings = hostedAccountSettingsEnabled();

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
                'https://github.com/chihumyum/Drifting/blob/main/PRIVACY.md',
              )
            }
          >
            {t('settings.common.open_in_browser')}
          </button>
        }
      />
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
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.about.contact')} hint="HELLO" />
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
                  'mailto:hi@drifting.app?subject=Drifting%20Pre-Alpha%20Feedback',
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
