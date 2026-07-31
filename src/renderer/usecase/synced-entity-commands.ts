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
import { encodeBlockHashes, encodeBlockIds, type BlockSection } from '../domain/block-section';
import { encodeAliases, type BookElement } from '../domain/book-element';
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
import { createCommentRepository } from '../sqlite-repo/comment-repo';
import {
  withAtomicSyncTransaction,
  type AtomicSyncWriter,
} from './sync-helpers';

export type EntityAtomicTransactionRunner = <T>(
  projectId: string,
  work: (tx: DbExecutor, sync: AtomicSyncWriter) => Promise<T>,
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
    orderKey: patch.orderKey,
  };
}

function elementPatchUpdatePayload(patch: ElementPatch): Record<string, unknown> {
  return {
    sourceNodeId: patch.sourceNodeId,
    sourceBlockId: patch.sourceBlockId,
    sourceBlockText: patch.sourceBlockText,
    textAnchorJson: patch.textAnchorJson,
    invalidatedAt: patch.invalidatedAt,
    title: patch.title,
    contentJson: patch.contentJson,
    orderKey: patch.orderKey,
  };
}

function blockSectionPayload(section: BlockSection): Record<string, unknown> {
  return {
    id: section.id,
    chapterId: section.chapterId,
    blockIdsJson: encodeBlockIds(section.blockIds),
    blockHashesJson: encodeBlockHashes(section.blockHashes),
    summary: section.summary,
    source: section.source,
  };
}

function blockSectionUpdatePayload(section: BlockSection): Record<string, unknown> {
  return {
    blockIdsJson: encodeBlockIds(section.blockIds),
    blockHashesJson: encodeBlockHashes(section.blockHashes),
    summary: section.summary,
    source: section.source,
  };
}

function elementUpdatePayload(element: BookElement): Record<string, unknown> {
  return {
    categoryId: element.categoryId,
    name: element.name,
    summary: element.summary,
    contentJson: element.contentJson,
    kvJson: element.kvJson,
    aliasesJson: encodeAliases(element.aliases),
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
    orderKey: storyline.orderKey,
    contentJson: storyline.contentJson,
    kvJson: storyline.kvJson,
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
  return runAtomic(projectId, async (tx, sync) => {
    const updated = await createBookElementSqliteRepository(
      projectId,
      tx,
    ).update(id, updates);
    if (!updated || updated.projectId !== projectId) {
      throw new Error(`Element ${id} not found in project ${projectId}`);
    }
    await sync(
      'element',
      'update',
      id,
      projectId,
      elementUpdatePayload(updated),
    );
    return updated;
  });
}

export async function updateStorylineWithSync(
  projectId: string,
  id: string,
  updates: UpdateStorylineInput,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<Storyline> {
  return runAtomic(projectId, async (tx, sync) => {
    const updated = await createStorylineRepository(
      projectId,
      tx,
    ).updateStoryline(id, updates);
    await sync(
      'storyline',
      'update',
      id,
      projectId,
      storylineUpdatePayload(updated),
    );
    return updated;
  });
}

export async function updateProjectWithSync(
  projectId: string,
  updates: ProjectUpdateData,
  runAtomic: EntityAtomicTransactionRunner = withAtomicSyncTransaction,
): Promise<Project> {
  return runAtomic(projectId, async (tx, sync) => {
    const updated = await createProjectRepository(undefined, tx).update(
      projectId,
      updates,
    );
    if (!updated) throw new Error(`Project ${projectId} not found`);
    await sync('project', 'update', projectId, projectId, {
      name: updated.name,
      summary: updated.summary,
      kvJson: updated.kvJson,
      storylineTemplateKvJson: updated.storylineTemplateKvJson,
    });
    return updated;
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
    await createCommentRepository(projectId, tx).delete(id);
    await sync('comment', 'delete', id, projectId);
  });
}

export async function createElementPatchWithSync(
  input: CreatePatchInput,
  runAtomic: ElementPatchAtomicTransactionRunner =
    withAtomicSyncTransaction,
): Promise<ElementPatch> {
  return runAtomic(input.projectId, async (tx, sync) => {
    const created = await createElementPatchRepository(tx).create(input);
    await sync('elementPatch', 'create', created.id, input.projectId, elementPatchPayload(created));
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
  return runAtomic(projectId, async (tx, sync) => {
    const updated = await createElementPatchRepository(tx).update(id, updates);
    if (updated) {
      await sync('elementPatch', 'update', id, projectId, elementPatchUpdatePayload(updated));
    }
    return updated;
  });
}

export async function updateElementPatchesWithSync(
  projectId: string,
  updates: Array<{ id: string; updates: UpdatePatchInput }>,
): Promise<ElementPatch[]> {
  return withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const repo = createElementPatchRepository(tx);
    const changed: ElementPatch[] = [];
    for (const item of updates) {
      const updated = await repo.update(item.id, item.updates);
      if (!updated) continue;
      changed.push(updated);
      await sync('elementPatch', 'update', item.id, projectId, elementPatchUpdatePayload(updated));
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
    await sync('elementPatch', 'delete', id, projectId);
  });
}

export async function createBlockSectionWithSync(
  input: CreateBlockSectionInput,
): Promise<BlockSection> {
  return withAtomicSyncTransaction(input.projectId, async (tx, sync) => {
    const created = await createBlockSectionRepository(tx).create(input);
    await sync('blockSection', 'create', created.id, input.projectId, blockSectionPayload(created));
    return created;
  });
}

export async function updateBlockSectionWithSync(
  projectId: string,
  id: string,
  updates: UpdateBlockSectionInput,
): Promise<BlockSection | null> {
  return withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const updated = await createBlockSectionRepository(tx).update(id, updates);
    if (updated) {
      await sync('blockSection', 'update', id, projectId, blockSectionUpdatePayload(updated));
    }
    return updated;
  });
}

export async function deleteBlockSectionsWithSync(
  projectId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const repo = createBlockSectionRepository(tx);
    for (const id of ids) {
      await repo.delete(id);
      await sync('blockSection', 'delete', id, projectId);
    }
  });
}

export async function replaceBlockSectionsWithSync(
  input: CreateBlockSectionInput,
  replacedIds: string[],
): Promise<BlockSection> {
  return withAtomicSyncTransaction(input.projectId, async (tx, sync) => {
    const repo = createBlockSectionRepository(tx);
    const created = await repo.create(input);
    await sync('blockSection', 'create', created.id, input.projectId, blockSectionPayload(created));
    for (const id of replacedIds) {
      await repo.delete(id);
      await sync('blockSection', 'delete', id, input.projectId);
    }
    return created;
  });
}
