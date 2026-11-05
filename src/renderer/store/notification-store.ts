/**
 * Global task notification feed. The sync feed projects sanitized Hosted
 * runtime progress into a capped, newest-first history that backs two surfaces:
 *   - the Dynamic-Island PILL in the topbar (shows the in-flight task, or the
 *     most-recent result for a few seconds, else an unread-count bell), and
 *   - the NOTIFICATION CENTER dropdown (the full recent history, reopenable).
 *
 * A task's phases collapse into ONE row keyed by `id` (started → completed),
 * so the pill morphs in place instead of stacking duplicates. The subscription
 * that feeds this store lives in the active project shell, so desktop and
 * mobile can project the same sanitized transfer lifecycle independently.
 */
import { create } from 'zustand';
import type { CrashFollowUp } from '../services/diagnostics/crash-reporter';
import type { SyncProblemReport } from '../sync/sync-health';

export type NotificationState = 'running' | 'completed' | 'failed' | 'stopped';
/**
 * `share-comment`: readers commented on something the author shares (features/share-links).
 * `markdown-folder`: an edited file in the project Markdown folder could not merge (docs/markdown-mirror.md).
 * `app-update`: a new version is available, or this launch installed one (services/update).
 * `crash-follow-up`: a fatal report from an earlier launch the author can explain (docs/crash-reports.md).
 */
export type AppNotificationSource =
  | 'hosted-sync'
  | 'share-comment'
  | 'agent-organize'
  | 'markdown-folder'
  | 'app-update'
  | 'crash-follow-up';

/** What a notification opens: an entity in a project, wherever the author is. */
export interface AppNotificationTarget {
  projectId: string;
  entityType: 'node' | 'element' | 'storyline' | 'category';
  id: string;
}
/** Tints the completed banner. */
export type NotificationOutcome = 'clean' | 'issues' | 'ok' | 'error';

export interface AppNotificationProgress {
  /** Null means the total is still being discovered. */
  value: number | null;
  transferredBytes: number;
  totalBytes: number;
  completedObjects: number;
  totalObjects: number;
}

/** One task lifecycle signal; `id` is stable across started → completed/failed. */
export interface AppNotificationEvent {
  id: string;
  source: AppNotificationSource;
  state: 'started' | 'completed' | 'failed' | 'stopped';
  title: string;
  detail?: string;
  /** For click-to-navigate, when applicable. */
  chapterId?: string;
  outcome?: NotificationOutcome;
  count?: number;
  error?: string;
  at: number;
  progress?: AppNotificationProgress;
  target?: AppNotificationTarget;
  /** Clicking the row opens this project's Home. */
  projectHomeId?: string;
  /** Clicking the row opens this Settings section. */
  settingsSection?: string;
  /** Clicking the row opens the feedback dialog to explain this crash. */
  crashFollowUp?: CrashFollowUp;
  /**
   * A sync problem the author has to act on (sync/sync-health.ts): the row
   * stays first and cannot be removed or cleared until an event with `null`
   * says it resolved.
   */
  syncProblem?: SyncProblemReport | null;
  /** Arrives already read, for a notice the author opened in an earlier launch. */
  read?: boolean;
}

export interface AppNotification {
  id: string; // === taskId (one row per task)
  source: AppNotificationSource;
  state: NotificationState;
  title: string;
  detail?: string;
  chapterId?: string;
  target?: AppNotificationTarget;
  projectHomeId?: string;
  settingsSection?: string;
  crashFollowUp?: CrashFollowUp;
  syncProblem?: SyncProblemReport;
  outcome?: NotificationOutcome;
  count?: number;
  error?: string;
  progress?: AppNotificationProgress;
  startedAt: number;
  updatedAt: number;
  read: boolean;
}

const MAX_ITEMS = 60;

function toState(s: AppNotificationEvent['state']): NotificationState {
  return s === 'started'
    ? 'running'
    : s === 'completed'
      ? 'completed'
      : s === 'stopped'
        ? 'stopped'
        : 'failed';
}

interface NotificationStore {
  items: AppNotification[]; // newest-first
  centerOpen: boolean;
  /** Which bell opened the center, when more than one is mounted (NotificationPill). */
  centerOwner: string | null;

  ingest: (e: AppNotificationEvent) => void;
  setCenterOpen: (open: boolean) => void;
  toggleCenter: (owner?: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  items: [],
  centerOpen: false,
  centerOwner: null,

  ingest: (e) =>
    set((s) => {
      const state = toState(e.state);
      const existing = s.items.find((n) => n.id === e.id);
      if (existing) {
        // A later phase of a known task — update in place, re-surface as unread
        // when it reaches a terminal state so the result actually gets noticed.
        const updated: AppNotification = {
          ...existing,
          state,
          title: e.title || existing.title,
          detail: e.syncProblem === null ? e.detail : e.detail ?? existing.detail,
          chapterId: e.chapterId ?? existing.chapterId,
          target: e.target ?? existing.target,
          projectHomeId: e.projectHomeId ?? existing.projectHomeId,
          settingsSection: e.settingsSection ?? existing.settingsSection,
          crashFollowUp: e.crashFollowUp ?? existing.crashFollowUp,
          syncProblem: e.syncProblem === undefined ? existing.syncProblem : e.syncProblem ?? undefined,
          outcome: e.outcome ?? existing.outcome,
          count: e.count ?? existing.count,
          // A resolved sync problem keeps none of the failure it reported.
          error: e.syncProblem === null ? e.error : e.error ?? existing.error,
          progress: e.progress,
          updatedAt: e.at,
          read: e.read ?? (state === 'running' ? existing.read : false),
        };
        // Move the touched row to the front.
        const rest = s.items.filter((n) => n.id !== e.id);
        return { items: [updated, ...rest].slice(0, MAX_ITEMS) };
      }
      const fresh: AppNotification = {
        id: e.id,
        source: e.source,
        state,
        title: e.title,
        detail: e.detail,
        chapterId: e.chapterId,
        target: e.target,
        projectHomeId: e.projectHomeId,
        settingsSection: e.settingsSection,
        crashFollowUp: e.crashFollowUp,
        syncProblem: e.syncProblem ?? undefined,
        outcome: e.outcome,
        count: e.count,
        error: e.error,
        progress: e.progress,
        startedAt: e.at,
        updatedAt: e.at,
        read: e.read ?? false,
      };
      return { items: [fresh, ...s.items].slice(0, MAX_ITEMS) };
    }),

  setCenterOpen: (open) =>
    set((s) => ({
      centerOpen: open,
      centerOwner: open ? s.centerOwner : null,
      items: open ? s.items.map((n) => (n.read ? n : { ...n, read: true })) : s.items,
    })),

  toggleCenter: (owner) =>
    set((s) => {
      const open = !s.centerOpen;
      return {
        centerOpen: open,
        centerOwner: open ? owner ?? null : null,
        items: open ? s.items.map((n) => (n.read ? n : { ...n, read: true })) : s.items,
      };
    }),

  markAllRead: () => set((s) => ({ items: s.items.map((n) => ({ ...n, read: true })) })),
  remove: (id) => set((s) => ({ items: s.items.filter((n) => n.id !== id || n.syncProblem) })),
  clear: () => set((s) => ({ items: s.items.filter((n) => n.syncProblem) })),
}));

export function selectUnreadCount(items: AppNotification[]): number {
  return items.reduce((acc, n) => (n.read ? acc : acc + 1), 0);
}
