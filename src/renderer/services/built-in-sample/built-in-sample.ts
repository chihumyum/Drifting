// The built-in sample project (docs/sample-project.md). A brand-new local
// library gets Pride and Prejudice, taken apart into a working project, once.
// It is written in a few authored transactions through the same repositories
// and journal as the author's own actions (./write-sample.ts), so the sample
// is an ordinary project: SQLite rows, live Yjs prose and app-owned asset
// bytes. A durable `library_state` marker makes it once-only per library;
// deleting the sample never brings it back.

import { eq, inArray } from 'drizzle-orm';
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';

import type { ProjectAsset, ProjectAssetVariant } from '../../domain/project-asset';
import { getDb, type DbClient } from '../../lib/db';
import {
  ProjectTable,
  SyncAppAuthorityTable,
  SyncGenerationTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
} from '../../schema/drizzle';
import { createLibraryStateRepository } from '../../sqlite-repo/library-state-repo';
import {
  deleteProjectDataInTransaction,
  type ProjectDeletionReceipt,
} from '../../sqlite-repo/project-deletion-repo';
import { LOCAL_USER_ID } from '../../store/auth';
import { ensureLocalAuthoredAssetBlobVerified } from '../../sync/assets/local-authored-blob';
import type { BookNodeAtomicTransactionRunner } from '../../usecase/book-node-write';
import { createProjectInTransaction } from '../../usecase/project-create';
import { withAtomicSyncTransaction } from '../../usecase/sync-helpers';
import { assetStoreService } from '../asset-store.service';
import { BOOK_ILLUSTRATIONS, type BookIllustration } from './book';
import { useBuiltInSampleStore } from './first-run';
import { SAMPLE_PROJECT_NAME } from './showcase';
import { writeBookSample, type ImportedSampleAsset } from './write-sample';

export type { ImportedSampleAsset } from './write-sample';

const log = loglevel.getLogger('BuiltInSample');

export const BUILT_IN_SAMPLE_STATE_KEY = 'built-in-sample';
/** The recipe a library received; recorded for diagnostics and later recipes. */
export const BUILT_IN_SAMPLE_RECIPE = 'pride-and-prejudice-v1';
/** Interrupted or failed attempts are retried on later launches up to this many times. */
export const BUILT_IN_SAMPLE_MAX_ATTEMPTS = 3;

export interface BuiltInSampleMarker {
  /**
   * `creating`: claimed, not complete (or interrupted by a quit).
   * `created`: published once; never created again, even after deletion.
   * `failed`: the attempt was rolled back; retried while attempts remain.
   * `skipped`: the library had other content, or attempts ran out.
   */
  status: 'creating' | 'created' | 'failed' | 'skipped';
  recipe: string;
  projectId: string | null;
  attempts: number;
  reason?: string;
  /** Wall-clock milliseconds the created sample took, for diagnostics. */
  durationMs?: number;
  /** Milliseconds per step (`…At` steps are offsets from the start of writing). */
  steps?: Record<string, number>;
  updatedAt: string;
}

export type BuiltInSampleOutcome =
  | { kind: 'created'; projectId: string; durationMs: number }
  | { kind: 'skipped'; reason: 'already-created' | 'not-a-new-library' | 'attempts-exhausted' }
  | { kind: 'failed'; error: unknown };

export interface BuiltInSampleDependencies {
  database(): DbClient;
  userId: string;
  /** The authored transaction runner (the app's own sync identity). */
  runAtomic: BookNodeAtomicTransactionRunner;
  importAsset(projectId: string, illustration: BookIllustration): Promise<ImportedSampleAsset>;
  /** Remove an unpublished (never connected) partial sample completely. */
  discardProject(projectId: string): Promise<void>;
  now(): string;
  newId(): string;
  /** Diagnostics: one step of the sample and how long it took. */
  onStep?(step: string, milliseconds: number): void;
}

class LibraryNoLongerNew extends Error {}

/** Any project row (live or in the trash), cloud account or provider transition. */
async function libraryHasContent(database: DbClient): Promise<boolean> {
  const [project] = await database.select({ id: ProjectTable.id }).from(ProjectTable).limit(1);
  if (project) return true;
  const [authority] = await database.select().from(SyncAppAuthorityTable).limit(1);
  if (authority && (authority.mode !== 'local' || authority.transitionState !== 'stable')) return true;
  const [account] = await database
    .select({ id: SyncProviderAccountTable.id })
    .from(SyncProviderAccountTable)
    .limit(1);
  return Boolean(account);
}

async function projectExists(database: DbClient, projectId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: ProjectTable.id })
    .from(ProjectTable)
    .where(eq(ProjectTable.id, projectId))
    .limit(1);
  return Boolean(row);
}

/**
 * Import every bundled illustration at once, alongside the sample's
 * transactions: each import's receipt transaction then queues behind the
 * current sample transaction instead of behind the previous import. Every
 * import settles before this resolves or rejects, so `imported` lists exactly
 * the files to abandon on failure.
 */
async function importIllustrations(
  dependencies: BuiltInSampleDependencies,
  projectId: string,
  imported: ImportedSampleAsset[],
): Promise<ReadonlyMap<string, ImportedSampleAsset>> {
  const byName = new Map<string, ImportedSampleAsset>();
  const results = await Promise.allSettled(BOOK_ILLUSTRATIONS.map(async (illustration) => {
    const entry = await dependencies.importAsset(projectId, illustration);
    imported.push(entry);
    byName.set(illustration.name, entry);
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw (failure as PromiseRejectedResult).reason;
  return byName;
}

/**
 * Create the built-in sample when this library is new, exactly once. A
 * library that already has (or had, per the marker) any project, a cloud
 * account or a provider transition is never touched. Failures roll the
 * partial sample back and resolve as `failed`; nothing here throws.
 */
export async function ensureBuiltInSampleProject(
  dependencies: BuiltInSampleDependencies = defaultBuiltInSampleDependencies(),
): Promise<BuiltInSampleOutcome> {
  const store = useBuiltInSampleStore;
  store.setState({ phase: 'checking' });
  let database: DbClient;
  let marker: BuiltInSampleMarker | null;
  try {
    database = dependencies.database();
    marker = await createLibraryStateRepository(database).read<BuiltInSampleMarker>(BUILT_IN_SAMPLE_STATE_KEY);
  } catch (error) {
    return { kind: 'failed', error };
  }
  const state = createLibraryStateRepository(database);
  const writeMarker = (value: Omit<BuiltInSampleMarker, 'recipe' | 'updatedAt'>) => {
    const updatedAt = dependencies.now();
    return state.write<BuiltInSampleMarker>(
      BUILT_IN_SAMPLE_STATE_KEY,
      { ...value, recipe: BUILT_IN_SAMPLE_RECIPE, updatedAt },
      updatedAt,
    );
  };
  if (marker?.status === 'created') return { kind: 'skipped', reason: 'already-created' };
  if (marker?.status === 'skipped') {
    return { kind: 'skipped', reason: marker.reason === 'attempts-exhausted' ? 'attempts-exhausted' : 'not-a-new-library' };
  }
  let attempts = marker?.attempts ?? 0;
  try {
    // An earlier attempt was interrupted (quit mid-way) or could not clean up
    // after itself. Its project was never shown; remove it before deciding.
    if (marker?.projectId && (marker.status === 'creating' || marker.status === 'failed')) {
      store.setState({ pendingProjectId: marker.projectId });
      if (await projectExists(database, marker.projectId)) await dependencies.discardProject(marker.projectId);
      store.setState({ pendingProjectId: null });
    }
    if (await libraryHasContent(database)) {
      await writeMarker({ status: 'skipped', projectId: null, attempts, reason: 'not-a-new-library' });
      return { kind: 'skipped', reason: 'not-a-new-library' };
    }
    if (attempts >= BUILT_IN_SAMPLE_MAX_ATTEMPTS) {
      await writeMarker({ status: 'skipped', projectId: null, attempts, reason: 'attempts-exhausted' });
      return { kind: 'skipped', reason: 'attempts-exhausted' };
    }
  } catch (error) {
    return { kind: 'failed', error };
  }

  const projectId = dependencies.newId();
  attempts += 1;
  const { runAtomic } = dependencies;
  const started = performance.now();
  const steps: Record<string, number> = {};
  const onStep = (step: string, milliseconds: number) => {
    steps[step] = Math.round(milliseconds);
    dependencies.onStep?.(step, milliseconds);
  };
  store.setState({ phase: 'creating', pendingProjectId: projectId });
  let claimed = false;
  const imported: ImportedSampleAsset[] = [];
  let assets: Promise<ReadonlyMap<string, ImportedSampleAsset>> | null = null;
  try {
    const now = dependencies.now();
    // The project row and the claim commit together: a later launch either
    // sees no project and no claim, or a claim naming this partial project.
    await runAtomic(projectId, async (tx, sync, changes) => {
      const [other] = await tx.select({ id: ProjectTable.id }).from(ProjectTable).limit(1);
      if (other) throw new LibraryNoLongerNew();
      await createProjectInTransaction(tx, sync, changes, {
        projectId,
        userId: dependencies.userId,
        name: SAMPLE_PROJECT_NAME,
        now,
      });
      await createLibraryStateRepository(tx).write<BuiltInSampleMarker>(
        BUILT_IN_SAMPLE_STATE_KEY,
        { status: 'creating', recipe: BUILT_IN_SAMPLE_RECIPE, projectId, attempts, updatedAt: now },
        now,
      );
    });
    claimed = true;
    onStep('claim', performance.now() - started);

    assets = importIllustrations(dependencies, projectId, imported);
    assets.catch(() => undefined);
    await writeBookSample({
      database,
      projectId,
      userId: dependencies.userId,
      runAtomic,
      now: dependencies.now,
      newId: dependencies.newId,
      assets,
      onStep,
    });
    for (const entry of imported) {
      await entry.commit().catch((error) => log.warn('[sample] Asset import marker was not cleared', error));
    }
    const durationMs = Math.round(performance.now() - started);
    await writeMarker({ status: 'created', projectId, attempts, durationMs, steps });
    store.setState({ pendingProjectId: null, createdProjectId: projectId });
    log.info(`[sample] Built-in sample created in ${durationMs} ms`);
    return { kind: 'created', projectId, durationMs };
  } catch (error) {
    // Imports still in flight finish first, so every imported file is abandoned.
    await assets?.catch(() => undefined);
    for (const entry of imported) await entry.abandon().catch(() => undefined);
    if (error instanceof LibraryNoLongerNew) {
      store.setState({ pendingProjectId: null });
      await writeMarker({ status: 'skipped', projectId: null, attempts: attempts - 1, reason: 'not-a-new-library' })
        .catch((markerError) => log.warn('[sample] Could not record the skipped sample', markerError));
      return { kind: 'skipped', reason: 'not-a-new-library' };
    }
    if (claimed) {
      try {
        if (await projectExists(database, projectId)) await dependencies.discardProject(projectId);
        store.setState({ pendingProjectId: null });
      } catch (cleanupError) {
        // Keep it hidden; the next launch removes it before retrying.
        log.warn('[sample] The partial sample project could not be removed yet', cleanupError);
      }
      await writeMarker({
        status: 'failed',
        projectId,
        attempts,
        reason: error instanceof Error ? error.message : String(error),
      }).catch((markerError) => log.warn('[sample] Could not record the failed sample', markerError));
    } else {
      store.setState({ pendingProjectId: null });
    }
    return { kind: 'failed', error };
  }
}

// ── App dependencies ────────────────────────────────────────────────────────

const bundledFileUrls = import.meta.glob('./pride-and-prejudice/*.jpg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A bundled illustration file, verified against the checked-in manifest. */
async function bundledFileBytes(file: string, sha256: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = bundledFileUrls[`./pride-and-prejudice/${file}`];
  if (!url) throw new Error(`Sample file ${file} is not bundled`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Sample file ${file} could not be read (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256Hex(bytes)) !== sha256) throw new Error(`Sample file ${file} failed its integrity check`);
  return bytes;
}

/**
 * Import one illustration as the app imports an image: source and prebuilt
 * preview bytes into the native asset store, then the verified local blob
 * receipt the asset.bind mutation requires. No image codec runs.
 */
async function importBundledIllustration(
  projectId: string,
  illustration: BookIllustration,
): Promise<ImportedSampleAsset> {
  const source = await bundledFileBytes(illustration.source, illustration.sha256);
  if (source.byteLength !== illustration.sizeBytes) throw new Error(`Sample file ${illustration.source} has the wrong size`);
  const variants = await Promise.all(
    Object.entries(illustration.variants).map(async ([variant, metadata]) => ({
      variant: variant as ProjectAssetVariant,
      bytes: metadata.file === illustration.source ? source : await bundledFileBytes(metadata.file, metadata.sha256),
    })),
  );
  const assetId = uuidv7();
  const abandon = () => assetStoreService.deleteAsset(projectId, assetId);
  await assetStoreService.beginImport(projectId, assetId);
  try {
    await assetStoreService.writeBytes(projectId, assetId, 'source', 'jpg', source);
    for (const { variant, bytes } of variants) {
      await assetStoreService.writeBytes(projectId, assetId, variant, 'jpg', bytes);
    }
    const asset: ProjectAsset = {
      id: assetId,
      projectId,
      kind: 'image',
      sourceMime: illustration.mime,
      sourceSizeBytes: source.byteLength,
      sourceSha256: illustration.sha256,
      width: illustration.width,
      height: illustration.height,
      createdAt: new Date().toISOString(),
    };
    await ensureLocalAuthoredAssetBlobVerified(asset);
    return { asset, commit: () => assetStoreService.commitImport(projectId, assetId), abandon };
  } catch (error) {
    await abandon().catch(() => undefined);
    throw error;
  }
}

/**
 * Delete a partial sample's rows. It never reached a cloud account (Hosted
 * connect waits for the sample), so this refuses a project with any provider
 * binding instead of asking Hosted to delete it.
 */
export async function purgeUnpublishedSampleProject(
  database: DbClient,
  projectId: string,
): Promise<ProjectDeletionReceipt | null> {
  return database.transaction(async (tx) => {
    const generations = await tx
      .select({ id: SyncGenerationTable.syncGenerationId })
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.projectId, projectId));
    const ids = generations.map((generation) => generation.id);
    if (ids.length) {
      const [binding] = await tx
        .select({ id: SyncProviderBindingTable.syncGenerationId })
        .from(SyncProviderBindingTable)
        .where(inArray(SyncProviderBindingTable.syncGenerationId, ids))
        .limit(1);
      if (binding) throw new Error('The partial sample project is bound to a cloud account');
    }
    const deleted = await deleteProjectDataInTransaction(tx, projectId);
    if (ids.length) {
      const now = new Date().toISOString();
      await tx
        .update(SyncGenerationTable)
        .set({ status: 'purged', purgedAt: now, updatedAt: now })
        .where(inArray(SyncGenerationTable.syncGenerationId, ids));
    }
    return deleted;
  });
}

/** The rows, then the asset files and renderer traces, as a permanent delete does. */
async function discardUnpublishedSampleProject(projectId: string): Promise<void> {
  const receipt = await purgeUnpublishedSampleProject(getDb(), projectId);
  if (!receipt) return;
  const { cleanupDeletedProject } = await import('../project-deletion-cleanup');
  await cleanupDeletedProject(projectId, receipt);
}

export function defaultBuiltInSampleDependencies(): BuiltInSampleDependencies {
  return {
    database: getDb,
    userId: LOCAL_USER_ID,
    runAtomic: withAtomicSyncTransaction,
    importAsset: importBundledIllustration,
    discardProject: discardUnpublishedSampleProject,
    now: () => new Date().toISOString(),
    newId: uuidv7,
    onStep: (step, milliseconds) => log.info(`[sample] ${step}: ${Math.round(milliseconds)} ms`),
  };
}
