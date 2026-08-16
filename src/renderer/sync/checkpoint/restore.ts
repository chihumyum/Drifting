import { eq } from 'drizzle-orm';

import type { DbExecutor, DbTransaction } from '../../lib/db';
import {
  ProjectTable,
  SyncBlobStateTable,
  SyncCheckpointTable,
  SyncLocalObjectTable,
  SyncRestoreAttemptTable,
  SyncGenerationTable,
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  yjsSnapshots,
} from '../../schema/drizzle';
import {
  encodeCanonicalCbor,
  type LocalObjectRef,
  type Sha256,
} from '../protocol';
import { initializeRestoredWriterStateInTransaction } from '../journal/writer-state';
import { invalidateSqliteReducerStateCache } from '../reducer';
import {
  materializeAuthoredTablesV1,
  materializeNormalizedAuthoredProjectionsV1,
} from './domain-catalog';
import { materializeReducerStateV1 } from './reducer-state';
import {
  SnapshotRestoreError,
  type RestoreFailureCode,
  type RestoreSnapshotInputV1,
  type RestoreSnapshotResultV1,
  type RestoreSnapshotsAtomicallyInputV1,
} from './types';
import { validateSnapshotForRestoreV1, type ValidatedSnapshotV1 } from './validate';

function rawSha256(value: Sha256): string {
  return value.slice('sha256:'.length);
}

function failureCode(error: unknown): RestoreFailureCode {
  return error instanceof SnapshotRestoreError ? error.code : 'activation-failed';
}

async function updateAttempt(
  db: DbExecutor,
  attemptId: string,
  values: Partial<typeof SyncRestoreAttemptTable.$inferInsert>,
): Promise<void> {
  await db
    .update(SyncRestoreAttemptTable)
    .set(values)
    .where(eq(SyncRestoreAttemptTable.attemptId, attemptId));
}

async function beginAttempts(
  inputs: readonly RestoreSnapshotInputV1[],
  nowIso: string,
): Promise<void> {
  const db = inputs[0]!.db;
  await db.transaction(async (tx) => {
    for (const input of inputs) {
      const generations = await tx
      .select()
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, input.expected.syncGenerationId))
      .limit(1);
      const generation = generations[0];
      if (
        !generation ||
        generation.projectSyncId !== input.expected.projectSyncId ||
        generation.projectId !== null ||
        generation.status !== 'staged' ||
        generation.protocolVersion !== 1 ||
        generation.domainSchemaVersion !== 1
      ) {
        throw new SnapshotRestoreError(
          'sync-generation-not-staged',
          'Restore requires a current-format staged SyncGeneration with no project binding',
        );
      }
      const project = await tx
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.expected.projectId))
        .limit(1);
      if (project.length) {
        throw new SnapshotRestoreError('target-exists', 'Restore target project already exists');
      }
      const [existingAttempt] = await tx
        .select()
        .from(SyncRestoreAttemptTable)
        .where(eq(SyncRestoreAttemptTable.attemptId, input.attemptId))
        .limit(1);
      if (existingAttempt) {
        if (
          existingAttempt.sourceSyncGenerationId !== input.expected.syncGenerationId ||
          existingAttempt.state === 'completed'
        ) {
          throw new SnapshotRestoreError(
            'activation-failed',
            'Restore attempt identity is already owned by another or completed restore',
          );
        }
        await tx
          .update(SyncRestoreAttemptTable)
          .set({
            sourceCheckpointId: null,
            targetProjectId: null,
            stagingRef: input.stagingRef,
            state: 'validating',
            validationCode: null,
            activationReceipt: null,
            errorCode: null,
            updatedAt: nowIso,
            completedAt: null,
          })
          .where(eq(SyncRestoreAttemptTable.attemptId, input.attemptId));
      } else {
        await tx.insert(SyncRestoreAttemptTable).values({
          attemptId: input.attemptId,
          sourceSyncGenerationId: input.expected.syncGenerationId,
          sourceCheckpointId: null,
          targetProjectId: null,
          stagingRef: input.stagingRef,
          state: 'validating',
          validationCode: null,
          activationReceipt: null,
          errorCode: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: null,
        });
      }
    }
  });
}

interface PreparedRestore {
  readonly input: RestoreSnapshotInputV1;
  readonly validated: ValidatedSnapshotV1;
  readonly stagingRefs: LocalObjectRef[];
  readonly activationReceipt: string;
}

async function materializePreparedRestore(
  tx: DbTransaction,
  prepared: PreparedRestore,
  activationTime: string,
): Promise<void> {
  const { input, validated, activationReceipt } = prepared;
  const existing = await tx
    .select({ id: ProjectTable.id })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, input.expected.projectId))
    .limit(1);
  if (existing.length) {
    throw new SnapshotRestoreError('target-exists', 'Restore target appeared during validation');
  }
  await materializeAuthoredTablesV1(tx, validated.authored.tables, {
    nowIso: activationTime,
    localUserId: input.localUserId,
  });
  await materializeReducerStateV1(tx, validated.reducer);
  await initializeRestoredWriterStateInTransaction(tx, {
    syncGenerationId: input.expected.syncGenerationId,
    identity: input.writerIdentity,
    checkpointHlc: validated.maxChangeSetHlc,
    nowIso: activationTime,
  });
  await tx
    .update(SyncGenerationTable)
    .set({ projectId: input.expected.projectId, updatedAt: activationTime })
    .where(eq(SyncGenerationTable.syncGenerationId, input.expected.syncGenerationId));
  await materializeNormalizedAuthoredProjectionsV1(tx, {
    projectId: input.expected.projectId,
    syncGenerationId: input.expected.syncGenerationId,
  });
  const snapshotLocalObjectId = JSON.stringify([
    'restored-snapshot-package',
    input.expected.syncGenerationId,
    validated.package.snapshotId,
  ]);
  await tx.insert(SyncLocalObjectTable).values({
    id: snapshotLocalObjectId,
    syncGenerationId: input.expected.syncGenerationId,
    objectKind: validated.package.snapshotKind,
    logicalKeyId: validated.marker.packageLogicalKeyId,
    storageRef: input.stagingRef,
    storedSha256: rawSha256(input.packageObject?.storedSha256 ?? validated.marker.packageSha256),
    contentSha256: rawSha256(validated.marker.packageSha256),
    sizeBytes: input.packageObject?.sizeBytes ?? input.packageBytes.byteLength,
    codec: 'cbor-rfc8949',
    state: 'published',
    createdAt: activationTime,
    verifiedAt: activationTime,
  });
  await tx.insert(SyncCheckpointTable).values({
    checkpointId: validated.package.snapshotId,
    syncGenerationId: input.expected.syncGenerationId,
    kind: validated.package.snapshotKind,
    protocolVersion: 1,
    domainSchemaVersion: validated.package.domainManifestVersion,
    frontierCbor: encodeCanonicalCbor([...validated.package.frontier]),
    localObjectId: snapshotLocalObjectId,
    logicalKeyId: validated.marker.packageLogicalKeyId,
    contentSha256: rawSha256(validated.marker.packageSha256),
    state: 'published',
    changeSetCount: validated.reducer.changeSets.length,
    sizeBytes: input.packageBytes.byteLength,
    createdAt: activationTime,
    publishedAt: activationTime,
    verifiedAt: activationTime,
  });
  for (const document of validated.package.proseDocuments) {
    if (document.mode !== 'full-state') continue;
    await tx.insert(yjsSnapshots).values({
      docId: document.documentId,
      stateBlob: new Uint8Array(document.state),
      updatedAt: activationTime,
    });
    await tx.insert(YjsDocumentRevisionTable).values({
      docId: document.documentId,
      revision: 1,
      updatedAt: activationTime,
    });
    await tx.insert(YjsDocumentRevisionProvenanceTable).values({
      docId: document.documentId,
      revision: 1,
      sourceKind: 'remote',
      agentSessionId: null,
      agentTurnId: null,
      agentCallId: null,
      createdAt: activationTime,
    });
  }
  for (const asset of validated.package.assets) {
    await tx.insert(SyncBlobStateTable).values({
      syncGenerationId: input.expected.syncGenerationId,
      blobId: asset.blobId,
      assetId: asset.assetId,
      logicalKeyId: input.blobLogicalKeyIds?.get(asset.blobId) ?? asset.blobId,
      contentSha256: rawSha256(asset.sourceSha256),
      sizeBytes: asset.sizeBytes,
      mime: asset.mimeType,
      localObjectId: null,
      localState: 'verified',
      remoteState: 'available',
      verifiedAt: activationTime,
      updatedAt: activationTime,
    });
  }
  await tx
    .update(SyncGenerationTable)
    .set({
      projectId: input.expected.projectId,
      status: 'active',
      updatedAt: activationTime,
    })
    .where(eq(SyncGenerationTable.syncGenerationId, input.expected.syncGenerationId));
  await tx
    .update(SyncRestoreAttemptTable)
    .set({
      sourceCheckpointId: validated.package.snapshotId,
      targetProjectId: input.expected.projectId,
      state: 'completed',
      activationReceipt,
      updatedAt: activationTime,
      completedAt: activationTime,
      errorCode: null,
    })
    .where(eq(SyncRestoreAttemptTable.attemptId, input.attemptId));
}

/**
 * Restore validates every byte and reference before any domain row exists.
 * Only the final SQLite transaction exposes the project and reducer state.
 */
export async function restoreSnapshotV1(
  input: RestoreSnapshotInputV1,
): Promise<RestoreSnapshotResultV1> {
  const results = await restoreSnapshotsAtomicallyV1({ snapshots: [input] });
  return results[0]!;
}

/**
 * Prepare every native asset first, then expose all recovered projects in one
 * SQLite transaction. A multi-SyncGeneration recovery can therefore never reveal a
 * prefix of the remote project set before App-wide provider activation.
 */
export async function restoreSnapshotsAtomicallyV1(
  input: RestoreSnapshotsAtomicallyInputV1,
): Promise<readonly RestoreSnapshotResultV1[]> {
  if (input.snapshots.length === 0) return [];
  const snapshots = [...input.snapshots];
  const database = snapshots[0]!.db;
  if (snapshots.some((snapshot) => snapshot.db !== database)) {
    throw new SnapshotRestoreError('activation-failed', 'Atomic restore requires one SQLite client');
  }
  for (const identity of [
    snapshots.map((snapshot) => snapshot.attemptId),
    snapshots.map((snapshot) => snapshot.expected.syncGenerationId),
    snapshots.map((snapshot) => snapshot.expected.projectId),
  ]) {
    if (new Set(identity).size !== identity.length) {
      throw new SnapshotRestoreError('identity-mismatch', 'Atomic restore identities must be unique');
    }
  }
  const now = snapshots[0]!.nowIso ?? (() => new Date().toISOString());
  await beginAttempts(snapshots, now());
  const prepared: PreparedRestore[] = [];
  let activated = false;
  try {
    for (const snapshot of snapshots) {
      const validated = await validateSnapshotForRestoreV1({
        packageBytes: snapshot.packageBytes,
        commitMarkerBytes: snapshot.commitMarkerBytes,
        expected: snapshot.expected,
      });
      await updateAttempt(snapshot.db, snapshot.attemptId, {
        validationCode: 'current-v1-verified',
        state: 'staging-assets',
        updatedAt: now(),
      });
      const stagingRefs: LocalObjectRef[] = [];
      for (const asset of validated.package.assets) {
        const sourceRef = snapshot.blobSources.get(asset.blobId);
        if (!sourceRef) {
          throw new SnapshotRestoreError('missing-blob', `Required blob ${asset.blobId} is missing`);
        }
        const staged = await snapshot.assetPort.prepareVerifiedSource({
          attemptId: snapshot.attemptId,
          targetProjectId: snapshot.expected.projectId,
          asset,
          sourceRef,
        });
        if (
          staged.assetId !== asset.assetId ||
          staged.sourceSha256 !== asset.sourceSha256 ||
          staged.sizeBytes !== asset.sizeBytes ||
          !staged.stagingRef.trim()
        ) {
          throw new SnapshotRestoreError('corrupt-blob', `Staged blob does not match ${asset.assetId}`);
        }
        stagingRefs.push(staged.stagingRef);
      }
      const activationReceipt = await snapshot.assetPort.activatePreparedSources({
        attemptId: snapshot.attemptId,
        targetProjectId: snapshot.expected.projectId,
        stagingRefs,
      });
      if (!activationReceipt.trim()) {
        throw new SnapshotRestoreError('activation-failed', 'Native asset activation returned no receipt');
      }
      prepared.push({ input: snapshot, validated, stagingRefs, activationReceipt });
      await updateAttempt(snapshot.db, snapshot.attemptId, {
        state: 'activating',
        updatedAt: now(),
      });
    }
    activated = true;
    const activationTime = now();
    await database.transaction(async (tx) => {
      for (const item of prepared) {
        await materializePreparedRestore(tx, item, activationTime);
      }
      await input.activationBarrier?.({
        tx,
        activatedAt: activationTime,
        results: prepared.map(({ input: item, validated, activationReceipt }) => ({
          attemptId: item.attemptId,
          projectId: item.expected.projectId,
          syncGenerationId: item.expected.syncGenerationId,
          snapshotId: validated.package.snapshotId,
          activationReceipt,
        })),
      });
    });
    for (const item of prepared) {
      try {
        await item.input.assetPort.finalizeAttempt?.({ attemptId: item.input.attemptId });
      } catch {
        // SQLite owns completion. Startup reconciliation only cleans receipts.
      }
      invalidateSqliteReducerStateCache(item.input.expected.syncGenerationId);
    }
    return prepared.map(({ input: item, validated, activationReceipt }) => ({
      attemptId: item.attemptId,
      projectId: item.expected.projectId,
      syncGenerationId: item.expected.syncGenerationId,
      snapshotId: validated.package.snapshotId,
      activationReceipt,
    }));
  } catch (error) {
    for (const snapshot of snapshots) {
      const item = prepared.find((candidate) => candidate.input.attemptId === snapshot.attemptId);
      try {
        await snapshot.assetPort.abandonAttempt({
          attemptId: snapshot.attemptId,
          stagingRefs: item?.stagingRefs ?? [],
        });
      } catch {
        // Attempts remain failed; restart-safe native orphan GC owns residue.
      }
      const completedAt = now();
      await updateAttempt(snapshot.db, snapshot.attemptId, {
        state: 'failed',
        errorCode: failureCode(error),
        updatedAt: completedAt,
        completedAt,
      });
    }
    if (error instanceof SnapshotRestoreError) throw error;
    throw new SnapshotRestoreError(
      'activation-failed',
      activated
        ? 'Atomic restore database activation failed after native asset activation'
        : 'Atomic restore failed before activation',
      error,
    );
  }
}
