/**
 * Agent activity perception (#17). Out-of-chat signal of what the agent is doing
 * so the user notices work happening in panels they aren't looking at.
 *
 * Two maps, keyed `${entityType}:${id}` (see tool-entity-ref):
 *   - active:  entities a tool is CURRENTLY touching → a pulse on their cell.
 *     Cleared when the turn ends.
 *   - touched: entities the agent WROTE/CREATED this run → a breathing dot that
 *     persists until the user opens that entity (or sends a new prompt).
 *
 * Fed by the app-owned chat journal consumer through the store composition; read
 * by the left panels (cell effects) and the left tab switcher (aggregate badge).
 */
import { create } from 'zustand';
import { toolEntityRefs, entityKey, type ToolEntityRef } from '../lib/agent/tool-entity-ref';
import { useAgentEditStore } from './agent-edit-store';

export interface ActivityMark {
  entityType: ToolEntityRef['entityType'];
  id: string;
  op: ToolEntityRef['op'];
}

/** Canonical owner of one activity signal. Tool call ids are provider-local and
 * therefore must never be used as a cross-session key on their own. */
export interface AgentActivityScope {
  sessionId: string;
  turnId: string;
}

/** A resolved set of change spots (block uuids materialized into a Set). */
interface SpotSet {
  summary: boolean;
  blocks: Set<string>;
  structural: boolean;
}

/**
 * A written/created entity, plus WHERE it changed (`spots`) and which of those
 * the user has since viewed (`seen`). The breathing dot ("M") auto-clears when
 * `seen` covers every `spot` — i.e. the user read each change in place — so the
 * dot reflects "unread agent changes," not merely "not yet clicked."
 */
export interface TouchedMark extends ActivityMark {
  spots: SpotSet;
  seen: SpotSet;
}

/** One spot the user just viewed, fed to markSpotSeen. */
export type SeenSpot = { summary: true } | { block: string } | { structural: true };

interface AgentActivityState {
  /** entityKey → mark, for tools running right now (pulse). */
  active: Record<string, ActivityMark>;
  /** entityKey → mark, for entities written/created this run (breathing dot). */
  touched: Record<string, TouchedMark>;

  onToolUse: (scope: AgentActivityScope, id: string, name: string, input: unknown) => void;
  onToolResult: (scope: AgentActivityScope, id: string, ok: boolean, text: string) => void;
  /** One turn finished — stop only its pulses (leave siblings + breathing dots). */
  onTurnEnd: (scope: AgentActivityScope) => void;
  /** The user viewed one changed spot — clears the dot once all spots are seen. */
  markSpotSeen: (entityType: ActivityMark['entityType'], id: string, spot: SeenSpot) => void;
  /** The user opened/looked at an entity — clear its breathing dot outright. */
  clearTouched: (entityType: ActivityMark['entityType'], id: string) => void;
  /** New prompt / fresh conversation — clear all markers. */
  clearAll: () => void;
}

const emptySpots = (): SpotSet => ({ summary: false, blocks: new Set(), structural: false });

/** Has every changed spot been viewed? (empty spots → nothing to read). */
function allSeen(spots: SpotSet, seen: SpotSet): boolean {
  if (spots.summary && !seen.summary) return false;
  if (spots.structural && !seen.structural) return false;
  for (const b of spots.blocks) if (!seen.blocks.has(b)) return false;
  return true;
}

// Pending tool calls by tool-use id, so onToolResult can recover the args (and,
// for create_*, read the new id out of the result). Module-level — not state.
const pending = new Map<
  string,
  { name: string; input: unknown; preflightRefs: ToolEntityRef[] }
>();
const pendingKeysByScope = new Map<string, Set<string>>();
const activeOwners = new Map<string, Map<string, ActivityMark>>();
const activeKeysByScope = new Map<string, Set<string>>();

function activityScopeKey(scope: AgentActivityScope): string {
  return `${scope.sessionId}\u0000${scope.turnId}`;
}

function scopedCallKey(scope: AgentActivityScope, callId: string): string {
  return `${activityScopeKey(scope)}\u0000${callId}`;
}

// Every tracked structural entity has a left-sidebar destination: nodes and
// elements have item rows; storylines and categories have group-header rows.
const hasCell = (_t: ActivityMark['entityType']): boolean => true;

function mergeRefs(...groups: readonly ToolEntityRef[][]): ToolEntityRef[] {
  const byKey = new Map<string, ToolEntityRef>();
  for (const group of groups) {
    for (const ref of group) byKey.set(entityKey(ref.entityType, ref.id), ref);
  }
  return [...byKey.values()];
}

export const useAgentActivityStore = create<AgentActivityState>((set) => ({
  active: {},
  touched: {},

  onToolUse: (scope, id, name, input) => {
    const ownerKey = activityScopeKey(scope);
    const callKey = scopedCallKey(scope, id);
    // Resolve targets before execution. Delete/update tools may remove or rename
    // the only state needed to identify their comment host or relation endpoints.
    const refs = toolEntityRefs(name, input);
    pending.set(callKey, { name, input, preflightRefs: refs });
    const pendingKeys = pendingKeysByScope.get(ownerKey) ?? new Set<string>();
    pendingKeys.add(callKey);
    pendingKeysByScope.set(ownerKey, pendingKeys);
    const activeKeys = activeKeysByScope.get(ownerKey) ?? new Set<string>();
    const marks: Record<string, ActivityMark> = {};
    for (const ref of refs) {
      if (!hasCell(ref.entityType)) continue;
      const key = entityKey(ref.entityType, ref.id);
      const mark = { entityType: ref.entityType, id: ref.id, op: ref.op };
      const owners = activeOwners.get(key) ?? new Map<string, ActivityMark>();
      owners.set(ownerKey, mark);
      activeOwners.set(key, owners);
      activeKeys.add(key);
      marks[key] = mark;
    }
    if (!Object.keys(marks).length) return;
    activeKeysByScope.set(ownerKey, activeKeys);
    set((s) => ({ active: { ...s.active, ...marks } }));
  },

  onToolResult: (scope, id, ok, text) => {
    const ownerKey = activityScopeKey(scope);
    const callKey = scopedCallKey(scope, id);
    const p = pending.get(callKey);
    pending.delete(callKey);
    const pendingKeys = pendingKeysByScope.get(ownerKey);
    pendingKeys?.delete(callKey);
    if (pendingKeys?.size === 0) pendingKeysByScope.delete(ownerKey);
    if (!p || !ok) return;
    const refs = mergeRefs(p.preflightRefs, toolEntityRefs(p.name, p.input, text));
    for (const ref of refs) {
      // Added is reserved for creation of the sidebar entity itself. Comment
      // and relation refs deliberately use op='write', so their hosts get M.
      if (ref.op === 'create') {
        useAgentEditStore.getState().recordAddition(ref.entityType, ref.id);
      }
      // Only successful writes/creates leave M; reads changed nothing and a
      // deleted sidebar entity has nowhere to display a marker.
      if (ref.op === 'read' || ref.op === 'delete' || !hasCell(ref.entityType)) continue;
      const key = entityKey(ref.entityType, ref.id);
      const incoming = ref.spots ?? { structural: true };
      set((s) => {
        const prev = s.touched[key];
        // Accumulate spots across the run (block A then B → both tracked); a fresh
        // entry starts with nothing seen.
        const spots: SpotSet = {
          summary: (prev?.spots.summary ?? false) || incoming.summary === true,
          blocks: new Set([...(prev?.spots.blocks ?? []), ...(incoming.blocks ?? [])]),
          structural: (prev?.spots.structural ?? false) || incoming.structural === true,
        };
        const mark: TouchedMark = {
          entityType: ref.entityType,
          id: ref.id,
          op: ref.op,
          spots,
          seen: prev?.seen ?? emptySpots(),
        };
        return { touched: { ...s.touched, [key]: mark } };
      });
    }
  },

  onTurnEnd: (scope) => {
    const ownerKey = activityScopeKey(scope);
    for (const callKey of pendingKeysByScope.get(ownerKey) ?? []) {
      pending.delete(callKey);
    }
    pendingKeysByScope.delete(ownerKey);
    const ownedKeys = activeKeysByScope.get(ownerKey);
    if (!ownedKeys?.size) return;
    activeKeysByScope.delete(ownerKey);
    set((s) => {
      const active = { ...s.active };
      let changed = false;
      for (const key of ownedKeys) {
        const owners = activeOwners.get(key);
        owners?.delete(ownerKey);
        if (!owners?.size) {
          activeOwners.delete(key);
          if (key in active) {
            delete active[key];
            changed = true;
          }
          continue;
        }
        const remainingOwners = [...owners.values()];
        const remaining = remainingOwners[remainingOwners.length - 1];
        if (remaining) {
          active[key] = remaining;
          changed = true;
        }
      }
      return changed ? { active } : s;
    });
  },

  markSpotSeen: (entityType, id, spot) => {
    const key = entityKey(entityType, id);
    set((s) => {
      const entry = s.touched[key];
      if (!entry) return s;
      const seen: SpotSet = {
        summary: entry.seen.summary || 'summary' in spot,
        blocks: 'block' in spot ? new Set([...entry.seen.blocks, spot.block]) : entry.seen.blocks,
        structural: entry.seen.structural || 'structural' in spot,
      };
      if (allSeen(entry.spots, seen)) {
        const next = { ...s.touched };
        delete next[key];
        return { touched: next };
      }
      return { touched: { ...s.touched, [key]: { ...entry, seen } } };
    });
  },

  clearTouched: (entityType, id) => {
    const key = entityKey(entityType, id);
    set((s) => {
      if (!(key in s.touched)) return s;
      const next = { ...s.touched };
      delete next[key];
      return { touched: next };
    });
  },

  clearAll: () => {
    pending.clear();
    pendingKeysByScope.clear();
    activeOwners.clear();
    activeKeysByScope.clear();
    set({ active: {}, touched: {} });
  },
}));
