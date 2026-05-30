/**
 * Minimal Claude Agent panel (P0).
 *
 * Proves the end-to-end pipe: OAuth connect (browser + paste code), send a
 * prompt, and render the streamed events from the main-process SDK loop.
 * Intentionally bare — entity tools and richer UI land in later phases.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../../../main/agent';

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
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [code, setCode] = useState('');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api) return;
    void api
      .authStatus()
      .then((s) => setAuthed(s.authenticated))
      .catch(() => setAuthed(false));
  }, [api]);

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
      setAuthed(true);
      setAwaitingCode(false);
      setCode('');
    } else {
      setLog((prev) => [...prev, `✗ auth: ${r.error}`]);
    }
  }, [api, code]);

  const send = useCallback(async () => {
    if (!api || !prompt.trim() || running) return;
    const text = prompt.trim();
    setLog((prev) => [...prev, `> ${text}`]);
    setPrompt('');
    setRunning(true);
    const r = await api.start({ prompt: text });
    if (!r.ok) {
      setLog((prev) => [...prev, `✗ ${r.error}`]);
      setRunning(false);
    }
  }, [api, prompt, running]);

  const abort = useCallback(() => {
    void api?.abort();
  }, [api]);

  const logout = useCallback(async () => {
    await api?.authLogout();
    setAuthed(false);
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
        <div style={{ display: 'flex', gap: 6 }}>
          {authed && (
            <button type="button" onClick={logout} style={smallBtn}>
              Logout
            </button>
          )}
          <button type="button" onClick={() => setOpen(false)} style={smallBtn}>
            ✕
          </button>
        </div>
      </div>

      {authed === null ? (
        <div style={{ padding: 12, fontSize: 12 }}>Checking…</div>
      ) : !authed ? (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!awaitingCode ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Connect with your Claude account (Max/Pro). A browser will open — approve, then
                paste the code shown.
              </div>
              <button type="button" onClick={connect} style={btnStyle}>
                Connect Claude
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Paste the authorization code:</div>
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
      ) : (
        <>
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
