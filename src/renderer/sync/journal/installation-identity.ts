import { v7 as uuidv7 } from 'uuid';

import { platform } from '../../platform';
import type { SyncWriterIdentitySource } from './writer-state';

const INSTALLATION_IDENTITY_KEY = 'sync.installation.identity.v1';
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface StoredInstallationIdentityV1 {
  readonly protocol: 'drifting.sync.installation';
  readonly version: 1;
  readonly installationId: string;
}

let pendingIdentity: Promise<SyncWriterIdentitySource> | null = null;

function assertToken(value: string, label: string): void {
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} is not a valid SyncEngine protocol token`);
  }
}

function decodeStoredIdentity(raw: string): StoredInstallationIdentityV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('stored SyncEngine installation identity is malformed');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { protocol?: unknown }).protocol !== 'drifting.sync.installation' ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { installationId?: unknown }).installationId !== 'string'
  ) {
    throw new Error('stored SyncEngine installation identity has an unsupported format');
  }
  const installationId = (parsed as StoredInstallationIdentityV1).installationId;
  assertToken(installationId, 'installationId');
  return { protocol: 'drifting.sync.installation', version: 1, installationId };
}

function createIdentity(installationId: string): SyncWriterIdentitySource {
  return Object.freeze({
    installationId,
    createWriterIdentity() {
      return {
        writerId: `writer-${uuidv7()}`,
        writerEpoch: `epoch-${uuidv7()}`,
      };
    },
  });
}

async function loadOrCreateIdentity(): Promise<SyncWriterIdentitySource> {
  const stored = await platform.keychain.get(INSTALLATION_IDENTITY_KEY);
  if (stored !== null) {
    return createIdentity(decodeStoredIdentity(stored).installationId);
  }

  const value: StoredInstallationIdentityV1 = {
    protocol: 'drifting.sync.installation',
    version: 1,
    installationId: `install-${uuidv7()}`,
  };
  const saved = await platform.keychain.set(INSTALLATION_IDENTITY_KEY, JSON.stringify(value));
  if (!saved) throw new Error('native secure storage refused the SyncEngine installation identity');
  return createIdentity(value.installationId);
}

/**
 * Returns the native-secure installation identity used to scope writer epochs.
 * There is deliberately no localStorage fallback: losing or replacing the
 * native identity must rotate the writer instead of risking sequence reuse.
 */
export function getSyncInstallationIdentity(): Promise<SyncWriterIdentitySource> {
  if (!pendingIdentity) {
    pendingIdentity = loadOrCreateIdentity().catch((error) => {
      pendingIdentity = null;
      throw error;
    });
  }
  return pendingIdentity;
}

export function resetSyncInstallationIdentityForTests(): void {
  pendingIdentity = null;
}
