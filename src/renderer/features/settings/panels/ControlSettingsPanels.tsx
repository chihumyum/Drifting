import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SyncActivityPanel } from '../../../components/sync/SyncActivityPanel';
import { useSyncObserver } from '../../../services/sync-observer.service';
import {
  SHORTCUT_ACTIONS,
  useShortcutsStore,
  type ShortcutActionId,
} from '../../../store/shortcuts-store';
import { acceleratorFromEvent, formatAccelerator } from '../../../lib/shortcuts';
import { events } from '../../../lib/events';
import { platform } from '../../../platform';
import { getPlatformRuntime } from '../../../platform/runtime';
import { useSettingsStore } from '../../../store/settings-store';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';

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

function SyncSummaryRow() {
  const { t } = useTranslation();
  // Live metrics from the sync observer. We don't import the full
  // SyncActivityPanel here — that keeps the overview row light.
  const metrics = useSyncObserver((s) => s.metrics);
  const last = metrics.lastSuccessAt ? new Date(metrics.lastSuccessAt).toLocaleTimeString() : '—';
  const successPct = Math.round(metrics.successRate * 100);
  const latestAttemptFailed =
    metrics.lastFailureAt !== null &&
    (metrics.lastSuccessAt === null || metrics.lastFailureAt > metrics.lastSuccessAt);
  const status =
    metrics.inflight > 0
      ? t('settings.sync.syncing')
      : latestAttemptFailed
        ? t('settings.sync.needs_attention')
        : t('settings.sync.idle');
  return (
    <SettingsRow
      label={t('settings.sync.cloud')}
      desc={
        metrics.total === 0 ? (
          t('settings.sync.no_activity')
        ) : (
          <>
            {t('settings.sync.lastSuccess')} <span className="set-italic">{last}</span> ·{' '}
            {t('settings.sync.successRate')} <b>{successPct}%</b>
            {metrics.inflight > 0 ? t('settings.sync.inflight', { count: metrics.inflight }) : ''}
          </>
        )
      }
      control={
        <span
          className="set-mono"
          style={{ color: latestAttemptFailed ? 'hsl(var(--destructive))' : 'hsl(var(--ink-3))' }}
        >
          {status}
        </span>
      }
    />
  );
}

export function SyncPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();
  const { syncDebugToasts, setSyncDebugToasts } = useSettingsStore();
  const [activityOpen, setActivityOpen] = useState(false);

  if (activityOpen) {
    return (
      <section className="set-panel" ref={registerRef} id="sync">
        <button
          className="set-head__back"
          style={{ marginBottom: 12 }}
          onClick={() => setActivityOpen(false)}
        >
          <span>←</span>
          <span>{t('settings.sync.back_to_sync')}</span>
        </button>
        <SettingsPanelHeader
          kicker={t('settings.sync.activity_kicker')}
          title={t('settings.sync.activity_title')}
          sub={t('settings.sync.activity_sub')}
        />
        <SyncActivityPanel />
      </section>
    );
  }

  return (
    <section className="set-panel" ref={registerRef} id="sync">
      <SettingsPanelHeader
        kicker={t('settings.sync.kicker')}
        title={t('settings.sync.title')}
        sub={t('settings.sync.sub')}
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.sync.cloud_sync')} hint="CLOUD BACKUP" />
        <SyncSummaryRow />
        <SettingsRow
          label={t('settings.sync.activity')}
          desc={t('settings.sync.activity_desc')}
          control={
            <button className="set-btn" onClick={() => setActivityOpen(true)}>
              {t('settings.sync.activity_open')}
            </button>
          }
        />
        <SettingsRow
          label={t('settings.sync.vault_path')}
          desc={t('settings.sync.local_data_managed')}
          control={
            <button className="set-btn" disabled title={t('settings.common.not_available_yet')}>
              {t('settings.sync.show_in_finder')}
            </button>
          }
        />
        <SettingsRow
          label={t('settings.sync.debug_toast')}
          desc={t('settings.sync.debug_toast_desc')}
          control={<SettingsToggle on={syncDebugToasts} onChange={setSyncDebugToasts} />}
        />
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
    </section>
  );
}

export function PrivacyPanel({ registerRef }: { registerRef: SettingsRegisterRef }) {
  const { t } = useTranslation();

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

      <SettingsRow
        label={t('settings.privacy.fullPolicy')}
        desc={<span className="set-mono">{t('settings.privacy.lastUpdated')}</span>}
        control={
          <button
            className="set-btn"
            onClick={() =>
              void platform.material.openExternal(
                'https://github.com/chihumyum/drifting/blob/main/PRIVACY.md',
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
        <button className="set-btn" disabled title={t('settings.common.not_available_yet')}>
          {t('settings.about.checkUpdates')}
        </button>
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
                  'https://github.com/chihumyum/drifting/blob/main/THIRD_PARTY_NOTICES.md',
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
                void platform.material.openExternal('https://github.com/chihumyum/drifting')
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
                  'https://github.com/chihumyum/drifting/blob/main/LICENSE',
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
