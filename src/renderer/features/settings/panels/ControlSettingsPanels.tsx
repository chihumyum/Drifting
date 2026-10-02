import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
import { MarkdownProjectionSettings } from './MarkdownProjectionSettings';

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
            <button className="set-btn" onClick={() => navigate('/settings?section=account')}>
              {t('settings.hosted.manage')}
            </button>
          }
        />
      )}

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.sync.local_data')} hint="LOCAL" />
        <MarkdownProjectionSettings projectRuntimeMounted={projectImportEnabled} />
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
