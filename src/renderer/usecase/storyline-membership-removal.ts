import { eq, inArray } from 'drizzle-orm';

import type { DbExecutor } from '../lib/db';
import { NodeStorylineLinkTable } from '../schema/drizzle';
import type { SyncChangeBuilder } from '../sync/journal';
import { appendAuthoredNodeStorylineProjectionInTransaction } from '../sync/journal/storyline-membership';
import { compareUtf8Bytewise } from '../sync/protocol';

/**
 * Take every chapter off a storyline that is leaving the book. A chapter whose
 * primary it was loses its other storylines too (no automatic fallback). The
 * chapters come from SQLite, not the store, so one in the Trash is journaled
 * too instead of losing its link silently.
 */
export async function removeStorylineMembershipsInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: { readonly projectId: string; readonly storylineId: string },
): Promise<readonly string[]> {
  const links = await tx
    .select({ nodeId: NodeStorylineLinkTable.nodeId, isPrimary: NodeStorylineLinkTable.isPrimary })
    .from(NodeStorylineLinkTable)
    .where(eq(NodeStorylineLinkTable.storylineId, input.storylineId));
  const unaffiliated = [...new Set(links.filter((link) => link.isPrimary).map((link) => link.nodeId))];
  if (unaffiliated.length > 0) {
    await tx.delete(NodeStorylineLinkTable).where(inArray(NodeStorylineLinkTable.nodeId, unaffiliated));
  }
  await tx.delete(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.storylineId, input.storylineId));
  const affected = [...new Set(links.map((link) => link.nodeId))].sort(compareUtf8Bytewise);
  for (const nodeId of affected) {
    await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
      projectId: input.projectId,
      nodeId,
    });
  }
  return affected;
}
