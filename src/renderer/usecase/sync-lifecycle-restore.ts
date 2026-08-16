import { and, eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';

import { decodeAliases } from '../domain/book-element';
import type { DbExecutor } from '../lib/db';
import { proseDocId, type ProseEntityType } from '../lib/yjs-doc-id';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  NodeContentTable,
  ProjectAssetTable,
  StorylineTable,
} from '../schema/drizzle';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import {
  appendAuthoredDomainMutation,
  appendPlannedAuthoredOrderInTransaction,
  appendAuthoredProseRestoreStateInTransaction,
  appendAuthoredNodeStorylineProjectionInTransaction,
  appendProjectAssetBindMutation,
  entityIdsByNumericPlacement,
  type AuthoredDomainEntityKind,
  type SyncChangeBuilder,
} from '../sync/journal';
import { replaceElementAliasesInTransaction } from './normalized-kv-alias-authority';

export type RestorableSyncEntityKind = Extract<
  AuthoredDomainEntityKind,
  'node' | 'storyline' | 'element' | 'elementCategory'
>;

function restoreMissing(kind: string, id: string): never {
  throw new Error(`Cannot restore ${kind}:${id}; the typed SQLite row does not exist`);
}

async function captureFullProseState(
  tx: DbExecutor,
  docId: string,
  seedContentJson: string,
): Promise<Uint8Array> {
  const repository = createYjsRepository(tx);
  const [snapshot, updates] = await Promise.all([
    repository.getSnapshot(docId),
    repository.listUpdates(docId),
  ]);
  if (!snapshot && updates.length === 0) {
    const { createYjsProseSeedState } = await import(
      '../lib/agent/runtime/yjs-prose-command'
    );
    return createYjsProseSeedState(seedContentJson);
  }

  const document = new Y.Doc();
  try {
    if (snapshot) Y.applyUpdate(document, snapshot.stateBlob, 'sync-restore:snapshot');
    for (const update of updates) {
      Y.applyUpdate(document, update.updateBlob, 'sync-restore:update');
    }
    return Y.encodeStateAsUpdate(document);
  } catch (error) {
    throw new Error(
      `Cannot capture restore Yjs state for ${docId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    document.destroy();
  }
}

async function appendFullProseRestore(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  entityType: ProseEntityType,
  entityId: string,
  seedContentJson: string,
): Promise<void> {
  const docId = proseDocId(entityType, entityId);
  await appendAuthoredProseRestoreStateInTransaction(tx, changes, {
    entityType,
    entityId,
    stateUpdate: await captureFullProseState(tx, docId, seedContentJson),
  });
}

async function appendNodeRestore(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  projectId: string,
  nodeId: string,
): Promise<void> {
  const [node] = await tx
    .select()
    .from(BookNodeTable)
    .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId)))
    .limit(1);
  if (!node) restoreMissing('node', nodeId);
  if (node.deletedAt !== null) {
    throw new Error(`Cannot journal node:${nodeId} restore before clearing deletedAt`);
  }
  const [content] = await tx
    .select({ contentJson: NodeContentTable.contentJson })
    .from(NodeContentTable)
    .where(eq(NodeContentTable.nodeId, nodeId))
    .limit(1);
  const contentJson = content?.contentJson ?? '{}';

  appendAuthoredDomainMutation(changes, {
    entityType: 'node',
    mutationType: 'restore',
    entityId: node.id,
    projectId,
    payload: {
      title: node.title,
      summary: node.summary,
      narrativeOrder: node.narrativeOrder,
      writingStatus: node.writingStatus,
      kind: node.kind,
      driftGroupId: node.driftGroupId,
    },
  });
  changes.add({
    action: 'tuple.set',
    target: { family: 'entity', kind: 'node', id: node.id, incarnation: 0 },
    payload: {
      tuple: 'graph.position',
      value: { x: node.positionX, y: node.positionY },
    },
  });
  if (node.kind === 'chapter') {
    if (node.bookOrder === null) {
      throw new Error(`Restored chapter ${node.id} is missing book order authority`);
    }
    await appendPlannedAuthoredOrderInTransaction(tx, changes, {
      projectId,
      listKind: 'chapter',
      scope: projectId,
      desiredEntityIds: entityIdsByNumericPlacement(
        (
          await tx
            .select({ id: BookNodeTable.id, bookOrder: BookNodeTable.bookOrder })
            .from(BookNodeTable)
            .where(and(eq(BookNodeTable.projectId, projectId), eq(BookNodeTable.kind, 'chapter'), isNull(BookNodeTable.deletedAt)))
        )
          .filter((entry): entry is { id: string; bookOrder: number } => entry.bookOrder !== null)
          .map((entry) => ({ entityId: entry.id, projection: entry.bookOrder })),
      ),
    });
    await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, {
      projectId,
      nodeId: node.id,
      forceReincarnation: true,
    });
  }
  await appendFullProseRestore(tx, changes, 'node', node.id, contentJson);
}

async function appendStorylineRestore(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  projectId: string,
  storylineId: string,
): Promise<void> {
  const [storyline] = await tx
    .select()
    .from(StorylineTable)
    .where(
      and(eq(StorylineTable.id, storylineId), eq(StorylineTable.projectId, projectId)),
    )
    .limit(1);
  if (!storyline) restoreMissing('storyline', storylineId);
  if (storyline.deletedAt !== null) {
    throw new Error(`Cannot journal storyline:${storylineId} restore before clearing deletedAt`);
  }
  appendAuthoredDomainMutation(changes, {
    entityType: 'storyline',
    mutationType: 'restore',
    entityId: storyline.id,
    projectId,
    payload: {
      name: storyline.name,
      color: storyline.color,
      summary: storyline.summary,
      nodeContentTemplateJson: storyline.nodeContentTemplateJson,
    },
  });
  await appendPlannedAuthoredOrderInTransaction(tx, changes, {
    projectId,
    listKind: 'storyline',
    scope: projectId,
    desiredEntityIds: entityIdsByNumericPlacement(
      (
        await tx
          .select({ id: StorylineTable.id, orderKey: StorylineTable.orderKey })
          .from(StorylineTable)
          .where(and(eq(StorylineTable.projectId, projectId), isNull(StorylineTable.deletedAt)))
      ).map((entry) => ({ entityId: entry.id, projection: entry.orderKey })),
    ),
  });
  await appendFullProseRestore(
    tx,
    changes,
    'storyline',
    storyline.id,
    storyline.contentJson,
  );
}

async function appendElementRestore(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  projectId: string,
  elementId: string,
): Promise<void> {
  const [element] = await tx
    .select()
    .from(BookElementTable)
    .where(and(eq(BookElementTable.id, elementId), eq(BookElementTable.projectId, projectId)))
    .limit(1);
  if (!element) restoreMissing('element', elementId);
  if (element.deletedAt !== null) {
    throw new Error(`Cannot journal element:${elementId} restore before clearing deletedAt`);
  }
  appendAuthoredDomainMutation(changes, {
    entityType: 'element',
    mutationType: 'restore',
    entityId: element.id,
    projectId,
    payload: {
      categoryId: element.categoryId,
      name: element.name,
      summary: element.summary,
      groupName: element.groupName,
    },
  });
  await replaceElementAliasesInTransaction(tx, changes, {
    projectId,
    elementId: element.id,
    aliases: decodeAliases(element.aliasesJson),
    forceReincarnation: true,
  });
  if (element.portraitAssetId) {
    const [asset] = await tx
      .select()
      .from(ProjectAssetTable)
      .where(
        and(
          eq(ProjectAssetTable.id, element.portraitAssetId),
          eq(ProjectAssetTable.projectId, projectId),
        ),
      )
      .limit(1);
    if (!asset || (asset.kind !== 'image' && asset.kind !== 'pdf')) {
      throw new Error(`Element ${element.id} has an invalid portrait asset`);
    }
    appendProjectAssetBindMutation(
      changes,
      projectId,
      { ...asset, kind: asset.kind },
      { kind: 'element-portrait', id: element.id },
    );
  }
  await appendFullProseRestore(
    tx,
    changes,
    'element',
    element.id,
    element.contentJson,
  );
}

async function appendCategoryRestore(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  projectId: string,
  categoryId: string,
): Promise<void> {
  const [category] = await tx
    .select()
    .from(ElementCategoryTable)
    .where(
      and(
        eq(ElementCategoryTable.id, categoryId),
        eq(ElementCategoryTable.projectId, projectId),
      ),
    )
    .limit(1);
  if (!category) restoreMissing('element-category', categoryId);
  if (category.deletedAt !== null) {
    throw new Error(
      `Cannot journal element-category:${categoryId} restore before clearing deletedAt`,
    );
  }
  const contentJson = category.contentJson ?? '{}';
  appendAuthoredDomainMutation(changes, {
    entityType: 'elementCategory',
    mutationType: 'restore',
    entityId: category.id,
    projectId,
    payload: {
      name: category.name,
      elementTemplateJson: category.elementTemplateJson ?? '{}',
      color: category.color,
      layoutMode: category.layoutMode,
      gridX: category.gridX,
      gridY: category.gridY,
    },
  });
  await appendFullProseRestore(tx, changes, 'category', category.id, contentJson);
}

/**
 * Capture a recoverable entity as a new lifecycle generation. The four Trash
 * UI restore paths call this through the shared authored transaction facade,
 * so no reachable restore can emit an empty seed or reuse incarnation zero.
 */
export async function appendAuthoredLifecycleRestoreInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly projectId: string;
    readonly entityType: RestorableSyncEntityKind;
    readonly entityId: string;
  },
): Promise<void> {
  switch (input.entityType) {
    case 'node':
      return appendNodeRestore(tx, changes, input.projectId, input.entityId);
    case 'storyline':
      return appendStorylineRestore(tx, changes, input.projectId, input.entityId);
    case 'element':
      return appendElementRestore(tx, changes, input.projectId, input.entityId);
    case 'elementCategory':
      return appendCategoryRestore(tx, changes, input.projectId, input.entityId);
  }
}

export function isRestorableSyncEntityKind(
  entityType: AuthoredDomainEntityKind,
): entityType is RestorableSyncEntityKind {
  return (
    entityType === 'node' ||
    entityType === 'storyline' ||
    entityType === 'element' ||
    entityType === 'elementCategory'
  );
}
