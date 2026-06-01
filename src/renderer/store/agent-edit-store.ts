/**
 * Agent prose-edit review state (#3 / #4).
 *
 * When the agent edits a chapter's prose, the change already landed in the live
 * Yjs doc (soft-approval model — the agent's own re-reads stay consistent). This
 * store remembers, per node, WHICH blocks changed and their before/after text,
 * so the editor can:
 *   - auto mode:    show colored scrollbar ticks (new/changed/deleted) and play a
 *                   per-block reveal animation when the block scrolls into view;
 *                   the tick + the panel "M" clear only once that animation runs.
 *   - approve mode: show inline accept/reject controls; approving plays the same
 *                   animation, rejecting undoes the block via Yjs.
 *
 * Keyed `${entityType}:${id}` like the activity store. Seeded synchronously from
 * the renderer write path (chapter-prose), so it's populated the instant the edit
 * applies — before the tool result round-trips back through main.
 *
 * PERSISTED to localStorage: the prose edit itself is already durable (Yjs), so
 * if this review state were session-only, a reload would drop the pending markers
 * while the applied text stayed — i.e. silently accepting unreviewed edits. The
 * data is plain JSON (no Sets), so it round-trips cleanly.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { mergeBlockChanges, type AgentBlockChange } from '../lib/agent/block-diff';

export type AgentEditMode = 'auto' | 'approve';

export interface PendingEntityEdits {
  entityType: ActivityEntityType;
  id: string;
  /** The mode in effect when these edits were recorded (so flipping the global
   *  setting mid-run doesn't retro-reclassify edits already on screen). */
  mode: AgentEditMode;
  /** Outstanding (not-yet-revealed / not-yet-approved) block changes, merged. */
  changes: AgentBlockChange[];
}

interface AgentEditState {
  /** entityKey → pending block edits awaiting reveal/approval. */
  pending: Record<string, PendingEntityEdits>;

  /** Record a batch of agent block edits (from the write path). */
  record: (
    entityType: ActivityEntityType,
    id: string,
    changes: AgentBlockChange[],
    mode: AgentEditMode,
  ) => void;
  /** A block's reveal animation finished (auto) or it was approved/rejected
   *  (approve) — drop it; the entity clears once nothing is left. */
  resolveBlocks: (entityType: ActivityEntityType, id: string, blockIds: string[]) => void;
  /** Drop an entity's whole pending set (e.g. the user dismissed it). */
  clear: (entityType: ActivityEntityType, id: string) => void;
  /** New prompt / project switch — forget everything. */
  clearAll: () => void;
}

export const useAgentEditStore = create<AgentEditState>()(
  persist(
    (set) => ({
      pending: {},

      record: (entityType, id, changes, mode) => {
        if (changes.length === 0) return;
        const key = entityKey(entityType, id);
        set((s) => {
          const prev = s.pending[key];
          const merged = prev ? mergeBlockChanges(prev.changes, changes) : changes;
          if (merged.length === 0) {
            if (!prev) return s;
            const next = { ...s.pending };
            delete next[key];
            return { pending: next };
          }
          // Keep the mode from the first record of this run (stable through the turn).
          return {
            pending: { ...s.pending, [key]: { entityType, id, mode: prev?.mode ?? mode, changes: merged } },
          };
        });
      },

      resolveBlocks: (entityType, id, blockIds) => {
        const key = entityKey(entityType, id);
        const drop = new Set(blockIds);
        set((s) => {
          const entry = s.pending[key];
          if (!entry) return s;
          const changes = entry.changes.filter((c) => !drop.has(c.blockId));
          const next = { ...s.pending };
          if (changes.length === 0) delete next[key];
          else next[key] = { ...entry, changes };
          return { pending: next };
        });
      },

      clear: (entityType, id) => {
        const key = entityKey(entityType, id);
        set((s) => {
          if (!(key in s.pending)) return s;
          const next = { ...s.pending };
          delete next[key];
          return { pending: next };
        });
      },

      clearAll: () => set({ pending: {} }),
    }),
    {
      name: 'agent-edit-pending',
      storage: createJSONStorage(() => localStorage),
      // Only the data — methods come from the initializer on every load.
      partialize: (s) => ({ pending: s.pending }),
    },
  ),
);
