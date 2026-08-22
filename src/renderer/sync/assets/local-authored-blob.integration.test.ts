import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectAsset } from '../../domain/project-asset';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  ProjectTable,
  SyncBlobStateTable,
  SyncGenerationTable,
  SyncLocalObjectTable,
} from '../../schema/drizzle';
import { createLocalObjectRef, type Sha256 } from '../protocol';
import {
  ensureLocalAuthoredAssetBlobVerified,
  type LocalAuthoredBlobDependencies,
} from './local-authored-blob';

const NOW = '2026-08-21T12:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const BLOB_ID = `sha256:${DIGEST}` as Sha256;
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

const ASSET: ProjectAsset = {
  id: 'asset-1',
  projectId: 'project-1',
  kind: 'image',
  sourceMime: 'image/png',
  sourceSizeBytes: 42,
  sourceSha256: DIGEST,
  width: 120,
  height: 80,
  createdAt: NOW,
};

async function setup(withGeneration = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-local-asset-blob-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: ASSET.projectId,
    userId: 'local',
    name: 'Project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (withGeneration) {
    await db.insert(SyncGenerationTable).values({
      syncGenerationId: 'sync-generation-1',
      projectId: ASSET.projectId,
      projectSyncId: 'project-sync-1',
      generationNumber: 1,
      protocolVersion: 1,
      domainSchemaVersion: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const prepareOutbound = vi.fn(async () => ({
    sourceRef: createLocalObjectRef('syncobj:verified-local-source'),
    logicalKeyId: 'sha256:' + 'b'.repeat(64),
    storedSha256: BLOB_ID,
    contentSha256: BLOB_ID,
    sizeBytes: ASSET.sourceSizeBytes,
  }));
  const discardLocal = vi.fn(async () => undefined);
  const dependencies: LocalAuthoredBlobDependencies = {
    database: () => db,
    blobPort: { prepareOutbound },
    discardLocal,
    nowIso: () => NOW,
  };
  return { db, dependencies, prepareOutbound, discardLocal };
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('local authored asset blob verification', () => {
  it('records a verified native blob before asset.bind domain validation', async () => {
    const input = await setup();

    await ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies);

    expect(input.prepareOutbound).toHaveBeenCalledWith({
      syncGenerationId: 'sync-generation-1',
      projectId: ASSET.projectId,
      declaration: {
        assetId: ASSET.id,
        blobId: BLOB_ID,
        sourceSha256: BLOB_ID,
        sourceSizeBytes: ASSET.sourceSizeBytes,
        sourceMime: ASSET.sourceMime,
      },
    });
    expect(await input.db.select().from(SyncLocalObjectTable)).toMatchObject([
      {
        syncGenerationId: 'sync-generation-1',
        storageRef: 'syncobj:verified-local-source',
        contentSha256: DIGEST,
        state: 'verified',
      },
    ]);
    expect(await input.db.select().from(SyncBlobStateTable)).toMatchObject([
      {
        syncGenerationId: 'sync-generation-1',
        blobId: BLOB_ID,
        assetId: ASSET.id,
        contentSha256: DIGEST,
        localState: 'verified',
        remoteState: 'missing',
      },
    ]);
    expect(input.discardLocal).not.toHaveBeenCalled();
  });

  it('reuses a matching verified receipt without recapturing native bytes', async () => {
    const input = await setup();
    await ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies);

    await ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies);

    expect(input.prepareOutbound).toHaveBeenCalledTimes(1);
    expect(await input.db.select().from(SyncBlobStateTable)).toHaveLength(1);
  });

  it('preserves an already-available remote blob while repairing its local receipt', async () => {
    const input = await setup();
    await ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies);
    await input.db
      .update(SyncBlobStateTable)
      .set({ localState: 'missing', remoteState: 'available', updatedAt: NOW });

    await ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies);

    expect(input.prepareOutbound).toHaveBeenCalledTimes(2);
    expect(await input.db.select().from(SyncBlobStateTable)).toMatchObject([
      { localState: 'verified', remoteState: 'available' },
    ]);
  });

  it('fails before native capture when the project has no active generation', async () => {
    const input = await setup(false);

    await expect(
      ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies),
    ).rejects.toThrow('has no active SyncGeneration');
    expect(input.prepareOutbound).not.toHaveBeenCalled();
  });

  it('discards the opaque native object when the durable receipt cannot commit', async () => {
    const input = await setup();
    input.prepareOutbound.mockResolvedValueOnce({
      sourceRef: createLocalObjectRef('syncobj:mismatched-source'),
      logicalKeyId: 'sha256:' + 'c'.repeat(64),
      storedSha256: BLOB_ID,
      contentSha256: `sha256:${'d'.repeat(64)}` as Sha256,
      sizeBytes: ASSET.sourceSizeBytes,
    });

    await expect(
      ensureLocalAuthoredAssetBlobVerified(ASSET, input.dependencies),
    ).rejects.toThrow('changed immutable metadata');
    expect(input.discardLocal).toHaveBeenCalledWith('syncobj:mismatched-source');
    expect(await input.db.select().from(SyncBlobStateTable)).toEqual([]);
  });
});
