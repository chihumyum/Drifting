import type { AgentRuntimeNodeWriteGuard } from '../domain/agent-runtime-freshness';
import type {
  BookNodeUpdateData,
  BookNodeUpdateOptions,
} from '../sqlite-repo/node-repo';
import { createBookNodeSqliteRepository } from '../sqlite-repo/node-repo';
import type { DbTransaction } from '../lib/db';
import {
  withAtomicSyncTransaction,
  type AtomicSyncWriter,
} from './sync-helpers';

export interface PersistBookNodeUpdateInput {
  projectId: string;
  nodeId: string;
  updates: BookNodeUpdateData;
  syncPayload: Record<string, unknown>;
  guard?: AgentRuntimeNodeWriteGuard;
}

export type BookNodeAtomicTransactionRunner = <T>(
  projectId: string,
  work: (tx: DbTransaction, sync: AtomicSyncWriter) => Promise<T>,
) => Promise<T>;

/**
 * Shared manual/Agent node update boundary. The entity CAS and sync outbox
 * append happen in one renderer-owned transaction; callers must not wrap this
 * command in a separate freshness transaction.
 */
export function persistBookNodeUpdateWithSync(
  input: PersistBookNodeUpdateInput,
  runAtomic: BookNodeAtomicTransactionRunner = withAtomicSyncTransaction,
) {
  const options: BookNodeUpdateOptions | undefined = input.guard
    ? { expectedRevision: input.guard.expectedRevision }
    : undefined;
  return runAtomic(input.projectId, async (tx, sync) => {
    const result = await createBookNodeSqliteRepository(
      input.projectId,
      tx,
    ).update(input.nodeId, input.updates, options);
    if (!result) {
      throw new Error(
        `Book node ${input.nodeId} no longer exists in project ${input.projectId}.`,
      );
    }
    await sync(
      'node',
      'update',
      input.nodeId,
      input.projectId,
      input.syncPayload,
    );
    return result;
  });
}
