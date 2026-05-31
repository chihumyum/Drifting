/**
 * Claude Agent panel.
 *
 * Two credential modes, switchable at the top:
 *  - BYOK   — your own Claude subscription (OAuth connect, talks to Anthropic
 *             directly; we never see the traffic).
 *  - Hosted — our subscription, metered: the SDK is routed through the server
 *             proxy using your Drifting login.
 * Both modes share the same tools, event stream, and UI below.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../../../main/agent';

type Mode = 'byok' | 'hosted';
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

export function AgentPanel() {
  const api = window.electronAPI?.agent;

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('byok');
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
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

  const connect = useCallback(async () => {
    if (!api) return;
    await api.authPrepare();
    setAwaitingCode(true);
  }, [api]);

  const submitCode = useCallback(async () => {
    if (!api || !code.trim()) return;
    const r = await api.authSubmitCode(code.trim());
    if (r.ok) {
      setAwaitingCode(false);
      setCode('');
      refreshStatus();
    } else {
      setLog((prev) => [...prev, `✗ auth: ${r.error}`]);
    }
  }, [api, code, refreshStatus]);

  const logout = useCallback(async () => {
    await api?.authLogout();
    refreshStatus();
  }, [api, refreshStatus]);

  const send = useCallback(async () => {
    if (!api || !prompt.trim() || running) return;
    const text = prompt.trim();
    setLog((prev) => [...prev, `> ${text}`]);
    setPrompt('');
    setRunning(true);
    const r = await api.start({ prompt: text, mode });
    if (!r.ok) {
      setLog((prev) => [...prev, `✗ ${r.error}`]);
      setRunning(false);
    }
  }, [api, prompt, running, mode]);

  const abort = useCallback(() => {
    void api?.abort();
  }, [api]);

  if (!api) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...btnStyle, position: 'fixed', right: 16, bottom: 48, zIndex: 9999 }}
      >
        Agent
      </button>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <strong style={{ fontSize: 13 }}>Claude Agent</strong>
        <button type="button" onClick={() => setOpen(false)} style={smallBtn}>
          ✕
        </button>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 10px 0' }}>
        {(['byok', 'hosted'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            style={mode === m ? segActive : segIdle}
          >
            {m === 'byok' ? 'BYOK (Claude)' : '托管订阅'}
          </button>
        ))}
      </div>

      {status === null ? (
        <div style={{ padding: 12, fontSize: 12 }}>Checking…</div>
      ) : mode === 'byok' && !status.byokConnected ? (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!awaitingCode ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                用你自己的 Claude 账号(Max/Pro)。会打开浏览器授权,然后把页面上的 code 粘回来。
              </div>
              <button type="button" onClick={connect} style={btnStyle}>
                Connect Claude
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, opacity: 0.8 }}>粘贴授权 code:</div>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="authorization code"
                style={inputStyle}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={submitCode} style={btnStyle}>
                  Submit
                </button>
                <button type="button" onClick={() => setAwaitingCode(false)} style={smallBtn}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      ) : mode === 'hosted' && !status.hostedAvailable ? (
        <div style={{ padding: 12, fontSize: 12, opacity: 0.8 }}>
          托管订阅需要先登录 Drifting 账号。请登录后重试。
        </div>
      ) : (
        <>
          <div style={{ padding: '6px 10px 0', display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.6 }}>
            <span>{mode === 'byok' ? '直连 Anthropic(你的订阅)' : '经服务器计量(托管)'}</span>
            {mode === 'byok' && status.byokConnected && (
              <button type="button" onClick={logout} style={{ ...smallBtn, padding: '0 6px' }}>
                断开
              </button>
            )}
          </div>
          <div ref={logRef} style={logStyle}>
            {log.length === 0 ? (
              <div style={{ opacity: 0.5 }}>Send a message to begin.</div>
            ) : (
              log.map((line, i) => (
                <div key={i} style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>
                  {line}
                </div>
              ))
            )}
          </div>
          <div style={{ padding: 8, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
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
              <button type="button" onClick={abort} style={btnStyle}>
                Stop
              </button>
            ) : (
              <button type="button" onClick={send} style={btnStyle}>
                Send
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 48,
  zIndex: 9999,
  width: 360,
  maxHeight: 480,
  display: 'flex',
  flexDirection: 'column',
  background: 'hsl(var(--surface))',
  color: 'hsl(var(--foreground))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 10,
  boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 10px',
  borderBottom: '1px solid hsl(var(--border))',
};

const logStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 10,
  fontSize: 12,
  lineHeight: 1.5,
  minHeight: 160,
};

const inputStyle: React.CSSProperties = {
  background: 'hsl(var(--page))',
  color: 'inherit',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
};

const btnStyle: React.CSSProperties = {
  background: 'hsl(var(--accent, 220 90% 56%))',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const smallBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  padding: '2px 8px',
  fontSize: 12,
  cursor: 'pointer',
};

const segIdle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  color: 'inherit',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
  cursor: 'pointer',
  opacity: 0.6,
};

const segActive: React.CSSProperties = {
  ...segIdle,
  opacity: 1,
  borderColor: 'hsl(var(--accent, 220 90% 56%))',
  fontWeight: 600,
};
