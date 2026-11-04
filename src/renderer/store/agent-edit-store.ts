/**
 * General Agent prose-edit presentation state (#3 / #4).
 *
 * General Agent prose writes enter this store only after their Yjs mutation,
 * durable effect result, and canonical SQLite settlement receipt have
 * committed. The store is therefore a rebuildable editor projection, never
 * write authority or prose truth. It remembers which blocks changed and their
 * before/after text for unread ticks and viewport reveals. Sidebar
 * acknowledgement consumes this presentation without mutating prose.
 *
 * Keyed `${entityType}:${id}` like the activity store.
 *
 * Best-effort, bounded localStorage cache so presentation can survive a reload.
 * Storage failure must never escape a store action or interrupt an editor.
 * SQLite reconciliation remains authoritative for every durable batch.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { mergeBlockChanges, type AgentBlockChange } from '../lib/agent/block-diff';
import { parseDocId, proseEntityTypeForDocKind } from '../lib/yjs-doc-id';
import { createAgentEditStorage } from './agent-edit-storage';

export interface PendingEntityEdits {
  entityType: ActivityEntityType;
  id: string;
  /** Outstanding unread changes. */
  changes: AgentBlockChange[];
  /** Who changed the entity most recently; absent means the Agent. */
  lastSource?: 'agent' | 'file';
}
/**
 * A prose entity created by General Agent but not yet opened by the author.
 * `revealBlockIds === null` means the editor has not materialized stable block
 * ids yet; once it does, the ids are persisted so an interrupted first-open
 * reveal resumes instead of silently turning the Added marker into Modified.
 */
export interface AgentAddedEntity {
  entityType: ActivityEntityType;
  id: string;
  revealBlockIds: string[] | null;
}

/**
 * Ephemeral pre-live guard for an auto prose write. The durable Yjs transaction
 * commits before its canonical review is projected; an open editor must mask
 * these blocks synchronously before that committed update merges into its
 * Y.Doc. This is presentation only and is deliberately excluded from persist.
 */
export interface AgentAutoRevealGuard {
  entityType: ActivityEntityType;
  id: string;
  reviewId: string;
  blockIds: string[];
}

export interface AgentEditReviewBatch {
  effectId: string;
  reviewId: string;
  entityType: ActivityEntityType;
  id: string;
  /** Exact per-effect diff, before cross-effect visual merging. */
  changes: AgentBlockChange[];
}

type PersistedAgentEditState = Pick<
  AgentEditState,
  'pending' | 'additions' | 'reviewBatches' | 'reviewOrder' | 'settledReviewIds'
>;

interface AgentEditState {
  /** entityKey → unread block edits awaiting reveal/acknowledgement. */
  pending: Record<string, PendingEntityEdits>;
  /** entityKey → Agent-created prose entity awaiting its first full reveal. */
  additions: Record<string, AgentAddedEntity>;
  /** reviewId → blocks masked immediately before a committed live Yjs merge. */
  autoRevealGuards: Record<string, AgentAutoRevealGuard>;
  /**
   * Independent persistent idempotency/provenance ledger for runtime receipts.
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
  ) => void;
  /**
   * Record what an edit made in another editor changed (docs/markdown-mirror.md).
   * A block with a pending Agent review keeps that review: the external change
   * is dropped for it rather than taking over its provenance.
   */
  recordExternal: (entityType: ActivityEntityType, id: string, changes: AgentBlockChange[]) => void;
  /**
   * Record one deterministic durable Agent receipt exactly once. Returns false
   * for a replay of the same reviewId.
   */
  recordReview: (
    entityType: ActivityEntityType,
    id: string,
    changes: AgentBlockChange[],
    provenance: { effectId: string; reviewId: string },
  ) => boolean;
  /** Install a mask before a durable auto write merges into an open Y.Doc. */
  stageAutoRevealGuard: (
    entityType: ActivityEntityType,
    id: string,
    reviewId: string,
    blockIds: string[],
  ) => void;
  /** Remove a failed/replayed pre-live mask. */
  clearAutoRevealGuard: (reviewId: string) => void;
  /** Persist the Added state after a successful General Agent create result. */
  recordAddition: (entityType: ActivityEntityType, id: string) => void;
  /**
   * Seed the first-open reveal after ProseMirror has assigned stable block ids.
   * Existing durable receipt blocks win on overlap so an Added presentation
   * never takes over a later edit's provenance.
   */
  beginAdditionReveal: (
    entityType: ActivityEntityType,
    id: string,
    changes: AgentBlockChange[],
  ) => string[];
  /** Clear the Added marker only after every seeded block reveal has finished. */
  resolveAddition: (entityType: ActivityEntityType, id: string) => void;
  /**
   * Remove successfully settled durable batches and deterministically rebuild
   * the visual aggregate from legacy changes plus the remaining ordered
   * batches. Idempotent for duplicate settlement notifications.
   */
  resolveReviews: (reviewIds: string[]) => void;
  /** A block's reveal finished or was acknowledged — drop it; the entity
   *  clears once nothing is left. */
  resolveBlocks: (entityType: ActivityEntityType, id: string, blockIds: string[]) => void;
  /** Drop an entity's whole pending set (e.g. the user dismissed it). */
  clear: (entityType: ActivityEntityType, id: string) => void;
  /** Acknowledge current presentation; SQLite/Yjs writes are already committed. */
  markSeen: (keys: readonly string[]) => void;
  /** Remove every persisted presentation receipt owned by a deleted project. */
  clearProject: (projectId: string, proseDocIds: string[], reviewIds: string[]) => void;
  /** New prompt / project switch — forget everything. */
  clearAll: () => void;
}

export const useAgentEditStore = create<AgentEditState>()(
  persist(
    (set, get) => ({
      pending: {},
      additions: {},
      autoRevealGuards: {},
      reviewBatches: {},
      reviewOrder: [],
      settledReviewIds: {},

      record: (entityType, id, changes) => {
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
          return { pending: { ...s.pending, [key]: { entityType, id, changes: merged, lastSource: 'agent' } } };
        });
      },

      recordExternal: (entityType, id, changes) => {
        const key = entityKey(entityType, id);
        const reviewed = new Set(
          (get().pending[key]?.changes ?? []).filter((change) => change.reviewId).map((change) => change.blockId),
        );
        const stamped = changes
          .filter((change) => !change.field && !reviewed.has(change.blockId))
          .map((change) => ({ ...change, source: 'file' as const }));
        if (stamped.length === 0) return;
        set((s) => {
          const prev = s.pending[key];
          const merged = prev ? mergeBlockChanges(prev.changes, stamped) : stamped;
          if (merged.length === 0) {
            if (!prev) return s;
            const next = { ...s.pending };
            delete next[key];
            return { pending: next };
          }
          return { pending: { ...s.pending, [key]: { entityType, id, changes: merged, lastSource: 'file' } } };
        });
      },

      recordReview: (
        entityType,
        id,
        changes,
        provenance,
      ) => {
        if (
          changes.length === 0 ||
          get().reviewBatches[provenance.reviewId] ||
          get().settledReviewIds[provenance.reviewId]
        ) {
          get().clearAutoRevealGuard(provenance.reviewId);
          return false;
        }
        const key = entityKey(entityType, id);
        const stamped = changes.map((change) => ({
          ...change,
          effectId: provenance.effectId,
          reviewId: provenance.reviewId,
        }));
        set((state) => {
          const guarded = state.autoRevealGuards[provenance.reviewId];
          const autoRevealGuards = guarded
            ? { ...state.autoRevealGuards }
            : state.autoRevealGuards;
          if (guarded) delete autoRevealGuards[provenance.reviewId];
          // Keep this guard inside the state transition as well as above: the
          // batch map, not merged block contents, is the idempotency authority.
          if (state.reviewBatches[provenance.reviewId]) {
            return guarded ? { autoRevealGuards } : state;
          }
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
                effectId: provenance.effectId,
                reviewId: provenance.reviewId,
                entityType,
                id,
                changes: stamped,
              },
            },
            reviewOrder: [...state.reviewOrder, provenance.reviewId],
            autoRevealGuards,
          };
        });
        return true;
      },

      stageAutoRevealGuard: (entityType, id, reviewId, blockIds) => {
        const uniqueBlockIds = [...new Set(blockIds.filter(Boolean))];
        if (!reviewId.trim() || uniqueBlockIds.length === 0) return;
        set((state) => {
          const previous = state.autoRevealGuards[reviewId];
          if (
            previous &&
            previous.entityType === entityType &&
            previous.id === id &&
            previous.blockIds.length === uniqueBlockIds.length &&
            previous.blockIds.every(
              (blockId, index) => blockId === uniqueBlockIds[index],
            )
          ) {
            return state;
          }
          return {
            autoRevealGuards: {
              ...state.autoRevealGuards,
              [reviewId]: { entityType, id, reviewId, blockIds: uniqueBlockIds },
            },
          };
        });
      },

      clearAutoRevealGuard: (reviewId) => {
        set((state) => {
          if (!state.autoRevealGuards[reviewId]) return state;
          const autoRevealGuards = { ...state.autoRevealGuards };
          delete autoRevealGuards[reviewId];
          return { autoRevealGuards };
        });
      },

      recordAddition: (entityType, id) => {
        const key = entityKey(entityType, id);
        set((state) =>
          state.additions[key]
            ? state
            : {
                additions: {
                  ...state.additions,
                  [key]: { entityType, id, revealBlockIds: null },
                },
              },
        );
      },

      beginAdditionReveal: (entityType, id, changes) => {
        const key = entityKey(entityType, id);
        const state = get();
        const addition = state.additions[key];
        if (!addition) return [];
        if (addition.revealBlockIds !== null) return addition.revealBlockIds;

        const existing = state.pending[key];
        const occupied = new Set(existing?.changes.map((change) => change.blockId) ?? []);
        const seeded = changes.filter((change) => !occupied.has(change.blockId));
        const revealBlockIds = seeded.map((change) => change.blockId);
        set((current) => ({
          additions: {
            ...current.additions,
            [key]: { ...addition, revealBlockIds },
          },
          ...(seeded.length > 0
            ? {
                pending: {
                  ...current.pending,
                  [key]: {
                    entityType,
                    id,
                    changes: current.pending[key]
                      ? mergeBlockChanges(current.pending[key].changes, seeded)
                      : seeded,
                  },
                },
              }
            : {}),
        }));
        return revealBlockIds;
      },

      resolveAddition: (entityType, id) => {
        const key = entityKey(entityType, id);
        set((state) => {
          if (!state.additions[key]) return state;
          const additions = { ...state.additions };
          delete additions[key];
          return { additions };
        });
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

      clear: (entityType, id) => {
        const key = entityKey(entityType, id);
        set((s) => {
          const guardedReviewIds = Object.values(s.autoRevealGuards)
            .filter((guard) => guard.entityType === entityType && guard.id === id)
            .map((guard) => guard.reviewId);
          if (
            !(key in s.pending) &&
            !(key in s.additions) &&
            guardedReviewIds.length === 0
          ) {
            return s;
          }
          const pending = { ...s.pending };
          const additions = { ...s.additions };
          const autoRevealGuards = { ...s.autoRevealGuards };
          delete pending[key];
          delete additions[key];
          for (const reviewId of guardedReviewIds) {
            delete autoRevealGuards[reviewId];
          }
          return { pending, additions, autoRevealGuards };
        });
      },

      markSeen: (keys) => {
        const acknowledged = new Set(keys);
        if (acknowledged.size === 0) return;
        set((state) => {
          const pending = { ...state.pending };
          const additions = { ...state.additions };
          const reviewBatches = { ...state.reviewBatches };
          const settledReviewIds = { ...state.settledReviewIds };
          for (const key of acknowledged) {
            delete pending[key];
            delete additions[key];
          }
          for (const [reviewId, batch] of Object.entries(reviewBatches)) {
            if (!acknowledged.has(entityKey(batch.entityType, batch.id))) continue;
            delete reviewBatches[reviewId];
            settledReviewIds[reviewId] = true;
          }
          return {
            pending, additions, reviewBatches, settledReviewIds,
            reviewOrder: state.reviewOrder.filter((reviewId) => reviewId in reviewBatches),
          };
        });
      },

      clearProject: (_projectId, proseDocIds, reviewIds) => {
        const projectEntityKeys = new Set<string>();
        for (const docId of proseDocIds) {
          const parsed = parseDocId(docId);
          const entityType: ActivityEntityType | null = parsed
            ? proseEntityTypeForDocKind(parsed.kind)
            : null;
          if (!parsed || !entityType) continue;
          projectEntityKeys.add(entityKey(entityType, parsed.entityId));
        }

        set((state) => {
          const removedReviewIds = new Set(reviewIds);
          for (const [reviewId, batch] of Object.entries(state.reviewBatches)) {
            if (projectEntityKeys.has(entityKey(batch.entityType, batch.id))) {
              removedReviewIds.add(reviewId);
            }
          }

          return {
            pending: Object.fromEntries(
              Object.entries(state.pending).filter(([key]) => !projectEntityKeys.has(key)),
            ),
            additions: Object.fromEntries(
              Object.entries(state.additions).filter(([key]) => !projectEntityKeys.has(key)),
            ),
            autoRevealGuards: Object.fromEntries(
              Object.entries(state.autoRevealGuards).filter(
                ([, guard]) =>
                  !projectEntityKeys.has(entityKey(guard.entityType, guard.id)) &&
                  !removedReviewIds.has(guard.reviewId),
              ),
            ),
            reviewBatches: Object.fromEntries(
              Object.entries(state.reviewBatches).filter(
                ([reviewId]) => !removedReviewIds.has(reviewId),
              ),
            ),
            reviewOrder: state.reviewOrder.filter(
              (reviewId) => !removedReviewIds.has(reviewId),
            ),
            settledReviewIds: Object.fromEntries(
              Object.entries(state.settledReviewIds).filter(
                ([reviewId]) => !removedReviewIds.has(reviewId),
              ),
            ),
          };
        });
      },

      clearAll: () =>
        set({
          pending: {},
          additions: {},
          autoRevealGuards: {},
          reviewBatches: {},
          reviewOrder: [],
          settledReviewIds: {},
        }),
    }),
    {
      name: 'agent-edit-pending',
      storage: createAgentEditStorage(),
      version: 2,
      // v0 caches belonged to the superseded pre-runtime review protocol and
      // are dropped. v1 caches also carried the retired reject queue
      // (`pendingReverts`); everything else is kept. Changes stamped with the
      // retired `mode` are read like any other unread change.
      migrate: (persistedState, version) => {
        if (version < 1 || !isRecord(persistedState)) return {} as PersistedAgentEditState;
        const state = { ...persistedState };
        delete state.pendingReverts;
        return state as unknown as PersistedAgentEditState;
      },
      // Only the data — methods come from the initializer on every load.
      // `autoRevealGuards` is intentionally absent: it only bridges one live
      // merge to the canonical review projection in the current renderer.
      partialize: (s) => ({
        pending: s.pending,
        additions: s.additions,
        reviewBatches: s.reviewBatches,
        reviewOrder: s.reviewOrder,
        settledReviewIds: s.settledReviewIds,
      }),
    },
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
    if (batch.changes.length === 0) continue;
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
