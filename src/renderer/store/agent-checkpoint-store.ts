/**
 * Agent turn checkpoints — the "revert to snapshot" backbone.
 *
 * Every agent turn that writes anything gets one checkpoint, accumulating the
 * SAME merged AgentBlockChange[] the edit-review store tracks (prose blocks +
 * structured fields, with original oldText preserved across re-edits). Unlike
 * the edit store — whose entries clear as edits are revealed/approved — a
 * checkpoint survives approval, so the user can undo a whole turn (and every
 * turn after it) long after the per-block review ticks are gone.
 *
 * Reverting applies each change's INVERSE through the same Yjs/usecase paths a
 * per-block reject uses — see lib/agent/turn-revert.ts. Per-turn diffs compose:
 * applying inverses newest-turn-first walks the document state straight back to
 * the snapshot taken before the target turn ran.
 *
 * PERSISTED (localStorage): the agent's edits are durable, so the undo trail
 * for them must survive a reload too. `activeTurn` is session-only — a reload
 * kills any in-flight turn.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { entityKey, type ActivityEntityType } from '../lib/agent/tool-entity-ref';
import { mergeBlockChanges, type AgentBlockChange } from '../lib/agent/block-diff';

/** Checkpoints kept per project — oldest beyond this are dropped on insert. */
const MAX_CHECKPOINTS_PER_PROJECT = 30;

export interface CheckpointEntityEdits {
  entityType: ActivityEntityType;
  id: string;
  changes: AgentBlockChange[];
}

export interface TurnCheckpoint {
  turnId: string;
  convId: string;
  projectId: string;
  /** First words of the user prompt that started the turn — the row label. */
  label: string;
  /** Turn start, epoch ms — orders checkpoints and renders the row time. */
  ts: number;
  /** entityKey → everything the agent changed on that entity this turn. */
  entities: Record<string, CheckpointEntityEdits>;
}

interface ActiveTurn {
  turnId: string;
  convId: string;
  projectId: string;
  label: string;
}

interface AgentCheckpointState {
  /** All projects' checkpoints, chronological (oldest first). */
  checkpoints: TurnCheckpoint[];
  /** The in-flight turn writes are attributed to; null when idle. */
  activeTurn: ActiveTurn | null;

  /** A turn started — subsequent recordChanges calls land in its checkpoint. */
  beginTurn: (turn: ActiveTurn) => void;
  /** The turn finished — stop attributing; drop its checkpoint if it never wrote. */
  endTurn: (turnId: string) => void;
  /** Tee of agent-edit-store.record(): fold a write into the active turn. */
  recordChanges: (entityType: ActivityEntityType, id: string, changes: AgentBlockChange[]) => void;
  /** Reverted (or otherwise spent) checkpoints — drop them. */
  removeCheckpoints: (turnIds: string[]) => void;
}

export const useAgentCheckpointStore = create<AgentCheckpointState>()(
  persist(
    (set, get) => ({
      checkpoints: [],
      activeTurn: null,

      beginTurn: (turn) => set({ activeTurn: turn }),

      endTurn: (turnId) => {
        set((s) => ({
          activeTurn: s.activeTurn?.turnId === turnId ? null : s.activeTurn,
          // A turn that wrote nothing leaves no checkpoint behind.
          checkpoints: s.checkpoints.filter(
            (c) => c.turnId !== turnId || Object.keys(c.entities).length > 0,
          ),
        }));
      },

      recordChanges: (entityType, id, changes) => {
        const turn = get().activeTurn;
        if (!turn || changes.length === 0) return;
        const key = entityKey(entityType, id);
        set((s) => {
          const idx = s.checkpoints.findIndex((c) => c.turnId === turn.turnId);
          const cp: TurnCheckpoint =
            idx >= 0
              ? s.checkpoints[idx]
              : { ...turn, ts: Date.now(), entities: {} };
          const prev = cp.entities[key];
          const merged = prev ? mergeBlockChanges(prev.changes, changes) : changes;
          const entities = { ...cp.entities };
          if (merged.length === 0) delete entities[key];
          else entities[key] = { entityType, id, changes: merged };
          const nextCp = { ...cp, entities };

          let checkpoints =
            idx >= 0
              ? s.checkpoints.map((c, i) => (i === idx ? nextCp : c))
              : [...s.checkpoints, nextCp];
          // Cap per project (oldest first in the array → drop from the front).
          const mine = checkpoints.filter((c) => c.projectId === turn.projectId);
          if (mine.length > MAX_CHECKPOINTS_PER_PROJECT) {
            const drop = new Set(
              mine.slice(0, mine.length - MAX_CHECKPOINTS_PER_PROJECT).map((c) => c.turnId),
            );
            checkpoints = checkpoints.filter((c) => !drop.has(c.turnId));
          }
          return { checkpoints };
        });
      },

      removeCheckpoints: (turnIds) => {
        const drop = new Set(turnIds);
        set((s) => ({ checkpoints: s.checkpoints.filter((c) => !drop.has(c.turnId)) }));
      },
    }),
    {
      name: 'agent-turn-checkpoints',
      storage: createJSONStorage(() => localStorage),
      // activeTurn is deliberately not persisted — a reload kills the turn.
      partialize: (s) => ({ checkpoints: s.checkpoints }),
    },
  ),
);
