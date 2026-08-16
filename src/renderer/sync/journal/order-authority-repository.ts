import { and, eq } from 'drizzle-orm';

import type { DbExecutor, DbTransaction } from '../../lib/db';
import {
  SyncEntityLifecycleTable,
  SyncOrderRegisterTable,
} from '../../schema/drizzle';
import {
  appendAuthoredOrderMove,
  appendAuthoredOrderRebalance,
  compareAuthoredOrderEntries,
  planAuthoredOrderMutation,
  type AppendAuthoredOrderMoveInput,
  type AuthoredOrderEntry,
} from './order-authority';
import type { SyncChangeBuilder } from './change-builder';
import { findActiveSyncGenerationInTransaction } from './sync-generation-repository';

export async function readAuthoredOrderEntriesInTransaction(
  tx: DbExecutor,
  input: {
    readonly projectId: string;
    readonly listKind: AppendAuthoredOrderMoveInput['listKind'];
    readonly scope: string;
  },
): Promise<readonly AuthoredOrderEntry[]> {
  const generation = await findActiveSyncGenerationInTransaction(tx as DbTransaction, input.projectId);
  if (!generation) return [];
  const rows = await tx
    .select({
      entityId: SyncOrderRegisterTable.entityId,
      positionKey: SyncOrderRegisterTable.positionKey,
      incarnation: SyncOrderRegisterTable.incarnation,
    })
    .from(SyncOrderRegisterTable)
    .where(
      and(
        eq(SyncOrderRegisterTable.syncGenerationId, generation.syncGenerationId),
        eq(SyncOrderRegisterTable.listKind, input.listKind),
        eq(SyncOrderRegisterTable.ownerId, input.scope),
      ),
    );
  const lifecycleKind = input.listKind === 'chapter' ? 'node' : input.listKind;
  const lifecycles = await tx
    .select({
      entityId: SyncEntityLifecycleTable.entityId,
      incarnation: SyncEntityLifecycleTable.incarnation,
      state: SyncEntityLifecycleTable.state,
    })
    .from(SyncEntityLifecycleTable)
    .where(
      and(
        eq(SyncEntityLifecycleTable.syncGenerationId, generation.syncGenerationId),
        eq(SyncEntityLifecycleTable.entityKind, lifecycleKind),
      ),
    );
  const lifecycleByEntity = new Map(
    lifecycles.map((row) => [row.entityId, row] as const),
  );
  return rows
    .filter((row) => {
      const lifecycle = lifecycleByEntity.get(row.entityId);
      // An order register may legitimately precede an explicit lifecycle in a
      // protocol-only fixture. Once lifecycle authority exists, only its live
      // current incarnation is eligible as an adjacent bound.
      return (
        lifecycle === undefined ||
        (lifecycle.state === 'live' && lifecycle.incarnation === row.incarnation)
      );
    })
    .sort(compareAuthoredOrderEntries);
}

/**
 * Append the complete authority update for one user ordering intent. Inserts
 * allocate inside surviving neighbours; an explicit reorder or an equal-key
 * gap becomes one change-set-wide rebalance. Callers never manufacture a wire
 * key from their numeric projection.
 */
export async function appendPlannedAuthoredOrderInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly projectId: string;
    readonly listKind: AppendAuthoredOrderMoveInput['listKind'];
    readonly scope: string;
    readonly desiredEntityIds: readonly string[];
  },
): Promise<void> {
  const plan = planAuthoredOrderMutation(
    await readAuthoredOrderEntriesInTransaction(tx, input),
    input.desiredEntityIds,
  );
  if (plan.kind === 'rebalance') {
    appendAuthoredOrderRebalance(changes, {
      listKind: input.listKind,
      scope: input.scope,
      entries: plan.entries,
    });
    return;
  }
  for (const entry of plan.entries) {
    appendAuthoredOrderMove(changes, {
      listKind: input.listKind,
      scope: input.scope,
      entityId: entry.entityId,
      positionKey: entry.positionKey,
    });
  }
}
