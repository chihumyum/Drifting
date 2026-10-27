// A new project as every client creates it, journaled in the caller's
// authored transaction. Kept free of stores and platform services so the
// development seed (src/dev-cli/seed.ts) can run it headless.

import type { Project } from '../domain/project';
import { defaultProjectKvJson } from '../domain/kv';
import { genericAssociationRelationType, type EntityRelationType } from '../domain/entity-relation-type';
import type { DbTransaction } from '../lib/db';
import { createProjectRepository } from '../sqlite-repo/project-repo';
import { createEntityRelationTypeRepository } from '../sqlite-repo/entity-relation-type-repo';
import type { SyncChangeBuilder } from '../sync/journal';
import { replaceEntityKvEntriesInTransaction } from './normalized-kv-alias-authority';
import type { AtomicSyncWriter } from './sync-helpers';

/** The project row, its default facts and the built-in relation type. */
export async function createProjectInTransaction(
  tx: DbTransaction,
  sync: AtomicSyncWriter,
  changes: SyncChangeBuilder,
  input: { projectId: string; userId: string; name: string; now: string },
): Promise<{ project: Project; builtInRelationType: EntityRelationType }> {
  const { projectId, userId, now } = input;
  const builtInRelationType = genericAssociationRelationType(projectId, now);
  const projectRepo = createProjectRepository(userId, tx);
  const created = await projectRepo.create({
    id: projectId,
    userId,
    name: input.name,
    summary: '',
    kvJson: '[]',
    storylineTemplateKvJson: '[]',
    createdAt: now,
    updatedAt: now,
  });
  await sync('project', 'create', created.id, created.id, {
    id: created.id,
    name: created.name,
    summary: created.summary,
  });
  await replaceEntityKvEntriesInTransaction(tx, changes, {
    projectId,
    ownerKind: 'project',
    ownerId: projectId,
    namespace: 'facts',
    nextJson: defaultProjectKvJson(),
  });
  await createEntityRelationTypeRepository(projectId, tx).create(builtInRelationType);
  await sync('entityRelationType', 'create', builtInRelationType.id, projectId, { ...builtInRelationType });
  return { project: (await projectRepo.findById(projectId))!, builtInRelationType };
}
