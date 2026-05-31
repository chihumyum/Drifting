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
 * Fed from agent-chat-store.handleEvent (the one place agent events land); read
 * by the left panels (cell effects) and the left tab switcher (aggregate badge).
 */
import { create } from 'zustand';
import { toolEntityRef, entityKey, type ToolEntityRef } from '../lib/agent/tool-entity-ref';

export interface ActivityMark {
  entityType: ToolEntityRef['entityType'];
  id: string;
  op: ToolEntityRef['op'];
}

interface AgentActivityState {
  /** entityKey → mark, for tools running right now (pulse). */
  active: Record<string, ActivityMark>;
  /** entityKey → mark, for entities written/created this run (breathing dot). */
  touched: Record<string, ActivityMark>;

  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult: (id: string, ok: boolean, text: string) => void;
  /** A turn finished — stop all pulses (leave the breathing dots). */
  onTurnEnd: () => void;
  /** The user opened/looked at an entity — clear its breathing dot. */
  clearTouched: (entityType: ActivityMark['entityType'], id: string) => void;
  /** New prompt / fresh conversation — clear all markers. */
  clearAll: () => void;
}

// Pending tool calls by tool-use id, so onToolResult can recover the args (and,
// for create_*, read the new id out of the result). Module-level — not state.
const pending = new Map<string, { name: string; input: unknown }>();

export const useAgentActivityStore = create<AgentActivityState>((set) => ({
  active: {},
  touched: {},

  onToolUse: (id, name, input) => {
    pending.set(id, { name, input });
    const ref = toolEntityRef(name, input);
    if (!ref) return;
    const key = entityKey(ref.entityType, ref.id);
    set((s) => ({
      active: { ...s.active, [key]: { entityType: ref.entityType, id: ref.id, op: ref.op } },
    }));
  },

  onToolResult: (id, ok, text) => {
    const p = pending.get(id);
    pending.delete(id);
    if (!p || !ok) return;
    const ref = toolEntityRef(p.name, p.input, text);
    if (!ref || ref.op === 'read') return; // only writes/creates leave a dot
    const key = entityKey(ref.entityType, ref.id);
    set((s) => ({
      touched: { ...s.touched, [key]: { entityType: ref.entityType, id: ref.id, op: ref.op } },
    }));
  },

  onTurnEnd: () => {
    pending.clear();
    set((s) => (Object.keys(s.active).length ? { active: {} } : s));
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
    set({ active: {}, touched: {} });
  },
}));
