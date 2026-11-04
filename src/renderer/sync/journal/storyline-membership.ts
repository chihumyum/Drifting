import { and, eq, isNull } from 'drizzle-orm';

import type { DbExecutor } from '../../lib/db';
import {
  BookNodeTable,
  NodeStorylineLinkTable,
  StorylineTable,
  SyncSetTagTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import { compareUtf8Bytewise } from '../protocol';
import type { SyncChangeBuilder } from './change-builder';
import { resolveCurrentEntityLifecycleInTransaction } from './incarnation';

export const STORYLINE_MEMBERSHIP_SET_KIND = 'membership';
export const NODE_PRIMARY_STORYLINE_REGISTER_KIND = 'node-storyline-primary';
export const NODE_PRIMARY_STORYLINE_FIELD = 'storylineId';

interface LiveMembershipTag {
  readonly storylineId: string;
  readonly addTag: string;
}

export interface AuthoredNodeStorylineProjection {
  readonly storylineIds: readonly string[];
  readonly primaryStorylineId: string | null;
}

async function activeSyncGenerationId(tx: DbExecutor, projectId: string): Promise<string | null> {
  const rows = await tx
    .select({ syncGenerationId: SyncGenerationTable.syncGenerationId })
    .from(SyncGenerationTable)
    .where(and(eq(SyncGenerationTable.projectId, projectId), eq(SyncGenerationTable.status, 'active')))
    .limit(1);
  return rows[0]?.syncGenerationId ?? null;
}

async function liveMembershipTags(
  tx: DbExecutor,
  projectId: string,
  nodeId: string,
): Promise<readonly LiveMembershipTag[]> {
  const syncGenerationId = await activeSyncGenerationId(tx, projectId);
  if (!syncGenerationId) return [];
  const rows = await tx
    .select({
      storylineId: SyncSetTagTable.ownerId,
      addTag: SyncSetTagTable.addTag,
      incarnation: SyncSetTagTable.incarnation,
    })
    .from(SyncSetTagTable)
    .where(
      and(
        eq(SyncSetTagTable.syncGenerationId, syncGenerationId),
        eq(SyncSetTagTable.ownerKind, STORYLINE_MEMBERSHIP_SET_KIND),
        eq(SyncSetTagTable.setKey, STORYLINE_MEMBERSHIP_SET_KIND),
        eq(SyncSetTagTable.valueKey, nodeId),
        isNull(SyncSetTagTable.removedByChangeSetId),
      ),
    );
  const currentByStoryline = new Map<string, number>();
  const liveRows: LiveMembershipTag[] = [];
  for (const row of rows) {
    let current = currentByStoryline.get(row.storylineId);
    if (current === undefined) {
      const lifecycle = await resolveCurrentEntityLifecycleInTransaction(tx, {
        syncGenerationId,
        kind: 'storyline',
        id: row.storylineId,
      });
      current = lifecycle
        ? lifecycle.state === 'live'
          ? lifecycle.incarnation
          : -1
        : 0;
      currentByStoryline.set(row.storylineId, current);
    }
    if (current !== row.incarnation) continue;
    liveRows.push({ storylineId: row.storylineId, addTag: row.addTag });
  }
  return liveRows.sort(
    (left, right) =>
      compareUtf8Bytewise(left.storylineId, right.storylineId) ||
      compareUtf8Bytewise(left.addTag, right.addTag),
  );
}

async function readAuthoredProjection(
  tx: DbExecutor,
  projectId: string,
  nodeId: string,
): Promise<AuthoredNodeStorylineProjection & { readonly nodeLive: boolean }> {
  const nodes = await tx
    .select({ kind: BookNodeTable.kind, deletedAt: BookNodeTable.deletedAt })
    .from(BookNodeTable)
    .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId)))
    .limit(1);
  const node = nodes[0];
  if (node && node.kind !== 'chapter') {
    throw new Error(`Only chapter nodes may have storyline membership: ${nodeId}`);
  }

  const rows = await tx
    .select({
      storylineId: NodeStorylineLinkTable.storylineId,
      isPrimary: NodeStorylineLinkTable.isPrimary,
    })
    .from(NodeStorylineLinkTable)
    .innerJoin(StorylineTable, eq(StorylineTable.id, NodeStorylineLinkTable.storylineId))
    .where(
      and(
        eq(NodeStorylineLinkTable.nodeId, nodeId),
        eq(StorylineTable.projectId, projectId),
      ),
    );
  rows.sort((left, right) => compareUtf8Bytewise(left.storylineId, right.storylineId));
  const primaryRows = rows.filter(({ isPrimary }) => isPrimary);
  if (primaryRows.length > 1) {
    throw new Error(`Chapter ${nodeId} has more than one primary storyline`);
  }
  return {
    storylineIds: rows.map(({ storylineId }) => storylineId),
    primaryStorylineId: primaryRows[0]?.storylineId ?? null,
    nodeLive: node !== undefined && node.deletedAt === null,
  };
}

/**
 * Convert the final typed SQLite membership projection into one OR-set diff
 * plus the node's independent primary-storyline LWW register. Call exactly
 * once per affected node, after every domain row mutation in the same outer
 * authored transaction.
 *
 * A chapter in the Trash gets only the membership diff (deleting a storyline
 * takes its trashed chapters off it too): its primary register cannot land on
 * a node that is not live, and a restore writes the register again for the
 * new incarnation. A chapter deleted for good goes through
 * {@link appendAuthoredNodeStorylinePurgeInTransaction} instead.
 */
export async function appendAuthoredNodeStorylineProjectionInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly projectId: string;
    readonly nodeId: string;
    /** Replace old node-membership tags when the node enters incarnation n+1. */
    readonly forceReincarnation?: boolean;
  },
): Promise<AuthoredNodeStorylineProjection> {
  const { nodeLive, ...projection } = await readAuthoredProjection(tx, input.projectId, input.nodeId);
  const currentTags = await liveMembershipTags(tx, input.projectId, input.nodeId);
  const currentByStoryline = new Map<string, string[]>();
  for (const { storylineId, addTag } of currentTags) {
    const tags = currentByStoryline.get(storylineId) ?? [];
    tags.push(addTag);
    currentByStoryline.set(storylineId, tags);
  }
  const desired = new Set(projection.storylineIds);
  const allStorylineIds = [...new Set([
    ...currentByStoryline.keys(),
    ...projection.storylineIds,
  ])].sort(compareUtf8Bytewise);

  for (const storylineId of allStorylineIds) {
    const target = {
      family: 'set' as const,
      kind: STORYLINE_MEMBERSHIP_SET_KIND,
      id: storylineId,
      incarnation: 0,
    };
    const observedAddTags = [...(currentByStoryline.get(storylineId) ?? [])]
      .sort(compareUtf8Bytewise);
    if (desired.has(storylineId)) {
      if (input.forceReincarnation && observedAddTags.length > 0) {
        changes.add({
          action: 'set.remove',
          target,
          payload: { memberId: input.nodeId, observedAddTags },
        });
      }
      if (input.forceReincarnation || observedAddTags.length === 0) {
        changes.add({
          action: 'set.add',
          target,
          payload: { memberId: input.nodeId, value: null },
        });
      }
    } else if (observedAddTags.length > 0) {
      changes.add({
        action: 'set.remove',
        target,
        payload: { memberId: input.nodeId, observedAddTags },
      });
    }
  }

  if (!nodeLive) return projection;
  changes.add({
    action: 'field.set',
    target: {
      family: 'entity',
      kind: NODE_PRIMARY_STORYLINE_REGISTER_KIND,
      id: input.nodeId,
      incarnation: 0,
    },
    payload: {
      field: NODE_PRIMARY_STORYLINE_FIELD,
      value: projection.primaryStorylineId,
    },
  });
  return projection;
}

/**
 * A chapter deleted for good leaves every storyline it was in: its link rows
 * go (foreign keys are not enforced) and each live membership tag is removed
 * from its storyline's OR-set. The primary-storyline register is owned by the
 * chapter and ends with the chapter's purge in the same change-set, so it is
 * not written: a field write on a purged owner cannot materialize and would
 * fail the whole transaction.
 */
export async function appendAuthoredNodeStorylinePurgeInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: { readonly projectId: string; readonly nodeId: string },
): Promise<void> {
  await tx.delete(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.nodeId, input.nodeId));
  const tagsByStoryline = new Map<string, string[]>();
  for (const { storylineId, addTag } of await liveMembershipTags(tx, input.projectId, input.nodeId)) {
    const tags = tagsByStoryline.get(storylineId) ?? [];
    tags.push(addTag);
    tagsByStoryline.set(storylineId, tags);
  }
  for (const storylineId of [...tagsByStoryline.keys()].sort(compareUtf8Bytewise)) {
    changes.add({
      action: 'set.remove',
      target: {
        family: 'set',
        kind: STORYLINE_MEMBERSHIP_SET_KIND,
        id: storylineId,
        incarnation: 0,
      },
      payload: {
        memberId: input.nodeId,
        observedAddTags: [...tagsByStoryline.get(storylineId)!].sort(compareUtf8Bytewise),
      },
    });
  }
}
