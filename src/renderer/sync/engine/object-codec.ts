import type {
  LocalObjectRef,
  RemoteObject,
  Sha256,
  SyncObjectKind,
} from '../protocol';

export interface PreparedOutboundSyncObject {
  readonly sourceRef: LocalObjectRef;
  readonly logicalKeyId: string;
  readonly storedSha256: Sha256;
  readonly contentSha256: Sha256;
  readonly sizeBytes: number;
  readonly codec: 'cbor-rfc8949';
}

export interface DecodedInboundSyncObject {
  readonly protocolBytes: Uint8Array;
  readonly contentSha256: Sha256;
  readonly objectKind: SyncObjectKind;
}

/**
 * Durable object preparation boundary used by the coordinator.
 *
 * Product implementations keep filesystem paths native.
 * The renderer receives only bounded protocol plaintext after an inbound object
 * has passed stored-hash, size and logical-key verification.
 */
export interface SyncEngineObjectCodec {
  prepareOutbound(input: {
    syncGenerationId: string;
    objectKind: SyncObjectKind;
    canonicalLogicalKey: string;
    protocolBytes: Uint8Array;
  }): Promise<PreparedOutboundSyncObject>;

  allocateInbound(input: {
    syncGenerationId: string;
    remoteObject: RemoteObject;
  }): Promise<LocalObjectRef>;

  decodeInbound(input: {
    syncGenerationId: string;
    expectedLogicalKeyId: string;
    remoteObject: RemoteObject;
    sourceRef: LocalObjectRef;
  }): Promise<DecodedInboundSyncObject>;
}
