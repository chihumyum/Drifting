import type { DbTransaction } from '../lib/db';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo.ts';
import type { SyncChangeBuilder } from '../sync/journal';
import { appendAuthoredNodeStorylinePurgeInTransaction } from '../sync/journal/storyline-membership';
import { deleteEntityRelationsInTransaction } from './entity-relation-cleanup';
import { withAtomicSyncTransaction, type AtomicSyncWriter } from './sync-helpers';

/**
 * Delete a chapter or idea for good inside one authored transaction: its
 * curated relations, its row (node_content and plot grid cascade), a
 * chapter's storyline memberships, and the node's purge. Shared by the trash's
 * permanent delete and the hard-delete fallback of libraries without Trash.
 */
export async function deleteNodeForGoodInTransaction(
  tx: DbTransaction,
  sync: AtomicSyncWriter,
  changes: SyncChangeBuilder,
  input: { readonly projectId: string; readonly nodeId: string },
): Promise<boolean> {
  const { projectId, nodeId } = input;
  await deleteEntityRelationsInTransaction(tx, sync, projectId, 'node', nodeId);
  const repository = createBookNodeSqliteRepository(projectId, tx);
  const existing = await repository.findById(nodeId);
  const deleted = await repository.delete(nodeId);
  if (existing?.kind === 'chapter') {
    await appendAuthoredNodeStorylinePurgeInTransaction(tx, changes, { projectId, nodeId });
  }
  await sync('node', 'delete', nodeId, projectId);
  return deleted;
}

/** The trash's 「立刻删除」 / 「清空回收站」 for one trashed chapter or idea. */
export function purgeTrashedNode(projectId: string, nodeId: string): Promise<boolean> {
  return withAtomicSyncTransaction(projectId, (tx, sync, changes) =>
    deleteNodeForGoodInTransaction(tx, sync, changes, { projectId, nodeId }),
  );
}
