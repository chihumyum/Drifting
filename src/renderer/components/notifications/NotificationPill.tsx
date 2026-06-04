/**
 * Dynamic-Island-style notification pill, mounted in the topbar to the left of
 * the right-sidebar toggle. It morphs in place:
 *   - a task is running   → spinner + its title,
 *   - a result just landed → ✓/⚠ + title for a few seconds,
 *   - otherwise            → a bell with an unread-count dot.
 * Clicking it toggles the NotificationCenter dropdown (the reopenable history).
 *
 * The store is fed globally from App (see useNotificationFeed), so this component
 * is pure presentation over useNotificationStore.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Ban, Bell, CheckCircle2, Loader2, Sparkles, Trash2, X } from 'lucide-react';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import {
  selectUnreadCount,
  useNotificationStore,
  type AppNotification,
} from '../../store/notification-store';

const RECENT_MS = 10000; // how long a finished task keeps showing in the pill before it collapses

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

function relTime(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function sourceLabel(n: AppNotification): string {
  return n.source === 'shadow' ? 'Shadow' : 'Copilot';
}

function SourceIcon({ n, size = 14 }: { n: AppNotification; size?: number }) {
  if (n.state === 'running') {
    return <Loader2 size={size} strokeWidth={2} style={{ animation: 'drift-spin 0.9s linear infinite' }} />;
  }
  if (n.state === 'stopped') return <Ban size={size} strokeWidth={2} />;
  if (n.state === 'failed') return <AlertTriangle size={size} strokeWidth={2} />;
  if (n.outcome === 'issues') return <AlertTriangle size={size} strokeWidth={2} />;
  return <CheckCircle2 size={size} strokeWidth={2} />;
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
  const items = useNotificationStore((s) => s.items);
  const centerOpen = useNotificationStore((s) => s.centerOpen);
  const toggleCenter = useNotificationStore((s) => s.toggleCenter);
  const setCenterOpen = useNotificationStore((s) => s.setCenterOpen);

  const runningItem = items.find((n) => n.state === 'running');
  const headUpdatedAt = items.length ? items[0].updatedAt : 0;

  // A finished result keeps showing in the pill for RECENT_MS after it lands,
  // then the pill collapses to the bell. Tracked by `recentKey` (the timestamp of
  // the update currently inside its recent window) — set/cleared from timeout
  // callbacks so the effect never calls setState synchronously.
  const [recentKey, setRecentKey] = useState(0);
  const lastHeadRef = useRef(0);
  useEffect(() => {
    if (!headUpdatedAt) return;
    // Only a genuinely NEW update (timestamp strictly increases) opens the recent
    // window. When the head changes because the newest item was deleted/reordered,
    // headUpdatedAt DROPS to an older value — that must not flash an old item into
    // the pill (bug #6).
    const isNew = headUpdatedAt > lastHeadRef.current;
    lastHeadRef.current = headUpdatedAt;
    if (!isNew) return;
    const on = window.setTimeout(() => setRecentKey(headUpdatedAt), 0);
    const off = window.setTimeout(
      () => setRecentKey((k) => (k === headUpdatedAt ? 0 : k)),
      RECENT_MS,
    );
    return () => {
      window.clearTimeout(on);
      window.clearTimeout(off);
    };
  }, [headUpdatedAt]);
  const recentActive = recentKey !== 0 && recentKey === headUpdatedAt;

  // Clock only for the center's relative timestamps (the pill needs no time).
  const now = useNow(centerOpen);
  const pillItem: AppNotification | null =
    runningItem ?? (recentActive ? items.find((n) => n.state !== 'running') ?? null : null);
  const unread = useMemo(() => selectUnreadCount(items), [items]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 40, right: 12 });

  const measure = () => {
    const r = pillRef.current?.getBoundingClientRect();
    if (r) setAnchor({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };
  const handleToggle = () => {
    if (!centerOpen) measure();
    toggleCenter();
  };

  // Close the center on outside click / Escape; keep it anchored on resize. The
  // center is portaled to <body> (see render) to escape the topbar's stacking
  // context — so the outside-click test must exclude BOTH the pill and the
  // portaled panel.
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

  const showText = !!pillItem;
  const tone = pillItem ? toneColor(pillItem) : 'hsl(var(--ink-3))';

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        ref={pillRef}
        type="button"
        onClick={handleToggle}
        title="通知"
        className={showText ? 'notif-pill' : 'notif-pill notif-pill--idle'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          maxWidth: 150,
          padding: showText ? '0 10px' : 0,
          width: showText ? undefined : 26,
          justifyContent: 'center',
          borderRadius: 13,
          border: '1px solid',
          borderColor: showText ? 'hsl(var(--rule))' : 'transparent',
          background: showText ? 'hsl(var(--paper-deep))' : 'transparent',
          color: tone,
          cursor: 'pointer',
          transition: 'width 0.25s ease, background 0.2s ease, border-color 0.2s ease, color 0.2s ease',
          overflow: 'hidden',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!showText) e.currentTarget.style.background = 'hsl(var(--paper-deep))';
        }}
        onMouseLeave={(e) => {
          if (!showText) e.currentTarget.style.background = 'transparent';
        }}
      >
        {pillItem ? (
          <>
            <SourceIcon n={pillItem} />
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: 'hsl(var(--ink-1))',
              }}
            >
              {pillItem.title}
            </span>
          </>
        ) : (
          <Bell size={16} strokeWidth={1.7} />
        )}
        {!showText && unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 1,
              right: 1,
              minWidth: 7,
              height: 7,
              borderRadius: 4,
              background: 'hsl(0 64% 51%)',
            }}
          />
        )}
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
        borderRadius: 10,
        boxShadow: '0 12px 40px hsl(var(--ink-1) / 0.18)',
        zIndex: 1300,
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
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'hsl(var(--ink-1))' }}>通知</span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clear}
            title="清空"
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
            <Trash2 size={12} /> 清空
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
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
          }}
        >
          暂无通知
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
                    {n.source === 'copilot' ? <Sparkles size={9} /> : <span style={{ fontStyle: 'italic' }}>◐</span>}
                    {sourceLabel(n)}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'hsl(var(--ink-4))' }}>
                    {relTime(n.updatedAt, now)}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--ink-1))', marginTop: 2 }}>
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
                aria-label="移除"
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
