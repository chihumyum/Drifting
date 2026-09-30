import { v7 as uuidv7 } from 'uuid';

import { platform } from '../../platform';
import type { SyncWriterIdentitySource } from './writer-state';

let pendingIdentity: Promise<SyncWriterIdentitySource> | null = null;

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
  const installationId = await platform.app.getInstallationIdentity();
  if (!/^install-[a-f0-9]{64}$/u.test(installationId)) {
    throw new Error('invalid native installation identity');
  }
  return createIdentity(installationId);
}

/**
 * Non-secret, durable native marker outside the SQLite backup. The first
 * upgrade rotates the journal writer without reading the retired Keychain
 * marker. Writer rotation preserves existing changes, sequences and HLCs.
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
