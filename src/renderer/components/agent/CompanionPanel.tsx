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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import {
  useSettingsStore,
  AGENT_MODEL_OPTIONS,
  AGENT_EFFORT_OPTIONS,
} from '../../store/settings-store';
import { useAgentChatStore } from '../../store/agent-chat-store';
import { events } from '../../lib/events';
import type { AgentChatMessage as ChatMsg } from '../../domain/agent-conversation';
import '../../../styles/agent-panel.css';

interface AuthStatus {
  byokConnected: boolean;
  hostedAvailable: boolean;
}

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
      <button type="button" className="agt-cfg" onClick={() => setOpen((o) => !o)} title="模型与推理">
        <span className="agt-cfg__val">{modelShort}</span>
        <span className="agt-cfg__sep">·</span>
        <span>{agentThinking === 'adaptive' ? `思考 ${effortShort}` : '思考关'}</span>
        <span className="agt-cfg__caret">▴</span>
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

function MessageView({ msg }: { msg: ChatMsg }) {
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
      return (
        <div
          className="agent-md"
          style={assistantBubble}
          dangerouslySetInnerHTML={{
            __html: mdToHtml(msg.text) + (msg.streaming ? '<span class="agent-caret">▌</span>' : ''),
          }}
        />
      );
    case 'tool':
      return <ToolRow msg={msg} />;
    case 'error':
      return <div style={errorBubble}>⚠ {msg.text}</div>;
    default:
      return null;
  }
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
  const bindProject = useAgentChatStore((s) => s.bindProject);

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
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
    stickRef.current = true;
    setAtBottom(true);
  }, [newConversation]);

  const handleLoad = useCallback(
    (id: string) => {
      void loadConversation(id);
      setShowHistory(false);
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

      {showHistory && (
        <div style={historyPanel}>
          {convList.length === 0 ? (
            <div style={{ padding: 12, opacity: 0.5, fontSize: 12 }}>暂无历史对话</div>
          ) : (
            convList.map((c) => (
              <div
                key={c.id}
                style={{ ...historyItem, ...(c.id === activeConvId ? historyItemActive : null) }}
                onClick={() => handleLoad(c.id)}
              >
                <span style={historyTitle}>{c.title || '未命名'}</span>
                <span style={historyTime}>{relTime(c.updatedAt)}</span>
                <button
                  type="button"
                  style={historyDel}
                  title="删除对话"
                  onClick={(e) => handleDelete(c.id, e)}
                >
                  ×
                </button>
              </div>
            ))
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
        </div>
        {!atBottom && (
          <button type="button" style={jumpBtn} onClick={jumpToBottom} title="回到最新">
            ↓
          </button>
        )}
      </div>

      <div style={inputArea}>
        <div className="agt-composer">
          <textarea
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
            rows={2}
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
  justifyContent: 'space-between',
  padding: '6px 10px',
  borderBottom: '1px solid hsl(var(--rule))',
  flexShrink: 0,
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

const historyDel: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  opacity: 0.4,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: '0 2px',
  flexShrink: 0,
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
`;
