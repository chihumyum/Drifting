/**
 * Global task notification feed. Copilot emits an `ai-task` event while the
 * desktop sync feed projects sanitized Google Drive runtime progress. Both are
 * ingested into a capped, newest-first history that backs two surfaces:
 *   - the Dynamic-Island PILL in the topbar (shows the in-flight task, or the
 *     most-recent result for a few seconds, else an unread-count bell), and
 *   - the NOTIFICATION CENTER dropdown (the full recent history, reopenable).
 *
 * A task's phases collapse into ONE row keyed by `id` (started → completed),
 * so the pill morphs in place instead of stacking duplicates. The subscription
 * that feeds this store lives in App (always mounted) so history is collected
 * even when the pill itself isn't rendered.
 */
import { create } from 'zustand';
import type { AiTaskEvent, AiTaskOutcome, AiTaskSource } from '../lib/events';

export type NotificationState = 'running' | 'completed' | 'failed' | 'stopped';
export type AppNotificationSource = AiTaskSource | 'google-drive';

export interface AppNotificationProgress {
  /** Null means the total is still being discovered. */
  value: number | null;
  transferredBytes: number;
  totalBytes: number;
  completedObjects: number;
  totalObjects: number;
}

export interface AppNotificationEvent extends Omit<AiTaskEvent, 'source'> {
  source: AppNotificationSource;
  progress?: AppNotificationProgress;
}

export interface AppNotification {
  id: string; // === taskId (one row per task)
  source: AppNotificationSource;
  state: NotificationState;
  title: string;
  detail?: string;
  chapterId?: string;
  outcome?: AiTaskOutcome;
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

  ingest: (e: AppNotificationEvent) => void;
  setCenterOpen: (open: boolean) => void;
  toggleCenter: () => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  items: [],
  centerOpen: false,

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
          detail: e.detail ?? existing.detail,
          chapterId: e.chapterId ?? existing.chapterId,
          outcome: e.outcome ?? existing.outcome,
          count: e.count ?? existing.count,
          error: e.error ?? existing.error,
          progress: e.progress,
          updatedAt: e.at,
          read: state === 'running' ? existing.read : false,
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
        outcome: e.outcome,
        count: e.count,
        error: e.error,
        progress: e.progress,
        startedAt: e.at,
        updatedAt: e.at,
        read: false,
      };
      return { items: [fresh, ...s.items].slice(0, MAX_ITEMS) };
    }),

  setCenterOpen: (open) =>
    set((s) => ({
      centerOpen: open,
      items: open ? s.items.map((n) => (n.read ? n : { ...n, read: true })) : s.items,
    })),

  toggleCenter: () =>
    set((s) => {
      const open = !s.centerOpen;
      return {
        centerOpen: open,
        items: open ? s.items.map((n) => (n.read ? n : { ...n, read: true })) : s.items,
      };
    }),

  markAllRead: () => set((s) => ({ items: s.items.map((n) => ({ ...n, read: true })) })),
  remove: (id) => set((s) => ({ items: s.items.filter((n) => n.id !== id) })),
  clear: () => set({ items: [] }),
}));

export function selectUnreadCount(items: AppNotification[]): number {
  return items.reduce((acc, n) => (n.read ? acc : acc + 1), 0);
}
