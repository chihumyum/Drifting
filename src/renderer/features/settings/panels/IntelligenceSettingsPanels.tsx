import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { byokKeychain, type BYOKProvider } from '../../../lib/byok-keychain';
import { speechKeychain } from '../../../lib/speech/speech-credentials';
import { resolveCopilotModel } from '../../../lib/ai/copilot-route';
import { testByokProviderConnection } from '../../../lib/ai/test-provider-connection';
import { getCopilotCapability } from '../../../lib/copilot/capability';
import { copilotRuntime } from '../../../lib/copilot/runtime';
import { events } from '../../../lib/events';
import {
  COPILOT_TASKS,
  useSettingsStore,
  type CopilotTaskId,
} from '../../../store/settings-store';
import {
  SettingsPanelHeader,
  SettingsRow,
  SettingsSectionHeader,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';

function ProviderRow({
  credentialsActive,
  provider,
  logoClass,
  logoText,
  name,
  desc,
}: {
  credentialsActive: boolean;
  provider: BYOKProvider;
  logoClass: string;
  logoText: string;
  name: string;
  desc: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const selectedCopilotProvider = useSettingsStore((state) => state.copilotByokProvider);
  const selectedCopilotModel = useSettingsStore((state) => state.copilotByokModel);

  // Settings needs existence only. On macOS this is an attribute-only native
  // query, so merely scrolling this panel into view never asks to decrypt keys.
  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void byokKeychain
      .has(provider)
      .then((value) => {
        if (!cancelled) setConnected(value);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive, provider]);

  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const testConnection = async () => {
    if (!connected) return;
    setTestState('testing');
    setTestMsg('');
    try {
      const model = resolveCopilotModel(
        provider,
        provider === selectedCopilotProvider ? selectedCopilotModel : '',
      );
      await testByokProviderConnection(provider, {
        model,
        signal: new AbortController().signal,
      });
      setTestState('ok');
    } catch (error) {
      setTestState('fail');
      setTestMsg(
        (error as { kind?: string })?.kind === 'auth'
          ? t('settings.byokProvider.invalidKey')
          : t('settings.byokProvider.requestFailed'),
      );
    }
  };

  const save = async () => {
    const value = draft.trim();
    if (!value) {
      await byokKeychain.clear(provider);
      setConnected(false);
    } else {
      await byokKeychain.set(provider, value);
      setConnected(true);
    }
    setDraft('');
    setEditing(false);
    copilotRuntime.resetClient();
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await byokKeychain.clear(provider);
    setConnected(false);
    copilotRuntime.resetClient();
    events.emit('byok:keys-changed');
  };

  return (
    <div
      className={
        'set-provider' + (connected ? ' set-provider--connected' : ' set-provider--disconnected')
      }
    >
      <div className="set-provider__head">
        <div className={`set-provider__logo ${logoClass}`}>{logoText}</div>
        <div className="set-provider__main">
          <div className="set-provider__name">
            <b>{name}</b>
            <em className={connected ? 'is-byok' : ''}>
              {connected
                ? t('settings.byokProvider.ownKey')
                : t('settings.byokProvider.notConnected')}
            </em>
          </div>
          <div className="set-provider__desc">{desc}</div>
        </div>
        <div
          className={
            'set-provider__status ' +
            (connected ? 'set-provider__status--live' : 'set-provider__status--off')
          }
        >
          <span className="set-provider__status-dot" />
          {connected ? 'CONNECTED' : 'OFFLINE'}
        </div>
      </div>

      {(connected || editing) && (
        <div className="set-provider__body">
          <div className="set-provider__body-inner">
            <span className="set-provider__k">API Key</span>
            <span className="set-provider__v">
              {editing ? (
                <input
                  className="set-input set-input--mono"
                  style={{ minWidth: 320 }}
                  placeholder={t('settings.byokProvider.keyPlaceholder')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
              ) : (
                <code>••••••••••••</code>
              )}
              {!editing && (
                <span className="set-mono" style={{ color: 'hsl(var(--ink-4))' }}>
                  · KEYCHAIN
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="set-provider__actions">
        {loading ? null : editing ? (
          <>
            <button className="set-btn set-btn--primary" onClick={save}>
              {t('settings.common.save')}
            </button>
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </button>
          </>
        ) : connected ? (
          <>
            <button className="set-btn" onClick={testConnection} disabled={testState === 'testing'}>
              {testState === 'testing'
                ? t('settings.byokProvider.testing')
                : t('settings.common.test_connection')}
            </button>
            {testState === 'ok' && (
              <span className="set-mono" style={{ color: '#2e7d52' }}>
                {t('settings.byokProvider.available')}
              </span>
            )}
            {testState === 'fail' && (
              <span className="set-mono" style={{ color: '#c0392b' }}>
                ✗ {testMsg}
              </span>
            )}
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(true);
              }}
            >
              {t('settings.byokProvider.editKey')}
            </button>
            <span style={{ flex: 1 }} />
            <button className="set-btn set-btn--danger" onClick={disconnect}>
              {t('settings.common.disconnect')}
            </button>
          </>
        ) : (
          <button
            className="set-btn set-btn--primary"
            onClick={() => {
              setDraft('');
              setEditing(true);
            }}
          >
            {t('settings.common.connect')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Voice-transcription credential (DashScope / 阿里云百炼). Deliberately not a
 * `ProviderRow`: it is not an LLM credential and must not join the Copilot
 * provider picker. Same keychain-only storage contract as the rows above.
 */
function SpeechCredentialRow({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void speechKeychain
      .has()
      .then((value) => {
        if (!cancelled) setConnected(value);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive]);

  const save = async () => {
    const value = draft.trim();
    if (!value) {
      await speechKeychain.clear();
      setConnected(false);
    } else {
      await speechKeychain.set(value);
      setConnected(true);
    }
    setDraft('');
    setEditing(false);
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await speechKeychain.clear();
    setConnected(false);
    events.emit('byok:keys-changed');
  };

  return (
    <div
      className={
        'set-provider' + (connected ? ' set-provider--connected' : ' set-provider--disconnected')
      }
    >
      <div className="set-provider__head">
        <div className="set-provider__logo set-provider__logo--dashscope">百</div>
        <div className="set-provider__main">
          <div className="set-provider__name">
            <b>阿里云百炼</b>
            <em className={connected ? 'is-byok' : ''}>
              {connected
                ? t('settings.byokProvider.ownKey')
                : t('settings.byokProvider.notConnected')}
            </em>
          </div>
          <div className="set-provider__desc">{t('settings.models.providers.dashscope')}</div>
        </div>
        <div
          className={
            'set-provider__status ' +
            (connected ? 'set-provider__status--live' : 'set-provider__status--off')
          }
        >
          <span className="set-provider__status-dot" />
          {connected ? 'CONNECTED' : 'OFFLINE'}
        </div>
      </div>

      {(connected || editing) && (
        <div className="set-provider__body">
          <div className="set-provider__body-inner">
            <span className="set-provider__k">API Key</span>
            <span className="set-provider__v">
              {editing ? (
                <input
                  className="set-input set-input--mono"
                  style={{ minWidth: 320 }}
                  placeholder={t('settings.byokProvider.keyPlaceholder')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
              ) : (
                <code>••••••••••••</code>
              )}
              {!editing && (
                <span className="set-mono" style={{ color: 'hsl(var(--ink-4))' }}>
                  · KEYCHAIN
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      <div className="set-provider__actions">
        {loading ? null : editing ? (
          <>
            <button className="set-btn set-btn--primary" onClick={save}>
              {t('settings.common.save')}
            </button>
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </button>
          </>
        ) : connected ? (
          <>
            <button
              className="set-btn"
              onClick={() => {
                setDraft('');
                setEditing(true);
              }}
            >
              {t('settings.byokProvider.editKey')}
            </button>
            <span style={{ flex: 1 }} />
            <button className="set-btn set-btn--danger" onClick={disconnect}>
              {t('settings.common.disconnect')}
            </button>
          </>
        ) : (
          <button
            className="set-btn set-btn--primary"
            onClick={() => {
              setDraft('');
              setEditing(true);
            }}
          >
            {t('settings.common.connect')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The only settings surface allowed to create, edit, test or delete AI keys. */
export function ModelsPanel({
  credentialsActive,
  registerRef,
}: {
  credentialsActive: boolean;
  registerRef: SettingsRegisterRef;
}) {
  const { t } = useTranslation();
  return (
    <section className="set-panel" ref={registerRef} id="models">
      <SettingsPanelHeader
        kicker={t('settings.models.kicker')}
        title={t('settings.models.title')}
        sub={t('settings.models.sub')}
      />
      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.models.credentialsTitle')} hint="BYOK · KEYCHAIN" />
        <p className="set-row__desc">{t('settings.models.credentialsDesc')}</p>
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="deepseek"
          logoClass="set-provider__logo--deepseek"
          logoText="D"
          name="DeepSeek"
          desc={t('settings.models.providers.deepseek')}
        />
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="anthropic"
          logoClass="set-provider__logo--anthropic"
          logoText="A"
          name="Anthropic"
          desc={t('settings.models.providers.anthropic')}
        />
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="openai"
          logoClass="set-provider__logo--openai"
          logoText="O"
          name="OpenAI"
          desc={t('settings.models.providers.openai')}
        />
        <ProviderRow
          credentialsActive={credentialsActive}
          provider="google"
          logoClass="set-provider__logo--google"
          logoText="G"
          name="Google"
          desc={t('settings.models.providers.google')}
        />
      </div>
      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.models.speechTitle')} hint="BYOK · KEYCHAIN" />
        <p className="set-row__desc">{t('settings.models.speechDesc')}</p>
        <SpeechCredentialRow credentialsActive={credentialsActive} />
      </div>
    </section>
  );
}

const COPILOT_DEBOUNCE_MIN_SEC = 1;
const COPILOT_DEBOUNCE_MAX_SEC = 60;
const COPILOT_SECTION_SIZE_MIN = 3;
const COPILOT_SECTION_SIZE_MAX = 30;

function clampDebounceSec(sec: number): number {
  return Math.min(COPILOT_DEBOUNCE_MAX_SEC, Math.max(COPILOT_DEBOUNCE_MIN_SEC, Math.round(sec)));
}

/**
 * Per-task config row. Shows the task's name, a wired/not-wired indicator,
 * its enable toggle, and (if wired) a debounce slider. The slider value
 * defaults to the capability's `defaultDebounceMs` until the user overrides.
 */
function CopilotTaskRow({
  taskId,
  label,
  desc,
}: {
  taskId: CopilotTaskId;
  label: string;
  desc: string;
}) {
  const { t } = useTranslation();
  const cfg = useSettingsStore((s) => s.copilotTaskConfigs[taskId]);
  const setEnabled = useSettingsStore((s) => s.setCopilotTaskEnabled);
  const setDebounceMs = useSettingsStore((s) => s.setCopilotTaskDebounceMs);

  const cap = getCopilotCapability(taskId);
  const wired = Boolean(cap);
  const enabled = cfg?.enabled ?? false;
  const effectiveMs = cfg?.debounceMs ?? cap?.defaultDebounceMs ?? 5000;
  const effectiveSec = Math.round(effectiveMs / 1000);
  const isOverride = cfg?.debounceMs !== undefined;

  return (
    <div
      style={{
        padding: '14px 0',
        borderTop: '1px solid hsl(var(--rule) / 0.5)',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{label}</strong>
            {!wired && (
              <span
                style={{
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'hsl(var(--rule) / 0.3)',
                }}
              >
                {t('settings.copilot.notLive')}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'hsl(var(--ink-2))', marginTop: 4 }}>{desc}</div>
        </div>
        <SettingsToggle on={enabled} onChange={(on) => setEnabled(taskId, on)} />
      </div>

      {wired && enabled && (
        <div style={{ marginTop: 12, paddingLeft: 4 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              fontSize: 12,
              color: 'hsl(var(--ink-3))',
              marginBottom: 4,
            }}
          >
            <span>{t('settings.copilot.triggerRhythm')}</span>
            <span>
              {t('settings.copilot.afterStopPrefix')}
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  margin: '0 4px',
                  color: 'hsl(var(--ink-1))',
                }}
              >
                {effectiveSec}s
              </span>
              {t('settings.copilot.afterStopSuffix')}
              {isOverride && (
                <button
                  onClick={() => setDebounceMs(taskId, undefined)}
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    color: 'hsl(var(--accent))',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  title={t('settings.copilot.resetTaskDefaultTitle')}
                >
                  {t('settings.copilot.resetDefault')}
                </button>
              )}
            </span>
          </div>
          <input
            type="range"
            min={COPILOT_DEBOUNCE_MIN_SEC}
            max={COPILOT_DEBOUNCE_MAX_SEC}
            step={1}
            value={effectiveSec}
            onChange={(e) =>
              setDebounceMs(taskId, clampDebounceSec(parseInt(e.target.value, 10)) * 1000)
            }
            style={{ width: '100%', accentColor: 'hsl(var(--accent))' }}
          />
        </div>
      )}
    </div>
  );
}

// Known models per BYOK provider — drives the Copilot model dropdown so the user
// can choose a provider-native id without hand-typing it. The renderer resolves
// this selection locally and sends it only to that provider. Custom remains an
// escape hatch for newly released model ids.
const COPILOT_BYOK_MODELS: Record<BYOKProvider, { value: string; label: string }[]> = {
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek Pro' },
  ],
  anthropic: [
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  google: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
  openai: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
};

const BYOK_PROVIDER_LABEL: Record<BYOKProvider, string> = {
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

// Live keychain-connected status for one BYOK provider. Re-checks on mount and on
// any 'byok:keys-changed' (ProviderRow connect/disconnect) so indicators that
// don't own ProviderRow's local state stay in sync. null = still loading.
function useByokConnected(provider: BYOKProvider, credentialsActive: boolean): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    const read = () => {
      void byokKeychain
        .has(provider)
        .then((exists) => {
          if (!cancelled) setConnected(exists);
        })
        .catch(() => {
          if (!cancelled) setConnected(false);
        });
    };
    read();
    events.on('byok:keys-changed', read);
    return () => {
      cancelled = true;
      events.off('byok:keys-changed', read);
    };
  }, [credentialsActive, provider]);
  return connected;
}

// Sentinel select value for the "custom model id" escape hatch.
const BYOK_MODEL_CUSTOM = '__custom__';

// Copilot BYOK model picker: a dropdown of known models for the active provider
// (+ provider-default + 自定义…), replacing the old hand-typed model-id input.
function CopilotByokModelPicker() {
  const { t } = useTranslation();
  const provider = useSettingsStore((s) => s.copilotByokProvider);
  const model = useSettingsStore((s) => s.copilotByokModel);
  const setModel = useSettingsStore((s) => s.setCopilotByokModel);
  const known = COPILOT_BYOK_MODELS[provider] ?? [];
  const inKnown = model === '' || known.some((m) => m.value === model);
  const [customOpen, setCustomOpen] = useState(false);
  const showCustom = customOpen || (model !== '' && !inKnown);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240 }}>
      <select
        className="set-input"
        style={{ minWidth: 240 }}
        value={showCustom ? BYOK_MODEL_CUSTOM : model}
        onChange={(e) => {
          const v = e.target.value;
          if (v === BYOK_MODEL_CUSTOM) {
            setCustomOpen(true);
          } else {
            setCustomOpen(false);
            setModel(v);
          }
        }}
      >
        <option value="">{t('settings.copilot.providerDefault')}</option>
        {known.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
        <option value={BYOK_MODEL_CUSTOM}>{t('settings.copilot.customModel')}</option>
      </select>
      {showCustom && (
        <input
          className="set-input set-input--mono"
          style={{ minWidth: 240 }}
          placeholder={t('settings.copilot.modelIdPlaceholder')}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      )}
    </div>
  );
}

// Warns when the active provider has no key. Pre-Alpha never falls back to hosted.
function CopilotByokWarning({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const provider = useSettingsStore((s) => s.copilotByokProvider);
  const connected = useByokConnected(provider, credentialsActive);
  if (connected !== false) return null;
  const jumpToModels = () =>
    document.getElementById('models')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div
      style={{
        margin: '0 0 10px',
        padding: '9px 12px',
        borderRadius: 2,
        background: 'hsl(38 92% 50% / 0.1)',
        border: '1px solid hsl(38 80% 50% / 0.35)',
        fontSize: 12.5,
        lineHeight: 1.6,
        color: 'hsl(var(--ink-2))',
      }}
    >
      {t('settings.copilot.byokWarningPrefix', { provider: BYOK_PROVIDER_LABEL[provider] })}
      <b>{t('settings.copilot.byokWarningStrong')}</b>
      {t('settings.copilot.byokWarningSuffix')}
      <button className="set-btn" style={{ marginLeft: 10 }} onClick={jumpToModels}>
        {t('settings.common.manageKeys')}
      </button>
    </div>
  );
}

export function CopilotPanel({
  credentialsActive,
  registerRef,
}: {
  credentialsActive: boolean;
  registerRef: SettingsRegisterRef;
}) {
  const { t } = useTranslation();
  const copilotByokProvider = useSettingsStore((s) => s.copilotByokProvider);
  const setCopilotByokProvider = useSettingsStore((s) => s.setCopilotByokProvider);
  const autoTrigger = useSettingsStore((s) => s.copilotAutoTrigger);
  const setAutoTrigger = useSettingsStore((s) => s.setCopilotAutoTrigger);
  const copilotInDrift = useSettingsStore((s) => s.copilotInDrift);
  const setCopilotInDrift = useSettingsStore((s) => s.setCopilotInDrift);
  const generateSummaries = useSettingsStore((s) => s.copilotGenerateSummaries);
  const setGenerateSummaries = useSettingsStore((s) => s.setCopilotGenerateSummaries);
  const sectionSize = useSettingsStore((s) => s.copilotSummarySectionSize);
  const setSectionSize = useSettingsStore((s) => s.setCopilotSummarySectionSize);

  return (
    <section className="set-panel" ref={registerRef} id="copilot">
      <SettingsPanelHeader
        kicker={t('settings.copilot.kicker')}
        title={t('settings.copilot.title')}
        sub={
          <>
            {t('settings.copilot.sub')}
            <span className="set-italic"> {t('settings.copilot.keyPrivacy')}</span>
          </>
        }
      />

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.ai.routing')} hint="PROVIDER · MODEL" />
        <p className="set-row__desc">{t('settings.copilot.routingDesc')}</p>
        <CopilotByokWarning credentialsActive={credentialsActive} />
        <SettingsRow
          label={t('settings.common.provider')}
          desc={t('settings.copilot.providerDesc')}
          control={
            <select
              className="set-input"
              style={{ minWidth: 240 }}
              value={copilotByokProvider}
              onChange={(e) => setCopilotByokProvider(e.target.value as BYOKProvider)}
            >
              {(Object.keys(BYOK_PROVIDER_LABEL) as BYOKProvider[]).map((provider) => (
                <option key={provider} value={provider}>
                  {BYOK_PROVIDER_LABEL[provider]}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          label={t('settings.copilot.byokModel')}
          desc={t('settings.copilot.byokModelDesc')}
          control={<CopilotByokModelPicker />}
        />
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.copilot.switchesTitle')} hint="ENABLE" />
        <SettingsRow
          label={t('settings.copilot.autoTrigger')}
          desc={t('settings.copilot.autoTriggerDesc')}
          control={<SettingsToggle on={autoTrigger} onChange={setAutoTrigger} />}
        />
        <SettingsRow
          label={t('settings.copilot.enableInDrift')}
          desc={t('settings.copilot.enableInDriftDesc')}
          control={<SettingsToggle on={copilotInDrift} onChange={setCopilotInDrift} />}
        />
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.copilot.summaryTitle')} hint="SUMMARY" />
        <SettingsRow
          label={t('settings.copilot.generateSummaries')}
          desc={t('settings.copilot.generateSummariesDesc')}
          control={<SettingsToggle on={generateSummaries} onChange={setGenerateSummaries} />}
        />
        {generateSummaries && (
          <SettingsRow
            label={t('settings.copilot.summaryThreshold')}
            desc={t('settings.copilot.summaryThresholdDesc', { count: sectionSize })}
            stack
            control={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  minWidth: 220,
                }}
              >
                <input
                  type="range"
                  min={COPILOT_SECTION_SIZE_MIN}
                  max={COPILOT_SECTION_SIZE_MAX}
                  step={1}
                  value={sectionSize}
                  onChange={(e) => setSectionSize(parseInt(e.target.value, 10))}
                  style={{ flex: 1, accentColor: 'hsl(var(--accent))' }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    minWidth: 32,
                    textAlign: 'right',
                    color: 'hsl(var(--ink-2))',
                  }}
                >
                  {t('settings.copilot.blocks', { count: sectionSize })}
                </span>
              </div>
            }
          />
        )}
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.copilot.tasksTitle')} hint="TASKS" />
        <p className="set-row__desc" style={{ margin: '-4px 0 0' }}>
          {t('settings.copilot.tasksDesc')}
        </p>
        {COPILOT_TASKS.map((task) => (
          <CopilotTaskRow
            key={task.id}
            taskId={task.id}
            label={t(`settings.copilot.tasks.${task.id}.label`, { defaultValue: task.label })}
            desc={t(`settings.copilot.tasks.${task.id}.desc`, { defaultValue: task.desc })}
          />
        ))}
      </div>
    </section>
  );
}
