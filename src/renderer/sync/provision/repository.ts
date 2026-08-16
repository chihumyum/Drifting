import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import type { DbClient, DbTransaction } from '../../lib/db';
import {
  SyncAppAuthorityTable,
  SyncCheckpointTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import type { CloudSyncProviderMode } from '../app-authority';
import type { ProviderBinding } from '../protocol';

const PENDING_STATES = ['connecting', 'publishing-genesis'] as const;

export interface PendingSyncGenerationProvision {
  readonly mode: CloudSyncProviderMode;
  readonly authorityGeneration: number;
  readonly providerAccountId: string;
  readonly accountSubject: string;
  readonly credentialSecretRef: string;
  readonly projectId: string;
  readonly syncGenerationId: string;
  readonly projectSyncId: string;
  readonly generationNumber: number;
  readonly bindingState: (typeof PENDING_STATES)[number];
  readonly binding: ProviderBinding;
}

function namespace(mode: CloudSyncProviderMode): string {
  return mode === 'google-drive' ? 'appDataFolder' : 'immutable-object-log';
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

export class SyncGenerationProvisionRepository {
  constructor(
    private readonly db: DbClient,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Repairs the narrow crash window where a SyncGeneration committed just after an App
   * authority transition, then returns only durable pending bindings. Ready
   * runtimes are deliberately outside this repository.
   */
  async ensureAndListPending(
    expectedMode: CloudSyncProviderMode,
  ): Promise<readonly PendingSyncGenerationProvision[]> {
    return this.db.transaction(async (tx) => {
      const [authority] = await tx.select().from(SyncAppAuthorityTable).limit(1);
      if (
        !authority ||
        authority.transitionState !== 'stable' ||
        authority.mode !== expectedMode
      ) {
        return [];
      }
      const [account] = await tx
        .select()
        .from(SyncProviderAccountTable)
        .where(
          and(
            eq(SyncProviderAccountTable.providerKind, expectedMode),
            eq(SyncProviderAccountTable.authorityGeneration, authority.generation),
          ),
        )
        .limit(1);
      if (!account) {
        throw new Error('Stable cloud authority is missing its provider account');
      }

      const unbound = await tx
        .select({ syncGenerationId: SyncGenerationTable.syncGenerationId })
        .from(SyncGenerationTable)
        .leftJoin(
          SyncProviderBindingTable,
          eq(SyncProviderBindingTable.syncGenerationId, SyncGenerationTable.syncGenerationId),
        )
        .where(
          and(
            eq(SyncGenerationTable.status, 'active'),
            isNotNull(SyncGenerationTable.projectId),
            isNull(SyncProviderBindingTable.syncGenerationId),
          ),
        );
      const nowIso = this.nowIso();
      for (const { syncGenerationId } of unbound) {
        await tx.insert(SyncProviderBindingTable).values({
          syncGenerationId,
          providerAccountId: account.id,
          providerNamespace: namespace(expectedMode),
          providerGenerationRef: null,
          state: 'connecting',
          connectedAt: null,
          updatedAt: nowIso,
        });
      }

      const rows = await tx
        .select({
          providerAccountId: SyncProviderBindingTable.providerAccountId,
          providerNamespace: SyncProviderBindingTable.providerNamespace,
          bindingState: SyncProviderBindingTable.state,
          projectId: SyncGenerationTable.projectId,
          syncGenerationId: SyncGenerationTable.syncGenerationId,
          projectSyncId: SyncGenerationTable.projectSyncId,
          generationNumber: SyncGenerationTable.generationNumber,
        })
        .from(SyncProviderBindingTable)
        .innerJoin(
          SyncGenerationTable,
          eq(SyncGenerationTable.syncGenerationId, SyncProviderBindingTable.syncGenerationId),
        )
        .where(
          and(
            eq(SyncProviderBindingTable.providerAccountId, account.id),
            eq(SyncGenerationTable.status, 'active'),
            inArray(SyncProviderBindingTable.state, [...PENDING_STATES]),
          ),
        );
      return rows.flatMap((row): PendingSyncGenerationProvision[] => {
        if (row.projectId === null) return [];
        const bindingState = row.bindingState as PendingSyncGenerationProvision['bindingState'];
        return [{
          mode: expectedMode,
          authorityGeneration: authority.generation,
          providerAccountId: row.providerAccountId,
          accountSubject: requireNonEmpty(account.accountSubjectId, 'accountSubjectId'),
          credentialSecretRef: requireNonEmpty(
            account.credentialSecretRef,
            'credentialSecretRef',
          ),
          projectId: row.projectId,
          syncGenerationId: row.syncGenerationId,
          projectSyncId: row.projectSyncId,
          generationNumber: row.generationNumber,
          bindingState,
          binding: {
            bindingId: `provision:${authority.generation}:${row.syncGenerationId}`,
            syncGenerationId: row.syncGenerationId,
            accountRef: account.accountSubjectId,
            secretRef: account.credentialSecretRef,
            authorityGeneration: authority.generation,
          },
        }];
      });
    });
  }

  async markReady(input: {
    pending: PendingSyncGenerationProvision;
    genesisCheckpointId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.assertStillOwned(tx, input.pending);
      const [checkpoint] = await tx
        .select({ state: SyncCheckpointTable.state })
        .from(SyncCheckpointTable)
        .where(
          and(
            eq(SyncCheckpointTable.checkpointId, input.genesisCheckpointId),
            eq(SyncCheckpointTable.syncGenerationId, input.pending.syncGenerationId),
            eq(SyncCheckpointTable.kind, 'genesis'),
          ),
        )
        .limit(1);
      if (checkpoint?.state !== 'published') {
        throw new Error('SyncGeneration binding cannot become ready before genesis is published');
      }
      const completedAt = this.nowIso();
      await tx
        .update(SyncProviderBindingTable)
        .set({ state: 'ready', connectedAt: completedAt, updatedAt: completedAt })
        .where(eq(SyncProviderBindingTable.syncGenerationId, input.pending.syncGenerationId));
    });
  }

  private async assertStillOwned(
    tx: DbTransaction,
    pending: PendingSyncGenerationProvision,
  ): Promise<void> {
    const [row] = await tx
      .select({
        mode: SyncAppAuthorityTable.mode,
        generation: SyncAppAuthorityTable.generation,
        transitionState: SyncAppAuthorityTable.transitionState,
        providerAccountId: SyncProviderBindingTable.providerAccountId,
        bindingState: SyncProviderBindingTable.state,
        status: SyncGenerationTable.status,
        projectId: SyncGenerationTable.projectId,
      })
      .from(SyncProviderBindingTable)
      .innerJoin(
        SyncGenerationTable,
        eq(SyncGenerationTable.syncGenerationId, SyncProviderBindingTable.syncGenerationId),
      )
      .innerJoin(SyncAppAuthorityTable, eq(SyncAppAuthorityTable.id, 'app'))
      .where(eq(SyncProviderBindingTable.syncGenerationId, pending.syncGenerationId))
      .limit(1);
    if (
      !row ||
      row.transitionState !== 'stable' ||
      row.mode !== pending.mode ||
      row.generation !== pending.authorityGeneration ||
      row.providerAccountId !== pending.providerAccountId ||
      row.status !== 'active' ||
      row.projectId !== pending.projectId ||
      !PENDING_STATES.includes(row.bindingState as (typeof PENDING_STATES)[number])
    ) {
      throw new Error('SyncGeneration provisioning lost its App authority ownership');
    }
  }
}
