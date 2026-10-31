import { deleteProjectWithRemoteConfirmation } from './project-deletion';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  ProjectTable,
  ProjectAssetTable,
  BookNodeTable,
  NodeContentTable,
  SyncGenerationTable,
  SyncRemoteObjectTable,
  SyncChangeSetTable,
} from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { ProviderSnapshotPublisher } from '../checkpoint';
import { SqliteSyncGenerationRuntime, syncRemoteObjectId } from '../engine/durable-runtime';
import { PlaintextSyncEngineObjectCodec } from '../engine/plaintext-object-codec';
import { SyncChangeBuilder, recordAuthoredChangeSetInTransaction } from '../journal';
import {
  invalidateSqliteReducerStateCache,
  observeLocalAuthoredReducerInTransaction,
  productionSyncDomainMaterializationKernel,
} from '../reducer';
import { createLocalObjectRef, sha256Bytes, type ProviderGeneration } from '../protocol';
import { MemoryProviderLocalObjectStore } from '../providers/local-object-store';
import { HostedObjectLogProvider, type HostedObjectTransport } from '../providers/hosted/provider';
import {
  restoreCloudSyncGenerations,
  restoreDiscoveredCloudProjects,
  type CloudRestoreDependencies,
  type RestoreObjectAccess,
} from '../restore/cloud-restore';
import { resumeHostedAuthentication } from './session-recovery';
import { PendingSyncGenerationProvisioner } from '../provision/sync-generation-provisioner';
import { SyncGenerationProvisionRepository } from '../provision/repository';

const origin = process.env.HOSTED_TEST_ORIGIN;
const signal = new AbortController().signal;
const now = () => new Date().toISOString();
const temp: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const dir of temp.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Public HTTP contract only; these synthetic accounts are created in local Mailpit. */
async function createAccount() {
  if (!origin || !['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw new Error('Requires a local disposable Hosted service');
  const email = `client-${randomUUID()}@example.test`;
  const password = randomUUID();
  async function post(endpoint: string, body: unknown) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${origin}/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin! },
        body: JSON.stringify(body),
      });
      if (response.status === 429 && attempt < 2) {
        // Repeated local runs share the genuine OTP rate limit. Honor it instead
        // of disabling service protections or depending on a fresh container.
        const retry = Number(response.headers.get('retry-after') ?? 60);
        const seconds = Number.isFinite(retry) ? Math.max(1, Math.min(60, retry)) : 60;
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
        continue;
      }
      expect(response.status, endpoint).toBe(200);
      return response;
    }
  }
  await post('sign-up/email', { email, password, name: 'Synthetic client acceptance' });
  await post('email-otp/send-verification-otp', { email, type: 'email-verification' });
  const mail = process.env.HOSTED_TEST_MAIL_ORIGIN ?? 'http://localhost:8025';
  const listing = (await (await fetch(`${mail}/api/v1/messages`)).json()) as {
    messages: { ID: string; To: { Address: string }[] }[];
  };
  const message = listing.messages.find((m) => m.To.some((to) => to.Address === email));
  expect(message).toBeDefined();
  const body = (await (await fetch(`${mail}/api/v1/message/${message!.ID}`)).json()) as {
    Text: string;
  };
  const otp = body.Text.match(/\b\d{6}\b/)?.[0];
  expect(otp).toBeDefined();
  await post('email-otp/verify-email', { email, otp });
  const response = await post('sign-in/email', { email, password });
  const token = response.headers.get('set-auth-token')!;
  expect(token).toBeTruthy();
  const session = (await response.json()) as { user: { id: string } };
  return { token, accountSubject: session.user.id, credentialSecretRef: 'hosted.session' };
}

async function device(
  label: string,
  account: Awaited<ReturnType<typeof createAccount>>,
  prepareLibrary?: (file: string) => void,
) {
  const directory = await mkdtemp(path.join(tmpdir(), `drifting-hosted-${label}-`));
  temp.push(directory);
  prepareLibrary?.(path.join(directory, 'library.db'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'library.db'));
  gateways.push(gateway);
  const db = gateway.client();
  const assets = new Map<string, Uint8Array>();
  const preparedAssets = new Map<string, { id: string; bytes: Uint8Array }>();
  const objects = new MemoryProviderLocalObjectStore();
  let counter = 0;
  const codec = new PlaintextSyncEngineObjectCodec({
    allocate: () => objects.ref(`${label}.${++counter}`),
    read: (ref, s) => objects.read(ref, s),
    write: (ref, bytes, s) => objects.write(ref, bytes, s),
  });
  const network = { online: true, loseUploadResponse: false, loseDeleteResponse: false, token: account.token };
  const transport: HostedObjectTransport = {
    accountSubject: () => account.accountSubject,
    async request(input) {
      if (!network.online) throw new Error('Injected offline');
      const headers: Record<string, string> = { Authorization: `Bearer ${network.token}` };
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (input.sourceRef) {
        body = new Uint8Array(
          await objects.read(createLocalObjectRef(input.sourceRef), input.signal ?? signal),
        );
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-Object-Kind'] = input.objectKind!;
        headers['X-Content-Sha256'] = input.storedSha256!;
      }
      const response = await fetch(`${origin}${input.path}`, {
        method: input.method,
        headers,
        body,
        signal: input.signal,
      });
      if (response.status === 410) {
        const receipt = await response.json() as { code: string; syncGenerationId: string; namespace: string; deletedAt: string };
        const parts = input.path.split('?')[0].split('/');
        expect(receipt.code).toBe('GENERATION_DELETED');
        expect(receipt.namespace).toBe(parts[4]);
        expect(receipt.syncGenerationId).toBe(decodeURIComponent(parts[6]));
        expect(Number.isFinite(Date.parse(receipt.deletedAt))).toBe(true);
        throw Object.assign(new Error(receipt.code), { code: receipt.code, syncGenerationId: receipt.syncGenerationId, retryable: false });
      }
      if (!response.ok)
        throw Object.assign(new Error(`Hosted ${response.status}`), {
          // Same status mapping as the native transport (src-tauri/src/hosted_sync.rs).
          code: response.status === 410 ? 'GENERATION_DELETED' : response.status === 401 ? 'needs-reauth'
            : response.status === 404 ? 'REMOTE_OBJECT_MISSING' : 'provider-unavailable',
          retryable: response.status !== 401 && response.status !== 404,
        });
      if (input.sourceRef && network.loseUploadResponse) {
        network.loseUploadResponse = false;
        throw new Error('Injected lost acknowledgement after server commit');
      }
      if (input.method === 'DELETE' && network.loseDeleteResponse) {
        network.loseDeleteResponse = false;
        throw new Error('Injected lost deletion acknowledgement');
      }
      if (input.destinationRef) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const storedSha256 = await sha256Bytes(bytes);
        expect(storedSha256).toBe(input.storedSha256);
        await objects.write(
          createLocalObjectRef(input.destinationRef),
          bytes,
          input.signal ?? signal,
        );
        return { destinationRef: input.destinationRef, storedSha256, sizeBytes: bytes.byteLength };
      }
      return response.json();
    },
  };
  const provider = new HostedObjectLogProvider(transport);
  const identity = {
    installationId: `installation-${label}`,
    createWriterIdentity: () => ({ writerId: `writer-${label}`, writerEpoch: `epoch-${label}` }),
  };
  const objectAccess: RestoreObjectAccess = {
    async decodeProtocol(input) {
      const ref = await codec.allocateInbound({
        syncGenerationId: input.generation.syncGenerationId,
        remoteObject: input.remoteObject,
      });
      await provider.downloadImmutable({
        generation: input.generation,
        objectId: input.remoteObject.objectId,
        destinationRef: ref,
        expectedStoredSha256: input.remoteObject.storedSha256,
        transferId: input.transferId,
        signal: input.signal,
      });
      const decoded = await codec.decodeInbound({
        syncGenerationId: input.generation.syncGenerationId,
        expectedLogicalKeyId: input.remoteObject.logicalKeyId,
        remoteObject: input.remoteObject,
        sourceRef: ref,
      });
      return { bytes: decoded.protocolBytes, sourceRef: ref, contentSha256: decoded.contentSha256 };
    },
    deriveBlobLogicalKey: ({ syncGenerationId, blobId }) =>
      sha256Bytes(new TextEncoder().encode(`blob/${syncGenerationId}/${blobId}`)),
    async decodeBlob(input) {
      const decoded = await this.decodeProtocol(input);
      return {
        sourceRef: decoded.sourceRef,
        contentSha256: decoded.contentSha256,
        sizeBytes: decoded.bytes.byteLength,
      };
    },
  };
  const publisher = (
    projectId: string,
    syncGenerationId: string,
    providerGeneration: ProviderGeneration,
  ) =>
    new ProviderSnapshotPublisher({
      db,
      projectId,
      syncGenerationId,
      provider,
      providerGeneration,
      objectCodec: codec,
      blobPort: {
        async prepareOutbound({ declaration, syncGenerationId }) {
          const bytes = assets.get(declaration.assetId);
          if (!bytes) throw new Error('Missing synthetic asset');
          const hash = await sha256Bytes(bytes);
          return {
            sourceRef: objects.put(`blob.${++counter}`, bytes),
            logicalKeyId: await objectAccess.deriveBlobLogicalKey({
              syncGenerationId,
              blobId: hash,
            }),
            storedSha256: hash,
            contentSha256: hash,
            sizeBytes: bytes.length,
          };
        },
        async verifyAndInstallInbound() {
          throw new Error('Incremental asset installation is tested by the native adapter suite');
        },
      },
      assetCapturePort: {
        async captureCanonicalSource({ assetId, expectedSourceSha256 }) {
          const bytes = assets.get(assetId);
          if (!bytes) throw new Error('Missing synthetic asset');
          const hash = await sha256Bytes(bytes);
          expect(hash).toBe(expectedSourceSha256);
          return {
            sourceRef: objects.put(`source.${++counter}`, bytes),
            blobId: hash,
            sourceSha256: hash,
            sizeBytes: bytes.length,
            mimeType: 'image/png',
          };
        },
      },
    });
  const dependencies: CloudRestoreDependencies = {
    provider,
    discovery: provider,
    objectAccess,
    claimAccount: async (credentialSecretRef, accountSubject) => ({
      credentialSecretRef,
      accountSubject,
    }),
    loadWriterIdentity: async () => identity,
    assetRestorePort: {
      async prepareVerifiedSource({ asset, sourceRef }) {
        const bytes = await objects.read(sourceRef, signal);
        const hash = await sha256Bytes(bytes);
        expect(hash).toBe(asset.sourceSha256);
        preparedAssets.set(sourceRef, { id: asset.assetId, bytes });
        return {
          assetId: asset.assetId,
          stagingRef: sourceRef,
          sourceSha256: hash,
          sizeBytes: bytes.length,
        };
      },
      async activatePreparedSources({ stagingRefs }) {
        for (const ref of stagingRefs) {
          const item = preparedAssets.get(ref)!;
          assets.set(item.id, item.bytes);
        }
        return 'synthetic-activation';
      },
      async abandonAttempt({ stagingRefs }) {
        for (const ref of stagingRefs) {
          const item = preparedAssets.get(ref);
          if (item) assets.delete(item.id);
          preparedAssets.delete(ref);
        }
      },
    },
    publishLocalSyncGeneration: ({ projectId, syncGenerationId, providerGeneration, attempt }) =>
      publisher(projectId, syncGenerationId, providerGeneration).publishSnapshot({
        snapshotId: `genesis-${attempt.attemptId}-${syncGenerationId}`,
        snapshotKind: 'genesis',
        signal,
      }),
  };
  const restoreInput = { db, account, signal, dependencies };
  async function cycle(syncGenerationId: string) {
    invalidateSqliteReducerStateCache();
    const active = (await createSyncAppAuthorityRepository(db).listActiveRuntimeBindings()).find(
      (item) => item.binding.syncGenerationId === syncGenerationId,
    );
    if (!active) throw new Error('Missing active generation');
    const runtime = new SqliteSyncGenerationRuntime({
      db,
      syncGenerationId,
      provider,
      providerBinding: active.binding,
      objectCodec: codec,
      writerIdentity: identity,
      domainKernel: productionSyncDomainMaterializationKernel,
    });
    await runtime.runCycle(new Set(['manual']), signal);
    return runtime.inspectPending();
  }
  return {
    db,
    gateway,
    directory,
    assets,
    provider,
    network,
    identity,
    restoreInput,
    publisher,
    cycle,
  };
}
type Device = Awaited<ReturnType<typeof device>>;
async function seed(db: DbClient, label: string) {
  const projectId = `project-${label}`;
  const syncGenerationId = `generation-${label}`;
  const projectSyncId = `project-sync-${label}`;
  const nodeId = `chapter-${label}`;
  await db.insert(ProjectTable).values({
    id: projectId,
    userId: 'drifting-library.db',
    name: `Synthetic ${label}`,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(BookNodeTable).values({
    id: nodeId,
    projectId,
    kind: 'chapter',
    title: '章节',
    summary: '',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(NodeContentTable).values({
    nodeId,
    contentJson: JSON.stringify({ type: 'doc', content: [] }),
    createdAt: now(),
    updatedAt: now(),
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId,
    projectId,
    projectSyncId,
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
  });
  return { projectId, syncGenerationId, projectSyncId, nodeId };
}
type Project = Awaited<ReturnType<typeof seed>>;
async function author(device: Device, project: Project, doc: Y.Doc, text: string) {
  const before = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment('default');
  if (!fragment.length) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText()]);
    fragment.insert(0, [paragraph]);
  }
  const paragraph = fragment.get(0) as Y.XmlElement;
  const prose = paragraph.get(0) as Y.XmlText;
  prose.insert(prose.length, text);
  const update = Y.encodeStateAsUpdate(doc, before);
  const changes = new SyncChangeBuilder();
  changes.add({
    action: 'yjs.update',
    target: {
      family: 'yjs',
      kind: 'prose-document',
      id: `node-content:${project.nodeId}`,
      incarnation: 0,
    },
    payload: { update },
  });
  await device.db.transaction(async (tx) => {
    await createYjsRepository(tx).appendUpdate(`node-content:${project.nodeId}`, update, {
      kind: 'user',
    });
    const clock = { nowMs: Date.now(), nowIso: now() };
    const recorded = await recordAuthoredChangeSetInTransaction(
      tx,
      { ...project, identity: device.identity, clock },
      changes,
    );
    await observeLocalAuthoredReducerInTransaction(tx, { changeSet: recorded.changeSet, clock });
  });
}
async function loadDoc(db: DbClient, nodeId: string) {
  const doc = new Y.Doc();
  const repo = createYjsRepository(db);
  const docId = `node-content:${nodeId}`;
  const snapshot = await repo.getSnapshot(docId);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob);
  for (const update of await repo.listUpdates(docId)) Y.applyUpdate(doc, update.updateBlob);
  return doc;
}

const DRIZZLE_DIRECTORY = new URL('../../../../drizzle/', import.meta.url);
const DRIVE_RETIREMENT_MIGRATION = '0014_retire_google_drive_sync';
/**
 * Writes a library file at the last schema that still allowed Google Drive,
 * recording its migration history exactly like the native migrator, so that
 * opening it applies the retirement migration as an upgrade would.
 */
function createDriveBoundLibrary(file: string, project: Project & { title: string }) {
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const retirement = journal.entries.findIndex((entry) => entry.tag === DRIVE_RETIREMENT_MIGRATION);
  expect(retirement).toBeGreaterThan(0);
  const database = new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  database.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
  for (const entry of journal.entries.slice(0, retirement)) {
    const bytes = readFileSync(new URL(`${entry.tag}.sql`, DRIZZLE_DIRECTORY));
    for (const statement of bytes.toString('utf8').split('--> statement-breakpoint'))
      if (statement.trim()) database.exec(statement);
    database
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(createHash('sha256').update(bytes).digest('hex'), entry.when);
  }
  database.exec('COMMIT');
  database.exec('PRAGMA foreign_keys = ON');
  const at = now();
  const run = (sql: string, ...values: Array<string | number | null>) => database.prepare(sql).run(...values);
  run(`INSERT INTO project (id, name, user_id, created_at, updated_at) VALUES (?, ?, 'drifting-library.db', ?, ?)`,
    project.projectId, 'Synthetic Drive library', at, at);
  run(`INSERT INTO book_node (id, project_id, kind, title, summary, writing_status, position_x, position_y, created_at, updated_at)
       VALUES (?, ?, 'chapter', ?, '', 'draft', 0, 0, ?, ?)`, project.nodeId, project.projectId, project.title, at, at);
  run(`INSERT INTO node_content (node_id, content_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    project.nodeId, JSON.stringify({ type: 'doc', content: [] }), at, at);
  run(`INSERT INTO sync_generation (sync_generation_id, project_id, project_sync_id, generation_number, protocol_version,
         domain_schema_version, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1, 'active', ?, ?)`,
    project.syncGenerationId, project.projectId, project.projectSyncId, at, at);
  // A completed Drive connect. Its commit marker is recorded the way the runtime records
  // a Drive object observed during restore: a remote row with no local download.
  const marker = syncRemoteObjectId(project.syncGenerationId, 'old-drive-object');
  run(`INSERT INTO sync_connect_attempt (attempt_id, authority_generation, kind, target_mode, target_account_subject_id,
         target_credential_secret_ref, state, created_at, updated_at)
       VALUES ('drive-connect', 1, 'connect', 'google-drive', 'synthetic-drive', 'unreachable-drive', 'preparing', ?, ?)`, at, at);
  run(`UPDATE sync_app_authority SET transition_state = 'connecting', target_mode = 'google-drive', attempt_id = 'drive-connect'`);
  run(`INSERT INTO sync_remote_object (id, sync_generation_id, provider_object_id, logical_key_id, object_kind,
         stored_sha256, size_bytes, first_observed_at, last_observed_at)
       VALUES (?, ?, 'old-drive-object', 'old-drive-key', 'snapshot-commit', ?, 1, ?, ?)`,
    marker, project.syncGenerationId, '0'.repeat(64), at, at);
  run(`INSERT INTO sync_connect_generation_attempt (attempt_id, source_sync_generation_id, commit_marker_object_id,
         state, created_at, updated_at) VALUES ('drive-connect', ?, ?, 'committed', ?, ?)`,
    project.syncGenerationId, marker, at, at);
  run(`UPDATE sync_connect_generation_attempt SET state = 'activated', activation_receipt = 'drive-receipt',
         activated_at = ?, updated_at = ? WHERE attempt_id = 'drive-connect'`, at, at);
  run(`UPDATE sync_connect_attempt SET state = 'completed', completed_at = ?, updated_at = ? WHERE attempt_id = 'drive-connect'`, at, at);
  run(`UPDATE sync_app_authority SET mode = 'google-drive', generation = 2, transition_state = 'stable',
         target_mode = NULL, attempt_id = NULL`);
  run(`INSERT INTO sync_provider_account (id, singleton_key, authority_id, provider_kind, authority_generation,
         account_subject_id, credential_secret_ref, created_at, updated_at)
       VALUES ('drive-account', 1, 'app', 'google-drive', 2, 'synthetic-drive', 'unreachable-drive', ?, ?)`, at, at);
  run(`INSERT INTO sync_provider_binding (sync_generation_id, provider_account_id, provider_namespace, state, connected_at, updated_at)
       VALUES (?, 'drive-account', 'appDataFolder', 'ready', ?, ?)`, project.syncGenerationId, at, at);
  run(`INSERT INTO sync_cursor (sync_generation_id, provider_epoch, committed_cursor, inventory_complete, updated_at)
       VALUES (?, 'drive-epoch', 'drive-cursor', 1, ?)`, project.syncGenerationId, at);
  database.close();
}

describe.skipIf(!origin)('Hosted current-client real HTTP and SQLite acceptance', () => {
  it('deletes remote bytes before local data, survives a lost acknowledgement and removes an offline peer without resurrection',
    { timeout: 150_000 }, async () => {
      const account = await createAccount();
      const a = await device('delete-source', account);
      const b = await device('delete-peer', account);
      const project = await seed(a.db, randomUUID());
      const doc = new Y.Doc();
      await author(a, project, doc, 'Synthetic deletion fixture.');
      doc.destroy();
      await restoreCloudSyncGenerations(a.restoreInput);
      await restoreCloudSyncGenerations(b.restoreInput);
      b.network.online = false;
      const peerDoc = await loadDoc(b.db, project.nodeId);
      await author(b, project, peerDoc, 'Unpublished offline peer edit.');
      peerDoc.destroy();
      const remove = () => deleteProjectWithRemoteConfirmation({ db: a.db, projectId: project.projectId,
        userId: 'drifting-library.db', signal,
        dependencies: { hostedEnabled: true, accountSubject: () => account.accountSubject,
          deleteRemote: input => a.provider.deleteProjectGeneration(input) } });
      a.network.online = false;
      await expect(remove()).rejects.toThrow('offline');
      expect(await a.db.select().from(ProjectTable)).toHaveLength(1);
      a.network.online = true;
      a.network.loseDeleteResponse = true;
      await expect(remove()).rejects.toThrow('lost deletion acknowledgement');
      expect(await a.db.select().from(ProjectTable)).toHaveLength(1);
      expect(await a.provider.discover({ ...account, signal })).toEqual([]);
      await remove();
      expect(await a.db.select().from(ProjectTable)).toEqual([]);
      b.network.online = true;
      await b.cycle(project.syncGenerationId);
      expect(await b.db.select().from(ProjectTable)).toEqual([]);
      expect(await b.db.select().from(SyncGenerationTable)).toMatchObject([{ status: 'purged' }]);
      const fresh = await device('delete-fresh', account);
      expect((await restoreCloudSyncGenerations(fresh.restoreInput)).restored).toEqual([]);
      expect(await fresh.db.select().from(ProjectTable)).toEqual([]);
    });
  it(
    'connects two local libraries, merges offline prose, recovers lost upload responses and discovers newly provisioned projects',
    { timeout: 150_000 },
    async () => {
      const account = await createAccount();
      const a = await device('desktop', account);
      const b = await device('mobile', account);
      const project = await seed(a.db, randomUUID());
      const initial = new Y.Doc();
      await author(a, project, initial, '离线初稿。');
      initial.destroy();
      await restoreCloudSyncGenerations(a.restoreInput);
      const connected = await restoreCloudSyncGenerations(b.restoreInput);
      expect(connected.restored.map((item) => item.projectId)).toContain(project.projectId);
      const first = await loadDoc(b.db, project.nodeId);
      expect(first.getXmlFragment('default').toString()).toContain('离线初稿。');
      first.destroy();
      const docA = await loadDoc(a.db, project.nodeId);
      const docB = await loadDoc(b.db, project.nodeId);
      a.network.online = false;
      b.network.online = false;
      await author(a, project, docA, '桌面续写。');
      await author(b, project, docB, '手机续写。');
      docA.destroy();
      docB.destroy();
      await expect(a.cycle(project.syncGenerationId)).rejects.toThrow('offline');
      a.network.online = true;
      b.network.online = true;
      a.network.loseUploadResponse = true;
      await a.cycle(project.syncGenerationId).catch(() => undefined);
      await a.cycle(project.syncGenerationId);
      await b.cycle(project.syncGenerationId);
      await a.cycle(project.syncGenerationId);
      await b.cycle(project.syncGenerationId);
      const mergedA = await loadDoc(a.db, project.nodeId);
      const mergedB = await loadDoc(b.db, project.nodeId);
      const text = mergedA.getXmlFragment('default').toString();
      expect(text).toContain('离线初稿。');
      expect(text).toContain('桌面续写。');
      expect(text).toContain('手机续写。');
      expect(mergedB.getXmlFragment('default').toString()).toBe(text);
      mergedA.destroy();
      mergedB.destroy();
      expect(await a.cycle(project.syncGenerationId)).toMatchObject({
        pendingChangeSets: 0,
        pendingTransfers: 0,
      });
      const fresh = await seed(a.db, randomUUID());
      const repository = new SyncGenerationProvisionRepository(a.db);
      const pending = await repository.ensureAndListPending('hosted');
      expect(pending).toHaveLength(1);
      await new PendingSyncGenerationProvisioner({
        db: a.db,
        repository,
        createProvider: () => a.provider,
        createSnapshotPublisher: ({ pending: p, providerGeneration }) =>
          a.publisher(p.projectId, p.syncGenerationId, providerGeneration),
        emitAuthorityChanged: () => {},
      }).provision(pending[0]!, signal);
      expect(
        (await restoreDiscoveredCloudProjects(b.restoreInput)).map((p) => p.projectId),
      ).toEqual([fresh.projectId]);
      expect(await restoreDiscoveredCloudProjects(b.restoreInput)).toEqual([]);
      const preserved = await loadDoc(b.db, project.nodeId);
      expect(preserved.getXmlFragment('default').toString()).toBe(text);
      preserved.destroy();
    },
  );
  it(
    'restores exact synthetic asset bytes and preserves local prose through rejected credentials and a SQLite reopen',
    { timeout: 150_000 },
    async () => {
      const account = await createAccount();
      const a = await device('asset-source', account);
      const b = await device('asset-target', account);
      const project = await seed(a.db, randomUUID());
      const assetId = randomUUID();
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 255]);
      const hash = await sha256Bytes(bytes);
      a.assets.set(assetId, bytes);
      await a.db.insert(ProjectAssetTable).values({
        id: assetId,
        projectId: project.projectId,
        kind: 'image',
        sourceMime: 'image/png',
        sourceSha256: hash.slice(7),
        sourceSizeBytes: bytes.length,
        width: 1,
        height: 1,
        createdAt: now(),
      });
      await restoreCloudSyncGenerations(a.restoreInput);
      await restoreCloudSyncGenerations(b.restoreInput);
      expect(b.assets.get(assetId)).toEqual(bytes);
      const doc = new Y.Doc();
      await author(b, project, doc, '账号过期后仍然保存的正文。');
      doc.destroy();
      b.network.token = 'invalid-session';
      await expect(b.cycle(project.syncGenerationId)).rejects.toThrow('Hosted 401');
      const pending = await loadDoc(b.db, project.nodeId);
      expect(pending.getXmlFragment('default').toString()).toContain('账号过期');
      pending.destroy();
      b.network.token = account.token;
      await resumeHostedAuthentication(account.accountSubject, b.db);
      await b.cycle(project.syncGenerationId);
      await a.cycle(project.syncGenerationId);
      await b.gateway.close();
      gateways.splice(gateways.indexOf(b.gateway), 1);
      const reopened = new ProductFileBackedSqliteGateway(path.join(b.directory, 'library.db'));
      gateways.push(reopened);
      const recovered = await loadDoc(reopened.client(), project.nodeId);
      expect(recovered.getXmlFragment('default').toString()).toContain('账号过期');
      recovered.destroy();
      expect(
        (
          await reopened
            .client()
            .select()
            .from(ProjectAssetTable)
            .where(eq(ProjectAssetTable.id, assetId))
        )[0]?.sourceSha256,
      ).toBe(hash.slice(7));
    },
  );
  it(
    'connects a library migrated from Google Drive to Hosted like any local library and keeps its content',
    { timeout: 150_000 },
    async () => {
      const account = await createAccount();
      const suffix = randomUUID();
      const project = {
        projectId: `project-${suffix}`,
        syncGenerationId: `generation-${suffix}`,
        projectSyncId: `project-sync-${suffix}`,
        nodeId: `chapter-${suffix}`,
        title: 'Drive 时期写下的章节名',
      };
      // Opening the file applies the retirement migration; no provider is contacted.
      const a = await device('drive-migrated', account, (file) => createDriveBoundLibrary(file, project));
      const raw = a.gateway.database;
      expect(raw.prepare('SELECT mode, generation, transition_state FROM sync_app_authority').get()).toEqual({
        mode: 'local',
        generation: 3,
        transition_state: 'stable',
      });
      for (const table of ['sync_provider_account', 'sync_provider_binding', 'sync_cursor'])
        expect(raw.prepare(`SELECT count(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
      expect(await a.db.select().from(SyncRemoteObjectTable)).toMatchObject([{ providerObjectId: 'old-drive-object' }]);

      const doc = new Y.Doc();
      await author(a, project, doc, '迁移后继续离线写的正文。');
      const journalBefore = await a.db.select().from(SyncChangeSetTable);
      expect(journalBefore).toHaveLength(1);

      await restoreCloudSyncGenerations(a.restoreInput);
      expect(raw.prepare('SELECT mode, generation, transition_state FROM sync_app_authority').get()).toEqual({
        mode: 'hosted',
        generation: 4,
        transition_state: 'stable',
      });
      // The same generation is published and bound; no replacement generation is created.
      expect(await a.db.select().from(SyncGenerationTable)).toMatchObject([
        { syncGenerationId: project.syncGenerationId, status: 'active' },
      ]);
      expect(
        (await createSyncAppAuthorityRepository(a.db).listActiveRuntimeBindings()).map(
          (item) => item.binding.syncGenerationId,
        ),
      ).toEqual([project.syncGenerationId]);
      expect(
        raw.prepare('SELECT attempt_id, target_mode, state FROM sync_connect_attempt ORDER BY created_at, attempt_id').all(),
      ).toEqual([
        { attempt_id: 'drive-connect', target_mode: 'google-drive', state: 'completed' },
        expect.objectContaining({ target_mode: 'hosted', state: 'completed' }),
      ]);
      const local = await loadDoc(a.db, project.nodeId);
      expect(local.getXmlFragment('default').toString()).toBe(doc.getXmlFragment('default').toString());
      local.destroy();
      expect(await a.db.select().from(SyncChangeSetTable)).toEqual(expect.arrayContaining(journalBefore));

      const b = await device('drive-migrated-peer', account);
      const restored = await restoreCloudSyncGenerations(b.restoreInput);
      expect(restored.restored.map((item) => item.projectId)).toEqual([project.projectId]);
      const peerDoc = await loadDoc(b.db, project.nodeId);
      expect(peerDoc.getXmlFragment('default').toString()).toBe(doc.getXmlFragment('default').toString());
      expect(
        (await b.db.select().from(BookNodeTable).where(eq(BookNodeTable.id, project.nodeId)))[0]?.title,
      ).toBe(project.title);

      await author(b, project, peerDoc, '第二台设备继续写。');
      await b.cycle(project.syncGenerationId);
      await a.cycle(project.syncGenerationId);
      await b.cycle(project.syncGenerationId);
      const roundTrip = await loadDoc(a.db, project.nodeId);
      expect(roundTrip.getXmlFragment('default').toString()).toBe(peerDoc.getXmlFragment('default').toString());
      expect(roundTrip.getXmlFragment('default').toString()).toContain('迁移后继续离线写的正文。');
      expect(await a.cycle(project.syncGenerationId)).toMatchObject({
        pendingChangeSets: 0,
        pendingSegments: 0,
        pendingTransfers: 0,
      });

      const deletedGenerations: string[] = [];
      await deleteProjectWithRemoteConfirmation({
        db: a.db, projectId: project.projectId, userId: 'drifting-library.db', signal,
        dependencies: {
          hostedEnabled: true, accountSubject: () => account.accountSubject,
          deleteRemote: async input => {
            deletedGenerations.push(input.syncGenerationId);
            await a.provider.deleteProjectGeneration(input);
          },
        },
      });
      expect(deletedGenerations).toEqual([project.syncGenerationId]);
      await b.cycle(project.syncGenerationId);
      expect(await b.db.select().from(ProjectTable)).toHaveLength(0);
      doc.destroy();
      peerDoc.destroy();
      roundTrip.destroy();
    },
  );
});
