import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { exportAllProjectsAsRelationalMarkdown } from '../../../services/export/relational-markdown.service';
import { installedUpdateFor, UPDATE_LOCAL_SAVE_FAILED, UpdateService } from '../../../services/update/update-service';
import { createSanitizedDiagnosticSummary } from '../../../services/diagnostics/sanitized-summary';
import {
  SHORTCUT_ACTIONS,
  useShortcutsStore,
  type ShortcutActionId,
} from '../../../store/shortcuts-store';
import { acceleratorFromEvent, formatAccelerator } from '../../../lib/shortcuts';
import { events } from '../../../lib/events';
import { APP_CONFIG } from '../../../lib/config';
import { platform } from '../../../platform';
import { getPlatformRuntime } from '../../../platform/runtime';
import { useProductSyncAuthority } from '../../../sync/product-authority-react';
import { useProductSyncRuntime } from '../../../sync/product-runtime-react';
import {
  SettingsButton,
  SettingsNote,
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { settingsOnDesktop } from '../settings-on-desktop';
import { hostedAccountSettingsEnabled } from '../hosted-settings-policy';
import { LibraryBackupSettings } from './LibraryBackupSettings';
import { MarkdownProjectionSettings } from './MarkdownProjectionSettings';
import { useSettingsStore } from '../../../store/settings-store';
import { useFeedbackDialogStore } from '../../feedback/feedback-dialog-store';

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
        <SettingsNote tone="error" role="alert" className="set-keys-conflict">
          {error}
        </SettingsNote>
      )}

      {settingsOnDesktop() ? (
        <div className="set-keys-list">
          <div className="set-keys-list__head">
            {t('settings.keys.allActionsShort', { count: SHORTCUT_ACTIONS.length })}
          </div>
          {SHORTCUT_ACTIONS.map((action) => {
            const label = t(`settings.keys.actions.${action.id}.label`);
            const combo = formatAccelerator(bindings[action.id]).split('+').join(' ');
            const isRecording = recording === action.id;
            return (
              <SettingsRow
                key={action.id}
                label={label}
                desc={t(`settings.keys.actions.${action.id}.desc`)}
                control={
                  // The combination in index type; while it waits for the new
                  // keys it is the accent glass that waits on the author.
                  <button
                    type="button"
                    className={`set-key-combo glass glass--small${isRecording ? ' glass--waiting' : ''}`}
                    aria-label={`${label}: ${isRecording ? t('settings.keys.recording') : combo}`}
                    title={t('settings.keys.resetOneTitle')}
                    onClick={() => {
                      setError(null);
                      setRecording(isRecording ? null : action.id);
                    }}
                    onDoubleClick={() => resetBinding(action.id)}
                  >
                    {isRecording ? t('settings.keys.pressNewCombo') : combo}
                  </button>
                }
              />
            );
          })}
        </div>
      ) : (
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
      )}

      <SettingsRow
        label={t('settings.keys.resetAll')}
        desc={t('settings.keys.resetAllDesc')}
        control={<SettingsButton onClick={resetAll}>{t('settings.keys.reset')}</SettingsButton>}
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
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const authority = useProductSyncAuthority();

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
        kicker={t(
          authority.mode === 'hosted' ? 'settings.hosted.sync_title' : 'settings.sync.local_kicker',
        )}
        title={t(
          authority.mode === 'hosted' ? 'settings.hosted.enabled' : 'settings.sync.local_title',
        )}
        sub={t(
          hostedAccountSettingsEnabled() ? 'settings.hosted.description' : 'settings.sync.local_sub',
        )}
      />
      {hostedAccountSettingsEnabled() && (
        <SettingsRow
          label={t('settings.hosted.title')}
          desc={t('settings.hosted.description')}
          control={
            <SettingsButton onClick={() => navigate('/settings?section=account')}>
              {t('settings.hosted.manage')}
            </SettingsButton>
          }
        />
      )}

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.sync.local_data')} hint="LOCAL" />
        <LibraryBackupSettings />
        <MarkdownProjectionSettings projectRuntimeMounted={projectImportEnabled} />
        <SettingsRow
          label={t('settings.account.export_all')}
          desc={t('settings.account.export_all_desc')}
          control={
            <SettingsButton onClick={handleMarkdownExport} disabled={exportBusy}>
              {exportBusy
                ? t('settings.account.exporting')
                : t('settings.account.export_all_btn')}
            </SettingsButton>
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
              <SettingsButton onClick={() => events.emit('import:open')}>
                {t('settings.sync.select_file')}
              </SettingsButton>
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
  const busy =
    update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing';
  const progress =
    update.totalBytes && update.totalBytes > 0
      ? Math.min(100, Math.round((update.downloadedBytes / update.totalBytes) * 100))
      : null;

  const currentVersion = getPlatformRuntime().appInfo?.version ?? null;
  const installed = currentVersion ? installedUpdateFor(currentVersion) : null;

  return (
    <section className="set-panel" ref={registerRef} id="updates">
      <SettingsPanelHeader
        kicker={t('settings.update.kicker')}
        title={t('settings.update.title')}
        sub={t('settings.update.sub')}
      />

      <SettingsRow
        label={t('settings.update.current_version')}
        desc={installed?.notes
          ? <span className="set-update-notes">{installed.notes}</span>
          : t('settings.update.channel_desc')}
        control={<span className="set-mono">{currentVersion ?? '—'}</span>}
      />

      {!updaterAvailable ? (
        <SettingsNote icon="status-stopped">{t('settings.update.unavailable')}</SettingsNote>
      ) : (
        <>
          <SettingsRow
            label={
              update.update
                ? t('settings.update.available_version', { version: update.update.version })
                : t('settings.update.check')
            }
            desc={
              (update.update?.notes && <span className="set-update-notes">{update.update.notes}</span>) ||
              (update.phase === 'idle'
                ? t('settings.update.no_update')
                : t(`settings.update.states.${update.phase}`))
            }
            control={
              update.phase === 'available' ? (
                <SettingsButton variant="primary" onClick={() => void UpdateService.download()}>
                  {t('settings.update.download')}
                </SettingsButton>
              ) : update.phase === 'ready' ? (
                installArmed ? (
                  <div className="set-actions">
                    <SettingsButton variant="primary" onClick={() => void UpdateService.install()}>
                      {t('settings.update.confirm_install')}
                    </SettingsButton>
                    <SettingsButton onClick={() => setInstallArmed(false)}>{t('common.cancel')}</SettingsButton>
                  </div>
                ) : (
                  <SettingsButton variant="primary" onClick={() => setInstallArmed(true)}>
                    {t('settings.update.install')}
                  </SettingsButton>
                )
              ) : update.phase === 'installing' ? (
                <SettingsButton variant="primary" disabled>
                  {t('settings.update.installing')}
                </SettingsButton>
              ) : (
                <SettingsButton disabled={busy} onClick={() => void UpdateService.check({ manual: true })}>
                  {update.phase === 'checking'
                    ? t('settings.update.checking')
                    : t('settings.update.check_action')}
                </SettingsButton>
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
            <SettingsNote>{t('settings.update.install_migration_safety')}</SettingsNote>
          )}
          {update.error && (
            <SettingsNote icon="status-stopped" tone="error" role="alert">
              {update.error === UPDATE_LOCAL_SAVE_FAILED
                ? t('settings.update.save_failed')
                : t('settings.update.error', { error: update.error })}
            </SettingsNote>
          )}
          {update.update && !busy && (
            <SettingsButton
              className="set-update-dismiss"
              disabled={busy}
              onClick={() => {
                setInstallArmed(false);
                void UpdateService.dismiss();
              }}
            >
              {t('settings.update.dismiss')}
            </SettingsButton>
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
  const [diagnosticMessage, setDiagnosticMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const sendCrashLogs = useSettingsStore((state) => state.sendCrashLogs);
  const setSendCrashLogs = useSettingsStore((state) => state.setSendCrashLogs);

  const copyDiagnostics = async () => {
    setDiagnosticMessage(null);
    try {
      const summary = createSanitizedDiagnosticSummary({
        runtime: getPlatformRuntime(),
        authority,
        sync: runtime,
        update,
      });
      await navigator.clipboard.writeText(summary);
      setDiagnosticMessage({ text: t('settings.privacy.diagnosticsCopied'), failed: false });
    } catch {
      setDiagnosticMessage({ text: t('settings.privacy.diagnosticsCopyFailed'), failed: true });
    }
  };

  return (
    <section className="set-panel" ref={registerRef} id="privacy">
      <SettingsPanelHeader
        kicker={t('settings.privacy.kicker')}
        title={t('settings.privacy.title')}
        sub={t('settings.privacy.sub')}
      />

      {settingsOnDesktop() ? (
        <SettingsNote icon="lock-shut">
          {t('settings.privacy.noteA')} {t('settings.privacy.noteBPrefix')}
          {t('settings.privacy.noteBStrong')}
          {t('settings.privacy.noteBSuffix')}
        </SettingsNote>
      ) : (
        <div className="set-note">
          {t('settings.privacy.noteA')}
          <br />
          <span className="set-mono" style={{ display: 'inline-block', marginTop: 6 }}>
            {t('settings.privacy.noteBPrefix')} <b>{t('settings.privacy.noteBStrong')}</b>{' '}
            {t('settings.privacy.noteBSuffix')}
          </span>
        </div>
      )}

      {hostedSettings && (
        <div className="set-sec set-sec--after-note">
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
              <SettingsToggle
                on={sendCrashLogs}
                onChange={setSendCrashLogs}
                aria-label={t('settings.privacy.crashLogs')}
              />
            }
          />
        </div>
      )}

      <SettingsRow
        label={t('settings.privacy.fullPolicy')}
        desc={<span className="set-mono">{t('settings.privacy.lastUpdated')}</span>}
        control={
          <SettingsButton outbound onClick={() => void platform.material.openExternal(APP_CONFIG.PRIVACY_URL)}>
            {t('settings.common.open_in_browser')}
          </SettingsButton>
        }
      />
      <SettingsRow
        label={t('settings.privacy.diagnostics')}
        desc={t('settings.privacy.diagnosticsDesc')}
        control={
          <SettingsButton onClick={() => void copyDiagnostics()}>
            {t('settings.privacy.copyDiagnostics')}
          </SettingsButton>
        }
      />
      {diagnosticMessage && (
        <SettingsNote
          icon={diagnosticMessage.failed ? 'status-stopped' : 'check'}
          tone={diagnosticMessage.failed ? 'error' : undefined}
          role={diagnosticMessage.failed ? 'alert' : 'status'}
        >
          {diagnosticMessage.text}
        </SettingsNote>
      )}
    </section>
  );
}

export function AboutPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const appVersion = getPlatformRuntime().appInfo?.version ?? '0.1.0';
  const desktop = settingsOnDesktop();
  const open = (url: string) => () => void platform.material.openExternal(url);
  return (
    <section className="set-panel" ref={registerRef} id="about">
      <SettingsPanelHeader
        kicker={t('settings.about.kicker')}
        title={t('settings.about.title')}
        sub={t('settings.about.sub')}
      />

      {desktop ? (
        // Only the name, in the structure serif, and one line of readouts.
        <div className="set-about-name">
          <div className="set-about-name__title">Drifting</div>
          <div className="set-about-name__meta">
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
      ) : (
        <div className="set-about">
          <div className="set-about__glyph">D</div>
          <div className="set-about__main">
            <div className="set-about__name">Drifting</div>
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
      )}

      <div className="set-sec set-sec--after-about">
        <SettingsSectionHeader title={t('settings.about.credits')} hint="CREDITS" />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.fonts')}</span>}
          desc={t('settings.about.fontsDesc')}
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.openSource')}</span>}
          desc="Tiptap · Yjs · Drizzle · React · Tauri 2"
          control={
            <SettingsButton outbound onClick={open('https://github.com/chihumyum/Drifting/blob/main/THIRD_PARTY_NOTICES.md')}>
              {t('settings.about.viewList')}
            </SettingsButton>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.sourceCode')}</span>}
          desc={t('settings.about.sourceCodeDesc')}
          control={
            <SettingsButton outbound onClick={open('https://github.com/chihumyum/Drifting')}>
              {t('settings.about.viewSource')}
            </SettingsButton>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.license')}</span>}
          desc={t('settings.about.licenseDesc')}
          control={
            <SettingsButton outbound onClick={open('https://github.com/chihumyum/Drifting/blob/main/LICENSE')}>
              {t('settings.about.viewLicense')}
            </SettingsButton>
          }
        />
        <SettingsRow
          label={<span className="set-italic">{t('settings.about.knownIssues')}</span>}
          desc={t('settings.about.knownIssuesDesc')}
          control={
            <SettingsButton outbound onClick={open('https://github.com/chihumyum/Drifting/blob/main/KNOWN_ISSUES.md')}>
              {t('settings.common.open_in_browser')}
            </SettingsButton>
          }
        />
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.about.contact')} hint="HELLO" />
        <SettingsRow
          label={t('settings.about.support')}
          desc={t('settings.about.supportDesc')}
          control={
            <SettingsButton outbound onClick={open(APP_CONFIG.SUPPORT_URL)}>
              {t('settings.common.open_in_browser')}
            </SettingsButton>
          }
        />
        <SettingsRow
          label={t('settings.about.emailTeam')}
          desc={<span className="set-mono">{APP_CONFIG.SUPPORT_EMAIL}</span>}
          control={
            <SettingsButton outbound onClick={open(`mailto:${APP_CONFIG.SUPPORT_EMAIL}`)}>
              {t('settings.about.writeEmail')}
            </SettingsButton>
          }
        />
        <SettingsRow
          label={t('settings.about.submitFeedback')}
          desc={t(desktop ? 'settings.about.submitFeedbackDesc' : 'settings.about.submitFeedbackMailDesc')}
          control={
            desktop ? (
              <SettingsButton onClick={() => useFeedbackDialogStore.getState().show()}>
                {t('settings.about.feedback')}
              </SettingsButton>
            ) : (
              <SettingsButton outbound onClick={open(`mailto:${APP_CONFIG.SUPPORT_EMAIL}?subject=${encodeURIComponent('Drifting feedback')}`)}>
                {t('settings.about.feedback')}
              </SettingsButton>
            )
          }
        />
      </div>

      {desktop ? (
        <p className="set-about-tagline">{t('settings.about.tagline')}</p>
      ) : (
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
      )}
    </section>
  );
}
