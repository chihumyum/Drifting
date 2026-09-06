import { describe, expect, it, vi } from 'vitest';

import type { GoogleDrivePlatformApi } from '../../../platform';
import {
  createLocalObjectRef,
  createProviderCursor,
  createProviderObjectId,
  type Sha256,
} from '../../protocol';
import { TauriGoogleDriveObjectTransport } from './tauri-transport';
import { createGoogleDriveTransportGenerationRef } from './transport';

const LOGICAL = `sha256:${'a'.repeat(64)}`;
const SHA = `sha256:${'b'.repeat(64)}` as Sha256;

function nativeApi(): GoogleDrivePlatformApi {
  const object = {
    objectId: 'drive-file-a',
    objectKind: 'segment' as const,
    logicalKeyId: LOGICAL,
    storedSha256: SHA,
    sizeBytes: 42,
  };
  return {
    connectAccount: vi.fn(async () => ({
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      accountSubject: 'google-subject',
    })),
    claimAccount: vi.fn(async (credentialSecretRef, accountSubject) => ({
      credentialSecretRef,
      accountSubject,
    })),
    reauthorizeAccount: vi.fn(async () => ({
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      accountSubject: 'google-subject',
    })),
    revokeAccount: vi.fn(async () => undefined),
    discoverProjectSnapshots: vi.fn(async () => ({ snapshots: [] })),
    openGeneration: vi.fn(async (input) => ({
      generationRef: 'syncdrive:opaque-sync-generation-ref',
      syncGenerationId: input.syncGenerationId,
    })),
    captureStartCursor: vi.fn(async () => 'cursor-a'),
    listInventory: vi.fn(async () => ({ objects: [object], nextPageToken: 'page-a' })),
    listChanges: vi.fn(async () => ({
      changes: [
        { kind: 'present' as const, object },
        { kind: 'removed' as const, objectId: 'drive-file-b', logicalKeyId: null },
      ],
      newCursor: 'cursor-b',
    })),
    statImmutable: vi.fn(async () => object),
    uploadImmutable: vi.fn(async () => ({ status: 'created' as const, object })),
    downloadVerifiedImmutable: vi.fn(async (input) => ({
      destinationRef: input.destinationRef,
      storedSha256: input.expectedStoredSha256,
      sizeBytes: 42,
    })),
  };
}

describe('TauriGoogleDriveObjectTransport', () => {
  it('opens an explicit Agent namespace while preserving the released project call shape', async () => {
    const native = nativeApi();
    const input = { credentialSecretRef: 'opaque', accountSubject: 'subject', bindingId: 'binding', syncGenerationId: 'generation', authorityGeneration: 1 };
    await new TauriGoogleDriveObjectTransport(native).openGeneration(input);
    expect(native.openGeneration).toHaveBeenLastCalledWith(input);
    await new TauriGoogleDriveObjectTransport(native, 'agent-chat').openGeneration(input);
    expect(native.openGeneration).toHaveBeenLastCalledWith({ ...input, namespace: 'agent-chat' });
  });

  it('projects only opaque references and immutable metadata across the native boundary', async () => {
    const native = nativeApi();
    const transport = new TauriGoogleDriveObjectTransport(native);
    const generation = await transport.openGeneration({
      credentialSecretRef: 'sync.google-drive.credentials.opaque',
      accountSubject: 'google-subject',
      bindingId: 'binding-a',
      syncGenerationId: 'sync-generation-a',
      authorityGeneration: 1,
    });
    expect(generation).toEqual({
      generationRef: createGoogleDriveTransportGenerationRef('syncdrive:opaque-sync-generation-ref'),
      syncGenerationId: 'sync-generation-a',
    });
    await expect(
      transport.captureStartCursor(generation),
    ).resolves.toBe(createProviderCursor('cursor-a'));
    await expect(transport.listInventory({ generation })).resolves.toMatchObject({
      objects: [{ objectId: createProviderObjectId('drive-file-a'), logicalKeyId: LOGICAL }],
    });
    await expect(
      transport.uploadImmutable({
        generation,
        sourceRef: createLocalObjectRef('syncobj:staged-object'),
        objectKind: 'segment',
        logicalKeyId: LOGICAL,
        storedSha256: SHA,
        sizeBytes: 42,
        transferId: 'transfer-a',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: 'created' });

    expect(native.uploadImmutable).toHaveBeenCalledWith({
      generationRef: 'syncdrive:opaque-sync-generation-ref',
      sourceRef: 'syncobj:staged-object',
      objectKind: 'segment',
      logicalKeyId: LOGICAL,
      storedSha256: SHA,
      sizeBytes: 42,
      transferId: 'transfer-a',
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(vi.mocked(native.uploadImmutable).mock.calls)).not.toMatch(
      /accessToken|refreshToken|sessionUri|filePath|\/Users\//u,
    );
  });
});
