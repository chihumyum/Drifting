import { and, eq, gt } from 'drizzle-orm';
import type { DbTransaction } from '../lib/db';
import { WorkspaceProjectionChangeTable, WorkspaceProjectionClockTable } from '../schema/drizzle';
import { WORKSPACE_PROJECTION_COLLECTIONS, WORKSPACE_PROJECTION_MAX_CHANGES, type WorkspaceProjectionCollection } from './workspace-projection-sources';

export interface WorkspaceProjectionCoverage {
  readonly epoch: string;
  readonly revision: number;
  readonly retainedAfter: number;
}

export interface WorkspaceProjectionChanges {
  readonly collections: ReadonlySet<WorkspaceProjectionCollection>;
  /** Null promotes this collection to a complete read. */
  readonly nodeIds: readonly string[] | null;
  readonly elementIds: readonly string[] | null;
}

/** Capture the cursor in the same SQLite snapshot as the projected rows. */
export async function readWorkspaceProjectionCoverage(tx: DbTransaction, projectId: string): Promise<WorkspaceProjectionCoverage | null> {
  const [clock] = await tx.select().from(WorkspaceProjectionClockTable)
    .where(eq(WorkspaceProjectionClockTable.projectId, projectId)).limit(1);
  if (!clock || !/^[0-9a-f]{32}$/.test(clock.epoch) ||
    !Number.isSafeInteger(clock.revision) || !Number.isSafeInteger(clock.retainedAfter) ||
    clock.retainedAfter < 0 || clock.revision < clock.retainedAfter) return null;
  return { epoch: clock.epoch, revision: clock.revision, retainedAfter: clock.retainedAfter };
}

/** Null means complete capture. A missing event cannot hide a committed row. */
export async function readWorkspaceProjectionChanges(
  tx: DbTransaction,
  projectId: string,
  previous: WorkspaceProjectionCoverage,
  current: WorkspaceProjectionCoverage | null,
): Promise<WorkspaceProjectionChanges | null> {
  if (!current || current.epoch !== previous.epoch ||
    previous.revision < current.retainedAfter || previous.revision > current.revision) return null;
  if (previous.revision === current.revision) return { collections: new Set(), nodeIds: null, elementIds: null };
  const rows = await tx.select({
    collection: WorkspaceProjectionChangeTable.collection,
    entityId: WorkspaceProjectionChangeTable.entityId,
    replacementRevision: WorkspaceProjectionChangeTable.replacementRevision,
  })
    .from(WorkspaceProjectionChangeTable)
    .where(and(eq(WorkspaceProjectionChangeTable.projectId, projectId), gt(WorkspaceProjectionChangeTable.revision, previous.revision)))
    .limit(WORKSPACE_PROJECTION_MAX_CHANGES + 1);
  if (rows.length === 0 || rows.length > WORKSPACE_PROJECTION_MAX_CHANGES) return null;
  const known = new Set<string>(WORKSPACE_PROJECTION_COLLECTIONS);
  if (rows.some(({ collection }) => !known.has(collection))) return null;
  const selectedIds = (collection: WorkspaceProjectionCollection) => {
    const selected = rows.filter((row) => row.collection === collection);
    return selected.length > 0 && selected.length <= 128 &&
      selected.every((row) => row.replacementRevision <= previous.revision)
      ? selected.map(({ entityId }) => entityId) : null;
  };
  return {
    collections: new Set(rows.map(({ collection }) => collection as WorkspaceProjectionCollection)),
    nodeIds: selectedIds('nodes'),
    elementIds: selectedIds('elements'),
  };
}
