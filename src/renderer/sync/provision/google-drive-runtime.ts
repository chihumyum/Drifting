import loglevel from 'loglevel';

import { canUsePersonalCloud } from '../../lib/config';
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
import {
  GoogleDriveObjectLogProvider,
  TauriGoogleDriveObjectTransport,
} from '../providers/google-drive';
import { SyncGenerationProvisionRepository } from './repository';
import { SyncGenerationProvisionSupervisor } from './supervisor';
import { PendingSyncGenerationProvisioner } from './sync-generation-provisioner';

const log = loglevel.getLogger('GoogleDriveSyncGenerationProvision');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

let activeProductSupervisor: SyncGenerationProvisionSupervisor | null = null;

/** Settings/manual retry entrypoint. Returns false before the App runtime is installed. */
export function requestGoogleDriveSyncGenerationProvisioning(): boolean {
  if (!activeProductSupervisor) return false;
  activeProductSupervisor.requestRun();
  return true;
}

function createProductSupervisor(): SyncGenerationProvisionSupervisor {
  return new SyncGenerationProvisionSupervisor({
    canUseProvider: canUsePersonalCloud,
    async runOnce(signal) {
      const db = getDb();
      const repository = new SyncGenerationProvisionRepository(db);
      const pending = await repository.ensureAndListPending('google-drive');
      const failures: unknown[] = [];
      for (const item of pending) {
        if (signal.aborted) throw signal.reason;
        const provisioner = new PendingSyncGenerationProvisioner({
          db,
          repository,
          createProvider: () =>
            new GoogleDriveObjectLogProvider(new TauriGoogleDriveObjectTransport()),
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
      log.warn('Pending Google Drive SyncGeneration provisioning will retry', error);
    },
  });
}

/** Installs foreground/start/commit wakeups without coupling to production-runtime.ts. */
export function installGoogleDriveSyncGenerationProvisioningRuntime(): () => void {
  const supervisor = createProductSupervisor();
  activeProductSupervisor = supervisor;
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
    if (activeProductSupervisor === supervisor) activeProductSupervisor = null;
  };
}
