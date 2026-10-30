import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { byokKeychain, type BYOKProvider } from '../../../lib/byok-keychain';
import {
  codexSubscription,
  isCodexLoginActive,
  type CodexSubscriptionStatus,
} from '../../../lib/codex-subscription';
import { speechKeychain } from '../../../lib/speech/speech-credentials';
import { testByokProviderConnection } from '../../../lib/ai/test-provider-connection';
import { readEnvApiKey } from '../../../lib/ai/credentials/env';
import { events } from '../../../lib/events';
import { useSettingsStore } from '../../../store/settings-store';
import {
  SettingsButton,
  SettingsField,
  SettingsPanelHeader,
  SettingsSectionHeader,
  type SettingsRegisterRef,
} from '../SettingsPrimitives';
import { settingsOnDesktop } from '../settings-on-desktop';
import { BrushIcon } from '../../../components/ui/BrushIcon';

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
  const agentProvider = useSettingsStore((state) => state.agentProvider);
  const agentModel = useSettingsStore((state) => state.agentModel);
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
      // Test with the model the Agent would use; other providers fall back
      // to their first catalog model.
      await testByokProviderConnection(provider, {
        ...(provider === agentProvider ? { model: agentModel } : {}),
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
    events.emit('byok:keys-changed');
  };

  const disconnect = async () => {
    await byokKeychain.clear(provider);
    setConnected(false);
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
 * tokens never reach the renderer, and it must not be treated as a BYOK
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
 * `ProviderRow`: it is not an LLM credential and must not join the BYOK
 * provider union. Same keychain-only storage contract as the rows above.
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
      </div>
      <div className="set-sec">
        <SettingsSectionHeader title={t('settings.models.speechTitle')} hint="BYOK · KEYCHAIN" />
        <p className="set-row__desc">{t('settings.models.speechDesc')}</p>
        <SpeechCredentialRow credentialsActive={credentialsActive} />
      </div>
    </section>
  );
}
