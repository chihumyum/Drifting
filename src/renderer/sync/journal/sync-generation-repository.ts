import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { DbTransaction } from '../../lib/db';
import { ProjectTable, SyncGenerationTable } from '../../schema/drizzle';
import { stagePendingProviderBindingForNewSyncGenerationInTransaction } from '../app-authority-repository';

export interface ActiveSyncGenerationIdentity {
  readonly projectId: string;
  readonly projectSyncId: string;
  readonly syncGenerationId: string;
  readonly generationNumber: number;
}

export interface SyncGenerationIdSource {
  createSyncGenerationId(): string;
  createProjectSyncId(): string;
}

export const defaultSyncGenerationIdSource: SyncGenerationIdSource = Object.freeze({
  createSyncGenerationId: () => `sync-generation-${uuidv7()}`,
  createProjectSyncId: () => `projectSync-${uuidv7()}`,
});

export async function findActiveSyncGenerationInTransaction(
  tx: DbTransaction,
  projectId: string,
): Promise<ActiveSyncGenerationIdentity | null> {
  const rows = await tx
    .select({
      projectId: SyncGenerationTable.projectId,
      projectSyncId: SyncGenerationTable.projectSyncId,
      syncGenerationId: SyncGenerationTable.syncGenerationId,
      generationNumber: SyncGenerationTable.generationNumber,
    })
    .from(SyncGenerationTable)
    .where(
      and(
        eq(SyncGenerationTable.projectId, projectId),
        eq(SyncGenerationTable.status, 'active'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.projectId === null) return null;
  return {
    projectId: row.projectId,
    projectSyncId: row.projectSyncId,
    syncGenerationId: row.syncGenerationId,
    generationNumber: row.generationNumber,
  };
}

export async function ensureActiveSyncGenerationInTransaction(
  tx: DbTransaction,
  input: {
    projectId: string;
    nowIso: string;
    ids?: SyncGenerationIdSource;
  },
): Promise<ActiveSyncGenerationIdentity> {
  const current = await findActiveSyncGenerationInTransaction(tx, input.projectId);
  if (current) return current;

  const projects = await tx
    .select({ id: ProjectTable.id })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, input.projectId))
    .limit(1);
  if (projects.length === 0) {
    throw new Error(`cannot create a SyncEngine SyncGeneration for missing project ${input.projectId}`);
  }

  const ids = input.ids ?? defaultSyncGenerationIdSource;
  const generation: ActiveSyncGenerationIdentity = {
    projectId: input.projectId,
    projectSyncId: ids.createProjectSyncId(),
    syncGenerationId: ids.createSyncGenerationId(),
    generationNumber: 1,
  };
  await tx.insert(SyncGenerationTable).values({
    syncGenerationId: generation.syncGenerationId,
    projectId: generation.projectId,
    projectSyncId: generation.projectSyncId,
    generationNumber: generation.generationNumber,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  });
  await stagePendingProviderBindingForNewSyncGenerationInTransaction(tx, {
    syncGenerationId: generation.syncGenerationId,
    nowIso: input.nowIso,
  });
  return generation;
}
