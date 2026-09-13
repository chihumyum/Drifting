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
});
