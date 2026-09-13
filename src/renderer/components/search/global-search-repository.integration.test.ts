import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT, WORKSPACE_TEST_NOW } from '../../services/workspace-projection.test-support';
import { BookNodeTable, NodeContentTable } from '../../schema/drizzle';
import { readGlobalSearchNodeBodies } from './global-search-repository';

const body = (text: string) => JSON.stringify({ type: 'doc', content: [{ type: 'text', text }] });
let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>>;
beforeEach(async () => { fixture = await createWorkspaceProjectionFixture(); });
afterEach(async () => { await fixture?.close(); });
describe('project-scoped global-search SQLite reads', () => {
  it('returns current live chapters and free-floating drift bodies, excluding foreign and trashed nodes', async () => {
    const stamps = { createdAt: WORKSPACE_TEST_NOW, updatedAt: WORKSPACE_TEST_NOW };
    await fixture.db.insert(BookNodeTable).values([
      { ...stamps, id: 'foreign', projectId: 'other-project', title: 'Foreign', kind: 'chapter', positionX: 0, positionY: 0 },
      { ...stamps, id: 'trashed', projectId: WORKSPACE_TEST_INPUT.projectId, title: 'Trash', kind: 'chapter', positionX: 0, positionY: 0, deletedAt: WORKSPACE_TEST_NOW },
    ]);
    await fixture.db.update(NodeContentTable).set({ contentJson: body('Needle chapter') }).where(eq(NodeContentTable.nodeId, 'chapter'));
    await fixture.db.insert(NodeContentTable).values(['drift', 'foreign', 'trashed'].map(nodeId => ({ ...stamps, nodeId, contentJson: body('Needle body') })));
    const results = await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, 'needle', fixture.db);
    expect([...results.keys()].sort()).toEqual(['chapter', 'drift']);
    expect([...await readGlobalSearchNodeBodies('other-project', 'needle', fixture.db)].map(([id]) => id)).toEqual(['foreign']);
    expect(await readGlobalSearchNodeBodies('missing-project', 'needle', fixture.db)).toEqual(new Map());
  });
  it.each(['%', '_', '\\', "' OR 1=1 --"] )('treats %s literally in LIKE and parameters', async query => {
    await fixture.db.update(NodeContentTable).set({ contentJson: body('unrelated plain text') });
    expect(await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, query, fixture.db)).toEqual(new Map());
    await fixture.db.update(NodeContentTable).set({ contentJson: body(`literal ${query} marker`) });
    expect([...await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, query, fixture.db)].map(([id]) => id)).toEqual(['chapter']);
  });
  it('returns changed persisted caches and skips whitespace-only queries', async () => {
    expect(await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, '   ', fixture.db)).toEqual(new Map());
    await fixture.db.update(NodeContentTable).set({ contentJson: body('Before') });
    expect((await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, 'before', fixture.db)).size).toBe(1);
    await fixture.db.update(NodeContentTable).set({ contentJson: body('After') });
    expect((await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, 'before', fixture.db)).size).toBe(0);
    expect((await readGlobalSearchNodeBodies(WORKSPACE_TEST_INPUT.projectId, 'after', fixture.db)).size).toBe(1);
  });
});
