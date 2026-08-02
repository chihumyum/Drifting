import type { AgentBlockChange } from '../../lib/agent/block-diff';

/** Stable per-review identity so two accepted batches touching one block both animate. */
export function agentEditAnimationKey(change: AgentBlockChange): string {
  return `${change.reviewId ?? 'legacy'}:${change.op}:${change.blockId}`;
}

/** The visible mutation produced by rejecting an already-applied Agent change. */
export function inverseAgentEditReveal(
  change: AgentBlockChange,
): AgentBlockChange {
  if (change.op === 'new') {
    return {
      ...change,
      op: 'deleted',
      oldText: change.newText,
      newText: '',
    };
  }
  if (change.op === 'deleted') {
    return {
      ...change,
      op: 'new',
      oldText: '',
      newText: change.oldText,
    };
  }
  return {
    ...change,
    oldText: change.newText,
    newText: change.oldText,
  };
}

export function bulkAgentEditRevealChanges(
  changes: readonly AgentBlockChange[],
  decision: 'accepted' | 'reverted',
): AgentBlockChange[] {
  return decision === 'accepted'
    ? [...changes]
    : changes.map(inverseAgentEditReveal);
}
