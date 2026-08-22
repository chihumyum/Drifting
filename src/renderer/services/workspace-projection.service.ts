import { eq } from 'drizzle-orm';

import type { Project } from '../domain/project';
import { deriveNodeStorylineState } from '../domain/node-storyline-state';
import { getDb } from '../lib/db';
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

export interface WorkspaceProjectionCapture {
  project: Project;
  data: WorkspaceDataProjection;
}

/**
 * Captures every renderer-owned workspace slice from one SQLite read
 * transaction. Nothing is published to Zustand here; the provider can reject
 * the whole capture when its route/epoch is no longer authoritative.
 */
export async function captureWorkspaceProjection(input: {
  projectId: string;
  userId: string;
}): Promise<WorkspaceProjectionCapture | null> {
  return getDb().transaction(async (tx) => {
    const project = await createProjectRepository(input.userId, tx).findById(input.projectId);
    if (!project || project.userId !== input.userId) return null;

    const nodeRepo = createBookNodeSqliteRepository(input.projectId, tx);
    const storylineRepo = createStorylineRepository(input.projectId, tx);
    const elementRepo = createBookElementSqliteRepository(input.projectId, tx);
    const categoryRepo = createElementCategoryRepository(input.projectId, tx);

    const [
      bookNodes,
      trashedNodes,
      storylines,
      trashedStorylines,
      bookElements,
      trashedElements,
      bookElementCategories,
      trashedCategories,
      projectAssets,
      libraryItems,
      comments,
      commentActions,
      entityRelationTypes,
      blockSections,
      bookActs,
      driftGroups,
      timelineMarkers,
      relationRows,
    ] = await Promise.all([
      nodeRepo.findAll(),
      nodeRepo.findTrashed(),
      storylineRepo.getStorylinesByProject(),
      storylineRepo.getTrashedStorylines(),
      elementRepo.findAll(),
      elementRepo.findTrashed(),
      categoryRepo.findAll(),
      categoryRepo.findTrashed(),
      createProjectAssetSqliteRepository(input.projectId, tx).findAll(),
      createLibraryItemSqliteRepository(input.projectId, tx).findAll(),
      createCommentRepository(input.projectId, tx).findAll(),
      createCommentActionRepository(input.projectId, tx).findAll(),
      createEntityRelationTypeRepository(input.projectId, tx).list(),
      createBlockSectionRepository(tx).findByProject(input.projectId),
      createBookActRepository(input.projectId, tx).findAll(),
      createDriftGroupRepository(input.projectId, tx).findAll(),
      createTimelineMarkerRepository(input.projectId, tx).findAll(),
      tx
        .select()
        .from(EntityRelationTable)
        .where(eq(EntityRelationTable.projectId, input.projectId)),
    ]);

    const links =
      bookNodes.length === 0
        ? []
        : await createNodeStorylineLinkRepository(
            input.projectId,
            tx,
          ).getStorylineLinksByNodeIds(bookNodes.map((node) => node.id));
    const { storylineNodeMapping, primaryStorylineByNode } = deriveNodeStorylineState(links);

    const trashedEntityIds = new Set<string>();
    for (const node of trashedNodes) trashedEntityIds.add(trashedKey('node', node.id));
    for (const storyline of trashedStorylines) {
      trashedEntityIds.add(trashedKey('storyline', storyline.id));
    }
    for (const element of trashedElements) trashedEntityIds.add(trashedKey('element', element.id));
    for (const category of trashedCategories) {
      trashedEntityIds.add(trashedKey('category', category.id));
    }

    const entityRelations: EntityRelationLink[] = relationRows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      fromKind: row.fromKind as EntityRelationLink['fromKind'],
      fromId: row.fromId,
      toKind: row.toKind as EntityRelationLink['toKind'],
      toId: row.toId,
      relationTypeId: row.relationTypeId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return {
      project,
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
  });
}
