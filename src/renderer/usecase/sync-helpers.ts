/**
 * Crash-safe entity sync transaction helper.
 *
 * Every local domain mutation and its durable outbox row must use the same
 * SQLite transaction. The network flush is scheduled only after commit.
 */

import {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
  type EntityType,
  type MutationType,
  type SyncMutation,
} from '../services/entity-sync.service';
import { getDb, type DbTransaction } from '../lib/db';
import { localMutationGeneration } from '../services/local-mutation-generation';
import { trackAtomicSyncTransaction } from '../services/atomic-sync-transaction-tracker';

function createSyncMutation(
  entityType: EntityType,
  mutationType: MutationType,
  entityId: string,
  projectId: string,
  payload?: Record<string, unknown>,
  parentId?: string,
): SyncMutation {
  return {
    entityType,
    mutationType,
    entityId,
    projectId,
    payload,
    parentId,
    timestamp: Date.now(),
  };
}

export type AtomicSyncWriter = (
  entityType: EntityType,
  mutationType: MutationType,
  entityId: string,
  projectId: string,
  payload?: Record<string, unknown>,
  parentId?: string,
) => Promise<void>;

export function withAtomicSyncTransaction<T>(
  projectId: string,
  work: (tx: DbTransaction, sync: AtomicSyncWriter) => Promise<T>,
): Promise<T> {
  // Bump before the first await / before acquiring the serialized transaction.
  // Any graph response already in flight for this project is now stale.
  localMutationGeneration.bump(projectId);
  let persistedMutation = false;
  const operation = getDb()
    .transaction(async (tx) => {
      const persist: AtomicSyncWriter = async (
        entityType,
        mutationType,
        entityId,
        mutationProjectId,
        payload,
        parentId,
      ) => {
        if (mutationProjectId !== projectId) {
          throw new Error(
            `Atomic sync transaction for ${projectId} cannot persist a mutation for ${mutationProjectId}`,
          );
        }
        const persisted = await persistSyncMutationInTransaction(
          tx,
          createSyncMutation(
            entityType,
            mutationType,
            entityId,
            mutationProjectId,
            payload,
            parentId,
          ),
        );
        persistedMutation = persistedMutation || persisted;
      };
      return work(tx, persist);
    })
    .then((result) => {
      if (persistedMutation) notifySyncMutationCommitted();
      return result;
    });

  return trackAtomicSyncTransaction(operation);
}
