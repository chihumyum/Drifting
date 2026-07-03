import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useAgentConfirmStore } from '../../store/agent-confirm-store';

/**
 * Global, non-blocking confirmation dialog for the agent's destructive tools.
 * Mounted once at the app root; renders only while a request is pending. See
 * agent-confirm-store for the promise/timeout plumbing.
 */
export function AgentConfirmDialog() {
  const { t } = useTranslation();
  const pending = useAgentConfirmStore((s) => s.pending);
  if (!pending) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.32)',
      }}
      onClick={() => pending.respond(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 320,
          maxWidth: 440,
          padding: '20px 22px',
          borderRadius: 12,
          background: 'var(--bg-elevated, #fff)',
          color: 'var(--text-primary, #1a1a1a)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{pending.message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button
            type="button"
            onClick={() => pending.respond(false)}
            style={{
              padding: '6px 16px',
              borderRadius: 8,
              border: '1px solid var(--border, #d4d4d4)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => pending.respond(true)}
            style={{
              padding: '6px 16px',
              borderRadius: 8,
              border: '1px solid #c0392b',
              background: '#c0392b',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            {t('agentConfirm.allowDelete')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
