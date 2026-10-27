import { and, eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';

import * as database from '../lib/db';
import { LibraryItemTable, MaterialFolderTable, SyncChangeSetTable, SyncEntityLifecycleTable } from '../schema/drizzle';
import { captureWorkspaceProjection } from '../services/workspace-projection.service';
import {
  createWorkspaceProjectionFixture,
  WORKSPACE_TEST_INPUT as INPUT,
} from '../services/workspace-projection.test-support';
import { useDataStore } from '../store/data-store';
import { createLibraryItemUsecases } from './useLibraryItem';
import { createMaterialFolderUsecases } from './useMaterialFolder';

const secureStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      app: { ...actual.platform.app, getInstallationIdentity: async () => `install-${'d'.repeat(64)}` },
      keychain: {
        get: async (key: string) => secureStorage.get(key) ?? null,
        has: async (key: string) => secureStorage.has(key),
        set: async (key: string, value: string) => {
          secureStorage.set(key, value);
          return true;
        },
        delete: async (key: string) => secureStorage.delete(key),
      },
    },
  };
});

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
  useDataStore.getState().setMaterialFolders([]);
  useDataStore.getState().setLibraryItems([]);
});

async function setup() {
  fixture = await createWorkspaceProjectionFixture();
  vi.spyOn(database, 'initDatabase').mockResolvedValue(undefined);
  const captured = (await captureWorkspaceProjection(INPUT))!;
  useDataStore.getState().setLibraryItems(captured.data.libraryItems);
  useDataStore.getState().setMaterialFolders(captured.data.materialFolders);
  return {
    db: fixture.db,
    folders: createMaterialFolderUsecases(INPUT.projectId),
    library: createLibraryItemUsecases(INPUT),
  };
}

const localChangeSets = (db: Awaited<ReturnType<typeof setup>>['db']) =>
  db.select().from(SyncChangeSetTable)
    .where(and(eq(SyncChangeSetTable.projectId, INPUT.projectId), eq(SyncChangeSetTable.origin, 'local')));

it('files materials in nested folders and empties a deleted folder into its parent', async () => {
  const { db, folders, library } = await setup();
  const before = (await localChangeSets(db)).length;

  const research = await folders.createFolder({ name: '调研' });
  const maps = await folders.createFolder({ name: '地图', parentFolderId: research.id });
  const note = await library.createLibraryItem({ kind: 'text', title: '潮汐', folderId: maps.id });
  expect(note.folderId).toBe(maps.id);
  await folders.moveMaterialsToFolder([note.id, 'library'], research.id);
  expect(await folders.moveFolder(research.id, maps.id)).toBe(false);
  await folders.renameFolder(maps.id, '海图');

  // Every write is one journaled local change set the sync kernel accepted.
  expect(await localChangeSets(db)).toHaveLength(before + 5);
  const lifecycles = await db.select().from(SyncEntityLifecycleTable)
    .where(eq(SyncEntityLifecycleTable.entityKind, 'material-folder'));
  expect(lifecycles.map((row) => row.entityId).sort()).toEqual([maps.id, research.id].sort());

  // The projection reads folders and filing back from SQLite.
  const captured = (await captureWorkspaceProjection(INPUT))!;
  expect(captured.data.materialFolders.map(({ name, parentFolderId }) => ({ name, parentFolderId })).sort((a, b) => a.name.localeCompare(b.name)))
    .toEqual([{ name: '海图', parentFolderId: research.id }, { name: '调研', parentFolderId: null }]);
  expect(captured.data.libraryItems.filter((item) => item.folderId === research.id).map((item) => item.id).sort())
    .toEqual([note.id, 'library'].sort());

  await folders.deleteFolder(research.id);
  const rows = await db.select().from(MaterialFolderTable).where(eq(MaterialFolderTable.projectId, INPUT.projectId));
  expect(rows).toEqual([expect.objectContaining({ id: maps.id, parentFolderId: null })]);
  const filed = await db.select({ id: LibraryItemTable.id, folderId: LibraryItemTable.folderId }).from(LibraryItemTable)
    .where(eq(LibraryItemTable.projectId, INPUT.projectId));
  expect(filed.every((row) => row.folderId === null)).toBe(true);
  expect(useDataStore.getState().materialFolders.map((folder) => folder.id)).toEqual([maps.id]);
  expect(useDataStore.getState().libraryItems.every((item) => item.folderId === null)).toBe(true);
});

it('turns a note\'s checklist sync off and back on as an authored field', async () => {
  const { db, library } = await setup();
  await library.updateLibraryItem('library', { taskTodos: false });
  const [row] = await db.select({ taskTodos: LibraryItemTable.taskTodos }).from(LibraryItemTable)
    .where(eq(LibraryItemTable.id, 'library'));
  expect(row?.taskTodos).toBe(false);
  await library.updateLibraryItem('library', { taskTodos: true });
  const [after] = await db.select({ taskTodos: LibraryItemTable.taskTodos }).from(LibraryItemTable)
    .where(eq(LibraryItemTable.id, 'library'));
  expect(after?.taskTodos).toBe(true);
});
