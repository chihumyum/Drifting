import { loadActiveMemoryHints } from '../../../usecase/useAgentMemory';
import {
  prepareAgentWorkingMemoryForTurn,
  takeWorkingMemoryConsolidationNotice,
} from '../../../usecase/useAgentWorkingMemory';

/** Prepare context only while the submitting intent owns preparation. Existing
 * repository work may settle, but cannot start the next step or consume reviews.
 * Only a writable turn consumes a Working Memory consolidation notice. */
export async function prepareAgentChatMemories(
  projectId: string,
  isCurrent: () => boolean,
  options: { writable?: boolean } = {},
) {
  if (!isCurrent()) return null;
  const memories = await loadActiveMemoryHints(projectId).catch(() => []);
  if (!isCurrent()) return null;
  const workingMemory = await prepareAgentWorkingMemoryForTurn(projectId).catch(() => null);
  if (!isCurrent()) return null;
  if (!workingMemory) {
    return { memories, workingMemory: { contentMd: '', revision: 0, approxTokens: 0 } };
  }
  const consolidate =
    options.writable !== false &&
    takeWorkingMemoryConsolidationNotice(projectId, workingMemory.approxTokens);
  return {
    memories,
    workingMemory: {
      contentMd: workingMemory.contentMd,
      revision: workingMemory.revision,
      approxTokens: workingMemory.approxTokens,
      ...(consolidate ? { consolidate: true } : {}),
    },
  };
}
