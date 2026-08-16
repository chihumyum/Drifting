import { and, asc, eq } from 'drizzle-orm';

import type { DbTransaction } from '../../lib/db';
import {
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncMutationTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import {
  decodeSyncChangeSetV1,
  encodeCanonicalCbor,
  encodeSyncChangeSetV1,
  hashCanonicalCbor,
  sha256Bytes,
  type Sha256,
  type SyncChangeSetV1,
} from '../protocol';
import {
  SyncChangeBuilder,
  type FinalizedSyncChangeBuilder,
} from './change-builder';
import { normalizeAuthoredIncarnationsInTransaction } from './incarnation';
import {
  observeRemoteHlcInTransaction,
  reserveLocalWriterStateInTransaction,
  type SyncJournalClock,
  type SyncWriterIdentitySource,
} from './writer-state';

export interface RecordedSyncChangeSet {
  readonly changeSet: SyncChangeSetV1;
  readonly encodedBytes: Uint8Array;
  readonly encodedSha256: Sha256;
  readonly alreadyApplied: boolean;
}

export interface RecordAuthoredChangeSetInput {
  projectId: string;
  projectSyncId: string;
  syncGenerationId: string;
  identity: SyncWriterIdentitySource;
  clock: SyncJournalClock;
  stateSha256?: Sha256;
  allowDetachedProject?: boolean;
}

export interface CompleteRemoteApplyInput {
  changeSet: SyncChangeSetV1;
  identity: SyncWriterIdentitySource;
  clock: SyncJournalClock;
  sourceObjectId?: string;
  stateSha256?: Sha256;
}

export interface StageRemoteChangeSetInput {
  changeSet: SyncChangeSetV1;
  clock: SyncJournalClock;
}

export interface StagedRemoteChangeSet extends RecordedSyncChangeSet {
  /** null means this transaction inserted the immutable remote journal row. */
  readonly storedOrigin: 'local' | 'remote' | null;
}

function sha256Hex(value: Sha256): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  if (!match) throw new TypeError('SHA-256 must use the protocol sha256:<hex> format');
  return match[1];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function assertActiveSyncGeneration(
  tx: DbTransaction,
  input: {
    projectId: string;
    projectSyncId: string;
    syncGenerationId: string;
    allowDetachedProject?: boolean;
    allowPurgedSyncGeneration?: boolean;
  },
): Promise<void> {
  const rows = await tx
    .select({
      projectId: SyncGenerationTable.projectId,
      projectSyncId: SyncGenerationTable.projectSyncId,
      status: SyncGenerationTable.status,
    })
    .from(SyncGenerationTable)
    .where(eq(SyncGenerationTable.syncGenerationId, input.syncGenerationId))
    .limit(1);
  const generation = rows[0];
  if (!generation) throw new Error(`sync generation ${input.syncGenerationId} does not exist`);
  if (generation.status !== 'active' && !(input.allowPurgedSyncGeneration === true && generation.status === 'purged')) {
    throw new Error(`sync generation ${input.syncGenerationId} is not active`);
  }
  const projectMatches =
    generation.projectId === input.projectId ||
    (input.allowDetachedProject === true && generation.projectId === null);
  if (!projectMatches || generation.projectSyncId !== input.projectSyncId) {
    throw new Error('change set project, projectSync, and generation identity do not match');
  }
}

function protocolMutations(finalized: FinalizedSyncChangeBuilder) {
  return finalized.mutations.map(({ mutation }) => ({
    ...mutation,
    target: { ...mutation.target },
  }));
}

async function insertChangeSetAndMutations(
  tx: DbTransaction,
  input: {
    changeSet: SyncChangeSetV1;
    finalized: FinalizedSyncChangeBuilder;
    encodedBytes: Uint8Array;
    encodedSha256: Sha256;
    origin: 'local' | 'remote';
    createdAt: string;
  },
): Promise<void> {
  const { changeSet } = input;
  await tx.insert(SyncChangeSetTable).values({
    changeSetId: changeSet.changeSetId,
    syncGenerationId: changeSet.syncGenerationId,
    projectId: changeSet.projectId,
    projectSyncId: changeSet.projectSyncId,
    writerId: changeSet.writerId,
    writerEpoch: changeSet.writerEpoch,
    deviceSeq: changeSet.deviceSeq,
    hlcWallMs: changeSet.hlc.wallMs,
    hlcCounter: changeSet.hlc.counter,
    protocolVersion: changeSet.protocolVersion,
    payloadVersion: changeSet.payloadVersion,
    mutationCount: changeSet.mutations.length,
    encodedBytes: new Uint8Array(input.encodedBytes),
    payloadSha256: sha256Hex(input.encodedSha256),
    origin: input.origin,
    applyState: 'applying',
    createdAt: input.createdAt,
  });

  await tx.insert(SyncMutationTable).values(
    input.finalized.mutations.map(({ mutation, payloadCbor }) => ({
      changeSetId: changeSet.changeSetId,
      mutationIndex: mutation.index,
      targetFamily: mutation.target.family,
      targetKind: mutation.target.kind,
      targetId: mutation.target.id,
      incarnation: mutation.target.incarnation,
      action: mutation.action,
      payloadVersion: mutation.payloadVersion,
      payloadCbor: new Uint8Array(payloadCbor),
      payloadSha256: sha256Hex(mutation.payloadSha256),
    })),
  );
}

async function insertApplyReceipt(
  tx: DbTransaction,
  input: {
    changeSet: SyncChangeSetV1;
    appliedAt: string;
    sourceObjectId?: string;
    stateSha256?: Sha256;
  },
): Promise<void> {
  await tx.insert(SyncApplyReceiptTable).values({
    changeSetId: input.changeSet.changeSetId,
    syncGenerationId: input.changeSet.syncGenerationId,
    mutationCount: input.changeSet.mutations.length,
    sourceObjectId: input.sourceObjectId,
    stateSha256: input.stateSha256 ? sha256Hex(input.stateSha256) : undefined,
    appliedAt: input.appliedAt,
  });
  await tx
    .update(SyncChangeSetTable)
    .set({ applyState: 'applied', appliedAt: input.appliedAt })
    .where(eq(SyncChangeSetTable.changeSetId, input.changeSet.changeSetId));
}

export async function recordAuthoredChangeSetInTransaction(
  tx: DbTransaction,
  input: RecordAuthoredChangeSetInput,
  builder: SyncChangeBuilder,
): Promise<RecordedSyncChangeSet> {
  // Normalize before hashing so every authored path (UI, Agent, Yjs and
  // assets) commits the current lifecycle incarnation. A zero-mutation
  // builder still fails in finalize before reserving a writer sequence.
  await normalizeAuthoredIncarnationsInTransaction(tx, {
    syncGenerationId: input.syncGenerationId,
    builder,
  });
  const finalized = await builder.finalize();
  await assertActiveSyncGeneration(tx, input);
  const writer = await reserveLocalWriterStateInTransaction(tx, {
    syncGenerationId: input.syncGenerationId,
    identity: input.identity,
    clock: input.clock,
  });
  const changeSet: SyncChangeSetV1 = {
    protocol: 'drifting.sync.changeset',
    protocolVersion: 1,
    payloadVersion: 1,
    projectId: input.projectId,
    projectSyncId: input.projectSyncId,
    syncGenerationId: input.syncGenerationId,
    changeSetId: `${writer.writerId}:${writer.writerEpoch}:${writer.deviceSeq}`,
    writerId: writer.writerId,
    writerEpoch: writer.writerEpoch,
    deviceSeq: writer.deviceSeq,
    hlc: writer.hlc,
    mutations: protocolMutations(finalized),
  };
  const encodedBytes = encodeSyncChangeSetV1(changeSet);
  const encodedSha256 = await sha256Bytes(encodedBytes);

  await insertChangeSetAndMutations(tx, {
    changeSet,
    finalized,
    encodedBytes,
    encodedSha256,
    origin: 'local',
    createdAt: input.clock.nowIso,
  });
  await insertApplyReceipt(tx, {
    changeSet,
    appliedAt: input.clock.nowIso,
    stateSha256: input.stateSha256,
  });
  return { changeSet, encodedBytes, encodedSha256, alreadyApplied: false };
}

async function finalizedRemoteMutations(
  changeSet: SyncChangeSetV1,
): Promise<FinalizedSyncChangeBuilder> {
  const mutations = await Promise.all(
    changeSet.mutations.map(async (mutation, index) => {
      const payloadSha256 = await hashCanonicalCbor(mutation.payload);
      if (payloadSha256 !== mutation.payloadSha256) {
        throw new Error(`remote mutation ${index} payload hash mismatch`);
      }
      return Object.freeze({
        mutation: Object.freeze({
          ...mutation,
          target: Object.freeze({ ...mutation.target }),
        }),
        payloadCbor: encodeCanonicalCbor(mutation.payload),
      });
    }),
  );
  return Object.freeze({ mutations: Object.freeze(mutations) });
}

async function assertStoredChangeSetMatches(
  tx: DbTransaction,
  input: {
    changeSet: SyncChangeSetV1;
    encodedBytes: Uint8Array;
    encodedSha256: Sha256;
  },
): Promise<'local' | 'remote' | null> {
  const rows = await tx
    .select()
    .from(SyncChangeSetTable)
    .where(eq(SyncChangeSetTable.changeSetId, input.changeSet.changeSetId))
    .limit(1);
  const stored = rows[0];
  if (!stored) return null;

  const encoded = stored.encodedBytes as Uint8Array;
  if (
    stored.syncGenerationId !== input.changeSet.syncGenerationId ||
    stored.projectId !== input.changeSet.projectId ||
    stored.projectSyncId !== input.changeSet.projectSyncId ||
    stored.writerId !== input.changeSet.writerId ||
    stored.writerEpoch !== input.changeSet.writerEpoch ||
    stored.deviceSeq !== input.changeSet.deviceSeq ||
    stored.mutationCount !== input.changeSet.mutations.length ||
    stored.payloadSha256 !== sha256Hex(input.encodedSha256) ||
    !bytesEqual(encoded, input.encodedBytes)
  ) {
    throw new Error('remote change set collides with different stored bytes');
  }

  const mutations = await tx
    .select()
    .from(SyncMutationTable)
    .where(eq(SyncMutationTable.changeSetId, input.changeSet.changeSetId))
    .orderBy(asc(SyncMutationTable.mutationIndex));
  if (mutations.length !== input.changeSet.mutations.length) {
    throw new Error('stored remote change set is incomplete');
  }
  for (let index = 0; index < mutations.length; index += 1) {
    const storedMutation = mutations[index];
    const incoming = input.changeSet.mutations[index];
    if (
      storedMutation.mutationIndex !== incoming.index ||
      storedMutation.targetFamily !== incoming.target.family ||
      storedMutation.targetKind !== incoming.target.kind ||
      storedMutation.targetId !== incoming.target.id ||
      storedMutation.incarnation !== incoming.target.incarnation ||
      storedMutation.action !== incoming.action ||
      storedMutation.payloadSha256 !== sha256Hex(incoming.payloadSha256)
    ) {
      throw new Error(`stored remote mutation ${index} does not match incoming bytes`);
    }
  }
  return stored.origin as 'local' | 'remote';
}

/**
 * Durably stages and verifies immutable remote journal rows without declaring
 * them applied. A reducer/domain kernel must finish in the same outer SQLite
 * transaction before `completeRemoteApplyInTransaction` writes the receipt.
 */
export async function stageRemoteChangeSetInTransaction(
  tx: DbTransaction,
  input: StageRemoteChangeSetInput,
): Promise<StagedRemoteChangeSet> {
  // A remote purge is terminal for domain materialization, not for immutable
  // journal ingestion. Later/duplicate writer lanes must still be receipted so
  // the applied frontier can converge without ever reviving the project.
  await assertActiveSyncGeneration(tx, {
    ...input.changeSet,
    allowDetachedProject: true,
    allowPurgedSyncGeneration: true,
  });
  const encodedBytes = encodeSyncChangeSetV1(input.changeSet);
  const verified = await decodeSyncChangeSetV1(encodedBytes);
  if (!verified.ok) {
    throw new Error(`remote change set failed protocol verification: ${verified.reason}`);
  }
  const finalized = await finalizedRemoteMutations(input.changeSet);
  const encodedSha256 = await sha256Bytes(encodedBytes);
  const storedOrigin = await assertStoredChangeSetMatches(tx, {
    changeSet: input.changeSet,
    encodedBytes,
    encodedSha256,
  });

  if (!storedOrigin) {
    await insertChangeSetAndMutations(tx, {
      changeSet: input.changeSet,
      finalized,
      encodedBytes,
      encodedSha256,
      origin: 'remote',
      createdAt: input.clock.nowIso,
    });
  }

  const receipts = await tx
    .select({ changeSetId: SyncApplyReceiptTable.changeSetId })
    .from(SyncApplyReceiptTable)
    .where(
      and(
        eq(SyncApplyReceiptTable.changeSetId, input.changeSet.changeSetId),
        eq(SyncApplyReceiptTable.syncGenerationId, input.changeSet.syncGenerationId),
      ),
    )
    .limit(1);
  if (receipts.length > 0) {
    return {
      changeSet: input.changeSet,
      encodedBytes,
      encodedSha256,
      alreadyApplied: true,
      storedOrigin,
    };
  }

  return {
    changeSet: input.changeSet,
    encodedBytes,
    encodedSha256,
    alreadyApplied: false,
    storedOrigin,
  };
}

/** Complete a previously staged remote apply after reducer/domain success. */
export async function completeRemoteApplyInTransaction(
  tx: DbTransaction,
  input: CompleteRemoteApplyInput & {
    staged: StagedRemoteChangeSet;
  },
): Promise<RecordedSyncChangeSet> {
  if (input.staged.changeSet.changeSetId !== input.changeSet.changeSetId) {
    throw new Error('staged remote change set does not match completion input');
  }
  if (input.staged.alreadyApplied) return input.staged;

  if (input.staged.storedOrigin !== 'local') {
    await observeRemoteHlcInTransaction(tx, {
      syncGenerationId: input.changeSet.syncGenerationId,
      remoteHlc: input.changeSet.hlc,
      identity: input.identity,
      clock: input.clock,
    });
  }
  await insertApplyReceipt(tx, {
    changeSet: input.changeSet,
    appliedAt: input.clock.nowIso,
    sourceObjectId: input.sourceObjectId,
    stateSha256: input.stateSha256,
  });
  return {
    changeSet: input.changeSet,
    encodedBytes: input.staged.encodedBytes,
    encodedSha256: input.staged.encodedSha256,
    alreadyApplied: false,
  };
}
