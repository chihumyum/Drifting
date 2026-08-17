import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STORYLINE_LANE_ID,
  UNAFFILIATED_STORYLINE_LANE_ID,
  canDropChapterOnLane,
  chapterLaneGrabOffsetX,
  commitChapterLaneDrop,
} from './chapter-lane-drag';

describe('chapter lane drag', () => {
  it('preserves the exact grabbed point for narrow holding chips and full cards', () => {
    const sourceRect = { left: 100, width: 240 };

    expect(chapterLaneGrabOffsetX(112, sourceRect)).toBe(12);
    expect(chapterLaneGrabOffsetX(220, sourceRect)).toBe(120);
    expect(chapterLaneGrabOffsetX(328, sourceRect)).toBe(228);
    expect(chapterLaneGrabOffsetX(80, sourceRect)).toBe(0);
    expect(chapterLaneGrabOffsetX(360, sourceRect)).toBe(240);
  });

  it('accepts every real and synthetic lane for both placed and unplaced chapters', () => {
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
    ).toBe(true);
    expect(
      canDropChapterOnLane({ targetLaneId: 'b', fromDrawer: true, primaryStorylineId: 'a' }),
    ).toBe(true);
    expect(
      canDropChapterOnLane({ targetLaneId: 'b', fromDrawer: false, primaryStorylineId: 'a' }),
    ).toBe(true);
  });

  it('delegates membership and order to one atomic move command', async () => {
    const moveChapterOnTimeline = vi.fn(async () => undefined);

    await commitChapterLaneDrop({
      nodeId: 'chapter-1',
      targetLaneId: 'storyline-b',
      targetOrder: 12.375,
      orderField: 'bookOrder',
      moveChapterOnTimeline,
    });

    expect(moveChapterOnTimeline).toHaveBeenCalledTimes(1);
    expect(moveChapterOnTimeline).toHaveBeenCalledWith('chapter-1', {
      orderField: 'bookOrder',
      order: 12.375,
      targetStorylineId: 'storyline-b',
    });
  });

  it('persists a continuous book-axis coordinate without slot conversion', async () => {
    const moveChapterOnTimeline = vi.fn(async () => undefined);

    await commitChapterLaneDrop({
      nodeId: 'chapter-1',
      targetLaneId: DEFAULT_STORYLINE_LANE_ID,
      targetOrder: 5.125,
      orderField: 'bookOrder',
      moveChapterOnTimeline,
    });

    expect(moveChapterOnTimeline).toHaveBeenCalledWith('chapter-1', {
      orderField: 'bookOrder',
      order: 5.125,
      targetStorylineId: undefined,
    });
  });

  it('clears primary and memberships before placing into the unaffiliated lane', async () => {
    const moveChapterOnTimeline = vi.fn(async () => undefined);
    await commitChapterLaneDrop({
      nodeId: 'chapter-1',
      targetLaneId: UNAFFILIATED_STORYLINE_LANE_ID,
      targetOrder: 8,
      orderField: 'narrativeOrder',
      moveChapterOnTimeline,
    });

    expect(moveChapterOnTimeline).toHaveBeenCalledTimes(1);
    expect(moveChapterOnTimeline).toHaveBeenCalledWith('chapter-1', {
      orderField: 'narrativeOrder',
      order: 8,
      targetStorylineId: null,
    });
  });
});
