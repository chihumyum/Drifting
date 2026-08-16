import type { DbExecutor, DbTransaction } from '../../../lib/db';
import { observeLocalAuthoredReducerInTransaction } from '../../../sync/reducer/sqlite-materializer';
import { productionSyncDomainMaterializationKernel } from '../../../sync/reducer/production-domain-kernel';
import {
  appendAuthoredDomainMutation,
  defaultSyncGenerationIdSource,
  ensureActiveSyncGenerationInTransaction,
  getSyncInstallationIdentity,
  recordAuthoredChangeSetInTransaction,
  SyncChangeBuilder,
  type AuthoredDomainMutation,
  type RecordedSyncChangeSet,
  type SyncGenerationIdSource,
  type SyncWriterIdentitySource,
} from '../../../sync/journal';

export interface AgentAuthoredJournalDependencies {
  readonly identity: () => Promise<SyncWriterIdentitySource>;
  readonly syncGenerationIds: SyncGenerationIdSource;
}

export interface AgentAuthoredJournal {
  createChangeSet(): SyncChangeBuilder;
  appendDomainMutation(
    changes: SyncChangeBuilder,
    mutation: AuthoredDomainMutation,
  ): void;
  record(
    tx: DbExecutor,
    input: {
      projectId: string;
      changes: SyncChangeBuilder;
      committedAt: string;
    },
  ): Promise<RecordedSyncChangeSet>;
}

const defaultDependencies: AgentAuthoredJournalDependencies = {
  identity: getSyncInstallationIdentity,
  syncGenerationIds: defaultSyncGenerationIdSource,
};

function journalClock(committedAt: string): { nowMs: number; nowIso: string } {
  const nowMs = Date.parse(committedAt);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Agent authored transaction committedAt must be an ISO timestamp');
  }
  return { nowMs, nowIso: committedAt };
}

/**
 * Provider-neutral journal boundary for Agent-owned outer SQLite transactions.
 * The Agent runtime already owns freshness/receipt transactions, so it cannot
 * enter the public transaction runner again. Instead, all mutations append to
 * one builder and this boundary records the complete change-set immediately
 * before that existing transaction commits.
 */
export function createAgentAuthoredJournal(
  dependencies: AgentAuthoredJournalDependencies = defaultDependencies,
): AgentAuthoredJournal {
  return {
    createChangeSet: () => new SyncChangeBuilder(),
    appendDomainMutation: appendAuthoredDomainMutation,
    async record(tx, input) {
      const transaction = tx as DbTransaction;
      const clock = journalClock(input.committedAt);
      const generation = await ensureActiveSyncGenerationInTransaction(transaction, {
        projectId: input.projectId,
        nowIso: clock.nowIso,
        ids: dependencies.syncGenerationIds,
      });
      const recorded = await recordAuthoredChangeSetInTransaction(
        transaction,
        {
          projectId: input.projectId,
          projectSyncId: generation.projectSyncId,
          syncGenerationId: generation.syncGenerationId,
          identity: await dependencies.identity(),
          clock,
        },
        input.changes,
      );
      // Local and remote writes must cross the same semantic boundary. The
      // local path observes rows that the Agent already wrote, while the
      // remote path asks this kernel to materialize them; validation and
      // conflict decisions are deliberately identical.
      await observeLocalAuthoredReducerInTransaction(transaction, {
        changeSet: recorded.changeSet,
        clock,
        validator: productionSyncDomainMaterializationKernel,
      });
      return recorded;
    },
  };
}

export const agentAuthoredJournal = createAgentAuthoredJournal();

export function appendAgentDomainMutation(
  journal: AgentAuthoredJournal,
  changes: SyncChangeBuilder,
  projectId: string,
  mutation: Omit<AuthoredDomainMutation, 'projectId'>,
): Promise<void> {
  journal.appendDomainMutation(changes, { ...mutation, projectId });
  return Promise.resolve();
}
