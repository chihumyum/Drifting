import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_NOW } from '../services/workspace-projection.test-support';
import { BookNodeTable, ProjectTable } from '../schema/drizzle';
import * as database from '../lib/db';
import { useProject } from './useProject';
import { useProjectStore } from '../store/project-store';

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; vi.restoreAllMocks(); useProjectStore.getState().setProjects([]); });

it('loads the owned shelf with bounded aggregate work and preserves updated-date order', async () => {
  fixture = await createWorkspaceProjectionFixture();
  const { db, gateway } = fixture;
  // The fixture installs a headless client; no native account switch is performed.
  vi.spyOn(database, 'initDatabase').mockResolvedValue(undefined);
  await db.update(BookNodeTable).set({ wordCountBasisKind: 'seed', wordCountBasisHash: `sha256:${'a'.repeat(64)}` }).where(eq(BookNodeTable.id, 'chapter'));
  await db.insert(ProjectTable).values(Array.from({ length: 12 }, (_, index) => ({ id: `shelf-${index}`, name: 'Synthetic', userId: 'synthetic-user', createdAt: WORKSPACE_TEST_NOW, updatedAt: `2026-09-${String(index + 1).padStart(2, '0')}T01:00:00.000Z` })));
  await db.insert(ProjectTable).values({ id: 'foreign-account', name: 'Foreign synthetic', userId: 'another-user', createdAt: WORKSPACE_TEST_NOW, updatedAt: '2026-09-30T00:00:00.000Z' });
  const original = gateway.query.bind(gateway);
  let active = 0; let maximum = 0;
  const query = vi.spyOn(gateway, 'query').mockImplementation(async (...args) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await original(...args); }
    finally { active--; }
  });
  let api!: ReturnType<typeof useProject>;
  function Owner() { api = useProject({ userId: 'synthetic-user' }); return null; }
  renderToString(createElement(Owner));
  const summaries = await api.loadProjectSummaries();
  expect(summaries).toHaveLength(14);
  expect(summaries[0].id).toBe('shelf-11');
  expect(summaries.some(project => project.id === 'foreign-account')).toBe(false);
  expect(summaries.every(project => project.source === 'local' && project.stats.wordsReady)).toBe(true);
  expect(useProjectStore.getState().projects).toEqual(summaries);
  expect(query).toHaveBeenCalledTimes(15); // one project inventory, one row per project
  expect(maximum).toBe(4);
});
