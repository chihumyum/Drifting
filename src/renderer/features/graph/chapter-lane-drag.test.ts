import { describe, expect, it, vi } from 'vitest';
import {
  CHAPTER_DRAG_MIME,
  DEFAULT_STORYLINE_LANE_ID,
  UNAFFILIATED_STORYLINE_LANE_ID,
  canDropChapterOnLane,
  commitChapterLaneDrop,
  initializeChapterDrag,
} from './chapter-lane-drag';

describe('chapter lane drag', () => {
  it('installs a real native drag payload for WebKit drop delivery', () => {
    const setData = vi.fn();
    const setDragImage = vi.fn();
    const dataTransfer = { effectAllowed: 'none', setData, setDragImage } as unknown as DataTransfer;
    const dragImage = {
      getBoundingClientRect: () => ({ width: 80, height: 40 }),
    } as unknown as HTMLElement;

    initializeChapterDrag(dataTransfer, 'chapter-1', dragImage);

    expect(dataTransfer.effectAllowed).toBe('move');
    expect(setData).toHaveBeenCalledWith('text/plain', 'chapter-1');
    expect(setData).toHaveBeenCalledWith(CHAPTER_DRAG_MIME, 'chapter-1');
    expect(setDragImage).toHaveBeenCalledWith(dragImage, 40, 20);
  });

  it('shares drawer and synthetic-lane acceptance rules', () => {
    expect(
      canDropChapterOnLane({ targetLaneId: null, fromDrawer: false, primaryStorylineId: 'a' }),
    ).toBe(false);
    expect(
      canDropChapterOnLane({
        targetLaneId: DEFAULT_STORYLINE_LANE_ID,
        fromDrawer: true,
        primaryStorylineId: 'a',
      }),
    ).toBe(true);
    expect(
      canDropChapterOnLane({
        targetLaneId: UNAFFILIATED_STORYLINE_LANE_ID,
        fromDrawer: true,
        primaryStorylineId: 'a',
      }),
    ).toBe(false);
    expect(
      canDropChapterOnLane({ targetLaneId: 'b', fromDrawer: true, primaryStorylineId: 'a' }),
    ).toBe(false);
    expect(
      canDropChapterOnLane({ targetLaneId: 'b', fromDrawer: false, primaryStorylineId: 'a' }),
    ).toBe(true);
  });

  it('reroutes primary membership and order as one shared transaction recipe', async () => {
    const calls: string[] = [];
    const setNodeStorylines = vi.fn(async (_id, ids: string[]) => {
      calls.push(`members:${ids.join(',')}`);
    });
    const updateNode = vi.fn(async (_id, patch: object) => {
      calls.push(`node:${JSON.stringify(patch)}`);
    });

    await commitChapterLaneDrop({
      nodeId: 'chapter-1',
      targetLaneId: 'storyline-b',
      targetOrder: 12,
      orderField: 'bookOrder',
      primaryStorylineId: 'storyline-a',
      membershipIds: ['storyline-a', 'storyline-c'],
      updateNode,
      setNodeStorylines,
    });

    expect(setNodeStorylines).toHaveBeenCalledWith(
      'chapter-1',
      ['storyline-c', 'storyline-b'],
      { primaryStorylineId: 'storyline-b' },
    );
    expect(updateNode).toHaveBeenCalledWith('chapter-1', {
      bookOrder: 12,
      mainStorylineId: 'storyline-b',
    });
    expect(calls).toEqual([
      'members:storyline-c,storyline-b',
      'node:{"bookOrder":12,"mainStorylineId":"storyline-b"}',
    ]);
  });

  it('clears primary and memberships before placing into the unaffiliated lane', async () => {
    const calls: string[] = [];
    await commitChapterLaneDrop({
      nodeId: 'chapter-1',
      targetLaneId: UNAFFILIATED_STORYLINE_LANE_ID,
      targetOrder: 8,
      orderField: 'narrativeOrder',
      primaryStorylineId: 'storyline-a',
      membershipIds: ['storyline-a'],
      updateNode: async (_id, patch) => {
        calls.push(`node:${JSON.stringify(patch)}`);
      },
      setNodeStorylines: async (_id, ids) => {
        calls.push(`members:${ids.join(',')}`);
      },
    });

    expect(calls).toEqual([
      'node:{"mainStorylineId":null}',
      'members:',
      'node:{"narrativeOrder":8}',
    ]);
  });
});
