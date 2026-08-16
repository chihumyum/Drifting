import { platform } from '../platform';
import type {
  NativeBytes,
  SyncObjectStorePlatformApi,
} from '../platform';
import {
  createLocalObjectRef,
  type LocalObjectRef,
  type Sha256,
} from './protocol';

export interface StagedSyncObject {
  readonly sourceRef: LocalObjectRef;
  readonly sizeBytes: number;
  readonly storedSha256: Sha256;
}

export interface NativeSyncObjectCodec {
  stageProtocolBytes(bytes: Uint8Array): Promise<StagedSyncObject>;
  readProtocolBytes(sourceRef: LocalObjectRef, maxBytes: number): Promise<Uint8Array>;
  stageAssetSource(input: {
    projectId: string;
    assetId: string;
    ext: string;
  }): Promise<StagedSyncObject>;
  discardLocal?(sourceRef: LocalObjectRef): Promise<void>;
}

function bytes(value: NativeBytes): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (
    !Array.isArray(value) ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new TypeError('native sync object bytes are malformed');
  }
  return Uint8Array.from(value);
}

function assertSafeSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('native sync object size is malformed');
  }
}

function sha256(value: string): Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('native sync object SHA-256 is malformed');
  }
  return value as Sha256;
}

function staged(value: {
  sourceRef: string;
  sizeBytes: number;
  storedSha256: string;
}): StagedSyncObject {
  assertSafeSize(value.sizeBytes);
  return Object.freeze({
    sourceRef: createLocalObjectRef(value.sourceRef),
    sizeBytes: value.sizeBytes,
    storedSha256: sha256(value.storedSha256),
  });
}

export function createNativeSyncObjectCodec(
  native: SyncObjectStorePlatformApi = platform.syncObjectStore,
): NativeSyncObjectCodec {
  return {
    async stageProtocolBytes(input) {
      return staged(await native.stageBytes(new Uint8Array(input)));
    },

    async readProtocolBytes(sourceRef, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new RangeError('native sync protocol read limit must be a positive safe integer');
      }
      return bytes(await native.readProtocolBytes(sourceRef, maxBytes));
    },

    async stageAssetSource(input) {
      return staged(await native.stageAssetSource(input.projectId, input.assetId, input.ext));
    },

    ...(native.discardLocal
      ? { discardLocal: (sourceRef: LocalObjectRef) => native.discardLocal!(sourceRef) }
      : {}),

  };
}

export const nativeSyncObjectCodec = createNativeSyncObjectCodec();
