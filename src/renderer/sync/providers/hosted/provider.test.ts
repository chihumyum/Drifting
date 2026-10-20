import { describe, expect, it, vi } from 'vitest';
import {
  createLocalObjectRef,
  createProviderCursor,
  createProviderObjectId,
  type ProviderBinding,
  type Sha256,
} from '../../protocol';
import { HostedObjectLogProvider, type HostedObjectTransport } from './provider';

const binding: ProviderBinding = {
  bindingId: 'binding-a',
  syncGenerationId: 'generation-a',
  accountRef: 'account-a',
  secretRef: 'hosted.session',
  authorityGeneration: 1,
};
const sha = `sha256:${'a'.repeat(64)}` as Sha256;
const object = {
  objectId: createProviderObjectId('object-a'),
  objectKind: 'segment' as const,
  logicalKeyId: `sha256:${'b'.repeat(64)}`,
  storedSha256: sha,
  sizeBytes: 3,
};
function setup() {
  let account = 'account-a';
  const request = vi
    .fn<HostedObjectTransport['request']>()
    .mockResolvedValue({ syncGenerationId: binding.syncGenerationId });
  const provider = new HostedObjectLogProvider({ accountSubject: () => account, request });
  return {
    provider,
    request,
    changeAccount: () => {
      account = 'account-b';
    },
  };
}

describe('Hosted provider response boundary', () => {
  it('deletes without reopening and validates the exact durable remote receipt', async () => {
    const { provider, request, changeAccount } = setup();
    const input = { accountSubject: 'account-a', syncGenerationId: 'generation-a', signal: new AbortController().signal };
    request.mockResolvedValue({ status: 'deleted', syncGenerationId: 'generation-a', deletedAt: '2026-10-02T00:00:00.000Z' });
    await provider.deleteProjectGeneration(input);
    expect(request).toHaveBeenCalledWith({ path: '/api/sync/v1/project-v1/generations/generation-a', method: 'DELETE', signal: input.signal });
    expect(request).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce({ status: 'deleted', syncGenerationId: 'other', deletedAt: '2026-10-02T00:00:00.000Z' });
    await expect(provider.deleteProjectGeneration(input)).rejects.toMatchObject({ code: 'REMOTE_STORE_CORRUPT' });
    request.mockImplementationOnce(async () => { changeAccount(); return {}; });
    await expect(provider.deleteProjectGeneration(input)).rejects.toMatchObject({ code: 'INVALID_GENERATION' });
  });
  it('rejects an account change while a response is in flight', async () => {
    const { provider, request, changeAccount } = setup();
    const generation = await provider.openGeneration(binding);
    request.mockImplementationOnce(async () => {
      changeAccount();
      return { cursor: 'cursor-a' };
    });
    await expect(provider.captureStartCursor(generation)).rejects.toMatchObject({
      code: 'INVALID_GENERATION',
    });
    await expect(provider.listInventory({ generation })).rejects.toMatchObject({
      code: 'INVALID_GENERATION',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects upload acknowledgements for different bytes', async () => {
    const { provider, request } = setup();
    const generation = await provider.openGeneration(binding);
    request.mockResolvedValueOnce({ status: 'created', object: { ...object, sizeBytes: 4 } });
    await expect(
      provider.uploadImmutable({
        generation,
        sourceRef: createLocalObjectRef('syncobj:source.a'),
        objectKind: object.objectKind,
        logicalKeyId: object.logicalKeyId,
        storedSha256: sha,
        sizeBytes: 3,
        transferId: 'transfer-a',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_STORE_CORRUPT' });
  });
  it('rejects oversized pages and missing continuation cursors', async () => {
    const { provider, request } = setup();
    const generation = await provider.openGeneration(binding);
    request.mockResolvedValueOnce({ objects: Array.from({ length: 129 }, () => object) });
    await expect(provider.listInventory({ generation })).rejects.toMatchObject({
      code: 'REMOTE_STORE_CORRUPT',
    });
    request.mockResolvedValueOnce({ changes: [] });
    await expect(
      provider.listChanges({ generation, cursor: createProviderCursor('cursor-a') }),
    ).rejects.toMatchObject({ code: 'REMOTE_STORE_CORRUPT' });
  });
  it('rejects a download returned under a different destination', async () => {
    const { provider, request } = setup();
    const generation = await provider.openGeneration(binding);
    request.mockResolvedValueOnce({
      destinationRef: createLocalObjectRef('syncobj:other.a'),
      storedSha256: sha,
      sizeBytes: 3,
    });
    await expect(
      provider.downloadImmutable({
        generation,
        objectId: object.objectId,
        expectedStoredSha256: sha,
        destinationRef: createLocalObjectRef('syncobj:requested.a'),
        transferId: 'transfer-a',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });
  it('bounds discovery pagination and checks ownership after each page', async () => {
    const { provider, request, changeAccount } = setup();
    const input = {
      accountSubject: binding.accountRef!,
      credentialSecretRef: 'hosted.session',
      signal: new AbortController().signal,
    };
    request.mockResolvedValue({ snapshots: [], nextPageToken: 'same-page' });
    await expect(provider.discover(input)).rejects.toMatchObject({ code: 'REMOTE_STORE_CORRUPT' });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockImplementationOnce(async () => {
      changeAccount();
      return { snapshots: [] };
    });
    await expect(provider.discover(input)).rejects.toMatchObject({ code: 'INVALID_GENERATION' });
  });
  it('requests removal changes and accepts the strict removal shape', async () => {
    const { provider, request } = setup();
    const generation = await provider.openGeneration(binding);
    request.mockResolvedValueOnce({
      changes: [{ kind: 'removed', objectId: 'object-a', logicalKeyId: object.logicalKeyId }],
      newCursor: 'cursor-b',
    });
    const page = await provider.listChanges({ generation, cursor: createProviderCursor('cursor-a') });
    expect(page.changes).toEqual([
      { kind: 'removed', objectId: 'object-a', logicalKeyId: object.logicalKeyId },
    ]);
    expect(request.mock.lastCall?.[0].path).toBe(
      '/api/sync/v1/project-v1/generations/generation-a/changes?cursor=cursor-a&includeRemovals=1',
    );
  });
  it('posts a prune request and validates the receipt against the request', async () => {
    const { provider, request } = setup();
    const generation = await provider.openGeneration(binding);
    const input = {
      generation,
      basisCursor: createProviderCursor('cursor-a'),
      retain: [createProviderObjectId('marker-1'), createProviderObjectId('marker-2')],
      remove: [createProviderObjectId('segment-1'), createProviderObjectId('segment-2')],
      signal: new AbortController().signal,
    };
    request.mockResolvedValueOnce({
      status: 'pruned',
      removed: ['segment-1'],
      deferred: ['segment-2'],
      cursor: 'cursor-c',
    });
    await expect(provider.pruneObjects(input)).resolves.toEqual({
      removed: ['segment-1'],
      deferred: ['segment-2'],
    });
    expect(request.mock.lastCall?.[0]).toEqual({
      path: '/api/sync/v1/project-v1/generations/generation-a/prune',
      method: 'POST',
      signal: input.signal,
      jsonBody: { basisCursor: 'cursor-a', retain: ['marker-1', 'marker-2'], remove: ['segment-1', 'segment-2'] },
    });
    request.mockResolvedValueOnce({ status: 'pruned', removed: ['marker-1'], deferred: [] });
    await expect(provider.pruneObjects(input)).rejects.toMatchObject({ code: 'REMOTE_STORE_CORRUPT' });
    const chat = new HostedObjectLogProvider({ accountSubject: () => 'account-a', request }, 'agent-chat-v1');
    await expect(chat.pruneObjects(input)).rejects.toMatchObject({ code: 'PRUNE_REJECTED' });
  });
});
