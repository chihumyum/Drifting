/**
 * Agent panel — the interactive Claude agent, rendered in the right sidebar's
 * "agent" tab group. Styled after the VS Code Claude Code plugin: a chat that
 * streams assistant text token-by-token, renders it as markdown, shows the
 * tool calls the agent makes (read/edit/relationship actions) as collapsible
 * rows, and has a "new conversation" action. The main process keeps
 * conversation continuity across turns (resume); "新对话" starts fresh.
 *
 * Credential mode (BYOK Claude OAuth vs Hosted) and the actual connect flow
 * live in Settings → 模型与 API (store.agentMode). If the agent isn't set up
 * for the chosen mode, we show a hint that opens Settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { useSettingsStore } from '../../store/settings-store';
import { events } from '../../lib/events';
import type { AgentEvent } from '../../../main/agent';

interface AuthStatus {
  byokConnected: boolean;
  hostedAvailable: boolean;
}

// ---- Chat message model ----------------------------------------------------

type ChatMsg =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input?: unknown;
      status: 'running' | 'ok' | 'error';
      result?: string;
    }
  | { kind: 'error'; text: string };

/** Mark any trailing still-streaming assistant/thinking message as finished. */
function finalizeStreaming(list: ChatMsg[]): ChatMsg[] {
  const last = list[list.length - 1];
  if (last && (last.kind === 'assistant' || last.kind === 'thinking') && last.streaming) {
    const copy = list.slice();
    copy[copy.length - 1] = { ...last, streaming: false };
    return copy;
  }
  return list;
}

/** Fold one streamed agent event into the chat transcript. */
function applyEvent(list: ChatMsg[], ev: AgentEvent): ChatMsg[] {
  switch (ev.type) {
    case 'assistant_delta': {
      const last = list[list.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const copy = list.slice();
        copy[copy.length - 1] = { ...last, text: last.text + ev.text };
        return copy;
      }
      return [...finalizeStreaming(list), { kind: 'assistant', text: ev.text, streaming: true }];
    }
    case 'thinking_delta': {
      const last = list[list.length - 1];
      if (last && last.kind === 'thinking' && last.streaming) {
        const copy = list.slice();
        copy[copy.length - 1] = { ...last, text: last.text + ev.text };
        return copy;
      }
      return [...finalizeStreaming(list), { kind: 'thinking', text: ev.text, streaming: true }];
    }
    case 'assistant':
      return [...finalizeStreaming(list), { kind: 'assistant', text: ev.text, streaming: false }];
    case 'tool_use':
      return [
        ...finalizeStreaming(list),
        { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' },
      ];
    case 'tool_result': {
      const idx = list.findIndex((m) => m.kind === 'tool' && m.id === ev.id);
      if (idx === -1) return list;
      const copy = list.slice();
      const t = copy[idx] as Extract<ChatMsg, { kind: 'tool' }>;
      copy[idx] = { ...t, status: ev.ok ? 'ok' : 'error', result: ev.text };
      return copy;
    }
    case 'result':
      // A successful result mirrors the last assistant text — only surface failures.
      return ev.ok ? finalizeStreaming(list) : [...finalizeStreaming(list), { kind: 'error', text: ev.text }];
    case 'error':
      return [...finalizeStreaming(list), { kind: 'error', text: ev.message }];
    case 'system':
      return list; // suppress init / compact breadcrumbs
    case 'done':
      return finalizeStreaming(list);
    default:
      return list;
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

export function CompanionPanel() {
  const api = window.electronAPI?.agent;
  const agentMode = useSettingsStore((s) => s.agentMode);
  const agentModel = useSettingsStore((s) => s.agentModel);
  const agentEffort = useSettingsStore((s) => s.agentEffort);
  const agentThinking = useSettingsStore((s) => s.agentThinking);

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((ev) => {
      setMessages((prev) => applyEvent(prev, ev));
      if (ev.type === 'done') setRunning(false);
    });
  }, [api]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    if (!api || !prompt.trim() || running) return;
    const text = prompt.trim();
    setMessages((prev) => [...prev, { kind: 'user', text }]);
    setPrompt('');
    setRunning(true);
    const r = await api.start({
      prompt: text,
      mode: agentMode,
      model: agentModel,
      effort: agentEffort,
      thinking: agentThinking,
    });
    if (!r.ok) {
      setMessages((prev) => [...prev, { kind: 'error', text: r.error }]);
      setRunning(false);
    }
  }, [api, prompt, running, agentMode, agentModel, agentEffort, agentThinking]);

  const abort = useCallback(() => {
    void api?.abort();
  }, [api]);

  const newConversation = useCallback(async () => {
    await api?.resetSession();
    setMessages([]);
  }, [api]);

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
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {agentMode === 'byok' ? '你的 Claude 订阅' : '托管 · 计量'}
        </span>
        <button type="button" style={ghostBtn} onClick={newConversation} title="开始新对话">
          ＋ 新对话
        </button>
      </div>
      <div ref={logRef} style={logStyle}>
        {messages.length === 0 ? (
          <div style={{ opacity: 0.5 }}>
            给 Agent 发条消息开始。它可以读写本项目的章节、元素与关系。
          </div>
        ) : (
          messages.map((m, i) => <MessageView key={i} msg={m} />)
        )}
      </div>
      <div style={inputRow}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Ask the agent… (Cmd/Ctrl+Enter)"
          rows={2}
          style={{ ...inputStyle, flex: 1, resize: 'none' }}
        />
        {running ? (
          <button type="button" style={primaryBtn} onClick={abort}>
            Stop
          </button>
        ) : (
          <button type="button" style={primaryBtn} onClick={() => void send()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

const fillStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
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

const inputRow: React.CSSProperties = {
  padding: 10,
  display: 'flex',
  gap: 6,
  alignItems: 'flex-end',
  borderTop: '1px solid hsl(var(--rule))',
};

const inputStyle: React.CSSProperties = {
  background: 'hsl(var(--page))',
  color: 'inherit',
  border: '1px solid hsl(var(--rule))',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
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
