import { getDb, type DbClient } from '../../lib/db';
import { events } from '../../lib/events';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { platform } from '../../platform';
import { productSyncRuntimeControl } from '../product-runtime-control';
import { CloudDisconnectOrchestrator } from './cloud-disconnect';

/** Production Google Drive composition; credentials remain native-owned. */
export function createGoogleDriveDisconnectOrchestrator(
  db: DbClient = getDb(),
): CloudDisconnectOrchestrator {
  return new CloudDisconnectOrchestrator({
    db,
    providerMode: 'google-drive',
    flushLocalDurability: flushLocalApplicationPersistence,
    waitForConvergence: (signal) =>
      productSyncRuntimeControl.waitForConvergence({ signal, timeoutMs: 120_000 }),
    revokeCredential: (credentialSecretRef, signal) =>
      platform.googleDrive.revokeAccount(credentialSecretRef, signal),
    emitAuthorityChanged: () => events.emit('sync:authority-changed'),
    nowIso: () => new Date().toISOString(),
  });
}
