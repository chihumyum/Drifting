// Development seed: a synthetic project for an isolated worktree profile
// (`pnpm dev:seed`, docs/worktree-development.md). Every write goes through the
// same journaled paths as the app or the General Agent tools, so the seeded
// database is an ordinary current-format library.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { installHeadlessRendererGlobals } from './headless-globals';
import { OfflineProductDatabase } from './offline-database';
import { createAtomicRunner } from './offline-workspace';
import { loadScenario, parseScenario, runScenario } from './scenario';
import defaultProjectSeed from './seeds/default-project.json';
import { createPlainCommentDoc } from '../renderer/domain/comment';
import type { LibraryItem } from '../renderer/domain/library-item';
import type { MaterialFolder } from '../renderer/domain/material-folder';
import { ProjectTable } from '../renderer/schema/drizzle';
import { createLibraryItemSqliteRepository } from '../renderer/sqlite-repo/library-item-repo';
import { createMaterialFolderRepository } from '../renderer/sqlite-repo/material-folder-repo';
import { libraryMutationPayload } from '../renderer/usecase/library-item-payload';
import { createProjectInTransaction } from '../renderer/usecase/project-create';

/** The local-only library: `store/auth`'s LOCAL_USER_ID and its database file. */
export const LOCAL_LIBRARY_USER_ID = 'drifting-library.db';

export interface SeedResult {
  /** False when the library already had a project and was left untouched. */
  seeded: boolean;
  databasePath: string;
  projectId: string | null;
}

/** The note body seeds: paragraphs, a checklist and a table-free outline. */
function noteBody(blocks: Array<{ type: 'heading' | 'paragraph' | 'tasks'; text?: string; tasks?: string[] }>): string {
  return JSON.stringify({
    type: 'doc',
    content: blocks.map((block) => {
      if (block.type === 'heading') {
        return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: block.text }] };
      }
      if (block.type === 'tasks') {
        return {
          type: 'taskList',
          content: (block.tasks ?? []).map((text) => ({
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
          })),
        };
      }
      return { type: 'paragraph', content: [{ type: 'text', text: block.text }] };
    }),
  });
}

async function seedMaterials(runAtomic: ReturnType<typeof createAtomicRunner>, projectId: string): Promise<void> {
  const now = new Date().toISOString();
  const research: MaterialFolder = {
    id: uuidv7(), projectId, name: '调研', parentFolderId: null, createdAt: now, updatedAt: now,
  };
  const maps: MaterialFolder = {
    id: uuidv7(), projectId, name: '地图与潮汐', parentFolderId: research.id, createdAt: now, updatedAt: now,
  };
  const note = (title: string, folderId: string | null, bodyJson: string): LibraryItem => ({
    id: uuidv7(), projectId, title, kind: 'text', assetId: null, externalUrl: null, previewImageUrl: null,
    bodyJson, notesJson: null, provenanceJson: null, orderKey: 0, folderId, taskTodos: true,
    createdAt: now, updatedAt: now,
  });
  const notes = [
    note('潮汐调研', maps.id, noteBody([
      { type: 'heading', text: '北岬的潮位' },
      { type: 'paragraph', text: '大潮时北岬礁石全部没入水下，退潮后能步行到灯塔基座。' },
      { type: 'tasks', tasks: ['找一份北岬的潮汐表', '确认灯塔建成的年份'] },
    ])),
    note('人物小记', research.id, noteBody([
      { type: 'paragraph', text: '老船长说话前总要先看一眼海。林潮不信天气预报，只信潮水。' },
    ])),
    note('随手记', null, createPlainCommentDoc('灯塔的光每隔九秒扫过一次窗户。')),
  ];
  await runAtomic(projectId, async (tx, sync) => {
    const folders = createMaterialFolderRepository(projectId, tx);
    for (const folder of [research, maps]) {
      await folders.create(folder);
      await sync('materialFolder', 'create', folder.id, projectId, {
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      });
    }
    const items = createLibraryItemSqliteRepository(projectId, tx);
    for (const item of notes) {
      await items.create(item);
      await sync('libraryItem', 'create', item.id, projectId, libraryMutationPayload(item));
    }
  });
}

/**
 * Seeds `databasePath` (created and migrated if missing) with one project as
 * the app creates it, the scenario's chapters, storylines, inspirations,
 * elements, relations and TODOs, and a few notes in folders. A library that
 * already has a project is left untouched.
 */
export async function seedDevelopmentDatabase(input: {
  databasePath: string;
  projectName?: string;
  scenarioPath?: string;
}): Promise<SeedResult> {
  installHeadlessRendererGlobals();
  await mkdir(dirname(input.databasePath), { recursive: true, mode: 0o700 });
  const database = new OfflineProductDatabase(input.databasePath, { migrate: true });
  await database.open();
  try {
    const existing = await database.client.select({ id: ProjectTable.id }).from(ProjectTable).limit(1);
    if (existing.length > 0) return { seeded: false, databasePath: input.databasePath, projectId: null };

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
    await runScenario({
      document: input.scenarioPath ? await loadScenario(input.scenarioPath) : parseScenario(defaultProjectSeed),
      database,
      projectId,
      requestId: `dev-seed-${uuidv7()}`,
    });
    await seedMaterials(runAtomic, projectId);
    return { seeded: true, databasePath: input.databasePath, projectId };
  } finally {
    await database.close();
  }
}
