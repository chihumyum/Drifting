import { isWellFormedUtf16, type Hlc } from './primitives';

export interface SyncTotalOrderV1 {
  hlc: Hlc;
  writerId: string;
  writerEpoch: string;
  deviceSeq: number;
  mutationIndex: number;
}

export type Comparison = -1 | 0 | 1;

function compareNumber(left: number, right: number): Comparison {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): Comparison {
  const sharedLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return compareNumber(left.byteLength, right.byteLength);
}

function assertWellFormedString(value: string): void {
  if (!isWellFormedUtf16(value)) {
    throw new TypeError('$: string contains an unpaired UTF-16 surrogate');
  }
}

/** A high surrogate starts a code point above every BMP code unit. */
function codePointRank(codeUnit: number): number {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff ? codeUnit + 0x10000 : codeUnit;
}

/**
 * UTF-8 byte order equals Unicode code point order, so well-formed UTF-16 is
 * compared in place. Reducer replay sorts with this comparator, and encoding
 * two byte arrays per comparison dominated its time and garbage.
 */
export function compareUtf8Bytewise(left: string, right: string): Comparison {
  assertWellFormedString(left);
  assertWellFormedString(right);
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    // After an equal high surrogate both strings continue with low surrogates.
    if (leftUnit !== rightUnit) return compareNumber(codePointRank(leftUnit), codePointRank(rightUnit));
  }
  return compareNumber(left.length, right.length);
}

export function compareHlc(left: Hlc, right: Hlc): Comparison {
  return compareNumber(left.wallMs, right.wallMs) || compareNumber(left.counter, right.counter);
}

export function compareSyncTotalOrder(
  left: SyncTotalOrderV1,
  right: SyncTotalOrderV1,
): Comparison {
  return (
    compareHlc(left.hlc, right.hlc) ||
    compareUtf8Bytewise(left.writerId, right.writerId) ||
    compareUtf8Bytewise(left.writerEpoch, right.writerEpoch) ||
    compareNumber(left.deviceSeq, right.deviceSeq) ||
    compareNumber(left.mutationIndex, right.mutationIndex)
  );
}

function incrementCounter(counter: number): number {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('HLC counter cannot be incremented safely');
  }
  return counter + 1;
}

function assertWallClock(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('HLC wall clock must be a non-negative safe integer');
  }
}

export function nextLocalHlc(previous: Hlc, nowMs: number): Hlc {
  assertWallClock(nowMs);
  if (nowMs > previous.wallMs) return { wallMs: nowMs, counter: 0 };
  return { wallMs: previous.wallMs, counter: incrementCounter(previous.counter) };
}

export function observeRemoteHlc(local: Hlc, remote: Hlc, nowMs: number): Hlc {
  assertWallClock(nowMs);
  const wallMs = Math.max(nowMs, local.wallMs, remote.wallMs);
  if (wallMs === local.wallMs && wallMs === remote.wallMs) {
    return { wallMs, counter: incrementCounter(Math.max(local.counter, remote.counter)) };
  }
  if (wallMs === local.wallMs) {
    return { wallMs, counter: incrementCounter(local.counter) };
  }
  if (wallMs === remote.wallMs) {
    return { wallMs, counter: incrementCounter(remote.counter) };
  }
  return { wallMs, counter: 0 };
}
