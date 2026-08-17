import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function authoredSemanticHashValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as { kind?: unknown; value?: unknown };
  if (!snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) {
    return value;
  }
  if (snapshot.kind === 'storyline') {
    const authored = { ...(snapshot.value as Record<string, unknown>) };
    delete authored.orderKey;
    return { ...snapshot, value: authored };
  }
  return value;
}

export async function hashEntityWriteValue(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto SHA-256 is unavailable; entity write receipts cannot be verified',
    );
  }
  const bytes = new TextEncoder().encode(
    canonicalAgentRuntimeJson(authoredSemanticHashValue(value)),
  );
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function deterministicAgentEntityId(
  idempotencyKey: string,
  kind: string,
): Promise<string> {
  const hash = (
    await hashEntityWriteValue({
      kind: `agent_entity_write:${kind}`,
      idempotencyKey,
    })
  ).slice('sha256:'.length);
  const bytes = Array.from(
    { length: 16 },
    (_, index) => Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16),
  );
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
