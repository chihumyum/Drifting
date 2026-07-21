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
import { encodeBlockHashes, encodeBlockIds, type BlockSection } from '../domain/block-section';
import { withAtomicSyncTransaction } from './sync-helpers';

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

export async function createElementPatchWithSync(input: CreatePatchInput): Promise<ElementPatch> {
  return withAtomicSyncTransaction(input.projectId, async (tx, sync) => {
    const created = await createElementPatchRepository(tx).create(input);
    await sync('elementPatch', 'create', created.id, input.projectId, elementPatchPayload(created));
    return created;
  });
}

export async function updateElementPatchWithSync(
  projectId: string,
  id: string,
  updates: UpdatePatchInput,
): Promise<ElementPatch | null> {
  return withAtomicSyncTransaction(projectId, async (tx, sync) => {
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

export async function deleteElementPatchWithSync(projectId: string, id: string): Promise<void> {
  await withAtomicSyncTransaction(projectId, async (tx, sync) => {
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
