/**
 * Agent panel — the interactive Drifting agent, rendered in the right sidebar's
 * "agent" tab group. Styled after the VS Code Claude Code plugin: a chat that
 * streams assistant text token-by-token, renders it as markdown, shows the
 * agent's tool calls, keeps a local history of past conversations, and exposes
 * a quick model switcher under the input.
 *
 * The conversation state + the agent-event subscription live in a module-level
 * store (useAgentChatStore), so this view survives the panel unmounting on tab
 * switches and streaming keeps flowing while it's not mounted. This component is
 * a thin projection: render + local UI concerns (scroll, history dropdown).
 *
 * Credential mode and model selection live in Settings → 模型与 API; the
 * switcher here writes the same store field. If the agent isn't set up for the
 * chosen mode, we show a hint that opens it.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { marked } from 'marked';
import { useTranslation } from 'react-i18next';
import {
  useSettingsStore,
  AGENT_PROVIDER_OPTIONS,
  agentProviderOption,
  type AgentProviderId,
} from '../../store/settings-store';
import {
  useAgentChatStore,
  selectAutomaticContinuation,
  selectAgentTaskContinuationReason,
  selectContextUsage,
  selectControlStatus,
  selectMessages,
  selectPendingControl,
  selectRunning,
  selectOtherRunning,
  selectRuntimeSessionId,
  selectForkCheckpointId,
} from '../../store/agent-chat-store';
import { useProjectStore } from '../../store/project-store';
import { useAgentMemory } from '../../usecase/useAgentMemory';
import { useAgentActivityStore } from '../../store/agent-activity-store';
import { Switch } from '../ui/Switch';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useAutosizeTextArea } from '../../hooks/useAutosizeTextArea';
import {
  collectTurnEntityRefs,
  type ActivityEntityType,
  type ToolEntityRef,
} from '../../lib/agent/tool-entity-ref';
import { events } from '../../lib/events';
import type {
  AgentControlStatus,
  AgentPendingControl,
  AgentPermissionScope,
  GeneralAgentAuthStatus,
} from '../../lib/agent/protocol';
import { generalAgentTransport } from '../../lib/agent/transport';
import type {
  AgentChatMessage as ChatMsg,
  AgentConversationSummary,
} from '../../domain/agent-conversation';
import {
  describeAgentToolActivity,
  shouldDisplayAgentToolActivity,
} from '../../lib/agent/agent-tool-activity';
import { AnchoredPopover } from '../ui/AnchoredPopover';
import { AgentContextIndicator } from './AgentContextIndicator';
import { FieldDiff } from '../editor/FieldReview';
import { AgentCheckpointMenu } from './AgentCheckpointMenu';
import '../../../styles/agent-panel.css';

const STREAM_FOLLOW_BOTTOM_THRESHOLD_PX = 16;

function relTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
}

// ---- Markdown (escape raw HTML first, so model output can't inject tags) ----

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function mdToHtml(text: string): string {
  return marked.parse(escapeHtml(text), { breaks: true, gfm: true, async: false }) as string;
}

// ---- Components ------------------------------------------------------------

function ToolRow({ msg }: { msg: Extract<ChatMsg, { kind: 'tool' }> }) {
  const { t, i18n } = useTranslation();
  const icon = msg.status === 'running' ? '◌' : msg.status === 'ok' ? '✓' : '✗';
  const semanticActivity = useMemo(
    () =>
      msg.phase === 'arguments' && msg.input === undefined
        ? ''
        : (describeAgentToolActivity(msg.name, msg.input, i18n.language) ?? ''),
    [i18n.language, msg.input, msg.name, msg.phase],
  );
  const inputStr = useMemo(() => {
    if (msg.inputText !== undefined) return msg.inputText;
    if (msg.input == null) return '';
    try {
      return JSON.stringify(msg.input, null, 2);
    } catch {
      return String(msg.input);
    }
  }, [msg.input, msg.inputText]);
  const semanticTool = semanticActivity.length > 0;
  const visibleInput = semanticTool ? '' : inputStr;
  const visibleResult = semanticTool && msg.status !== 'error' ? '' : (msg.result ?? '');
  const hasBody = !!visibleInput || !!visibleResult;
  // `tool_call_started` intentionally has no arguments yet. Showing a semantic
  // label at that point can only guess (for example list_files defaults to `/`),
  // then visibly rename itself once the real JSON arrives. Wait for ready/error;
  // the author sees one truthful action a moment later instead of a placeholder.
  if (
    !shouldDisplayAgentToolActivity({
      phase: msg.phase,
      toolInput: msg.input,
      status: msg.status,
    })
  )
    return null;
  const summary = (
    <>
      <span style={{ opacity: 0.7, width: 12, display: 'inline-block' }}>{icon}</span>
      {semanticTool ? (
        <span style={toolActivity}>{semanticActivity}</span>
      ) : (
        <code style={toolName}>{msg.name}</code>
      )}
      {msg.status === 'running' && <span style={{ opacity: 0.5 }}>…</span>}
    </>
  );
  return (
    <div style={semanticTool ? quietToolRow : toolRow}>
      {hasBody ? (
        <details style={toolDetails}>
          <summary style={toolSummary}>{summary}</summary>
          <div style={toolBody}>
            {visibleInput && (
              <>
                <div style={toolBodyLabel}>{t('agentPanel.tool.input')}</div>
                <pre style={toolPre}>{visibleInput}</pre>
              </>
            )}
            {visibleResult && (
              <>
                <div style={toolBodyLabel}>{t('agentPanel.tool.result')}</div>
                <pre style={toolPre}>{visibleResult}</pre>
              </>
            )}
          </div>
        </details>
      ) : (
        <div style={{ ...toolSummary, cursor: 'default' }}>{summary}</div>
      )}
    </div>
  );
}

function ThinkingRow({ msg }: { msg: Extract<ChatMsg, { kind: 'thinking' }> }) {
  const { t } = useTranslation();
  // Open while the model is thinking; auto-collapse once the block finishes.
  const [open, setOpen] = useState(true);
  const wasStreaming = useRef(msg.streaming);
  useEffect(() => {
    if (wasStreaming.current && !msg.streaming) setOpen(false);
    wasStreaming.current = msg.streaming;
  }, [msg.streaming]);
  return (
    <details open={open} style={thinkingRow}>
      <summary
        style={thinkingSummary}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        💭 {msg.streaming ? t('agentPanel.thinking.streaming') : t('agentPanel.thinking.done')}
      </summary>
      <div style={thinkingBody}>{msg.text}</div>
    </details>
  );
}

/**
 * The single composer config control: a quiet summary button that opens an
 * upward menu. The menu adjusts the active model and edit-review behavior.
 * Reasoning controls stay hidden until the product driver can replay provider
 * reasoning state across tool rounds.
 */
function ComposerConfig() {
  const { t } = useTranslation();
  const agentProvider = useSettingsStore((s) => s.agentProvider);
  const setAgentProvider = useSettingsStore((s) => s.setAgentProvider);
  const agentModel = useSettingsStore((s) => s.agentModel);
  const setAgentModel = useSettingsStore((s) => s.setAgentModel);
  const agentEditMode = useSettingsStore((s) => s.agentEditMode);
  const setAgentEditMode = useSettingsStore((s) => s.setAgentEditMode);

  const projectId = useProjectStore((s) => s.currentProject?.id ?? '');
  const memory = useAgentMemory(projectId);
  const visibleMemories = memory.memories.filter((m) => m.status !== 'dismissed');

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'model' | 'memory'>('main');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const modelOptions = agentProviderOption(agentProvider).models;
  const modelOption = modelOptions.find((m) => m.value === agentModel);
  const modelShort = t(`settings.agent.modelOptions.${agentModel}.short`, {
    defaultValue: modelOption?.short ?? agentModel,
  });
  const close = () => {
    setOpen(false);
    setView('main');
  };

  return (
    <div className="agt-pop">
      <button
        ref={triggerRef}
        type="button"
        className={'agt-cfg' + (open ? ' agt-cfg--open' : '')}
        onClick={() => setOpen((o) => !o)}
        title={t('agentPanel.config.title')}
        aria-label={t('agentPanel.config.aria')}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="4" y1="8" x2="20" y2="8" />
          <circle cx="9" cy="8" r="2.3" fill="currentColor" stroke="none" />
          <line x1="4" y1="16" x2="20" y2="16" />
          <circle cx="15" cy="16" r="2.3" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        placement="top-start"
        maxHeight={360}
        className="agt-menu"
        role="dialog"
        ariaLabel={t('agentPanel.config.aria')}
      >
        {view === 'main' ? (
          <>
            <div className="agt-menu__sec">{t('agentPanel.config.model')}</div>
            <button
              type="button"
              className="agt-menu__row agt-menu__row--btn"
              onClick={() => setView('model')}
            >
              <span>{t('agentPanel.config.switchModel')}</span>
              <span className="agt-menu__val">
                {modelShort}
                <span className="agt-menu__caret">›</span>
              </span>
            </button>
            <div className="agt-menu__divider" />
            <div className="agt-menu__sec">{t('agentPanel.config.edits')}</div>
            <div className="agt-menu__row" title={t('agentPanel.config.reviewEditsTitle')}>
              <span>{t('agentPanel.config.reviewEdits')}</span>
              <Switch
                checked={agentEditMode === 'approve'}
                onCheckedChange={(checked) => setAgentEditMode(checked ? 'approve' : 'auto')}
              />
            </div>
            <div className="agt-menu__divider" />
            <div className="agt-menu__sec">{t('agentPanel.config.memory')}</div>
            <button
              type="button"
              className="agt-menu__row agt-menu__row--btn"
              title={t('agentPanel.config.memoryTitle')}
              onClick={() => {
                void memory.refresh();
                setView('memory');
              }}
            >
              <span>{t('agentPanel.config.manageMemory')}</span>
              <span className="agt-menu__val">
                {visibleMemories.length || t('agentPanel.common.none')}
                <span className="agt-menu__caret">›</span>
              </span>
            </button>
          </>
        ) : view === 'model' ? (
          <>
            <button type="button" className="agt-menu__back" onClick={() => setView('main')}>
              ‹ {t('agentPanel.config.model')}
            </button>
            {AGENT_PROVIDER_OPTIONS.map((provider) => (
              <div key={provider.value}>
                <div className="agt-menu__sec">{provider.label}</div>
                {provider.models.map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    className={
                      'agt-menu__opt' +
                      (provider.value === agentProvider && m.value === agentModel
                        ? ' agt-menu__opt--active'
                        : '')
                    }
                    onClick={() => {
                      setAgentProvider(provider.value as AgentProviderId);
                      setAgentModel(m.value);
                      setView('main');
                    }}
                  >
                    <span>
                      {t(`settings.agent.modelOptions.${m.value}.label`, {
                        defaultValue: m.label,
                      })}
                    </span>
                    {provider.value === agentProvider && m.value === agentModel && (
                      <span className="agt-menu__check">●</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </>
        ) : (
          <>
            <button type="button" className="agt-menu__back" onClick={() => setView('main')}>
              ‹ {t('agentPanel.config.memory')}
            </button>
            {visibleMemories.length === 0 ? (
              <div className="agt-menu__row agt-menu__row--empty">
                <span style={{ opacity: 0.6 }}>{t('agentPanel.config.noMemory')}</span>
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                {visibleMemories.map((m) => (
                  <div key={m.id} className="agt-mem">
                    <div className="agt-mem__main">
                      <span className={'agt-mem__kind agt-mem__kind--' + m.kind}>
                        {m.kind === 'veto'
                          ? t('agentPanel.memoryKind.veto')
                          : m.kind === 'directive'
                            ? t('agentPanel.memoryKind.directive')
                            : t('agentPanel.memoryKind.preference')}
                      </span>
                      <span className="agt-mem__body" title={m.body}>
                        {m.body}
                      </span>
                    </div>
                    <div className="agt-mem__acts">
                      {m.status === 'pending' && (
                        <button
                          type="button"
                          className="agt-mem__btn"
                          title={t('agentPanel.config.approveMemory')}
                          onClick={() => void memory.approve(m.id)}
                        >
                          ✓
                        </button>
                      )}
                      <button
                        type="button"
                        className="agt-mem__btn agt-mem__btn--del"
                        title={t('common.delete')}
                        onClick={() => void memory.remove(m.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </AnchoredPopover>
    </div>
  );
}

/**
 * Assistant bubble. Memoized + the markdown parse is memoized on the text, so a
 * stable (non-streaming) message never re-runs marked.parse — this is what keeps
 * typing in the composer responsive even with a long transcript (every keystroke
 * used to re-parse every assistant message).
 */
const AssistantBubble = memo(function AssistantBubble({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const html = useMemo(() => mdToHtml(text), [text]);
  return (
    <div
      className="agent-md"
      style={assistantBubble}
      dangerouslySetInnerHTML={{
        __html: html + (streaming ? '<span class="agent-caret">▌</span>' : ''),
      }}
    />
  );
});

/** Compact token count: 1234 → "1.2k", 23000 → "23k". */
function fmtTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

/** Compact duration: 850 → "850ms", 4200 → "4.2s". */
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Subtle per-turn diagnostic badge appended after each agent turn.
 *
 * Beyond token/cost it surfaces the latency split that distinguishes "the model
 * is slow" from "the local tool bridge is slow":
 *   ⏱ total = SDK duration_ms (wall-clock for the whole turn)
 *   api      = SDK duration_api_ms (time in model API calls)
 *   总 − api = local overhead (transport + Yjs hydration + tool work)
 * and the cache-hit indicator (⚡ = cache_read_input_tokens): a large ⚡ with a
 * small cache-write means the tools+system prefix is being reused, so per-turn
 * cost is dominated by output/thinking, not input re-processing.
 */
function UsageRow({ msg }: { msg: Extract<ChatMsg, { kind: 'usage' }> }) {
  const { t } = useTranslation();
  const inTok = msg.inputTokens + msg.cacheReadTokens + msg.cacheCreationTokens;
  const hasTiming = msg.durationMs != null;
  const localMs =
    msg.durationMs != null && msg.durationApiMs != null
      ? Math.max(0, msg.durationMs - msg.durationApiMs)
      : null;
  const title =
    `${t('agentPanel.usage.turnUsage')}\n` +
    `${t('agentPanel.usage.inputDetail', {
      input: inTok,
      cacheRead: msg.cacheReadTokens,
      cacheWrite: msg.cacheCreationTokens,
      net: msg.inputTokens,
    })}\n` +
    `${t('agentPanel.usage.outputTurns', {
      output: msg.outputTokens,
      turns: msg.turns,
    })}` +
    (msg.costUsd > 0 ? ` · ${fmtCost(msg.costUsd)}` : '') +
    (hasTiming
      ? `\n${t('agentPanel.usage.timingDetail', {
          total: msg.durationMs,
          api: msg.durationApiMs,
          local: localMs,
        })}` + `\n${t('agentPanel.usage.timingHint')}`
      : '');
  return (
    <div style={usageRow} title={title}>
      ↑{fmtTokens(inTok)} ↓{fmtTokens(msg.outputTokens)}
      {msg.costUsd > 0 ? ` · ${fmtCost(msg.costUsd)}` : ''}
      {hasTiming ? ` · ⏱${fmtMs(msg.durationMs!)}` : ''}
      {hasTiming && msg.durationApiMs != null ? ` (api ${fmtMs(msg.durationApiMs)})` : ''}
      {msg.turns > 0 ? ` · ${t('agentPanel.usage.turnsShort', { count: msg.turns })}` : ''}
      {msg.cacheReadTokens > 0 ? ` · ⚡${fmtTokens(msg.cacheReadTokens)}` : ''}
    </div>
  );
}

const ENTITY_GLYPH: Record<ActivityEntityType, string> = {
  node: '§',
  element: '◆',
  storyline: '◈',
  category: '▣',
};

function entityRefName(
  s: ReturnType<typeof useDataStore.getState>,
  ref: ToolEntityRef,
  deletedLabel: string,
): string {
  switch (ref.entityType) {
    case 'node':
      return s.bookNodes.find((n) => n.id === ref.id)?.title || deletedLabel;
    case 'element':
      return s.bookElements.find((e) => e.id === ref.id)?.name || deletedLabel;
    case 'storyline':
      return s.storylines.find((sl) => sl.id === ref.id)?.name || deletedLabel;
    case 'category':
      return s.bookElementCategories.find((c) => c.id === ref.id)?.name || deletedLabel;
    default:
      return ref.id;
  }
}

/** A clickable pill for an entity the agent created/edited — jumps to its tab. */
function EntityLinkChip({
  refItem,
  onOpen,
}: {
  refItem: ToolEntityRef;
  onOpen: (ref: ToolEntityRef) => void;
}) {
  const { t } = useTranslation();
  const deletedLabel = t('common.deleted_paren');
  const name = useDataStore((s) => entityRefName(s, refItem, deletedLabel));
  return (
    <button type="button" className="agt-entity-chip" onClick={() => onOpen(refItem)}>
      <span className="agt-entity-chip__glyph">{ENTITY_GLYPH[refItem.entityType]}</span>
      <span>{name}</span>
      <span className="agt-entity-chip__op">
        {refItem.op === 'create' ? t('agentPanel.entity.created') : t('agentPanel.entity.edited')}
      </span>
    </button>
  );
}

/**
 * A row indicating the agent is working but nothing is actively streaming yet —
 * i.e. it's reasoning. The OAuth path returns no plaintext thinking, so instead
 * of content we show an elapsed-seconds counter that grows while we wait, so the
 * user has live feedback that the model is busy. Remounts each thinking gap, so
 * the count starts fresh whenever the model drops back into思考.
 */
function PendingRow({ status }: { status: AgentControlStatus | null }) {
  const { t } = useTranslation();
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = window.setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, []);
  const label =
    status === 'committing'
      ? t('agentPanel.pending.committing', { defaultValue: '正在保存…' })
      : status === 'cancelling'
        ? t('agentPanel.pending.cancelling', { defaultValue: '正在停止…' })
        : secs > 0
          ? t('agentPanel.pending.withSeconds', { seconds: secs })
          : t('agentPanel.pending.now');
  return (
    <div className="agt-pending">
      <span className="agt-pending__dot" />
      <span className="agt-pending__dot" />
      <span className="agt-pending__dot" />
      <span>{label}</span>
    </div>
  );
}

// Memoized so that re-rendering CompanionPanel (e.g. on every keystroke in the
// composer) does not re-render/-parse every message — only messages whose `msg`
// object identity changed (the streaming tail) re-render.
const MessageView = memo(function MessageView({ msg }: { msg: ChatMsg }) {
  switch (msg.kind) {
    case 'user':
      return (
        <div style={userRow}>
          <div style={userBubble}>{msg.text}</div>
        </div>
      );
    case 'thinking':
      return <ThinkingRow msg={msg} />;
    case 'assistant':
      return <AssistantBubble text={msg.text} streaming={msg.streaming} />;
    case 'tool':
      return <ToolRow msg={msg} />;
    case 'todos':
      return <TodoList items={msg.items} />;
    case 'usage':
      return <UsageRow msg={msg} />;
    case 'error':
      return <div style={errorBubble}>⚠ {msg.text}</div>;
    default:
      return null;
  }
});

function RuntimeControlCard({
  pending,
  onPermission,
  onCancelRecovered,
}: {
  pending: AgentPendingControl;
  onPermission: (decision: 'allow' | 'deny', scope?: AgentPermissionScope) => void;
  onCancelRecovered: () => void;
}) {
  const { t, i18n } = useTranslation();
  if (pending.requiresContinuation) {
    return (
      <div className="agt-control-card" role="status">
        <strong>{t('agentPanel.control.recoveredTitle')}</strong>
        <span>{t('agentPanel.control.recoveredBody')}</span>
        <div className="agt-control-card__actions">
          <button type="button" onClick={onCancelRecovered}>
            {t('agentPanel.control.endRecovered')}
          </button>
        </div>
      </div>
    );
  }

  const permission = pending.permissionRequest;
  if (pending.status === 'waiting_permission' && permission) {
    const activity = describeAgentToolActivity(
      permission.toolName,
      permission.arguments,
      i18n.language,
    );
    let argumentsText = '{}';
    try {
      argumentsText = JSON.stringify(permission.arguments, null, 2);
    } catch {
      argumentsText = String(permission.arguments);
    }
    return (
      <div className="agt-control-card" role="alertdialog">
        <strong>{t('agentPanel.control.permissionTitle')}</strong>
        <span>
          {activity ?? <code>{permission.toolName}</code>}
          {activity
            ? ` · ${t('agentPanel.control.destructiveHint', {
                defaultValue: '这项操作会改变作品结构，需要你先确认',
              })}`
            : permission.reason
              ? ` · ${permission.reason}`
              : ''}
        </span>
        <EditFilePermissionPreview arguments_={permission.arguments} />
        <details>
          <summary>{t('agentPanel.control.arguments')}</summary>
          <pre>{argumentsText}</pre>
        </details>
        <div className="agt-control-card__actions">
          <button type="button" onClick={() => onPermission('deny', 'once')}>
            {t('agentPanel.control.deny')}
          </button>
          {permission.allowedScopes.map((scope) => (
            <button
              key={scope}
              type="button"
              className="agt-control-card__allow"
              onClick={() => onPermission('allow', scope)}
            >
              {t(`agentPanel.control.allow.${scope}`)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const request = pending.userInputRequest;
  if (pending.status === 'waiting_user' && request) {
    return (
      <div className="agt-control-card" role="status">
        <strong>{t('agentPanel.control.questionTitle')}</strong>
        <span>{request.prompt}</span>
        <small>{t('agentPanel.control.answerHint')}</small>
      </div>
    );
  }
  return null;
}

function EditFilePermissionPreview({ arguments_ }: { arguments_: Record<string, unknown> }) {
  const { t } = useTranslation();
  const path = typeof arguments_.path === 'string' ? arguments_.path : '';
  const replacements = Array.isArray(arguments_.replacements)
    ? arguments_.replacements.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const row = value as Record<string, unknown>;
        return typeof row.oldText === 'string' && typeof row.newText === 'string'
          ? [{ oldText: row.oldText, newText: row.newText, replaceAll: row.replaceAll === true }]
          : [];
      })
    : [];
  if (!path || replacements.length === 0) return null;
  return (
    <div className="agt-permission-edit">
      <div className="agt-permission-edit__path">
        {t('agentPanel.control.editPreview')} <code>{path}</code>
      </div>
      {replacements.map((replacement, index) => (
        <div key={`${index}:${replacement.oldText}`} className="agt-permission-edit__diff">
          <FieldDiff oldText={replacement.oldText} newText={replacement.newText} />
          {replacement.replaceAll && <small>{t('agentPanel.control.replaceAll')}</small>}
        </div>
      ))}
    </div>
  );
}

function TodoList({ items }: { items: Extract<ChatMsg, { kind: 'todos' }>['items'] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === 'completed').length;
  return (
    <div style={todoBox}>
      <div style={todoHead}>
        <span>{t('agentPanel.todos.plan')}</span>
        <span style={{ opacity: 0.7 }}>
          {done}/{items.length}
        </span>
      </div>
      {items.map((t, i) => {
        const icon = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐';
        const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
        return (
          <div key={i} style={todoItem}>
            <span
              style={{ width: 14, flexShrink: 0, opacity: t.status === 'completed' ? 0.5 : 0.85 }}
            >
              {icon}
            </span>
            <span
              style={{
                textDecoration: t.status === 'completed' ? 'line-through' : 'none',
                opacity: t.status === 'completed' ? 0.55 : 1,
                fontWeight: t.status === 'in_progress' ? 600 : 400,
              }}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CompanionPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = generalAgentTransport;
  const agentAuth = useSettingsStore((s) => s.agentAuth);

  // Chat state + actions live in the module store so they persist across the
  // panel unmounting (tab switches) and streaming keeps flowing while unmounted.
  const messages = useAgentChatStore(selectMessages);
  const prompt = useAgentChatStore((s) => s.prompt);
  // `running` = the displayed conversation has the in-flight turn. `otherRunning`
  // = a turn is running, but in a different conversation than the one shown.
  const running = useAgentChatStore(selectRunning);
  const otherRunning = useAgentChatStore(selectOtherRunning);
  const starting = useAgentChatStore((s) => s.starting);
  const controlStatus = useAgentChatStore(selectControlStatus);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const continuationReason = useAgentChatStore(selectAgentTaskContinuationReason);
  const automaticContinuation = useAgentChatStore(selectAutomaticContinuation);
  const contextUsage = useAgentChatStore(selectContextUsage);
  const runtimeSessionId = useAgentChatStore(selectRuntimeSessionId);
  const forkCheckpointId = useAgentChatStore(selectForkCheckpointId);
  const runningConvId = useAgentChatStore((s) => s.runningConvId);
  const convList = useAgentChatStore((s) => s.convList);
  const activeConvId = useAgentChatStore((s) => s.activeConvId);
  const setPrompt = useAgentChatStore((s) => s.setPrompt);
  const send = useAgentChatStore((s) => s.send);
  const continueTask = useAgentChatStore((s) => s.continueTask);
  const respondPermission = useAgentChatStore((s) => s.respondPermission);
  const stopAfterTool = useAgentChatStore((s) => s.stopAfterTool);
  const cancelRecoveredControl = useAgentChatStore((s) => s.cancelRecoveredControl);
  const newConversation = useAgentChatStore((s) => s.newConversation);
  const loadConversation = useAgentChatStore((s) => s.loadConversation);
  const deleteConversation = useAgentChatStore((s) => s.deleteConversation);
  const renameConversation = useAgentChatStore((s) => s.renameConversation);
  const bindProject = useAgentChatStore((s) => s.bindProject);
  const refreshConversations = useAgentChatStore((s) => s.refreshList);

  const [status, setStatus] = useState<GeneralAgentAuthStatus | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  // Inline rename: the header edits the active conversation; a history row edits
  // whichever entry is `editingItemId`.
  const [editingHeaderId, setEditingHeaderId] = useState<string | null>(null);
  const [headerDraft, setHeaderDraft] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  // Auto-grow the composer from one line up to the CSS max-height (then it scrolls
  // internally). A ref-callback + ResizeObserver (not a one-shot [prompt] effect)
  // so the height is re-measured every mount AND when the textarea regains a real
  // size — e.g. when the right column is switched away and back, which unmounts +
  // remounts this panel. The old [prompt]-only effect re-ran once on remount before
  // the panel had settled its width, so a multi-line draft collapsed to one row.
  const taRef = useAutosizeTextArea(prompt);
  // Whether to keep pinning the view to the bottom during streaming. The user
  // scrolling up sets this false (breaks free); scrolling back to the bottom
  // re-engages it.
  const stickRef = useRef(true);

  const refreshStatus = useCallback(() => {
    if (!api.capability.available) return;
    void api
      .authStatus()
      .then((result) => {
        setStatus(
          result.ok
            ? result.value
            : { byokConnected: false, apiKeyConnected: false, hostedAvailable: false },
        );
      })
      .catch(() =>
        setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false }),
      );
  }, [api]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Re-check after the user connects/disconnects in Settings.
  useEffect(() => {
    events.on('agent:auth-changed', refreshStatus);
    return () => events.off('agent:auth-changed', refreshStatus);
  }, [refreshStatus]);

  // Bind the active project: loads its history, and resets the live chat only
  // if the project actually changed (a remount with the same project keeps it).
  useEffect(() => {
    bindProject(projectId);
  }, [projectId, bindProject]);

  // Auto-follow the stream only while pinned to the bottom.
  useEffect(() => {
    if (stickRef.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, pendingControl, controlStatus]);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const bottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STREAM_FOLLOW_BOTTOM_THRESHOLD_PX;
    stickRef.current = bottom;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  const handleSend = useCallback(() => {
    stickRef.current = true; // sending re-engages auto-follow
    setAtBottom(true);
    void send();
  }, [send]);

  const handleNew = useCallback(() => {
    newConversation();
    setShowHistory(false);
    setEditingHeaderId(null);
    setEditingItemId(null);
    stickRef.current = true;
    setAtBottom(true);
  }, [newConversation]);

  const handleLoad = useCallback(
    (id: string) => {
      void loadConversation(id);
      setShowHistory(false);
      setEditingHeaderId(null);
      setEditingItemId(null);
      stickRef.current = true;
      setAtBottom(true);
    },
    [loadConversation],
  );

  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void deleteConversation(id);
    },
    [deleteConversation],
  );

  // The active conversation's summary (gives the current session's title). Null
  // until the first turn persists a row — a fresh chat has no name to rename.
  const activeConv = convList.find((c) => c.id === activeConvId) ?? null;
  const sessionName = activeConv
    ? activeConv.title || t('common.untitled')
    : t('agentPanel.newConversation');
  // Title of the conversation whose turn is running in the background (if any),
  // for the "switch to the running conversation" banner.
  const runningConv = otherRunning ? (convList.find((c) => c.id === runningConvId) ?? null) : null;
  const editingHeader = editingHeaderId !== null && editingHeaderId === activeConvId;
  const automaticContinuationActive =
    automaticContinuation?.status === 'armed' ||
    automaticContinuation?.status === 'evaluating' ||
    automaticContinuation?.status === 'scheduled';

  // Show a "思考中…" placeholder whenever the agent is running but nothing is
  // actively streaming — i.e. the dead-air gaps (right after send, and between a
  // tool finishing and the next token), where there was previously no feedback.
  const lastMsg = messages[messages.length - 1];
  const busyTail =
    !!lastMsg &&
    (((lastMsg.kind === 'assistant' || lastMsg.kind === 'thinking') && lastMsg.streaming) ||
      (lastMsg.kind === 'tool' && lastMsg.status === 'running'));
  const waiting = (running || starting) && !busyTail && !pendingControl;

  // Session totals — summed across the conversation's per-turn usage rows (which
  // persist in the transcript), plus a tool-call count. Drives the footer.
  const sessionUsage = useMemo(() => {
    let inTok = 0;
    let outTok = 0;
    let cost = 0;
    let tools = 0;
    for (const m of messages) {
      if (m.kind === 'usage') {
        inTok += m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
        outTok += m.outputTokens;
        cost += m.costUsd;
      } else if (m.kind === 'tool') {
        tools += 1;
      }
    }
    return { inTok, outTok, cost, tools };
  }, [messages]);

  // Entities the agent created/edited this turn → clickable "本轮改动" links.
  const { openEntity } = useProjectNavigation();
  const turnRefs = useMemo(
    () => (running ? [] : collectTurnEntityRefs(messages)),
    [messages, running],
  );
  const openRef = useCallback(
    (ref: ToolEntityRef) => {
      openEntity({ entityType: ref.entityType, id: ref.id });
      useAgentActivityStore.getState().clearTouched(ref.entityType, ref.id);
    },
    [openEntity],
  );

  const beginHeaderRename = useCallback(() => {
    if (!activeConv) return;
    setHeaderDraft(activeConv.title || '');
    setEditingHeaderId(activeConv.id);
  }, [activeConv]);

  const commitHeaderRename = useCallback(() => {
    setEditingHeaderId(null);
    const text = headerDraft.trim();
    if (editingHeaderId && text) void renameConversation(editingHeaderId, text);
  }, [editingHeaderId, headerDraft, renameConversation]);

  const beginItemRename = useCallback((c: AgentConversationSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingItemId(c.id);
    setItemDraft(c.title || '');
  }, []);

  const commitItemRename = useCallback(
    (id: string) => {
      setEditingItemId(null);
      const text = itemDraft.trim();
      if (text) void renameConversation(id, text);
    },
    [itemDraft, renameConversation],
  );

  if (!api.capability.available) {
    return (
      <div style={hintBox} role="status">
        <div style={hintTitle}>{t('agentPanel.unavailableTitle')}</div>
        <div style={hintText}>{t('agentPanel.unavailableReason')}</div>
        <div style={hintText}>{t('agentPanel.unavailableFuture')}</div>
      </div>
    );
  }
  if (status === null) {
    return <div style={hintBox}>{t('agentPanel.checking')}</div>;
  }

  const usable =
    agentAuth === 'hosted'
      ? status.hostedAvailable
      : agentAuth === 'apikey'
        ? status.apiKeyConnected
        : status.byokConnected;

  // ---- Not set up → point to Settings (connect / subscribe lives there) ----
  if (!usable) {
    const notConnectedText =
      agentAuth === 'hosted'
        ? t('agentPanel.setup.hosted')
        : agentAuth === 'apikey'
          ? t('agentPanel.setup.apiKey')
          : t('agentPanel.setup.byok');
    return (
      <div style={hintBox}>
        <div style={hintTitle}>{t('agentPanel.setup.title')}</div>
        <div style={hintText}>{notConnectedText}</div>
        <button
          type="button"
          style={primaryBtn}
          onClick={() => events.emit('settings:open', { railId: 'agent' })}
        >
          {t('agentPanel.setup.openSettings')}
        </button>
      </div>
    );
  }

  // ---- Chat ----
  return (
    <div style={fillStyle}>
      <style>{panelCss}</style>
      <div style={toolbar}>
        {editingHeader ? (
          <input
            style={nameInput}
            value={headerDraft}
            autoFocus
            onChange={(e) => setHeaderDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitHeaderRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitHeaderRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditingHeaderId(null);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="agt-name"
            style={sessionNameBtn}
            onClick={beginHeaderRename}
            disabled={!activeConv}
            title={activeConv ? t('agentPanel.toolbar.renameTitle') : undefined}
          >
            {sessionName}
          </button>
        )}
        <div style={toolbarRight}>
          <AgentContextIndicator snapshot={contextUsage} />
          <AgentCheckpointMenu
            projectId={projectId}
            conversationId={activeConvId}
            runtimeSessionId={runtimeSessionId}
            forkCheckpointId={forkCheckpointId}
            messages={messages}
            mode={agentAuth === 'hosted' ? 'hosted' : 'byok'}
            disabled={running || otherRunning || starting}
            loadConversation={loadConversation}
            refreshConversations={refreshConversations}
          />
          <button
            ref={historyTriggerRef}
            type="button"
            style={ghostBtn}
            onClick={() => {
              setShowHistory((s) => !s);
            }}
            title={t('agentPanel.toolbar.historyTitle')}
            aria-expanded={showHistory}
            aria-haspopup="dialog"
          >
            ☰ {t('agentPanel.toolbar.history')}
            {convList.length ? ` · ${convList.length}` : ''}
          </button>
          <button
            type="button"
            style={ghostBtn}
            onClick={handleNew}
            title={t('agentPanel.toolbar.newTitle')}
          >
            ＋ {t('agentPanel.newConversation')}
          </button>
        </div>
      </div>

      <AnchoredPopover
        anchorRef={historyTriggerRef}
        open={showHistory}
        onClose={() => setShowHistory(false)}
        placement="bottom-end"
        role="dialog"
        ariaLabel={t('agentPanel.toolbar.historyTitle')}
        maxHeight={280}
        style={historyPanel}
        autoFocus={false}
        restoreFocus={false}
      >
        {convList.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>
            {t('agentPanel.history.empty')}
          </div>
        ) : (
          convList.map((c) =>
            editingItemId === c.id ? (
              <div key={c.id} style={historyItem} onClick={(e) => e.stopPropagation()}>
                <input
                  style={historyInput}
                  value={itemDraft}
                  autoFocus
                  onChange={(e) => setItemDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onBlur={() => commitItemRename(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitItemRename(c.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingItemId(null);
                    }
                  }}
                />
              </div>
            ) : (
              <div
                key={c.id}
                style={{ ...historyItem, ...(c.id === activeConvId ? historyItemActive : null) }}
              >
                <button type="button" style={historyLoadButton} onClick={() => handleLoad(c.id)}>
                  <span style={historyTitle}>{c.title || t('agentPanel.history.untitled')}</span>
                  <span style={historyTime}>{relTime(c.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  style={historyAct}
                  title={t('agentPanel.history.rename')}
                  onClick={(e) => beginItemRename(c, e)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  style={historyAct}
                  title={t('agentPanel.history.delete')}
                  onClick={(e) => handleDelete(c.id, e)}
                >
                  ×
                </button>
              </div>
            ),
          )
        )}
      </AnchoredPopover>

      <div style={logWrap}>
        <div ref={logRef} style={logStyle} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div style={{ opacity: 0.5 }}>{t('agentPanel.empty.start')}</div>
          ) : (
            messages.map((m, i) => <MessageView key={i} msg={m} />)
          )}
          {waiting && <PendingRow status={controlStatus} />}
          {pendingControl && (
            <RuntimeControlCard
              pending={pendingControl}
              onPermission={(decision, scope) => {
                void respondPermission(decision, scope);
              }}
              onCancelRecovered={() => {
                void cancelRecoveredControl();
              }}
            />
          )}
          {continuationReason && (
            <div className="agt-control-card" role="status">
              <strong>
                {automaticContinuation?.stopReason === 'waiting_review'
                  ? t('agentPanel.autoContinue.waitingReviewTitle')
                  : automaticContinuation?.stopReason === 'no_progress'
                    ? t('agentPanel.autoContinue.noProgressTitle')
                    : continuationReason === 'budget_exceeded'
                      ? t('agentPanel.budget.title', {
                          defaultValue: '本次上下文需要续接',
                        })
                      : t('agentPanel.longTask.title', {
                          defaultValue: '任务计划尚未完成',
                        })}
              </strong>
              <span>
                {automaticContinuation?.stopReason === 'waiting_review'
                  ? t('agentPanel.autoContinue.waitingReviewBody')
                  : automaticContinuation?.stopReason === 'no_progress'
                    ? t('agentPanel.autoContinue.noProgressBody')
                    : continuationReason === 'budget_exceeded'
                      ? t('agentPanel.budget.body', {
                          defaultValue:
                            '已完成的进度会保留。继续后，Agent 会从持久化状态恢复并接着处理。',
                        })
                      : t('agentPanel.longTask.body', {
                          defaultValue:
                            '本轮已正常结束，但同一会话的持久化任务计划仍有未完成内容。你可以继续执行下一步。',
                        })}
              </span>
              <div className="agt-control-card__actions">
                <button
                  type="button"
                  className="agt-control-card__allow"
                  onClick={() => void continueTask()}
                >
                  {t('agentPanel.budget.continue', {
                    defaultValue: '继续此任务',
                  })}
                </button>
              </div>
            </div>
          )}
          {turnRefs.length > 0 && (
            <div className="agt-entity-links">
              <span style={{ opacity: 0.55, fontSize: 11 }}>{t('agentPanel.turnChanges')}</span>
              {turnRefs.map((r) => (
                <EntityLinkChip key={`${r.entityType}:${r.id}`} refItem={r} onOpen={openRef} />
              ))}
            </div>
          )}
        </div>
        {!atBottom && (
          <button
            type="button"
            style={jumpBtn}
            onClick={jumpToBottom}
            title={t('agentPanel.jumpLatest')}
          >
            ↓
          </button>
        )}
      </div>

      {(sessionUsage.outTok > 0 || sessionUsage.tools > 0) && (
        <div style={usageFooter} title={t('agentPanel.usage.sessionTitle')}>
          <span style={{ opacity: 0.7 }}>{t('agentPanel.usage.session')}</span>
          <span>
            ↑{fmtTokens(sessionUsage.inTok)} ↓{fmtTokens(sessionUsage.outTok)}
          </span>
          {sessionUsage.cost > 0 && <span>{fmtCost(sessionUsage.cost)}</span>}
          <span>{t('agentPanel.usage.toolsCount', { count: sessionUsage.tools })}</span>
        </div>
      )}

      <div style={inputArea}>
        {otherRunning && runningConvId && (
          <button
            type="button"
            className="agt-otherrun"
            onClick={() => handleLoad(runningConvId)}
            title={t('agentPanel.running.switchTitle')}
          >
            <span className="agt-otherrun__dot" />
            <span className="agt-otherrun__text">
              {t('agentPanel.running.message', {
                title: runningConv?.title || t('agentPanel.running.otherConversation'),
              })}
            </span>
          </button>
        )}
        <div className="agt-composer">
          <textarea
            ref={taRef}
            className="agt-composer__text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              pendingControl?.status === 'waiting_user' && !pendingControl.requiresContinuation
                ? t('agentPanel.composer.answerPlaceholder')
                : running
                  ? t('agentPanel.composer.steerPlaceholder')
                  : t('agentPanel.composer.placeholder')
            }
            disabled={starting || Boolean(pendingControl?.requiresContinuation)}
            rows={1}
          />
          <div className="agt-composer__bar">
            <ComposerConfig />
            <div className="agt-composer__spacer" />
            {running || automaticContinuationActive ? (
              <>
                <button
                  type="button"
                  className="agt-send agt-send--stop"
                  onClick={() => void stopAfterTool()}
                  disabled={starting}
                  title={t('agentPanel.composer.stopAfterToolTitle')}
                >
                  {t('agentPanel.composer.stop')}
                </button>
                {running && (
                  <button
                    type="button"
                    className="agt-send"
                    onClick={handleSend}
                    disabled={
                      !prompt.trim() ||
                      starting ||
                      controlStatus === 'waiting_permission' ||
                      controlStatus === 'cancelling' ||
                      controlStatus === 'committing'
                    }
                    title={t('agentPanel.composer.steerTitle')}
                  >
                    {pendingControl?.status === 'waiting_user'
                      ? t('agentPanel.composer.answer')
                      : t('agentPanel.composer.steer')}
                  </button>
                )}
              </>
            ) : otherRunning ? (
              <button
                type="button"
                className="agt-send"
                disabled
                style={{ opacity: 0.45, cursor: 'not-allowed' }}
                title={t('agentPanel.running.disabledTitle')}
              >
                {t('agentPanel.composer.send')}
              </button>
            ) : (
              <button
                type="button"
                className="agt-send"
                onClick={handleSend}
                disabled={starting || Boolean(pendingControl?.requiresContinuation)}
              >
                {t('agentPanel.composer.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const fillStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  position: 'relative',
  color: 'hsl(var(--ink-1))',
};

const toolbar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderBottom: '1px solid hsl(var(--rule))',
  flexShrink: 0,
};

const toolbarRight: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
};

const sessionNameBtn: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'left',
  cursor: 'pointer',
  padding: '2px 4px',
  borderRadius: 6,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const nameInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  padding: '2px 4px',
  border: '1px solid hsl(var(--accent) / 0.5)',
  borderRadius: 6,
  background: 'hsl(var(--paper))',
  color: 'inherit',
  outline: 'none',
};

const historyPanel: React.CSSProperties = {
  width: 'min(360px, calc(100vw - 16px))',
  maxHeight: 280,
  overflowY: 'auto',
  background: 'hsl(var(--paper))',
  border: '1px solid hsl(var(--rule))',
  borderRadius: 8,
  boxShadow: '0 8px 24px hsl(var(--ink-1) / 0.18)',
  zIndex: 20,
  padding: 4,
};

const historyItem: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
};

const historyItemActive: React.CSSProperties = {
  background: 'hsl(var(--accent) / 0.12)',
};

const historyTitle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const historyLoadButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  border: 0,
  padding: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

const historyTime: React.CSSProperties = {
  fontSize: 10.5,
  opacity: 0.5,
  flexShrink: 0,
};

const historyAct: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  opacity: 0.4,
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: '0 2px',
  flexShrink: 0,
};

const historyInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: 'inherit',
  fontSize: 12,
  padding: '2px 6px',
  border: '1px solid hsl(var(--accent) / 0.5)',
  borderRadius: 4,
  background: 'hsl(var(--paper))',
  color: 'inherit',
  outline: 'none',
};

const logWrap: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
};

const logStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 12,
  fontSize: 12.5,
  lineHeight: 1.55,
  minHeight: 120,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const jumpBtn: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  right: 12,
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-1))',
  cursor: 'pointer',
  boxShadow: '0 2px 10px hsl(var(--ink-1) / 0.2)',
  fontSize: 14,
  lineHeight: 1,
  zIndex: 10,
};

const userRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
};

const userBubble: React.CSSProperties = {
  background: 'hsl(var(--accent) / 0.14)',
  border: '1px solid hsl(var(--accent) / 0.25)',
  borderRadius: 8,
  padding: '6px 10px',
  maxWidth: '85%',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const assistantBubble: React.CSSProperties = {
  maxWidth: '100%',
  wordBreak: 'break-word',
};

const errorBubble: React.CSSProperties = {
  background: 'hsl(0 70% 50% / 0.1)',
  border: '1px solid hsl(0 70% 50% / 0.3)',
  borderRadius: 8,
  padding: '6px 10px',
  color: 'hsl(0 70% 60%)',
  whiteSpace: 'pre-wrap',
};

const thinkingRow: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
};

const thinkingSummary: React.CSSProperties = {
  cursor: 'pointer',
  listStyle: 'none',
  userSelect: 'none',
  fontSize: 11,
  letterSpacing: '0.02em',
  color: 'hsl(var(--ink-3, var(--ink-1)))',
};

const thinkingBody: React.CSSProperties = {
  marginTop: 4,
  padding: '6px 8px',
  borderRadius: 'var(--radius-xs)',
  background: 'hsl(var(--ink-1) / 0.025)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontStyle: 'italic',
  fontSize: 11.5,
  lineHeight: 1.5,
  opacity: 0.85,
};

const todoBox: React.CSSProperties = {
  border: '1px solid hsl(var(--rule))',
  borderRadius: 8,
  background: 'hsl(var(--page))',
  padding: '8px 10px',
  fontSize: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
};

const todoHead: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  opacity: 0.6,
  marginBottom: 3,
};

const todoItem: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  lineHeight: 1.5,
};

const toolRow: React.CSSProperties = {
  border: '1px solid hsl(var(--rule))',
  borderRadius: 8,
  background: 'hsl(var(--page))',
  fontSize: 12,
};

const quietToolRow: React.CSSProperties = {
  fontSize: 12,
  color: 'hsl(var(--ink-muted))',
};

const toolDetails: React.CSSProperties = {
  margin: 0,
};

const toolSummary: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  listStyle: 'none',
  userSelect: 'none',
};

const toolName: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11.5,
  opacity: 0.9,
};

const toolActivity: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
};

const toolBody: React.CSSProperties = {
  borderTop: '1px solid hsl(var(--rule))',
  padding: '6px 8px',
};

const toolBodyLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  opacity: 0.5,
  marginBottom: 2,
};

const toolPre: React.CSSProperties = {
  margin: '0 0 6px',
  padding: 6,
  background: 'hsl(var(--ink-1) / 0.05)',
  borderRadius: 4,
  fontSize: 11,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflow: 'auto',
};

const inputArea: React.CSSProperties = {
  padding: 10,
  flexShrink: 0,
};

const usageRow: React.CSSProperties = {
  fontSize: 10.5,
  opacity: 0.45,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  padding: '0 2px',
};

const usageFooter: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  padding: '4px 12px',
  fontSize: 11,
  opacity: 0.6,
  flexShrink: 0,
  borderTop: '1px solid hsl(var(--rule))',
  fontVariantNumeric: 'tabular-nums',
};

const primaryBtn: React.CSSProperties = {
  background: 'hsl(var(--accent))',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const ghostBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid hsl(var(--rule))',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const hintBox: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 16,
  fontSize: 12,
  alignItems: 'flex-start',
};

const hintTitle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'hsl(var(--ink-1))',
};

const hintText: React.CSSProperties = {
  fontSize: 12,
  opacity: 0.8,
  lineHeight: 1.6,
};

// Markdown element styling + streaming caret. Scoped under .agent-md so it only
// touches assistant bubbles. Descendant selectors can't be expressed as inline
// styles, hence a small stylesheet rendered with the panel.
const panelCss = `
.agt-name { transition: background 0.12s ease; }
.agt-name:hover:not(:disabled) { background: hsl(var(--ink-1) / 0.06); }
.agt-name:disabled { cursor: default; opacity: 0.75; }
.agent-md > :first-child { margin-top: 0; }
.agent-md > :last-child { margin-bottom: 0; }
.agent-md p { margin: 0 0 8px; }
.agent-md ul, .agent-md ol { margin: 0 0 8px; padding-left: 20px; }
.agent-md li { margin: 2px 0; }
.agent-md h1, .agent-md h2, .agent-md h3, .agent-md h4 { margin: 10px 0 6px; font-size: 13.5px; font-weight: 600; }
.agent-md code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; background: hsl(var(--ink-1) / 0.08); padding: 1px 4px; border-radius: 3px; }
.agent-md pre { margin: 0 0 8px; padding: 8px; background: hsl(var(--ink-1) / 0.06); border-radius: 6px; overflow: auto; }
.agent-md pre code { background: none; padding: 0; }
.agent-md blockquote { margin: 0 0 8px; padding: 6px 10px; border-radius: var(--radius-xs); background: hsl(var(--ink-1) / 0.035); opacity: 0.85; }
.agent-md a { color: hsl(var(--accent)); text-decoration: underline; }
.agent-md table { border-collapse: collapse; margin: 0 0 8px; }
.agent-md th, .agent-md td { border: 1px solid hsl(var(--rule)); padding: 3px 6px; }
.agent-caret { display: inline-block; width: 0; opacity: 0.6; animation: agentBlink 1s steps(1) infinite; }
@keyframes agentBlink { 50% { opacity: 0; } }
.agt-pending { display: flex; align-items: center; gap: 5px; padding: 4px 2px; font-size: 12px; opacity: 0.6; }
.agt-pending__dot { width: 5px; height: 5px; border-radius: 50%; background: hsl(var(--ink-1)); animation: agtPendingPulse 1.2s ease-in-out infinite; }
.agt-pending__dot:nth-child(2) { animation-delay: 0.15s; }
.agt-pending__dot:nth-child(3) { animation-delay: 0.3s; }
.agt-pending span:last-child { margin-left: 2px; }
@keyframes agtPendingPulse { 0%, 100% { opacity: 0.25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
.agt-entity-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 2px 2px; }
.agt-entity-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid hsl(var(--rule)); border-radius: 999px; background: hsl(var(--surface)); color: hsl(var(--ink-1)); font-size: 11.5px; cursor: pointer; transition: background 0.12s, border-color 0.12s; }
.agt-entity-chip:hover { background: hsl(var(--accent) / 0.08); border-color: hsl(var(--accent) / 0.5); }
.agt-entity-chip__glyph { color: hsl(var(--accent)); font-family: var(--font-sans); font-style: italic; }
.agt-entity-chip__op { font-size: 9.5px; opacity: 0.55; }
.agt-otherrun { display: flex; align-items: center; gap: 7px; width: 100%; margin: 0 0 8px; padding: 6px 10px; border: 1px solid hsl(var(--accent) / 0.3); border-radius: 8px; background: hsl(var(--accent) / 0.06); color: hsl(var(--ink-2)); font-size: 11.5px; cursor: pointer; text-align: left; transition: background 0.12s, border-color 0.12s; }
.agt-otherrun:hover { background: hsl(var(--accent) / 0.12); border-color: hsl(var(--accent) / 0.5); }
.agt-otherrun__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agt-otherrun__dot { width: 7px; height: 7px; border-radius: 50%; background: hsl(var(--accent)); flex-shrink: 0; animation: agtOtherRunPulse 1.4s ease-in-out infinite; }
@keyframes agtOtherRunPulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
`;
