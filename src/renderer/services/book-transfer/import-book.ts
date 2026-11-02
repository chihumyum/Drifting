// Import a `.driftingbook` file as a new book in the open library
// (docs/book-transfer.md). The package is validated exactly as a cloud
// restore validates it; then every identity is replaced, so the copy shares
// no id with its original (or with an earlier import of the same file). The
// rows, the reseeded prose, the verified asset receipts and the replayed
// authored change-sets commit in one SQLite transaction: the book appears
// whole or not at all. A new SyncGeneration makes an account library publish
// it like any book written there.
import { eq } from 'drizzle-orm';

import type { ProjectAsset, ProjectAssetKind, ProjectAssetVariant } from '../../domain/project-asset';
import type { DbClient } from '../../lib/db';
import { ProjectTable } from '../../schema/drizzle';
import { recordVerifiedLocalAssetBlobInTransaction } from '../../sync/assets/local-authored-blob';
import {
  materializeAuthoredTablesV1,
  materializeNormalizedAuthoredProjectionsV1,
} from '../../sync/checkpoint/domain-catalog';
import type { SnapshotTableRowsV1 } from '../../sync/checkpoint/types';
import { validateSnapshotForRestore, type ValidatedSnapshot } from '../../sync/checkpoint/validate';
import type { PreparedOutboundSyncBlob, SyncEngineBlobPort } from '../../sync/engine/blob-port';
import {
  defaultSyncGenerationIdSource,
  ensureActiveSyncGenerationInTransaction,
  recordAuthoredChangeSetInTransaction,
  SyncChangeBuilder,
  type AuthoredCommitEvent,
  type SyncGenerationIdSource,
  type SyncJournalClock,
  type SyncWriterIdentitySource,
} from '../../sync/journal';
import { appendAuthoredDocumentSeedInTransaction } from '../../sync/journal/yjs-update';
import { committedProseDocIds } from '../../sync/prose-change-scope';
import {
  decodeSnapshotCommitMarkerV1,
  sha256Bytes,
  type LocalObjectRef,
} from '../../sync/protocol';
import {
  invalidateSqliteReducerStateCache,
  observeLocalAuthoredReducerInTransaction,
  productionSyncDomainMaterializationKernel,
} from '../../sync/reducer';
import { parseDocId } from '../../lib/yjs-doc-id';
import { projectAssetVariantExt } from '../asset-store.service';
import { BookFileError, decodeBookFile, type BookFileErrorCode, type BookFileV1 } from './book-file';
import {
  createBookIdRewriter,
  rewriteAuthoredTables,
  rewriteYjsState,
} from './id-rewriter';
import { planBookReplay } from './reducer-replay';

export interface BookImportAssetStore {
  beginImport(projectId: string, assetId: string): Promise<unknown>;
  writeBytes(
    projectId: string,
    assetId: string,
    variant: ProjectAssetVariant,
    ext: string,
    bytes: Uint8Array,
  ): Promise<unknown>;
  commitImport(projectId: string, assetId: string): Promise<unknown>;
  deleteAsset(projectId: string, assetId: string): Promise<unknown>;
}

export interface BookImportDependencies {
  readonly database: DbClient;
  readonly localUserId: string;
  readonly identity: () => Promise<SyncWriterIdentitySource>;
  readonly clock: () => SyncJournalClock;
  readonly newId: () => string;
  readonly syncGenerationIds?: SyncGenerationIdSource;
  readonly assetStore: BookImportAssetStore;
  readonly blobPort: Pick<SyncEngineBlobPort, 'prepareOutbound'>;
  readonly discardLocalObject: (sourceRef: LocalObjectRef) => Promise<void>;
  /** Refuses a book the account's storage cannot hold, before anything is written. */
  readonly assertStorageAllows?: (bytes: number) => Promise<void>;
  /** Wraps the activation transaction, as authored writes are tracked for quit. */
  readonly trackTransaction?: <T>(operation: Promise<T>) => Promise<T>;
  readonly onCommitted?: (event: AuthoredCommitEvent) => void;
  readonly warn?: (message: string, error: unknown) => void;
}

/** `invalid`: the package fails validation; `failed`: writing it here did. */
export type BookImportErrorCode = BookFileErrorCode | 'invalid' | 'failed';

export class BookImportError extends Error {
  constructor(
    readonly code: BookImportErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BookImportError';
  }
}

export interface ImportedBook {
  readonly projectId: string;
  readonly title: string;
  /** Source id → the copy's id, for every rewritten identity. */
  readonly identities: ReadonlyMap<string, string>;
}

type ValidatedSnapshotV2 = Extract<ValidatedSnapshot, { payloadVersion: 2 }>;

async function validatedPackage(file: BookFileV1): Promise<ValidatedSnapshotV2> {
  const marker = decodeSnapshotCommitMarkerV1(file.commitMarkerBytes);
  if (!marker.ok) throw new BookImportError('invalid', `The book's snapshot marker is invalid: ${marker.reason}`);
  let validated: ValidatedSnapshot;
  try {
    validated = await validateSnapshotForRestore({
      packageBytes: file.packageBytes,
      commitMarkerBytes: file.commitMarkerBytes,
      expected: {
        projectId: marker.value.projectId,
        projectSyncId: marker.value.projectSyncId,
        syncGenerationId: marker.value.syncGenerationId,
      },
    });
  } catch (error) {
    throw new BookImportError('invalid', 'The book package failed validation', error);
  }
  if (validated.payloadVersion !== 2) {
    throw new BookImportError('invalid', 'The book package predates compacted reducer state');
  }
  return validated;
}

function tableRows(tables: readonly SnapshotTableRowsV1[], name: string) {
  return tables.find((entry) => entry.table === name)?.rows ?? [];
}

/** The project row arrives live whatever its source state; the copy is never trashed. */
function liveProject(tables: SnapshotTableRowsV1[]): SnapshotTableRowsV1[] {
  return tables.map((entry) =>
    entry.table === 'project'
      ? { table: entry.table, rows: entry.rows.map((row) => ({ ...row, deleted_at: null })) }
      : entry,
  );
}

export async function importBook(
  bytes: Uint8Array,
  dependencies: BookImportDependencies,
): Promise<ImportedBook> {
  let file: BookFileV1;
  try {
    file = decodeBookFile(bytes);
  } catch (error) {
    if (error instanceof BookFileError) throw new BookImportError(error.code, error.message, error);
    throw error;
  }
  const validated = await validatedPackage(file);

  const fileAssets = new Map(file.assets.map((asset) => [asset.assetId, asset]));
  for (const asset of validated.package.assets) {
    const source = fileAssets.get(asset.assetId)?.variants.find((entry) => entry.variant === 'source');
    if (
      !source ||
      source.bytes.byteLength !== asset.sizeBytes ||
      (await sha256Bytes(source.bytes)) !== asset.sourceSha256
    ) {
      throw new BookImportError('invalid', `The bytes of asset ${asset.assetId} do not match the book`);
    }
  }

  const rewriter = createBookIdRewriter(validated.authored.tables, dependencies.newId);
  const tables = liveProject(rewriteAuthoredTables(validated.authored.tables, rewriter));
  const projectId = rewriter.string(validated.package.projectId);
  let plan: ReturnType<typeof planBookReplay>;
  try {
    plan = planBookReplay(validated.reducer.state, tables, rewriter);
  } catch (error) {
    throw new BookImportError('invalid', 'The book state cannot be replayed', error);
  }
  const title = String(tableRows(tables, 'project')[0]?.name ?? file.title);
  const prose = validated.package.proseDocuments.flatMap((document) => {
    if (document.mode !== 'full-state') return [];
    const docId = rewriter.string(document.documentId);
    const parsed = parseDocId(docId);
    const owner = parsed && (parsed.kind === 'node-content' ? 'node' : parsed.kind === 'category' ? 'element-category' : parsed.kind);
    if (!parsed || !owner || !plan.carries(owner, parsed.entityId)) return [];
    return [{ docId, state: rewriteYjsState(document.state, rewriter) }];
  });

  const clock = dependencies.clock();
  const assets = validated.package.assets.map((source) => {
    const row = tableRows(tables, 'project_asset').find((candidate) => candidate.id === rewriter.string(source.assetId))!;
    const asset: ProjectAsset = {
      id: String(row.id),
      projectId,
      kind: row.kind as ProjectAssetKind,
      sourceMime: String(row.source_mime),
      sourceSizeBytes: Number(row.source_size_bytes),
      sourceSha256: String(row.source_sha256),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      createdAt: clock.nowIso,
    };
    return { asset, variants: fileAssets.get(source.assetId)!.variants };
  });
  await dependencies.assertStorageAllows?.(
    assets.reduce((total, { asset }) => total + asset.sourceSizeBytes, 0),
  );

  const generationIds = dependencies.syncGenerationIds ?? defaultSyncGenerationIdSource;
  const projectSyncId = generationIds.createProjectSyncId();
  const syncGenerationId = generationIds.createSyncGenerationId();
  const written: string[] = [];
  const prepared: { asset: ProjectAsset; blob: PreparedOutboundSyncBlob }[] = [];
  try {
    for (const { asset, variants } of assets) {
      await dependencies.assetStore.beginImport(projectId, asset.id);
      written.push(asset.id);
      for (const { variant, bytes: variantBytes } of variants) {
        await dependencies.assetStore.writeBytes(
          projectId,
          asset.id,
          variant,
          projectAssetVariantExt(asset, variant),
          variantBytes,
        );
      }
      const blobId = `sha256:${asset.sourceSha256}` as const;
      const blob = await dependencies.blobPort.prepareOutbound({
        syncGenerationId,
        projectId,
        declaration: {
          assetId: asset.id,
          blobId,
          sourceSha256: blobId,
          sourceSizeBytes: asset.sourceSizeBytes,
          sourceMime: asset.sourceMime,
        },
      });
      prepared.push({ asset, blob });
    }

    const identity = await dependencies.identity();
    const activation = dependencies.database.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, projectId))
        .limit(1);
      if (existing) throw new Error(`Imported project ${projectId} already exists`);
      await materializeAuthoredTablesV1(tx, tables, {
        nowIso: clock.nowIso,
        localUserId: dependencies.localUserId,
      });
      const generation = await ensureActiveSyncGenerationInTransaction(tx, {
        projectId,
        nowIso: clock.nowIso,
        ids: {
          createProjectSyncId: () => projectSyncId,
          createSyncGenerationId: () => syncGenerationId,
        },
      });
      if (generation.syncGenerationId !== syncGenerationId) {
        throw new Error('The imported project was bound to another SyncGeneration');
      }
      for (const { asset, blob } of prepared) {
        await recordVerifiedLocalAssetBlobInTransaction(tx, {
          syncGenerationId,
          asset,
          prepared: blob,
          nowIso: clock.nowIso,
        });
      }

      const creates = new SyncChangeBuilder();
      for (const mutation of plan.creates) creates.add(mutation);
      for (const document of prose) {
        await appendAuthoredDocumentSeedInTransaction(tx, creates, {
          docId: document.docId,
          stateUpdate: document.state,
        });
      }
      const builders = [creates];
      if (plan.trashes.length > 0) {
        const trashes = new SyncChangeBuilder();
        for (const mutation of plan.trashes) trashes.add(mutation);
        builders.push(trashes);
      }
      const events: AuthoredCommitEvent[] = [];
      for (const [index, builder] of builders.entries()) {
        // Projections are rebuilt while every entity is live, as the source
        // built them before trashing; a trash leaves them as they were.
        if (index === 1) await materializeNormalizedAuthoredProjectionsV1(tx, { projectId, syncGenerationId });
        const recorded = await recordAuthoredChangeSetInTransaction(
          tx,
          { projectId, projectSyncId: generation.projectSyncId, syncGenerationId, identity, clock },
          builder,
        );
        await observeLocalAuthoredReducerInTransaction(tx, {
          changeSet: recorded.changeSet,
          clock,
          validator: productionSyncDomainMaterializationKernel,
        });
        events.push({
          command: 'project.import',
          projectId,
          syncGenerationId,
          changeSetId: recorded.changeSet.changeSetId,
          proseDocIds: committedProseDocIds(recorded.changeSet.mutations),
        });
      }
      if (builders.length === 1) {
        await materializeNormalizedAuthoredProjectionsV1(tx, { projectId, syncGenerationId });
      }
      return events;
    });
    const events = await (dependencies.trackTransaction?.(activation) ?? activation);

    for (const assetId of written) {
      await dependencies.assetStore.commitImport(projectId, assetId).catch((error: unknown) => {
        dependencies.warn?.('[book-import] Asset import marker was not cleared', error);
      });
    }
    for (const event of events) dependencies.onCommitted?.(event);
    return { projectId, title, identities: rewriter.ids };
  } catch (error) {
    // The rolled-back generation never existed; forget any reducer state cached for it.
    invalidateSqliteReducerStateCache(syncGenerationId);
    for (const { blob } of prepared) {
      await dependencies.discardLocalObject(blob.sourceRef).catch(() => undefined);
    }
    for (const assetId of written) {
      await dependencies.assetStore.deleteAsset(projectId, assetId).catch(() => undefined);
    }
    if (error instanceof BookImportError) throw error;
    throw new BookImportError('failed', 'The book could not be imported', error);
  }
}
