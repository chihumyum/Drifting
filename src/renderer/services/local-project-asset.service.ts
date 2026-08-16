import { v7 as uuidv7 } from 'uuid';
import type {
  ProjectAsset,
  ProjectAssetKind,
} from '../domain/project-asset';
import { platform } from '../platform';
import { assetStoreService, extForMime } from './asset-store.service';

export interface PrepareLocalProjectAssetInput {
  projectId: string;
  kind: ProjectAssetKind;
  sourcePath: string;
  assetId?: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function sourceSha256(sourcePath: string): Promise<string> {
  const source = await platform.material.readBytes(sourcePath);
  if (!source.ok) throw new Error(source.error);
  return bytesToHex(await crypto.subtle.digest('SHA-256', source.bytes));
}

/**
 * Import one picked image/PDF into Drifting-owned storage.
 *
 * The source variant written below is the authoritative local byte stream.
 * Display and thumbnail variants are rebuildable derivatives. Publishing the
 * source is a later SyncEngine concern and is never triggered by local import.
 *
 * This function performs file IO only. The caller must persist the returned
 * metadata and owner binding in one SQLite transaction, then release the picker
 * import. On failure, every partially-written variant is removed.
 */
export async function prepareLocalProjectAsset(
  input: PrepareLocalProjectAssetInput,
): Promise<ProjectAsset> {
  const assetId = input.assetId ?? uuidv7();
  const now = new Date().toISOString();

  try {
    if (input.kind === 'image') {
      const [prepared, sha256] = await Promise.all([
        platform.material.prepareImage(input.sourcePath),
        sourceSha256(input.sourcePath),
      ]);
      if (!prepared.ok) throw new Error(prepared.error);
      // The source path is reconstructed from persisted MIME on every later
      // read, so import and lookup must use the same resolver and fallback.
      const sourceExt = extForMime(prepared.source.mime);
      const writes = await Promise.allSettled([
        assetStoreService.copyFile(
          input.projectId,
          assetId,
          'source',
          sourceExt,
          input.sourcePath,
        ),
        assetStoreService.writeBytes(
          input.projectId,
          assetId,
          'display',
          'jpg',
          prepared.display.bytes,
        ),
        assetStoreService.writeBytes(
          input.projectId,
          assetId,
          'thumbnail',
          'jpg',
          prepared.thumbnail.bytes,
        ),
      ]);
      const failedWrite = writes.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedWrite) throw failedWrite.reason;
      const source = (writes[0] as PromiseFulfilledResult<{ sizeBytes: number }>).value;
      return {
        id: assetId,
        projectId: input.projectId,
        kind: 'image',
        sourceMime: prepared.source.mime,
        sourceSizeBytes: source.sizeBytes,
        sourceSha256: sha256,
        width: prepared.source.width,
        height: prepared.source.height,
        createdAt: now,
      };
    }

    const [thumbnail, sha256] = await Promise.all([
      platform.material.createThumbnailVariant(input.sourcePath, 512, 72),
      sourceSha256(input.sourcePath),
    ]);
    if (!thumbnail.ok) throw new Error(thumbnail.error);
    const writes = await Promise.allSettled([
      assetStoreService.copyFile(
        input.projectId,
        assetId,
        'source',
        'pdf',
        input.sourcePath,
      ),
      assetStoreService.writeBytes(
        input.projectId,
        assetId,
        'thumbnail',
        'jpg',
        thumbnail.bytes,
      ),
    ]);
    const failedWrite = writes.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedWrite) throw failedWrite.reason;
    const source = (writes[0] as PromiseFulfilledResult<{ sizeBytes: number }>).value;
    return {
      id: assetId,
      projectId: input.projectId,
      kind: 'pdf',
      sourceMime: 'application/pdf',
      sourceSizeBytes: source.sizeBytes,
      sourceSha256: sha256,
      width: null,
      height: null,
      createdAt: now,
    };
  } catch (error) {
    await assetStoreService.deleteAsset(input.projectId, assetId).catch((cleanupError) => {
      console.warn('[asset] failed to clean a partial local import:', cleanupError);
    });
    throw error;
  }
}

export async function releasePickedMaterialImport(sourcePath: string): Promise<void> {
  const deleted = await platform.material.deleteImport(sourcePath);
  if (!deleted.ok) throw new Error(deleted.error);
}
