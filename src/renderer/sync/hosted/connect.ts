import { SyncProviderBindingTable } from '../../schema/drizzle';
import { adoptDriveReplicaForHosted } from './adopt-drive';
import { events } from '../../lib/events';
import { getDb, type DbClient } from '../../lib/db';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { getHostedSessionBinding } from '../../lib/hosted-session-binding';
import {
  nativeSnapshotAssetCapturePort,
  nativeSnapshotAssetRestorePort,
  nativeSyncAssetBlobPort,
} from '../assets';
import { ProviderSnapshotPublisher } from '../checkpoint';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { productSyncRuntimeControl } from '../product-runtime-control';
import { NativePlaintextSyncEngineObjectCodec } from '../engine';
import { getSyncInstallationIdentity } from '../journal';
import { nativeSyncObjectCodec } from '../native-object-codec';
import { createHostedProvider } from '../providers/hosted/tauri-transport';
import {
  NativeRestoreObjectAccess,
  restoreCloudSyncGenerations,
  restoreDiscoveredCloudProjects,
  type CloudRestoreDependencies,
} from '../restore/cloud-restore';
export function hostedRestoreDependencies(): CloudRestoreDependencies {
  const provider = createHostedProvider();
  return {
    provider,
    discovery: provider,
    objectAccess: new NativeRestoreObjectAccess(),
    assetRestorePort: nativeSnapshotAssetRestorePort,
    async claimAccount(credentialSecretRef, accountSubject) {
      if (getHostedSessionBinding()?.accountSubject !== accountSubject)
        throw new Error('HOSTED_ACCOUNT_MISMATCH');
      return { accountSubject, credentialSecretRef };
    },
    loadWriterIdentity: getSyncInstallationIdentity,
    async publishLocalSyncGeneration({
      db,
      attempt,
      syncGenerationId,
      projectId,
      providerGeneration,
      signal,
    }) {
      const publisher = new ProviderSnapshotPublisher({
        db,
        projectId,
        syncGenerationId,
        provider,
        providerGeneration,
        objectCodec: new NativePlaintextSyncEngineObjectCodec(nativeSyncObjectCodec),
        blobPort: nativeSyncAssetBlobPort,
        assetCapturePort: nativeSnapshotAssetCapturePort,
        flushLocalDurability: flushLocalApplicationPersistence,
      });
      return publisher.publishSnapshot({
        snapshotId: `genesis-${attempt.attemptId}-${syncGenerationId}`,
        snapshotKind: 'genesis',
        signal,
      });
    },
    emitAuthorityChanged: () => events.emit('sync:authority-changed'),
    emitProjectChanged: (projectId) =>
      events.emit('sync:project-changed', { projectId, projectionImpact: 'workspace' }),
  };
}
export async function connectHostedFromProduct(signal: AbortSignal, db: DbClient = getDb()) {
  const session = getHostedSessionBinding();
  if (!session) throw new Error('needs-reauth');
  await flushLocalApplicationPersistence();
  const repository = createSyncAppAuthorityRepository(db);
  let current = await repository.read();
  // Drive is suspended. Retire an unfinished local transition without contacting
  // its provider, so a previous connect/disconnect cannot strand Hosted sign-in.
  if (
    current.transitionState !== 'stable' &&
    (current.mode === 'google-drive' || current.targetMode === 'google-drive')
  ) {
    signal.throwIfAborted();
    await repository.cancel({ attemptId: current.attemptId, nowIso: new Date().toISOString() });
    events.emit('sync:authority-changed');
    current = await repository.read();
  }
  if (current.mode === 'hosted' && current.transitionState === 'stable')
    return { restored: await discoverHostedProjects(db, signal) };
  if (current.mode === 'google-drive' && current.transitionState === 'stable') {
    const resume = await productSyncRuntimeControl.quiesceForProviderChange();
    try {
      signal.throwIfAborted();
      await flushLocalApplicationPersistence();
      await adoptDriveReplicaForHosted({
        db,
        accountSubject: session.accountSubject,
        identity: await getSyncInstallationIdentity(),
        assertAccount() {
          signal.throwIfAborted();
          if (getHostedSessionBinding()?.accountSubject !== session.accountSubject)
            throw new Error('HOSTED_ACCOUNT_MISMATCH');
        },
      });
    } catch (error) {
      resume();
      throw error;
    }
    events.emit('sync:authority-changed');
    current = await createSyncAppAuthorityRepository(db).read();
  }
  if (current.mode !== 'local')
    throw new Error('Finish or cancel the current provider transition first.');
  const result = await restoreCloudSyncGenerations({
    db,
    signal,
    account: { accountSubject: session.accountSubject, credentialSecretRef: 'hosted.session' },
    ...(current.transitionState !== 'stable' ? { attemptId: current.attemptId } : {}),
    dependencies: hostedRestoreDependencies(),
  });
  if (result.restored.length)
    events.emit('sync:projects-restored', {
      projectIds: result.restored.map((item) => item.projectId),
    });
  return result;
}

const discoveries = new WeakMap<
  DbClient,
  Promise<Awaited<ReturnType<typeof restoreDiscoveredCloudProjects>>>
>();
/** Manual and foreground wakeups share one import transaction sequence per local library. */
export function discoverHostedProjects(db: DbClient, signal: AbortSignal) {
  const active = discoveries.get(db);
  if (active) return active;
  const session = getHostedSessionBinding();
  if (!session) return Promise.reject(new Error('needs-reauth'));
  const operation = restoreDiscoveredCloudProjects({
    db,
    signal,
    account: { accountSubject: session.accountSubject, credentialSecretRef: 'hosted.session' },
    dependencies: hostedRestoreDependencies(),
  })
    .then((restored) => {
      if (restored.length)
        events.emit('sync:projects-restored', {
          projectIds: restored.map((item) => item.projectId),
        });
      return restored;
    })
    .finally(() => {
      if (discoveries.get(db) === operation) discoveries.delete(db);
    });
  discoveries.set(db, operation);
  return operation;
}

/** A successful button result includes a fresh cycle, even after first activation. */
export async function synchronizeHostedNow(signal: AbortSignal): Promise<void> {
  await connectHostedFromProduct(signal);
  const bindings = await getDb().select().from(SyncProviderBindingTable);
  if (!bindings.length) return;
  const expected = bindings.map((item) => item.syncGenerationId);
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const inspect = () => {
      const runtime = productSyncRuntimeControl.getSnapshot();
      if (expected.every((id) => runtime.syncGenerationIds.includes(id))) finish();
    };
    const abort = () => finish(new DOMException('Sync cancelled', 'AbortError'));
    const unsubscribe = productSyncRuntimeControl.subscribe(inspect);
    const timer = setTimeout(
      () => finish(new Error('Hosted sync could not start; local writing remains saved.')),
      120_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else inspect();
  });
  await productSyncRuntimeControl.waitForConvergence({ signal, timeoutMs: 120_000 });
}
