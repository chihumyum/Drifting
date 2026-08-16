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
): Promise<AuthoredNodeStorylineProjection> {
  const nodes = await tx
    .select({ kind: BookNodeTable.kind })
    .from(BookNodeTable)
    .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, projectId)))
    .limit(1);
  if (nodes[0] && nodes[0].kind !== 'chapter') {
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
  };
}

/**
 * Convert the final typed SQLite membership projection into one OR-set diff
 * plus the node's independent primary-storyline LWW register. Call exactly
 * once per affected node, after every domain row mutation in the same outer
 * authored transaction.
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
  const projection = await readAuthoredProjection(tx, input.projectId, input.nodeId);
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
