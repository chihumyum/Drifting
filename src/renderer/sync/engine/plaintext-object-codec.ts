import {
  createLocalObjectRef,
  sha256Bytes,
  type LocalObjectRef,
  type RemoteObject,
} from '../protocol';
import type {
  DecodedInboundSyncObject,
  PreparedOutboundSyncObject,
  SyncEngineObjectCodec,
} from './object-codec';

export interface PlaintextSyncObjectPort {
  allocate(input: {
    syncGenerationId: string;
    purpose: 'outbound' | 'inbound';
    logicalKeyId: string;
  }): Promise<LocalObjectRef> | LocalObjectRef;
  read(ref: LocalObjectRef, signal: AbortSignal): Promise<Uint8Array>;
  write(ref: LocalObjectRef, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

function hex(hash: string): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(hash);
  if (!match) throw new TypeError('SHA-256 must use sha256:<lowercase hex>');
  return match[1];
}

/**
 * Development/reference codec for Memory and LocalFolder providers.
 *
 * It deliberately has no secret handling. Production Drive composition uses
 * the native root-confined staging variant instead of renderer-owned files.
 */
export class PlaintextSyncEngineObjectCodec implements SyncEngineObjectCodec {
  constructor(private readonly objects: PlaintextSyncObjectPort) {}

  async prepareOutbound(input: {
    syncGenerationId: string;
    objectKind: RemoteObject['objectKind'];
    canonicalLogicalKey: string;
    protocolBytes: Uint8Array;
  }): Promise<PreparedOutboundSyncObject> {
    const logicalHash = await sha256Bytes(new TextEncoder().encode(input.canonicalLogicalKey));
    const logicalKeyId = `sha256:${hex(logicalHash)}`;
    const sourceRef = createLocalObjectRef(await this.objects.allocate({
      syncGenerationId: input.syncGenerationId,
      purpose: 'outbound',
      logicalKeyId,
    }));
    const bytes = new Uint8Array(input.protocolBytes);
    await this.objects.write(sourceRef, bytes, new AbortController().signal);
    const contentSha256 = await sha256Bytes(bytes);
    return {
      sourceRef,
      logicalKeyId,
      storedSha256: contentSha256,
      contentSha256,
      sizeBytes: bytes.byteLength,
      codec: 'cbor-rfc8949',
    };
  }

  async allocateInbound(input: {
    syncGenerationId: string;
    remoteObject: RemoteObject;
  }): Promise<LocalObjectRef> {
    return createLocalObjectRef(await this.objects.allocate({
      syncGenerationId: input.syncGenerationId,
      purpose: 'inbound',
      logicalKeyId: input.remoteObject.logicalKeyId,
    }));
  }

  async decodeInbound(input: {
    syncGenerationId: string;
    expectedLogicalKeyId: string;
    remoteObject: RemoteObject;
    sourceRef: LocalObjectRef;
  }): Promise<DecodedInboundSyncObject> {
    if (input.remoteObject.logicalKeyId !== input.expectedLogicalKeyId) {
      throw new Error('plaintext object logical key does not match discovery metadata');
    }
    const bytes = await this.objects.read(input.sourceRef, new AbortController().signal);
    if (bytes.byteLength !== input.remoteObject.sizeBytes) {
      throw new Error('plaintext object size does not match discovery metadata');
    }
    const contentSha256 = await sha256Bytes(bytes);
    if (contentSha256 !== input.remoteObject.storedSha256) {
      throw new Error('plaintext object hash does not match discovery metadata');
    }
    return {
      protocolBytes: new Uint8Array(bytes),
      contentSha256,
      objectKind: input.remoteObject.objectKind,
    };
  }
}
