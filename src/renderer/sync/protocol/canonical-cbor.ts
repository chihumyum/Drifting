import { decode, encode, rfc8949EncodeOptions } from 'cborg';

import {
  assertCanonicalCborValue,
  type CanonicalCborValue,
  type Sha256,
} from './primitives';

export type CborQuarantineReason =
  | 'malformed-cbor'
  | 'non-canonical-cbor'
  | 'unsupported-cbor-value';

export interface CborQuarantineResult {
  ok: false;
  disposition: 'quarantine';
  reason: CborQuarantineReason;
  message: string;
  rawBytes: Uint8Array;
}

export type CanonicalCborDecodeResult =
  | { ok: true; value: CanonicalCborValue; canonicalBytes: Uint8Array }
  | CborQuarantineResult;

const STRICT_DECODE_OPTIONS = Object.freeze({
  strict: true,
  allowIndefinite: false,
  allowUndefined: false,
  coerceUndefinedToNull: false,
  allowInfinity: false,
  allowNaN: false,
  allowBigInt: false,
  useMaps: true,
  rejectDuplicateMapKeys: true,
});

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodedMapToObject(value: unknown, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (active.has(value)) throw new TypeError('decoded CBOR contains a cycle');
  active.add(value);

  if (Array.isArray(value)) {
    const array = value.map((entry) => decodedMapToObject(entry, active));
    active.delete(value);
    return array;
  }

  if (!(value instanceof Map)) {
    active.delete(value);
    throw new TypeError('decoded CBOR contains an unsupported object');
  }

  const object: Record<string, unknown> = {};
  for (const [key, entry] of value.entries()) {
    if (typeof key !== 'string') {
      active.delete(value);
      throw new TypeError('decoded CBOR map key is not a string');
    }
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: decodedMapToObject(entry, active),
    });
  }
  active.delete(value);
  return object;
}

export function encodeCanonicalCbor(value: CanonicalCborValue): Uint8Array {
  assertCanonicalCborValue(value);
  return new Uint8Array(encode(value, rfc8949EncodeOptions));
}

export function decodeCanonicalCbor(bytes: Uint8Array): CanonicalCborDecodeResult {
  const rawBytes = new Uint8Array(bytes);
  let decoded: unknown;
  try {
    decoded = decodedMapToObject(decode(rawBytes, STRICT_DECODE_OPTIONS));
  } catch (error) {
    return {
      ok: false,
      disposition: 'quarantine',
      reason: 'malformed-cbor',
      message: error instanceof Error ? error.message : String(error),
      rawBytes,
    };
  }

  try {
    assertCanonicalCborValue(decoded);
  } catch (error) {
    return {
      ok: false,
      disposition: 'quarantine',
      reason: 'unsupported-cbor-value',
      message: error instanceof Error ? error.message : String(error),
      rawBytes,
    };
  }

  const canonicalBytes = encodeCanonicalCbor(decoded);
  if (!bytesEqual(rawBytes, canonicalBytes)) {
    return {
      ok: false,
      disposition: 'quarantine',
      reason: 'non-canonical-cbor',
      message: 'CBOR bytes do not use the RFC 8949 deterministic encoding',
      rawBytes,
    };
  }

  return { ok: true, value: decoded, canonicalBytes };
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(hex)) {
    throw new TypeError('hex must contain lowercase, complete byte pairs');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Sha256> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function hashCanonicalCbor(value: CanonicalCborValue): Promise<Sha256> {
  return sha256Bytes(encodeCanonicalCbor(value));
}
