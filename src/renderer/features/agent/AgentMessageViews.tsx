import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { marked } from 'marked';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../store/data-store';
import type { ActivityEntityType, ToolEntityRef } from '../../lib/agent/tool-entity-ref';
import type { AgentControlStatus, AgentPendingControl, AgentPermissionScope } from '../../lib/agent/protocol';
import type { AgentChatMessage as ChatMsg } from '../../domain/agent-conversation';
import {
  describeAgentPermissionAction,
  describeAgentToolActivity,
  shouldDisplayAgentToolActivity,
} from '../../lib/agent/agent-tool-activity';

export const STREAM_FOLLOW_BOTTOM_THRESHOLD_PX = 16;

export function relTime(iso: string): string {
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

function messageTime(iso: string | undefined): { short: string; full: string } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const short = sameDay
    ? clock
    : `${date.toLocaleDateString([], {
        year: sameYear ? undefined : 'numeric',
        month: '2-digit',
        day: '2-digit',
      })} ${clock}`;
  return { short, full: date.toLocaleString() };
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
  // label at that point can only guess a placeholder target,
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
  // Only a live thinking block starts open; hydrated history stays collapsed.
  const [open, setOpen] = useState(() => msg.streaming === true);
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
export function fmtTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

/** Compact duration: 850 → "850ms", 4200 → "4.2s", 92000 → "1m 32s". */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
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
  const hasUsage = inTok > 0 || msg.outputTokens > 0 || msg.costUsd > 0 || msg.turns > 0;
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
    (hasTiming && msg.durationApiMs != null && localMs != null
      ? `\n${t('agentPanel.usage.timingDetail', {
          total: msg.durationMs,
          api: msg.durationApiMs,
          local: localMs,
        })}` + `\n${t('agentPanel.usage.timingHint')}`
      : hasTiming
        ? `\n${t('agentPanel.usage.workDetail', { duration: fmtMs(msg.durationMs!) })}`
        : '');
  const details = [
    hasTiming ? t('agentPanel.usage.workedFor', { duration: fmtMs(msg.durationMs!) }) : null,
    hasUsage ? `↑${fmtTokens(inTok)} ↓${fmtTokens(msg.outputTokens)}` : null,
    msg.costUsd > 0 ? fmtCost(msg.costUsd) : null,
    msg.turns > 0 ? t('agentPanel.usage.turnsShort', { count: msg.turns }) : null,
    msg.cacheReadTokens > 0 ? `⚡${fmtTokens(msg.cacheReadTokens)}` : null,
  ].filter((part): part is string => Boolean(part));
  return (
    <div style={usageRow} title={title}>
      {details.join(' · ')}
    </div>
  );
}

const UserBubble = memo(function UserBubble({ msg }: { msg: Extract<ChatMsg, { kind: 'user' }> }) {
  const { t } = useTranslation();
  const timestamp = messageTime(msg.at);
  return (
    <div style={userMessage}>
      <div style={userBubble}>{msg.text}</div>
      {timestamp ? (
        <time
          dateTime={msg.at}
          title={t('agentPanel.usage.sentAt', { time: timestamp.full })}
          style={userTimestamp}
        >
          {timestamp.short}
        </time>
      ) : null}
    </div>
  );
});

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
export function EntityLinkChip({
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
export function PendingRow({ status }: { status: AgentControlStatus | null }) {
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
export const MessageView = memo(function MessageView({ msg }: { msg: ChatMsg }) {
  switch (msg.kind) {
    case 'user':
      return (
        <div style={userRow}>
          <UserBubble msg={msg} />
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

export function RuntimeControlCard({
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
    const description = describeAgentPermissionAction(
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
        <div className="agt-control-card__description">
          <span>{description?.summary ?? <code>{permission.toolName}</code>}</span>
          {description?.details.map((detail, index) => (
            <small key={`${index}:${detail}`}>{detail}</small>
          ))}
          <small>
            {description
              ? t('agentPanel.control.destructiveHint', {
                  defaultValue: '这项操作会删除或替换现有内容，需要你先确认',
                })
              : permission.reason ?? ''}
          </small>
        </div>
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


const userRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
};

const userMessage: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 3,
  maxWidth: '85%',
};

const userBubble: React.CSSProperties = {
  background: 'hsl(var(--accent) / 0.14)',
  border: '1px solid hsl(var(--accent) / 0.25)',
  borderRadius: 2,
  padding: '6px 10px',
  maxWidth: '100%',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const userTimestamp: React.CSSProperties = {
  padding: '0 2px',
  color: 'hsl(var(--ink-muted))',
  fontSize: 10.5,
  fontVariantNumeric: 'tabular-nums',
};

const assistantBubble: React.CSSProperties = {
  maxWidth: '100%',
  wordBreak: 'break-word',
};

const errorBubble: React.CSSProperties = {
  background: 'hsl(0 70% 50% / 0.1)',
  border: '1px solid hsl(0 70% 50% / 0.3)',
  borderRadius: 2,
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
  borderRadius: 1,
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
  borderRadius: 1,
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
  borderRadius: 1,
  fontSize: 11,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 220,
  overflow: 'auto',
};


const usageRow: React.CSSProperties = {
  fontSize: 10.5,
  opacity: 0.45,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  padding: '0 2px',
};
