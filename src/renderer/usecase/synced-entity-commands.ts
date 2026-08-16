import {
  createElementPatchRepository,
  type CreatePatchInput,
  type ElementPatch,
  type UpdatePatchInput,
} from '../sqlite-repo/element-patch-repo';
import {
  createBlockSectionRepository,
  type CreateBlockSectionInput,
  type UpdateBlockSectionInput,
} from '../sqlite-repo/block-section-repo';
import type { DbExecutor } from '../lib/db';
import type { BlockSection } from '../domain/block-section';
import type { BookElement } from '../domain/book-element';
import type { Comment } from '../domain/comment';
import type { Project } from '../domain/project';
import type { Storyline } from '../domain/storyline';
import {
  createBookElementSqliteRepository,
  type ElementUpdateData,
} from '../sqlite-repo/element-repo';
import {
  createStorylineRepository,
  type UpdateStorylineInput,
} from '../sqlite-repo/storyline-repo';
import {
  createProjectRepository,
  type ProjectUpdateData,
} from '../sqlite-repo/project-repo';
import {
  createCommentActionRepository,
  createCommentRepository,
} from '../sqlite-repo/comment-repo';
import {
  withAtomicSyncTransaction,
  type AtomicSyncWriter,
} from './sync-helpers';
import {
  appendPlannedAuthoredOrderInTransaction,
  runDerivedTransaction,
  type SyncChangeBuilder,
} from '../sync/journal';
import {
  replaceElementAliasesInTransaction,
  replaceEntityKvEntriesInTransaction,
} from './normalized-kv-alias-authority';
import {
  appendAuthoredOrderRebalance,
  authoredOrderRebalanceEntries,
  entityIdsByNumericPlacement,
} from '../sync/journal/order-authority';

export type EntityAtomicTransactionRunner = <T>(
  projectId: string,
  work: (
    tx: DbExecutor,
    sync: AtomicSyncWriter,
    changes: SyncChangeBuilder,
  ) => Promise<T>,
) => Promise<T>;
export type ElementPatchAtomicTransactionRunner =
  EntityAtomicTransactionRunner;

function elementPatchPayload(patch: ElementPatch): Record<string, unknown> {
  return {
    id: patch.id,
    elementId: patch.elementId,
    sourceNodeId: patch.sourceNodeId,
    sourceBlockId: patch.sourceBlockId,
    sourceBlockText: patch.sourceBlockText,
    textAnchorJson: patch.textAnchorJson,
    invalidatedAt: patch.invalidatedAt,
    title: patch.title,
    contentJson: patch.contentJson,
  };
}

function elementPatchUpdatePayload(
  patch: ElementPatch,
  updates: UpdatePatchInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (updates.sourceNodeId !== undefined) payload.sourceNodeId = patch.sourceNodeId;
  if (updates.sourceBlockId !== undefined) payload.sourceBlockId = patch.sourceBlockId;
  if (updates.textAnchorJson !== undefined) payload.textAnchorJson = patch.textAnchorJson;
  if (updates.invalidatedAt !== undefined) payload.invalidatedAt = patch.invalidatedAt;
  if (updates.title !== undefined) payload.title = patch.title;
  if (updates.contentJson !== undefined) payload.contentJson = patch.contentJson;
  return payload;
}

function elementUpdatePayload(element: BookElement): Record<string, unknown> {
  return {
    categoryId: element.categoryId,
    name: element.name,
    summary: element.summary,
    groupName: element.groupName,
    portraitAssetId: element.portraitAssetId,
  };
}

function storylineUpdatePayload(
  storyline: Storyline,
): Record<string, unknown> {
  return {
    name: storyline.name,
    color: storyline.color,
    summary: storyline.summary,
    nodeContentTemplateJson: storyline.nodeContentTemplateJson,
  };
}

function commentPayload(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    kind: comment.kind,
    targetKind: comment.targetKind,
    targetId: comment.targetId,
    targetBlockId: comment.targetBlockId,
    anchorJson: comment.anchorJson,
    authorKind: comment.authorKind,
    authorId: comment.authorId,
    authorName: comment.authorName,
    bodyJson: comment.bodyJson,
    status: comment.status,
    priority: comment.priority,
    source: comment.source,
    metadataJson: comment.metadataJson,
    targetBlockIdsJson: comment.targetBlockIdsJson,
    resolvedAt: comment.resolvedAt,
  };
}

export async function updateElementWithSync(
  projectId: string,
  id: string,
  updates: ElementUpdateData,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<BookElement> {
  const projectionOnly =
    updates.contentJson !== undefined &&
    updates.kvJson === undefined &&
    updates.aliases === undefined &&
    Object.keys(updates).every(
      (field) => field === 'contentJson' || field === 'updatedAt',
    );
  if (projectionOnly) {
    if (runAtomic !== withAtomicSyncTransaction) {
      throw new Error('Projection-only element writes cannot use an authored transaction runner');
    }
    return runDerivedTransaction('prose.element-projection', async (tx) => {
      const updated = await createBookElementSqliteRepository(projectId, tx).update(id, updates);
      if (!updated || updated.projectId !== projectId) {
        throw new Error(`Element ${id} not found in project ${projectId}`);
      }
      return updated;
    });
  }
  return runAtomic(projectId, async (tx, sync, changes) => {
    const { kvJson, aliases, ...scalarUpdates } = updates;
    const updated = await createBookElementSqliteRepository(
      projectId,
      tx,
    ).update(id, scalarUpdates);
    if (!updated || updated.projectId !== projectId) {
      throw new Error(`Element ${id} not found in project ${projectId}`);
    }
    if (kvJson !== undefined) {
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        projectId,
        ownerKind: 'element',
        ownerId: id,
        namespace: 'facts',
        nextJson: kvJson,
      });
    }
    if (aliases !== undefined) {
      await replaceElementAliasesInTransaction(tx, changes, { projectId, elementId: id, aliases });
    }
    const persisted = (await createBookElementSqliteRepository(projectId, tx).findById(id))!;
    const payload = elementUpdatePayload(persisted);
    const authoredScalar = Object.keys(scalarUpdates).some(
      (key) => key !== 'updatedAt' && key !== 'contentJson',
    );
    if (authoredScalar) await sync('element', 'update', id, projectId, payload);
    return persisted;
  });
}

export async function updateStorylineWithSync(
  projectId: string,
  id: string,
  updates: UpdateStorylineInput,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<Storyline> {
  const projectionOnly =
    updates.contentJson !== undefined &&
    updates.kvJson === undefined &&
    updates.orderKey === undefined &&
    Object.keys(updates).every(
      (field) =>
        field === 'contentJson' ||
        field === 'updatedAt' ||
        field === 'projectId',
    );
  if (projectionOnly) {
    if (runAtomic !== withAtomicSyncTransaction) {
      throw new Error('Projection-only storyline writes cannot use an authored transaction runner');
    }
    return runDerivedTransaction('prose.storyline-projection', async (tx) => {
      await createStorylineRepository(projectId, tx).updateStoryline(id, updates);
      const persisted = await createStorylineRepository(projectId, tx).getStorylineById(id);
      if (!persisted) throw new Error(`Storyline ${id} not found in project ${projectId}`);
      return persisted;
    });
  }
  return runAtomic(projectId, async (tx, sync, changes) => {
    const { kvJson, orderKey, ...scalarUpdates } = updates;
    const repository = createStorylineRepository(projectId, tx);
    await repository.updateStoryline(id, {
      ...scalarUpdates,
      ...(orderKey === undefined ? {} : { orderKey }),
    });
    if (kvJson !== undefined) {
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        projectId,
        ownerKind: 'storyline',
        ownerId: id,
        namespace: 'facts',
        nextJson: kvJson,
      });
    }
    const persisted = (await repository.getStorylineById(id))!;
    const authoredScalar = Object.keys(scalarUpdates).some(
      (key) => key !== 'updatedAt' && key !== 'projectId' && key !== 'contentJson',
    );
    if (authoredScalar) {
      await sync('storyline', 'update', id, projectId, storylineUpdatePayload(persisted));
    }
    if (orderKey !== undefined) {
      await appendPlannedAuthoredOrderInTransaction(tx, changes, {
        projectId,
        listKind: 'storyline',
        scope: projectId,
        desiredEntityIds: entityIdsByNumericPlacement(
          (await repository.getStorylinesByProject()).map((entry) => ({
            entityId: entry.id,
            projection: entry.orderKey,
          })),
        ),
      });
    }
    return persisted;
  });
}

export async function updateProjectWithSync(
  projectId: string,
  updates: ProjectUpdateData,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<Project> {
  return runAtomic(projectId, async (tx, sync, changes) => {
    const { kvJson, storylineTemplateKvJson, ...scalarUpdates } = updates;
    const updated = await createProjectRepository(undefined, tx).update(
      projectId,
      scalarUpdates,
    );
    if (!updated) throw new Error(`Project ${projectId} not found`);
    if (kvJson !== undefined) {
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        projectId,
        ownerKind: 'project',
        ownerId: projectId,
        namespace: 'facts',
        nextJson: kvJson,
      });
    }
    if (storylineTemplateKvJson !== undefined) {
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        projectId,
        ownerKind: 'project',
        ownerId: projectId,
        namespace: 'storyline-template',
        nextJson: storylineTemplateKvJson,
      });
    }
    const persisted = (await createProjectRepository(undefined, tx).findById(projectId))!;
    const authoredScalar = Object.keys(scalarUpdates).some(
      (key) => key !== 'updatedAt' && key !== 'userId',
    );
    if (authoredScalar) {
      await sync('project', 'update', projectId, projectId, {
        name: persisted.name,
        summary: persisted.summary,
      });
    }
    return persisted;
  });
}

export async function createCommentWithSync(
  comment: Comment,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<Comment> {
  return runAtomic(comment.projectId, async (tx, sync) => {
    const created = await createCommentRepository(
      comment.projectId,
      tx,
    ).create(comment);
    await sync(
      'comment',
      'create',
      created.id,
      created.projectId,
      commentPayload(created),
    );
    return created;
  });
}

export async function deleteCommentWithSync(
  projectId: string,
  id: string,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<void> {
  await runAtomic(projectId, async (tx, sync) => {
    const actions = await createCommentActionRepository(projectId, tx).findByComment(id);
    await createCommentRepository(projectId, tx).delete(id);
    await sync('comment', 'softDelete', id, projectId);
    for (const action of actions) {
      await sync('commentAction', 'softDelete', action.id, projectId);
    }
  });
}

export async function createElementPatchWithSync(
  input: CreatePatchInput,
  runAtomic: ElementPatchAtomicTransactionRunner =
    withAtomicSyncTransaction,
): Promise<ElementPatch> {
  return runAtomic(input.projectId, async (tx, sync, changes) => {
    const repository = createElementPatchRepository(tx);
    const created = await repository.create(input);
    await sync('elementPatch', 'create', created.id, input.projectId, elementPatchPayload(created));
    await appendPlannedAuthoredOrderInTransaction(tx, changes, {
      projectId: input.projectId,
      listKind: 'element-patch',
      scope: created.elementId,
      desiredEntityIds: entityIdsByNumericPlacement(
        (await repository.listByElement(created.elementId)).map((entry) => ({
          entityId: entry.id,
          projection: entry.orderKey,
        })),
      ),
    });
    return created;
  });
}

export async function updateElementPatchWithSync(
  projectId: string,
  id: string,
  updates: UpdatePatchInput,
  runAtomic: ElementPatchAtomicTransactionRunner =
    withAtomicSyncTransaction,
): Promise<ElementPatch | null> {
  return runAtomic(projectId, async (tx, sync, changes) => {
    const repository = createElementPatchRepository(tx);
    const normalizedUpdates = updates;
    const updated = await repository.update(id, normalizedUpdates);
    if (updated) {
      const payload = elementPatchUpdatePayload(updated, normalizedUpdates);
      if (Object.keys(payload).length > 0) {
        await sync('elementPatch', 'update', id, projectId, payload);
      }
      if (updates.orderKey !== undefined) {
        await appendPlannedAuthoredOrderInTransaction(tx, changes, {
          projectId,
          listKind: 'element-patch',
          scope: updated.elementId,
          desiredEntityIds: entityIdsByNumericPlacement(
            (await repository.listByElement(updated.elementId)).map((entry) => ({
              entityId: entry.id,
              projection: entry.orderKey,
            })),
          ),
        });
      }
    }
    return updated;
  });
}

export async function updateElementPatchesWithSync(
  projectId: string,
  updates: Array<{ id: string; updates: UpdatePatchInput }>,
): Promise<ElementPatch[]> {
  return withAtomicSyncTransaction(projectId, async (tx, sync, changes) => {
    const repo = createElementPatchRepository(tx);
    const changed: ElementPatch[] = [];
    const reorderedElementIds = new Set<string>();
    for (const item of updates) {
      const normalizedUpdates = item.updates;
      const updated = await repo.update(item.id, normalizedUpdates);
      if (!updated) continue;
      changed.push(updated);
      const payload = elementPatchUpdatePayload(updated, normalizedUpdates);
      if (Object.keys(payload).length > 0) {
        await sync('elementPatch', 'update', item.id, projectId, payload);
      }
      if (item.updates.orderKey !== undefined) reorderedElementIds.add(updated.elementId);
    }
    for (const elementId of reorderedElementIds) {
      const desiredIds = entityIdsByNumericPlacement(
        (await repo.listByElement(elementId)).map((entry) => ({
          entityId: entry.id,
          projection: entry.orderKey,
        })),
      );
      appendAuthoredOrderRebalance(changes, {
        listKind: 'element-patch',
        scope: elementId,
        entries: authoredOrderRebalanceEntries(desiredIds),
      });
    }
    return changed;
  });
}

export async function deleteElementPatchWithSync(
  projectId: string,
  id: string,
  runAtomic: ElementPatchAtomicTransactionRunner =
    withAtomicSyncTransaction,
): Promise<void> {
  await runAtomic(projectId, async (tx, sync) => {
    await createElementPatchRepository(tx).delete(id);
    await sync('elementPatch', 'softDelete', id, projectId);
  });
}

export async function createBlockSectionWithSync(
  input: CreateBlockSectionInput,
): Promise<BlockSection> {
  return runDerivedTransaction('copilot.block-section-create', (tx) =>
    createBlockSectionRepository(tx).create(input),
  );
}

export async function updateBlockSectionWithSync(
  _projectId: string,
  id: string,
  updates: UpdateBlockSectionInput,
): Promise<BlockSection | null> {
  return runDerivedTransaction('copilot.block-section-update', (tx) =>
    createBlockSectionRepository(tx).update(id, updates),
  );
}

export async function deleteBlockSectionsWithSync(
  _projectId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await runDerivedTransaction('copilot.block-section-delete', async (tx) => {
    const repo = createBlockSectionRepository(tx);
    for (const id of ids) {
      await repo.delete(id);
    }
  });
}

export async function replaceBlockSectionsWithSync(
  input: CreateBlockSectionInput,
  replacedIds: string[],
): Promise<BlockSection> {
  return runDerivedTransaction('copilot.block-section-replace', async (tx) => {
    const repo = createBlockSectionRepository(tx);
    const created = await repo.create(input);
    for (const id of replacedIds) {
      await repo.delete(id);
    }
    return created;
  });
}
