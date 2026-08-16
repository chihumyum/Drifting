import type { CapturedSnapshotV1, SnapshotPublishPort } from './types';

/** Publish dependencies first; only the final call makes a snapshot visible. */
export async function publishCapturedSnapshotV1(
  captured: CapturedSnapshotV1,
  port: SnapshotPublishPort,
): Promise<void> {
  for (const asset of captured.assets) await port.ensureBlob(asset);
  await port.publishPackage({
    snapshotKind: captured.package.snapshotKind,
    snapshotId: captured.package.snapshotId,
    logicalKeyId: captured.commitMarker.packageLogicalKeyId,
    bytes: new Uint8Array(captured.packageBytes),
    sha256: captured.packageSha256,
  });
  await port.publishCommitMarker({
    snapshotKind: captured.package.snapshotKind,
    snapshotId: captured.package.snapshotId,
    bytes: new Uint8Array(captured.commitMarkerBytes),
  });
}
