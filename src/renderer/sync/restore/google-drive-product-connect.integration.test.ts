import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { ProjectTable, SyncGenerationTable } from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import {
  connectGoogleDriveFromProduct,
  type ProductGoogleDriveConnectDependencies,
} from './google-drive-product-connect';

const NOW = '2026-08-15T12:00:00.000Z';
const LATER = '2026-08-15T12:01:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function setup(errorCode?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-product-connect-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: 'project-1',
    userId: 'local',
    name: 'Project',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: 'sync-generation-1',
    projectId: 'project-1',
    projectSyncId: 'project-sync-1',
    generationNumber: 1,
    protocolVersion: 1,
    domainSchemaVersion: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (errorCode) {
    const authority = createSyncAppAuthorityRepository(db);
    const attempt = await authority.begin({
      targetMode: 'google-drive',
      accountSubjectId: 'subject-1',
      credentialSecretRef: 'secret:credential-original',
      attemptId: 'connect-1',
      nowIso: NOW,
    });
    await authority.block({ attemptId: attempt.attemptId, errorCode, nowIso: LATER });
  }
  const dependencies: ProductGoogleDriveConnectDependencies = {
    connectAccount: vi.fn(async () => ({
      accountSubject: 'subject-new',
      credentialSecretRef: 'secret:credential-new',
    })),
    reauthorizeAccount: vi.fn(async (credentialSecretRef) => ({
      accountSubject: 'subject-1',
      credentialSecretRef,
    })),
    connect: vi.fn(async ({ account, attemptId }) => ({
      attemptId: attemptId ?? 'connect-new',
      restored: [],
      connectedLocalSyncGenerationIds: ['sync-generation-1'],
      account,
    })),
  };
  return { db, dependencies };
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('product Google Drive unified connect', () => {
  it('uses one OAuth action for account discovery, remote restore, and local publication', async () => {
    const input = await setup();
    const signal = new AbortController().signal;
    await expect(
      connectGoogleDriveFromProduct({ db: input.db, signal }, input.dependencies),
    ).resolves.toMatchObject({
      status: 'connected',
      accountSubject: 'subject-new',
      connectedLocalSyncGenerationIds: ['sync-generation-1'],
    });
    expect(input.dependencies.connectAccount).toHaveBeenCalledOnce();
    expect(input.dependencies.connect).toHaveBeenCalledWith({
      db: input.db,
      account: {
        accountSubject: 'subject-new',
        credentialSecretRef: 'secret:credential-new',
      },
      signal,
    });
  });

  it('reuses the durable credential after an offline failure without new OAuth', async () => {
    const input = await setup('OFFLINE');
    const signal = new AbortController().signal;
    await connectGoogleDriveFromProduct({ db: input.db, signal }, input.dependencies);
    expect(input.dependencies.connectAccount).not.toHaveBeenCalled();
    expect(input.dependencies.reauthorizeAccount).not.toHaveBeenCalled();
    expect(input.dependencies.connect).toHaveBeenCalledWith({
      db: input.db,
      account: {
        accountSubject: 'subject-1',
        credentialSecretRef: 'secret:credential-original',
      },
      signal,
      attemptId: 'connect-1',
    });
  });

  it('reauthorizes the same durable identity only when required', async () => {
    const input = await setup('needs-reauth');
    await connectGoogleDriveFromProduct(
      { db: input.db, signal: new AbortController().signal },
      input.dependencies,
    );
    expect(input.dependencies.connectAccount).not.toHaveBeenCalled();
    expect(input.dependencies.reauthorizeAccount).toHaveBeenCalledWith(
      'secret:credential-original',
    );
  });
});
