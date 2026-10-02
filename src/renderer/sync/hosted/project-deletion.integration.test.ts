import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as project,
  WORKSPACE_TEST_NOW as now } from '../../services/workspace-projection.test-support';
import { ProjectTable, BookNodeTable, SyncGenerationTable,
  SyncProviderBindingTable, SyncRemoteObjectTable } from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { applyHostedGenerationDeletion, deleteProjectWithRemoteConfirmation } from './project-deletion';

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>>;
afterEach(async () => { await fixture?.close(); });
async function setup(hosted = true) {
  fixture = await createWorkspaceProjectionFixture();
  const { db } = fixture;
  const authority = createSyncAppAuthorityRepository(db);
  if (hosted) {
    const attempt = await authority.begin({ targetMode: 'hosted', accountSubjectId: 'author',
      credentialSecretRef: 'hosted.session', nowIso: now });
    await db.insert(SyncRemoteObjectTable).values({ id: 'genesis-marker', syncGenerationId: 'workspace-generation',
      providerObjectId: 'marker', logicalKeyId: 'marker-key', objectKind: 'snapshot-commit', storedSha256: '0'.repeat(64),
      sizeBytes: 1, firstObservedAt: now, lastObservedAt: now });
    await authority.markSyncGenerationCommitted({ attemptId: attempt.attemptId,
      sourceSyncGenerationId: 'workspace-generation', commitMarkerObjectId: 'genesis-marker', nowIso: now });
    await authority.complete({ attemptId: attempt.attemptId, providerAccountId: 'hosted-account',
      bindings: [{ syncGenerationId: 'workspace-generation', providerNamespace: 'project-v1', providerGenerationRef: null }], nowIso: now });
  }
  const disconnect = async () => {
    const attempt = await authority.begin({ targetMode: 'local', nowIso: now });
    await authority.markSyncGenerationCommitted({ attemptId: attempt.attemptId,
      sourceSyncGenerationId: 'workspace-generation', nowIso: now });
    await authority.complete({ attemptId: attempt.attemptId, nowIso: now });
  };
  let account: string | null = 'author';
  const deleteRemote = vi.fn(async () => {});
  const dependencies = { hostedEnabled: hosted, accountSubject: () => account, deleteRemote };
  const remove = () => deleteProjectWithRemoteConfirmation({ db, ...project,
    signal: new AbortController().signal, dependencies });
  return { db, disconnect, remove, deleteRemote, dependencies, setAccount: (value: string | null) => { account = value; } };
}
async function expectKept() {
  expect(await fixture.db.select().from(ProjectTable).where(eq(ProjectTable.id, project.projectId))).toHaveLength(1);
  expect(await fixture.db.select().from(BookNodeTable)).toHaveLength(2);
}

describe('Hosted project deletion boundary', () => {
  it('retains all local data while remote confirmation is pending, then commits purge and asset inventory', async () => {
    const f = await setup();
    f.deleteRemote.mockImplementation(async () => { await expectKept(); });
    expect(await f.remove()).toMatchObject({ assetIds: ['asset'] });
    expect(f.deleteRemote).toHaveBeenCalledWith(expect.objectContaining({ accountSubject: 'author', syncGenerationId: 'workspace-generation' }));
    expect(await f.db.select().from(ProjectTable)).toMatchObject([{ id: 'other-project' }]);
    expect(await f.db.select().from(SyncGenerationTable)).toMatchObject([{ status: 'purged', projectId: null }]);
    expect(await f.db.select().from(SyncProviderBindingTable)).toMatchObject([{ state: 'purged' }]);
  });
  it.each(['offline', 'needs-reauth', 'server-does-not-support-delete', 'lost-response'])(
    'preserves prose and retries the same remote identity after %s', async code => {
      const f = await setup();
      f.deleteRemote.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(f.remove()).rejects.toThrow(code);
      await expectKept();
      expect((await f.db.select().from(SyncGenerationTable))[0].status).toBe('active');
      await f.remove();
      expect(f.deleteRemote).toHaveBeenCalledTimes(2);
      expect(f.deleteRemote).toHaveBeenNthCalledWith(2, expect.objectContaining({ syncGenerationId: 'workspace-generation' }));
    },
  );
  it('rejects signed-out and wrong-account deletion without sending requests', async () => {
    const f = await setup();
    for (const account of [null, 'another-author']) {
      f.setAccount(account);
      await expect(f.remove()).rejects.toMatchObject({ code: 'account' });
      await expectKept();
    }
    expect(f.deleteRemote).not.toHaveBeenCalled();
  });
  it('keeps the project if account ownership changes while DELETE is in flight', async () => {
    const f = await setup();
    f.deleteRemote.mockImplementation(async () => { f.setAccount('another-author'); });
    await expect(f.remove()).rejects.toMatchObject({ code: 'account' });
    await expectKept();
  });
  it('does not fall back to local-only deletion after Hosted disconnect', async () => {
    const f = await setup();
    await f.disconnect();
    await expect(f.remove()).rejects.toMatchObject({ code: 'connect' });
    await expectKept();
    expect(f.deleteRemote).not.toHaveBeenCalled();
  });
  it('deletes pending genesis remotely before it can be published', async () => {
    const f = await setup();
    await f.db.delete(SyncProviderBindingTable);
    await f.remove();
    expect(f.deleteRemote).toHaveBeenCalledOnce();
  });
  it('includes retained Hosted generations from historical connect receipts', async () => {
    const f = await setup();
    await f.db.delete(SyncProviderBindingTable);
    await f.db.update(SyncGenerationTable).set({ status: 'retired', retiredAt: now });
    await f.db.insert(SyncGenerationTable).values({ syncGenerationId: 'new-generation', projectId: project.projectId,
      projectSyncId: 'workspace-sync', generationNumber: 2, status: 'active', createdAt: now, updatedAt: now });
    await f.db.insert(SyncProviderBindingTable).values({ syncGenerationId: 'new-generation',
      providerAccountId: 'hosted-account', providerNamespace: 'project-v1', state: 'ready', updatedAt: now });
    await f.remove();
    expect(f.deleteRemote).toHaveBeenCalledTimes(2);
    expect(f.deleteRemote).toHaveBeenCalledWith(expect.objectContaining({ syncGenerationId: 'workspace-generation' }));
  });
  it('rejects a library change between remote confirmation and the local transaction', async () => {
    const f = await setup();
    f.deleteRemote.mockImplementation(async () => {
      await f.db.insert(SyncGenerationTable).values({ syncGenerationId: 'unexpected-generation', projectId: project.projectId,
        projectSyncId: 'other-sync', generationNumber: 1, status: 'retired', retiredAt: now, createdAt: now, updatedAt: now });
    });
    await expect(f.remove()).rejects.toMatchObject({ code: 'changed' });
    await expectKept();
  });
  it('a local-only build cannot silently discard evidence of an unowned remote copy', async () => {
    const f = await setup(false);
    await f.db.insert(SyncRemoteObjectTable).values({ id: 'remote-evidence', syncGenerationId: 'workspace-generation',
      providerObjectId: 'remote', logicalKeyId: 'key', objectKind: 'snapshot-commit', storedSha256: '0'.repeat(64),
      sizeBytes: 1, firstObservedAt: now, lastObservedAt: now });
    await expect(f.remove()).rejects.toMatchObject({ code: 'connect' });
    await expectKept();
  });
  it('pure local builds can delete never-synced data without a network dependency', async () => {
    const f = await setup(false);
    await f.remove();
    expect(f.deleteRemote).not.toHaveBeenCalled();
  });
  it('applies a confirmed server tombstone idempotently without touching another project', async () => {
    const f = await setup();
    expect(await applyHostedGenerationDeletion(f.db, 'workspace-generation')).toMatchObject({ projectId: project.projectId });
    expect(await applyHostedGenerationDeletion(f.db, 'workspace-generation')).toBeNull();
    expect(await f.db.select().from(ProjectTable)).toMatchObject([{ id: 'other-project' }]);
  });
});
