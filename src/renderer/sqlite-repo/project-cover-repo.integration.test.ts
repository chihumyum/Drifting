import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_NOW } from '../services/workspace-projection.test-support';
import { BookNodeTable, NodeStorylineLinkTable, StorylineTable } from '../schema/drizzle';
import { COVER_MAX_STORYLINES, readProjectCover } from './project-cover-repo';

let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>> | undefined;
afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = undefined;
  }
});

const owned = { projectId: 'synthetic-workspace', createdAt: WORKSPACE_TEST_NOW, updatedAt: WORKSPACE_TEST_NOW };
const chapter = (id: string, bookOrder: number, extra: Partial<typeof BookNodeTable.$inferInsert> = {}) => ({
  ...owned, id, title: id, kind: 'chapter', bookOrder, positionX: 0, positionY: 0, ...extra,
});

describe('project shelf cover', () => {
  it('reads each storyline in order with the chapters it runs through, by reading order', async () => {
    fixture = await createWorkspaceProjectionFixture();
    const { db, gateway } = fixture;
    // The fixture's one chapter sits at book order 1; add one before and two after it.
    await db.insert(BookNodeTable).values([
      chapter('opening', 0),
      chapter('late', 5),
      chapter('middle', 3),
      chapter('trashed', 4, { deletedAt: WORKSPACE_TEST_NOW }),
    ]);
    await db.insert(NodeStorylineLinkTable).values([
      { nodeId: 'late', storylineId: 'main' },
      { nodeId: 'opening', storylineId: 'support' },
      { nodeId: 'middle', storylineId: 'support' },
      { nodeId: 'trashed', storylineId: 'support' },
      { nodeId: 'drift', storylineId: 'support' },
    ]);
    await db.update(StorylineTable).set({ color: '#46639F' }).where(eq(StorylineTable.id, 'main'));
    const query = vi.spyOn(gateway, 'query');

    expect(await readProjectCover('synthetic-workspace', db)).toEqual({
      storylines: [
        // chapter (order 1) is index 1, late (order 5) index 3.
        { color: '#46639F', chapters: [1, 3] },
        // The trashed chapter and the drift node are not on the reading axis.
        { color: '#778899', chapters: [0, 2] },
      ],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(await readProjectCover('other-project', db)).toEqual({ storylines: [] });
  });

  it('leaves out deleted storylines and draws no more than the cover holds', async () => {
    fixture = await createWorkspaceProjectionFixture();
    const { db } = fixture;
    await db.update(StorylineTable).set({ deletedAt: WORKSPACE_TEST_NOW }).where(eq(StorylineTable.id, 'support'));
    await db.insert(StorylineTable).values(
      Array.from({ length: COVER_MAX_STORYLINES + 2 }, (_, i) => ({
        ...owned, id: `extra-${i}`, name: `extra-${i}`, color: '#C98A58', orderKey: 10 + i,
      })),
    );
    const cover = await readProjectCover('synthetic-workspace', db);
    expect(cover.storylines).toHaveLength(COVER_MAX_STORYLINES);
    expect(cover.storylines[0]).toEqual({ color: '#778899', chapters: [0] });
    expect(cover.storylines.slice(1).every((line) => line.chapters.length === 0)).toBe(true);
  });
});
