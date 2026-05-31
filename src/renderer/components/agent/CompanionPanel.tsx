/**
 * Agent panel — the interactive Claude agent, rendered in the right sidebar's
 * "agent" tab group. Styled after the VS Code Claude Code plugin: a chat with
 * a "new conversation" action; conversation continuity is kept across turns by
 * the main process (resume), and "新对话" starts fresh.
 *
 * Credential mode (BYOK vs Hosted) is chosen in Settings (store.agentMode), NOT
 * here. If the agent isn't set up for the chosen mode, we show a connect /
 * subscribe hint instead of the chat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';
import { events } from '../../lib/events';
import type { AgentEvent } from '../../../main/agent';

interface AuthStatus {
  byokConnected: boolean;
  hostedAvailable: boolean;
}

function formatEvent(ev: AgentEvent): string {
  switch (ev.type) {
    case 'system':
      return `· ${ev.text}`;
    case 'assistant':
      return ev.text;
    case 'result':
      return ev.ok ? `✓ ${ev.text}` : `⚠ ${ev.text}`;
    case 'error':
      return `✗ ${ev.message}`;
    case 'done':
      return '— done —';
    default:
      return '';
  }
}

export function CompanionPanel() {
  const api = window.electronAPI?.agent;
  const agentMode = useUiStore((s) => s.agentMode);

  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  // BYOK connect flow (only shown in the not-connected state).
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((ev) => {
      setLog((prev) => [...prev, formatEvent(ev)]);
      if (ev.type === 'done') setRunning(false);
    });
  }, [api]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const send = useCallback(async () => {
    if (!api || !prompt.trim() || running) return;
    const text = prompt.trim();
    setLog((prev) => [...prev, `> ${text}`]);
    setPrompt('');
    setRunning(true);
    const r = await api.start({ prompt: text, mode: agentMode });
    if (!r.ok) {
      setLog((prev) => [...prev, `✗ ${r.error}`]);
      setRunning(false);
    }
  }, [api, prompt, running, agentMode]);

  const abort = useCallback(() => {
    void api?.abort();
  }, [api]);

  const newConversation = useCallback(async () => {
    await api?.resetSession();
    setLog([]);
  }, [api]);

  // ---- BYOK connect flow ----
  const connect = useCallback(async () => {
    if (!api) return;
    setAuthError(null);
    await api.authPrepare();
    setAwaitingCode(true);
  }, [api]);

  const submitCode = useCallback(async () => {
    if (!api || !code.trim()) return;
    const r = await api.authSubmitCode(code.trim());
    if (r.ok) {
      setAwaitingCode(false);
      setCode('');
      setAuthError(null);
      refreshStatus();
    } else {
      setAuthError(r.error);
    }
  }, [api, code, refreshStatus]);

  const openExternal = (url: string) => void window.electronAPI?.material?.openExternal(url);

  if (!api) {
    return <div style={hintBox}>Agent 不可用。</div>;
  }
  if (status === null) {
    return <div style={hintBox}>Checking…</div>;
  }

  const usable = agentMode === 'byok' ? status.byokConnected : status.hostedAvailable;

  // ---- Not set up: connect (BYOK) or subscribe (Hosted) ----
  if (!usable) {
    if (agentMode === 'hosted') {
      return (
        <div style={hintBox}>
          <div style={hintTitle}>托管 Agent 未就绪</div>
          <div style={hintText}>使用托管订阅的 Agent 需要先登录并订阅 Drifting。</div>
          <button type="button" style={primaryBtn} onClick={() => events.emit('settings:open', {})}>
            打开设置 / 订阅
          </button>
        </div>
      );
    }
    // BYOK
    return (
      <div style={hintBox}>
        <div style={hintTitle}>连接 Claude 账号</div>
        {!awaitingCode ? (
          <>
            <div style={hintText}>
              用你自己的 Claude 账号(Max/Pro)。点击后会打开浏览器授权,把页面上的 code 粘回来。
            </div>
            <button type="button" style={primaryBtn} onClick={connect}>
              连接 Claude
            </button>
            <button
              type="button"
              style={linkBtn}
              onClick={() => openExternal('https://claude.ai/upgrade')}
            >
              还没有 Claude 订阅?去订阅
            </button>
          </>
        ) : (
          <>
            <div style={hintText}>粘贴授权 code:</div>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="authorization code"
              style={inputStyle}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={primaryBtn} onClick={submitCode}>
                提交
              </button>
              <button
                type="button"
                style={ghostBtn}
                onClick={() => {
                  setAwaitingCode(false);
                  setAuthError(null);
                }}
              >
                取消
              </button>
            </div>
          </>
        )}
        {authError && <div style={errorText}>{authError}</div>}
      </div>
    );
  }

  // ---- Chat ----
  return (
    <div style={fillStyle}>
      <div style={toolbar}>
        <span style={{ fontSize: 11, opacity: 0.6 }}>
          {agentMode === 'byok' ? '你的 Claude 订阅' : '托管 · 计量'}
        </span>
        <button type="button" style={ghostBtn} onClick={newConversation} title="开始新对话">
          ＋ 新对话
        </button>
      </div>
      <div ref={logRef} style={logStyle}>
        {log.length === 0 ? (
          <div style={{ opacity: 0.5 }}>给 Agent 发条消息开始。它可以读写本项目的章节、元素与关系。</div>
        ) : (
          log.map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>
              {line}
            </div>
          ))
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

const linkBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'hsl(var(--accent))',
  border: 'none',
  padding: 0,
  fontSize: 11,
  cursor: 'pointer',
  textAlign: 'left',
};

const hintBox: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 16,
  fontSize: 12,
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

const errorText: React.CSSProperties = {
  fontSize: 11.5,
  color: 'hsl(var(--danger, 0 70% 50%))',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
};
