import { adoptDriveReplicaForHosted } from './adopt-drive';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
  SyncFieldClockTable,
} from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { ProviderSnapshotPublisher } from '../checkpoint';
import { SqliteSyncGenerationRuntime } from '../engine/durable-runtime';
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

async function device(label: string, account: Awaited<ReturnType<typeof createAccount>>) {
  const directory = await mkdtemp(path.join(tmpdir(), `drifting-hosted-${label}-`));
  temp.push(directory);
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
  const network = { online: true, loseUploadResponse: false, token: account.token };
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
      if (!response.ok)
        throw Object.assign(new Error(`Hosted ${response.status}`), {
          code: response.status === 401 ? 'needs-reauth' : 'provider-unavailable',
          retryable: response.status !== 401,
        });
      if (input.sourceRef && network.loseUploadResponse) {
        network.loseUploadResponse = false;
        throw new Error('Injected lost acknowledgement after server commit');
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

describe.skipIf(!origin)('Hosted current-client real HTTP and SQLite acceptance', () => {
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
    'takes over an offline Drive replica atomically, keeps immutable history, and provisions a fresh Hosted generation',
    { timeout: 150_000 },
    async () => {
      const account = await createAccount();
      const a = await device('drive-takeover-a', account);
      const b = await device('drive-takeover-b', account);
      const project = await seed(a.db, randomUUID());
      const doc = new Y.Doc();
      await author(a, project, doc, '尚未上传到 Drive 的中文正文。');
      const title = '离线修改的章节名';
      for (let revision = 0; revision < 40; revision++)
        await a.db.transaction(async (tx) => {
          const changes = new SyncChangeBuilder();
          changes.add({
            action: 'field.set',
            target: { family: 'entity', kind: 'node', id: project.nodeId, incarnation: 0 },
            payload: { field: 'title', value: title },
          });

          await tx.update(BookNodeTable).set({ title }).where(eq(BookNodeTable.id, project.nodeId));
          const clock = { nowMs: Date.now() + 10_000, nowIso: now() };
          const result = await recordAuthoredChangeSetInTransaction(
            tx,
            { ...project, identity: a.identity, clock },
            changes,
          );
          await observeLocalAuthoredReducerInTransaction(tx, {
            changeSet: result.changeSet,
            clock,
          });
        });
      const authorityRepository = createSyncAppAuthorityRepository(a.db);
      const driveAttempt = await authorityRepository.begin({
        targetMode: 'google-drive',
        accountSubjectId: 'synthetic-drive',
        credentialSecretRef: 'unreachable-drive',
        nowIso: now(),
      });
      await a.db.insert(SyncRemoteObjectTable).values({
        id: 'old-drive-marker',
        syncGenerationId: project.syncGenerationId,
        providerObjectId: 'old-drive-object',
        logicalKeyId: 'old-drive-key',
        objectKind: 'snapshot-commit',
        storedSha256: '0'.repeat(64),
        sizeBytes: 1,
        firstObservedAt: now(),
        lastObservedAt: now(),
      });
      await authorityRepository.markSyncGenerationCommitted({
        attemptId: driveAttempt.attemptId,
        sourceSyncGenerationId: project.syncGenerationId,
        commitMarkerObjectId: 'old-drive-marker',
        nowIso: now(),
      });
      await authorityRepository.complete({
        attemptId: driveAttempt.attemptId,
        bindings: [
          {
            syncGenerationId: project.syncGenerationId,
            providerNamespace: 'appDataFolder',
            providerGenerationRef: null,
          },
        ],
        nowIso: now(),
      });
      const assetId = randomUUID();
      const assetBytes = new Uint8Array([137, 80, 78, 71, 7, 8, 9]);
      const assetHash = await sha256Bytes(assetBytes);
      a.assets.set(assetId, assetBytes);
      await a.db.insert(ProjectAssetTable).values({
        id: assetId,
        projectId: project.projectId,
        kind: 'image',
        sourceMime: 'image/png',
        sourceSha256: assetHash.slice(7),
        sourceSizeBytes: assetBytes.length,
        width: 1,
        height: 1,
        createdAt: now(),
      });
      const original = await a.db.select().from(SyncChangeSetTable);
      const identity = {
        ...a.identity,
        createWriterIdentity: () => ({ writerId: randomUUID(), writerEpoch: randomUUID() }),
      };
      let guards = 0;
      await expect(
        adoptDriveReplicaForHosted({
          db: a.db,
          accountSubject: account.accountSubject,
          identity,
          assertAccount() {
            if (++guards === 2) throw new Error('Account changed before commit');
          },
        }),
      ).rejects.toThrow('Account changed');
      expect((await createSyncAppAuthorityRepository(a.db).read()).mode).toBe('google-drive');
      expect(await a.db.select().from(SyncChangeSetTable)).toEqual(original);
      expect(await a.db.select().from(SyncGenerationTable)).toHaveLength(1);

      // No provider call is made by takeover, including while all network is unavailable.
      a.network.online = false;
      const adoption = await adoptDriveReplicaForHosted({
        db: a.db,
        accountSubject: account.accountSubject,
        identity,
        assertAccount() {},
      });
      const [newGeneration] = adoption.syncGenerationIds;
      expect(newGeneration).not.toBe(project.syncGenerationId);
      expect(
        await a.db
          .select()
          .from(SyncChangeSetTable)
          .where(eq(SyncChangeSetTable.syncGenerationId, project.syncGenerationId)),
      ).toEqual(original);
      expect(
        (
          await a.db
            .select()
            .from(SyncFieldClockTable)
            .where(eq(SyncFieldClockTable.syncGenerationId, newGeneration!))
        )[0]?.changeSetId,
      ).not.toBe(original[1]?.changeSetId);
      const hostedProject = { ...project, syncGenerationId: newGeneration! };
      await author(a, hostedProject, doc, '切换后仍可离线继续写。');
      const retry = { ...a.restoreInput, attemptId: adoption.attemptId };
      await expect(restoreCloudSyncGenerations(retry)).rejects.toThrow();
      expect(await createSyncAppAuthorityRepository(a.db).listActiveRuntimeBindings()).toHaveLength(
        0,
      );
      a.network.online = true;
      await restoreCloudSyncGenerations(retry);
      await restoreCloudSyncGenerations(b.restoreInput);
      expect(b.assets.get(assetId)).toEqual(assetBytes);
      const restored = await loadDoc(b.db, project.nodeId);
      expect(restored.getXmlFragment('default').toString()).toBe(
        doc.getXmlFragment('default').toString(),
      );
      expect(
        (await b.db.select().from(BookNodeTable).where(eq(BookNodeTable.id, project.nodeId)))[0]
          ?.title,
      ).toBe(title);
      await author(b, hostedProject, restored, '第二台 Mac 继续写。');
      await b.cycle(newGeneration!);
      await a.cycle(newGeneration!);
      await b.cycle(newGeneration!);
      const roundTrip = await loadDoc(a.db, project.nodeId);
      expect(roundTrip.getXmlFragment('default').toString()).toBe(
        restored.getXmlFragment('default').toString(),
      );
      expect(await a.cycle(newGeneration!)).toMatchObject({
        pendingChangeSets: 0,
        pendingSegments: 0,
        pendingTransfers: 0,
      });
      doc.destroy();
      restored.destroy();
      roundTrip.destroy();
    },
  );
});
