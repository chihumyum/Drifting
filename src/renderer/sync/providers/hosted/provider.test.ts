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
});
