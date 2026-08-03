import type { AgentBlockChange } from '../../lib/agent/block-diff';

export interface AgentEditRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Convert an anchor's viewport rect into the coordinate space of the scrolling
 * overlay host. Both the prose anchor and a nested host move in the same native
 * scroll transaction, so the returned coordinates stay stable while scrolling.
 * `scrollTop` / `scrollLeft` keep the fallback correct when the host is the
 * scroll container itself rather than its in-flow `.editor__spread` child.
 */
export function agentEditRectInScrollHost(
  anchor: AgentEditRect,
  host: Pick<AgentEditRect, 'top' | 'left'>,
  scrollTop = 0,
  scrollLeft = 0,
  clientTop = 0,
  clientLeft = 0,
): AgentEditRect {
  return {
    top: anchor.top - host.top + scrollTop - clientTop,
    left: anchor.left - host.left + scrollLeft - clientLeft,
    width: anchor.width,
    height: anchor.height,
  };
}

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
