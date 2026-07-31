import type {
  AgentRuntimeElementPatchSnapshot,
} from '../../../domain/agent-runtime-element-patch-receipt';
import { snapshotElementPatch } from '../../../domain/agent-runtime-element-patch-receipt';
import type { ElementPatch } from '../../../sqlite-repo/element-patch-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function hashElementPatchValue(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto SHA-256 is unavailable; element patch freshness cannot be verified',
    );
  }
  const bytes = new TextEncoder().encode(canonicalAgentRuntimeJson(value));
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function elementPatchRevision(
  patch: ElementPatch | AgentRuntimeElementPatchSnapshot,
): Promise<string> {
  // `listByElement` returns a display-enriched PatchWithSourceTitle while
  // `findById` returns the authored ElementPatch row. Freshness must only hash
  // the canonical authored fields or an immediate read -> update will look
  // stale merely because the read shape carried source-title/order helpers.
  return `element-patch:${await hashElementPatchValue(snapshotElementPatch(patch))}`;
}

export async function elementPatchSetRevision(
  patches: readonly ElementPatch[],
): Promise<string> {
  const snapshots = patches
    .map(snapshotElementPatch)
    .sort((left, right) => left.id.localeCompare(right.id));
  return `element-patch-set:${await hashElementPatchValue(snapshots)}`;
}

export async function deterministicElementPatchId(
  idempotencyKey: string,
): Promise<string> {
  const hash = (await hashElementPatchValue({
    kind: 'agent_element_patch',
    idempotencyKey,
  })).slice('sha256:'.length);
  const bytes = Array.from(
    { length: 16 },
    (_, index) => Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16),
  );
  // RFC 4122 variant, deterministic version-5-shaped UUID. The namespace is
  // encoded in the hashed `kind`, so unrelated command ids cannot collide.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
