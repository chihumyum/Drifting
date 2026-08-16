import type { DbTransaction } from '../lib/db';
import {
  appendAuthoredDomainMutation,
  runAuthoredTransaction,
  type AuthoredDomainEntityKind,
  type AuthoredDomainMutationKind,
  type SyncChangeBuilder,
} from '../sync/journal';
import {
  appendAuthoredLifecycleRestoreInTransaction,
  isRestorableSyncEntityKind,
} from './sync-lifecycle-restore';

export type AtomicSyncWriter = (
  entityType: AuthoredDomainEntityKind,
  mutationType: AuthoredDomainMutationKind,
  entityId: string,
  projectId: string,
  payload?: Record<string, unknown>,
  parentId?: string,
) => Promise<void>;

/**
 * UI/domain facade over the one SyncEngine authored transaction entrypoint.
 * Every callback invocation appends to one builder; only the outer transaction
 * allocates a writer sequence and commits the complete change-set.
 */
export function withAtomicSyncTransaction<T>(
  projectId: string,
  work: (
    tx: DbTransaction,
    sync: AtomicSyncWriter,
    changes: SyncChangeBuilder,
  ) => Promise<T>,
): Promise<T> {
  return runAuthoredTransaction(projectId, 'domain.authored-write', async ({ tx, changes }) => {
    const sync: AtomicSyncWriter = async (
      entityType,
      mutationType,
      entityId,
      mutationProjectId,
      payload,
      parentId,
    ) => {
      if (mutationProjectId !== projectId) {
        throw new Error(
          `Authored transaction for ${projectId} cannot record a mutation for ${mutationProjectId}`,
        );
      }
      if (mutationType === 'restore' && isRestorableSyncEntityKind(entityType)) {
        if (parentId !== undefined) {
          throw new TypeError(`${entityType} restore cannot carry a parentId side channel`);
        }
        await appendAuthoredLifecycleRestoreInTransaction(tx, changes, {
          projectId,
          entityType,
          entityId,
        });
        return;
      }
      appendAuthoredDomainMutation(changes, {
        entityType,
        mutationType,
        entityId,
        projectId,
        payload,
        parentId,
      });
    };
    return work(tx, sync, changes);
  });
}
