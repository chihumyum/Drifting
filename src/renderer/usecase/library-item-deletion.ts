import type { LibraryItem } from '../domain/library-item';
import type { DbTransaction } from '../lib/db';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { createCommentRepository } from '../sqlite-repo/comment-repo';
import { deleteEntityRelationsInTransaction } from './entity-relation-cleanup';
import type { AtomicSyncWriter } from './sync-helpers';
import {
  appendProjectAssetUnbindMutation,
  type SyncChangeBuilder,
} from '../sync/journal';

export interface LibraryItemDeletionReceipt {
  relationIds: string[];
  /** Region comments (and their relations) removed with an image or PDF. */
  commentIds: string[];
}

/**
 * Delete one library owner, its curated relations, the comments that target
 * it, and local asset metadata atomically. A comment left behind would point
 * at nothing and make checkpoint restore fail its target check.
 */
export async function deleteLibraryItemInTransaction(
  tx: DbTransaction,
  sync: AtomicSyncWriter,
  changes: SyncChangeBuilder,
  projectId: string,
  item: LibraryItem,
): Promise<LibraryItemDeletionReceipt> {
  if (item.projectId !== projectId) {
    throw new Error(`Library item ${item.id} does not belong to project ${projectId}`);
  }

  const relationIds = await deleteEntityRelationsInTransaction(
    tx,
    sync,
    projectId,
    'library_item',
    item.id,
  );
  const commentRepository = createCommentRepository(projectId, tx);
  const comments = (await commentRepository.findAll()).filter(
    (comment) => comment.targetKind === 'library_item' && comment.targetId === item.id,
  );
  for (const comment of comments) {
    relationIds.push(...(await deleteEntityRelationsInTransaction(tx, sync, projectId, 'comment', comment.id)));
    await commentRepository.delete(comment.id);
    await sync('comment', 'delete', comment.id, projectId);
  }
  const deleted = await createLibraryItemSqliteRepository(projectId, tx).delete(item.id);
  if (!deleted) throw new Error(`Library item with id ${item.id} not found`);

  if (item.kind === 'image' || item.kind === 'pdf') {
    appendProjectAssetUnbindMutation(changes, item.assetId, {
      kind: 'library-item',
      id: item.id,
    });
    const assetDeleted = await createProjectAssetSqliteRepository(projectId, tx).delete(
      item.assetId,
    );
    if (!assetDeleted) {
      throw new Error(`Library item ${item.id} is missing asset metadata ${item.assetId}`);
    }
  }
  await sync('libraryItem', 'delete', item.id, projectId);

  return { relationIds, commentIds: comments.map((comment) => comment.id) };
}
