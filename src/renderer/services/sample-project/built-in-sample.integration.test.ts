import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectAsset } from '../../domain/project-asset';
import type { DbClient } from '../../lib/db';
import { installHeadlessRendererGlobals } from '../../../dev-cli/headless-globals';

// Renderer stores read browser storage when their modules load.
installHeadlessRendererGlobals();
const { OfflineProductDatabase } = await import('../../../dev-cli/offline-database');
const { createAtomicRunner, createDevCliAgentAuthoredJournal } = await import('../../../dev-cli/offline-workspace');
const { auditDevelopmentSeed } = await import('../../../dev-cli/seeds/audit');
const {
  BUILT_IN_SAMPLE_MAX_ATTEMPTS,
  BUILT_IN_SAMPLE_STATE_KEY,
  ensureBuiltInSampleProject,
  purgeUnpublishedSampleProject,
} = await import('./built-in-sample');
const { resetBuiltInSampleForTests, startBuiltInSampleProject, useBuiltInSampleStore, waitForBuiltInSampleProject, withoutPendingSampleProject } =
  await import('./first-run');
const { SAMPLE_ASSET_FIXTURES } = await import('./materials');
const { SEED_PRESETS } = await import('./presets');
const { BUILT_IN_SAMPLE_PROJECT_NAME } = await import('./scenario');
const { LOCAL_USER_ID } = await import('../../store/auth');
const { useDataStore } = await import('../../store/data-store');
const { useProjectStore } = await import('../../store/project-store');
const { ensureLocalAuthoredAssetBlobVerified } = await import('../../sync/assets/local-authored-blob');
const { createLocalObjectRef, sha256Bytes } = await import('../../sync/protocol');
const { createSyncAppAuthorityRepository } = await import('../../sync/app-authority-repository');
const { invalidateSqliteReducerStateCache } = await import('../../sync/reducer/sqlite-materializer');
const { createProjectInTransaction } = await import('../../usecase/project-create');

type Library = InstanceType<typeof OfflineProductDatabase>;
type Dependencies = NonNullable<Parameters<typeof ensureBuiltInSampleProject>[0]>;
type Fixture = (typeof SAMPLE_ASSET_FIXTURES)[number];

const directories: string[] = [];
const libraries: Library[] = [];
const liteEvidence = (JSON.parse(
  readFileSync(new URL('../../../../docs/dev-cli/acceptance/seed-presets.json', import.meta.url), 'utf8'),
) as { results: { lite: { bodies: Record<string, { corpusSha256: string }> } } }).results.lite;

afterEach(async () => {
  for (const library of libraries.splice(0)) await library.close();
  invalidateSqliteReducerStateCache();
  resetBuiltInSampleForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openLibrary(): Promise<Library> {
  const directory = mkdtempSync(join(tmpdir(), 'drifting-built-in-sample-'));
  directories.push(directory);
  const library = new OfflineProductDatabase(join(directory, 'drifting-library.db'), { migrate: true });
  await library.open();
  libraries.push(library);
  return library;
}

/** The app imports bytes into the native asset store; here only the verified receipt is real. */
function memoryAssetImporter(database: DbClient, events: string[]) {
  return async (projectId: string, fixture: Fixture) => {
    const id = uuidv7();
    const asset: ProjectAsset = {
      id, projectId, kind: fixture.kind,
      sourceMime: fixture.kind === 'image' ? 'image/png' : 'application/pdf',
      sourceSizeBytes: fixture.sizeBytes, sourceSha256: fixture.sha256,
      width: fixture.width, height: fixture.height, createdAt: new Date().toISOString(),
    };
    await ensureLocalAuthoredAssetBlobVerified(asset, {
      database: () => database,
      nowIso: () => new Date().toISOString(),
      discardLocal: async () => undefined,
      blobPort: {
        async prepareOutbound({ syncGenerationId }) {
          const hash = `sha256:${fixture.sha256}` as const;
          return {
            sourceRef: createLocalObjectRef(`syncobj:${id}`),
            logicalKeyId: await sha256Bytes(new TextEncoder().encode(`blob/${syncGenerationId}/${hash}`)),
            storedSha256: hash, contentSha256: hash, sizeBytes: fixture.sizeBytes,
          };
        },
      },
    });
    return {
      asset,
      commit: async () => { events.push(`commit:${fixture.name}`); },
      abandon: async () => { events.push(`abandon:${fixture.name}`); },
    };
  };
}

function dependencies(library: Library, overrides: Partial<Dependencies> = {}, assetEvents: string[] = []): Dependencies {
  return {
    database: () => library.client,
    userId: LOCAL_USER_ID,
    writer: () => ({ runAtomic: createAtomicRunner(library.client), authoredJournal: createDevCliAgentAuthoredJournal() }),
    importAsset: memoryAssetImporter(library.client, assetEvents),
    discardProject: async (projectId) => { await purgeUnpublishedSampleProject(library.client, projectId); },
    now: () => new Date().toISOString(),
    newId: uuidv7,
    ...overrides,
  };
}

function rows<T>(library: Library, sql: string, ...parameters: string[]): T[] {
  return library.gateway.database.prepare(sql).all(...parameters) as T[];
}

function count(library: Library, sql: string): number {
  return Number((library.gateway.database.prepare(sql).get() as { n: number }).n);
}

function marker(library: Library) {
  const [row] = rows<{ json: string }>(library, 'SELECT value_json AS json FROM library_state WHERE key = ?', BUILT_IN_SAMPLE_STATE_KEY);
  return row ? JSON.parse(row.json) as { status: string; projectId: string | null; attempts: number; reason?: string } : null;
}

async function createAuthorProject(library: Library, projectId: string, name: string) {
  await createAtomicRunner(library.client)(projectId, (tx, sync, changes) =>
    createProjectInTransaction(tx, sync, changes, { projectId, userId: LOCAL_USER_ID, name, now: new Date().toISOString() }));
}

describe('built-in sample project', () => {
  it('gives an empty new library exactly one complete sample, and never brings it back after deletion', async () => {
    const library = await openLibrary();
    const assetEvents: string[] = [];
    const storesBefore = { project: useProjectStore.getState().currentProject, nodes: useDataStore.getState().bookNodes };

    const outcome = await ensureBuiltInSampleProject(dependencies(library, {}, assetEvents));
    expect(outcome.kind).toBe('created');
    const projectId = (outcome as { projectId: string }).projectId;

    expect(rows(library, 'SELECT id, name, user_id AS userId, deleted_at AS deletedAt FROM project')).toEqual([
      { id: projectId, name: BUILT_IN_SAMPLE_PROJECT_NAME, userId: LOCAL_USER_ID, deletedAt: null },
    ]);
    // The lite recipe exactly: word budgets, canonical Yjs bodies, cached
    // counts, verified assets and foreign keys, with the same text as the
    // development lite seed. Only its Agent history is left out.
    const report = auditDevelopmentSeed(library.gateway.database, projectId, SEED_PRESETS.lite, { agentHistory: false });
    for (const [group, statistics] of Object.entries(report.bodies))
      expect(statistics.corpusSha256, group).toBe(liteEvidence.bodies[group]?.corpusSha256);
    expect(report.assets).toMatchObject({ images: 4, pdfs: 2, verifiedBlobs: SAMPLE_ASSET_FIXTURES.length });
    expect(count(library, "SELECT count(*) AS n FROM library_item WHERE kind = 'text'")).toBe(SEED_PRESETS.lite.materialNotes.count);
    expect(count(library, 'SELECT count(*) AS n FROM material_folder')).toBe(6);
    expect(count(library, "SELECT count(*) AS n FROM comment WHERE status = 'resolved'")).toBe(5);
    expect(count(library, 'SELECT count(*) AS n FROM entity_relation')).toBe(36);
    expect(count(library, 'SELECT count(*) AS n FROM sync_change_set')).toBeGreaterThan(100);
    expect(assetEvents.filter((event) => event.startsWith('commit:'))).toHaveLength(SAMPLE_ASSET_FIXTURES.length);
    expect(assetEvents.some((event) => event.startsWith('abandon:'))).toBe(false);

    // No development bookkeeping reaches the author.
    for (const table of ['agent_conversation', 'agent_runtime_session', 'agent_runtime_turn', 'agent_runtime_tool_call', 'agent_runtime_write_effect'])
      expect(count(library, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    expect(rows(library, "SELECT key FROM entity_kv_entry WHERE owner_kind = 'project' AND key = '开发样本'")).toEqual([]);
    expect(rows(library, 'SELECT body FROM agent_memory')).toEqual([{ body: '作者偏好短句，场景描写克制，对白少而准。' }]);
    expect(marker(library)).toMatchObject({ status: 'created', projectId, attempts: 1 });
    // The working stores the tools used are handed back untouched.
    expect(useProjectStore.getState().currentProject).toBe(storesBefore.project);
    expect(useDataStore.getState().bookNodes).toBe(storesBefore.nodes);
    expect(useBuiltInSampleStore.getState()).toMatchObject({ pendingProjectId: null, createdProjectId: projectId });

    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'already-created' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(1);

    // Trash it, then let it be permanently deleted: the library is empty again.
    library.gateway.database.prepare('UPDATE project SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), projectId);
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'already-created' });
    await purgeUnpublishedSampleProject(library.client, projectId);
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'already-created' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
  }, 300_000);

  it('never touches a library that already has projects, even in the trash or after they are gone', async () => {
    const library = await openLibrary();
    await createAuthorProject(library, 'author-book', '作者的书');
    library.gateway.database.prepare("UPDATE project SET deleted_at = '2026-10-01T00:00:00.000Z'").run();

    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'not-a-new-library' });
    expect(rows(library, 'SELECT name FROM project')).toEqual([{ name: '作者的书' }]);
    expect(marker(library)).toMatchObject({ status: 'skipped', projectId: null, attempts: 0 });

    await purgeUnpublishedSampleProject(library.client, 'author-book');
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'not-a-new-library' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
  });

  it('leaves a library that is connecting to a cloud account to that account', async () => {
    const library = await openLibrary();
    await createSyncAppAuthorityRepository(library.client).begin({
      targetMode: 'hosted', accountSubjectId: 'subject', credentialSecretRef: 'hosted.session',
      attemptId: 'connect', nowIso: new Date().toISOString(),
    });
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'not-a-new-library' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
  });

  it('rolls a failed attempt back without blocking, then retries it on a later launch', async () => {
    const library = await openLibrary();
    const assetEvents: string[] = [];
    const working = memoryAssetImporter(library.client, assetEvents);
    let imports = 0;
    const failing: Dependencies['importAsset'] = async (projectId, fixture) => {
      if (++imports === 3) throw new Error('disk full');
      return working(projectId, fixture);
    };

    const failed = await ensureBuiltInSampleProject(dependencies(library, { importAsset: failing }));
    expect(failed.kind).toBe('failed');
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
    expect(count(library, 'SELECT count(*) AS n FROM agent_conversation')).toBe(0);
    expect(count(library, 'SELECT count(*) AS n FROM entity_kv_entry')).toBe(0);
    expect(assetEvents).toEqual(['abandon:island-map', 'abandon:lighthouse']);
    expect(marker(library)).toMatchObject({ status: 'failed', attempts: 1, reason: 'disk full' });
    expect(useProjectStore.getState().currentProject).toBeNull();
    expect(useBuiltInSampleStore.getState().pendingProjectId).toBeNull();

    const retried = await ensureBuiltInSampleProject(dependencies(library));
    expect(retried.kind).toBe('created');
    expect(rows(library, 'SELECT name FROM project')).toEqual([{ name: BUILT_IN_SAMPLE_PROJECT_NAME }]);
    expect(marker(library)).toMatchObject({ status: 'created', attempts: 2 });
  }, 300_000);

  it('removes the partial project of an interrupted attempt before creating the sample', async () => {
    const library = await openLibrary();
    await createAuthorProject(library, 'interrupted-sample', BUILT_IN_SAMPLE_PROJECT_NAME);
    const now = new Date().toISOString();
    library.gateway.database.prepare('INSERT INTO library_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      BUILT_IN_SAMPLE_STATE_KEY,
      JSON.stringify({ status: 'creating', recipe: 'lite-v1', projectId: 'interrupted-sample', attempts: 1, updatedAt: now }),
      now,
    );
    // Shelves never list the unfinished project while it is being replaced.
    useBuiltInSampleStore.setState({ pendingProjectId: 'interrupted-sample' });
    expect(withoutPendingSampleProject([{ id: 'interrupted-sample' }, { id: 'other' }])).toEqual([{ id: 'other' }]);

    const outcome = await ensureBuiltInSampleProject(dependencies(library));
    expect(outcome.kind).toBe('created');
    const projects = rows<{ id: string }>(library, 'SELECT id FROM project');
    expect(projects).toHaveLength(1);
    expect(projects[0].id).not.toBe('interrupted-sample');
    expect(marker(library)).toMatchObject({ status: 'created', attempts: 2 });
  }, 300_000);

  it('gives up after repeated failures instead of retrying forever', async () => {
    const library = await openLibrary();
    const now = new Date().toISOString();
    library.gateway.database.prepare('INSERT INTO library_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      BUILT_IN_SAMPLE_STATE_KEY,
      JSON.stringify({ status: 'failed', recipe: 'lite-v1', projectId: null, attempts: BUILT_IN_SAMPLE_MAX_ATTEMPTS, updatedAt: now }),
      now,
    );
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'attempts-exhausted' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
    expect(marker(library)).toMatchObject({ status: 'skipped', reason: 'attempts-exhausted' });
  });

  it('never rejects or blocks startup when the library cannot be read', async () => {
    // No database is open: the startup hook logs and settles, and a Hosted
    // connect waiting on it continues.
    await expect(startBuiltInSampleProject()).resolves.toBeUndefined();
    expect(startBuiltInSampleProject()).toBe(startBuiltInSampleProject());
    await expect(waitForBuiltInSampleProject()).resolves.toBeUndefined();
    expect(useBuiltInSampleStore.getState()).toMatchObject({ phase: 'settled', pendingProjectId: null, createdProjectId: null });
  });
});
