import loglevel from 'loglevel';

import { canUseHostedService } from '../../lib/config';
import { getDb } from '../../lib/db';
import { events } from '../../lib/events';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { platform } from '../../platform';
import {
  nativeSnapshotAssetCapturePort,
  nativeSyncAssetBlobPort,
} from '../assets';
import { ProviderSnapshotPublisher } from '../checkpoint';
import { NativePlaintextSyncEngineObjectCodec } from '../engine';
import { onAuthoredChangeCommitted } from '../journal';
import { nativeSyncObjectCodec } from '../native-object-codec';
import { SyncGenerationProvisionRepository } from './repository';
import { SyncGenerationProvisionSupervisor } from './supervisor';
import { PendingSyncGenerationProvisioner } from './sync-generation-provisioner';

import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import { createHostedProvider } from '../providers/hosted/tauri-transport';

const log = loglevel.getLogger('HostedSyncGenerationProvision');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

let hostedSupervisor: SyncGenerationProvisionSupervisor | null = null;

export async function holdHostedProvisioning(): Promise<() => void> {
  return hostedSupervisor ? hostedSupervisor.hold() : () => {};
}

function createProductSupervisor(): SyncGenerationProvisionSupervisor {
  return new SyncGenerationProvisionSupervisor({
    canUseProvider: () => canUseHostedService() && getHostedSessionBinding() !== null,
    async runOnce(signal) {
      const db = getDb();
      const repository = new SyncGenerationProvisionRepository(db);
      const pending = await repository.ensureAndListPending('hosted');
      const failures: unknown[] = [];
      for (const item of pending) {
        if (signal.aborted) throw signal.reason;
        const provisioner = new PendingSyncGenerationProvisioner({
          db,
          repository,
          createProvider: () => createHostedProvider(),
          createSnapshotPublisher: ({
            pending: generation,
            provider,
            providerGeneration,
          }) =>
            new ProviderSnapshotPublisher({
              db,
              projectId: generation.projectId,
              syncGenerationId: generation.syncGenerationId,
              provider,
              providerGeneration,
              objectCodec: new NativePlaintextSyncEngineObjectCodec(nativeSyncObjectCodec),
              blobPort: nativeSyncAssetBlobPort,
              assetCapturePort: nativeSnapshotAssetCapturePort,
              flushLocalDurability: flushLocalApplicationPersistence,
            }),
          emitAuthorityChanged: () => events.emit('sync:authority-changed'),
        });
        try {
          await provisioner.provision(item, signal);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} SyncGeneration provision(s) failed`);
      }
    },
    onError(error) {
      log.warn('Pending Hosted SyncGeneration provisioning will retry', error);
    },
  });
}

export function installHostedSyncGenerationProvisioningRuntime(): () => void {
  const supervisor = createProductSupervisor();
  hostedSupervisor = supervisor;
  let databaseReady = false;
  const request = () => {
    if (databaseReady) supervisor.requestRun();
  };
  const onDatabaseReady = () => {
    databaseReady = true;
    supervisor.requestRun();
  };
  const onDatabaseError = () => {
    databaseReady = false;
    supervisor.deactivate();
  };
  events.on('db:ready', onDatabaseReady);
  events.on('db:error', onDatabaseError);
  events.on('sync:authority-changed', request);
  const unsubscribeAuthored = onAuthoredChangeCommitted(request);
  const unsubscribeLifecycle = platform.lifecycle.onReadyOrResume(request);
  const onOnline = () => request();
  globalThis.addEventListener?.('online', onOnline);
  return () => {
    globalThis.removeEventListener?.('online', onOnline);
    unsubscribeLifecycle();
    unsubscribeAuthored();
    events.off('sync:authority-changed', request);
    events.off('db:error', onDatabaseError);
    events.off('db:ready', onDatabaseReady);
    supervisor.stop();
    if (hostedSupervisor === supervisor) hostedSupervisor = null;
  };
}
