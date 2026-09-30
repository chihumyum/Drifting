import { getDb } from '../../lib/db';
import { events } from '../../lib/events';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { CloudDisconnectOrchestrator } from '../disconnect/cloud-disconnect';
import { productSyncRuntimeControl } from '../product-runtime-control';

export async function disconnectHosted(signal: AbortSignal): Promise<void> {
  const db = getDb();
  const repository = createSyncAppAuthorityRepository(db);
  const current = await repository.read();
  if (
    current.mode === 'local' &&
    current.transitionState !== 'stable' &&
    current.targetMode === 'hosted'
  ) {
    await repository.cancel({ attemptId: current.attemptId, nowIso: new Date().toISOString() });
    events.emit('sync:authority-changed');
    return;
  }
  await new CloudDisconnectOrchestrator({
    db,
    providerMode: 'hosted',
    flushLocalDurability: flushLocalApplicationPersistence,
    async waitForConvergence(abortSignal) {
      const bindings = await repository.listActiveRuntimeBindings();
      if (bindings.length)
        await productSyncRuntimeControl.waitForConvergence({
          signal: abortSignal,
          timeoutMs: 120_000,
        });
    },
    // Disconnecting sync keeps the verified account session. Signing out is explicit.
    revokeCredential: async () => {},
    emitAuthorityChanged: () => events.emit('sync:authority-changed'),
    nowIso: () => new Date().toISOString(),
  }).disconnect(signal);
}
