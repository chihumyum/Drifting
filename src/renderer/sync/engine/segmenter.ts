import {
  compareUtf8Bytewise,
  encodeSegmentV1,
  requiredBlobIdsForChangeSet,
  sha256Bytes,
  type SegmentV1,
  type Sha256,
  type SyncChangeSetV1,
} from '../protocol';

export const SEGMENT_MAX_CHANGE_SETS = 256;
export const SEGMENT_MAX_BYTES = 512 * 1024;
export const SEGMENT_MAX_AGE_MS = 2_000;

export type SegmentFlushReason = 'manual' | 'lifecycle' | 'age';

export interface SegmenterIdentity {
  readonly projectId: string;
  readonly projectSyncId: string;
  readonly syncGenerationId: string;
  readonly writerId: string;
  readonly writerEpoch: string;
}

export interface PendingSegmentChangeSet {
  readonly changeSet: SyncChangeSetV1;
  readonly enqueuedAtMs: number;
}

export interface SealedSegment {
  readonly segment: SegmentV1;
  readonly encodedBytes: Uint8Array;
  readonly segmentSha256: Sha256;
  readonly oversized: boolean;
  readonly sealedBecause: 'count' | 'size' | SegmentFlushReason;
}

export type SegmentRangeRegistration =
  | { readonly disposition: 'accepted' | 'duplicate'; readonly sha256: Sha256 }
  | {
      readonly disposition: 'fork';
      readonly existingSha256: Sha256;
      readonly incomingSha256: Sha256;
    };

/** Pure ingest guard: a writer/range identity may name exactly one byte hash. */
export class SegmentRangeForkDetector {
  private readonly hashes = new Map<string, Sha256>();

  register(input: {
    readonly syncGenerationId: string;
    readonly writerId: string;
    readonly writerEpoch: string;
    readonly firstSeq: number;
    readonly lastSeq: number;
    readonly sha256: Sha256;
  }): SegmentRangeRegistration {
    const key = JSON.stringify([
      input.syncGenerationId,
      input.writerId,
      input.writerEpoch,
      input.firstSeq,
      input.lastSeq,
    ]);
    const existing = this.hashes.get(key);
    if (!existing) {
      this.hashes.set(key, input.sha256);
      return Object.freeze({ disposition: 'accepted', sha256: input.sha256 });
    }
    return existing === input.sha256
      ? Object.freeze({ disposition: 'duplicate', sha256: existing })
      : Object.freeze({
          disposition: 'fork',
          existingSha256: existing,
          incomingSha256: input.sha256,
        });
  }
}

interface BufferedChangeSet {
  readonly changeSet: SyncChangeSetV1;
  readonly requiredBlobIds: readonly string[];
  readonly enqueuedAtMs: number;
}

function assertSafeTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('segment enqueuedAtMs must be a non-negative safe integer');
  }
}

function sortedUniqueBlobIds(buffer: readonly BufferedChangeSet[]): string[] {
  const ids = new Set<string>();
  for (const entry of buffer) {
    for (const blobId of entry.requiredBlobIds) {
      if (!blobId) throw new TypeError('required blob ID must not be empty');
      ids.add(blobId);
    }
  }
  return [...ids].sort(compareUtf8Bytewise);
}

function assertIdentity(identity: SegmenterIdentity, changeSet: SyncChangeSetV1): void {
  for (const field of [
    'projectId',
    'projectSyncId',
    'syncGenerationId',
    'writerId',
    'writerEpoch',
  ] as const) {
    if (identity[field] !== changeSet[field]) {
      throw new Error(`change set ${field} does not belong to this segment writer lane`);
    }
  }
}

/**
 * Single-writer-epoch segment accumulator.
 *
 * The caller serializes access per SyncGeneration. The accumulator measures the final
 * deterministic CBOR bytes, never splits a change set, and advances its hash
 * chain only after a segment has been sealed successfully.
 */
export class ChangeSetSegmenter {
  private readonly identity: SegmenterIdentity;
  private readonly maxChangeSets: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private buffer: BufferedChangeSet[] = [];
  private nextDeviceSeq: number;
  private previousSegmentHash: Sha256 | null;

  constructor(input: {
    identity: SegmenterIdentity;
    nextDeviceSeq: number;
    previousSegmentHash?: Sha256 | null;
    maxChangeSets?: number;
    maxBytes?: number;
    maxAgeMs?: number;
  }) {
    if (!Number.isSafeInteger(input.nextDeviceSeq) || input.nextDeviceSeq < 1) {
      throw new RangeError('nextDeviceSeq must be a positive safe integer');
    }
    this.identity = { ...input.identity };
    this.nextDeviceSeq = input.nextDeviceSeq;
    this.previousSegmentHash = input.previousSegmentHash ?? null;
    this.maxChangeSets = input.maxChangeSets ?? SEGMENT_MAX_CHANGE_SETS;
    this.maxBytes = input.maxBytes ?? SEGMENT_MAX_BYTES;
    this.maxAgeMs = input.maxAgeMs ?? SEGMENT_MAX_AGE_MS;
    if (
      !Number.isSafeInteger(this.maxChangeSets) ||
      this.maxChangeSets < 1 ||
      this.maxChangeSets > SEGMENT_MAX_CHANGE_SETS
    ) {
      throw new RangeError(`maxChangeSets must be between 1 and ${SEGMENT_MAX_CHANGE_SETS}`);
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1) {
      throw new RangeError('maxAgeMs must be a positive safe integer');
    }
  }

  get pendingCount(): number {
    return this.buffer.length;
  }

  get expectedDeviceSeq(): number {
    return this.nextDeviceSeq;
  }

  async push(input: PendingSegmentChangeSet): Promise<readonly SealedSegment[]> {
    assertSafeTimestamp(input.enqueuedAtMs);
    assertIdentity(this.identity, input.changeSet);
    if (input.changeSet.deviceSeq !== this.nextDeviceSeq) {
      throw new Error(
        `non-contiguous change set sequence: expected ${this.nextDeviceSeq}, received ${input.changeSet.deviceSeq}`,
      );
    }

    const next: BufferedChangeSet = {
      changeSet: input.changeSet,
      requiredBlobIds: requiredBlobIdsForChangeSet(input.changeSet),
      enqueuedAtMs: input.enqueuedAtMs,
    };
    const sealed: SealedSegment[] = [];
    // Validate the full protocol candidate before any buffer/sequence mutation.
    const candidateBytes = encodeSegmentV1(this.createSegment([...this.buffer, next]));

    if (this.buffer.length > 0) {
      if (candidateBytes.byteLength > this.maxBytes) {
        sealed.push(await this.seal('size'));
      }
    }

    this.buffer.push(next);
    this.nextDeviceSeq += 1;

    if (this.buffer.length >= this.maxChangeSets) {
      sealed.push(await this.seal('count'));
    } else if (encodeSegmentV1(this.createSegment(this.buffer)).byteLength >= this.maxBytes) {
      sealed.push(await this.seal('size'));
    }
    return sealed;
  }

  async sealExpired(nowMs: number): Promise<SealedSegment | null> {
    assertSafeTimestamp(nowMs);
    const oldest = this.buffer[0];
    if (!oldest || nowMs - oldest.enqueuedAtMs < this.maxAgeMs) return null;
    return this.seal('age');
  }

  async flush(reason: Extract<SegmentFlushReason, 'manual' | 'lifecycle'>): Promise<SealedSegment | null> {
    return this.buffer.length === 0 ? null : this.seal(reason);
  }

  private createSegment(entries: readonly BufferedChangeSet[]): SegmentV1 {
    const first = entries[0];
    const last = entries[entries.length - 1];
    if (!first || !last) throw new Error('cannot create an empty segment');
    return {
      protocol: 'drifting.sync.segment',
      protocolVersion: 1,
      payloadVersion: 1,
      header: {
        codec: 'cbor-rfc8949',
        compression: 'none',
        ...this.identity,
        firstSeq: first.changeSet.deviceSeq,
        lastSeq: last.changeSet.deviceSeq,
        opCount: entries.length,
        previousSegmentHash: this.previousSegmentHash,
        requiredBlobIds: sortedUniqueBlobIds(entries),
      },
      changeSets: entries.map((entry) => entry.changeSet),
    };
  }

  private async seal(sealedBecause: SealedSegment['sealedBecause']): Promise<SealedSegment> {
    const segment = this.createSegment(this.buffer);
    const encodedBytes = encodeSegmentV1(segment);
    const segmentSha256 = await sha256Bytes(encodedBytes);
    const sealed: SealedSegment = Object.freeze({
      segment,
      encodedBytes,
      segmentSha256,
      oversized: encodedBytes.byteLength > this.maxBytes,
      sealedBecause,
    });
    this.previousSegmentHash = segmentSha256;
    this.buffer = [];
    return sealed;
  }
}
