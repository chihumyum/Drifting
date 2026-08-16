import { describe, expect, it, vi } from 'vitest';

import {
  createLocalObjectRef,
  createProviderCursor,
  createProviderObjectId,
  createProviderGenerationRef,
  type ProviderBinding,
  type Sha256,
} from '../../protocol';
import { GoogleDriveObjectLogProvider } from './provider';
import {
  createGoogleDriveTransportGenerationRef,
  type GoogleDriveObjectTransportPort,
} from './transport';

const SHA = `sha256:${'a'.repeat(64)}` as Sha256;
const LOGICAL_ID = `sha256:${'b'.repeat(64)}`;
const binding: ProviderBinding = {
  bindingId: 'binding-a',
  syncGenerationId: 'sync-generation-a',
  accountRef: 'google-subject-a',
  secretRef: 'sync.google-drive.credentials.a',
  authorityGeneration: 2,
};

function transport(): GoogleDriveObjectTransportPort {
  const object = {
    objectId: createProviderObjectId('drive-file-a'),
    objectKind: 'segment' as const,
    logicalKeyId: LOGICAL_ID,
    storedSha256: SHA,
    sizeBytes: 3,
  };
  return {
    openGeneration: vi.fn(async (input) => ({
      generationRef: createGoogleDriveTransportGenerationRef('syncdrive:generation.a'),
      syncGenerationId: input.syncGenerationId,
    })),
    captureStartCursor: vi.fn(async () => createProviderCursor('drive-cursor-a')),
    listInventory: vi.fn(async () => ({ objects: [object] })),
    listChanges: vi.fn(async () => ({
      changes: [{ kind: 'present' as const, object }],
      newCursor: createProviderCursor('drive-cursor-b'),
    })),
    statImmutable: vi.fn(async () => object),
    uploadImmutable: vi.fn(async () => ({ status: 'created' as const, object })),
    downloadVerifiedImmutable: vi.fn(async (input) => ({
      destinationRef: input.destinationRef,
      storedSha256: input.expectedStoredSha256,
      sizeBytes: 3,
    })),
  };
}

describe('GoogleDriveObjectLogProvider', () => {
  it('keeps credentials and immutable file transport behind the native boundary', async () => {
    const native = transport();
    const provider = new GoogleDriveObjectLogProvider(native);
    const generation = await provider.openGeneration(binding);
    const sourceRef = createLocalObjectRef('syncobj:staged.a');
    const result = await provider.uploadImmutable({
      generation,
      sourceRef,
      objectKind: 'segment',
      logicalKeyId: LOGICAL_ID,
      storedSha256: SHA,
      sizeBytes: 3,
      transferId: 'transfer-a',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('created');
    expect(native.openGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialSecretRef: binding.secretRef,
        accountSubject: binding.accountRef,
      }),
    );
    expect(native.uploadImmutable).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef, transferId: 'transfer-a' }),
    );
  });

  it('never accepts a renderer path or a binding without native credentials', async () => {
    const provider = new GoogleDriveObjectLogProvider(transport());
    await expect(provider.openGeneration({ ...binding, secretRef: null })).rejects.toThrow(
      'credential secret reference',
    );
    expect(() => createLocalObjectRef('/tmp/plaintext')).toThrow();
  });

  it('fails closed when native upload metadata does not match the immutable request', async () => {
    const native = transport();
    native.uploadImmutable = vi.fn(async () => ({
      status: 'created' as const,
      object: {
        objectId: createProviderObjectId('drive-file-forged'),
        objectKind: 'blob' as const,
        logicalKeyId: LOGICAL_ID,
        storedSha256: SHA,
        sizeBytes: 3,
      },
    }));
    const provider = new GoogleDriveObjectLogProvider(native);
    const generation = await provider.openGeneration(binding);
    await expect(
      provider.uploadImmutable({
        generation,
        sourceRef: createLocalObjectRef('syncobj:staged.a'),
        objectKind: 'segment',
        logicalKeyId: LOGICAL_ID,
        storedSha256: SHA,
        sizeBytes: 3,
        transferId: 'transfer-a',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('inconsistent');
  });

  it('rejects a forged provider generation reference before calling native', async () => {
    const native = transport();
    const provider = new GoogleDriveObjectLogProvider(native);
    const generation = await provider.openGeneration(binding);
    await expect(
      provider.captureStartCursor({
        ...generation,
        generationRef: createProviderGenerationRef('google-drive-generation:forged'),
      }),
    ).rejects.toThrow('generationRef is invalid');
  });
});
