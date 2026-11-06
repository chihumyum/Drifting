import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { exportAllProjectsAsRelationalMarkdown } from '../../../services/export/relational-markdown.service';
import {
  installedUpdateFor,
  UPDATE_CHECK_FAILED,
  UPDATE_LOCAL_SAVE_FAILED,
  UpdateService,
} from '../../../services/update/update-service';
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
              update.phase === 'downloading' || update.phase === 'installing' ? (
                <SettingsButton variant="primary" disabled>
                  {update.phase === 'installing' ? t('settings.update.installing') : t('settings.update.install')}
                </SettingsButton>
              ) : update.update ? (
                // One click downloads, verifies, saves, installs and relaunches;
                // a failure is shown in the update state below.
                <SettingsButton variant="primary" onClick={() => void UpdateService.install().catch(() => undefined)}>
                  {t('settings.update.install')}
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
          {update.update && !busy && (
            <SettingsNote>{t('settings.update.install_migration_safety')}</SettingsNote>
          )}
          {update.error && (
            <SettingsNote icon="status-stopped" tone="error" role="alert">
              {update.error === UPDATE_LOCAL_SAVE_FAILED
                ? t('settings.update.save_failed')
                : update.error === UPDATE_CHECK_FAILED
                  ? t('settings.update.check_failed')
                  : t('settings.update.error', { error: update.error })}
            </SettingsNote>
          )}
          {update.update && !busy && (
            <SettingsButton
              className="set-update-dismiss"
              disabled={busy}
              onClick={() => void UpdateService.dismiss()}
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

      <SettingsNote icon="lock-shut">
        {t(hostedSettings ? 'settings.privacy.noteHosted' : 'settings.privacy.noteLocal')}
      </SettingsNote>

      {hostedSettings && (
        <div className="set-sec set-sec--after-note">
          <SettingsSectionHeader title={t('settings.privacy.dataUsage')} hint="YOUR CONTROL" />
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
  const open = (url: string) => () => void platform.material.openExternal(url);
  return (
    <section className="set-panel" ref={registerRef} id="about">
      <SettingsPanelHeader
        kicker={t('settings.about.kicker')}
        title={t('settings.about.title')}
        sub={t('settings.about.sub')}
      />

      // The panel's header already names the app; here only one line of readouts.
      <div className="set-about-name">
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
          desc={t('settings.about.submitFeedbackDesc')}
          control={
            <SettingsButton onClick={() => useFeedbackDialogStore.getState().show()}>
              {t('settings.about.feedback')}
            </SettingsButton>
          }
        />
      </div>

      <p className="set-about-tagline">{t('settings.about.tagline')}</p>
    </section>
  );
}
