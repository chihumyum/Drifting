import { docToBlocks } from './serialize';

export type AgentProseReviewMode = 'auto' | 'approve';

/**
 * Ordinary prose edits stay automatic. Escalate only deletion-heavy commands
 * whose effect is difficult to recover by eyeballing a short reveal: a large
 * fraction of a long document, almost all of a smaller document, or at least
 * half of a document's blocks. The write still lands through Yjs and remains
 * available to the Agent; this only keeps its exact durable inverse behind the
 * editor's existing per-block accept/reject surface.
 */
export function resolveAgentProseReviewMode(
  configuredMode: AgentProseReviewMode,
  beforeContentJson: string,
  afterContentJson: string,
): AgentProseReviewMode {
  if (configuredMode === 'approve') return 'approve';

  const before = docToBlocks(beforeContentJson).filter((block) => block.blockId);
  if (before.length === 0) return 'auto';
  const afterById = new Map(
    docToBlocks(afterContentJson)
      .filter((block) => block.blockId)
      .map((block) => [block.blockId!, block]),
  );
  const beforeChars = before.reduce(
    (total, block) => total + codePointLength(block.text),
    0,
  );
  let removedChars = 0;
  let deletedBlocks = 0;
  for (const block of before) {
    const after = afterById.get(block.blockId!);
    if (!after) {
      deletedBlocks += 1;
      removedChars += codePointLength(block.text);
      continue;
    }
    removedChars += Math.max(
      0,
      codePointLength(block.text) - codePointLength(after.text),
    );
  }
  if (removedChars === 0) return 'auto';

  const removedRatio = beforeChars > 0 ? removedChars / beforeChars : 0;
  const deletedBlockRatio = deletedBlocks / before.length;
  return (removedChars >= 2_000 && removedRatio >= 0.35) ||
    (removedChars >= 400 && removedRatio >= 0.8) ||
    (deletedBlocks >= 10 && deletedBlockRatio >= 0.5)
    ? 'approve'
    : 'auto';
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
