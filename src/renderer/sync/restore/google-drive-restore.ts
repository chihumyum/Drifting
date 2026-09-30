import { events } from '../../lib/events';
import { platform } from '../../platform';
import { nativeSnapshotAssetCapturePort, nativeSnapshotAssetRestorePort, nativeSyncAssetBlobPort } from '../assets';
import { ProviderSnapshotPublisher } from '../checkpoint';
import { NativePlaintextSyncEngineObjectCodec } from '../engine/native-plaintext-object-codec';
import { getSyncInstallationIdentity } from '../journal';
import { nativeSyncObjectCodec } from '../native-object-codec';
import { GoogleDriveObjectLogProvider, TauriGoogleDriveObjectTransport, TauriGoogleDriveProjectSnapshotDiscovery } from '../providers/google-drive';
import { NativeRestoreObjectAccess, restoreCloudSyncGenerations, type CloudRestoreDependencies,
  type RestoreCloudSyncGenerationsInput, type RestoreCloudSyncGenerationsResult } from './cloud-restore';
export { NativeRestoreObjectAccess, discoverCurrentSyncGenerationObjects,
  CloudRestoreError as GoogleDriveRestoreError } from './cloud-restore';
export type { RestoreObjectAccess, CloudRestoreDependencies as GoogleDriveRestoreDependencies,
  CloudRestoreFailureCode as GoogleDriveRestoreFailureCode } from './cloud-restore';
export type RestoreGoogleDriveSyncGenerationsInput = Omit<RestoreCloudSyncGenerationsInput, 'dependencies'> & { readonly dependencies?: CloudRestoreDependencies };
export type RestoreGoogleDriveSyncGenerationsResult = RestoreCloudSyncGenerationsResult;
function productionDependencies(): CloudRestoreDependencies {
  const provider = new GoogleDriveObjectLogProvider(new TauriGoogleDriveObjectTransport());
  return {
    provider,
    discovery: new TauriGoogleDriveProjectSnapshotDiscovery(),
    objectAccess: new NativeRestoreObjectAccess(),
    assetRestorePort: nativeSnapshotAssetRestorePort,
    claimAccount: (credentialSecretRef, accountSubject) =>
      platform.googleDrive.claimAccount(credentialSecretRef, accountSubject),
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
      });
      const published = await publisher.publishSnapshot({
        snapshotId: `genesis-${attempt.attemptId}-${syncGenerationId}`,
        snapshotKind: 'genesis',
        signal,
      });
      return { commitMarkerRemoteObjectId: published.commitMarkerRemoteObjectId };
    },
    emitAuthorityChanged: () => events.emit('sync:authority-changed'),
    // Restore can replace every project-owned slice, so it always crosses the
    // structural workspace projection barrier rather than the prose-only seam.
    emitProjectChanged: (projectId) =>
      events.emit('sync:project-changed', { projectId, projectionImpact: 'workspace' }),
  };
}

export function restoreGoogleDriveSyncGenerations(input: RestoreGoogleDriveSyncGenerationsInput): Promise<RestoreGoogleDriveSyncGenerationsResult> {
  return restoreCloudSyncGenerations({ ...input, dependencies: input.dependencies ?? productionDependencies() });
}
