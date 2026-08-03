import type { AgentBlockChange } from '../../lib/agent/block-diff';

export interface AgentAddedProseBlock {
  blockId: string;
  text: string;
}

/**
 * Turn the stable top-level blocks materialized by ProseMirror into the same
 * all-new diff shape used by ordinary Agent reveal animations. Blank blocks do
 * not need an animation, but still participate in predecessor anchoring so the
 * following textual block keeps its real document position.
 */
export function planAgentAddedProseReveal(
  blocks: readonly AgentAddedProseBlock[],
): AgentBlockChange[] {
  const seen = new Set<string>();
  const changes: AgentBlockChange[] = [];
  let previousBlockId: string | null = null;

  for (const block of blocks) {
    const blockId = block.blockId.trim();
    if (!blockId || seen.has(blockId)) continue;
    seen.add(blockId);
    if (block.text.trim()) {
      changes.push({
        blockId,
        op: 'new',
        oldText: '',
        newText: block.text,
        afterPrevId: previousBlockId,
      });
    }
    previousBlockId = blockId;
  }

  return changes;
}
