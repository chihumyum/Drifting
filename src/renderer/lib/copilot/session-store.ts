/**
 * Copilot session store — per-chapter dirty-block queue + visit tracking.
 *
 * The Copilot runner used to scan only the block at the cursor when the
 * debounce timer fired. That model dropped edits on the floor whenever the
 * user wrote fast enough to leave a block before debounce hit. This store
 * fixes the gap: every text-changing transaction marks its block as dirty,
 * and the runner drains the per-chapter dirty set on each debounce fire.
 *
 * Persistence: in-memory only. Rolling block-section summaries (PR A) are
 * the durable artifact; this queue is pure ephemeral session state. If the
 * app is closed before a debounce ever flushes, the unscanned edits are
 * lost — a future quit-flush hook can fire detect on `before-quit` to
 * close that gap if it shows up in practice.
 *
 * Per-chapter scoping: dirty + lastVisited bucket by chapterId. Switching
 * chapters never bleeds dirty state across. Visiting a chapter updates
 * `lastVisitedAt` so a future idle-clear policy can prune stale state
 * without re-engineering the store.
 */
import { create } from 'zustand';

interface CopilotSessionState {
  /** chapterId → dirty blockIds (still need a Copilot scan). */
  dirtyByChapter: Record<string, Set<string>>;
  /** chapterId → last time the user was active in this chapter. */
  lastVisitedAt: Record<string, number>;

  /** Mark a block as needing a Copilot scan in its chapter. */
  markDirty(chapterId: string, blockId: string): void;
  /** Mark multiple blocks at once (e.g. paste / IME multi-transaction). */
  markDirtyMany(chapterId: string, blockIds: Iterable<string>): void;
  /** Snapshot the dirty set for a chapter (returns a new Set; safe to iterate). */
  getDirty(chapterId: string): Set<string>;
  /**
   * Remove the listed block ids from the chapter's dirty set. Called after
   * a successful detect run so subsequent debounces only process NEW edits.
   * Idempotent — block ids not in the set are no-ops.
   */
  drainDirty(chapterId: string, blockIds: Iterable<string>): void;
  /** Drop the entire dirty set for a chapter (chapter marked finished, etc). */
  clearChapter(chapterId: string): void;
  /** Stamp the user as active in this chapter; called on editor mount + edits. */
  touchChapter(chapterId: string): void;
}

export const useCopilotSessionStore = create<CopilotSessionState>((set, get) => ({
  dirtyByChapter: {},
  lastVisitedAt: {},

  markDirty: (chapterId, blockId) => {
    set((state) => {
      const current = state.dirtyByChapter[chapterId];
      if (current && current.has(blockId)) return state;
      const next = new Set(current ?? []);
      next.add(blockId);
      return {
        dirtyByChapter: { ...state.dirtyByChapter, [chapterId]: next },
        lastVisitedAt: { ...state.lastVisitedAt, [chapterId]: Date.now() },
      };
    });
  },

  markDirtyMany: (chapterId, blockIds) => {
    set((state) => {
      const current = state.dirtyByChapter[chapterId];
      const next = new Set(current ?? []);
      let changed = false;
      for (const id of blockIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (!changed) return state;
      return {
        dirtyByChapter: { ...state.dirtyByChapter, [chapterId]: next },
        lastVisitedAt: { ...state.lastVisitedAt, [chapterId]: Date.now() },
      };
    });
  },

  getDirty: (chapterId) => {
    const current = get().dirtyByChapter[chapterId];
    return current ? new Set(current) : new Set();
  },

  drainDirty: (chapterId, blockIds) => {
    set((state) => {
      const current = state.dirtyByChapter[chapterId];
      if (!current || current.size === 0) return state;
      const next = new Set(current);
      let changed = false;
      for (const id of blockIds) {
        if (next.delete(id)) changed = true;
      }
      if (!changed) return state;
      return {
        dirtyByChapter: { ...state.dirtyByChapter, [chapterId]: next },
      };
    });
  },

  clearChapter: (chapterId) => {
    set((state) => {
      if (!state.dirtyByChapter[chapterId]) return state;
      const nextDirty = { ...state.dirtyByChapter };
      delete nextDirty[chapterId];
      return { dirtyByChapter: nextDirty };
    });
  },

  touchChapter: (chapterId) => {
    set((state) => ({
      lastVisitedAt: { ...state.lastVisitedAt, [chapterId]: Date.now() },
    }));
  },
}));
