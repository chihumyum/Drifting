import type { useAgentEditStore, AgentAutoRevealGuard } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import type { ProseEntityType } from '../../lib/yjs-doc-id';
import type { AgentBlockChange } from '../../lib/agent/block-diff';
import { agentChangeUsesAutoRevealMask, planAgentAutoRevealMask } from '../../lib/extensions/agent-diff-decoration';

export type AgentDecorationSnapshot = Pick<ReturnType<typeof useAgentEditStore.getState>,
  'pending' | 'additions' | 'autoRevealGuards'>;

export interface AgentDecorationProjection {
  approveChanges: AgentBlockChange[];
  autoRevealBlockIds: string[] | null | undefined;
}

const noGuards: readonly AgentAutoRevealGuard[] = [];
const guardsByEntity = new WeakMap<AgentDecorationSnapshot['autoRevealGuards'], ReadonlyMap<string, readonly AgentAutoRevealGuard[]>>();

function selectGuards(state: AgentDecorationSnapshot, key: string): readonly AgentAutoRevealGuard[] {
  let index = guardsByEntity.get(state.autoRevealGuards);
  if (!index) {
    const next = new Map<string, AgentAutoRevealGuard[]>();
    for (const guard of Object.values(state.autoRevealGuards)) {
      const guardKey = entityKey(guard.entityType, guard.id);
      const entries = next.get(guardKey) ?? [];
      entries.push(guard);
      next.set(guardKey, entries);
    }
    index = next;
    guardsByEntity.set(state.autoRevealGuards, index);
  }
  return index.get(key) ?? noGuards;
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => item === right[index]));
}

/** Per-editor semantic selection; unrelated reviews and non-prose fields stay out. */
export function createAgentDecorationSelector(entityType: ProseEntityType, id: string) {
  const key = entityKey(entityType, id);
  let previousChanges: readonly AgentBlockChange[] = [];
  let previousGuards: readonly AgentAutoRevealGuard[] = noGuards;
  let previousMaskAll = false;
  let projection: AgentDecorationProjection = { approveChanges: [], autoRevealBlockIds: undefined };
  let pending: AgentDecorationSnapshot['pending'][string] | undefined;
  let relevantChanges: AgentBlockChange[] = [];
  return (state: AgentDecorationSnapshot): AgentDecorationProjection => {
    if (pending !== state.pending[key]) {
      pending = state.pending[key];
      relevantChanges = (pending?.changes ?? []).filter((change) =>
        !change.field && ((change.mode ?? 'approve') === 'approve' || agentChangeUsesAutoRevealMask(change)),
      );
    }
    const guards = selectGuards(state, key);
    const maskAll = state.additions[key]?.revealBlockIds === null;
    if (sameItems(previousChanges, relevantChanges) && sameItems(previousGuards, guards) && previousMaskAll === maskAll) return projection;
    previousChanges = relevantChanges;
    previousGuards = guards;
    previousMaskAll = maskAll;
    projection = {
      approveChanges: relevantChanges.filter((change) => (change.mode ?? 'approve') === 'approve'),
      autoRevealBlockIds: planAgentAutoRevealMask(relevantChanges, maskAll, guards.flatMap((guard) => guard.blockIds)),
    };
    return projection;
  };
}
