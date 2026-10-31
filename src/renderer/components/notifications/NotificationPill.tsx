/**
 * Notification bell: the round glass button in the account cell at the foot
 * of the left sidebar.
 *   - a task is running   → its source icon blinks
 *   - task just finished  → the result's ink seal for FLASH_MS, then the bell
 *   - a crash follow-up is unread → its warning seal, until the center opens
 *   - otherwise           → the bell (furin)
 * Clicking toggles the notification center, which opens upward from it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { workspaceUrlFor } from '../../features/workspace/navigation/workspace-route';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { BrushIcon } from '../ui/BrushIcon';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { GhostIconButton } from '../ui/GhostIconButton';
import { useNotificationStore, type AppNotification } from '../../store/notification-store';
import { useFeedbackDialogStore } from '../../features/feedback/feedback-dialog-store';
import '../../../styles/notifications.css';

const FLASH_MS = 1800; // how long the result icon shows in the circle after the pill collapses

type FlashResult = {
  state: 'completed' | 'failed' | 'stopped';
  outcome: string | undefined;
  source: AppNotification['source'];
  id: number;
} | null;

/** A reader's comment speaks in the comment colour with its own mark. */
const COMMENT_INK = 'hsl(var(--comment))';

/** Fixed-position edges of the notification center. */
type Anchor = { top: number; right: number } | { bottom: number; left: number };

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

function sourceLabel(n: AppNotification, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (n.source === 'agent-organize') return t('notifications.organize.source');
  if (n.source === 'markdown-folder') return t('notifications.markdownFolder.source');
  if (n.source === 'app-update') return t('notifications.appUpdate.source');
  if (n.source === 'crash-follow-up') return t('notifications.crashFollowUp.source');
  return t(n.source === 'share-comment' ? 'notifications.shareComments.source' : 'notifications.cloudSync.source');
}

function SourceIcon({ n, size = 14 }: { n: AppNotification; size?: number }) {
  if (n.source === 'share-comment') return <BrushIcon name="comment" size={size} />;
  if (n.state === 'running') {
    return (
      <BrushIcon name="loader" size={size} className="ui-spin" />
    );
  }
  if (n.state === 'stopped') return <BrushIcon name="status-stopped" size={size} />;
  if (n.state === 'failed') return <BrushIcon name="status-warning" size={size} />;
  if (n.outcome === 'issues') return <BrushIcon name="status-warning" size={size} />;
  return <BrushIcon name="status-done" size={size} />;
}

function flashToneColor(r: NonNullable<FlashResult>): string {
  if (r.source === 'share-comment') return COMMENT_INK;
  if (r.state === 'stopped') return 'hsl(var(--ink-3))';
  if (r.state === 'failed') return 'hsl(var(--destructive))';
  if (r.outcome === 'issues') return 'hsl(32 80% 44%)';
  return 'hsl(142 42% 40%)';
}

function FlashIcon({ result }: { result: NonNullable<FlashResult> }) {
  if (result.source === 'share-comment') return <BrushIcon name="comment" size={15} />;
  if (result.state === 'stopped') return <BrushIcon name="status-stopped" size={15} />;
  if (result.state === 'failed') return <BrushIcon name="status-warning" size={15} />;
  if (result.outcome === 'issues') return <BrushIcon name="status-warning" size={15} />;
  return <BrushIcon name="status-done" size={15} />;
}

// Foreground color for a notification's state/outcome.
function toneColor(n: AppNotification): string {
  if (n.source === 'share-comment') return COMMENT_INK;
  if (n.state === 'running') return 'hsl(var(--ink-2))';
  if (n.state === 'stopped') return 'hsl(var(--ink-3))';
  if (n.state === 'failed') return 'hsl(var(--destructive))';
  if (n.outcome === 'issues') return 'hsl(32 80% 44%)';
  return 'hsl(142 42% 40%)';
}

export function NotificationPill({ opens = 'down' }: {
  /** `up` opens the center above the bell, aligned to its left edge. */
  opens?: 'down' | 'up';
} = {}) {
  const { t } = useTranslation();
  const items = useNotificationStore((s) => s.items);
  const centerOpen = useNotificationStore((s) => s.centerOpen);
  const toggleCenter = useNotificationStore((s) => s.toggleCenter);
  const setCenterOpen = useNotificationStore((s) => s.setCenterOpen);

  const runningItem = items.find((n) => n.state === 'running');
  // A crash the author has not looked at keeps its seal on the bell.
  const unreadFollowUp = items.some((n) => n.source === 'crash-follow-up' && !n.read);
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
        source: head.source,
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
    if (!r) return;
    setAnchor(opens === 'up'
      ? { bottom: window.innerHeight - r.top + 6, left: Math.max(8, r.left - 8) }
      : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
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

  // Priority: active work (source-specific blink) > flash result icon > bell.
  let iconEl: React.ReactNode;
  let iconColor: string | undefined;
  if (runningItem) {
    iconColor = 'hsl(var(--ink-2))';
    iconEl = (
      <span key={`${runningItem.source}-run`} className="notif-blink-icon">
        {runningItem.source === 'agent-organize' ? (
          <BrushIcon name="shikigami" size={14} />
        ) : (
          <BrushIcon name="cloud" size={15} />
        )}
      </span>
    );
  } else if (flashResult) {
    iconColor = flashToneColor(flashResult);
    iconEl = (
      <span key={flashResult.id} className="notif-flash-icon">
        <FlashIcon result={flashResult} />
      </span>
    );
  } else if (unreadFollowUp) {
    iconColor = 'hsl(var(--destructive))';
    iconEl = <BrushIcon name="status-warning" size={15} />;
  } else {
    iconColor = undefined;
    iconEl = <BrushIcon name="furin" />;
  }

  return (
    <div ref={wrapRef} className="notification-pill">
      <GhostIconButton
        ref={btnRef}
        glass="round"
        onClick={handleToggle}
        title={t('notifications.title')}
        aria-label={t('notifications.title')}
        aria-expanded={centerOpen}
        className="notification-pill-button"
        style={iconColor ? { color: iconColor } : undefined}
        icon={iconEl}
      />

      {centerOpen &&
        createPortal(
          <NotificationCenter now={now} anchor={anchor} containerRef={centerRef} />,
          document.body,
        )}
    </div>
  );
}

/**
 * The notification center: the menu shell's rich panel (360px). Each
 * notification is a menu row; one that leads to a chapter carries the row's
 * ring of glass under the pointer. Unread titles are set at a heavier weight,
 * a failure speaks in the danger ink, progress is a hairline, and the remove
 * button appears only on the row under the pointer.
 */
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
  const { projectId, navigateToNode, navigateToHome } = useProjectNavigation();
  const navigate = useNavigate();
  const location = useLocation();

  const onRowClick = (n: AppNotification) => {
    if (n.crashFollowUp) {
      useFeedbackDialogStore.getState().show(n.crashFollowUp);
      setCenterOpen(false);
      return;
    }
    if (n.settingsSection) {
      navigate(`/settings?section=${n.settingsSection}`, { state: { from: `${location.pathname}${location.search}` } });
      setCenterOpen(false);
      return;
    }
    if (n.projectHomeId) {
      if (n.projectHomeId === projectId) navigateToHome();
      else navigate(`/project/${n.projectHomeId}`);
      setCenterOpen(false);
      return;
    }
    // A target may be in another project: open it by its workspace URL.
    const url = n.target
      ? workspaceUrlFor(n.target.projectId, { entityType: n.target.entityType, id: n.target.id })
      : null;
    if (url) {
      navigate(url);
      setCenterOpen(false);
    } else if (n.chapterId) {
      navigateToNode(n.chapterId);
      setCenterOpen(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="menu-surface menu-surface--rich menu-surface--panel notification-center"
      style={{ position: 'fixed', ...anchor }}
    >
      <div className="notification-center__head">
        <span>{t('notifications.title')}</span>
        {items.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clear} title={t('notifications.clear')}>
            {t('notifications.clear')}
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState icon="furin" density="compact" message={t('notifications.empty')} />
      ) : (
        <div className="notification-center__list">
          {items.map((n) => (
            <div
              key={n.id}
              onClick={() => onRowClick(n)}
              className={[
                'menu-surface__item',
                'notification-row',
                n.read ? '' : 'is-unread',
                n.chapterId || n.target || n.projectHomeId || n.settingsSection || n.crashFollowUp ? '' : 'is-static',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="notification-row__state" style={{ color: toneColor(n) }}>
                <SourceIcon n={n} size={15} />
              </span>
              <div className="notification-row__body">
                <div className="notification-row__meta">
                  <span className="notification-row__source">
                    <BrushIcon
                      name={n.source === 'share-comment' ? 'comment' : n.source === 'agent-organize' ? 'shikigami' : n.source === 'markdown-folder' ? 'both-ways' : n.source === 'app-update' ? 'rotate' : n.source === 'crash-follow-up' ? 'brush-broken' : 'cloud'}
                      size={12}
                    />
                    {sourceLabel(n, t)}
                  </span>
                  <span className="notification-row__time">{relTime(n.updatedAt, now, t)}</span>
                </div>
                <div className="notification-row__title">{n.title}</div>
                {(n.detail || n.error) && (
                  <div className={`notification-row__detail${n.error ? ' is-error' : ''}`}>
                    {n.error || n.detail}
                  </div>
                )}
                {n.state === 'running' && n.progress && (
                  <div
                    className={`ui-progress notification-row__progress${n.progress.value === null ? ' ui-progress--indeterminate' : ''}`}
                    role="progressbar"
                    aria-label={t('notifications.cloudSync.progressLabel')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(n.progress.value === null
                      ? {}
                      : { 'aria-valuenow': Math.round(n.progress.value * 100) })}
                  >
                    <span
                      className="ui-progress__fill"
                      style={n.progress.value === null ? undefined : { width: `${n.progress.value * 100}%` }}
                    />
                  </div>
                )}
              </div>
              <GhostIconButton
                size="sm"
                className="notification-row__remove"
                aria-label={t('notifications.remove')}
                title={t('notifications.remove')}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(n.id);
                }}
                icon={<BrushIcon name="close" size={13} />}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
