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
import { mergeBlockChanges, type AgentBlockChange, type AgentFieldRef } from '../lib/agent/block-diff';
import { useAgentCheckpointStore } from './agent-checkpoint-store';

export type AgentEditMode = 'auto' | 'approve';

export interface PendingEntityEdits {
  entityType: ActivityEntityType;
  id: string;
  /** Outstanding (not-yet-revealed / not-yet-approved) block changes, merged.
   *  Each change carries its OWN `mode` (stamped at record time), so flipping the
   *  global toggle only governs future edits — see {@link AgentBlockChange.mode}. */
  changes: AgentBlockChange[];
}

export interface AgentEditReviewBatch {
  effectId: string;
  reviewId: string;
  entityType: ActivityEntityType;
  id: string;
  /**
   * Exact per-effect diff, before cross-effect visual merging. Durable review
   * settlement must consume these batches in reverse reviewOrder and call the
   * Agent runtime's guarded inverse; it must never locally replay old text.
   */
  changes: AgentBlockChange[];
}

/**
 * A block edit the user REJECTED (approve-mode ✗) and that was successfully
 * reverted in the doc. The agent ran `bypassPermissions`, so it believes its
 * edit stuck — this is queued and fed into its NEXT turn's prompt so its mental
 * model of the manuscript stays in sync. Project-scoped because the edit-store
 * key carries no projectId and a revert in one project must not leak into
 * another project's conversation.
 */
export interface RevertRecord {
  projectId: string;
  entityType: ActivityEntityType;
  id: string;
  blockId: string;
  op: AgentBlockChange['op'];
  /** The text the block was restored TO ('' when the rejected edit was a brand-new
   *  block that got removed). */
  restoredText: string;
  /** Present when the rejected edit was a NON-PROSE field (summary / kv / …), so
   *  the agent-facing revert note can name the field instead of "a paragraph". */
  field?: AgentFieldRef;
}

interface AgentEditState {
  /** entityKey → pending block edits awaiting reveal/approval. */
  pending: Record<string, PendingEntityEdits>;
  /** Rejected-then-reverted edits awaiting delivery to the agent's next turn. */
  pendingReverts: RevertRecord[];
  /**
   * Independent persistent idempotency/provenance ledger for runtime reviews.
   * `pending` is a visual aggregate and cannot answer whether an older effect
   * was already recorded after a later effect touched the same block.
   */
  reviewBatches: Record<string, AgentEditReviewBatch>;
  reviewOrder: string[];
  /** Reviews whose canonical runtime settlement succeeded and whose local
   * visual batch was removed. Prevents a late receipt replay from resurrecting
   * an already-settled review. */
  settledReviewIds: Record<string, true>;

  /** Record a batch of agent block edits (from the write path). */
  record: (
    entityType: ActivityEntityType,
    id: string,
    changes: AgentBlockChange[],
    mode: AgentEditMode,
  ) => void;
  /**
   * Record one deterministic durable Agent review exactly once. Returns false
   * for a replay of the same reviewId.
   */
  recordReview: (
    entityType: ActivityEntityType,
    id: string,
    changes: AgentBlockChange[],
    mode: AgentEditMode,
    provenance: { effectId: string; reviewId: string },
  ) => boolean;
  /**
   * Remove successfully settled durable batches and deterministically rebuild
   * the visual aggregate from legacy changes plus the remaining ordered
   * batches. Idempotent for duplicate settlement notifications.
   */
  resolveReviews: (reviewIds: string[]) => void;
  /** A block's reveal animation finished (auto) or it was approved/rejected
   *  (approve) — drop it; the entity clears once nothing is left. */
  resolveBlocks: (entityType: ActivityEntityType, id: string, blockIds: string[]) => void;
  /** Queue a rejected-then-reverted edit for the agent's next turn. */
  recordRevert: (
    projectId: string,
    entityType: ActivityEntityType,
    id: string,
    change: AgentBlockChange,
  ) => void;
  /** Take (and clear) the queued reverts for a project, to inject into the next
   *  turn's prompt. Leaves other projects' reverts untouched. */
  drainReverts: (projectId: string) => RevertRecord[];
  /** Drop an entity's whole pending set (e.g. the user dismissed it). */
  clear: (entityType: ActivityEntityType, id: string) => void;
  /** New prompt / project switch — forget everything. */
  clearAll: () => void;
}

export const useAgentEditStore = create<AgentEditState>()(
  persist(
    (set, get) => ({
      pending: {},
      pendingReverts: [],
      reviewBatches: {},
      reviewOrder: [],
      settledReviewIds: {},

      record: (entityType, id, changes, mode) => {
        if (changes.length === 0) return;
        const key = entityKey(entityType, id);
        // Stamp EACH change with the mode in effect right now, so it keeps that
        // mode for the rest of its life regardless of later toggle flips. Merging
        // a re-edited block keeps the latest edit's mode (mergeBlockChanges spreads
        // the incoming change).
        const stamped = changes.map((c) => ({ ...c, mode }));
        // Tee into the running turn's checkpoint (the whole-turn undo trail) —
        // it outlives this store's entries, which clear on reveal/approve.
        useAgentCheckpointStore.getState().recordChanges(entityType, id, stamped);
        set((s) => {
          const prev = s.pending[key];
          const merged = prev ? mergeBlockChanges(prev.changes, stamped) : stamped;
          if (merged.length === 0) {
            if (!prev) return s;
            const next = { ...s.pending };
            delete next[key];
            return { pending: next };
          }
          return { pending: { ...s.pending, [key]: { entityType, id, changes: merged } } };
        });
      },

      recordReview: (
        entityType,
        id,
        changes,
        mode,
        provenance,
      ) => {
        if (
          changes.length === 0 ||
          get().reviewBatches[provenance.reviewId] ||
          get().settledReviewIds[provenance.reviewId]
        ) {
          return false;
        }
        const key = entityKey(entityType, id);
        const stamped = changes.map((change) => ({
          ...change,
          mode,
          effectId: provenance.effectId,
          reviewId: provenance.reviewId,
        }));
        useAgentCheckpointStore
          .getState()
          .recordChanges(entityType, id, stamped);
        set((state) => {
          // Keep this guard inside the state transition as well as above: the
          // batch map, not merged block contents, is the idempotency authority.
          if (state.reviewBatches[provenance.reviewId]) return state;
          const previous = state.pending[key];
          const merged = previous
            ? mergeBlockChanges(previous.changes, stamped)
            : stamped;
          return {
            pending: {
              ...state.pending,
              [key]: { entityType, id, changes: merged },
            },
            reviewBatches: {
              ...state.reviewBatches,
              [provenance.reviewId]: {
                ...provenance,
                entityType,
                id,
                changes: stamped,
              },
            },
            reviewOrder: [...state.reviewOrder, provenance.reviewId],
          };
        });
        return true;
      },

      resolveReviews: (reviewIds) => {
        const resolved = new Set(
          reviewIds.filter((reviewId) => reviewId.trim().length > 0),
        );
        if (resolved.size === 0) return;
        set((state) => {
          const reviewBatches = { ...state.reviewBatches };
          const settledReviewIds = { ...state.settledReviewIds };
          let changed = false;
          for (const reviewId of resolved) {
            if (reviewBatches[reviewId]) {
              delete reviewBatches[reviewId];
              changed = true;
            }
            if (!settledReviewIds[reviewId]) {
              settledReviewIds[reviewId] = true;
              changed = true;
            }
          }
          if (!changed) return state;
          const reviewOrder = state.reviewOrder.filter(
            (reviewId) => !resolved.has(reviewId),
          );
          return {
            reviewBatches,
            reviewOrder,
            settledReviewIds,
            pending: rebuildVisualPending(
              state.pending,
              reviewBatches,
              reviewOrder,
            ),
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

      recordRevert: (projectId, entityType, id, change) => {
        set((s) => ({
          pendingReverts: [
            ...s.pendingReverts,
            {
              projectId,
              entityType,
              id,
              blockId: change.blockId,
              op: change.op,
              restoredText: change.oldText,
              field: change.field,
            },
          ],
        }));
      },

      drainReverts: (projectId) => {
        const all = get().pendingReverts;
        const mine = all.filter((r) => r.projectId === projectId);
        if (mine.length) set({ pendingReverts: all.filter((r) => r.projectId !== projectId) });
        return mine;
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

      clearAll: () =>
        set({
          pending: {},
          pendingReverts: [],
          reviewBatches: {},
          reviewOrder: [],
          settledReviewIds: {},
        }),
    }),
    {
      name: 'agent-edit-pending',
      storage: createJSONStorage(() => localStorage),
      // Only the data — methods come from the initializer on every load. Reverts
      // persist too, so a reject survives a reload before the next turn drains it.
      partialize: (s) => ({
        pending: s.pending,
        pendingReverts: s.pendingReverts,
        reviewBatches: s.reviewBatches,
        reviewOrder: s.reviewOrder,
        settledReviewIds: s.settledReviewIds,
      }),
    },
  ),
);

function rebuildVisualPending(
  previous: Record<string, PendingEntityEdits>,
  reviewBatches: Record<string, AgentEditReviewBatch>,
  reviewOrder: readonly string[],
): Record<string, PendingEntityEdits> {
  const rebuilt: Record<string, PendingEntityEdits> = {};
  for (const [key, entry] of Object.entries(previous)) {
    const legacy = entry.changes.filter((change) => !change.reviewId);
    if (legacy.length > 0) {
      rebuilt[key] = { ...entry, changes: legacy };
    }
  }
  for (const reviewId of reviewOrder) {
    const batch = reviewBatches[reviewId];
    if (!batch) continue;
    const key = entityKey(batch.entityType, batch.id);
    const previousEntry = rebuilt[key];
    rebuilt[key] = {
      entityType: batch.entityType,
      id: batch.id,
      changes: previousEntry
        ? mergeBlockChanges(previousEntry.changes, batch.changes)
        : [...batch.changes],
    };
  }
  return rebuilt;
}
