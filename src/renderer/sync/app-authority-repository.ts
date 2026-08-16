import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { getDb, type DbClient, type DbExecutor, type DbTransaction } from '../lib/db';
import {
  SyncAppAuthorityTable,
  SyncConnectAttemptTable,
  SyncConnectGenerationAttemptTable,
  SyncCursorTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
  SyncGenerationTable,
} from '../schema/drizzle';
import type { ProviderBinding } from './protocol';
import {
  assertSyncAppAuthority,
  beginSyncProviderTransition,
  blockSyncProviderTransition,
  cancelSyncProviderTransition,
  completeSyncProviderTransition,
  resumeSyncProviderTransition,
  type CloudSyncProviderMode,
  type SyncAppAuthority,
  type SyncProviderMode,
} from './app-authority';

export type SyncConnectAttemptKind =
  | 'connect'
  | 'switch-provider'
  | 'disconnect'
  | 'restore';

export type SyncConnectAttemptState =
  | 'preparing'
  | 'discovering'
  | 'publishing-genesis'
  | 'restoring'
  | 'activating'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type SyncConnectGenerationAttemptState =
  | 'pending'
  | 'capturing'
  | 'publishing'
  | 'restoring'
  | 'committed'
  | 'activating'
  | 'activated'
  | 'failed'
  | 'cancelled';

export interface SyncProviderTransitionIdSource {
  createAttemptId(): string;
  createProviderAccountId(): string;
  createTargetSyncGenerationId(): string;
}

const defaultIds: SyncProviderTransitionIdSource = Object.freeze({
  createAttemptId: () => `sync-attempt-${uuidv7()}`,
  createProviderAccountId: () => `sync-account-${uuidv7()}`,
  createTargetSyncGenerationId: () => `sync-generation-${uuidv7()}`,
});

interface ActiveSyncGenerationRow {
  syncGenerationId: string;
  projectId: string | null;
  projectSyncId: string;
  generationNumber: number;
}

export interface SyncGenerationTransitionPlan {
  sourceSyncGenerationId: string;
  targetSyncGenerationId: string | null;
}

export interface SyncProviderTransitionAttempt {
  attemptId: string;
  kind: SyncConnectAttemptKind;
  sourceMode: SyncProviderMode;
  targetMode: SyncProviderMode;
  authorityGeneration: number;
  generations: readonly SyncGenerationTransitionPlan[];
}

export interface BeginSyncProviderTransitionInput {
  targetMode: SyncProviderMode;
  /** Opaque Google/hosted subject identifier. Never an access token. */
  accountSubjectId?: string;
  /** Native secure-storage reference. Never a bearer or refresh token. */
  credentialSecretRef?: string;
  /** Optional deterministic ids for crash/fault tests. */
  attemptId?: string;
  nowIso: string;
}

export interface CommittedSyncGenerationInput {
  attemptId: string;
  sourceSyncGenerationId: string;
  sourceCheckpointId?: string | null;
  /** Required for every cloud target; must already exist in sync_remote_object. */
  commitMarkerObjectId?: string | null;
  nowIso: string;
}

export interface StageRestoreSyncGenerationInput {
  attemptId: string;
  syncGenerationId: string;
  projectSyncId: string;
  projectId: string;
  nowIso: string;
}

export interface ActivatedProviderBindingInput {
  syncGenerationId: string;
  providerNamespace: string;
  providerGenerationRef: string | null;
}

export interface CompleteSyncProviderTransitionInput {
  attemptId: string;
  /** Required exactly once for a cloud target; omitted for local. */
  providerAccountId?: string;
  bindings?: readonly ActivatedProviderBindingInput[];
  nowIso: string;
}

export interface ActiveProviderRuntimeBinding {
  mode: CloudSyncProviderMode;
  providerNamespace: string;
  providerGenerationRef: string | null;
  binding: ProviderBinding;
}

/** Stable provider binding identity shared by activation and runtime cursor ownership. */
export function activeProviderBindingId(authorityGeneration: number, syncGenerationId: string): string {
  return `binding:${authorityGeneration}:${syncGenerationId}`;
}

function requireNonEmpty(value: string | undefined | null, label: string): string {
  if (!value?.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

function assertExactKeys(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    expectedSet.size !== expected.length ||
    actualSet.size !== actual.length ||
    expectedSet.size !== actualSet.size ||
    [...expectedSet].some((value) => !actualSet.has(value))
  ) {
    throw new Error(`${label} must cover every active SyncGeneration exactly once`);
  }
}

function inferAttemptKind(source: SyncProviderMode, target: SyncProviderMode): SyncConnectAttemptKind {
  if (source === 'local') return 'connect';
  if (target === 'local') return 'disconnect';
  return 'switch-provider';
}

function mapAuthority(row: typeof SyncAppAuthorityTable.$inferSelect): SyncAppAuthority {
  const authority = {
    id: row.id,
    mode: row.mode,
    generation: row.generation,
    transitionState: row.transitionState,
    targetMode: row.targetMode,
    attemptId: row.attemptId,
    updatedAt: row.updatedAt,
  } as SyncAppAuthority;
  assertSyncAppAuthority(authority);
  return authority;
}

async function readAuthority(executor: DbExecutor): Promise<SyncAppAuthority> {
  const row = (await executor.select().from(SyncAppAuthorityTable).limit(1))[0];
  if (!row) throw new Error('Sync App authority is missing');
  return mapAuthority(row);
}

async function listActiveSyncGenerations(executor: DbExecutor): Promise<ActiveSyncGenerationRow[]> {
  return executor
    .select({
      syncGenerationId: SyncGenerationTable.syncGenerationId,
      projectId: SyncGenerationTable.projectId,
      projectSyncId: SyncGenerationTable.projectSyncId,
      generationNumber: SyncGenerationTable.generationNumber,
    })
    .from(SyncGenerationTable)
    .where(eq(SyncGenerationTable.status, 'active'));
}

function providerNamespace(mode: CloudSyncProviderMode): string {
  return mode === 'google-drive' ? 'appDataFolder' : 'immutable-object-log';
}

/**
 * Atomically records that a newly-created local SyncGeneration still needs its cloud
 * genesis. No native/network work is allowed here: project creation must stay
 * local and fully usable while provisioning proceeds after commit.
 */
export async function stagePendingProviderBindingForNewSyncGenerationInTransaction(
  tx: DbTransaction,
  input: { syncGenerationId: string; nowIso: string },
): Promise<boolean> {
  const authority = await readAuthority(tx);
  if (authority.transitionState !== 'stable' || authority.mode === 'local') return false;
  const [account] = await tx
    .select()
    .from(SyncProviderAccountTable)
    .where(
      and(
        eq(SyncProviderAccountTable.providerKind, authority.mode),
        eq(SyncProviderAccountTable.authorityGeneration, authority.generation),
      ),
    )
    .limit(1);
  // A corrupt or interrupted authority transition must not roll back the authored project.
  // The active unbound SyncGeneration remains discoverable as pending by the provisioner.
  if (!account) return false;
  const [existing] = await tx
    .select({ providerAccountId: SyncProviderBindingTable.providerAccountId })
    .from(SyncProviderBindingTable)
    .where(eq(SyncProviderBindingTable.syncGenerationId, input.syncGenerationId))
    .limit(1);
  if (existing) {
    if (existing.providerAccountId !== account.id) {
      throw new Error('New SyncGeneration already belongs to another provider authority');
    }
    return true;
  }
  await tx.insert(SyncProviderBindingTable).values({
    syncGenerationId: input.syncGenerationId,
    providerAccountId: account.id,
    providerNamespace: providerNamespace(authority.mode as CloudSyncProviderMode),
    providerGenerationRef: null,
    state: 'connecting',
    connectedAt: null,
    updatedAt: input.nowIso,
  });
  return true;
}

async function requireAttempt(
  executor: DbExecutor,
  attemptId: string,
): Promise<typeof SyncConnectAttemptTable.$inferSelect> {
  const row = (await executor
    .select()
    .from(SyncConnectAttemptTable)
    .where(eq(SyncConnectAttemptTable.attemptId, attemptId))
    .limit(1))[0];
  if (!row) throw new Error(`Unknown sync provider transition ${attemptId}`);
  return row;
}

async function requireOwnedAttempt(
  executor: DbExecutor,
  attemptId: string,
): Promise<{
  authority: Exclude<SyncAppAuthority, { transitionState: 'stable' }>;
  attempt: typeof SyncConnectAttemptTable.$inferSelect;
}> {
  const authority = await readAuthority(executor);
  if (authority.transitionState === 'stable' || authority.attemptId !== attemptId) {
    throw new Error('Sync provider transition attempt does not own the App authority');
  }
  const attempt = await requireAttempt(executor, attemptId);
  if (
    attempt.authorityGeneration !== authority.generation ||
    attempt.targetMode !== authority.targetMode
  ) {
    throw new Error('Sync provider transition attempt does not match App authority');
  }
  return { authority, attempt };
}

async function writeAuthority(tx: DbTransaction, authority: SyncAppAuthority): Promise<void> {
  await tx
    .update(SyncAppAuthorityTable)
    .set({
      mode: authority.mode,
      generation: authority.generation,
      transitionState: authority.transitionState,
      targetMode: authority.targetMode,
      attemptId: authority.attemptId,
      updatedAt: authority.updatedAt,
    })
    .where(eq(SyncAppAuthorityTable.id, 'app'));
}

async function completeTransitionInTransaction(
  tx: DbTransaction,
  input: CompleteSyncProviderTransitionInput,
  ids: SyncProviderTransitionIdSource,
): Promise<SyncAppAuthority> {
  const { authority, attempt } = await requireOwnedAttempt(tx, input.attemptId);
  if (authority.transitionState === 'blocked') {
    throw new Error('Blocked sync provider transition must resume before completion');
  }
  const generationAttempts = await tx
    .select()
    .from(SyncConnectGenerationAttemptTable)
    .where(eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId));
  if (generationAttempts.some((item) => item.state !== 'committed')) {
    throw new Error('Every SyncGeneration must have a durable commit before provider activation');
  }

  if (attempt.kind === 'switch-provider') {
    for (const item of generationAttempts) {
      if (!item.targetSyncGenerationId) throw new Error('Provider switch is missing target SyncGeneration');
      await tx
        .update(SyncGenerationTable)
        .set({ status: 'retired', retiredAt: input.nowIso, updatedAt: input.nowIso })
        .where(eq(SyncGenerationTable.syncGenerationId, item.sourceSyncGenerationId));
      await tx
        .update(SyncGenerationTable)
        .set({ status: 'active', updatedAt: input.nowIso })
        .where(eq(SyncGenerationTable.syncGenerationId, item.targetSyncGenerationId));
    }
  }

  for (const item of generationAttempts) {
    await tx
      .update(SyncConnectGenerationAttemptTable)
      .set({
        state: 'activated',
        activationReceipt: `activate:${input.attemptId}:${item.targetSyncGenerationId ?? item.sourceSyncGenerationId}`,
        activatedAt: input.nowIso,
        updatedAt: input.nowIso,
      })
      .where(
        and(
          eq(SyncConnectGenerationAttemptTable.attemptId, item.attemptId),
          eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, item.sourceSyncGenerationId),
        ),
      );
  }

  await tx
    .update(SyncConnectAttemptTable)
    .set({
      state: 'completed',
      completedAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .where(eq(SyncConnectAttemptTable.attemptId, input.attemptId));

  const currentBindings = await tx
    .select({ syncGenerationId: SyncProviderBindingTable.syncGenerationId })
    .from(SyncProviderBindingTable);
  if (currentBindings.length > 0) {
    await tx
      .delete(SyncCursorTable)
      .where(inArray(SyncCursorTable.syncGenerationId, currentBindings.map((item) => item.syncGenerationId)));
    await tx.delete(SyncProviderBindingTable);
  }
  await tx.delete(SyncProviderAccountTable);

  const completed = completeSyncProviderTransition(authority, {
    attemptId: input.attemptId,
    expectedSyncGenerationIds: generationAttempts.map((item) => item.sourceSyncGenerationId),
    readySyncGenerations: generationAttempts.map((item) => ({
      syncGenerationId: item.sourceSyncGenerationId,
      receiptId: `activate:${input.attemptId}:${item.targetSyncGenerationId ?? item.sourceSyncGenerationId}`,
    })),
    now: input.nowIso,
  });
  await writeAuthority(tx, completed);

  if (completed.mode === 'local') {
    if (input.providerAccountId !== undefined || (input.bindings?.length ?? 0) > 0) {
      throw new Error('A local provider transition cannot activate cloud bindings');
    }
    return completed;
  }

  const providerAccountId = input.providerAccountId ?? ids.createProviderAccountId();
  requireNonEmpty(providerAccountId, 'providerAccountId');
  const bindings = input.bindings ?? [];
  const activeSyncGenerations = await listActiveSyncGenerations(tx);
  const provisionsLateSyncGenerations = attempt.kind === 'connect' || attempt.kind === 'restore';
  const requiredBindingSyncGenerationIds =
    provisionsLateSyncGenerations
      ? generationAttempts.map((generation) => generation.sourceSyncGenerationId)
      : activeSyncGenerations.map((generation) => generation.syncGenerationId);
  assertExactKeys(
    requiredBindingSyncGenerationIds,
    bindings.map((binding) => binding.syncGenerationId),
    'bindings',
  );
  for (const binding of bindings) requireNonEmpty(binding.providerNamespace, 'providerNamespace');

  const accountSubjectId = requireNonEmpty(
    attempt.targetAccountSubjectId,
    'targetAccountSubjectId',
  );
  const credentialSecretRef = requireNonEmpty(
    attempt.targetCredentialSecretRef,
    'targetCredentialSecretRef',
  );
  await tx.insert(SyncProviderAccountTable).values({
    id: providerAccountId,
    singletonKey: 1,
    authorityId: 'app',
    providerKind: completed.mode,
    authorityGeneration: completed.generation,
    accountSubjectId,
    credentialSecretRef,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  });
  for (const binding of bindings) {
    await tx.insert(SyncProviderBindingTable).values({
      syncGenerationId: binding.syncGenerationId,
      providerAccountId,
      providerNamespace: binding.providerNamespace,
      providerGenerationRef: binding.providerGenerationRef,
      state: 'ready',
      connectedAt: input.nowIso,
      updatedAt: input.nowIso,
    });
  }
  if (provisionsLateSyncGenerations) {
    const readySyncGenerationIds = new Set(bindings.map((binding) => binding.syncGenerationId));
    for (const generation of activeSyncGenerations) {
      if (readySyncGenerationIds.has(generation.syncGenerationId)) continue;
      await tx.insert(SyncProviderBindingTable).values({
        syncGenerationId: generation.syncGenerationId,
        providerAccountId,
        providerNamespace: providerNamespace(completed.mode),
        providerGenerationRef: null,
        state: 'connecting',
        connectedAt: null,
        updatedAt: input.nowIso,
      });
    }
  }
  return completed;
}

function requireCloudCredentials(input: BeginSyncProviderTransitionInput): {
  accountSubjectId: string;
  credentialSecretRef: string;
} {
  if (input.targetMode === 'local') {
    if (input.accountSubjectId !== undefined || input.credentialSecretRef !== undefined) {
      throw new Error('A local sync target cannot retain provider credentials');
    }
    return { accountSubjectId: '', credentialSecretRef: '' };
  }
  return {
    accountSubjectId: requireNonEmpty(input.accountSubjectId, 'accountSubjectId'),
    credentialSecretRef: requireNonEmpty(input.credentialSecretRef, 'credentialSecretRef'),
  };
}

export function createSyncAppAuthorityRepository(
  database: DbClient = getDb(),
  ids: SyncProviderTransitionIdSource = defaultIds,
) {
  return {
    read(): Promise<SyncAppAuthority> {
      return readAuthority(database);
    },

    async begin(input: BeginSyncProviderTransitionInput): Promise<SyncProviderTransitionAttempt> {
      return database.transaction(async (tx) => {
        const current = await readAuthority(tx);
        const attemptId = input.attemptId ?? ids.createAttemptId();
        const next = beginSyncProviderTransition(current, {
          targetMode: input.targetMode,
          attemptId,
          now: input.nowIso,
        });
        const kind = inferAttemptKind(current.mode, input.targetMode);
        const credentials = requireCloudCredentials(input);
        const activeSyncGenerations = await listActiveSyncGenerations(tx);

        await tx.insert(SyncConnectAttemptTable).values({
          attemptId,
          authorityGeneration: current.generation,
          kind,
          targetMode: input.targetMode,
          targetAccountSubjectId:
            input.targetMode === 'local' ? null : credentials.accountSubjectId,
          targetCredentialSecretRef:
            input.targetMode === 'local' ? null : credentials.credentialSecretRef,
          state: 'preparing',
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        });

        const generationPlans: SyncGenerationTransitionPlan[] = [];
        for (const source of activeSyncGenerations) {
          let targetSyncGenerationId: string | null = null;
          if (kind === 'switch-provider') {
            targetSyncGenerationId = ids.createTargetSyncGenerationId();
            await tx.insert(SyncGenerationTable).values({
              syncGenerationId: targetSyncGenerationId,
              projectId: source.projectId,
              projectSyncId: source.projectSyncId,
              generationNumber: source.generationNumber + 1,
              protocolVersion: 1,
              domainSchemaVersion: 1,
              status: 'staged',
              createdAt: input.nowIso,
              updatedAt: input.nowIso,
            });
          }

          await tx.insert(SyncConnectGenerationAttemptTable).values({
            attemptId,
            sourceSyncGenerationId: source.syncGenerationId,
            targetSyncGenerationId,
            state: 'pending',
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
          });
          generationPlans.push({
            sourceSyncGenerationId: source.syncGenerationId,
            targetSyncGenerationId,
          });
        }

        await writeAuthority(tx, next);
        return {
          attemptId,
          kind,
          sourceMode: current.mode,
          targetMode: input.targetMode,
          authorityGeneration: current.generation,
          generations: generationPlans,
        };
      });
    },

    /**
     * Add one authenticated remote SyncGeneration to an owned Google Drive connect transition.
     * The SyncGeneration remains staged and project-less until snapshot restore validates
     * and materializes it. Replaying the exact registration is idempotent.
     */
    async stageRestoreSyncGeneration(input: StageRestoreSyncGenerationInput): Promise<void> {
      await database.transaction(async (tx) => {
        const { attempt } = await requireOwnedAttempt(tx, input.attemptId);
        if (attempt.kind !== 'connect' || attempt.targetMode === 'local') {
          throw new Error('Only a cloud connect transition can stage a remote SyncGeneration');
        }
        const syncGenerationId = requireNonEmpty(input.syncGenerationId, 'syncGenerationId');
        const projectSyncId = requireNonEmpty(input.projectSyncId, 'projectSyncId');
        const projectId = requireNonEmpty(input.projectId, 'projectId');
        const [existing] = await tx
          .select()
          .from(SyncGenerationTable)
          .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId))
          .limit(1);
        if (existing) {
          const unresolvedProjectSync = `restore-pending:${syncGenerationId}`;
          if (
            existing.projectSyncId === unresolvedProjectSync &&
            existing.projectId === null &&
            existing.status === 'staged'
          ) {
            const generations = await tx
              .select({ generationNumber: SyncGenerationTable.generationNumber })
              .from(SyncGenerationTable)
              .where(eq(SyncGenerationTable.projectSyncId, projectSyncId));
            const generationNumber =
              generations.reduce((highest, row) => Math.max(highest, row.generationNumber), 0) + 1;
            await tx
              .update(SyncGenerationTable)
              .set({ projectSyncId, generationNumber, updatedAt: input.nowIso })
              .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId));
          } else if (
            existing.projectSyncId !== projectSyncId ||
            !(
              (existing.projectId === null && existing.status === 'staged') ||
              (existing.projectId === projectId && existing.status === 'active')
            )
          ) {
            throw new Error('Recovered SyncGeneration identity conflicts with local state');
          }
        } else {
          const generations = await tx
            .select({ generationNumber: SyncGenerationTable.generationNumber })
            .from(SyncGenerationTable)
            .where(eq(SyncGenerationTable.projectSyncId, projectSyncId));
          const generationNumber =
            generations.reduce((highest, row) => Math.max(highest, row.generationNumber), 0) + 1;
          await tx.insert(SyncGenerationTable).values({
            syncGenerationId,
            projectId: null,
            projectSyncId,
            generationNumber,
            protocolVersion: 1,
            domainSchemaVersion: 1,
            status: 'staged',
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
          });
        }

        const [child] = await tx
          .select()
          .from(SyncConnectGenerationAttemptTable)
          .where(
            and(
              eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId),
              eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, syncGenerationId),
            ),
          )
          .limit(1);
        if (child) {
          if (child.targetSyncGenerationId !== null) {
            throw new Error('Recovered SyncGeneration cannot be a provider-switch target');
          }
          return;
        }
        await tx.insert(SyncConnectGenerationAttemptTable).values({
          attemptId: input.attemptId,
          sourceSyncGenerationId: syncGenerationId,
          targetSyncGenerationId: null,
          state: 'restoring',
          createdAt: input.nowIso,
          updatedAt: input.nowIso,
        });
      });
    },

    async setAttemptState(input: {
      attemptId: string;
      state: Exclude<SyncConnectAttemptState, 'completed' | 'failed' | 'cancelled'>;
      nowIso: string;
    }): Promise<void> {
      await database.transaction(async (tx) => {
        const { authority, attempt } = await requireOwnedAttempt(tx, input.attemptId);
        if (attempt.state === 'completed' || attempt.state === 'failed' || attempt.state === 'cancelled') {
          throw new Error('Terminal sync provider transition cannot advance');
        }
        if (input.state === 'blocked') {
          await writeAuthority(
            tx,
            blockSyncProviderTransition(authority, {
              attemptId: input.attemptId,
              now: input.nowIso,
            }),
          );
        }
        await tx
          .update(SyncConnectAttemptTable)
          .set({ state: input.state, errorCode: null, updatedAt: input.nowIso })
          .where(eq(SyncConnectAttemptTable.attemptId, input.attemptId));
      });
    },

    async resume(input: { attemptId: string; nowIso: string }): Promise<void> {
      await database.transaction(async (tx) => {
        const { authority } = await requireOwnedAttempt(tx, input.attemptId);
        await writeAuthority(
          tx,
          resumeSyncProviderTransition(authority, {
            attemptId: input.attemptId,
            now: input.nowIso,
          }),
        );
        await tx
          .update(SyncConnectAttemptTable)
          .set({ state: 'preparing', errorCode: null, updatedAt: input.nowIso })
          .where(eq(SyncConnectAttemptTable.attemptId, input.attemptId));
      });
    },

    async setSyncGenerationState(input: {
      attemptId: string;
      sourceSyncGenerationId: string;
      state: Exclude<SyncConnectGenerationAttemptState, 'committed' | 'activated'>;
      errorCode?: string | null;
      nowIso: string;
    }): Promise<void> {
      await database.transaction(async (tx) => {
        await requireOwnedAttempt(tx, input.attemptId);
        const row = (await tx
          .select({ state: SyncConnectGenerationAttemptTable.state })
          .from(SyncConnectGenerationAttemptTable)
          .where(
            and(
              eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId),
              eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, input.sourceSyncGenerationId),
            ),
          )
          .limit(1))[0];
        if (!row) throw new Error('Unknown SyncGeneration transition attempt');
        if (row.state === 'activated') throw new Error('Activated SyncGeneration transition is immutable');
        await tx
          .update(SyncConnectGenerationAttemptTable)
          .set({ state: input.state, errorCode: input.errorCode ?? null, updatedAt: input.nowIso })
          .where(
            and(
              eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId),
              eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, input.sourceSyncGenerationId),
            ),
          );
      });
    },

    async markSyncGenerationCommitted(input: CommittedSyncGenerationInput): Promise<void> {
      await database.transaction(async (tx) => {
        const { attempt } = await requireOwnedAttempt(tx, input.attemptId);
        if (attempt.targetMode !== 'local') {
          requireNonEmpty(input.commitMarkerObjectId, 'commitMarkerObjectId');
        }
        await tx
          .update(SyncConnectGenerationAttemptTable)
          .set({
            sourceCheckpointId: input.sourceCheckpointId ?? null,
            commitMarkerObjectId: input.commitMarkerObjectId ?? null,
            state: 'committed',
            errorCode: null,
            updatedAt: input.nowIso,
          })
          .where(
            and(
              eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId),
              eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, input.sourceSyncGenerationId),
            ),
          );
        const row = (await tx
          .select({ state: SyncConnectGenerationAttemptTable.state })
          .from(SyncConnectGenerationAttemptTable)
          .where(
            and(
              eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId),
              eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, input.sourceSyncGenerationId),
            ),
          )
          .limit(1))[0];
        if (row?.state !== 'committed') throw new Error('Unknown SyncGeneration transition attempt');
      });
    },

    async complete(input: CompleteSyncProviderTransitionInput): Promise<SyncAppAuthority> {
      return database.transaction((tx) => completeTransitionInTransaction(tx, input, ids));
    },

    /** Used by atomic multi-SyncGeneration restore after materialization in the same SQLite transaction. */
    completeInTransaction(
      tx: DbTransaction,
      input: CompleteSyncProviderTransitionInput,
    ): Promise<SyncAppAuthority> {
      return completeTransitionInTransaction(tx, input, ids);
    },

    async block(input: { attemptId: string; errorCode: string; nowIso: string }): Promise<void> {
      await database.transaction(async (tx) => {
        const { authority } = await requireOwnedAttempt(tx, input.attemptId);
        requireNonEmpty(input.errorCode, 'errorCode');
        await writeAuthority(
          tx,
          blockSyncProviderTransition(authority, {
            attemptId: input.attemptId,
            now: input.nowIso,
          }),
        );
        await tx
          .update(SyncConnectAttemptTable)
          .set({ state: 'blocked', errorCode: input.errorCode, updatedAt: input.nowIso })
          .where(eq(SyncConnectAttemptTable.attemptId, input.attemptId));
      });
    },

    async cancel(input: { attemptId: string; nowIso: string }): Promise<{ secretRef: string | null }> {
      return database.transaction(async (tx) => {
        const { authority, attempt } = await requireOwnedAttempt(tx, input.attemptId);
        const children = await tx
          .select()
          .from(SyncConnectGenerationAttemptTable)
          .where(eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId));
        if (children.some((child) => child.state === 'activated')) {
          throw new Error('An activated provider transition cannot be cancelled');
        }
        await tx
          .update(SyncConnectGenerationAttemptTable)
          .set({ state: 'cancelled', errorCode: null, updatedAt: input.nowIso })
          .where(eq(SyncConnectGenerationAttemptTable.attemptId, input.attemptId));
        const stagedIds = children
          .map((child) => child.targetSyncGenerationId)
          .filter((value): value is string => value !== null);
        if (stagedIds.length > 0) {
          await tx
            .update(SyncGenerationTable)
            .set({ status: 'retired', retiredAt: input.nowIso, updatedAt: input.nowIso })
            .where(inArray(SyncGenerationTable.syncGenerationId, stagedIds));
        }
        // Unified cloud connect may discover and stage remote projects before
        // activation. Cancelling it must retire only those still-projectless
        // staged generations, regardless of the legacy attempt kind label.
        if (children.length > 0) {
          await tx
            .update(SyncGenerationTable)
            .set({ status: 'retired', retiredAt: input.nowIso, updatedAt: input.nowIso })
            .where(
              and(
                inArray(
                  SyncGenerationTable.syncGenerationId,
                  children.map((child) => child.sourceSyncGenerationId),
                ),
                eq(SyncGenerationTable.status, 'staged'),
                isNull(SyncGenerationTable.projectId),
              ),
            );
        }
        await tx
          .update(SyncConnectAttemptTable)
          .set({ state: 'cancelled', completedAt: input.nowIso, updatedAt: input.nowIso })
          .where(eq(SyncConnectAttemptTable.attemptId, input.attemptId));
        await writeAuthority(
          tx,
          cancelSyncProviderTransition(authority, {
            attemptId: input.attemptId,
            now: input.nowIso,
          }),
        );
        return { secretRef: attempt.targetCredentialSecretRef };
      });
    },

    async listActiveRuntimeBindings(): Promise<readonly ActiveProviderRuntimeBinding[]> {
      const authority = await readAuthority(database);
      if (authority.transitionState !== 'stable' || authority.mode === 'local') return [];
      const rows = await database
        .select({
          syncGenerationId: SyncProviderBindingTable.syncGenerationId,
          providerNamespace: SyncProviderBindingTable.providerNamespace,
          providerGenerationRef: SyncProviderBindingTable.providerGenerationRef,
          accountSubjectId: SyncProviderAccountTable.accountSubjectId,
          credentialSecretRef: SyncProviderAccountTable.credentialSecretRef,
          authorityGeneration: SyncProviderAccountTable.authorityGeneration,
        })
        .from(SyncProviderBindingTable)
        .innerJoin(
          SyncProviderAccountTable,
          eq(SyncProviderBindingTable.providerAccountId, SyncProviderAccountTable.id),
        )
        .innerJoin(SyncGenerationTable, eq(SyncProviderBindingTable.syncGenerationId, SyncGenerationTable.syncGenerationId))
        .where(
          and(
            eq(SyncGenerationTable.status, 'active'),
            eq(SyncProviderBindingTable.state, 'ready'),
          ),
        );
      return rows.map((row) => {
        if (row.authorityGeneration !== authority.generation) {
          throw new Error('Provider binding authority generation is stale');
        }
        return {
          mode: authority.mode as CloudSyncProviderMode,
          providerNamespace: row.providerNamespace,
          providerGenerationRef: row.providerGenerationRef,
          binding: {
            bindingId: activeProviderBindingId(authority.generation, row.syncGenerationId),
            syncGenerationId: row.syncGenerationId,
            accountRef: row.accountSubjectId,
            secretRef: row.credentialSecretRef,
            authorityGeneration: authority.generation,
          },
        };
      });
    },
  };
}
