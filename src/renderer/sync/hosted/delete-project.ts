import { getDb } from '../../lib/db';
import { canUseHostedService } from '../../lib/config';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { events } from '../../lib/events';
import { productSyncRuntimeControl } from '../product-runtime-control';
import { holdHostedProvisioning } from '../provision/google-drive-runtime';
import { createHostedProvider } from '../providers/hosted/tauri-transport';
import { holdHostedDiscovery } from './runtime';
import { deleteProjectWithRemoteConfirmation } from './project-deletion';

let tail: Promise<unknown> = Promise.resolve();
/** Serialize project deletes and drain background writers before inspecting ownership. */
export function deleteProjectEverywhere(projectId: string, userId: string) {
  const operation = tail.catch(() => {}).then(async () => {
    const release: (() => void)[] = [];
    try {
      release.push(await holdHostedDiscovery());
      release.push(await holdHostedProvisioning());
      release.push(await productSyncRuntimeControl.hold());
      await flushLocalApplicationPersistence();
      const provider = createHostedProvider();
      return await deleteProjectWithRemoteConfirmation({
        db: getDb(), projectId, userId, signal: AbortSignal.timeout(60_000),
        dependencies: {
          hostedEnabled: canUseHostedService(),
          accountSubject: () => getHostedSessionBinding()?.accountSubject ?? null,
          deleteRemote: input => provider.deleteProjectGeneration(input),
        },
      });
    } finally {
      for (const resume of release.reverse()) resume();
      events.emit('sync:authority-changed');
    }
  });
  tail = operation;
  return operation;
}
