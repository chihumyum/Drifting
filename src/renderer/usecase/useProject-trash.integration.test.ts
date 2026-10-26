import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { and, eq } from 'drizzle-orm';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT } from '../services/workspace-projection.test-support';
import { ProjectTable, SyncChangeSetTable } from '../schema/drizzle';
import * as database from '../lib/db';
import { PROJECT_TRASH_RETENTION_DAYS, projectTrashExpiresAt, useProject } from './useProject';
import { useProjectStore } from '../store/project-store';

const cleanup = vi.hoisted(() => vi.fn());
const secureStorage = vi.hoisted(() => new Map<string, string>());
// Native asset/projection cleanup is covered by its own tests; this file covers the trash lifecycle.
vi.mock('../services/project-deletion-cleanup', () => ({ cleanupDeletedProject: cleanup }));
// The headless database has no native checkpoint; the deletion barrier itself is tested elsewhere.
vi.mock('../lib/persistence-lifecycle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/persistence-lifecycle')>(),
  flushLocalApplicationPersistence: async () => undefined,
}));
vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      app: { ...actual.platform.app, getInstallationIdentity: async () => `install-${'c'.repeat(64)}` },
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

const PROJECT_ID = WORKSPACE_TEST_INPUT.projectId;
let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
  cleanup.mockReset();
  useProjectStore.getState().setProjects([]);
});

async function setup() {
  fixture = await createWorkspaceProjectionFixture();
  vi.spyOn(database, 'initDatabase').mockResolvedValue(undefined);
  let api!: ReturnType<typeof useProject>;
  function Owner() { api = useProject({ userId: WORKSPACE_TEST_INPUT.userId }); return null; }
  renderToString(createElement(Owner));
  return { api, db: fixture.db };
}

const localChangeSets = (db: Awaited<ReturnType<typeof setup>>['db']) =>
  db.select().from(SyncChangeSetTable)
    .where(and(eq(SyncChangeSetTable.projectId, PROJECT_ID), eq(SyncChangeSetTable.origin, 'local')));

it('moves a project to Recently Deleted as one synced write and restores it intact', async () => {
  const { api, db } = await setup();
  const before = (await localChangeSets(db)).length;

  expect(await api.trashProject(PROJECT_ID)).toBe(true);
  expect((await api.loadProjects()).map((project) => project.id)).not.toContain(PROJECT_ID);
  const [trashed] = await api.loadTrashedProjects();
  expect(trashed).toMatchObject({ id: PROJECT_ID, name: 'Synthetic' });
  expect(Number.isNaN(Date.parse(trashed.deletedAt!))).toBe(false);
  expect(await localChangeSets(db)).toHaveLength(before + 1);

  expect(await api.restoreProject(PROJECT_ID)).toBe(true);
  expect(await api.loadTrashedProjects()).toEqual([]);
  expect((await api.loadProjects()).map((project) => project.id)).toContain(PROJECT_ID);
  expect(await localChangeSets(db)).toHaveLength(before + 2);
  expect(cleanup).not.toHaveBeenCalled();
});

it('permanently deletes only projects whose trash period has expired', async () => {
  const { api, db } = await setup();
  const now = new Date('2026-10-27T00:00:00.000Z');
  const day = 24 * 60 * 60 * 1_000;
  const expired = new Date(now.getTime() - (PROJECT_TRASH_RETENTION_DAYS + 1) * day).toISOString();
  const recent = new Date(now.getTime() - day).toISOString();
  await db.update(ProjectTable).set({ deletedAt: expired }).where(eq(ProjectTable.id, PROJECT_ID));
  await db.update(ProjectTable).set({ deletedAt: recent }).where(eq(ProjectTable.id, 'other-project'));
  expect(projectTrashExpiresAt(expired) < now).toBe(true);

  expect(await api.purgeExpiredTrashedProjects(now)).toEqual([PROJECT_ID]);

  expect(await db.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, PROJECT_ID))).toEqual([]);
  expect((await api.loadTrashedProjects()).map((project) => project.id)).toEqual(['other-project']);
  expect(cleanup).toHaveBeenCalledOnce();
});
