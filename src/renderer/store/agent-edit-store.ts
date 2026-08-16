/**
 * General Agent prose-edit presentation state (#3 / #4).
 *
 * General Agent prose writes enter this store only after their Yjs mutation,
 * durable effect result, and canonical SQLite review have committed. The store
 * is therefore a rebuildable editor projection, never review authority or prose
 * truth. It remembers per entity which blocks changed and their before/after
 * text, so the editor can:
 *   - auto mode:    show colored scrollbar ticks (new/changed/deleted) and play a
 *                   per-block reveal animation when the block scrolls into view;
 *                   the tick + the panel "M" clear only once that animation runs.
 *   - approve mode: show inline accept/reject controls; approving plays the same
 *                   animation, rejecting undoes the block via Yjs.
 *
 * Keyed `${entityType}:${id}` like the activity store.
 *
 * PERSISTED to localStorage so pending editor presentation survives a reload.
 * The v1 migration retires batches from the previously removed review protocol;
 * SQLite reconciliation remains authoritative for all new durable batches.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { mergeBlockChanges, type AgentBlockChange, type AgentFieldRef } from '../lib/agent/block-diff';
import { parseDocId } from '../lib/yjs-doc-id';

export type AgentEditMode = 'auto' | 'approve';

export interface PendingEntityEdits {
  entityType: ActivityEntityType;
  id: string;
  /** Outstanding (not-yet-revealed / not-yet-approved) block changes, merged.
   *  Each change carries its OWN `mode` (stamped at record time), so flipping the
   *  global toggle only governs future edits — see {@link AgentBlockChange.mode}. */
  changes: AgentBlockChange[];
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
  /**
   * Exact per-effect diff, before cross-effect visual merging. Durable review
   * settlement must consume these batches in reverse reviewOrder and call the
   * Agent runtime's guarded inverse; it must never locally replay old text.
   */
  changes: AgentBlockChange[];
  /** Per-block author decisions made before the effect-level review settles.
   * The original changes stay intact for audit/retry; visual projection only
   * includes blocks not present in this map. */
  blockDecisions?: Record<string, AgentBlockReviewDecision>;
}

export type AgentBlockReviewDecision = 'accepted' | 'reverted';

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
  /** Durable General Agent owner. Missing only for legacy/manual staging. */
  sessionId?: string;
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
  /** entityKey → Agent-created prose entity awaiting its first full reveal. */
  additions: Record<string, AgentAddedEntity>;
  /** reviewId → blocks masked immediately before a committed live Yjs merge. */
  autoRevealGuards: Record<string, AgentAutoRevealGuard>;
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
   * Existing durable review blocks win on overlap so an Added presentation can
   * never downgrade or silently accept a later approve-mode edit.
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
  /** Replace the rebuildable local block projection with SQLite authority. */
  syncReviewBlockDecisions: (
    reviewId: string,
    decisions: Readonly<Record<string, AgentBlockReviewDecision>>,
  ) => void;
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
  /** Take queued reverts belonging to this exact Agent session. Legacy rows
   * without an owner are delivered only when sessionId is absent. */
  drainReverts: (projectId: string, sessionId?: string | null) => RevertRecord[];
  /** Drop an entity's whole pending set (e.g. the user dismissed it). */
  clear: (entityType: ActivityEntityType, id: string) => void;
  /** Remove every persisted presentation/revert receipt owned by a deleted project. */
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
          get().clearAutoRevealGuard(provenance.reviewId);
          return false;
        }
        const key = entityKey(entityType, id);
        const stamped = changes.map((change) => ({
          ...change,
          mode,
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
                ...provenance,
                entityType,
                id,
                changes: stamped,
                blockDecisions: {},
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
        const seeded = changes
          .filter((change) => !occupied.has(change.blockId))
          .map((change) => ({ ...change, mode: 'auto' as const }));
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

      syncReviewBlockDecisions: (reviewId, decisions) => {
        set((state) => {
          const batch = state.reviewBatches[reviewId];
          if (!batch) return state;
          const known = new Set(batch.changes.map((change) => change.blockId));
          const canonical = Object.fromEntries(
            Object.entries(decisions).filter(
              ([blockId, decision]) =>
                known.has(blockId) &&
                (decision === 'accepted' || decision === 'reverted'),
            ),
          ) as Record<string, AgentBlockReviewDecision>;
          if (
            JSON.stringify(batch.blockDecisions ?? {}) ===
            JSON.stringify(canonical)
          ) {
            return state;
          }
          const reviewBatches = {
            ...state.reviewBatches,
            [reviewId]: {
              ...batch,
              blockDecisions: canonical,
            },
          };
          return {
            reviewBatches,
            pending: rebuildVisualPending(
              state.pending,
              reviewBatches,
              state.reviewOrder,
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
        const sessionId = agentSessionIdFromEffectId(change.effectId);
        set((s) => ({
          pendingReverts: [
            ...s.pendingReverts,
            {
              projectId,
              ...(sessionId ? { sessionId } : {}),
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

      drainReverts: (projectId, sessionId = null) => {
        const all = get().pendingReverts;
        const owns = (record: RevertRecord): boolean =>
          record.projectId === projectId &&
          (sessionId ? record.sessionId === sessionId : !record.sessionId);
        const mine = all.filter(owns);
        if (mine.length) set({ pendingReverts: all.filter((record) => !owns(record)) });
        return mine;
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

      clearProject: (projectId, proseDocIds, reviewIds) => {
        const projectEntityKeys = new Set<string>();
        for (const docId of proseDocIds) {
          const parsed = parseDocId(docId);
          if (!parsed) continue;
          const entityType: ActivityEntityType =
            parsed.kind === 'node-content' ? 'node' : parsed.kind;
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
            pendingReverts: state.pendingReverts.filter(
              (record) => record.projectId !== projectId,
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
          pendingReverts: [],
          reviewBatches: {},
          reviewOrder: [],
          settledReviewIds: {},
        }),
    }),
    {
      name: 'agent-edit-pending',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      migrate: (persistedState, version) =>
        version < 1
          ? retireLegacyAgentReviewPersistence(persistedState)
          : persistedState,
      // Only the data — methods come from the initializer on every load. Reverts
      // persist too, so a reject survives a reload before the next turn drains it.
      // `autoRevealGuards` is intentionally absent: it only bridges one live
      // merge to the canonical review projection in the current renderer.
      partialize: (s) => ({
        pending: s.pending,
        additions: s.additions,
        pendingReverts: s.pendingReverts,
        reviewBatches: s.reviewBatches,
        reviewOrder: s.reviewOrder,
        settledReviewIds: s.settledReviewIds,
      }),
    },
  ),
);

function agentSessionIdFromEffectId(effectId: string | undefined): string | null {
  const prefix = 'agent-write:';
  if (!effectId?.startsWith(prefix)) return null;
  const separator = effectId.indexOf(':', prefix.length);
  if (separator <= prefix.length) return null;
  return effectId.slice(prefix.length, separator);
}

/**
 * Retire review batches created by the superseded pre-v1 protocol at hydration
 * time. Changes without a reviewId belong to legacy local staging and remain.
 * Retired ids are remembered so a delayed old receipt cannot recreate them.
 */
export function retireLegacyAgentReviewPersistence(
  persistedState: unknown,
): unknown {
  if (!isRecord(persistedState)) return persistedState;

  const state = persistedState as Partial<
    Pick<
      AgentEditState,
      | 'pending'
      | 'pendingReverts'
      | 'reviewBatches'
      | 'reviewOrder'
      | 'settledReviewIds'
    >
  >;
  const retiredReviewIds = new Set<string>();

  if (Array.isArray(state.reviewOrder)) {
    for (const reviewId of state.reviewOrder) {
      if (typeof reviewId === 'string' && reviewId.length > 0) {
        retiredReviewIds.add(reviewId);
      }
    }
  }
  if (isRecord(state.reviewBatches)) {
    for (const [reviewId, rawBatch] of Object.entries(state.reviewBatches)) {
      if (reviewId.length > 0) retiredReviewIds.add(reviewId);
      if (
        isRecord(rawBatch) &&
        typeof rawBatch.reviewId === 'string' &&
        rawBatch.reviewId.length > 0
      ) {
        retiredReviewIds.add(rawBatch.reviewId);
      }
    }
  }

  const pending: Record<string, PendingEntityEdits> = {};
  if (isRecord(state.pending)) {
    for (const [key, rawEntry] of Object.entries(state.pending)) {
      if (!isRecord(rawEntry) || !Array.isArray(rawEntry.changes)) continue;
      const changes = rawEntry.changes.filter((rawChange): rawChange is AgentBlockChange => {
        if (!isRecord(rawChange)) return false;
        if (typeof rawChange.reviewId === 'string' && rawChange.reviewId.length > 0) {
          retiredReviewIds.add(rawChange.reviewId);
          return false;
        }
        return true;
      });
      if (
        changes.length > 0 &&
        typeof rawEntry.entityType === 'string' &&
        typeof rawEntry.id === 'string'
      ) {
        pending[key] = {
          entityType: rawEntry.entityType as ActivityEntityType,
          id: rawEntry.id,
          changes,
        };
      }
    }
  }

  const settledReviewIds: Record<string, true> = {};
  if (isRecord(state.settledReviewIds)) {
    for (const [reviewId, settled] of Object.entries(state.settledReviewIds)) {
      if (settled === true) settledReviewIds[reviewId] = true;
    }
  }
  for (const reviewId of retiredReviewIds) {
    settledReviewIds[reviewId] = true;
  }

  return {
    ...state,
    pending,
    reviewBatches: {},
    reviewOrder: [],
    settledReviewIds,
  };
}

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
    const unresolved = batch.changes.filter(
      (change) => !batch.blockDecisions?.[change.blockId],
    );
    if (unresolved.length === 0) continue;
    rebuilt[key] = {
      entityType: batch.entityType,
      id: batch.id,
      changes: previousEntry
        ? mergeBlockChanges(previousEntry.changes, unresolved)
        : [...unresolved],
    };
  }
  return rebuilt;
}
