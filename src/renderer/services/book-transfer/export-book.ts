// Export one book as a `.driftingbook` file (docs/book-transfer.md). The
// package is the same deterministic snapshot a checkpoint publishes; asset
// bytes are read from this library's asset store instead of being staged in
// the sync object store, so exporting changes nothing in the library.
import { eq } from 'drizzle-orm';

import type { ProjectAsset, ProjectAssetVariant } from '../../domain/project-asset';
import type { DbClient } from '../../lib/db';
import { ProjectAssetTable, ProjectTable } from '../../schema/drizzle';
import { captureSnapshot } from '../../sync/checkpoint/capture';
import { findActiveSyncGenerationInTransaction } from '../../sync/journal/sync-generation-repository';
import { createLocalObjectRef, sha256Bytes, type Sha256 } from '../../sync/protocol';
import { projectAssetVariantExt } from '../asset-store.service';
import {
  BOOK_FILE_FORMAT,
  BOOK_FILE_VERSION,
  bookFileName,
  encodeBookFile,
  type BookFileAssetV1,
  type BookFileAssetVariantV1,
} from './book-file';

const DERIVED_VARIANTS: readonly ProjectAssetVariant[] = ['display', 'thumbnail'];

export interface BookExportDependencies {
  readonly database: DbClient;
  /** The stored bytes of one variant, or null when this library has none. */
  readonly readAssetVariant: (
    projectId: string,
    asset: ProjectAsset,
    variant: ProjectAssetVariant,
  ) => Promise<Uint8Array | null>;
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface ExportedBook {
  readonly title: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export class BookExportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookExportUnavailableError';
  }
}

export async function exportBook(
  projectId: string,
  dependencies: BookExportDependencies,
): Promise<ExportedBook> {
  const { database } = dependencies;
  const { generation, title, assets } = await database.transaction(async (tx) => {
    const [project] = await tx
      .select({ name: ProjectTable.name })
      .from(ProjectTable)
      .where(eq(ProjectTable.id, projectId))
      .limit(1);
    if (!project) throw new BookExportUnavailableError(`Project ${projectId} does not exist`);
    return {
      title: project.name,
      generation: await findActiveSyncGenerationInTransaction(tx, projectId),
      assets: await tx.select().from(ProjectAssetTable).where(eq(ProjectAssetTable.projectId, projectId)),
    };
  });
  if (!generation) {
    throw new BookExportUnavailableError(`Project ${projectId} has no active SyncGeneration`);
  }

  const assetsById = new Map(assets.map((row) => [row.id, row as ProjectAsset]));
  const sources = new Map<string, Uint8Array>();
  const now = dependencies.now();
  const exportId = `book-export-${dependencies.newId()}`;
  const hlc = { wallMs: now.getTime(), counter: 0 };
  const captured = await captureSnapshot({
    db: database,
    projectId,
    syncGenerationId: generation.syncGenerationId,
    snapshotId: exportId,
    snapshotKind: 'checkpoint',
    packageLogicalKeyId: exportId,
    capturedAt: hlc,
    committedAt: hlc,
    assetPort: {
      async captureCanonicalSource(input) {
        const asset = assetsById.get(input.assetId);
        if (!asset) throw new Error(`Asset ${input.assetId} appeared during export`);
        const bytes = await dependencies.readAssetVariant(projectId, asset, 'source');
        if (!bytes) throw new BookExportUnavailableError(`Asset ${input.assetId} is missing its source`);
        const sourceSha256: Sha256 = await sha256Bytes(bytes);
        sources.set(input.assetId, bytes);
        return {
          blobId: sourceSha256,
          // Never staged: the reference only names the bytes this export holds.
          sourceRef: createLocalObjectRef(`syncobj:book-export.${input.assetId}`),
          sourceSha256,
          sizeBytes: bytes.byteLength,
          mimeType: asset.sourceMime,
        };
      },
    },
  });

  const fileAssets: BookFileAssetV1[] = [];
  for (const entry of captured.assets) {
    const asset = assetsById.get(entry.asset.assetId)!;
    const variants: BookFileAssetVariantV1[] = [{
      variant: 'source',
      ext: projectAssetVariantExt(asset, 'source'),
      bytes: sources.get(asset.id)!,
    }];
    for (const variant of DERIVED_VARIANTS) {
      // Display and thumbnail are rebuildable; a library without them still exports.
      const bytes = await dependencies.readAssetVariant(projectId, asset, variant).catch(() => null);
      if (bytes && bytes.byteLength > 0) {
        variants.push({ variant, ext: projectAssetVariantExt(asset, variant), bytes });
      }
    }
    fileAssets.push({ assetId: asset.id, variants });
  }

  return {
    title,
    fileName: bookFileName(title),
    bytes: encodeBookFile({
      format: BOOK_FILE_FORMAT,
      version: BOOK_FILE_VERSION,
      exportedAt: now.toISOString(),
      title,
      packageBytes: captured.packageBytes,
      commitMarkerBytes: captured.commitMarkerBytes,
      assets: fileAssets,
    }),
  };
}
