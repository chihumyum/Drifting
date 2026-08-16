import {
  sha256Bytes,
  type LocalObjectRef,
  type RemoteObject,
  type SyncObjectKind,
} from '../protocol';
import type { NativeSyncObjectCodec } from '../native-object-codec';
import type {
  DecodedInboundSyncObject,
  PreparedOutboundSyncObject,
  SyncEngineObjectCodec,
} from './object-codec';

export const MAX_SYNC_ENGINE_PROTOCOL_BYTES = 512 * 1024 * 1024;

function assertProtocolObjectKind(value: SyncObjectKind): void {
  if (value === 'blob') {
    throw new Error('asset blobs must stay on the native streaming path');
  }
}

/**
 * Native plaintext codec used by trusted-cloud production providers.
 *
 * Native owns root-confined files and bounded IPC. Renderer owns deterministic
 * logical identities and independently verifies size plus SHA-256 before any
 * protocol bytes are decoded.
 */
export class NativePlaintextSyncEngineObjectCodec implements SyncEngineObjectCodec {
  private readonly maxProtocolBytes: number;

  constructor(
    private readonly native: NativeSyncObjectCodec,
    options: { readonly maxProtocolBytes?: number } = {},
  ) {
    this.maxProtocolBytes = options.maxProtocolBytes ?? MAX_SYNC_ENGINE_PROTOCOL_BYTES;
    if (
      !Number.isSafeInteger(this.maxProtocolBytes) ||
      this.maxProtocolBytes < 1 ||
      this.maxProtocolBytes > MAX_SYNC_ENGINE_PROTOCOL_BYTES
    ) {
      throw new RangeError(
        `maxProtocolBytes must be between 1 and ${MAX_SYNC_ENGINE_PROTOCOL_BYTES}`,
      );
    }
  }

  async prepareOutbound(input: {
    syncGenerationId: string;
    objectKind: SyncObjectKind;
    canonicalLogicalKey: string;
    protocolBytes: Uint8Array;
  }): Promise<PreparedOutboundSyncObject> {
    assertProtocolObjectKind(input.objectKind);
    if (input.protocolBytes.byteLength > this.maxProtocolBytes) {
      throw new Error('outbound protocol object exceeds the renderer decode limit');
    }
    const bytes = new Uint8Array(input.protocolBytes);
    const [logicalKeyId, contentSha256] = await Promise.all([
      sha256Bytes(new TextEncoder().encode(input.canonicalLogicalKey)),
      sha256Bytes(bytes),
    ]);
    const staged = await this.native.stageProtocolBytes(bytes);
    if (
      staged.sizeBytes !== bytes.byteLength ||
      staged.storedSha256 !== contentSha256
    ) {
      await this.native.discardLocal?.(staged.sourceRef).catch(() => undefined);
      throw new Error('native protocol staging changed the immutable content identity');
    }
    return {
      sourceRef: staged.sourceRef,
      logicalKeyId,
      storedSha256: contentSha256,
      contentSha256,
      sizeBytes: staged.sizeBytes,
      codec: 'cbor-rfc8949',
    };
  }

  async allocateInbound(_input: {
    syncGenerationId: string;
    remoteObject: RemoteObject;
  }): Promise<LocalObjectRef> {
    return (await this.native.stageProtocolBytes(new Uint8Array())).sourceRef;
  }

  async decodeInbound(input: {
    syncGenerationId: string;
    expectedLogicalKeyId: string;
    remoteObject: RemoteObject;
    sourceRef: LocalObjectRef;
  }): Promise<DecodedInboundSyncObject> {
    assertProtocolObjectKind(input.remoteObject.objectKind);
    if (input.remoteObject.logicalKeyId !== input.expectedLogicalKeyId) {
      throw new Error('remote logical key ID does not match durable discovery metadata');
    }
    if (input.remoteObject.sizeBytes > this.maxProtocolBytes) {
      throw new Error('inbound protocol object exceeds the renderer decode limit');
    }
    const protocolBytes = await this.native.readProtocolBytes(
      input.sourceRef,
      this.maxProtocolBytes,
    );
    if (protocolBytes.byteLength !== input.remoteObject.sizeBytes) {
      throw new Error('plaintext protocol object size does not match discovery metadata');
    }
    const contentSha256 = await sha256Bytes(protocolBytes);
    if (contentSha256 !== input.remoteObject.storedSha256) {
      throw new Error('plaintext protocol object hash does not match discovery metadata');
    }
    return {
      protocolBytes: new Uint8Array(protocolBytes),
      contentSha256,
      objectKind: input.remoteObject.objectKind,
    };
  }
}
