import { sha256Bytes } from '../protocol';

const TRANSFER_ID_PATTERN = /^[A-Za-z0-9._~:-]{1,200}$/u;

/**
 * Stable provider-safe identity for one resumable transfer.
 *
 * SQLite may use structured JSON identities, but a native provider boundary
 * may accept only bounded token characters. Hash the canonical tuple so
 * provider-specific syntax never leaks back into the durable domain identity.
 */
export async function createProviderTransferId(input: {
  direction: 'upload' | 'download';
  syncGenerationId: string;
  objectIdentity: string;
}): Promise<string> {
  if (!input.syncGenerationId || !input.objectIdentity) {
    throw new TypeError('provider transfer identity fields must not be empty');
  }
  const canonical = JSON.stringify([
    'drifting.sync.transfer',
    1,
    input.direction,
    input.syncGenerationId,
    input.objectIdentity,
  ]);
  const digest = await sha256Bytes(new TextEncoder().encode(canonical));
  const transferId = `${input.direction}-${digest.slice('sha256:'.length)}`;
  if (!TRANSFER_ID_PATTERN.test(transferId)) {
    throw new Error('provider transfer ID is not a bounded native-safe token');
  }
  return transferId;
}
