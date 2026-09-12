import { eq } from 'drizzle-orm';
import { committedProseDocIds } from '../prose-change-scope';

import { getDb, type DbClient, type DbTransaction } from '../../lib/db';
import { ProjectTable } from '../../schema/drizzle';
import {
  flushPendingAtomicSyncTransactions,
  trackAtomicSyncTransaction,
} from '../../services/atomic-sync-transaction-tracker';
import { observeLocalAuthoredReducerInTransaction } from '../reducer/sqlite-materializer';
import { productionSyncDomainMaterializationKernel } from '../reducer/production-domain-kernel';
import { SyncChangeBuilder } from './change-builder';
import { getSyncInstallationIdentity } from './installation-identity';
import { recordAuthoredChangeSetInTransaction } from './repository';
import type { SyncJournalClock, SyncWriterIdentitySource } from './writer-state';
import {
  ensureActiveSyncGenerationInTransaction,
  findActiveSyncGenerationInTransaction,
  type ActiveSyncGenerationIdentity,
  type SyncGenerationIdSource,
} from './sync-generation-repository';

export type AuthoredCommandKind = `${string}.${string}`;
export type DerivedTransactionReason = `${string}.${string}`;

export interface AuthoredTransactionContext {
  readonly tx: DbTransaction;
  readonly changes: SyncChangeBuilder;
  readonly origin: 'local';
  /** Present for every existing project; null only while creating a project. */
  readonly generation: ActiveSyncGenerationIdentity | null;
}

export interface AuthoredCommitEvent {
  readonly command: AuthoredCommandKind;
  readonly projectId: string;
  readonly syncGenerationId: string;
  readonly changeSetId: string;
  readonly proseDocIds?: readonly string[];
}

export interface AuthoredTransactionDependencies {
  readonly database: () => DbClient;
  readonly identity: () => Promise<SyncWriterIdentitySource>;
  readonly clock: () => SyncJournalClock;
  readonly syncGenerationIds: SyncGenerationIdSource;
  readonly observeAuthored?: typeof observeLocalAuthoredReducerInTransaction;
  readonly onCommitted?: (event: AuthoredCommitEvent) => void;
}

const commitListeners = new Set<(event: AuthoredCommitEvent) => void>();

function systemClock(): SyncJournalClock {
  const now = new Date();
  return { nowMs: now.getTime(), nowIso: now.toISOString() };
}

const observeLocalAuthoredWithProductionKernel: typeof observeLocalAuthoredReducerInTransaction =
  (tx, input) =>
    observeLocalAuthoredReducerInTransaction(tx, {
      ...input,
      validator: productionSyncDomainMaterializationKernel,
    });

const defaultDependencies: AuthoredTransactionDependencies = {
  database: getDb,
  identity: getSyncInstallationIdentity,
  clock: systemClock,
  syncGenerationIds: {
    createSyncGenerationId: () => globalThis.crypto.randomUUID(),
    createProjectSyncId: () => globalThis.crypto.randomUUID(),
  },
  observeAuthored: observeLocalAuthoredWithProductionKernel,
  onCommitted: notifyAuthoredChangeCommitted,
};

/** Post-commit only; Agent-owned transactions use afterDatabaseCommit. */
export function notifyAuthoredChangeCommitted(event: AuthoredCommitEvent): void {
  for (const listener of [...commitListeners]) {
    try {
      listener(event);
    } catch {
      console.warn('An authored commit observer failed after a successful commit.');
    }
  }
}

function assertCommand(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a namespaced lower-case identifier`);
  }
}

export function onAuthoredChangeCommitted(
  listener: (event: AuthoredCommitEvent) => void,
): () => void {
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
}

export function createAuthoredTransactionRunner(
  dependencies: AuthoredTransactionDependencies,
): <T>(
  projectId: string,
  command: AuthoredCommandKind,
  work: (context: AuthoredTransactionContext) => Promise<T>,
) => Promise<T> {
  return async function run<T>(
    projectId: string,
    command: AuthoredCommandKind,
    work: (context: AuthoredTransactionContext) => Promise<T>,
  ): Promise<T> {
    if (projectId.length === 0) throw new TypeError('projectId is required');
    assertCommand(command, 'authored command');
    const identity = await dependencies.identity();
    const clock = dependencies.clock();
    let committedEvent: AuthoredCommitEvent | null = null;

    const operation = dependencies.database().transaction(async (tx) => {
      const existingSyncGeneration = await findActiveSyncGenerationInTransaction(tx, projectId);
      const changes = new SyncChangeBuilder();
      const result = await work({ tx, changes, origin: 'local', generation: existingSyncGeneration });
      const projects = await tx
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectId))
        .limit(1);
      const projectDetached = projects.length === 0;
      const generation = existingSyncGeneration ?? (projectDetached
        ? null
        : await ensureActiveSyncGenerationInTransaction(tx, {
            projectId,
            nowIso: clock.nowIso,
            ids: dependencies.syncGenerationIds,
          }));
      if (!generation) {
        throw new Error(`authored transaction detached missing project ${projectId} without a SyncGeneration`);
      }
      const recorded = await recordAuthoredChangeSetInTransaction(
        tx,
        {
          projectId,
          projectSyncId: generation.projectSyncId,
          syncGenerationId: generation.syncGenerationId,
          identity,
          clock,
          allowDetachedProject: projectDetached,
        },
        changes,
      );
      await (dependencies.observeAuthored ?? observeLocalAuthoredWithProductionKernel)(tx, {
        changeSet: recorded.changeSet,
        clock,
      });
      committedEvent = {
        command,
        projectId,
        syncGenerationId: generation.syncGenerationId,
        changeSetId: recorded.changeSet.changeSetId,
        proseDocIds: committedProseDocIds(recorded.changeSet.mutations),
      };
      return result;
    });

    const result = await trackAtomicSyncTransaction(operation);
    if (committedEvent) dependencies.onCommitted?.(committedEvent);
    return result;
  };
}

export const runAuthoredTransaction = createAuthoredTransactionRunner(defaultDependencies);

/** Explicit path for device-local or rebuildable writes that must not journal. */
export function runDerivedTransaction<T>(
  reason: DerivedTransactionReason,
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  assertCommand(reason, 'derived transaction reason');
  return trackAtomicSyncTransaction(getDb().transaction(work));
}

export { flushPendingAtomicSyncTransactions };
