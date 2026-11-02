// Moving one book between libraries (docs/book-transfer.md): export writes a
// `.driftingbook` file the author saves anywhere; import, run explicitly in the
// library that should receive it, adds the book as a new one. Only one library
// is open per process, so the file is the carrier between them.
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';

import type { ProjectAsset, ProjectAssetVariant } from '../../domain/project-asset';
import { getDb } from '../../lib/db';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { platform } from '../../platform';
import { LOCAL_USER_ID } from '../../store/auth';
import { nativeSyncAssetBlobPort } from '../../sync/assets/native-asset-pipeline';
import { assertHostedQuotaAllows } from '../../sync/hosted/quota';
import {
  getSyncInstallationIdentity,
  notifyAuthoredChangeCommitted,
} from '../../sync/journal';
import { nativeSyncObjectCodec } from '../../sync/native-object-codec';
import { assetStoreService, projectAssetVariantExt } from '../asset-store.service';
import { trackAtomicSyncTransaction } from '../atomic-sync-transaction-tracker';
import { exportBook } from './export-book';
import { importBook, type ImportedBook } from './import-book';

const log = loglevel.getLogger('BookTransfer');

async function readAssetVariant(
  projectId: string,
  asset: ProjectAsset,
  variant: ProjectAssetVariant,
): Promise<Uint8Array | null> {
  const stored = await assetStoreService.getPath(projectId, asset.id, variant, projectAssetVariantExt(asset, variant));
  if (!stored) return null;
  const read = await platform.material.readBytes(stored.filePath);
  if (!read.ok) throw new Error(read.error);
  return new Uint8Array(read.bytes);
}

/** Export one book and ask where to save it; false when the author cancels. */
export async function exportBookToFile(projectId: string): Promise<boolean> {
  // Edits still on their way to SQLite belong in the file.
  await flushLocalApplicationPersistence();
  const book = await exportBook(projectId, {
    database: getDb(),
    readAssetVariant,
    newId: uuidv7,
    now: () => new Date(),
  });
  const { saved } = await platform.bookTransfer.save(book.fileName, book.bytes);
  if (saved) log.info(`[book-transfer] Exported ${book.bytes.byteLength} bytes`);
  return saved;
}

/**
 * Pick a book file and add it to the open library; null when the author
 * cancels. `onPicked` runs once a file is chosen, before the import starts.
 */
export async function importBookFromFile(onPicked?: () => void): Promise<ImportedBook | null> {
  const bytes = await platform.bookTransfer.open();
  if (!bytes) return null;
  onPicked?.();
  const imported = await importBook(bytes, {
    database: getDb(),
    localUserId: LOCAL_USER_ID,
    identity: getSyncInstallationIdentity,
    clock: () => {
      const now = new Date();
      return { nowMs: now.getTime(), nowIso: now.toISOString() };
    },
    newId: uuidv7,
    assetStore: assetStoreService,
    blobPort: nativeSyncAssetBlobPort,
    discardLocalObject: (sourceRef) => nativeSyncObjectCodec.discardLocal?.(sourceRef) ?? Promise.resolve(),
    assertStorageAllows: (bytes) => assertHostedQuotaAllows(bytes),
    trackTransaction: trackAtomicSyncTransaction,
    onCommitted: notifyAuthoredChangeCommitted,
    warn: (message, error) => log.warn(message, error),
  });
  log.info(`[book-transfer] Imported ${bytes.byteLength} bytes as ${imported.projectId}`);
  return imported;
}
