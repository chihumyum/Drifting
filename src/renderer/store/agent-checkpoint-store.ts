/**
 * Agent turn checkpoints — the "revert to snapshot" backbone.
 *
 * Legacy Claude-SDK turns may get one checkpoint, accumulating the SAME merged
 * AgentBlockChange[] the edit-review store tracks (prose blocks + structured
 * fields, with original oldText preserved across re-edits).
 *
 * Provider-neutral runtime writes MUST NOT enter this legacy undo trail. Their
 * canonical authority is the durable write-effect/review ledger, whose inverse
 * is revision-guarded and whose settlement feeds long-task truth. Replaying
 * this older best-effort Yjs/usecase inverse after `accepted_effect` would
 * silently fork manuscript state from that ledger.
 *
 * PERSISTED (localStorage): the agent's edits are durable, so the undo trail
 * for explicitly legacy sessions survives a reload. `activeTurn` is
 * session-only — a reload kills any in-flight turn. Once a project starts a
 * provider-neutral turn, its legacy whole-turn trail is sealed fail-closed.
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
  /**
   * New checkpoints must opt in to the legacy SDK authority explicitly.
   * Historical rows have no marker and are authorized against the durable
   * conversation identity at revert time.
   */
  revertAuthority?: 'legacy-sdk';
  /** First words of the user prompt that started the turn — the row label. */
  label: string;
  /** Turn start, epoch ms — orders checkpoints and renders the row time. */
  ts: number;
  /** entityKey → everything the agent changed on that entity this turn. */
  entities: Record<string, CheckpointEntityEdits>;
}

export interface AgentCheckpointTurn {
  turnId: string;
  convId: string;
  projectId: string;
  label: string;
  /**
   * Omitted means provider-neutral runtime. This intentionally makes old/new
   * callers fail closed unless a legacy SDK path opts in by name.
   */
  revertAuthority?: 'legacy-sdk';
}

interface AgentCheckpointState {
  /** All projects' checkpoints, chronological (oldest first). */
  checkpoints: TurnCheckpoint[];
  /** The in-flight turn writes are attributed to; null when idle. */
  activeTurn: AgentCheckpointTurn | null;
  /**
   * First provider-neutral turn observed per project. Any such turn makes the
   * legacy inverse trail unsafe because later canonical writes are not part of
   * that trail.
   */
  providerNeutralProjectBarriers: Record<string, number>;

  /**
   * A turn started. Only an explicitly `legacy-sdk` turn becomes active;
   * provider-neutral turns seal the project and deliberately collect nothing.
   */
  beginTurn: (turn: AgentCheckpointTurn) => void;
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
      providerNeutralProjectBarriers: {},

      beginTurn: (turn) => {
        if (turn.revertAuthority === 'legacy-sdk') {
          set({ activeTurn: turn });
          return;
        }
        set((state) => ({
          activeTurn: null,
          providerNeutralProjectBarriers: state.providerNeutralProjectBarriers[turn.projectId]
            ? state.providerNeutralProjectBarriers
            : {
                ...state.providerNeutralProjectBarriers,
                [turn.projectId]: Date.now(),
              },
        }));
      },

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
      partialize: (s) => ({
        checkpoints: s.checkpoints,
        providerNeutralProjectBarriers: s.providerNeutralProjectBarriers,
      }),
    },
  ),
);
