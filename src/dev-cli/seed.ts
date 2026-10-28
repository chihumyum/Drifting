// Development seed: a synthetic project for an isolated worktree profile
// (`pnpm dev:seed`, docs/worktree-development.md). Every write goes through the
// same journaled paths as the app or the General Agent tools, so the seeded
// database is an ordinary current-format library.

import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup } from 'node:sqlite';
import { v7 as uuidv7 } from 'uuid';

import { installHeadlessRendererGlobals } from './headless-globals';
import { OfflineProductDatabase } from './offline-database';
import { createAtomicRunner, executeOfflineWorkspaceTool } from './offline-workspace';
import { loadScenario, parseScenario, runScenario } from './scenario';
import { createDefaultProjectScenario } from './seeds/default-project';
import { seedConversations } from './seeds/conversations';
import { loadSeedAssets, seedMaterials } from './seeds/materials';
import { ProjectTable } from '../renderer/schema/drizzle';
import { createCommentRepository } from '../renderer/sqlite-repo/comment-repo';
import { createProjectInTransaction } from '../renderer/usecase/project-create';

/** The local-only library: `store/auth`'s LOCAL_USER_ID and its database file. */
export const LOCAL_LIBRARY_USER_ID = 'drifting-library.db';

export interface SeedResult {
  /** False when the library already had a project and was left untouched. */
  seeded: boolean;
  databasePath: string;
  projectId: string | null;
}

/**
 * Seeds `databasePath` (created and migrated if missing) with one project as
 * the app creates it, the scenario's chapters, storylines, inspirations,
 * elements, relations and TODOs, material notes/assets and resumable offline
 * Agent conversations. A library that already has a project is left untouched.
 */
export async function seedDevelopmentDatabase(input: {
  databasePath: string;
  projectName?: string;
  scenarioPath?: string;
  /** Native app_local_data_dir for this isolated profile; never the daily app. */
  appLocalDataDirectory?: string;
  onProgress?: (message: string) => void;
}): Promise<SeedResult> {
  installHeadlessRendererGlobals();
  await mkdir(dirname(input.databasePath), { recursive: true, mode: 0o700 });
  const original = new OfflineProductDatabase(input.databasePath, { migrate: true });
  await original.open();
  const stagingPath = `${input.databasePath}.seed-${uuidv7()}.db`;
  try {
    const existing = await original.client.select({ id: ProjectTable.id }).from(ProjectTable).limit(1);
    if (existing.length > 0) return { seeded: false, databasePath: input.databasePath, projectId: null };
    // Publish only a completed seed. Preserve settings in an existing empty
    // library, and leave that library usable if any of the many writes fails.
    await backup(original.gateway.database, stagingPath);
  } catch (error) {
    await rm(stagingPath, { force: true });
    throw error;
  } finally {
    await original.close();
  }

  const database = new OfflineProductDatabase(stagingPath, { migrate: false });
  let abandonAssets: (() => Promise<void>) | undefined;
  let published = false;
  let opened = false;
  try {
    await database.open();
    opened = true;
    const document = input.scenarioPath ? await loadScenario(input.scenarioPath) : parseScenario(createDefaultProjectScenario());
    const fixtures = await loadSeedAssets();
    const appLocalDataDirectory = input.appLocalDataDirectory ?? join(dirname(input.databasePath), 'app-local-data');
    const runAtomic = createAtomicRunner(database.client);
    const projectId = uuidv7();
    const now = new Date().toISOString();
    await runAtomic(projectId, (tx, sync, changes) =>
      createProjectInTransaction(tx, sync, changes, {
        projectId,
        userId: LOCAL_LIBRARY_USER_ID,
        name: input.projectName ?? '潮汐灯塔（示例）',
        now,
      }),
    );
    input.onProgress?.(`Seeding ${document.steps.length} authored workspace operations…`);
    await runScenario({
      document,
      database,
      projectId,
      requestId: `dev-seed-${uuidv7()}`,
    });
    // Include both open and completed review work, through the normal tool.
    const comments = await createCommentRepository(projectId, database.client).findAll();
    for (const [index, comment] of comments.entries()) {
      if (index % 4 !== 0) continue;
      const result = await executeOfflineWorkspaceTool({
        database: database.client, projectId, toolName: 'update_comment',
        arguments: { commentId: comment.id, status: 'resolved' }, requestId: `dev-seed-resolve-${comment.id}`,
      });
      if (!result.result.ok) throw new Error(`Could not seed comment state: ${result.result.error}`);
    }
    input.onProgress?.('Seeding material notes, verified images and PDFs…');
    abandonAssets = await seedMaterials(database.client, projectId, appLocalDataDirectory, fixtures);
    input.onProgress?.('Seeding offline Agent conversations and recovery checkpoints…');
    await seedConversations(database.client, projectId);
    await database.close();
    opened = false;
    await rename(stagingPath, input.databasePath);
    published = true;
    return { seeded: true, databasePath: input.databasePath, projectId };
  } finally {
    if (opened) await database.close();
    if (!published) await abandonAssets?.();
    for (const suffix of ['', '-wal', '-shm']) await rm(`${stagingPath}${suffix}`, { force: true });
  }
}
