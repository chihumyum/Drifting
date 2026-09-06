import { describe, expect, it } from 'vitest';
import {
  VERTICAL_TIMELINE_CHIP_HEIGHT,
  VERTICAL_TIMELINE_CLUSTER_HEIGHT,
  VERTICAL_TIMELINE_ENTRY_ANCHOR,
  VERTICAL_TIMELINE_LEVELS,
  projectVerticalTimeline,
  verticalTimelineContentHeight,
  type VerticalTimelineItem,
} from './vertical-timeline-projection';

const chapter = (id: string, y: number): VerticalTimelineItem => ({ id, kind: 'chapter', y });
const act = (id: string, y: number): VerticalTimelineItem => ({ id, kind: 'act', y });
const marker = (id: string, y: number): VerticalTimelineItem => ({ id, kind: 'marker', y });

describe('vertical timeline projection', () => {
  it('grades entries by the free space below their dot', () => {
    const entries = projectVerticalTimeline([
      chapter('a', 44),
      chapter('b', 184),
      chapter('c', 254),
      chapter('d', 294),
      chapter('e', 306),
    ]);
    expect(entries.map(({ id, level }) => [id, level])).toEqual([
      ['a', 'L'],
      ['b', 'M'],
      ['c', 'S'],
      ['d', 'X'],
      ['e', 'L'],
    ]);
    expect(entries[0]).toMatchObject({
      top: 44 - VERTICAL_TIMELINE_ENTRY_ANCHOR,
      height: VERTICAL_TIMELINE_LEVELS.L.height,
      displaced: 0,
    });
  });

  it('gives every entry a leader from its dot to its anchor line', () => {
    const entries = projectVerticalTimeline([chapter('a', 40), chapter('b', 200)]);
    for (const entry of entries) {
      expect(entry.leader.fromY).toBe(entry.y);
      expect(entry.leader.toY).toBe(entry.top + VERTICAL_TIMELINE_ENTRY_ANCHOR);
    }
  });

  it('slides a crowded entry down instead of overlapping and keeps its leader', () => {
    const entries = projectVerticalTimeline([chapter('a', 306), chapter('b', 318), chapter('c', 400)]);
    const [a, b] = entries;
    expect(a).toMatchObject({ level: 'X', displaced: 0 });
    expect(b!.top).toBeGreaterThanOrEqual(a!.top + a!.height);
    expect(b!.displaced).toBeGreaterThan(0);
    expect(b!.leader).toEqual({ fromY: 318, toY: b!.top + VERTICAL_TIMELINE_ENTRY_ANCHOR });
    expect(entries.every((entry) => entry.kind !== 'cluster')).toBe(true);
  });

  it('collapses three or more piled chapters into one cluster with a bracket', () => {
    const entries = projectVerticalTimeline([
      chapter('a', 30),
      chapter('b', 135),
      chapter('c', 161),
      chapter('d', 167),
      chapter('e', 201),
      chapter('f', 320),
    ]);
    // b still fits exactly under a's entry; c, d and e pile up under c.
    const cluster = entries.find((entry) => entry.kind === 'cluster');
    expect(cluster).toMatchObject({
      id: 'c',
      ids: ['c', 'd', 'e'],
      top: 161,
      height: VERTICAL_TIMELINE_CLUSTER_HEIGHT,
      bracket: { fromY: 161, toY: 201 },
      level: null,
    });
    expect(entries.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'f']);
    expect(entries.every((entry) => entry.displaced === 0)).toBe(true);
  });

  it('never clusters a pair, and never clusters chips', () => {
    const entries = projectVerticalTimeline([
      act('act-1', 14),
      chapter('a', 20),
      chapter('b', 24),
      marker('m-1', 28),
      chapter('c', 200),
    ]);
    expect(entries.some((entry) => entry.kind === 'cluster')).toBe(false);
    const chips = entries.filter((entry) => entry.kind !== 'chapter');
    expect(chips.map(({ id, height }) => [id, height])).toEqual([
      ['act-1', VERTICAL_TIMELINE_CHIP_HEIGHT],
      ['m-1', VERTICAL_TIMELINE_CHIP_HEIGHT],
    ]);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.top).toBeGreaterThanOrEqual(
        entries[index - 1]!.top + entries[index - 1]!.height,
      );
    }
  });

  it('respects the list top padding and reports the content extent', () => {
    const entries = projectVerticalTimeline([chapter('a', 4)], { minTop: 16 });
    expect(entries[0]!.top).toBe(16);
    expect(verticalTimelineContentHeight(entries)).toBe(16 + VERTICAL_TIMELINE_LEVELS.L.height);
    expect(projectVerticalTimeline([])).toEqual([]);
  });

  it('orders equal coordinates deterministically by id', () => {
    const entries = projectVerticalTimeline([chapter('b', 50), chapter('a', 50)]);
    expect(entries.map(({ id }) => id)).toEqual(['a', 'b']);
  });
});
