import type { AgentBlockChange } from '../../lib/agent/block-diff';

export interface AgentEditRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function cssColorAlpha(color: string): number {
  const normalized = color.trim().toLowerCase();
  if (!normalized || normalized === 'transparent') return 0;

  // Modern computed colors may use a slash (`rgb(0 0 0 / 0.5)`), while older
  // WebKit returns legacy comma-separated rgba(). Values without an explicit
  // alpha channel are opaque.
  const slashAlpha = normalized.match(/\/\s*([\d.]+)%?\s*\)$/);
  if (slashAlpha) {
    const value = Number(slashAlpha[1]);
    return slashAlpha[0].includes('%') ? value / 100 : value;
  }
  const legacy = normalized.match(/^rgba?\((.*)\)$/);
  if (legacy) {
    const parts = legacy[1].split(',').map((part) => part.trim());
    if (parts.length === 4) {
      const value = Number.parseFloat(parts[3]);
      return Number.isFinite(value) ? value : 1;
    }
  }
  return 1;
}

/**
 * Pick a genuinely opaque backdrop for a reveal overlay. Editor surfaces are
 * allowed to be transparent (for example the flat continuous-page treatment),
 * but using that transparent value on the overlay exposes the already-written
 * live prose underneath and makes the typewriter look like a duplicate pass.
 */
export function agentEditOpaqueBackground(
  candidates: readonly string[],
  fallback = '#fff',
): string {
  return candidates.find((color) => cssColorAlpha(color) >= 0.999) ?? fallback;
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
