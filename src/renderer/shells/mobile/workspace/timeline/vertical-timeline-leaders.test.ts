import { describe, expect, it } from 'vitest';
import { projectVerticalTimeline } from './vertical-timeline-projection';
import { projectVerticalTimelineLeaders } from './vertical-timeline-leaders';

const layout = { gutterWidth: 100, trackX0: 10, trackStep: 20, channelOffset: 4, entryOffset: 12 };

describe('vertical timeline leaders', () => {
  it('connects chapters and crowded clusters to their first dot and skips acts and markers', () => {
    const entries = projectVerticalTimeline([
      { id: 'a', kind: 'chapter', y: 100 }, { id: 'b', kind: 'chapter', y: 101 },
      { id: 'c', kind: 'chapter', y: 102 }, { id: 'act', kind: 'act', y: 300 },
      { id: 'marker', kind: 'marker', y: 400 }, { id: 'd', kind: 'chapter', y: 500 },
    ]);
    expect(projectVerticalTimelineLeaders(entries, [{ id: 'a', trackIndex: 2 }, { id: 'd', trackIndex: 1 }], layout)).toEqual([
      { id: 'a', bracket: 'M98,100 H104 V102 H98', points: '50,100 104,100 104,100 112,100' },
      { id: 'd', bracket: null, points: '30,500 104,500 104,500 112,500' },
    ]);
  });

  it('keeps first-match and unplaced preview fallback behavior, and refreshes a changed snapshot', () => {
    const entries = projectVerticalTimeline([{ id: 'a', kind: 'chapter', y: 100 }, { id: 'unplaced', kind: 'chapter', y: 300 }]);
    const chapters = [{ id: 'a', trackIndex: 2 }, { id: 'a', trackIndex: 5 }];
    expect(projectVerticalTimelineLeaders(entries, chapters, layout).map((item) => item.points)).toEqual([
      '50,100 104,100 104,100 112,100', '10,300 104,300 104,300 112,300',
    ]);
    const changed = [{ id: 'a', trackIndex: 3 }];
    expect(projectVerticalTimelineLeaders(entries, changed, layout)[0].points).toBe('70,100 104,100 104,100 112,100');
  });
});
