/**
 * The empty Agent conversation on its first run (agent-onboarding.ts): the
 * provider rows while no model can run, then three requests that fit the
 * book. Rows are sidebar cells — a sand seal, the name, the source in index
 * type — and a row opens in place to take a key or a ChatGPT sign-in.
 * Keys are only added here; Settings → Models & API manages them.
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KindMark } from '../../../components/ui/KindMark';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { Button } from '../../../components/ui/Button';
import { byokKeychain, type BYOKProvider } from '../../../lib/byok-keychain';
import { readEnvApiKey } from '../../../lib/ai/credentials/env';
import {
  codexSubscription,
  isCodexLoginActive,
  type CodexSubscriptionStatus,
} from '../../../lib/codex-subscription';
import {
  connectAgentProviderKey,
  selectAgentProvider,
  type ConnectAgentProviderResult,
} from '../../../lib/agent/connect-agent-provider';
import { agentProviderModelOption } from '../../../lib/agent/runtime/agent-provider-contract';
import { platform } from '../../../platform';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useRecentEntitiesStore } from '../../../store/recent-entities-store';
import { useSettingsStore } from '../../../store/settings-store';
import { isChapter } from '../../../domain/book-node';
import {
  AGENT_PROVIDER_KEY_PAGES,
  buildAgentStarterPrompts,
  type AgentOnboardingView,
} from './agent-onboarding';

const KEY_PROVIDERS: ReadonlyArray<{ id: BYOKProvider; name: string }> = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
];

type RowId = BYOKProvider | 'openai-codex';

export function AgentOnboarding({
  view,
  onPick,
}: {
  view: Exclude<AgentOnboardingView, null>;
  /** Send this request as the author's own. */
  onPick: (text: string) => void;
}) {
  // Connected in this panel: the suggestions open with the model it reached.
  const [connected, setConnected] = useState(false);
  return (
    <div className="agt-onboard" data-agent-onboarding={view}>
      {view === 'connect' ? (
        <ConnectSection onConnected={() => setConnected(true)} />
      ) : (
        <SuggestSection connected={connected} onPick={onPick} />
      )}
    </div>
  );
}

function ConnectSection({ onConnected }: { onConnected: () => void }) {
  const { t } = useTranslation();
  const [stored, setStored] = useState<Partial<Record<BYOKProvider, boolean>>>({});
  const [codex, setCodex] = useState<CodexSubscriptionStatus | null>(null);
  const [open, setOpen] = useState<RowId | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Existence only, like Settings: nothing is decrypted to draw the rows.
  useEffect(() => {
    let cancelled = false;
    for (const { id } of KEY_PROVIDERS) {
      void byokKeychain.has(id).catch(() => false).then((has) => {
        if (!cancelled) setStored((current) => ({ ...current, [id]: has }));
      });
    }
    void codexSubscription.status().then(
      (status) => { if (!cancelled) setCodex(status); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, []);

  const loginActive = isCodexLoginActive(codex);
  useEffect(() => {
    if (!loginActive) return;
    const timer = window.setInterval(() => {
      void codexSubscription.status().then(setCodex, () => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [loginActive]);

  const signedIn = codex?.signedIn === true;
  useEffect(() => {
    if (!signedIn || open !== 'openai-codex') return;
    selectAgentProvider('openai-codex');
    onConnected();
  }, [signedIn, open, onConnected]);

  const toggle = (id: RowId) => {
    setFailure(null);
    setDraft('');
    setOpen((current) => (current === id ? null : id));
  };

  const choose = (id: RowId, live: boolean) => {
    if (!live) return toggle(id);
    selectAgentProvider(id);
    onConnected();
  };

  const connect = async (provider: BYOKProvider) => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setFailure(null);
    let result: ConnectAgentProviderResult;
    try {
      result = await connectAgentProviderKey(provider, draft);
    } catch {
      result = { ok: false, reason: 'request' };
    }
    setBusy(false);
    if (result.ok) {
      onConnected();
      return;
    }
    setFailure(
      result.reason === 'auth'
        ? t('settings.byokProvider.invalidKey')
        : result.reason === 'storage'
          ? t('agentPanel.onboarding.saveFailed')
          : t('settings.byokProvider.requestFailed'),
    );
  };

  const signIn = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const login = await codexSubscription.startLogin();
      setCodex((current) => ({ signedIn: current?.signedIn ?? false, account: current?.account ?? null, login }));
    } catch {
      setFailure(t('settings.codexSubscription.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  const cancelSignIn = async () => {
    await codexSubscription.cancelLogin().catch(() => undefined);
    setCodex(await codexSubscription.status().catch(() => null));
  };

  const login = codex?.login ?? null;
  const loginFailure = login?.phase === 'failed' ? login.failure ?? 'provider_rejected' : null;
  const onKeyDown = (provider: BYOKProvider) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void connect(provider);
    }
  };

  return (
    <>
      <div className="agt-onboard__sec">{t('agentPanel.onboarding.connect')}</div>
      <ProviderCell
        id="openai-codex"
        name={t('settings.codexSubscription.name')}
        source={signedIn ? codex?.account?.email ?? t('settings.codexSubscription.signedInAs') : t('agentPanel.onboarding.experimental')}
        live={signedIn}
        open={open === 'openai-codex'}
        onClick={() => choose('openai-codex', signedIn)}
      >
        {loginActive && login ? (
          <>
            <div className="agt-onboard__row">
              <span className="agt-onboard__code">{login.userCode}</span>
              <BrushIcon name="loader" size={13} className="ui-spin" />
            </div>
            <div className="agt-onboard__row">
              <Button variant="primary" size="sm" onClick={() => codexSubscription.openVerification(login)}>
                {t('settings.codexSubscription.openVerification')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void cancelSignIn()}>
                {t('settings.common.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <div className="agt-onboard__row">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void signIn()}>
              {t('settings.codexSubscription.signIn')}
            </Button>
            {(failure || loginFailure) && (
              <Failure>{failure ?? t(`settings.codexSubscription.failure.${loginFailure}`)}</Failure>
            )}
          </div>
        )}
      </ProviderCell>
      {KEY_PROVIDERS.map(({ id, name }) => {
        const env = Boolean(readEnvApiKey(id));
        const live = env || stored[id] === true;
        return (
          <ProviderCell
            key={id}
            id={id}
            name={name}
            source={live ? (env ? '.ENV (DEV)' : 'Keychain') : ''}
            live={live}
            open={open === id}
            onClick={() => choose(id, live)}
          >
            <div className="agt-onboard__row">
              <label className="ui-field ui-field--sm ui-field--mono glass glass--rest glass--field agt-onboard__key">
                <input
                  type="password"
                  value={draft}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('settings.byokProvider.keyPlaceholder')}
                  aria-label={`${name} API Key`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown(id)}
                />
              </label>
              <Button variant="primary" size="sm" disabled={busy || !draft.trim()} onClick={() => void connect(id)}>
                {busy && <BrushIcon name="loader" size={12} className="ui-spin" />}
                {t('settings.common.connect')}
              </Button>
            </div>
            <div className="agt-onboard__row">
              <Button variant="ghost" size="sm" onClick={() => void platform.material.openExternal(AGENT_PROVIDER_KEY_PAGES[id])}>
                {t('agentPanel.onboarding.getKey')}
                <BrushIcon name="arrow-out" size={12} />
              </Button>
              {failure && <Failure>{failure}</Failure>}
            </div>
          </ProviderCell>
        );
      })}
    </>
  );
}

function ProviderCell({
  id,
  name,
  source,
  live,
  open,
  onClick,
  children,
}: {
  id: RowId;
  name: string;
  source: string;
  live: boolean;
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className={'agt-onboard__provider' + (open ? ' is-open' : '')} data-provider={id}>
      <button
        type="button"
        className="agt-onboard__cell glass glass--surface"
        aria-expanded={live ? undefined : open}
        onClick={onClick}
      >
        <KindMark kind="chapter" seed={id} hollow={!live} color="hsl(var(--ink-2))" />
        <span className="agt-onboard__name">{name}</span>
        {source && <span className="agt-onboard__src">{source}</span>}
      </button>
      {open && !live && <div className="agt-onboard__body">{children}</div>}
    </div>
  );
}

function Failure({ children }: { children: ReactNode }) {
  return (
    <span className="agt-onboard__failure" role="alert">
      <BrushIcon name="status-stopped" size={13} />
      {children}
    </span>
  );
}

function SuggestSection({
  connected,
  onPick,
}: {
  connected: boolean;
  onPick: (text: string) => void;
}) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const nodes = useDataStore((s) => s.bookNodes);
  const elements = useDataStore((s) => s.bookElements);
  const relations = useDataStore((s) => s.entityRelations);
  const recent = useRecentEntitiesStore((s) => s.items);
  const agentProvider = useSettingsStore((s) => s.agentProvider);
  const agentModel = useSettingsStore((s) => s.agentModel);

  const prompts = useMemo(() => {
    const chapters = nodes.filter(isChapter).filter((node) => node.projectId === projectId);
    // Links between elements find the book's hubs; appearances in chapters
    // would favour whatever was tagged most.
    const relationCounts: Record<string, number> = {};
    for (const relation of relations) {
      if (relation.fromKind !== 'element' || relation.toKind !== 'element') continue;
      relationCounts[relation.fromId] = (relationCounts[relation.fromId] ?? 0) + 1;
      relationCounts[relation.toId] = (relationCounts[relation.toId] ?? 0) + 1;
    }
    return buildAgentStarterPrompts({
      chapters,
      elements: elements
        .filter((element) => element.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      relationCounts,
      recentChapterIds: recent
        .filter((item) => item.projectId === projectId && item.entityType === 'node')
        .map((item) => item.entityId),
    });
  }, [nodes, elements, relations, recent, projectId]);

  return (
    <>
      {connected && (
        <div className="agt-onboard__connected">
          <KindMark kind="chapter" seed={agentProvider} color="hsl(var(--ink-2))" />
          <span className="agt-onboard__name">
            {agentProvider === 'openai-codex' ? t('settings.codexSubscription.name') : KEY_PROVIDERS.find((p) => p.id === agentProvider)?.name}
          </span>
          <span className="agt-onboard__src">{agentProviderModelOption(agentProvider, agentModel).short}</span>
        </div>
      )}
      <div className="agt-onboard__sec">{t('agentPanel.onboarding.try')}</div>
      {prompts.map((prompt) => {
        const text = t(`agentPanel.onboarding.prompts.${prompt.key}`, prompt.values);
        return (
          <button
            key={prompt.key}
            type="button"
            className="agt-onboard__cell agt-onboard__cell--prompt glass glass--surface"
            onClick={() => onPick(text)}
          >
            {prompt.mark && <KindMark kind={prompt.mark.kind} seed={prompt.mark.seed} />}
            <span className="agt-onboard__prompt">{text}</span>
          </button>
        );
      })}
    </>
  );
}
