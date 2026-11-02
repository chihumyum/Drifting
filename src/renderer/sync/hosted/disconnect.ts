import { getDb, type DbClient } from '../../lib/db';
import { events } from '../../lib/events';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { CloudDisconnectOrchestrator } from '../disconnect/cloud-disconnect';
import { getSyncInstallationIdentity } from '../journal';
import { productSyncRuntimeControl } from '../product-runtime-control';
import { countUnuploadedLocalChanges } from './unuploaded';

const UPLOAD_POLL_MS = 1_500;

export interface HostedDisconnectOptions {
  /**
   * Upload what only this Mac holds before disconnecting. Waiting ends early
   * when `stopWaiting` aborts; the rest then stays on this Mac alone.
   */
  readonly uploadFirst: boolean;
  readonly stopWaiting?: AbortSignal;
  readonly onRemaining?: (remaining: number) => void;
}

/** How many changes would stay on this Mac alone if sync disconnected now. */
export async function countHostedUnuploadedChanges(): Promise<number> {
  const { installationId } = await getSyncInstallationIdentity();
  return countUnuploadedLocalChanges(getDb(), installationId);
}

export async function disconnectHosted(
  signal: AbortSignal,
  options: HostedDisconnectOptions = { uploadFirst: true },
): Promise<void> {
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
    // Only outbound changes matter: what the cloud already has stays there, and
    // waiting for a large download to finish is not needed to disconnect.
    waitForConvergence: (abortSignal) =>
      options.uploadFirst
        ? waitForLocalUpload(db, abortSignal, options)
        : Promise.resolve(),
    // Disconnecting sync keeps the verified account session. Signing out is explicit.
    revokeCredential: async () => {},
    emitAuthorityChanged: () => events.emit('sync:authority-changed'),
    nowIso: () => new Date().toISOString(),
  }).disconnect(signal);
}

/** Wait until this Mac holds no change the cloud lacks, or until `stopWaiting` aborts. */
export function waitForHostedUpload(
  signal: AbortSignal,
  options: Pick<HostedDisconnectOptions, 'stopWaiting' | 'onRemaining'> = {},
): Promise<void> {
  return waitForLocalUpload(getDb(), signal, options);
}

async function waitForLocalUpload(
  db: DbClient,
  signal: AbortSignal,
  options: Pick<HostedDisconnectOptions, 'stopWaiting' | 'onRemaining'>,
): Promise<void> {
  const { installationId } = await getSyncInstallationIdentity();
  for (;;) {
    if (signal.aborted) throw signal.reason;
    if (options.stopWaiting?.aborted) return;
    const remaining = await countUnuploadedLocalChanges(db, installationId);
    options.onRemaining?.(remaining);
    if (remaining === 0) return;
    productSyncRuntimeControl.triggerManual();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        options.stopWaiting?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, UPLOAD_POLL_MS);
      signal.addEventListener('abort', done, { once: true });
      options.stopWaiting?.addEventListener('abort', done, { once: true });
    });
  }
}
