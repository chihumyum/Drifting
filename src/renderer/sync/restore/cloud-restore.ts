import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { DbClient, DbExecutor, DbTransaction } from '../../lib/db';
import type {
  CloudProviderAccount,
  ProjectSnapshotDiscoveryPort,
} from '../providers/cloud-discovery';
import {
  SyncAppAuthorityTable,
  SyncProviderAccountTable,
  SyncChangeSetTable,
  SyncConnectAttemptTable,
  SyncConnectGenerationAttemptTable,
  SyncCursorTable,
  SyncLocalObjectTable,
  SyncProviderBindingTable,
  SyncQuarantinedObjectTable,
  SyncRemoteObjectTable,
  SyncRestoreAttemptTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import {
  restoreSnapshotsAtomically,
  validateSnapshotForRestore,
  type RestoreSnapshotInputV1,
  type RestoreSnapshotResultV1,
  type SnapshotAssetRestorePort,
} from '../checkpoint';
import {
  activeProviderBindingId,
  createSyncAppAuthorityRepository,
  resolveSyncGenerationAuthorityProjectId,
  type SyncProviderTransitionAttempt,
} from '../app-authority-repository';
import { syncProviderEpoch, syncRemoteObjectId } from '../engine/durable-runtime';
import type { SyncEngineObjectCodec } from '../engine/object-codec';
import { NativePlaintextSyncEngineObjectCodec } from '../engine/native-plaintext-object-codec';
import { type SyncWriterIdentitySource } from '../journal';
import { nativeSyncObjectCodec, type NativeSyncObjectCodec } from '../native-object-codec';
import {
  compareHlc,
  compareUtf8Bytewise,
  decodeSnapshotCommitMarkerV1,
  sha256Bytes,
  type LocalObjectRef,
  type ObjectLogProvider,
  type ProviderBinding,
  type ProviderCursor,
  type ProviderPageToken,
  type ProviderGeneration,
  type RemoteObject,
  type Sha256,
  type SnapshotCommitMarkerV1,
  type SnapshotPackageV1,
  type SnapshotPackageV2,
} from '../protocol';

const MAX_PROVIDER_PAGES = 10_000;
const DEFAULT_LOCAL_USER_ID = 'drifting-library.db';

function unresolvedProjectSync(syncGenerationId: string): string {
  return `restore-pending:${syncGenerationId}`;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim() || value.includes('\u0000')) {
    throw new Error(`${label} must be a non-empty opaque ID`);
  }
  return value;
}

function sha256Hex(value: Sha256): string {
  return value.slice('sha256:'.length);
}

function remoteRowId(syncGenerationId: string, providerObjectId: string): string {
  return syncRemoteObjectId(syncGenerationId, providerObjectId);
}

function sameRemoteObject(left: RemoteObject, right: RemoteObject): boolean {
  return (
    left.objectId === right.objectId &&
    left.objectKind === right.objectKind &&
    left.logicalKeyId === right.logicalKeyId &&
    left.storedSha256 === right.storedSha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

function sameImmutableValue(left: RemoteObject, right: RemoteObject): boolean {
  return (
    left.objectKind === right.objectKind &&
    left.logicalKeyId === right.logicalKeyId &&
    left.storedSha256 === right.storedSha256 &&
    left.sizeBytes === right.sizeBytes
  );
}

async function canonicalLogicalKeyId(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function stageUnresolvedProjectGeneration(input: {
  db: DbClient;
  syncGenerationId: string;
  nowIso: string;
}): Promise<'discover' | 'skip-terminal-local'> {
  return input.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, input.syncGenerationId))
      .limit(1);
    if (existing) {
      // Discovery is intentionally replayable. A previous run may already
      // have authenticated the marker and replaced restore-pending with the
      // real projectSyncId before a later download/materialization step
      // blocked. The marker is validated again below by
      // stageRestoreSyncGeneration, so both unresolved and resolved
      // project-less staging rows are safe to reuse here.
      if (existing.projectId === null && existing.status === 'staged') {
        return 'discover';
      }

      if (existing.projectId === null && existing.status === 'retired') {
        const journal = await tx
          .select({ id: SyncChangeSetTable.changeSetId })
          .from(SyncChangeSetTable)
          .where(eq(SyncChangeSetTable.syncGenerationId, input.syncGenerationId))
          .limit(1);
        const binding = await tx
          .select({ id: SyncProviderBindingTable.syncGenerationId })
          .from(SyncProviderBindingTable)
          .where(eq(SyncProviderBindingTable.syncGenerationId, input.syncGenerationId))
          .limit(1);
        const histories = await tx
          .select({
            state: SyncConnectGenerationAttemptTable.state,
            targetSyncGenerationId: SyncConnectGenerationAttemptTable.targetSyncGenerationId,
          })
          .from(SyncConnectGenerationAttemptTable)
          .where(
            eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, input.syncGenerationId),
          );
        const isCancelledRestoreShell =
          journal.length === 0 &&
          binding.length === 0 &&
          histories.length > 0 &&
          histories.every(
            (history) =>
              history.targetSyncGenerationId === null &&
              history.state !== 'committed' &&
              history.state !== 'activated',
          );
        if (isCancelledRestoreShell) {
          await tx
            .update(SyncGenerationTable)
            .set({
              status: 'staged',
              retiredAt: null,
              updatedAt: input.nowIso,
            })
            .where(eq(SyncGenerationTable.syncGenerationId, input.syncGenerationId));
          return 'discover';
        }
      }

      // Provider object logs are immutable, so discovery continues to list a
      // generation after this device has durably retired or purged it. That
      // terminal local receipt is authority to ignore the historical remote
      // generation; staging it again would resurrect deleted state and used
      // to fail reconnect before the still-active generation was examined.
      if (existing.status === 'retired' || existing.status === 'purged') {
        return 'skip-terminal-local';
      }

      throw new CloudRestoreError(
        'local-project-sync-conflict',
        'Remote project generation identity is already owned by active local state',
      );
    }
    await tx.insert(SyncGenerationTable).values({
      syncGenerationId: input.syncGenerationId,
      projectId: null,
      projectSyncId: unresolvedProjectSync(input.syncGenerationId),
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'staged',
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    });
    return 'discover';
  });
}

async function quarantineRestoreObject(input: {
  db: DbClient;
  syncGenerationId: string;
  remoteObject: RemoteObject;
  sourceRef: LocalObjectRef;
  reason: string;
  state: 'blocked-update' | 'blocked-corrupt';
  observedProtocol: string;
  observedVersion?: number;
  nowIso: string;
}): Promise<void> {
  await recordRemoteObjects(input.db, input.syncGenerationId, [input.remoteObject], input.nowIso);
  const localId = JSON.stringify([
    'restore-quarantine-local',
    input.syncGenerationId,
    input.remoteObject.objectId,
  ]);
  const quarantineId = JSON.stringify([
    'restore-quarantine',
    input.syncGenerationId,
    input.remoteObject.objectId,
  ]);
  await input.db.transaction(async (tx) => {
    await tx
      .insert(SyncLocalObjectTable)
      .values({
        id: localId,
        syncGenerationId: input.syncGenerationId,
        objectKind: 'quarantine',
        logicalKeyId: input.remoteObject.logicalKeyId,
        storageRef: input.sourceRef,
        storedSha256: sha256Hex(input.remoteObject.storedSha256),
        contentSha256: null,
        sizeBytes: input.remoteObject.sizeBytes,
        codec: 'cbor-rfc8949',
        state: 'quarantined',
        createdAt: input.nowIso,
        verifiedAt: input.nowIso,
      })
      .onConflictDoUpdate({
        target: SyncLocalObjectTable.id,
        set: { storageRef: input.sourceRef, state: 'quarantined', verifiedAt: input.nowIso },
      });
    await tx
      .insert(SyncQuarantinedObjectTable)
      .values({
        quarantineId,
        syncGenerationId: input.syncGenerationId,
        remoteObjectId: remoteRowId(input.syncGenerationId, input.remoteObject.objectId),
        localObjectId: localId,
        reason: input.reason,
        observedProtocol: input.observedProtocol,
        observedVersion: input.observedVersion ?? null,
        storedSha256: sha256Hex(input.remoteObject.storedSha256),
        sizeBytes: input.remoteObject.sizeBytes,
        state: input.state,
        createdAt: input.nowIso,
      })
      .onConflictDoUpdate({
        target: SyncQuarantinedObjectTable.localObjectId,
        set: { reason: input.reason, state: input.state, resolvedAt: null },
      });
  });
}

function temporaryBinding(input: {
  attemptId: string;
  syncGenerationId: string;
  account: CloudProviderAccount;
  targetAuthorityGeneration: number;
}): ProviderBinding {
  return {
    bindingId: `restore:${input.attemptId}:${input.syncGenerationId}`,
    syncGenerationId: input.syncGenerationId,
    accountRef: input.account.accountSubject,
    secretRef: input.account.credentialSecretRef,
    authorityGeneration: input.targetAuthorityGeneration,
  };
}

/** Capture-before-inventory and drain-after-inventory closes the Drive listing race. */
export async function discoverCurrentSyncGenerationObjects(input: {
  provider: ObjectLogProvider;
  generation: ProviderGeneration;
  signal: AbortSignal;
}): Promise<{
  readonly objects: readonly RemoteObject[];
  readonly committedCursor: ProviderCursor;
}> {
  const startCursor = await input.provider.captureStartCursor(input.generation);
  const byId = new Map<string, RemoteObject>();
  const logicalIdentity = new Map<string, RemoteObject>();
  const observe = (object: RemoteObject) => {
    const previousId = byId.get(object.objectId);
    if (previousId && !sameRemoteObject(previousId, object)) {
      throw new CloudRestoreError(
        'blocked-corrupt',
        'Provider object identity changed during restore inventory',
      );
    }
    const previousLogical = logicalIdentity.get(object.logicalKeyId);
    if (previousLogical && !sameImmutableValue(previousLogical, object)) {
      throw new CloudRestoreError(
        'blocked-corrupt',
        'One provider logical key resolves to conflicting immutable bytes',
      );
    }
    byId.set(object.objectId, object);
    logicalIdentity.set(object.logicalKeyId, object);
  };

  let inventoryPage: ProviderPageToken | undefined;
  const seenInventoryPages = new Set<string>();
  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    if (input.signal.aborted) throw input.signal.reason;
    const result = await input.provider.listInventory({
      generation: input.generation,
      ...(inventoryPage ? { pageToken: inventoryPage } : {}),
    });
    for (const object of result.objects) observe(object);
    if (!result.nextPageToken) break;
    if (!seenInventoryPages.add(result.nextPageToken)) {
      throw new CloudRestoreError('blocked-corrupt', 'Provider inventory repeated a page token');
    }
    inventoryPage = result.nextPageToken;
    if (page === MAX_PROVIDER_PAGES - 1) {
      throw new CloudRestoreError('blocked-corrupt', 'Provider inventory exceeded its page bound');
    }
  }

  let changePage: ProviderPageToken | undefined;
  const seenChangePages = new Set<string>();
  let committedCursor: ProviderCursor | null = null;
  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    if (input.signal.aborted) throw input.signal.reason;
    const result = await input.provider.listChanges({
      generation: input.generation,
      cursor: startCursor,
      ...(changePage ? { pageToken: changePage } : {}),
    });
    for (const change of result.changes) {
      if (change.kind === 'present') {
        observe(change.object);
      } else if (byId.has(change.objectId)) {
        throw new CloudRestoreError(
          'blocked-corrupt',
          'Provider removed an immutable object during restore inventory',
        );
      }
    }
    if (result.nextPageToken) {
      if (!seenChangePages.add(result.nextPageToken)) {
        throw new CloudRestoreError('blocked-corrupt', 'Provider changes repeated a page token');
      }
      changePage = result.nextPageToken;
      continue;
    }
    committedCursor = result.newCursor ?? null;
    break;
  }
  if (!committedCursor) {
    throw new CloudRestoreError('blocked-corrupt', 'Provider changes omitted a committed cursor');
  }
  return Object.freeze({
    objects: Object.freeze(
      [...byId.values()].sort(
        (left, right) =>
          compareUtf8Bytewise(left.logicalKeyId, right.logicalKeyId) ||
          compareUtf8Bytewise(left.objectId, right.objectId),
      ),
    ),
    committedCursor,
  });
}

export interface RestoreObjectAccess {
  decodeProtocol(input: {
    provider: ObjectLogProvider;
    generation: ProviderGeneration;
    remoteObject: RemoteObject;
    transferId: string;
    signal: AbortSignal;
  }): Promise<{ bytes: Uint8Array; sourceRef: LocalObjectRef; contentSha256: Sha256 }>;
  deriveBlobLogicalKey(input: { syncGenerationId: string; blobId: Sha256 }): Promise<string>;
  decodeBlob(input: {
    provider: ObjectLogProvider;
    generation: ProviderGeneration;
    remoteObject: RemoteObject;
    transferId: string;
    signal: AbortSignal;
  }): Promise<{ sourceRef: LocalObjectRef; contentSha256: Sha256; sizeBytes: number }>;
  discard?(sourceRef: LocalObjectRef): Promise<void>;
}

export class NativeRestoreObjectAccess implements RestoreObjectAccess {
  private readonly protocolCodec: SyncEngineObjectCodec;

  constructor(private readonly native: NativeSyncObjectCodec = nativeSyncObjectCodec) {
    this.protocolCodec = new NativePlaintextSyncEngineObjectCodec(native);
  }

  async decodeProtocol(input: Parameters<RestoreObjectAccess['decodeProtocol']>[0]) {
    const destinationRef = await this.protocolCodec.allocateInbound({
      syncGenerationId: input.generation.syncGenerationId,
      remoteObject: input.remoteObject,
    });
    await input.provider.downloadImmutable({
      generation: input.generation,
      objectId: input.remoteObject.objectId,
      destinationRef,
      expectedStoredSha256: input.remoteObject.storedSha256,
      transferId: input.transferId,
      signal: input.signal,
    });
    const decoded = await this.protocolCodec.decodeInbound({
      syncGenerationId: input.generation.syncGenerationId,
      expectedLogicalKeyId: input.remoteObject.logicalKeyId,
      remoteObject: input.remoteObject,
      sourceRef: destinationRef,
    });
    return {
      bytes: decoded.protocolBytes,
      sourceRef: destinationRef,
      contentSha256: decoded.contentSha256,
    };
  }

  deriveBlobLogicalKey(input: Parameters<RestoreObjectAccess['deriveBlobLogicalKey']>[0]) {
    return canonicalLogicalKeyId(`blob/${input.syncGenerationId}/${input.blobId}`);
  }

  async decodeBlob(input: Parameters<RestoreObjectAccess['decodeBlob']>[0]) {
    const destination = await this.native.stageProtocolBytes(new Uint8Array());
    await input.provider.downloadImmutable({
      generation: input.generation,
      objectId: input.remoteObject.objectId,
      destinationRef: destination.sourceRef,
      expectedStoredSha256: input.remoteObject.storedSha256,
      transferId: input.transferId,
      signal: input.signal,
    });
    return {
      sourceRef: destination.sourceRef,
      contentSha256: input.remoteObject.storedSha256,
      sizeBytes: input.remoteObject.sizeBytes,
    };
  }

  discard(sourceRef: LocalObjectRef): Promise<void> {
    return this.native.discardLocal?.(sourceRef) ?? Promise.resolve();
  }
}

interface RemoteSnapshotCandidate {
  readonly syncGenerationId: string;
  readonly providerGeneration: ProviderGeneration;
  readonly inventory: readonly RemoteObject[];
  readonly committedCursor: ProviderCursor;
  readonly markerObject: RemoteObject;
  readonly marker: SnapshotCommitMarkerV1;
  readonly markerBytes: Uint8Array;
  readonly markerSourceRef: LocalObjectRef;
  readonly packageObject: RemoteObject;
  readonly package: SnapshotPackageV1 | SnapshotPackageV2;
  readonly packageBytes: Uint8Array;
  readonly packageSourceRef: LocalObjectRef;
}

function compareSnapshotCandidate(
  left: RemoteSnapshotCandidate,
  right: RemoteSnapshotCandidate,
): number {
  return (
    compareHlc(left.marker.committedAt, right.marker.committedAt) ||
    compareUtf8Bytewise(left.marker.snapshotId, right.marker.snapshotId) ||
    compareUtf8Bytewise(left.syncGenerationId, right.syncGenerationId) ||
    compareUtf8Bytewise(left.markerObject.objectId, right.markerObject.objectId)
  );
}

function singleLogicalObject(
  inventory: readonly RemoteObject[],
  logicalKeyId: string,
  objectKind: string,
): RemoteObject {
  const matches = inventory.filter((object) => object.logicalKeyId === logicalKeyId);
  if (matches.length === 0) {
    throw new CloudRestoreError('blocked-corrupt', 'Committed immutable object is missing');
  }
  if (matches.some((object) => object.objectKind !== objectKind)) {
    throw new CloudRestoreError('blocked-corrupt', 'Logical key resolves to another object kind');
  }
  const first = matches[0]!;
  if (matches.some((object) => !sameImmutableValue(first, object))) {
    throw new CloudRestoreError('blocked-corrupt', 'Logical key has conflicting duplicates');
  }
  return [...matches].sort((a, b) => compareUtf8Bytewise(a.objectId, b.objectId))[0]!;
}

async function discoverLatestSnapshot(input: {
  db: DbClient;
  syncGenerationId: string;
  provider: ObjectLogProvider;
  providerGeneration: ProviderGeneration;
  objectAccess: RestoreObjectAccess;
  signal: AbortSignal;
  attemptId: string;
  nowIso: () => string;
}): Promise<RemoteSnapshotCandidate> {
  const discovery = await discoverCurrentSyncGenerationObjects({
    provider: input.provider,
    generation: input.providerGeneration,
    signal: input.signal,
  });
  const markers = discovery.objects.filter((object) => object.objectKind === 'snapshot-commit');
  if (markers.length === 0) {
    throw new CloudRestoreError('blocked-corrupt', 'Remote project has no committed snapshot');
  }
  const decoded: RemoteSnapshotCandidate[] = [];
  for (const markerObject of markers) {
    const markerDownload = await input.objectAccess.decodeProtocol({
      provider: input.provider,
      generation: input.providerGeneration,
      remoteObject: markerObject,
      transferId: `restore-marker:${input.attemptId}:${input.syncGenerationId}:${markerObject.objectId}`,
      signal: input.signal,
    });
    const markerResult = decodeSnapshotCommitMarkerV1(markerDownload.bytes);
    if (!markerResult.ok) {
      const blockedState = markerResult.reason.includes('unsupported')
        ? 'blocked-update'
        : 'blocked-corrupt';
      await quarantineRestoreObject({
        db: input.db,
        syncGenerationId: input.syncGenerationId,
        remoteObject: markerObject,
        sourceRef: markerDownload.sourceRef,
        reason: markerResult.reason,
        state: blockedState,
        observedProtocol: 'drifting.sync.snapshot-commit',
        ...(typeof markerResult.observed === 'number'
          ? { observedVersion: markerResult.observed }
          : {}),
        nowIso: input.nowIso(),
      });
      throw new CloudRestoreError(
        blockedState,
        `Snapshot commit marker is quarantined: ${markerResult.reason}`,
      );
    }
    const marker = markerResult.value;
    if (marker.syncGenerationId !== input.syncGenerationId) {
      throw new CloudRestoreError('blocked-corrupt', 'Snapshot marker crosses project generation');
    }
    const expectedMarkerKey = await canonicalLogicalKeyId(
      `snapshot/${input.syncGenerationId}/${marker.snapshotKind}/${marker.snapshotId}/commit`,
    );
    const expectedPackageKey = await canonicalLogicalKeyId(
      `snapshot/${input.syncGenerationId}/${marker.snapshotKind}/${marker.snapshotId}/package`,
    );
    if (
      markerObject.logicalKeyId !== expectedMarkerKey ||
      marker.packageLogicalKeyId !== expectedPackageKey
    ) {
      throw new CloudRestoreError('blocked-corrupt', 'Snapshot logical identity is invalid');
    }
    const packageObject = singleLogicalObject(
      discovery.objects,
      marker.packageLogicalKeyId,
      marker.snapshotKind,
    );
    const packageDownload = await input.objectAccess.decodeProtocol({
      provider: input.provider,
      generation: input.providerGeneration,
      remoteObject: packageObject,
      transferId: `restore-package:${input.attemptId}:${input.syncGenerationId}:${packageObject.objectId}`,
      signal: input.signal,
    });
    if (packageDownload.contentSha256 !== marker.packageSha256) {
      throw new CloudRestoreError('blocked-corrupt', 'Snapshot package hash differs from marker');
    }
    let validated: Awaited<ReturnType<typeof validateSnapshotForRestore>>;
    try {
      validated = await validateSnapshotForRestore({
        packageBytes: packageDownload.bytes,
        commitMarkerBytes: markerDownload.bytes,
        expected: {
          projectId: marker.projectId,
          projectSyncId: marker.projectSyncId,
          syncGenerationId: marker.syncGenerationId,
        },
      });
    } catch (error) {
      const state =
        error instanceof Error && 'code' in error && error.code === 'unknown-version'
          ? 'blocked-update'
          : 'blocked-corrupt';
      await quarantineRestoreObject({
        db: input.db,
        syncGenerationId: input.syncGenerationId,
        remoteObject: packageObject,
        sourceRef: packageDownload.sourceRef,
        reason: error instanceof Error && 'code' in error ? String(error.code) : 'invalid-package',
        state,
        observedProtocol: 'drifting.sync.snapshot',
        nowIso: input.nowIso(),
      });
      throw new CloudRestoreError(state, 'Snapshot failed isolated validation', error);
    }
    decoded.push({
      syncGenerationId: input.syncGenerationId,
      providerGeneration: input.providerGeneration,
      inventory: discovery.objects,
      committedCursor: discovery.committedCursor,
      markerObject,
      marker,
      markerBytes: markerDownload.bytes,
      markerSourceRef: markerDownload.sourceRef,
      packageObject,
      package: validated.package,
      packageBytes: packageDownload.bytes,
      packageSourceRef: packageDownload.sourceRef,
    });
  }
  decoded.sort(compareSnapshotCandidate);
  return decoded[decoded.length - 1]!;
}

function newestPerProjectSync(
  candidates: readonly RemoteSnapshotCandidate[],
): RemoteSnapshotCandidate[] {
  const selected = new Map<string, RemoteSnapshotCandidate>();
  for (const candidate of candidates) {
    const previous = selected.get(candidate.marker.projectSyncId);
    if (!previous || compareSnapshotCandidate(previous, candidate) < 0) {
      selected.set(candidate.marker.projectSyncId, candidate);
    }
  }
  return [...selected.values()].sort(
    (left, right) =>
      compareUtf8Bytewise(left.marker.projectSyncId, right.marker.projectSyncId) ||
      compareUtf8Bytewise(left.syncGenerationId, right.syncGenerationId),
  );
}

async function recordRemoteObjects(
  db: DbClient,
  syncGenerationId: string,
  objects: readonly RemoteObject[],
  nowIso: string,
  observedCursor?: string,
): Promise<void> {
  await db.transaction((tx) =>
    recordRemoteObjectsInTransaction(tx, syncGenerationId, objects, nowIso, observedCursor),
  );
}

async function durableRemoteObjectRowId(
  executor: DbExecutor,
  syncGenerationId: string,
  providerObjectId: string,
): Promise<string> {
  const [row] = await executor
    .select({ id: SyncRemoteObjectTable.id })
    .from(SyncRemoteObjectTable)
    .where(
      and(
        eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
        eq(SyncRemoteObjectTable.providerObjectId, providerObjectId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new CloudRestoreError('restore-failed', 'Remote commit marker was not durably recorded');
  }
  return row.id;
}

async function recordRemoteObjectsInTransaction(
  tx: DbTransaction,
  syncGenerationId: string,
  objects: readonly RemoteObject[],
  nowIso: string,
  observedCursor?: string,
): Promise<void> {
  for (const object of objects) {
    const id = remoteRowId(syncGenerationId, object.objectId);
    const [existing] = await tx
      .select()
      .from(SyncRemoteObjectTable)
      .where(
        and(
          eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
          eq(SyncRemoteObjectTable.providerObjectId, object.objectId),
        ),
      )
      .limit(1);
    if (
      existing &&
      (existing.logicalKeyId !== object.logicalKeyId ||
        existing.objectKind !== object.objectKind ||
        existing.storedSha256 !== sha256Hex(object.storedSha256) ||
        existing.sizeBytes !== object.sizeBytes)
    ) {
      throw new CloudRestoreError('blocked-corrupt', 'Durable provider object identity changed');
    }
    await tx
      .insert(SyncRemoteObjectTable)
      .values({
        id,
        syncGenerationId,
        providerObjectId: object.objectId,
        logicalKeyId: object.logicalKeyId,
        objectKind: object.objectKind,
        storedSha256: sha256Hex(object.storedSha256),
        sizeBytes: object.sizeBytes,
        observedCursor: observedCursor ?? existing?.observedCursor ?? null,
        firstObservedAt: existing?.firstObservedAt ?? nowIso,
        lastObservedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [SyncRemoteObjectTable.syncGenerationId, SyncRemoteObjectTable.providerObjectId],
        set: {
          lastObservedAt: nowIso,
          removedAt: null,
          ...(observedCursor ? { observedCursor } : {}),
        },
      });
  }
}

async function persistRecoveredProviderStateInTransaction(input: {
  tx: DbTransaction;
  candidates: readonly RemoteSnapshotCandidate[];
  provider: ObjectLogProvider;
  account: CloudProviderAccount;
  authorityGeneration: number;
  nowIso: string;
}): Promise<void> {
  for (const candidate of input.candidates) {
    const binding: ProviderBinding = {
      bindingId: activeProviderBindingId(input.authorityGeneration, candidate.syncGenerationId),
      syncGenerationId: candidate.syncGenerationId,
      accountRef: input.account.accountSubject,
      secretRef: input.account.credentialSecretRef,
      authorityGeneration: input.authorityGeneration,
    };
    const providerEpoch = syncProviderEpoch(input.provider.kind, binding);
    await recordRemoteObjectsInTransaction(
      input.tx,
      candidate.syncGenerationId,
      candidate.inventory,
      input.nowIso,
      candidate.committedCursor,
    );
    await input.tx.insert(SyncCursorTable).values({
      syncGenerationId: candidate.syncGenerationId,
      providerEpoch,
      committedCursor: candidate.committedCursor,
      pendingBaseCursor: null,
      pendingPageToken: null,
      inventoryComplete: true,
      updatedAt: input.nowIso,
    });
  }
}

export type CloudRestoreFailureCode =
  | 'blocked-update'
  | 'blocked-corrupt'
  | 'local-project-sync-conflict'
  | 'restore-failed';

export class CloudRestoreError extends Error {
  constructor(
    readonly code: CloudRestoreFailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CloudRestoreError';
  }
}

export interface CloudRestoreDependencies {
  readonly provider: ObjectLogProvider;
  readonly discovery: ProjectSnapshotDiscoveryPort;
  readonly objectAccess: RestoreObjectAccess;
  readonly assetRestorePort: SnapshotAssetRestorePort;
  claimAccount(credentialSecretRef: string, accountSubject: string): Promise<CloudProviderAccount>;
  loadWriterIdentity(): Promise<SyncWriterIdentitySource>;
  publishLocalSyncGeneration(input: {
    db: DbClient;
    attempt: SyncProviderTransitionAttempt;
    account: CloudProviderAccount;
    syncGenerationId: string;
    projectId: string;
    providerGeneration: ProviderGeneration;
    signal: AbortSignal;
  }): Promise<{ commitMarkerRemoteObjectId: string }>;
  readonly nowIso?: () => string;
  readonly createAttemptId?: () => string;
  readonly emitAuthorityChanged?: () => void;
  readonly emitProjectChanged?: (projectId: string) => void;
}

async function activeLocalSyncGenerations(db: DbClient) {
  const generations = await db
    .select({
      syncGenerationId: SyncGenerationTable.syncGenerationId,
      projectId: SyncGenerationTable.projectId,
      projectSyncId: SyncGenerationTable.projectSyncId,
    })
    .from(SyncGenerationTable)
    .where(eq(SyncGenerationTable.status, 'active'));
  return Promise.all(
    generations.map(async (generation) => ({
      ...generation,
      authorityProjectId: await resolveSyncGenerationAuthorityProjectId(db, generation),
    })),
  );
}

async function resolveAttempt(input: {
  db: DbClient;
  account: CloudProviderAccount;
  dependencies: CloudRestoreDependencies;
  attemptId?: string;
}): Promise<SyncProviderTransitionAttempt> {
  const authority = createSyncAppAuthorityRepository(input.db);
  const current = await authority.read();
  if (current.transitionState !== 'stable') {
    if (!input.attemptId || current.attemptId !== input.attemptId) {
      throw new CloudRestoreError('restore-failed', 'Another provider transition is in progress');
    }
    const [row] = await input.db
      .select()
      .from(SyncConnectAttemptTable)
      .where(eq(SyncConnectAttemptTable.attemptId, input.attemptId))
      .limit(1);
    if (
      !row ||
      row.kind !== 'connect' ||
      row.targetMode !==
        (input.dependencies.provider.kind === 'hosted' ? 'hosted' : 'google-drive') ||
      row.targetAccountSubjectId !== input.account.accountSubject ||
      row.targetCredentialSecretRef !== input.account.credentialSecretRef
    ) {
      throw new CloudRestoreError(
        'restore-failed',
        'Connect retry does not own its durable attempt',
      );
    }
    if (current.transitionState === 'blocked') {
      await authority.resume({
        attemptId: row.attemptId,
        nowIso: input.dependencies.nowIso?.() ?? new Date().toISOString(),
      });
    }
    const children = await input.db
      .select({
        sourceSyncGenerationId: SyncConnectGenerationAttemptTable.sourceSyncGenerationId,
        targetSyncGenerationId: SyncConnectGenerationAttemptTable.targetSyncGenerationId,
      })
      .from(SyncConnectGenerationAttemptTable)
      .where(eq(SyncConnectGenerationAttemptTable.attemptId, row.attemptId));
    return {
      attemptId: row.attemptId,
      kind: 'connect',
      sourceMode: 'local',
      targetMode: input.dependencies.provider.kind === 'hosted' ? 'hosted' : 'google-drive',
      authorityGeneration: row.authorityGeneration,
      generations: children.map((child) => ({
        sourceSyncGenerationId: child.sourceSyncGenerationId,
        targetSyncGenerationId: child.targetSyncGenerationId,
      })),
    };
  }
  if (current.mode !== 'local') {
    throw new CloudRestoreError('restore-failed', 'Cloud is already connected');
  }
  return authority.begin({
    targetMode: input.dependencies.provider.kind === 'hosted' ? 'hosted' : 'google-drive',
    accountSubjectId: input.account.accountSubject,
    credentialSecretRef: input.account.credentialSecretRef,
    attemptId:
      input.attemptId ??
      input.dependencies.createAttemptId?.() ??
      `connect-${input.dependencies.provider.kind}-${uuidv7()}`,
    nowIso: input.dependencies.nowIso?.() ?? new Date().toISOString(),
  });
}

async function restoreBlobs(input: {
  candidate: RemoteSnapshotCandidate;
  provider: ObjectLogProvider;
  objectAccess: RestoreObjectAccess;
  signal: AbortSignal;
  attemptId: string;
}): Promise<Map<string, LocalObjectRef>> {
  const sources = new Map<string, LocalObjectRef>();
  try {
    for (const blobId of input.candidate.package.requiredBlobIds) {
      const typedBlobId = blobId as Sha256;
      const logicalKeyId = await input.objectAccess.deriveBlobLogicalKey({
        syncGenerationId: input.candidate.syncGenerationId,
        blobId: typedBlobId,
      });
      const remote = singleLogicalObject(input.candidate.inventory, logicalKeyId, 'blob');
      const decoded = await input.objectAccess.decodeBlob({
        provider: input.provider,
        generation: input.candidate.providerGeneration,
        remoteObject: remote,
        transferId: `restore-blob:${input.attemptId}:${input.candidate.syncGenerationId}:${remote.objectId}`,
        signal: input.signal,
      });
      if (decoded.contentSha256 !== typedBlobId) {
        await input.objectAccess.discard?.(decoded.sourceRef).catch(() => {});
        throw new CloudRestoreError('blocked-corrupt', `Blob ${blobId} failed content addressing`);
      }
      const declaredSizes = new Set(
        input.candidate.package.assets
          .filter((asset) => asset.blobId === blobId)
          .map((asset) => asset.sizeBytes),
      );
      if (declaredSizes.size !== 1 || !declaredSizes.has(decoded.sizeBytes)) {
        await input.objectAccess.discard?.(decoded.sourceRef).catch(() => {});
        throw new CloudRestoreError(
          'blocked-corrupt',
          `Blob ${blobId} size conflicts with snapshot`,
        );
      }
      sources.set(blobId, decoded.sourceRef);
    }
    return sources;
  } catch (error) {
    for (const ref of sources.values()) await input.objectAccess.discard?.(ref).catch(() => {});
    throw error;
  }
}

export interface RestoreCloudSyncGenerationsInput {
  readonly db: DbClient;
  readonly account: CloudProviderAccount;
  readonly localUserId?: string;
  readonly signal: AbortSignal;
  readonly attemptId?: string;
  readonly dependencies: CloudRestoreDependencies;
}

export interface RestoreCloudSyncGenerationsResult {
  readonly attemptId: string;
  readonly restored: readonly {
    syncGenerationId: string;
    projectId: string;
    projectSyncId: string;
    snapshotId: string;
  }[];
  readonly connectedLocalSyncGenerationIds: readonly string[];
}

/**
 * Unified trusted-cloud connect. Account-level discovery decides whether the
 * operation publishes local genesis objects, restores remote projects, or
 * performs both before one atomic App authority activation.
 */
export async function restoreCloudSyncGenerations(
  input: RestoreCloudSyncGenerationsInput,
): Promise<RestoreCloudSyncGenerationsResult> {
  const account = input.account;
  requireNonEmpty(account.accountSubject, 'Provider account subject');
  requireNonEmpty(account.credentialSecretRef, 'Provider credential secret reference');
  const dependencies = input.dependencies;
  const repository = createSyncAppAuthorityRepository(input.db);
  let ownedAttemptId: string | null = null;
  try {
    const attempt = await resolveAttempt({
      db: input.db,
      account,
      dependencies,
      attemptId: input.attemptId,
    });
    ownedAttemptId = attempt.attemptId;
    const claimed = await dependencies.claimAccount(
      account.credentialSecretRef,
      account.accountSubject,
    );
    if (
      claimed.accountSubject !== account.accountSubject ||
      claimed.credentialSecretRef !== account.credentialSecretRef
    ) {
      throw new CloudRestoreError(
        'restore-failed',
        'Provider credential claim changed its durable identity',
      );
    }
    await repository.setAttemptState({
      attemptId: attempt.attemptId,
      state: 'discovering',
      nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
    });

    const ownedAttemptSyncGenerationIds = new Set(
      attempt.generations.map((generation) => generation.sourceSyncGenerationId),
    );
    const localBeforeRestore = (await activeLocalSyncGenerations(input.db)).filter((generation) =>
      ownedAttemptSyncGenerationIds.has(generation.syncGenerationId),
    );

    const discoveredSnapshots = await dependencies.discovery.discover({
      credentialSecretRef: account.credentialSecretRef,
      accountSubject: account.accountSubject,
      signal: input.signal,
    });
    const remoteSyncGenerationIds = [
      ...new Set(discoveredSnapshots.map(({ syncGenerationId }) => syncGenerationId)),
    ].sort(compareUtf8Bytewise);
    const localBySyncGenerationId = new Map(
      localBeforeRestore.map((generation) => [generation.syncGenerationId, generation] as const),
    );

    const targetGeneration = attempt.authorityGeneration + 1;
    const discovered: RemoteSnapshotCandidate[] = [];
    for (const syncGenerationId of remoteSyncGenerationIds) {
      // A generation that survived an earlier disconnect is already the local
      // project authority. Reconnecting that exact identity must rebind it, not
      // stage a duplicate restore generation or overwrite its offline edits.
      if (!localBySyncGenerationId.has(syncGenerationId)) {
        const disposition = await stageUnresolvedProjectGeneration({
          db: input.db,
          syncGenerationId,
          nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
        });
        if (disposition === 'skip-terminal-local') continue;
      }
      const providerGeneration = await dependencies.provider.openGeneration(
        temporaryBinding({
          attemptId: attempt.attemptId,
          syncGenerationId,
          account,
          targetAuthorityGeneration: targetGeneration,
        }),
      );
      discovered.push(
        await discoverLatestSnapshot({
          db: input.db,
          syncGenerationId,
          provider: dependencies.provider,
          providerGeneration,
          objectAccess: dependencies.objectAccess,
          signal: input.signal,
          attemptId: attempt.attemptId,
          nowIso: dependencies.nowIso ?? (() => new Date().toISOString()),
        }),
      );
    }

    const selected = newestPerProjectSync(discovered);
    const selectedSyncGenerationIds = new Set(
      selected.map((candidate) => candidate.syncGenerationId),
    );
    const retiredAt = dependencies.nowIso?.() ?? new Date().toISOString();
    for (const candidate of discovered) {
      if (selectedSyncGenerationIds.has(candidate.syncGenerationId)) continue;
      if (localBySyncGenerationId.has(candidate.syncGenerationId)) continue;
      await input.db
        .update(SyncGenerationTable)
        .set({ status: 'retired', retiredAt, updatedAt: retiredAt })
        .where(eq(SyncGenerationTable.syncGenerationId, candidate.syncGenerationId));
    }
    const localProjectSyncs = new Set(
      localBeforeRestore.map((generation) => generation.projectSyncId),
    );
    const reconnectCandidates: RemoteSnapshotCandidate[] = [];
    const restoreCandidates: RemoteSnapshotCandidate[] = [];
    for (const candidate of selected) {
      const local = localBySyncGenerationId.get(candidate.syncGenerationId);
      if (local) {
        if (
          local.authorityProjectId !== candidate.marker.projectId ||
          local.projectSyncId !== candidate.marker.projectSyncId
        ) {
          throw new CloudRestoreError(
            'local-project-sync-conflict',
            'Remote generation identity conflicts with its local project authority',
          );
        }
        reconnectCandidates.push(candidate);
        continue;
      }
      if (localProjectSyncs.has(candidate.marker.projectSyncId)) {
        throw new CloudRestoreError(
          'local-project-sync-conflict',
          'A remote project belongs to another generation of a local projectSync',
        );
      }
      restoreCandidates.push(candidate);
    }
    for (const candidate of restoreCandidates) {
      await repository.stageRestoreSyncGeneration({
        attemptId: attempt.attemptId,
        syncGenerationId: candidate.syncGenerationId,
        projectSyncId: candidate.marker.projectSyncId,
        projectId: candidate.marker.projectId,
        nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
      });
    }

    await repository.setAttemptState({
      attemptId: attempt.attemptId,
      state: 'publishing-genesis',
      nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
    });
    const connectedLocalSyncGenerationIds: string[] = [];
    const reconnectedSyncGenerationIds = new Set<string>();
    for (const candidate of reconnectCandidates) {
      const observedAt = dependencies.nowIso?.() ?? new Date().toISOString();
      await recordRemoteObjects(
        input.db,
        candidate.syncGenerationId,
        candidate.inventory,
        observedAt,
        candidate.committedCursor,
      );
      await repository.markSyncGenerationCommitted({
        attemptId: attempt.attemptId,
        sourceSyncGenerationId: candidate.syncGenerationId,
        commitMarkerObjectId: await durableRemoteObjectRowId(
          input.db,
          candidate.syncGenerationId,
          candidate.markerObject.objectId,
        ),
        nowIso: observedAt,
      });
      reconnectedSyncGenerationIds.add(candidate.syncGenerationId);
      connectedLocalSyncGenerationIds.push(candidate.syncGenerationId);
    }
    for (const local of localBeforeRestore) {
      if (!local.projectId) continue;
      if (reconnectedSyncGenerationIds.has(local.syncGenerationId)) continue;
      const [child] = await input.db
        .select({ state: SyncConnectGenerationAttemptTable.state })
        .from(SyncConnectGenerationAttemptTable)
        .where(
          and(
            eq(SyncConnectGenerationAttemptTable.attemptId, attempt.attemptId),
            eq(SyncConnectGenerationAttemptTable.sourceSyncGenerationId, local.syncGenerationId),
          ),
        )
        .limit(1);
      if (child?.state === 'committed' || child?.state === 'activated') {
        connectedLocalSyncGenerationIds.push(local.syncGenerationId);
        continue;
      }
      const providerGeneration = await dependencies.provider.openGeneration(
        temporaryBinding({
          attemptId: attempt.attemptId,
          syncGenerationId: local.syncGenerationId,
          account,
          targetAuthorityGeneration: targetGeneration,
        }),
      );
      const published = await dependencies.publishLocalSyncGeneration({
        db: input.db,
        attempt,
        account,
        syncGenerationId: local.syncGenerationId,
        projectId: local.projectId,
        providerGeneration,
        signal: input.signal,
      });
      await repository.markSyncGenerationCommitted({
        attemptId: attempt.attemptId,
        sourceSyncGenerationId: local.syncGenerationId,
        commitMarkerObjectId: published.commitMarkerRemoteObjectId,
        nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
      });
      connectedLocalSyncGenerationIds.push(local.syncGenerationId);
    }

    await repository.setAttemptState({
      attemptId: attempt.attemptId,
      state: 'restoring',
      nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
    });
    const { restored, atomicInputs, downloadedBlobRefs } = await prepareRestoredSnapshots(
      input,
      dependencies,
      restoreCandidates,
      attempt.attemptId,
    );

    await repository.setAttemptState({
      attemptId: attempt.attemptId,
      state: 'activating',
      nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
    });
    let authorityCompleted = false;
    try {
      await restoreSnapshotsAtomically({
        snapshots: atomicInputs,
        ...(atomicInputs.length > 0
          ? {
              activationBarrier: async ({
                tx,
                activatedAt,
              }: {
                tx: DbTransaction;
                results: readonly RestoreSnapshotResultV1[];
                activatedAt: string;
              }) => {
                for (const candidate of restoreCandidates) {
                  const markerId = await durableRemoteObjectRowId(
                    tx,
                    candidate.syncGenerationId,
                    candidate.markerObject.objectId,
                  );
                  const updated = await tx
                    .update(SyncConnectGenerationAttemptTable)
                    .set({
                      commitMarkerObjectId: markerId,
                      sourceCheckpointId: candidate.marker.snapshotId,
                      state: 'committed',
                      errorCode: null,
                      updatedAt: activatedAt,
                    })
                    .where(
                      and(
                        eq(SyncConnectGenerationAttemptTable.attemptId, attempt.attemptId),
                        eq(
                          SyncConnectGenerationAttemptTable.sourceSyncGenerationId,
                          candidate.syncGenerationId,
                        ),
                      ),
                    )
                    .returning({
                      syncGenerationId: SyncConnectGenerationAttemptTable.sourceSyncGenerationId,
                    });
                  if (updated.length !== 1) {
                    throw new Error('Restored project transition disappeared before activation');
                  }
                }
                await repository.completeInTransaction(tx, {
                  attemptId: attempt.attemptId,
                  bindings: [
                    ...new Set([
                      ...localBeforeRestore.map((generation) => generation.syncGenerationId),
                      ...selected.map((candidate) => candidate.syncGenerationId),
                    ]),
                  ].map((syncGenerationId) => ({
                    syncGenerationId,
                    providerNamespace:
                      dependencies.provider.kind === 'hosted' ? 'project-v1' : 'appDataFolder',
                    providerGenerationRef: null,
                  })),
                  nowIso: activatedAt,
                });
                await persistRecoveredProviderStateInTransaction({
                  tx,
                  candidates: selected,
                  provider: dependencies.provider,
                  account,
                  authorityGeneration: targetGeneration,
                  nowIso: activatedAt,
                });
                authorityCompleted = true;
              },
            }
          : {}),
      });
    } finally {
      for (const sourceRef of downloadedBlobRefs) {
        await dependencies.objectAccess.discard?.(sourceRef).catch(() => {});
      }
    }
    if (!authorityCompleted) {
      await input.db.transaction(async (tx) => {
        const activatedAt = dependencies.nowIso?.() ?? new Date().toISOString();
        await repository.completeInTransaction(tx, {
          attemptId: attempt.attemptId,
          bindings: [
            ...new Set([
              ...localBeforeRestore.map((generation) => generation.syncGenerationId),
              ...selected.map((candidate) => candidate.syncGenerationId),
            ]),
          ].map((syncGenerationId) => ({
            syncGenerationId,
            providerNamespace:
              dependencies.provider.kind === 'hosted' ? 'project-v1' : 'appDataFolder',
            providerGenerationRef: null,
          })),
          nowIso: activatedAt,
        });
        await persistRecoveredProviderStateInTransaction({
          tx,
          candidates: selected,
          provider: dependencies.provider,
          account,
          authorityGeneration: targetGeneration,
          nowIso: activatedAt,
        });
      });
    }
    try {
      dependencies.emitAuthorityChanged?.();
    } catch {
      console.warn('[SyncRestore] Authority notification failed after a committed connect');
    }
    for (const { projectId } of restored) {
      try {
        dependencies.emitProjectChanged?.(projectId);
      } catch {
        console.warn('[SyncRestore] Project notification failed after a committed restore');
      }
    }
    return {
      attemptId: attempt.attemptId,
      restored: Object.freeze(restored),
      connectedLocalSyncGenerationIds: Object.freeze(
        connectedLocalSyncGenerationIds.sort(compareUtf8Bytewise),
      ),
    };
  } catch (error) {
    if (ownedAttemptId) {
      const code = error instanceof CloudRestoreError ? error.code : 'restore-failed';
      await repository
        .block({
          attemptId: ownedAttemptId,
          errorCode: code,
          nowIso: dependencies.nowIso?.() ?? new Date().toISOString(),
        })
        .catch(() => {});
      try {
        dependencies.emitAuthorityChanged?.();
      } catch {
        console.warn('[SyncRestore] Authority notification failed after a blocked connect');
      }
    }
    if (error instanceof CloudRestoreError) throw error;
    throw new CloudRestoreError('restore-failed', 'Cloud connect failed closed', error);
  }
}

async function prepareRestoredSnapshots(
  input: { db: DbClient; signal: AbortSignal; localUserId?: string },
  dependencies: CloudRestoreDependencies,
  candidates: readonly RemoteSnapshotCandidate[],
  attemptId: string,
) {
  const restored: RestoreCloudSyncGenerationsResult['restored'][number][] = [];
  const atomicInputs: RestoreSnapshotInputV1[] = [];
  const downloadedBlobRefs: LocalObjectRef[] = [];
  try {
    const restoreWriterIdentity =
      candidates.length > 0 ? await dependencies.loadWriterIdentity() : null;
    for (const candidate of candidates) {
      const restoreAttemptId = `snapshot-restore:${attemptId}:${candidate.syncGenerationId}`;
      const [completed] = await input.db
        .select()
        .from(SyncRestoreAttemptTable)
        .where(eq(SyncRestoreAttemptTable.attemptId, restoreAttemptId))
        .limit(1);
      if (completed?.state !== 'completed') {
        await recordRemoteObjects(
          input.db,
          candidate.syncGenerationId,
          [candidate.markerObject, candidate.packageObject],
          dependencies.nowIso?.() ?? new Date().toISOString(),
        );
        const blobSources = await restoreBlobs({
          candidate,
          provider: dependencies.provider,
          objectAccess: dependencies.objectAccess,
          signal: input.signal,
          attemptId: attemptId,
        });
        downloadedBlobRefs.push(...blobSources.values());
        const blobLogicalKeyIds = new Map<string, string>();
        for (const blobId of candidate.package.requiredBlobIds) {
          blobLogicalKeyIds.set(
            blobId,
            await dependencies.objectAccess.deriveBlobLogicalKey({
              syncGenerationId: candidate.syncGenerationId,
              blobId: blobId as Sha256,
            }),
          );
        }
        await recordRemoteObjects(
          input.db,
          candidate.syncGenerationId,
          [...blobLogicalKeyIds.values()].map((logicalKeyId) =>
            singleLogicalObject(candidate.inventory, logicalKeyId, 'blob'),
          ),
          dependencies.nowIso?.() ?? new Date().toISOString(),
        );
        atomicInputs.push({
          db: input.db,
          attemptId: restoreAttemptId,
          stagingRef: candidate.packageSourceRef,
          packageObject: {
            storedSha256: candidate.packageObject.storedSha256,
            sizeBytes: candidate.packageObject.sizeBytes,
          },
          expected: {
            projectId: candidate.marker.projectId,
            projectSyncId: candidate.marker.projectSyncId,
            syncGenerationId: candidate.syncGenerationId,
          },
          localUserId: input.localUserId ?? DEFAULT_LOCAL_USER_ID,
          writerIdentity: restoreWriterIdentity!,
          packageBytes: candidate.packageBytes,
          commitMarkerBytes: candidate.markerBytes,
          blobSources,
          blobLogicalKeyIds,
          assetPort: dependencies.assetRestorePort,
          ...(dependencies.nowIso ? { nowIso: dependencies.nowIso } : {}),
        });
      }
      restored.push({
        syncGenerationId: candidate.syncGenerationId,
        projectId: candidate.marker.projectId,
        projectSyncId: candidate.marker.projectSyncId,
        snapshotId: candidate.marker.snapshotId,
      });
    }

    return { restored, atomicInputs, downloadedBlobRefs };
  } catch (error) {
    for (const ref of downloadedBlobRefs)
      await dependencies.objectAccess.discard?.(ref).catch(() => {});
    throw error;
  }
}

/** Discover projects created on another device without replacing local authority or prose. */
export async function restoreDiscoveredCloudProjects(
  input: Omit<RestoreCloudSyncGenerationsInput, 'attemptId'>,
): Promise<RestoreCloudSyncGenerationsResult['restored']> {
  const { db, dependencies, account } = input;
  const repository = createSyncAppAuthorityRepository(db);
  const authority = await repository.read();
  if (authority.transitionState !== 'stable' || authority.mode !== dependencies.provider.kind)
    return [];
  const [ownedAccount] = await db
    .select()
    .from(SyncProviderAccountTable)
    .where(
      and(
        eq(SyncProviderAccountTable.authorityGeneration, authority.generation),
        eq(SyncProviderAccountTable.providerKind, authority.mode),
        eq(SyncProviderAccountTable.accountSubjectId, account.accountSubject),
      ),
    )
    .limit(1);
  if (!ownedAccount || ownedAccount.credentialSecretRef !== account.credentialSecretRef)
    throw new Error('CLOUD_ACCOUNT_MISMATCH');
  const bindings = await db.select().from(SyncProviderBindingTable);
  if (bindings.some((binding) => binding.state === 'paused' || binding.state === 'needs-reauth'))
    return [];
  await dependencies.claimAccount(account.credentialSecretRef, account.accountSubject);
  const generationIds = [
    ...new Set(
      (await dependencies.discovery.discover({ ...account, signal: input.signal })).map(
        (item) => item.syncGenerationId,
      ),
    ),
  ].sort(compareUtf8Bytewise);
  const attemptId = `discovery:${authority.generation}:${ownedAccount.id}`;
  const discovered: RemoteSnapshotCandidate[] = [];
  for (const syncGenerationId of generationIds) {
    const [known] = await db
      .select()
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId))
      .limit(1);
    // Active and terminal identities are never overwritten or resurrected by discovery.
    if (known && (known.status !== 'staged' || known.projectId !== null)) continue;
    await stageUnresolvedProjectGeneration({
      db,
      syncGenerationId,
      nowIso: new Date().toISOString(),
    });
    const generation = await dependencies.provider.openGeneration(
      temporaryBinding({
        attemptId,
        syncGenerationId,
        account,
        targetAuthorityGeneration: authority.generation,
      }),
    );
    discovered.push(
      await discoverLatestSnapshot({
        db,
        syncGenerationId,
        provider: dependencies.provider,
        providerGeneration: generation,
        objectAccess: dependencies.objectAccess,
        signal: input.signal,
        attemptId,
        nowIso: dependencies.nowIso ?? (() => new Date().toISOString()),
      }),
    );
  }
  const candidates = newestPerProjectSync(discovered);
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(SyncGenerationTable)
        .where(eq(SyncGenerationTable.projectSyncId, candidate.marker.projectSyncId));
      if (existing.some((row) => row.syncGenerationId !== candidate.syncGenerationId))
        throw new Error('REMOTE_PROJECT_GENERATION_CONFLICT');
      const [staged] = await tx
        .select()
        .from(SyncGenerationTable)
        .where(eq(SyncGenerationTable.syncGenerationId, candidate.syncGenerationId));
      if (
        staged?.status !== 'staged' ||
        staged.projectId !== null ||
        (staged.projectSyncId !== unresolvedProjectSync(candidate.syncGenerationId) &&
          staged.projectSyncId !== candidate.marker.projectSyncId)
      )
        throw new Error('REMOTE_PROJECT_IDENTITY_CONFLICT');
      await tx
        .update(SyncGenerationTable)
        .set({ projectSyncId: candidate.marker.projectSyncId, updatedAt: new Date().toISOString() })
        .where(eq(SyncGenerationTable.syncGenerationId, candidate.syncGenerationId));
    });
  }
  if (candidates.length === 0) return [];
  const { restored, atomicInputs, downloadedBlobRefs } = await prepareRestoredSnapshots(
    input,
    dependencies,
    candidates,
    attemptId,
  );
  try {
    await restoreSnapshotsAtomically({
      snapshots: atomicInputs,
      activationBarrier: async ({ tx, activatedAt }) => {
        const [current] = await tx.select().from(SyncAppAuthorityTable).limit(1);
        const [currentAccount] = await tx
          .select()
          .from(SyncProviderAccountTable)
          .where(eq(SyncProviderAccountTable.id, ownedAccount.id))
          .limit(1);
        const currentBindings = await tx.select().from(SyncProviderBindingTable);
        if (
          current?.mode !== authority.mode ||
          current.generation !== authority.generation ||
          current.transitionState !== 'stable' ||
          currentAccount?.accountSubjectId !== account.accountSubject ||
          currentBindings.some(
            (binding) => binding.state === 'paused' || binding.state === 'needs-reauth',
          )
        )
          throw new Error('CLOUD_AUTHORITY_CHANGED');
        for (const candidate of candidates) {
          await tx
            .insert(SyncProviderBindingTable)
            .values({
              syncGenerationId: candidate.syncGenerationId,
              providerAccountId: ownedAccount.id,
              providerNamespace: authority.mode === 'hosted' ? 'project-v1' : 'appDataFolder',
              providerGenerationRef: null,
              state: 'ready',
              connectedAt: activatedAt,
              updatedAt: activatedAt,
            });
        }
        await persistRecoveredProviderStateInTransaction({
          tx,
          candidates,
          provider: dependencies.provider,
          account,
          authorityGeneration: authority.generation,
          nowIso: activatedAt,
        });
      },
    });
  } finally {
    for (const ref of downloadedBlobRefs)
      await dependencies.objectAccess.discard?.(ref).catch(() => {});
  }
  dependencies.emitAuthorityChanged?.();
  for (const item of restored) dependencies.emitProjectChanged?.(item.projectId);
  return restored;
}
