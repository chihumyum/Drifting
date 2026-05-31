/**
 * Agent panel — the interactive Claude agent, rendered in the right sidebar's
 * "agent" tab group. Styled after the VS Code Claude Code plugin: a chat that
 * streams assistant text token-by-token, renders it as markdown, shows the
 * agent's tool calls and extended thinking, keeps a local history of past
 * conversations, and exposes a quick model / effort / thinking switcher under
 * the input.
 *
 * The conversation state + the agent-event subscription live in a module-level
 * store (useAgentChatStore), so this view survives the panel unmounting on tab
 * switches and streaming keeps flowing while it's not mounted. This component is
 * a thin projection: render + local UI concerns (scroll, history dropdown).
 *
 * Credential mode (BYOK Claude OAuth vs Hosted) and the model / thinking params
 * live in Settings → 模型与 API; the switcher here writes the same store fields.
 * If the agent isn't set up for the chosen mode, we show a hint that opens it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import {
  useSettingsStore,
  AGENT_MODEL_OPTIONS,
  AGENT_EFFORT_OPTIONS,
} from '../../store/settings-store';
import { useAgentChatStore } from '../../store/agent-chat-store';
import { events } from '../../lib/events';
import type {
  AgentChatMessage as ChatMsg,
  AgentConversationSummary,
} from '../../domain/agent-conversation';
import '../../../styles/agent-panel.css';

interface AuthStatus {
  byokConnected: boolean;
  hostedAvailable: boolean;
}

/** Max composer height before it stops growing and scrolls internally (~8 lines). */
const COMPOSER_MAX_PX = 168;

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
  const icon = msg.status === 'running' ? '◌' : msg.status === 'ok' ? '✓' : '✗';
  const inputStr = useMemo(() => {
    if (msg.input == null) return '';
    try {
      return JSON.stringify(msg.input, null, 2);
    } catch {
      return String(msg.input);
    }
  }, [msg.input]);
  const hasBody = !!inputStr || !!msg.result;
  return (
    <details style={toolRow}>
      <summary style={toolSummary}>
        <span style={{ opacity: 0.7, width: 12, display: 'inline-block' }}>{icon}</span>
        <code style={toolName}>{msg.name}</code>
        {msg.status === 'running' && <span style={{ opacity: 0.5 }}>…</span>}
      </summary>
      {hasBody && (
        <div style={toolBody}>
          {inputStr && (
            <>
              <div style={toolBodyLabel}>input</div>
              <pre style={toolPre}>{inputStr}</pre>
            </>
          )}
          {msg.result && (
            <>
              <div style={toolBodyLabel}>result</div>
              <pre style={toolPre}>{msg.result}</pre>
            </>
          )}
        </div>
      )}
    </details>
  );
}

function ThinkingRow({ msg }: { msg: Extract<ChatMsg, { kind: 'thinking' }> }) {
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
        💭 思考{msg.streaming ? '中…' : '过程'}
      </summary>
      <div style={thinkingBody}>{msg.text}</div>
    </details>
  );
}

/**
 * The single composer config control: a quiet summary button that opens an
 * upward menu. The menu adjusts model (a nested option list), extended thinking
 * (inline toggle), and reasoning effort (an inline 5-dot meter) in place.
 */
function ComposerConfig() {
  const agentModel = useSettingsStore((s) => s.agentModel);
  const setAgentModel = useSettingsStore((s) => s.setAgentModel);
  const agentThinking = useSettingsStore((s) => s.agentThinking);
  const setAgentThinking = useSettingsStore((s) => s.setAgentThinking);
  const agentEffort = useSettingsStore((s) => s.agentEffort);
  const setAgentEffort = useSettingsStore((s) => s.setAgentEffort);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'model'>('main');

  const modelShort = AGENT_MODEL_OPTIONS.find((m) => m.value === agentModel)?.short ?? agentModel;
  const effortShort = AGENT_EFFORT_OPTIONS.find((e) => e.value === agentEffort)?.short ?? agentEffort;
  const effortIdx = AGENT_EFFORT_OPTIONS.findIndex((e) => e.value === agentEffort);

  const close = () => {
    setOpen(false);
    setView('main');
  };

  return (
    <div className="agt-pop">
      <button
        type="button"
        className={'agt-cfg' + (open ? ' agt-cfg--open' : '')}
        onClick={() => setOpen((o) => !o)}
        title="模型与推理"
        aria-label="模型与推理设置"
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
      {open && (
        <>
          <div className="agt-pop__backdrop" onClick={close} />
          <div className="agt-menu">
            {view === 'main' ? (
              <>
                <div className="agt-menu__sec">模型</div>
                <div className="agt-menu__row agt-menu__row--btn" onClick={() => setView('model')}>
                  <span>切换模型</span>
                  <span className="agt-menu__val">
                    {modelShort}
                    <span className="agt-menu__caret">›</span>
                  </span>
                </div>
                <div className="agt-menu__divider" />
                <div className="agt-menu__sec">推理</div>
                <div className="agt-menu__row">
                  <span>扩展思考</span>
                  <button
                    type="button"
                    aria-pressed={agentThinking === 'adaptive'}
                    className={'agt-tog' + (agentThinking === 'adaptive' ? ' agt-tog--on' : '')}
                    onClick={() => setAgentThinking(agentThinking === 'adaptive' ? 'off' : 'adaptive')}
                  />
                </div>
                {agentThinking === 'adaptive' && (
                  <div className="agt-menu__row">
                    <span>强度 · {effortShort}</span>
                    <span className="agt-dots">
                      {AGENT_EFFORT_OPTIONS.map((o, i) => (
                        <button
                          key={o.value}
                          type="button"
                          title={o.label}
                          className={'agt-dot' + (i <= effortIdx ? ' agt-dot--on' : '')}
                          onClick={() => setAgentEffort(o.value)}
                        />
                      ))}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="agt-menu__back" onClick={() => setView('main')}>
                  ‹ 模型
                </div>
                {AGENT_MODEL_OPTIONS.map((m) => (
                  <div
                    key={m.value}
                    className={'agt-menu__opt' + (m.value === agentModel ? ' agt-menu__opt--active' : '')}
                    onClick={() => {
                      setAgentModel(m.value);
                      setView('main');
                    }}
                  >
                    <span>{m.label}</span>
                    {m.value === agentModel && <span className="agt-menu__check">●</span>}
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
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

/** Subtle per-turn token/cost badge appended after each agent turn. */
function UsageRow({ msg }: { msg: Extract<ChatMsg, { kind: 'usage' }> }) {
  const inTok = msg.inputTokens + msg.cacheReadTokens + msg.cacheCreationTokens;
  return (
    <div style={usageRow} title="本轮 token 用量（输入含缓存）/ 费用">
      ↑{fmtTokens(inTok)} ↓{fmtTokens(msg.outputTokens)}
      {msg.costUsd > 0 ? ` · ${fmtCost(msg.costUsd)}` : ''}
    </div>
  );
}

/** A row indicating the agent is working but nothing is actively streaming yet. */
function PendingRow() {
  return (
    <div className="agt-pending">
      <span className="agt-pending__dot" />
      <span className="agt-pending__dot" />
      <span className="agt-pending__dot" />
      <span>思考中…</span>
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

function TodoList({ items }: { items: Extract<ChatMsg, { kind: 'todos' }>['items'] }) {
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === 'completed').length;
  return (
    <div style={todoBox}>
      <div style={todoHead}>
        <span>计划</span>
        <span style={{ opacity: 0.7 }}>
          {done}/{items.length}
        </span>
      </div>
      {items.map((t, i) => {
        const icon = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▸' : '☐';
        const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
        return (
          <div key={i} style={todoItem}>
            <span style={{ width: 14, flexShrink: 0, opacity: t.status === 'completed' ? 0.5 : 0.85 }}>
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
  const api = window.electronAPI?.agent;
  const agentMode = useSettingsStore((s) => s.agentMode);

  // Chat state + actions live in the module store so they persist across the
  // panel unmounting (tab switches) and streaming keeps flowing while unmounted.
  const messages = useAgentChatStore((s) => s.messages);
  const prompt = useAgentChatStore((s) => s.prompt);
  const running = useAgentChatStore((s) => s.running);
  const convList = useAgentChatStore((s) => s.convList);
  const activeConvId = useAgentChatStore((s) => s.activeConvId);
  const setPrompt = useAgentChatStore((s) => s.setPrompt);
  const send = useAgentChatStore((s) => s.send);
  const abort = useAgentChatStore((s) => s.abort);
  const newConversation = useAgentChatStore((s) => s.newConversation);
  const loadConversation = useAgentChatStore((s) => s.loadConversation);
  const deleteConversation = useAgentChatStore((s) => s.deleteConversation);
  const renameConversation = useAgentChatStore((s) => s.renameConversation);
  const bindProject = useAgentChatStore((s) => s.bindProject);

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  // Inline rename: the header edits the active conversation; a history row edits
  // whichever entry is `editingItemId`.
  const [editingHeaderId, setEditingHeaderId] = useState<string | null>(null);
  const [headerDraft, setHeaderDraft] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Whether to keep pinning the view to the bottom during streaming. The user
  // scrolling up sets this false (breaks free); scrolling back to the bottom
  // re-engages it.
  const stickRef = useRef(true);

  const refreshStatus = useCallback(() => {
    if (!api) return;
    void api
      .authStatus()
      .then(setStatus)
      .catch(() => setStatus({ byokConnected: false, hostedAvailable: false }));
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
  }, [messages]);

  // Auto-grow the composer from one line up to a cap, then scroll. The bar is
  // bottom-anchored with the log on flex:1, so growing the textarea pushes the
  // input area upward (the requested "grow upward" behavior).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [prompt]);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
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
  const sessionName = activeConv ? activeConv.title || '未命名' : '新对话';
  const editingHeader = editingHeaderId !== null && editingHeaderId === activeConvId;

  // Show a "思考中…" placeholder whenever the agent is running but nothing is
  // actively streaming — i.e. the dead-air gaps (right after send, and between a
  // tool finishing and the next token), where there was previously no feedback.
  const lastMsg = messages[messages.length - 1];
  const busyTail =
    !!lastMsg &&
    (((lastMsg.kind === 'assistant' || lastMsg.kind === 'thinking') && lastMsg.streaming) ||
      (lastMsg.kind === 'tool' && lastMsg.status === 'running'));
  const waiting = running && !busyTail;

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

  if (!api) {
    return <div style={hintBox}>Agent 不可用。</div>;
  }
  if (status === null) {
    return <div style={hintBox}>Checking…</div>;
  }

  const usable = agentMode === 'byok' ? status.byokConnected : status.hostedAvailable;

  // ---- Not set up → point to Settings (connect / subscribe lives there) ----
  if (!usable) {
    return (
      <div style={hintBox}>
        <div style={hintTitle}>Agent 未连接</div>
        <div style={hintText}>
          {agentMode === 'byok'
            ? '当前为「自带 Claude 账号」模式,但还没连接。前往设置连接你的 Claude 账号(Max/Pro)。'
            : '当前为「托管订阅」模式,但尚未就绪。前往设置登录并开通订阅。'}
        </div>
        <button
          type="button"
          style={primaryBtn}
          onClick={() => events.emit('settings:open', { railId: 'models' })}
        >
          前往设置
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
            title={activeConv ? '点击重命名当前对话' : undefined}
          >
            {sessionName}
          </button>
        )}
        <div style={toolbarRight}>
          <button
            type="button"
            style={ghostBtn}
            onClick={() => setShowHistory((s) => !s)}
            title="历史对话"
          >
            ☰ 历史{convList.length ? ` · ${convList.length}` : ''}
          </button>
          <button type="button" style={ghostBtn} onClick={handleNew} title="开始新对话">
            ＋ 新对话
          </button>
        </div>
      </div>

      {showHistory && (
        <div style={historyPanel}>
          {convList.length === 0 ? (
            <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>暂无历史对话</div>
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
                  onClick={() => handleLoad(c.id)}
                >
                  <span style={historyTitle}>{c.title || '未命名'}</span>
                  <span style={historyTime}>{relTime(c.updatedAt)}</span>
                  <button
                    type="button"
                    style={historyAct}
                    title="重命名"
                    onClick={(e) => beginItemRename(c, e)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    style={historyAct}
                    title="删除对话"
                    onClick={(e) => handleDelete(c.id, e)}
                  >
                    ×
                  </button>
                </div>
              ),
            )
          )}
        </div>
      )}

      <div style={logWrap}>
        <div ref={logRef} style={logStyle} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div style={{ opacity: 0.5 }}>
              给 Agent 发条消息开始。它可以读写本项目的章节、元素与关系。
            </div>
          ) : (
            messages.map((m, i) => <MessageView key={i} msg={m} />)
          )}
          {waiting && <PendingRow />}
        </div>
        {!atBottom && (
          <button type="button" style={jumpBtn} onClick={jumpToBottom} title="回到最新">
            ↓
          </button>
        )}
      </div>

      {(sessionUsage.outTok > 0 || sessionUsage.tools > 0) && (
        <div style={usageFooter} title="本会话累计 token / 费用 / 工具调用次数">
          <span style={{ opacity: 0.7 }}>本会话</span>
          <span>
            ↑{fmtTokens(sessionUsage.inTok)} ↓{fmtTokens(sessionUsage.outTok)}
          </span>
          {sessionUsage.cost > 0 && <span>{fmtCost(sessionUsage.cost)}</span>}
          <span>{sessionUsage.tools} 次工具</span>
        </div>
      )}

      <div style={inputArea}>
        <div className="agt-composer">
          <textarea
            ref={taRef}
            className="agt-composer__text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask the agent… (Cmd/Ctrl+Enter)"
            rows={1}
          />
          <div className="agt-composer__bar">
            <ComposerConfig />
            <div className="agt-composer__spacer" />
            {running ? (
              <button type="button" className="agt-send agt-send--stop" onClick={abort}>
                Stop
              </button>
            ) : (
              <button type="button" className="agt-send" onClick={handleSend}>
                Send
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
  position: 'absolute',
  top: 40,
  left: 8,
  right: 8,
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
  paddingLeft: 10,
  borderLeft: '2px solid hsl(var(--rule))',
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
.agent-md blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid hsl(var(--rule)); opacity: 0.85; }
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
`;
