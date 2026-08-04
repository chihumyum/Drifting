/**
 * Notification bell button in the topbar. Always a 26×26 circle.
 *   - a task is running   → Copilot icon blinks
 *   - task just finished  → result icon (✓ / ⚠ / ✗) for FLASH_MS, then bell
 *   - otherwise           → bell icon
 * Clicking toggles the NotificationCenter history dropdown.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, Bell, CheckCircle2, Loader2, Sparkles, Trash2, X } from 'lucide-react';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useNotificationStore, type AppNotification } from '../../store/notification-store';

const FLASH_MS = 1800; // how long the result icon shows in the circle after the pill collapses

type FlashResult = {
  state: 'completed' | 'failed' | 'stopped';
  outcome: string | undefined;
  id: number;
} | null;

interface Anchor {
  top: number;
  right: number;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.timeOrigin + performance.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function relTime(
  ms: number,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return t('notifications.time.justNow');
  if (d < 3_600_000) return t('notifications.time.minutesAgo', { count: Math.floor(d / 60_000) });
  if (d < 86_400_000) return t('notifications.time.hoursAgo', { count: Math.floor(d / 3_600_000) });
  return t('notifications.time.daysAgo', { count: Math.floor(d / 86_400_000) });
}

function sourceLabel(n: AppNotification): string {
  return n.source === 'copilot' ? 'Copilot' : 'Copilot';
}

function SourceIcon({ n, size = 14 }: { n: AppNotification; size?: number }) {
  if (n.state === 'running') {
    return (
      <Loader2
        size={size}
        strokeWidth={2}
        style={{ animation: 'drift-spin 0.9s linear infinite' }}
      />
    );
  }
  if (n.state === 'stopped') return <Ban size={size} strokeWidth={2} />;
  if (n.state === 'failed') return <AlertTriangle size={size} strokeWidth={2} />;
  if (n.outcome === 'issues') return <AlertTriangle size={size} strokeWidth={2} />;
  return <CheckCircle2 size={size} strokeWidth={2} />;
}

function flashToneColor(r: NonNullable<FlashResult>): string {
  if (r.state === 'stopped') return 'hsl(var(--ink-3))';
  if (r.state === 'failed') return 'hsl(0 64% 51%)';
  if (r.outcome === 'issues') return 'hsl(32 80% 44%)';
  return 'hsl(142 42% 40%)';
}

function FlashIcon({ result }: { result: NonNullable<FlashResult> }) {
  if (result.state === 'stopped') return <Ban size={15} strokeWidth={1.7} />;
  if (result.state === 'failed') return <AlertTriangle size={15} strokeWidth={1.7} />;
  if (result.outcome === 'issues') return <AlertTriangle size={15} strokeWidth={1.7} />;
  return <CheckCircle2 size={15} strokeWidth={1.7} />;
}

// Foreground color for a notification's state/outcome.
function toneColor(n: AppNotification): string {
  if (n.state === 'running') return 'hsl(var(--ink-2))';
  if (n.state === 'stopped') return 'hsl(var(--ink-3))';
  if (n.state === 'failed') return 'hsl(0 64% 51%)';
  if (n.outcome === 'issues') return 'hsl(32 80% 44%)';
  return 'hsl(142 42% 40%)';
}

export function NotificationPill() {
  const { t } = useTranslation();
  const items = useNotificationStore((s) => s.items);
  const centerOpen = useNotificationStore((s) => s.centerOpen);
  const toggleCenter = useNotificationStore((s) => s.toggleCenter);
  const setCenterOpen = useNotificationStore((s) => s.setCenterOpen);

  const runningItem = items.find((n) => n.state === 'running');
  const headUpdatedAt = items.length ? items[0].updatedAt : 0;

  // When a task reaches a terminal state, flash its result icon for FLASH_MS.
  const lastHeadRef = useRef(0);
  const [flashResult, setFlashResult] = useState<FlashResult>(null);
  const flashClearRef = useRef<number>(0);

  useEffect(() => {
    if (!headUpdatedAt) return;
    const isNew = headUpdatedAt > lastHeadRef.current;
    lastHeadRef.current = headUpdatedAt;
    if (!isNew) return;
    const head = items[0];
    if (!head) return;
    if (head.state !== 'running') {
      setFlashResult({
        state: head.state as 'completed' | 'failed' | 'stopped',
        outcome: head.outcome,
        id: Date.now(),
      });
    } else {
      setFlashResult(null);
    }
  }, [headUpdatedAt, items]);

  useEffect(() => {
    if (flashResult === null) return;
    window.clearTimeout(flashClearRef.current);
    flashClearRef.current = window.setTimeout(() => setFlashResult(null), FLASH_MS);
    return () => window.clearTimeout(flashClearRef.current);
  }, [flashResult]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 40, right: 12 });

  const measure = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  const handleToggle = () => {
    if (!centerOpen) measure();
    toggleCenter();
  };

  useEffect(() => {
    if (!centerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || centerRef.current?.contains(t)) return;
      setCenterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCenterOpen(false);
    };
    const onResize = () => measure();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [centerOpen, setCenterOpen]);

  const now = useNow(centerOpen);

  // Priority: running Copilot icon (blink) > flash result icon > bell
  let iconEl: React.ReactNode;
  let iconColor: string;
  if (runningItem) {
    iconColor = 'hsl(var(--ink-2))';
    iconEl = (
      <span key="copilot-run" className="notif-blink-icon">
        <Sparkles size={14} strokeWidth={1.8} />
      </span>
    );
  } else if (flashResult) {
    iconColor = flashToneColor(flashResult);
    iconEl = (
      <span key={flashResult.id} className="notif-flash-icon">
        <FlashIcon result={flashResult} />
      </span>
    );
  } else {
    iconColor = 'hsl(var(--ink-3))';
    iconEl = <Bell size={15} strokeWidth={1.7} />;
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        title={t('notifications.title')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          borderRadius: 2,
          border: 'none',
          background: 'transparent',
          color: iconColor,
          cursor: 'pointer',
          transition: 'color 0.12s ease',
          flexShrink: 0,
          padding: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = iconColor;
        }}
      >
        {iconEl}
      </button>

      {centerOpen &&
        createPortal(
          <NotificationCenter now={now} anchor={anchor} containerRef={centerRef} />,
          document.body,
        )}
    </div>
  );
}

function NotificationCenter({
  now,
  anchor,
  containerRef,
}: {
  now: number;
  anchor: Anchor;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const items = useNotificationStore((s) => s.items);
  const remove = useNotificationStore((s) => s.remove);
  const clear = useNotificationStore((s) => s.clear);
  const setCenterOpen = useNotificationStore((s) => s.setCenterOpen);
  const { navigateToNode } = useProjectNavigation();

  const onRowClick = (n: AppNotification) => {
    if (n.chapterId) {
      navigateToNode(n.chapterId);
      setCenterOpen(false);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        top: anchor.top,
        right: anchor.right,
        width: 340,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'min(60vh, 480px)',
        display: 'flex',
        flexDirection: 'column',
        background: 'hsl(var(--paper))',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 2,
        boxShadow: '0 16px 34px -16px hsl(var(--ink-1) / 0.36)',
        zIndex: 'var(--z-toast)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderBottom: '1px solid hsl(var(--rule))',
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'hsl(var(--ink-1))' }}>
          {t('notifications.title')}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clear}
            title={t('notifications.clear')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--ink-3))',
              cursor: 'pointer',
              fontSize: 11,
              padding: '2px 4px',
              borderRadius: 4,
            }}
          >
            <Trash2 size={12} /> {t('notifications.clear')}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div
          style={{
            padding: '28px 12px',
            textAlign: 'center',
            fontSize: 12,
            color: 'hsl(var(--ink-4))',
            fontFamily: 'var(--font-sans)',
            fontStyle: 'italic',
          }}
        >
          {t('notifications.empty')}
        </div>
      ) : (
        <div style={{ overflowY: 'auto' }}>
          {items.map((n) => (
            <div
              key={n.id}
              onClick={() => onRowClick(n)}
              style={{
                display: 'flex',
                gap: 9,
                padding: '10px 12px',
                borderBottom: '1px solid hsl(var(--rule) / 0.6)',
                cursor: n.chapterId ? 'pointer' : 'default',
                background: n.read ? 'transparent' : 'hsl(var(--paper-deep) / 0.5)',
              }}
            >
              <span style={{ color: toneColor(n), marginTop: 1, flexShrink: 0 }}>
                <SourceIcon n={n} size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      fontSize: 9.5,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'hsl(var(--ink-4))',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {n.source === 'copilot' ? (
                      <Sparkles size={9} />
                    ) : (
                      <span style={{ fontStyle: 'italic' }}>◐</span>
                    )}
                    {sourceLabel(n)}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'hsl(var(--ink-4))' }}>
                    {relTime(n.updatedAt, now, t)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'hsl(var(--ink-1))',
                    marginTop: 2,
                  }}
                >
                  {n.title}
                </div>
                {(n.detail || n.error) && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: n.error ? 'hsl(0 60% 48%)' : 'hsl(var(--ink-3))',
                      marginTop: 2,
                      lineHeight: 1.4,
                    }}
                  >
                    {n.error || n.detail}
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label={t('notifications.remove')}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(n.id);
                }}
                style={{
                  width: 20,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: 'transparent',
                  color: 'hsl(var(--ink-4))',
                  cursor: 'pointer',
                  flexShrink: 0,
                  alignSelf: 'flex-start',
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
