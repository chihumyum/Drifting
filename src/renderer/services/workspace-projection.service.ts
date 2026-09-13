import { eq } from 'drizzle-orm';

import type { Project } from '../domain/project';
import type { BookNode } from '../domain/book-node';
import { deriveNodeStorylineState } from '../domain/node-storyline-state';
import { indexById } from '../lib/immutable-id-index';
import { getDb, type DbClient } from '../lib/db';
import { EntityRelationTable } from '../schema/drizzle';
import { createBlockSectionRepository } from '../sqlite-repo/block-section-repo';
import { createBookActRepository } from '../sqlite-repo/book-act-repo';
import { createCommentActionRepository, createCommentRepository } from '../sqlite-repo/comment-repo';
import { createDriftGroupRepository } from '../sqlite-repo/drift-group-repo';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createElementCategoryRepository } from '../sqlite-repo/element-category-repo';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import { createNodeStorylineLinkRepository } from '../sqlite-repo/node-storyline-link-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { createProjectRepository } from '../sqlite-repo/project-repo';
import { createStorylineRepository } from '../sqlite-repo/storyline-repo';
import { createTimelineMarkerRepository } from '../sqlite-repo/timeline-marker-repo';
import {
  trashedKey,
  type EntityRelationLink,
  type WorkspaceDataProjection,
} from '../store/data-store';

import { readWorkspaceProjectionChanges, readWorkspaceProjectionCoverage, type WorkspaceProjectionCoverage } from './workspace-projection-coverage';
import { readWorkspaceLibrary } from './workspace-projection-library';
import { readWorkspaceElements } from './workspace-projection-elements';
import { WORKSPACE_PROJECTION_COLLECTIONS, type WorkspaceProjectionCollection } from './workspace-projection-sources';

const captureDatabases = new WeakMap<WorkspaceProjectionCapture, DbClient>();

export interface WorkspaceProjectionCapture {
  project: Project;
  data: WorkspaceDataProjection;
  coverage: WorkspaceProjectionCoverage | null;
  mode: 'full' | 'changes';
  readCollections: readonly WorkspaceProjectionCollection[];
  nodeRead: 'all' | 'changed' | 'reuse';
  elementRead: 'all' | 'changed' | 'reuse';
  libraryRead: 'all' | 'changed' | 'reuse';
}

/**
 * Captures a complete renderer projection from one SQLite read transaction.
 * Covered collections may reuse a previously published base; bootstrap, repair
 * and invalid/expired coverage read every collection. Nothing is published to Zustand here; the provider can reject
 * the whole capture when its route/epoch is no longer authoritative.
 */
export async function captureWorkspaceProjection(input: {
  projectId: string;
  userId: string;
  previous?: WorkspaceProjectionCapture;
}): Promise<WorkspaceProjectionCapture | null> {
  const database = getDb();
  return database.transaction(async (tx) => {
    const project = await createProjectRepository(input.userId, tx).findById(input.projectId);
    if (!project || project.userId !== input.userId) return null;

    const coverage = await readWorkspaceProjectionCoverage(tx, input.projectId);
    const previous = input.previous;
    const canReuse = previous?.coverage &&
      captureDatabases.get(previous) === database &&
      previous.project.id === project.id &&
      previous.project.userId === project.userId &&
      previous.project.createdAt === project.createdAt;
    const changes = canReuse
      ? await readWorkspaceProjectionChanges(tx, input.projectId, previous.coverage!, coverage)
      : null;
    const reads = new Set(changes?.collections ?? WORKSPACE_PROJECTION_COLLECTIONS);
    reads.add('project');
    const base = changes === null ? undefined : previous!.data;
    const needs = (collection: WorkspaceProjectionCollection) => reads.has(collection);
    const select = <T>(collection: WorkspaceProjectionCollection, read: () => Promise<T>, reused: T | undefined): Promise<T> =>
      needs(collection) ? read() : Promise.resolve(reused!);

    const nodeRepo = createBookNodeSqliteRepository(input.projectId, tx);
    const storylineRepo = createStorylineRepository(input.projectId, tx);
    const elementRepo = createBookElementSqliteRepository(input.projectId, tx);
    const categoryRepo = createElementCategoryRepository(input.projectId, tx);

    let changedNodes: BookNode[] | null = null;
    if (base && changes?.nodeIds) {
      const selected = await nodeRepo.findAll(changes.nodeIds);
      const before = indexById(base.bookNodes);
      // Reusing array order requires stable row identity, visibility and sort
      // keys. The journal rules out delete/reinsert (even same timestamps).
      // Lifecycle, order or oversized batches promote only this collection.
      if (selected.length === changes.nodeIds.length && selected.every((node) => {
        const old = before.get(node.id);
        return old && old.kind === node.kind && old.bookOrder === node.bookOrder;
      })) {
        const replacements = indexById(selected);
        changedNodes = base.bookNodes.map((node) => replacements.get(node.id) ?? node);
      }
    }
    const nodeRead = !needs('nodes') ? 'reuse' : changedNodes ? 'changed' : 'all';
    // Full live-node/storyline changes require the complete ordered membership
    // dependency; a metadata-only node read keeps it unless links also changed.
    if (nodeRead === 'all' || needs('storylines')) reads.add('memberships');

    const [
      { bookElements, trashedElements, elementRead },
      bookNodes,
      trashedNodes,
      storylines,
      trashedStorylines,
      bookElementCategories,
      trashedCategories,
      projectAssets,
      { libraryItems, libraryRead },
      comments,
      commentActions,
      entityRelationTypes,
      blockSections,
      bookActs,
      driftGroups,
      timelineMarkers,
      relationRows,
    ] = await Promise.all([
      needs('elements')
        ? readWorkspaceElements(elementRepo, base?.bookElements, changes?.elementIds)
        : Promise.resolve({ bookElements: base!.bookElements, trashedElements: [], elementRead: 'reuse' as const }),
      changedNodes ? Promise.resolve(changedNodes) : select('nodes', () => nodeRepo.findAll(), base?.bookNodes),
      nodeRead === 'changed' ? Promise.resolve([]) : select('nodes', () => nodeRepo.findTrashed(), []),
      select('storylines', () => storylineRepo.getStorylinesByProject(), base?.storylines),
      select('storylines', () => storylineRepo.getTrashedStorylines(), []),
      select('categories', () => categoryRepo.findAll(), base?.bookElementCategories),
      select('categories', () => categoryRepo.findTrashed(), []),
      select('assets', () => createProjectAssetSqliteRepository(input.projectId, tx).findAll(), base?.projectAssets),
      needs('library')
        ? readWorkspaceLibrary(createLibraryItemSqliteRepository(input.projectId, tx), base?.libraryItems, changes?.libraryIds)
        : Promise.resolve({ libraryItems: base!.libraryItems, libraryRead: 'reuse' as const }),
      select('comments', () => createCommentRepository(input.projectId, tx).findAll(), base?.comments),
      select('comment-actions', () => createCommentActionRepository(input.projectId, tx).findAll(), base?.commentActions),
      select('relation-types', () => createEntityRelationTypeRepository(input.projectId, tx).list(), base?.entityRelationTypes),
      select('sections', () => createBlockSectionRepository(tx).findByProject(input.projectId), base?.blockSections),
      select('acts', () => createBookActRepository(input.projectId, tx).findAll(), base?.bookActs),
      select('drift-groups', () => createDriftGroupRepository(input.projectId, tx).findAll(), base?.driftGroups),
      select('markers', () => createTimelineMarkerRepository(input.projectId, tx).findAll(), base?.timelineMarkers),
      select('relations', async () => tx.select().from(EntityRelationTable)
        .where(eq(EntityRelationTable.projectId, input.projectId)), []),
    ]);

    const links =
      !needs('memberships') || bookNodes.length === 0
        ? []
        : await createNodeStorylineLinkRepository(
            input.projectId,
            tx,
          ).getStorylineLinksByNodeIds(bookNodes.map((node) => node.id));
    const { storylineNodeMapping, primaryStorylineByNode } = needs('memberships')
      ? deriveNodeStorylineState(links)
      : { storylineNodeMapping: base!.storylineNodeMapping, primaryStorylineByNode: base!.primaryStorylineByNode };

    const needsTrash = (collection: WorkspaceProjectionCollection) =>
      needs(collection) && !(collection === 'nodes' && nodeRead === 'changed') &&
      !(collection === 'elements' && elementRead === 'changed');
    const trashGroups = [
      ['nodes', 'node', trashedNodes], ['storylines', 'storyline', trashedStorylines],
      ['elements', 'element', trashedElements], ['categories', 'category', trashedCategories],
    ] as const;
    const trashChanged = trashGroups.some(([collection]) => needsTrash(collection));
    const trashedEntityIds = base && !trashChanged ? base.trashedEntityIds : new Set<string>();
    if (trashChanged) {
      // Keep the full path's kind/row iteration order, including unchanged kinds.
      for (const [collection, kind, rows] of trashGroups) {
        if (needsTrash(collection)) for (const row of rows) trashedEntityIds.add(trashedKey(kind, row.id));
        else for (const key of base!.trashedEntityIds) if (key.startsWith(`${kind}:`)) trashedEntityIds.add(key);
      }
    }

    const entityRelations: EntityRelationLink[] = needs('relations') ? relationRows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fromKind: row.fromKind as EntityRelationLink['fromKind'],
      fromId: row.fromId,
      toKind: row.toKind as EntityRelationLink['toKind'],
      toId: row.toId,
      relationTypeId: row.relationTypeId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })) : base!.entityRelations;

    const result: WorkspaceProjectionCapture = {
      project,
      coverage,
      mode: changes === null ? 'full' : 'changes',
      readCollections: [...reads],
      nodeRead,
      elementRead,
      libraryRead,
      data: {
        storylines,
        storylineNodeMapping,
        primaryStorylineByNode,
        bookNodes,
        bookElementCategories,
        bookElements,
        projectAssets,
        trashedEntityIds,
        libraryItems,
        comments,
        commentActions,
        entityRelations,
        entityRelationTypes,
        blockSections,
        bookActs,
        driftGroups,
        timelineMarkers,
      },
    };
    captureDatabases.set(result, database);
    return result;
  });
}
