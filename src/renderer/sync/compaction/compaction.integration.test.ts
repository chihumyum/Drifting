import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, asc, count, eq, isNotNull, ne } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  AgentWorkingMemoryTable,
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
  SyncApplyReceiptTable,
  SyncChangeSetTable,
  SyncFrontierGapTable,
  SyncGenerationTable,
  SyncJournalTruncationTable,
  SyncMutationTable,
  SyncProviderBindingTable,
  SyncReducerBaseTable,
  SyncRemoteObjectTable,
  SyncLocalObjectTable,
  SyncSegmentTable,
  SyncTransferTable,
  SyncYjsMaterializationReceiptTable,
} from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import {
  appliedJournalPosition,
  createProviderCheckpointHook,
  ProviderSnapshotPublisher,
} from '../checkpoint/provider-publisher';
import { captureCompactedReducerStateV2 } from '../checkpoint/reducer-state';
import type { SyncEngineBlobPort } from '../engine/blob-port';
import { SqliteSyncGenerationRuntime, type SyncEngineRuntimeClock } from '../engine/durable-runtime';
import { PlaintextSyncEngineObjectCodec } from '../engine/plaintext-object-codec';
import {
  appendYjsUpdateMutation,
  recordAuthoredChangeSetInTransaction,
  SyncChangeBuilder,
  type SyncWriterIdentitySource,
} from '../journal';
import { registerAuthoredYjsMaterialization } from '../journal/yjs-materialization';
import {
  decodeSyncChangeSetV1,
  sha256Bytes,
  type SyncChangeSetV1,
  type ProviderBinding,
  type ProviderGeneration,
  type RemoteObject,
} from '../protocol';
import { MemoryObjectLogProvider, MemoryProviderLocalObjectStore } from '../providers';
import { ObjectLogProviderError } from '../providers/provider-error';
import {
  applyVerifiedRemoteChangeSetInTransaction,
  canonicalReducerSnapshot,
  compactReducerReceipts,
  decodeReducerStatePagesV2,
  DEFAULT_SQLITE_REDUCER_PROFILE,
  getSqliteReducerLoadDiagnostics,
  invalidateSqliteReducerStateCache,
  loadSqliteReducerStateInTransaction,
  mergeCheckpointProseInTransaction,
  observeLocalAuthoredReducerInTransaction,
  rebaseSqliteReducerOntoAppliedCheckpointInTransaction,
  sqliteReplayReducerProfile,
  SqliteReducerRebaseMismatchError,
  type SyncDomainMaterializationKernel,
} from '../reducer';
import { discoverCurrentSyncGenerationObjects } from '../restore/cloud-restore';
import { truncateCoveredJournal } from './journal-truncation';
import { SyncLogCompactor } from './policy';
import { loadRemoteSnapshotCatalog } from './snapshot-catalog';

const PROJECT_ID = 'project-compaction';
const SYNC_GENERATION_ID = 'sync-generation-compaction';
const PROJECT_SYNC_ID = 'project-sync-compaction';
const NODE_ID = 'node-compaction';
const PROSE_DOC_ID = `node-content:${NODE_ID}`;
const NOW = '2026-10-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1_000;

const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];
/** Local object refs stay unique even when a device reopens its database. */
let nextRef = 1;

const titleKernel: SyncDomainMaterializationKernel = {
  async validate() {
    return [];
  },
  async materialize({ tx, effects }) {
    for (const effect of effects) {
      if (
        effect.materialize &&
        effect.type === 'field.set' &&
        effect.target.kind === 'node' &&
        effect.target.id === NODE_ID &&
        effect.field === 'title' &&
        typeof effect.value === 'string'
      ) {
        await tx.update(BookNodeTable).set({ title: effect.value }).where(eq(BookNodeTable.id, NODE_ID));
      }
    }
  },
};

const noBlobs: SyncEngineBlobPort = {
  async prepareOutbound() {
    throw new Error('No asset is expected in this fixture');
  },
  async verifyAndInstallInbound() {
    throw new Error('No asset is expected in this fixture');
  },
};

interface World {
  readonly clock: { value: number };
  readonly objects: MemoryProviderLocalObjectStore;
  readonly provider: MemoryObjectLogProvider;
}

interface Device {
  readonly id: string;
  readonly db: DbClient;
  readonly gateway: ProductFileBackedSqliteGateway;
  readonly identity: SyncWriterIdentitySource;
  readonly kernel: SyncDomainMaterializationKernel;
  readonly runtime: SqliteSyncGenerationRuntime;
  readonly objectCodec: PlaintextSyncEngineObjectCodec;
  readonly generation: ProviderGeneration;
  readonly publisher: ProviderSnapshotPublisher;
  readonly compactor: SyncLogCompactor;
}

function createWorld(graceMs = 30 * DAY_MS): World {
  const clock = { value: NOW_MS };
  const objects = new MemoryProviderLocalObjectStore();
  const provider = new MemoryObjectLogProvider(objects, {
    pruning: { graceMs, nowMs: () => clock.value },
  });
  return { clock, objects, provider };
}

async function createDatabase(deviceId: string): Promise<{ db: DbClient; gateway: ProductFileBackedSqliteGateway }> {
  const directory = await mkdtemp(path.join(tmpdir(), `drifting-compaction-${deviceId}-`));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Compaction project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: NODE_ID,
    projectId: PROJECT_ID,
    kind: 'chapter',
    title: 'Initial',
    summary: '',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(NodeContentTable).values({
    nodeId: NODE_ID,
    contentJson: '{"type":"doc","content":[]}',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    projectId: PROJECT_ID,
    projectSyncId: PROJECT_SYNC_ID,
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  // The provider binding requires a completed connect attempt whose marker
  // row exists. It never had local bytes, so it is recorded as removed.
  const run = (sql: string, ...values: unknown[]) => gateway.database.prepare(sql).run(...(values as never[]));
  run(
    `INSERT INTO sync_connect_attempt
      (attempt_id, authority_generation, kind, target_mode, target_account_subject_id,
       target_credential_secret_ref, state, created_at, updated_at)
     VALUES ('connect-hosted', 1, 'connect', 'hosted', 'account', ?, 'preparing', ?, ?)`,
    `secret-${deviceId}`, NOW, NOW,
  );
  run(
    `UPDATE sync_app_authority SET transition_state = 'connecting', target_mode = 'hosted',
       attempt_id = 'connect-hosted', updated_at = ? WHERE id = 'app'`,
    NOW,
  );
  run(
    `INSERT INTO sync_remote_object
      (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
       stored_sha256, size_bytes, first_observed_at, last_observed_at, removed_at)
     VALUES ('connect-marker', ?, 'connect-provider-marker', 'connect-logical-marker',
             'snapshot-commit', ?, 1, ?, ?, ?)`,
    SYNC_GENERATION_ID, '0'.repeat(64), NOW, NOW, NOW,
  );
  run(
    `INSERT INTO sync_connect_generation_attempt
      (attempt_id, source_sync_generation_id, commit_marker_object_id, state, created_at, updated_at)
     VALUES ('connect-hosted', ?, 'connect-marker', 'committed', ?, ?)`,
    SYNC_GENERATION_ID, NOW, NOW,
  );
  run(
    `UPDATE sync_connect_generation_attempt SET state = 'activated', activation_receipt = 'test',
       activated_at = ?, updated_at = ? WHERE attempt_id = 'connect-hosted'`,
    NOW, NOW,
  );
  run(
    `UPDATE sync_connect_attempt SET state = 'completed', completed_at = ?, updated_at = ?
     WHERE attempt_id = 'connect-hosted'`,
    NOW, NOW,
  );
  run(
    `UPDATE sync_app_authority SET mode = 'hosted', generation = 2, transition_state = 'stable',
       target_mode = NULL, attempt_id = NULL, updated_at = ? WHERE id = 'app'`,
    NOW,
  );
  run(
    `INSERT INTO sync_provider_account
      (id, singleton_key, authority_id, provider_kind, authority_generation,
       account_subject_id, credential_secret_ref, created_at, updated_at)
     VALUES (?, 1, 'app', 'hosted', 2, 'account', ?, ?, ?)`,
    `account-${deviceId}`, `secret-${deviceId}`, NOW, NOW,
  );
  await db.insert(SyncProviderBindingTable).values({
    syncGenerationId: SYNC_GENERATION_ID,
    providerAccountId: `account-${deviceId}`,
    providerNamespace: 'reference-provider',
    state: 'ready',
    connectedAt: NOW,
    updatedAt: NOW,
  });
  return { db, gateway };
}

async function createDevice(
  world: World,
  id: string,
  options: {
    readonly opened?: { db: DbClient; gateway: ProductFileBackedSqliteGateway };
    readonly kernel?: SyncDomainMaterializationKernel;
  } = {},
): Promise<Device> {
  const { db, gateway } = options.opened ?? (await createDatabase(id));
  const kernel = options.kernel ?? titleKernel;
  const identity: SyncWriterIdentitySource = {
    installationId: `installation-${id}`,
    createWriterIdentity: () => ({ writerId: `writer-${id}`, writerEpoch: `epoch-${id}` }),
  };
  const binding: ProviderBinding = {
    bindingId: `binding-${id}`,
    syncGenerationId: SYNC_GENERATION_ID,
    accountRef: null,
    secretRef: null,
    authorityGeneration: 2,
  };
  const objectCodec = new PlaintextSyncEngineObjectCodec({
    allocate: (input) => world.objects.ref(`${id}.${input.purpose}.${nextRef++}`),
    read: (ref, signal) => world.objects.read(ref, signal),
    write: (ref, bytes, signal) => world.objects.write(ref, bytes, signal),
  });
  const clock: SyncEngineRuntimeClock = {
    nowMs: () => world.clock.value,
    nowIso: () => new Date(world.clock.value).toISOString(),
  };
  const runtime = new SqliteSyncGenerationRuntime({
    db,
    syncGenerationId: SYNC_GENERATION_ID,
    provider: world.provider,
    providerBinding: binding,
    objectCodec,
    writerIdentity: identity,
    domainKernel: kernel,
    clock,
  });
  const generation = await world.provider.openGeneration(binding);
  const publisher = new ProviderSnapshotPublisher({
    db,
    projectId: PROJECT_ID,
    syncGenerationId: SYNC_GENERATION_ID,
    provider: world.provider,
    providerGeneration: generation,
    objectCodec,
    blobPort: noBlobs,
    assetCapturePort: {
      async captureCanonicalSource() {
        throw new Error('No asset is expected in this fixture');
      },
    },
    nowMs: () => world.clock.value,
    nowIso: () => new Date(world.clock.value).toISOString(),
  });
  const compactor = new SyncLogCompactor({
    db,
    syncGenerationId: SYNC_GENERATION_ID,
    provider: world.provider,
    providerGeneration: generation,
    objectCodec,
    pruneEnabled: true,
    pruneIntervalMs: 0,
    nowMs: () => world.clock.value,
  });
  return { id, db, gateway, identity, kernel, runtime, objectCodec, generation, publisher, compactor };
}

async function authorTitle(world: World, device: Device, title: string): Promise<void> {
  invalidateSqliteReducerStateCache();
  world.clock.value += 1_000;
  const clock = { nowMs: world.clock.value, nowIso: new Date(world.clock.value).toISOString() };
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'field.set',
    target: { family: 'entity', kind: 'node', id: NODE_ID, incarnation: 0 },
    payload: { field: 'title', value: title },
  });
  await device.db.transaction(async (tx) => {
    await tx.update(BookNodeTable).set({ title }).where(eq(BookNodeTable.id, NODE_ID));
    const recorded = await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock,
    }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, { changeSet: recorded.changeSet, clock });
  });
}

async function authorProse(world: World, device: Device, textValue: string): Promise<void> {
  invalidateSqliteReducerStateCache();
  world.clock.value += 1_000;
  const clock = { nowMs: world.clock.value, nowIso: new Date(world.clock.value).toISOString() };
  const source = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, textValue);
  paragraph.insert(0, [text]);
  source.getXmlFragment('default').insert(0, [paragraph]);
  const update = Y.encodeStateAsUpdate(source);
  source.destroy();
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'yjs.update',
    target: { family: 'yjs', kind: 'prose-document', id: PROSE_DOC_ID, incarnation: 0 },
    payload: { update },
  });
  await device.db.transaction(async (tx) => {
    await createYjsRepository(tx).appendUpdate(PROSE_DOC_ID, update, { kind: 'user' });
    const recorded = await recordAuthoredChangeSetInTransaction(tx, {
      projectId: PROJECT_ID,
      projectSyncId: PROJECT_SYNC_ID,
      syncGenerationId: SYNC_GENERATION_ID,
      identity: device.identity,
      clock,
    }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, { changeSet: recorded.changeSet, clock });
  });
}

async function proseText(device: Device): Promise<string> {
  const repository = createYjsRepository(device.db);
  const doc = new Y.Doc();
  const snapshot = await repository.getSnapshot(PROSE_DOC_ID);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob);
  for (const row of await repository.listUpdates(PROSE_DOC_ID)) Y.applyUpdate(doc, row.updateBlob);
  const text = doc.getXmlFragment('default').toString();
  doc.destroy();
  return text;
}

async function cycle(device: Device) {
  invalidateSqliteReducerStateCache();
  return device.runtime.runCycle(new Set(['manual']), new AbortController().signal);
}

async function publish(world: World, device: Device, snapshotId: string, kind: 'genesis' | 'checkpoint' = 'checkpoint') {
  world.clock.value += 1_000;
  return device.publisher.publishSnapshot({ snapshotId, snapshotKind: kind, signal: new AbortController().signal });
}

async function title(device: Device): Promise<string | undefined> {
  return (await device.db.select({ title: BookNodeTable.title }).from(BookNodeTable))[0]?.title;
}

async function bindingState(device: Device): Promise<string | undefined> {
  return (await device.db.select({ state: SyncProviderBindingTable.state }).from(SyncProviderBindingTable))[0]?.state;
}

async function installedBase(device: Device): Promise<string | undefined> {
  return (await device.db.select({ source: SyncReducerBaseTable.sourceCheckpointId }).from(SyncReducerBaseTable))[0]
    ?.source;
}

async function removedKinds(device: Device): Promise<string[]> {
  const rows = await device.db
    .select({ kind: SyncRemoteObjectTable.objectKind })
    .from(SyncRemoteObjectTable)
    .where(
      and(
        isNotNull(SyncRemoteObjectTable.removedAt),
        ne(SyncRemoteObjectTable.providerObjectId, 'connect-provider-marker'),
      ),
    );
  return rows.map((row) => row.kind).sort();
}

async function remoteKinds(world: World, generation: ProviderGeneration): Promise<string[]> {
  return (await world.provider.listInventory({ generation })).objects.map((object) => object.objectKind).sort();
}

/**
 * A writes three titles (one segment each) and checkpoints after the second
 * and third. Genesis came first, so three snapshots exist when A prunes.
 */
async function historyWithThreeSnapshots(world: World, a: Device): Promise<void> {
  await publish(world, a, 'genesis-1', 'genesis');
  await authorTitle(world, a, 'One');
  await cycle(a);
  await authorTitle(world, a, 'Two');
  await cycle(a);
  await publish(world, a, 'checkpoint-2');
  await authorTitle(world, a, 'Three');
  await cycle(a);
  await publish(world, a, 'checkpoint-3');
  await cycle(a);
}

afterEach(async () => {
  vi.restoreAllMocks();
  invalidateSqliteReducerStateCache();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('sync log compaction', () => {
  it('orders snapshots by frontier and prunes only history both retained snapshots cover', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    await historyWithThreeSnapshots(world, a);

    const catalog = await loadRemoteSnapshotCatalog({
      db: a.db,
      syncGenerationId: SYNC_GENERATION_ID,
      objectCodec: a.objectCodec,
    });
    expect(catalog.incomplete).toBe(false);
    expect(catalog.entries.map((entry) => entry.snapshotId)).toEqual(['checkpoint-3', 'checkpoint-2', 'genesis-1']);

    const outcome = await a.compactor.pruneIfDue(new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'pruned', deferred: [] });
    // Genesis (marker + package) and the two segments checkpoint-2 covers.
    expect(outcome.status === 'pruned' && outcome.removed).toHaveLength(4);
    expect(await remoteKinds(world, a.generation)).toEqual([
      'checkpoint', 'checkpoint', 'segment', 'snapshot-commit', 'snapshot-commit',
    ]);

    await expect(cycle(a)).resolves.toMatchObject({ converged: true });
    expect(await bindingState(a)).toBe('ready');
    expect(await removedKinds(a)).toEqual(['genesis', 'segment', 'segment', 'snapshot-commit']);
    // A's local copies of the pruned segments go; its newest segment stays to
    // chain the next one.
    expect((await a.db.select().from(SyncSegmentTable)).map((row) => row.lastSeq)).toEqual([3]);
    await authorTitle(world, a, 'Four');
    await expect(cycle(a)).resolves.toMatchObject({ converged: true, publishedSegments: 1 });
    expect((await a.db.select().from(SyncSegmentTable)).map((row) => row.lastSeq).sort()).toEqual([3, 4]);
  });

  it('keeps an up-to-date replica converging after its applied history is pruned', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    await historyWithThreeSnapshots(world, a);
    await cycle(b);
    expect(await title(b)).toBe('Three');

    await expect(a.compactor.pruneIfDue(new AbortController().signal)).resolves.toMatchObject({ status: 'pruned' });
    await expect(cycle(b)).resolves.toMatchObject({ converged: true });
    expect(await bindingState(b)).toBe('ready');

    await authorTitle(world, a, 'Four');
    await cycle(a);
    await expect(cycle(b)).resolves.toMatchObject({ converged: true });
    expect(await title(b)).toBe('Four');
    await expect(b.compactor.allowsCheckpoint()).resolves.toBe(true);
  });

  it('defers segments inside the grace window and never removes the retained snapshots', async () => {
    const world = createWorld(30 * DAY_MS);
    const a = await createDevice(world, 'a');
    await historyWithThreeSnapshots(world, a);

    const early = await a.compactor.pruneIfDue(new AbortController().signal);
    expect(early).toMatchObject({ status: 'pruned' });
    expect(early.status === 'pruned' && early.removed).toHaveLength(2);
    expect(early.status === 'pruned' && early.deferred).toHaveLength(2);

    world.clock.value += 31 * DAY_MS;
    await cycle(a);
    const late = await a.compactor.pruneIfDue(new AbortController().signal);
    expect(late.status === 'pruned' && late.removed).toHaveLength(2);
    expect(await remoteKinds(world, a.generation)).toEqual([
      'checkpoint', 'checkpoint', 'segment', 'snapshot-commit', 'snapshot-commit',
    ]);
  });

  it('fast-forwards a replica that connects after truncation onto the newest snapshot', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    await historyWithThreeSnapshots(world, a);
    await a.compactor.pruneIfDue(new AbortController().signal);
    await authorTitle(world, a, 'Four');
    await cycle(a);

    // B's history starts after the pruned segments: no segment chain can
    // ever reach checkpoint-3's frontier, so B installs it as its base.
    const b = await createDevice(world, 'b');
    await expect(cycle(b)).resolves.toMatchObject({ converged: true });
    expect(await installedBase(b)).toBe('checkpoint-3');
    expect(await bindingState(b)).toBe('ready');
    expect(await title(b)).toBe('Four');
    expect(await b.db.select().from(SyncFrontierGapTable).where(eq(SyncFrontierGapTable.state, 'open'))).toEqual([]);
    await expect(b.compactor.allowsCheckpoint()).resolves.toBe(true);
  });

  it('rebases a lagging replica with unsent edits onto the snapshot without losing them', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    await b.db.insert(AgentWorkingMemoryTable).values({
      projectId: PROJECT_ID,
      contentMd: 'device-local notes',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await historyWithThreeSnapshots(world, a);
    await a.compactor.pruneIfDue(new AbortController().signal);
    // B edits offline after A's history, so its title wins by HLC order.
    await authorTitle(world, b, 'Offline edit on B');

    await expect(cycle(b)).resolves.toMatchObject({ converged: true, publishedSegments: 1 });
    expect(await installedBase(b)).toBe('checkpoint-3');
    expect(await title(b)).toBe('Offline edit on B');
    expect(await bindingState(b)).toBe('ready');
    expect(await b.db.select({ content: AgentWorkingMemoryTable.contentMd }).from(AgentWorkingMemoryTable))
      .toEqual([{ content: 'device-local notes' }]);

    await expect(cycle(a)).resolves.toMatchObject({ converged: true });
    expect(await title(a)).toBe('Offline edit on B');
    // A later edit on B still orders after everything the snapshot absorbed.
    await authorTitle(world, a, 'Five');
    await cycle(a);
    await cycle(b);
    expect(await title(b)).toBe('Five');
  });

  it('merges pruned prose into the lagging replica and its cached projection', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    await publish(world, a, 'genesis-1', 'genesis');
    await authorProse(world, a, 'Pruned paragraph');
    await cycle(a);
    await authorTitle(world, a, 'Two');
    await cycle(a);
    await publish(world, a, 'checkpoint-2');
    await authorTitle(world, a, 'Three');
    await cycle(a);
    await publish(world, a, 'checkpoint-3');
    await cycle(a);
    await expect(a.compactor.pruneIfDue(new AbortController().signal)).resolves.toMatchObject({ status: 'pruned' });

    await expect(cycle(b)).resolves.toMatchObject({ converged: true });
    expect(await installedBase(b)).toBe('checkpoint-3');
    expect(await proseText(b)).toContain('Pruned paragraph');
    expect(await proseText(b)).toBe(await proseText(a));
    const [projection] = await b.db.select({ json: NodeContentTable.contentJson }).from(NodeContentTable);
    expect(projection?.json).toContain('Pruned paragraph');
  });

  it('stops a lagging replica from publishing a checkpoint below the newest snapshot', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    await historyWithThreeSnapshots(world, a);
    await a.compactor.pruneIfDue(new AbortController().signal);
    const b = await createDevice(world, 'b');
    // Before its first pull, B knows no snapshot and is not lagging.
    await expect(b.compactor.allowsCheckpoint()).resolves.toBe(true);
    // Seeing snapshots it cannot reach yet, B must not checkpoint.
    vi.spyOn(b.runtime as unknown as { apply(signal: AbortSignal): Promise<void> }, 'apply')
      .mockResolvedValue(undefined);
    await cycle(b);
    await expect(b.compactor.allowsCheckpoint()).resolves.toBe(false);
    await expect(b.compactor.pruneIfDue(new AbortController().signal)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'behind-newest-snapshot',
    });
  });

  it('retries a download that 404s instead of assuming the object was pruned', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    await authorTitle(world, a, 'One');
    await cycle(a);
    vi.spyOn(world.provider, 'downloadImmutable')
      .mockRejectedValueOnce(new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'transient'))
      .mockRejectedValueOnce(new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'transient'));

    await expect(cycle(b)).resolves.toMatchObject({ converged: false });
    expect(await removedKinds(b)).toEqual([]);
    expect(await bindingState(b)).toBe('ready');
    await expect(cycle(b)).resolves.toMatchObject({ converged: true });
    expect(await title(b)).toBe('One');
  });

  it('settles a download that the provider pruned before its bytes arrived', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    await authorTitle(world, a, 'One');
    await cycle(a);
    const [segment] = await a.db.select().from(SyncSegmentTable);
    const [local] = await a.db.select().from(SyncLocalObjectTable).where(eq(SyncLocalObjectTable.id, segment!.localObjectId));
    const download = world.provider.downloadImmutable.bind(world.provider);
    vi.spyOn(world.provider, 'downloadImmutable').mockImplementation(async (input) => {
      world.provider.removeRemoteObject(a.generation, local!.logicalKeyId);
      return download(input);
    });

    // The cycle's repull sees the removal and cancels the dead download.
    await expect(cycle(b)).resolves.toMatchObject({ converged: true });
    expect(await removedKinds(b)).toEqual(['segment']);
    expect(await bindingState(b)).toBe('ready');
    const transfers = await b.db.select({ state: SyncTransferTable.state }).from(SyncTransferTable);
    expect(transfers.map((transfer) => transfer.state)).toContain('cancelled');
  });

  it('keeps uploading local edits when a snapshot cannot be installed', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const failing: SyncDomainMaterializationKernel = {
      ...titleKernel,
      async validate() {
        throw new Error('this replica cannot validate the snapshot');
      },
    };
    const b = await createDevice(world, 'b', { kernel: failing });
    await historyWithThreeSnapshots(world, a);
    await a.compactor.pruneIfDue(new AbortController().signal);
    await authorTitle(world, b, 'Offline edit on B');

    await expect(cycle(b)).resolves.toMatchObject({ publishedSegments: 1, converged: false });
    expect(await installedBase(b)).toBeUndefined();
    expect(await bindingState(b)).toBe('ready');
    await cycle(a);
    expect(await title(a)).toBe('Offline edit on B');
  });

  it('does not merge prose into an owner this replica purged', async () => {
    const world = createWorld(0);
    const b = await createDevice(world, 'b');
    await b.db.delete(NodeContentTable);
    await b.db.delete(BookNodeTable);
    const source = new Y.Doc();
    source.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    const merged = await b.db.transaction((tx) =>
      mergeCheckpointProseInTransaction(tx, {
        projectId: PROJECT_ID,
        documentId: PROSE_DOC_ID,
        state: Y.encodeStateAsUpdate(source),
        nowIso: NOW,
      }),
    );
    expect(merged).toBe(false);
    expect(await createYjsRepository(b.db).listUpdates(PROSE_DOC_ID)).toEqual([]);
    expect(await b.db.select().from(NodeContentTable)).toEqual([]);
  });

  it('still treats a lost blob as corruption on a pruning provider', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    const bytes = new TextEncoder().encode('blob bytes');
    const storedSha256 = await sha256Bytes(bytes);
    const uploaded: RemoteObject = (
      await world.provider.uploadImmutable({
        generation: a.generation,
        sourceRef: world.objects.put('blob.source', bytes),
        objectKind: 'blob',
        logicalKeyId: 'blob-logical',
        storedSha256,
        sizeBytes: bytes.byteLength,
        transferId: 'blob-upload',
        signal: new AbortController().signal,
      })
    ).object;
    await cycle(b);
    world.provider.removeRemoteObject(a.generation, uploaded.logicalKeyId);

    await expect(cycle(b)).rejects.toThrow(/blocked-corrupt/u);
    expect(await bindingState(b)).toBe('blocked-corrupt');
  });

  it('lets restore discovery drop history pruned while it was listing', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    await historyWithThreeSnapshots(world, a);
    const listChanges = world.provider.listChanges.bind(world.provider);
    let pruned = false;
    vi.spyOn(world.provider, 'listChanges').mockImplementation(async (input) => {
      if (!pruned) {
        pruned = true;
        await a.compactor.pruneIfDue(new AbortController().signal);
      }
      return listChanges(input);
    });

    const discovery = await discoverCurrentSyncGenerationObjects({
      provider: world.provider,
      generation: a.generation,
      signal: new AbortController().signal,
    });
    expect(discovery.objects.map((object) => object.objectKind).sort()).toEqual([
      'checkpoint', 'checkpoint', 'segment', 'snapshot-commit', 'snapshot-commit',
    ]);
  });
});

/** The title kernel plus remote prose, appended the way the production kernel does. */
const proseKernel: SyncDomainMaterializationKernel = {
  externallyMaterializedActions: new Set(['yjs.update']),
  validate: titleKernel.validate,
  async materialize(context) {
    await titleKernel.materialize(context);
    for (const effect of context.effects) {
      if (effect.type !== 'yjs.update' || !effect.materialize) continue;
      if (effect.source.changeSetId !== context.changeSet.changeSetId) continue;
      const { update } = effect.payload as { update: Uint8Array };
      await createYjsRepository(context.tx).appendUpdate(effect.target.id, update, { kind: 'remote' });
    }
  },
};

const REDUCER_IDENTITY = {
  projectId: PROJECT_ID,
  projectSyncId: PROJECT_SYNC_ID,
  syncGenerationId: SYNC_GENERATION_ID,
};

/** An authored prose edit with the Yjs materialization receipt production writes. */
async function authorMaterializedProse(world: World, device: Device, textValue: string): Promise<void> {
  invalidateSqliteReducerStateCache();
  world.clock.value += 1_000;
  const clock = { nowMs: world.clock.value, nowIso: new Date(world.clock.value).toISOString() };
  const source = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, textValue);
  paragraph.insert(0, [text]);
  source.getXmlFragment('default').insert(0, [paragraph]);
  const update = Y.encodeStateAsUpdate(source);
  source.destroy();
  const changes = new SyncChangeBuilder();
  const mutationIndex = appendYjsUpdateMutation(changes, PROSE_DOC_ID, update);
  await device.db.transaction(async (tx) => {
    const appended = await createYjsRepository(tx).appendMaterializedUpdate(
      PROSE_DOC_ID,
      update,
      { kind: 'authored', builder: changes, mutationIndex },
      { kind: 'user' },
    );
    registerAuthoredYjsMaterialization(tx, changes, mutationIndex, appended.token);
    const recorded = await recordAuthoredChangeSetInTransaction(tx, { ...REDUCER_IDENTITY, identity: device.identity, clock }, changes);
    await observeLocalAuthoredReducerInTransaction(tx, { changeSet: recorded.changeSet, clock });
  });
}

/** Canonical reducer state rebuilt from SQLite, and where the rebuild started. */
async function rebuiltState(device: Device) {
  invalidateSqliteReducerStateCache();
  const profile = sqliteReplayReducerProfile(DEFAULT_SQLITE_REDUCER_PROFILE, titleKernel);
  const loaded = await device.db.transaction((tx) =>
    loadSqliteReducerStateInTransaction(tx, REDUCER_IDENTITY, profile, ''),
  );
  return {
    snapshot: canonicalReducerSnapshot(compactReducerReceipts(loaded.state)),
    source: getSqliteReducerLoadDiagnostics()?.source,
  };
}

async function journalIds(device: Device): Promise<string[]> {
  return (
    await device.db
      .select({ id: SyncChangeSetTable.changeSetId })
      .from(SyncChangeSetTable)
      .orderBy(asc(SyncChangeSetTable.changeSetId))
  ).map((row) => row.id);
}

async function journalCounts(device: Device) {
  const [[changeSets], [mutations], [receipts]] = await Promise.all([
    device.db.select({ value: count() }).from(SyncChangeSetTable),
    device.db.select({ value: count() }).from(SyncMutationTable),
    device.db.select({ value: count() }).from(SyncApplyReceiptTable),
  ]);
  return { changeSets: changeSets?.value, mutations: mutations?.value, receipts: receipts?.value };
}

async function storedChangeSet(device: Device, changeSetId: string): Promise<SyncChangeSetV1> {
  const [row] = await device.db
    .select({ bytes: SyncChangeSetTable.encodedBytes })
    .from(SyncChangeSetTable)
    .where(eq(SyncChangeSetTable.changeSetId, changeSetId));
  const decoded = await decodeSyncChangeSetV1(row!.bytes as Uint8Array);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}

async function truncationFloors(device: Device): Promise<[string, number][]> {
  return (await device.db.select().from(SyncJournalTruncationTable))
    .map((row): [string, number] => [row.writerId, row.truncatedThroughSeq])
    .sort();
}

function foreignKeyViolations(device: Device): unknown[] {
  return device.gateway.database.prepare('PRAGMA foreign_key_check').all();
}

/** Closes the device's database file and opens it again, like an app restart. */
async function restart(world: World, device: Device): Promise<Device> {
  await device.gateway.close();
  gateways.splice(gateways.indexOf(device.gateway), 1);
  invalidateSqliteReducerStateCache();
  const gateway = new ProductFileBackedSqliteGateway(device.gateway.databasePath);
  gateways.push(gateway);
  return createDevice(world, device.id, { opened: { db: gateway.client(), gateway }, kernel: device.kernel });
}

describe('local journal truncation', () => {
  it('truncates history a published checkpoint covers and stays correct across restart, apply and capture', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a', { kernel: proseKernel });
    const b = await createDevice(world, 'b', { kernel: proseKernel });
    await publish(world, a, 'genesis-1', 'genesis');
    await authorTitle(world, b, 'One');
    await cycle(b);
    await cycle(a);
    await authorMaterializedProse(world, a, 'Kept paragraph');
    await authorTitle(world, a, 'Two');
    await cycle(a);
    await publish(world, a, 'checkpoint-2');
    const expected = await rebuiltState(a);
    const redelivered = await storedChangeSet(a, 'writer-b:epoch-b:1');
    const materialized = await a.db.select().from(SyncYjsMaterializationReceiptTable);
    expect(materialized).toHaveLength(1);
    const position = await appliedJournalPosition(a.db, SYNC_GENERATION_ID);

    await expect(cycle(a)).resolves.toMatchObject({ converged: true });
    expect(a.runtime.journalTruncation).toEqual({
      status: 'truncated',
      sourceCheckpointId: 'checkpoint-2',
      installedBase: true,
      deletedChangeSets: 2,
      retainedChangeSets: 1,
    });
    expect(await installedBase(a)).toBe('checkpoint-2');
    // B's overwritten title and A's prose update leave; the winning title,
    // which reducer metadata names, stays.
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:2']);
    expect(await journalCounts(a)).toEqual({ changeSets: 1, mutations: 1, receipts: 1 });
    expect(await truncationFloors(a)).toEqual([['writer-a', 2], ['writer-b', 1]]);
    // The Yjs receipt outlives its mutation as a watermark.
    expect(await a.db.select().from(SyncYjsMaterializationReceiptTable)).toEqual(materialized);
    expect(foreignKeyViolations(a)).toEqual([]);
    expect(await appliedJournalPosition(a.db, SYNC_GENERATION_ID)).toBe(position);
    const truncated = await rebuiltState(a);
    expect(truncated.source).toBe('base');
    expect(truncated.snapshot).toEqual(expected.snapshot);

    // Redelivery of a deleted change-set is a duplicate, not a second apply.
    const duplicate = await a.db.transaction((tx) =>
      applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet: redelivered,
        identity: a.identity,
        clock: { nowMs: world.clock.value, nowIso: new Date(world.clock.value).toISOString() },
        kernel: proseKernel,
      }),
    );
    expect(duplicate.status).toBe('duplicate');
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:2']);
    expect(await title(a)).toBe('Two');

    const restarted = await restart(world, a);
    const reopened = await rebuiltState(restarted);
    expect(reopened.source).toBe('base');
    expect(reopened.snapshot).toEqual(expected.snapshot);
    expect(await proseText(restarted)).toContain('Kept paragraph');

    // Remote changes keep applying on top of the truncated journal.
    await cycle(b);
    await authorTitle(world, b, 'Three');
    await cycle(b);
    await expect(cycle(restarted)).resolves.toMatchObject({ converged: true });
    expect(await title(restarted)).toBe('Three');
    expect((await rebuiltState(restarted)).snapshot).toEqual((await rebuiltState(b)).snapshot);

    // A checkpoint captured from the truncated journal restores a new device.
    await publish(world, restarted, 'checkpoint-3');
    await cycle(restarted);
    expect(await installedBase(restarted)).toBe('checkpoint-3');
    await expect(restarted.compactor.pruneIfDue(new AbortController().signal)).resolves.toMatchObject({
      status: 'pruned',
    });
    const c = await createDevice(world, 'c', { kernel: proseKernel });
    await expect(cycle(c)).resolves.toMatchObject({ converged: true });
    expect(await installedBase(c)).toBe('checkpoint-3');
    expect(await title(c)).toBe('Three');
    expect(await proseText(c)).toBe(await proseText(restarted));
    expect((await rebuiltState(c)).snapshot).toEqual((await rebuiltState(restarted)).snapshot);
  });

  it('fast-forwards a truncated replica with unsent edits onto a newer snapshot', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a', { kernel: proseKernel });
    const b = await createDevice(world, 'b', { kernel: proseKernel });
    await publish(world, a, 'genesis-1', 'genesis');
    await authorTitle(world, a, 'One');
    await authorTitle(world, a, 'Two');
    await cycle(a);
    await publish(world, a, 'checkpoint-1');
    await cycle(a);
    await cycle(b);
    expect(await installedBase(b)).toBe('checkpoint-1');
    expect(await journalIds(b)).toEqual(['writer-a:epoch-a:2']);

    // B writes offline while A moves on and prunes history B never received.
    await authorMaterializedProse(world, b, 'Offline paragraph on B');
    await authorTitle(world, a, 'Three');
    await cycle(a);
    await publish(world, a, 'checkpoint-2');
    await authorTitle(world, a, 'Four');
    await cycle(a);
    await publish(world, a, 'checkpoint-3');
    await cycle(a);
    await expect(a.compactor.pruneIfDue(new AbortController().signal)).resolves.toMatchObject({ status: 'pruned' });

    await expect(cycle(b)).resolves.toMatchObject({ converged: true, publishedSegments: 1 });
    expect(await installedBase(b)).toBe('checkpoint-3');
    expect(await bindingState(b)).toBe('ready');
    expect(await title(b)).toBe('Four');
    expect(await truncationFloors(b)).toEqual([['writer-a', 4]]);
    expect(foreignKeyViolations(b)).toEqual([]);
    await cycle(a);
    expect(await proseText(a)).toContain('Offline paragraph on B');
    expect(await proseText(b)).toBe(await proseText(a));
    expect((await rebuiltState(b)).snapshot).toEqual((await rebuiltState(a)).snapshot);
  });

  it('keeps rows without a covering snapshot, while blocked, above the floor and until published', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a', { kernel: proseKernel });
    const truncate = () =>
      truncateCoveredJournal({
        db: a.db,
        syncGenerationId: SYNC_GENERATION_ID,
        objectCodec: a.objectCodec,
        kernel: proseKernel,
        nowIso: () => new Date(world.clock.value).toISOString(),
        // One change-set per transaction exercises the batch loop.
        batchSize: 1,
      });
    const run = (sql: string, ...values: string[]) => () => a.gateway.database.prepare(sql).run(...values);
    await authorTitle(world, a, 'One');
    await authorTitle(world, a, 'Two');
    await cycle(a);
    await expect(truncate()).resolves.toEqual({ status: 'skipped', reason: 'no-covering-snapshot' });
    expect(run(`DELETE FROM sync_apply_receipt WHERE change_set_id = 'writer-a:epoch-a:1'`)).toThrow(/cannot be deleted/);

    await publish(world, a, 'checkpoint-1');
    run(
      `INSERT INTO sync_conflict (conflict_id, sync_generation_id, kind, details_cbor, state, created_at)
       VALUES ('open-conflict', ?, 'semantic', X'a0', 'open', ?)`,
      SYNC_GENERATION_ID,
      NOW,
    )();
    await expect(truncate()).resolves.toEqual({ status: 'skipped', reason: 'blocked' });
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:1', 'writer-a:epoch-a:2']);
    run(`UPDATE sync_conflict SET state = 'resolved', resolved_at = ? WHERE conflict_id = 'open-conflict'`, NOW)();

    // An edit not yet sealed lies above the floor. It supersedes the base's
    // title, so the base's own register source may leave too.
    await authorTitle(world, a, 'Three');
    await expect(truncate()).resolves.toMatchObject({ status: 'truncated', deletedChangeSets: 2 });
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:3']);
    expect((await rebuiltState(a)).source).toBe('base');
    expect(await title(a)).toBe('Three');
    await expect(truncate()).resolves.toEqual({ status: 'skipped', reason: 'nothing-covered' });

    // Above the floor the journal stays append-only, an own change-set stays
    // until its segment is published, and the floor never moves back.
    expect(run(`DELETE FROM sync_apply_receipt WHERE change_set_id = 'writer-a:epoch-a:3'`)).toThrow(/cannot be deleted/);
    run(`UPDATE sync_journal_truncation SET truncated_through_seq = 3`)();
    expect(run(`DELETE FROM sync_apply_receipt WHERE change_set_id = 'writer-a:epoch-a:3'`)).toThrow(/cannot be deleted/);
    expect(run(`UPDATE sync_journal_truncation SET truncated_through_seq = 1`)).toThrow(/backwards/);
    expect(run(`DELETE FROM sync_journal_truncation`)).toThrow(/cannot be deleted/);
  });

  it('refuses a base that would not reproduce the current state and changes nothing', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a', { kernel: proseKernel });
    const b = await createDevice(world, 'b', { kernel: proseKernel });
    await authorTitle(world, a, 'Only on A');
    await authorTitle(world, b, 'Only on B');
    await cycle(b);
    // B's compacted state covers a change-set A never applied.
    const { pages } = await b.db.transaction((tx) => captureCompactedReducerStateV2(tx, REDUCER_IDENTITY));
    const before = await rebuiltState(a);

    await expect(
      a.db.transaction((tx) =>
        rebaseSqliteReducerOntoAppliedCheckpointInTransaction(tx, {
          identity: REDUCER_IDENTITY,
          baseProfile: decodeReducerStatePagesV2(pages).header.profile,
          pages,
          sourceCheckpointId: 'foreign-checkpoint',
          kernel: proseKernel,
          nowIso: new Date(world.clock.value).toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(SqliteReducerRebaseMismatchError);
    expect(await installedBase(a)).toBeUndefined();
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:1']);
    const after = await rebuiltState(a);
    expect(after.source).toBe('journal');
    expect(after.snapshot).toEqual(before.snapshot);
  });

  it('keeps the checkpoint due position monotonic after truncation', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a', { kernel: proseKernel });
    let next = 1;
    const hook = createProviderCheckpointHook({
      db: a.db,
      syncGenerationId: SYNC_GENERATION_ID,
      publisher: a.publisher,
      createSnapshotId: () => `due-${next++}`,
      nowMs: () => world.clock.value,
      changeSetThreshold: 2,
      segmentByteThreshold: Number.MAX_SAFE_INTEGER,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      prunesHistory: true,
    });
    const due = () => hook.captureIfDue({ syncGenerationId: SYNC_GENERATION_ID, signal: new AbortController().signal });
    for (const value of ['One', 'Two', 'Three']) await authorTitle(world, a, value);
    await cycle(a);
    await expect(due()).resolves.toBe(true);
    await cycle(a);
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:3']);
    expect(await appliedJournalPosition(a.db, SYNC_GENERATION_ID)).toBe(3);

    await authorTitle(world, a, 'Four');
    await cycle(a);
    await expect(due()).resolves.toBe(false);
    await authorTitle(world, a, 'Five');
    await cycle(a);
    // Two journal rows remain, fewer than the three the checkpoint recorded;
    // a row count would never call this checkpoint due.
    expect(await journalIds(a)).toEqual(['writer-a:epoch-a:4', 'writer-a:epoch-a:5']);
    await expect(due()).resolves.toBe(true);
  });
});
