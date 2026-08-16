import { eq, inArray } from 'drizzle-orm';

import type { DbTransaction } from '../lib/db';
import { isProseEntityType, proseDocId } from '../lib/yjs-doc-id';
import {
  AgentRuntimeResultArtifactTable,
  AgentRuntimeResultBlobTable,
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteReviewTable,
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntitySnapshotHistoryTable,
  ProjectAssetTable,
  ProjectTable,
  StorylineTable,
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  YjsProseCommandReceiptTable,
  yjsSnapshots,
  yjsUpdates,
} from '../schema/drizzle';

const DELETE_BATCH_SIZE = 250;

interface ProjectDeletionInventory {
  proseDocIds: string[];
  agentReviewIds: string[];
  assetIds: string[];
  resultBlobHashes: string[];
}

export interface ProjectDeletionReceipt {
  proseDocIds: string[];
  agentReviewIds: string[];
  assetIds: string[];
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += DELETE_BATCH_SIZE) {
    result.push(values.slice(offset, offset + DELETE_BATCH_SIZE));
  }
  return result;
}

function addProseDocId(
  docIds: Set<string>,
  entityKind: string,
  entityId: string,
): void {
  if (!isProseEntityType(entityKind)) return;
  docIds.add(proseDocId(entityKind, entityId));
}

async function collectProjectDeletionInventory(
  tx: DbTransaction,
  projectId: string,
): Promise<ProjectDeletionInventory> {
  const docIds = new Set<string>();

  const nodes = await tx
    .select({ id: BookNodeTable.id })
    .from(BookNodeTable)
    .where(eq(BookNodeTable.projectId, projectId));
  for (const row of nodes) addProseDocId(docIds, 'node', row.id);

  const elements = await tx
    .select({ id: BookElementTable.id })
    .from(BookElementTable)
    .where(eq(BookElementTable.projectId, projectId));
  for (const row of elements) addProseDocId(docIds, 'element', row.id);

  const storylines = await tx
    .select({ id: StorylineTable.id })
    .from(StorylineTable)
    .where(eq(StorylineTable.projectId, projectId));
  for (const row of storylines) addProseDocId(docIds, 'storyline', row.id);

  const categories = await tx
    .select({ id: ElementCategoryTable.id })
    .from(ElementCategoryTable)
    .where(eq(ElementCategoryTable.projectId, projectId));
  for (const row of categories) addProseDocId(docIds, 'category', row.id);

  // History is also durable ownership evidence for a prose entity that was
  // hard-deleted before its project. It lets project deletion collect that
  // document without guessing from an unscoped Yjs prefix.
  const historicalEntities = await tx
    .select({
      entityKind: EntitySnapshotHistoryTable.entityKind,
      entityId: EntitySnapshotHistoryTable.entityId,
    })
    .from(EntitySnapshotHistoryTable)
    .where(eq(EntitySnapshotHistoryTable.projectId, projectId));
  for (const row of historicalEntities) {
    addProseDocId(docIds, row.entityKind, row.entityId);
  }

  const resultArtifacts = await tx
    .select({ contentHash: AgentRuntimeResultArtifactTable.contentHash })
    .from(AgentRuntimeResultArtifactTable)
    .where(eq(AgentRuntimeResultArtifactTable.projectId, projectId));

  // Do not use ProjectAssetRepository.findAll(): it intentionally hides
  // soft-deleted rows, but their app-owned directories still need cleanup.
  const assets = await tx
    .select({ id: ProjectAssetTable.id })
    .from(ProjectAssetTable)
    .where(eq(ProjectAssetTable.projectId, projectId));

  const agentReviews = await tx
    .select({ id: AgentRuntimeWriteReviewTable.id })
    .from(AgentRuntimeWriteReviewTable)
    .innerJoin(
      AgentRuntimeWriteEffectTable,
      eq(AgentRuntimeWriteReviewTable.effectId, AgentRuntimeWriteEffectTable.id),
    )
    .where(eq(AgentRuntimeWriteEffectTable.projectId, projectId));

  return {
    proseDocIds: [...docIds],
    agentReviewIds: agentReviews.map((row) => row.id),
    assetIds: assets.map((row) => row.id),
    resultBlobHashes: [...new Set(resultArtifacts.map((row) => row.contentHash))],
  };
}

async function deleteProjectProseState(
  tx: DbTransaction,
  projectId: string,
  docIds: readonly string[],
): Promise<void> {
  // This table has an explicit project id but intentionally no FK. Delete it
  // before the project row so rollback covers history and authored data alike.
  await tx
    .delete(EntitySnapshotHistoryTable)
    .where(eq(EntitySnapshotHistoryTable.projectId, projectId));

  for (const docIdBatch of batches(docIds)) {
    await tx
      .delete(YjsProseCommandReceiptTable)
      .where(inArray(YjsProseCommandReceiptTable.docId, docIdBatch));
    await tx
      .delete(YjsDocumentRevisionProvenanceTable)
      .where(inArray(YjsDocumentRevisionProvenanceTable.docId, docIdBatch));
    await tx
      .delete(YjsDocumentRevisionTable)
      .where(inArray(YjsDocumentRevisionTable.docId, docIdBatch));
    await tx.delete(yjsUpdates).where(inArray(yjsUpdates.docId, docIdBatch));
    await tx.delete(yjsSnapshots).where(inArray(yjsSnapshots.docId, docIdBatch));
  }
}

async function deleteUnreferencedResultBlobs(
  tx: DbTransaction,
  candidateHashes: readonly string[],
): Promise<void> {
  for (const hashBatch of batches(candidateHashes)) {
    const remainingReferences = await tx
      .selectDistinct({ contentHash: AgentRuntimeResultArtifactTable.contentHash })
      .from(AgentRuntimeResultArtifactTable)
      .where(inArray(AgentRuntimeResultArtifactTable.contentHash, hashBatch));
    const referencedHashes = new Set(remainingReferences.map((row) => row.contentHash));
    const orphanedHashes = hashBatch.filter((hash) => !referencedHashes.has(hash));
    if (orphanedHashes.length > 0) {
      await tx
        .delete(AgentRuntimeResultBlobTable)
        .where(inArray(AgentRuntimeResultBlobTable.contentHash, orphanedHashes));
    }
  }
}

/**
 * Delete one project and every SQLite row whose ownership can be proven to be
 * that project. The caller must persist the terminal SyncGeneration/domain change-set on
 * this same transaction after this function returns a receipt.
 *
 * The project FK tree owns normal entities, local asset metadata, and the
 * complete Agent runtime/session/review/task/memory tree. Detached Yjs/history
 * rows are removed explicitly before the project row; content-addressed result
 * blobs are removed afterwards only when no surviving project artifact still
 * references them. Provider-neutral SyncGeneration logs and purge receipts deliberately
 * survive project-row deletion and are not touched here.
 */
export async function deleteProjectDataInTransaction(
  tx: DbTransaction,
  projectId: string,
): Promise<ProjectDeletionReceipt | null> {
  const existing = await tx
    .select({ id: ProjectTable.id })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, projectId))
    .limit(1);
  if (!existing[0]) return null;

  const inventory = await collectProjectDeletionInventory(tx, projectId);
  await deleteProjectProseState(tx, projectId, inventory.proseDocIds);

  const deleted = await tx
    .delete(ProjectTable)
    .where(eq(ProjectTable.id, projectId))
    .returning({ id: ProjectTable.id });
  if (!deleted[0]) {
    throw new Error(`Project ${projectId} disappeared during transactional deletion.`);
  }

  await deleteUnreferencedResultBlobs(tx, inventory.resultBlobHashes);
  return {
    proseDocIds: inventory.proseDocIds,
    agentReviewIds: inventory.agentReviewIds,
    assetIds: inventory.assetIds,
  };
}
