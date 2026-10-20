import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  AgentWorkingMemoryTable,
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
  SyncFrontierGapTable,
  SyncGenerationTable,
  SyncProviderBindingTable,
  SyncReducerBaseTable,
  SyncRemoteObjectTable,
  SyncSegmentTable,
} from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { ProviderSnapshotPublisher } from '../checkpoint/provider-publisher';
import type { SyncEngineBlobPort } from '../engine/blob-port';
import { SqliteSyncGenerationRuntime, type SyncEngineRuntimeClock } from '../engine/durable-runtime';
import { PlaintextSyncEngineObjectCodec } from '../engine/plaintext-object-codec';
import {
  recordAuthoredChangeSetInTransaction,
  SyncChangeBuilder,
  type SyncWriterIdentitySource,
} from '../journal';
import {
  sha256Bytes,
  type ProviderBinding,
  type ProviderGeneration,
  type RemoteObject,
} from '../protocol';
import { MemoryObjectLogProvider, MemoryProviderLocalObjectStore } from '../providers';
import { ObjectLogProviderError } from '../providers/provider-error';
import {
  invalidateSqliteReducerStateCache,
  observeLocalAuthoredReducerInTransaction,
  type SyncDomainMaterializationKernel,
} from '../reducer';
import { discoverCurrentSyncGenerationObjects } from '../restore/cloud-restore';
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

async function createDevice(world: World, id: string): Promise<Device> {
  const { db, gateway } = await createDatabase(id);
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
  let nextRef = 1;
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
    domainKernel: titleKernel,
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
  return { id, db, gateway, identity, runtime, objectCodec, generation, publisher, compactor };
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

  it('records a listed object pruned before its download as a removal', async () => {
    const world = createWorld(0);
    const a = await createDevice(world, 'a');
    const b = await createDevice(world, 'b');
    await authorTitle(world, a, 'One');
    await cycle(a);
    const download = vi.spyOn(world.provider, 'downloadImmutable');
    download.mockRejectedValueOnce(new ObjectLogProviderError('REMOTE_OBJECT_MISSING', 'pruned'));

    await expect(cycle(b)).resolves.toBeDefined();
    expect(await bindingState(b)).toBe('ready');
    expect(await removedKinds(b)).toEqual(['segment']);
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
