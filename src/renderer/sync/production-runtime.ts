import loglevel from 'loglevel';
import { eq } from 'drizzle-orm';

import { events } from '../lib/events';
import { getDb, type DbClient } from '../lib/db';
import { flushLocalApplicationPersistence } from '../lib/persistence-lifecycle';
import { reconcileOpenYjsDocumentSessions } from '../services/yjs-document-session';
import { platform } from '../platform';
import {
  nativeSnapshotAssetCapturePort,
  nativeSyncAssetBlobPort,
  reconcileNativeSyncAssetAttempts,
} from './assets';
import {
  createProviderCheckpointHook,
  ProviderSnapshotPublisher,
} from './checkpoint';
import {
  createSyncAppAuthorityRepository,
  type ActiveProviderRuntimeBinding,
} from './app-authority-repository';
import {
  installSyncEngineCoordinatorRuntime,
  NativePlaintextSyncEngineObjectCodec,
  SqliteSyncGenerationRuntime,
  SyncEngineCoordinator,
  type SyncEngineCheckpointHook,
  type RegisteredSyncGenerationRuntime,
} from './engine';
import { reconcileNativeSyncObjects } from './local-object-gc';
import { getSyncInstallationIdentity, type SyncWriterIdentitySource } from './journal';
import { nativeSyncObjectCodec } from './native-object-codec';
import type { ObjectLogProvider } from './protocol';
import { productionSyncDomainMaterializationKernel } from './reducer';
import { SyncGenerationTable } from '../schema/drizzle';
import { productSyncRuntimeControl } from './product-runtime-control';
import {
  GoogleDriveObjectLogProvider,
  TauriGoogleDriveObjectTransport,
} from './providers/google-drive';

const log = loglevel.getLogger('SyncEngineProductionRuntime');
log.setLevel(import.meta.env.DEV ? loglevel.levels.TRACE : loglevel.levels.WARN);

export interface ProductionSyncRuntimeDependencies {
  readonly database: () => DbClient;
  readonly listBindings: (
    database: DbClient,
  ) => Promise<readonly ActiveProviderRuntimeBinding[]>;
  readonly reconcileNativeStorage: (database: DbClient) => Promise<void>;
  readonly writerIdentity: () => Promise<SyncWriterIdentitySource>;
  readonly createProvider: (
    mode: ActiveProviderRuntimeBinding['mode'],
  ) => ObjectLogProvider;
  readonly createCoordinator: () => SyncEngineCoordinator;
  readonly createCheckpoint: (input: {
    database: DbClient;
    binding: ActiveProviderRuntimeBinding;
    provider: ObjectLogProvider;
  }) => SyncEngineCheckpointHook;
  readonly createSyncGenerationRuntime: (input: {
    database: DbClient;
    binding: ActiveProviderRuntimeBinding;
    provider: ObjectLogProvider;
    writerIdentity: SyncWriterIdentitySource;
    checkpoint: SyncEngineCheckpointHook;
  }) => RegisteredSyncGenerationRuntime;
  readonly installCoordinator: (coordinator: SyncEngineCoordinator) => () => void;
  readonly exposeCoordinator: (coordinator: SyncEngineCoordinator) => () => void;
  readonly onError: (error: unknown) => void;
}

const defaultDependencies: ProductionSyncRuntimeDependencies = {
  database: getDb,
  listBindings: (database) =>
    createSyncAppAuthorityRepository(database).listActiveRuntimeBindings(),
  async reconcileNativeStorage(database) {
    await reconcileNativeSyncAssetAttempts({
      db: database,
      native: platform.syncAssetStore,
    });
    await reconcileNativeSyncObjects({
      db: database,
      native: platform.syncObjectStore,
    });
  },
  writerIdentity: getSyncInstallationIdentity,
  createProvider(mode) {
    if (mode === 'google-drive') {
      return new GoogleDriveObjectLogProvider(new TauriGoogleDriveObjectTransport());
    }
    throw new Error('The Hosted SyncEngine provider is not implemented');
  },
  createCoordinator: () =>
    new SyncEngineCoordinator({
      onCycleError(syncGenerationId, error) {
        log.warn(`SyncEngine cycle failed for ${syncGenerationId}; local journal remains durable`, error);
      },
    }),
  createCheckpoint({ database, binding, provider }) {
    let delegate: Promise<SyncEngineCheckpointHook> | null = null;
    return {
      async captureIfDue(input) {
        delegate ??= (async () => {
          const [generation] = await database
            .select({ projectId: SyncGenerationTable.projectId })
            .from(SyncGenerationTable)
            .where(eq(SyncGenerationTable.syncGenerationId, binding.binding.syncGenerationId))
            .limit(1);
          if (!generation?.projectId) {
            // A detached active generation owns only a terminal project purge.
            // The runtime must publish that journal, but there is no remaining
            // authored project state from which a checkpoint could be captured.
            return { captureIfDue: async () => false };
          }
          const providerGeneration = await provider.openGeneration(binding.binding);
          const objectCodec = new NativePlaintextSyncEngineObjectCodec(nativeSyncObjectCodec);
          const publisher = new ProviderSnapshotPublisher({
            db: database,
            projectId: generation.projectId,
            syncGenerationId: binding.binding.syncGenerationId,
            provider,
            providerGeneration,
            objectCodec,
            blobPort: nativeSyncAssetBlobPort,
            assetCapturePort: nativeSnapshotAssetCapturePort,
            flushLocalDurability: flushLocalApplicationPersistence,
          });
          return createProviderCheckpointHook({
            db: database,
            syncGenerationId: binding.binding.syncGenerationId,
            publisher,
          });
        })();
        return (await delegate).captureIfDue(input);
      },
    };
  },
  createSyncGenerationRuntime({ database, binding, provider, writerIdentity, checkpoint }) {
    return new SqliteSyncGenerationRuntime({
      db: database,
      syncGenerationId: binding.binding.syncGenerationId,
      projectId: binding.projectId,
      provider,
      providerBinding: binding.binding,
      objectCodec: new NativePlaintextSyncEngineObjectCodec(nativeSyncObjectCodec),
      blobPort: nativeSyncAssetBlobPort,
      writerIdentity,
      domainKernel: productionSyncDomainMaterializationKernel,
      flushLocalDurability: flushLocalApplicationPersistence,
      reconcileOpenYjsDocuments: ({ projectId, docIds }) =>
        reconcileOpenYjsDocumentSessions(projectId, docIds),
      onRemoteChangeCommitted: ({ projectId }) => {
        events.emit('sync:project-changed', { projectId });
      },
      checkpoint,
    });
  },
  installCoordinator: installSyncEngineCoordinatorRuntime,
  exposeCoordinator: (coordinator) => productSyncRuntimeControl.attach(coordinator),
  onError(error) {
    log.error('SyncEngine production runtime could not be activated', error);
  },
};

/**
 * Owns exactly one product coordinator for the currently-open SQLite database.
 * Reloads are serialized so a database/provider switch cannot leave old SyncGeneration
 * callbacks running against a replaced database or credential generation.
 */
export class ProductionSyncRuntimeSupervisor {
  private cleanupActive: () => void = () => {};
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private revision = 0;

  constructor(private readonly dependencies: ProductionSyncRuntimeDependencies) {}

  requestReload(): void {
    if (this.stopped) return;
    const revision = ++this.revision;
    this.tail = this.tail
      .catch(() => undefined)
      .then(() => this.reload(revision))
      .catch((error) => this.dependencies.onError(error));
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  deactivate(): void {
    this.revision += 1;
    this.cleanupActive();
    this.cleanupActive = () => {};
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.deactivate();
  }

  private async reload(revision: number): Promise<void> {
    if (this.stopped || revision !== this.revision) return;
    this.cleanupActive();
    this.cleanupActive = () => {};

    const database = this.dependencies.database();
    await this.dependencies.reconcileNativeStorage(database);
    if (this.stopped || revision !== this.revision) return;
    const bindings = await this.dependencies.listBindings(database);
    if (this.stopped || revision !== this.revision || bindings.length === 0) return;

    const mode = bindings[0]!.mode;
    if (bindings.some((binding) => binding.mode !== mode)) {
      throw new Error('All active SyncGenerations must share one App-wide provider authority');
    }
    const authorityGeneration = bindings[0]!.binding.authorityGeneration;
    if (
      bindings.some(
        (binding) => binding.binding.authorityGeneration !== authorityGeneration,
      )
    ) {
      throw new Error('All active SyncGenerations must share one provider authority generation');
    }

    const provider = this.dependencies.createProvider(mode);
    const identity = await this.dependencies.writerIdentity();
    if (this.stopped || revision !== this.revision) return;
    const coordinator = this.dependencies.createCoordinator();
    const unregister: Array<() => void> = [];
    let uninstallSignals: () => void = () => {};
    let hideCoordinator: () => void = () => {};
    try {
      for (const binding of bindings) {
        const checkpoint = this.dependencies.createCheckpoint({
          database,
          binding,
          provider,
        });
        unregister.push(
          coordinator.register(
            this.dependencies.createSyncGenerationRuntime({
              database,
              binding,
              provider,
              writerIdentity: identity,
              checkpoint,
            }),
          ),
        );
      }
      uninstallSignals = this.dependencies.installCoordinator(coordinator);
      hideCoordinator = this.dependencies.exposeCoordinator(coordinator);
      this.cleanupActive = () => {
        hideCoordinator();
        uninstallSignals();
        for (const dispose of unregister.reverse()) dispose();
      };
    } catch (error) {
      hideCoordinator();
      uninstallSignals();
      for (const dispose of unregister.reverse()) dispose();
      coordinator.shutdown();
      throw error;
    }
  }
}

/** Install once at App scope; activation still waits for the database-ready event. */
export function installProductionSyncRuntime(
  dependencies: ProductionSyncRuntimeDependencies = defaultDependencies,
): () => void {
  const supervisor = new ProductionSyncRuntimeSupervisor(dependencies);
  const reload = () => supervisor.requestReload();
  const deactivate = () => supervisor.deactivate();
  events.on('db:ready', reload);
  events.on('sync:authority-changed', reload);
  events.on('db:error', deactivate);
  return () => {
    events.off('db:ready', reload);
    events.off('sync:authority-changed', reload);
    events.off('db:error', deactivate);
    supervisor.stop();
  };
}
