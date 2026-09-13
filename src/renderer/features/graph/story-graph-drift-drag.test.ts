import { describe, expect, it } from 'vitest';
import { createStoryGraphDriftDrag, storyGraphDriftShift } from './story-graph-drift-drag';

describe('Story Graph drift presentation lifetime', () => {
  it('keeps published snapshots stable and shifts only the crossed slots', () => {
    const drag = createStoryGraphDriftDrag(); let notifications = 0;
    const unsubscribe = drag.subscribe(() => notifications++);
    const empty = drag.getSnapshot(); drag.hover(4); expect(drag.getSnapshot()).toBe(empty);
    drag.start('synthetic-drift-a', 1); const started = drag.getSnapshot();
    drag.hover(4); const forward = drag.getSnapshot();
    expect(started).toEqual({ dragged: { id: 'synthetic-drift-a', index: 1 }, dropIndex: 1 });
    expect(forward.dragged).toBe(started.dragged);
    expect([0, 1, 2, 3, 4].map(index => storyGraphDriftShift(forward, index))).toEqual(['', '', 'translateX(-178px)', 'translateX(-178px)', '']);
    drag.hover(4); expect(drag.getSnapshot()).toBe(forward); expect(notifications).toBe(2);
    drag.start('synthetic-drift-b', 3); drag.hover(1);
    expect([0, 1, 2, 3, 4].map(index => storyGraphDriftShift(drag.getSnapshot(), index))).toEqual(['', 'translateX(178px)', 'translateX(178px)', '', '']);
    expect(Object.isFrozen(forward) && Object.isFrozen(forward.dragged)).toBe(true);
    unsubscribe();
  });

  it('clears immediately on close/cancel, ignores late hover and permits a new lifetime', () => {
    const drag = createStoryGraphDriftDrag(); const empty = drag.getSnapshot();
    let cards = 0; let edges = 0;
    const stopCards = drag.subscribe(() => cards++); const stopEdges = drag.subscribe(() => edges++);
    drag.start('synthetic-drift-a', 2); drag.hover(0); drag.cancel();
    expect(drag.getSnapshot()).toBe(empty); expect([cards, edges]).toEqual([3, 3]);
    drag.hover(8); drag.cancel(); expect([cards, edges]).toEqual([3, 3]);
    stopCards(); stopCards(); stopEdges();
    drag.start('synthetic-drift-b', 1); expect([cards, edges]).toEqual([3, 3]);
    expect(drag.getSnapshot().dragged?.id).toBe('synthetic-drift-b');
    drag.cancel(); expect(drag.getSnapshot()).toBe(empty);
  });

  it('notifies exactly the changed slots across forward, reverse, source replacement and cancellation', () => {
    const drag = createStoryGraphDriftDrag();
    const notices = Array<number>(8).fill(0);
    const stops = notices.map((_, index) => drag.subscribeCard(index, () => { notices[index]++; }));
    const expected = () => notices.map((_, index) => {
      const { dragged, dropIndex } = drag.getSnapshot();
      if (!dragged || dropIndex === null) return '';
      if (index === dragged.index) return 'dragged';
      if (dragged.index < index && index < dropIndex) return 'translateX(-178px)';
      if (dropIndex <= index && index < dragged.index) return 'translateX(178px)';
      return '';
    });
    function change(action: () => void) {
      const before = expected(); notices.fill(0); action(); const after = expected();
      expect(notices).toEqual(after.map((value, index) => Number(value !== before[index])));
      expect(after.map((_, index) => drag.getCardSnapshot(index))).toEqual(after);
    }
    for (let source = 0; source < 8; source++) {
      change(() => drag.start(`synthetic-${source}`, source));
      for (let previous = 0; previous <= 8; previous++) {
        change(() => drag.hover(previous));
        for (let next = 8; next >= 0; next--) change(() => drag.hover(next));
      }
      change(() => drag.start(`replacement-${source}`, source));
    }
    change(() => drag.cancel()); stops.forEach(stop => stop());
    notices.fill(0); drag.start('disposed', 2); drag.hover(0); drag.cancel();
    expect(notices).toEqual(Array(8).fill(0));
  });

  it('keeps adjacent hover notifications local in 5000 cards and bounds far targets to subscribed slots', () => {
    const drag = createStoryGraphDriftDrag(); const notices = Array<number>(5000).fill(0);
    const stops = notices.map((_, index) => drag.subscribeCard(index, () => { notices[index]++; }));
    drag.start('synthetic-first', 0); expect(notices[0]).toBe(1); notices.fill(0);
    for (let target = 1; target <= 20; target++) drag.hover(target);
    expect(notices.reduce((sum, count) => sum + count, 0)).toBe(19);
    expect(notices.slice(1, 20)).toEqual(Array(19).fill(1));
    notices.fill(0); drag.hover(Number.MAX_SAFE_INTEGER);
    expect(notices.reduce((sum, count) => sum + count, 0)).toBe(4980);
    notices.fill(0); drag.cancel(); expect(notices).toEqual(Array(5000).fill(1));
    stops.forEach(stop => { stop(); stop(); });
    let current = 0; const stop = drag.subscribeCard(0, () => { current++; });
    drag.start('new-lifetime', 0); expect(current).toBe(1);
    expect(notices).toEqual(Array(5000).fill(1)); stop();
  });
});
