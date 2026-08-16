import type { LibraryItem } from '../domain/library-item';
import type { DbTransaction } from '../lib/db';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { deleteEntityRelationsInTransaction } from './entity-relation-cleanup';
import type { AtomicSyncWriter } from './sync-helpers';
import {
  appendProjectAssetUnbindMutation,
  type SyncChangeBuilder,
} from '../sync/journal';

export interface LibraryItemDeletionReceipt {
  relationIds: string[];
}

/** Delete one library owner, its curated relations, and local asset metadata atomically. */
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

  return { relationIds };
}
