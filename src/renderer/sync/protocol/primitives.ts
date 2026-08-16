import { Type, type Static } from '@sinclair/typebox';

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_PAYLOAD_VERSION = 1 as const;
export const SYNC_CBOR_CODEC = 'cbor-rfc8949' as const;
export const SYNC_COMPRESSION = 'none' as const;

export const SAFE_UNSIGNED_INTEGER_SCHEMA = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const POSITIVE_SAFE_INTEGER_SCHEMA = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const OPAQUE_ID_SCHEMA = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
});

export const PROTOCOL_TOKEN_SCHEMA = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
});

export const DOMAIN_KIND_SCHEMA = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z][a-z0-9._-]*$',
});

export const SHA256_SCHEMA = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });

export const HLC_SCHEMA = Type.Object(
  {
    wallMs: SAFE_UNSIGNED_INTEGER_SCHEMA,
    counter: SAFE_UNSIGNED_INTEGER_SCHEMA,
  },
  { additionalProperties: false },
);

export type Hlc = Static<typeof HLC_SCHEMA>;
export type Sha256 = Static<typeof SHA256_SCHEMA>;

export type CanonicalCborValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly CanonicalCborValue[]
  | { readonly [key: string]: CanonicalCborValue };

export interface CanonicalCborValueIssue {
  path: string;
  message: string;
}

const MAX_CBOR_DEPTH = 64;
const MAX_CBOR_NODES = 100_000;

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

export function findCanonicalCborValueIssue(value: unknown): CanonicalCborValueIssue | null {
  const active = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, path: string, depth: number): CanonicalCborValueIssue | null => {
    nodes += 1;
    if (nodes > MAX_CBOR_NODES) {
      return { path, message: `CBOR value exceeds ${MAX_CBOR_NODES} nodes` };
    }
    if (depth > MAX_CBOR_DEPTH) {
      return { path, message: `CBOR value exceeds depth ${MAX_CBOR_DEPTH}` };
    }

    if (current === null || typeof current === 'boolean') return null;
    if (typeof current === 'number') {
      return Number.isFinite(current) ? null : { path, message: 'number must be finite' };
    }
    if (typeof current === 'string') {
      return isWellFormedUtf16(current)
        ? null
        : { path, message: 'string contains an unpaired UTF-16 surrogate' };
    }
    if (current instanceof Uint8Array) return null;

    if (Array.isArray(current)) {
      if (active.has(current)) return { path, message: 'CBOR value contains a cycle' };
      active.add(current);
      for (let index = 0; index < current.length; index += 1) {
        if (!(index in current)) {
          active.delete(current);
          return { path: `${path}/${index}`, message: 'sparse arrays are not supported' };
        }
        const issue = visit(current[index], `${path}/${index}`, depth + 1);
        if (issue) {
          active.delete(current);
          return issue;
        }
      }
      active.delete(current);
      return null;
    }

    if (typeof current !== 'object' || current === undefined) {
      return { path, message: `unsupported CBOR value type: ${typeof current}` };
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return { path, message: 'only plain string-keyed objects are supported' };
    }
    if (active.has(current)) return { path, message: 'CBOR value contains a cycle' };
    if (Object.getOwnPropertySymbols(current).length > 0) {
      return { path, message: 'symbol-keyed properties are not supported' };
    }

    const names = Object.getOwnPropertyNames(current);
    const enumerableNames = Object.keys(current);
    if (names.length !== enumerableNames.length) {
      return { path, message: 'non-enumerable properties are not supported' };
    }

    active.add(current);
    for (const key of names) {
      if (!isWellFormedUtf16(key)) {
        active.delete(current);
        return { path: `${path}/${key}`, message: 'map key contains an unpaired UTF-16 surrogate' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) {
        active.delete(current);
        return { path: `${path}/${key}`, message: 'accessor properties are not supported' };
      }
      const issue = visit(descriptor.value, `${path}/${key}`, depth + 1);
      if (issue) {
        active.delete(current);
        return issue;
      }
    }
    active.delete(current);
    return null;
  };

  return visit(value, '$', 0);
}

export function isCanonicalCborValue(value: unknown): value is CanonicalCborValue {
  return findCanonicalCborValueIssue(value) === null;
}

export function assertCanonicalCborValue(
  value: unknown,
): asserts value is CanonicalCborValue {
  const issue = findCanonicalCborValueIssue(value);
  if (issue) throw new TypeError(`${issue.path}: ${issue.message}`);
}
