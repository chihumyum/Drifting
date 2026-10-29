import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { byokKeychain, type BYOKProvider } from '../../../lib/byok-keychain';
import {
  codexSubscription,
  isCodexLoginActive,
  type CodexSubscriptionStatus,
} from '../../../lib/codex-subscription';
import { speechKeychain } from '../../../lib/speech/speech-credentials';
import { resolveCopilotModel } from '../../../lib/ai/copilot-route';
import { testByokProviderConnection } from '../../../lib/ai/test-provider-connection';
import { readEnvApiKey } from '../../../lib/ai/credentials/env';
import { getCopilotCapability } from '../../../lib/copilot/capability';
import { copilotRuntime } from '../../../lib/copilot/runtime';
import { events } from '../../../lib/events';
import {
  COPILOT_TASKS,
  useSettingsStore,
  type CopilotTaskId,
} from '../../../store/settings-store';
import {
  SettingsButton,
  SettingsField,
  SettingsNote,
  SettingsPanelHeader,
  SettingsRange,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSelect,
  SettingsToggle,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { settingsOnDesktop } from '../settings-on-desktop';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { GlassSelect } from '../../../components/ui/GlassSelect';

/**
 * One way to reach a model or a transcriber. On the desktop it is a flat row
 * (components.md, provider connection row): a seal, solid while connected and
 * hollow while not, the name, where the credential comes from in index type,
 * the description, and the actions on a line below. The paused mobile shell
 * keeps the bordered card with its brand tile and status dot.
 */
function ProviderShell({
  name,
  desc,
  logoClass,
  logoText,
  live,
  chip,
  source,
  body,
  detail,
  actions,
}: {
  name: string;
  desc: string;
  logoClass: string;
  logoText: string;
  live: boolean;
  /** Mobile: the chip after the name. */
  chip: string;
  /** Desktop: where the credential comes from (Keychain, .ENV (DEV), not connected). */
  source: string;
  /** Mobile: the credential line under the head. */
  body?: { label: string; value: ReactNode } | null;
  /** Desktop: a line between the description and the actions (a device code). */
  detail?: ReactNode;
  actions: ReactNode;
}) {
  if (settingsOnDesktop()) {
    return (
      <div className="set-provider-line">
        {/* The chapter's round seal; hollow like a chapter not yet begun. */}
        <span
          className={`set-provider-line__seal kind-mark kind-mark--chapter${live ? '' : ' kind-mark--hollow'}`}
          style={{ '--sand-c': 'hsl(var(--ink-2))' } as CSSProperties}
          aria-hidden="true"
        >
          <i className="sand sand--blob-2" />
        </span>
        <span className="set-provider-line__name">{name}</span>
        <span className="set-provider-line__source">{source}</span>
        <div className="set-provider-line__desc">{desc}</div>
        {detail && <div className="set-provider-line__row">{detail}</div>}
        {actions && <div className="set-provider-line__row">{actions}</div>}
      </div>
    );
  }
  return (
    <div className={'set-provider' + (live ? ' set-provider--connected' : ' set-provider--disconnected')}>
      <div className="set-provider__head">
        <div className={`set-provider__logo ${logoClass}`}>{logoText}</div>
        <div className="set-provider__main">
          <div className="set-provider__name">
            <b>{name}</b>
            <em className={live ? 'is-byok' : ''}>{chip}</em>
          </div>
          <div className="set-provider__desc">{desc}</div>
        </div>
        <div className={'set-provider__status ' + (live ? 'set-provider__status--live' : 'set-provider__status--off')}>
          <span className="set-provider__status-dot" />
          {live ? 'CONNECTED' : 'OFFLINE'}
        </div>
      </div>
      {body && (
        <div className="set-provider__body">
          <div className="set-provider__body-inner">
            <span className="set-provider__k">{body.label}</span>
            <span className="set-provider__v">{body.value}</span>
          </div>
        </div>
      )}
      <div className="set-provider__actions">{actions}</div>
    </div>
  );
}

/** A connection test's answer, or a sign-in failure. */
function ProviderResult({ tone, children }: { tone: 'ok' | 'error' | 'muted'; children: ReactNode }) {
  if (settingsOnDesktop()) {
    return (
      <span className={`set-provider-result${tone === 'error' ? ' set-provider-result--error' : ''}`}>
        {tone !== 'muted' && <BrushIcon name={tone === 'ok' ? 'check' : 'status-stopped'} size={13} />}
        {children}
      </span>
    );
  }
  const color = tone === 'ok' ? '#2e7d52' : tone === 'error' ? '#c0392b' : 'hsl(var(--ink-4))';
  return (
    <span className="set-mono" style={{ color }}>
      {tone !== 'muted' && <BrushIcon name={tone === 'ok' ? 'check' : 'status-stopped'} size={11} inline />}{' '}
      {children}
    </span>
  );
}

/** The mobile card's key line: the mask and where the key lives. */
function maskedKey(source: string) {
  return (
    <>
      <code>••••••••••••</code>
      <span className="set-mono" style={{ color: 'hsl(var(--ink-4))' }}>
        {source}
      </span>
    </>
  );
}

function KeyField({ name, value, onChange }: { name: string; value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation();
  const desktop = settingsOnDesktop();
  return (
    <SettingsField
      mono
      small={desktop}
      style={desktop ? { width: 250 } : { minWidth: 320 }}
      placeholder={t('settings.byokProvider.keyPlaceholder')}
      aria-label={`${name} API Key`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoFocus
    />
  );
}

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
  // A development key handed to the dev server (scripts/dev-agent-keys.mjs)
  // counts as connected; it is read before the keychain, like the Agent does.
  const envKey = Boolean(readEnvApiKey(provider));
  const live = connected || envKey;
  const [loading, setLoading] = useState(true);
  const selectedCopilotProvider = useSettingsStore((state) => state.copilotByokProvider);
  const selectedCopilotModel = useSettingsStore((state) => state.copilotByokModel);
  const desktop = settingsOnDesktop();

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
    if (!live) return;
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

  const startEditing = () => {
    setDraft('');
    setEditing(true);
  };
  const keyField = <KeyField name={name} value={draft} onChange={setDraft} />;

  return (
    <ProviderShell
      name={name}
      desc={desc}
      logoClass={logoClass}
      logoText={logoText}
      live={live}
      chip={live ? t('settings.byokProvider.ownKey') : t('settings.byokProvider.notConnected')}
      source={live ? (connected ? 'Keychain' : '.ENV (DEV)') : t('settings.byokProvider.notConnected')}
      body={
        editing
          ? { label: 'API Key', value: keyField }
          : live
            ? { label: 'API Key', value: maskedKey(connected ? '· KEYCHAIN' : '· .ENV (DEV)') }
            : null
      }
      actions={
        loading ? null : editing ? (
          <>
            {desktop && keyField}
            <SettingsButton variant="primary" onClick={save}>
              {t('settings.common.save')}
            </SettingsButton>
            <SettingsButton
              variant={desktop ? 'ghost' : 'default'}
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </SettingsButton>
          </>
        ) : live ? (
          <>
            <SettingsButton size="sm" onClick={testConnection} disabled={testState === 'testing'}>
              {testState === 'testing'
                ? t('settings.byokProvider.testing')
                : t('settings.common.test_connection')}
            </SettingsButton>
            <SettingsButton variant={desktop ? 'ghost' : 'default'} size="sm" onClick={startEditing}>
              {t('settings.byokProvider.editKey')}
            </SettingsButton>
            {testState === 'ok' && <ProviderResult tone="ok">{t('settings.byokProvider.available')}</ProviderResult>}
            {testState === 'fail' && <ProviderResult tone="error">{testMsg}</ProviderResult>}
            <span style={{ flex: 1 }} />
            {/* An .env key is the dev server's: there is nothing here to disconnect. */}
            {connected && (
              <SettingsButton variant="danger" size="sm" onClick={disconnect}>
                {t('settings.common.disconnect')}
              </SettingsButton>
            )}
          </>
        ) : (
          <SettingsButton variant="primary" size="sm" onClick={startEditing}>
            {t('settings.common.connect')}
          </SettingsButton>
        )
      }
    />
  );
}

/**
 * Experimental ChatGPT subscription sign-in for General Agent's `openai-codex`
 * route. Deliberately not a `ProviderRow`: there is no key to paste, the OAuth
 * tokens never reach the renderer, and Copilot must not treat it as a BYOK
 * provider. The row drives the Codex device-code flow and polls native status
 * while an attempt is live.
 */
function ChatGptSubscriptionRow({ credentialsActive }: { credentialsActive: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodexSubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const desktop = settingsOnDesktop();

  useEffect(() => {
    if (!credentialsActive) return;
    let cancelled = false;
    void codexSubscription
      .status()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsActive]);

  const loginActive = isCodexLoginActive(status);
  useEffect(() => {
    if (!loginActive) return;
    const timer = window.setInterval(() => {
      void codexSubscription
        .status()
        .then(setStatus)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loginActive]);

  const signIn = async () => {
    setBusy(true);
    setStartError(null);
    try {
      const login = await codexSubscription.startLogin();
      setStatus((current) => ({
        signedIn: current?.signedIn ?? false,
        account: current?.account ?? null,
        login,
      }));
    } catch {
      setStartError(t('settings.codexSubscription.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await codexSubscription.cancelLogin().catch(() => undefined);
    setStatus(await codexSubscription.status().catch(() => null));
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await codexSubscription.logout();
      setStatus(await codexSubscription.status().catch(() => null));
      events.emit('byok:keys-changed');
    } finally {
      setBusy(false);
    }
  };

  const signedIn = status?.signedIn === true;
  const publishedSignedIn = status?.signedIn;
  useEffect(() => {
    if (publishedSignedIn === undefined) return;
    events.emit('agent:auth-changed');
  }, [publishedSignedIn, status?.account?.accountId, status?.login?.attemptId, status?.login?.phase]);
  const login = status?.login ?? null;
  const account = status?.account ?? null;
  const failureKey = login?.phase === 'failed' ? login.failure ?? 'provider_rejected' : null;
  const accountWord = signedIn
    ? account?.email ?? t('settings.codexSubscription.signedInAs')
    : t('settings.codexSubscription.notSignedIn');
  const codeHint =
    login?.phase === 'exchanging'
      ? t('settings.codexSubscription.exchanging')
      : t('settings.codexSubscription.codeHint');

  return (
    <ProviderShell
      name={t('settings.codexSubscription.name')}
      desc={t('settings.models.providers.openaiCodex')}
      logoClass="set-provider__logo--openai"
      logoText="C"
      live={signedIn}
      chip={accountWord}
      source={signedIn && account?.plan ? `${accountWord} · ${account.plan}` : accountWord}
      body={
        loginActive && login
          ? {
              label: t('settings.codexSubscription.codeLabel'),
              value: maskedCode(login.userCode, ` · ${codeHint}`),
            }
          : signedIn
            ? { label: t('settings.codexSubscription.plan'), value: maskedCode(account?.plan ?? '—', '· KEYCHAIN') }
            : null
      }
      detail={
        loginActive && login ? (
          <>
            <span className="set-provider-line__k">{t('settings.codexSubscription.codeLabel')}</span>
            <span className="set-provider-line__code">{login.userCode}</span>
            <BrushIcon name="loader" size={13} className="ui-spin" />
            <span className="set-provider-line__k">{codeHint}</span>
          </>
        ) : null
      }
      actions={
        loading ? null : loginActive && login ? (
          <>
            <SettingsButton variant="primary" size="sm" onClick={() => codexSubscription.openVerification(login)}>
              {t('settings.codexSubscription.openVerification')}
            </SettingsButton>
            <SettingsButton variant={desktop ? 'ghost' : 'default'} size="sm" onClick={cancel}>
              {t('settings.common.cancel')}
            </SettingsButton>
          </>
        ) : signedIn ? (
          <>
            <span style={{ flex: 1 }} />
            <SettingsButton variant="danger" size="sm" onClick={signOut} disabled={busy}>
              {t('settings.codexSubscription.signOut')}
            </SettingsButton>
          </>
        ) : (
          <>
            <SettingsButton variant="primary" size="sm" onClick={signIn} disabled={busy}>
              {t('settings.codexSubscription.signIn')}
            </SettingsButton>
            {startError && <ProviderResult tone="error">{startError}</ProviderResult>}
            {failureKey && (
              <ProviderResult tone="error">{t(`settings.codexSubscription.failure.${failureKey}`)}</ProviderResult>
            )}
            {login?.phase === 'cancelled' && (
              <ProviderResult tone="muted">{t('settings.codexSubscription.cancelled')}</ProviderResult>
            )}
          </>
        )
      }
    />
  );
}

/** The mobile card's code or plan line. */
function maskedCode(code: string, note: string) {
  return (
    <>
      <code>{code}</code>
      <span className="set-mono" style={{ color: 'hsl(var(--ink-4))' }}>
        {note}
      </span>
    </>
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
  const desktop = settingsOnDesktop();

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

  const startEditing = () => {
    setDraft('');
    setEditing(true);
  };
  const keyField = <KeyField name="阿里云百炼" value={draft} onChange={setDraft} />;

  return (
    <ProviderShell
      name="阿里云百炼"
      desc={t('settings.models.providers.dashscope')}
      logoClass="set-provider__logo--dashscope"
      logoText="百"
      live={connected}
      chip={connected ? t('settings.byokProvider.ownKey') : t('settings.byokProvider.notConnected')}
      source={connected ? 'Keychain' : t('settings.byokProvider.notConnected')}
      body={
        editing
          ? { label: 'API Key', value: keyField }
          : connected
            ? { label: 'API Key', value: maskedKey('· KEYCHAIN') }
            : null
      }
      actions={
        loading ? null : editing ? (
          <>
            {desktop && keyField}
            <SettingsButton variant="primary" onClick={save}>
              {t('settings.common.save')}
            </SettingsButton>
            <SettingsButton
              variant={desktop ? 'ghost' : 'default'}
              onClick={() => {
                setDraft('');
                setEditing(false);
              }}
            >
              {t('settings.common.cancel')}
            </SettingsButton>
          </>
        ) : connected ? (
          <>
            <SettingsButton variant={desktop ? 'ghost' : 'default'} size="sm" onClick={startEditing}>
              {t('settings.byokProvider.editKey')}
            </SettingsButton>
            <span style={{ flex: 1 }} />
            <SettingsButton variant="danger" size="sm" onClick={disconnect}>
              {t('settings.common.disconnect')}
            </SettingsButton>
          </>
        ) : (
          <SettingsButton variant="primary" size="sm" onClick={startEditing}>
            {t('settings.common.connect')}
          </SettingsButton>
        )
      }
    />
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
        <ChatGptSubscriptionRow credentialsActive={credentialsActive} />
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

  const setDebounceSec = (sec: number) => setDebounceMs(taskId, clampDebounceSec(sec) * 1000);

  return (
    <div className="set-copilot-task">
      <div className="set-copilot-task__head">
        <div className="set-copilot-task__main">
          <div className="set-copilot-task__title">
            <strong>{label}</strong>
            {!wired && <span className="set-copilot-task__badge">{t('settings.copilot.notLive')}</span>}
          </div>
          <div className="set-copilot-task__desc">{desc}</div>
        </div>
        <SettingsToggle on={enabled} onChange={(on) => setEnabled(taskId, on)} aria-label={label} />
      </div>

      {wired && enabled && (
        <div className="set-copilot-task__rhythm">
          <div className="set-copilot-task__rhythm-head">
            <span>{t('settings.copilot.triggerRhythm')}</span>
            <span>
              {t('settings.copilot.afterStopPrefix')}
              <span className="set-copilot-task__value">{effectiveSec}s</span>
              {t('settings.copilot.afterStopSuffix')}
              {isOverride && (
                <SettingsButton
                  variant="ghost"
                  size="sm"
                  className="set-copilot-task__reset"
                  onClick={() => setDebounceMs(taskId, undefined)}
                  title={t('settings.copilot.resetTaskDefaultTitle')}
                >
                  {t('settings.copilot.resetDefault')}
                </SettingsButton>
              )}
            </span>
          </div>
          <SettingsRange
            wide
            min={COPILOT_DEBOUNCE_MIN_SEC}
            max={COPILOT_DEBOUNCE_MAX_SEC}
            value={effectiveSec}
            ariaLabel={`${label} · ${t('settings.copilot.triggerRhythm')}`}
            onChange={setDebounceSec}
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
  const choose = (next: string) => {
    if (next === BYOK_MODEL_CUSTOM) {
      setCustomOpen(true);
    } else {
      setCustomOpen(false);
      setModel(next);
    }
  };
  const options = [
    { value: '', label: t('settings.copilot.providerDefault') },
    ...known,
    { value: BYOK_MODEL_CUSTOM, label: t('settings.copilot.customModel') },
  ];
  const desktop = settingsOnDesktop();
  return (
    <div className="set-model-picker">
      {desktop ? (
        <span className="set-select-slot" style={{ width: 240 }}>
          <GlassSelect
            value={showCustom ? BYOK_MODEL_CUSTOM : model}
            options={options}
            onChange={choose}
            ariaLabel={t('settings.copilot.byokModel')}
          />
        </span>
      ) : (
        <select
          className="set-input"
          style={{ minWidth: 240 }}
          value={showCustom ? BYOK_MODEL_CUSTOM : model}
          onChange={(e) => choose(e.target.value)}
        >
          {options.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      {showCustom && (
        <SettingsField
          mono
          small={desktop}
          style={desktop ? { width: 240 } : { minWidth: 240 }}
          placeholder={t('settings.copilot.modelIdPlaceholder')}
          aria-label={t('settings.copilot.modelIdPlaceholder')}
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
  const message = (
    <>
      {t('settings.copilot.byokWarningPrefix', { provider: BYOK_PROVIDER_LABEL[provider] })}
      <b>{t('settings.copilot.byokWarningStrong')}</b>
      {t('settings.copilot.byokWarningSuffix')}
    </>
  );
  if (settingsOnDesktop()) {
    return (
      <SettingsNote className="set-copilot-warning">
        {message}
        <SettingsButton variant="ghost" size="sm" onClick={jumpToModels}>
          {t('settings.common.manageKeys')}
        </SettingsButton>
      </SettingsNote>
    );
  }
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
      {message}
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
            <SettingsSelect<BYOKProvider>
              few
              value={copilotByokProvider}
              onChange={setCopilotByokProvider}
              ariaLabel={t('settings.common.provider')}
              width={240}
              options={(Object.keys(BYOK_PROVIDER_LABEL) as BYOKProvider[]).map((provider) => ({
                value: provider,
                label: BYOK_PROVIDER_LABEL[provider],
              }))}
            />
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
          control={
            <SettingsToggle on={autoTrigger} onChange={setAutoTrigger} aria-label={t('settings.copilot.autoTrigger')} />
          }
        />
        <SettingsRow
          label={t('settings.copilot.enableInDrift')}
          desc={t('settings.copilot.enableInDriftDesc')}
          control={
            <SettingsToggle
              on={copilotInDrift}
              onChange={setCopilotInDrift}
              aria-label={t('settings.copilot.enableInDrift')}
            />
          }
        />
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.copilot.summaryTitle')} hint="SUMMARY" />
        <SettingsRow
          label={t('settings.copilot.generateSummaries')}
          desc={t('settings.copilot.generateSummariesDesc')}
          control={
            <SettingsToggle
              on={generateSummaries}
              onChange={setGenerateSummaries}
              aria-label={t('settings.copilot.generateSummaries')}
            />
          }
        />
        {generateSummaries && (
          <SettingsRow
            label={t('settings.copilot.summaryThreshold')}
            desc={t('settings.copilot.summaryThresholdDesc', { count: sectionSize })}
            stack
            control={
              <div className="set-copilot-threshold">
                <SettingsRange
                  wide
                  min={COPILOT_SECTION_SIZE_MIN}
                  max={COPILOT_SECTION_SIZE_MAX}
                  value={sectionSize}
                  ariaLabel={t('settings.copilot.summaryThreshold')}
                  onChange={setSectionSize}
                  style={{ flex: 1, accentColor: 'hsl(var(--accent))' }}
                />
                <span className="set-copilot-threshold__value">
                  {t('settings.copilot.blocks', { count: sectionSize })}
                </span>
              </div>
            }
          />
        )}
      </div>

      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.copilot.tasksTitle')} hint="TASKS" />
        <p className="set-row__desc set-copilot-tasks-desc">{t('settings.copilot.tasksDesc')}</p>
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
