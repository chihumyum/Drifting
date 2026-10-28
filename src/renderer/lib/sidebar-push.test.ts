import { describe, expect, it } from 'vitest';
import { planSidebarPush } from './sidebar-push';

const W = 300;

describe('planSidebarPush', () => {
  it('pushes the resting panel out as the new one enters from its side', () => {
    expect(planSidebarPush([{ key: 'a', x: 0 }], 'b', W, 1)).toEqual([
      { key: 'a', from: 0, to: 300 },
      { key: 'b', from: -300, to: 0 },
    ]);
    expect(planSidebarPush([{ key: 'a', x: 0 }], 'b', W, -1)).toEqual([
      { key: 'a', from: 0, to: -300 },
      { key: 'b', from: 300, to: 0 },
    ]);
  });

  it('carries a half-finished push on as one strip instead of dropping its panels', () => {
    // a was leaving to the left, b arriving from the right, when c is chosen.
    const midway = [{ key: 'a', x: -120 }, { key: 'b', x: 180 }];
    expect(planSidebarPush(midway, 'c', W, -1)).toEqual([
      { key: 'a', from: -120, to: -600 },
      { key: 'b', from: 180, to: -300 },
      { key: 'c', from: 480, to: 0 },
    ]);
    // Reversing direction attaches c on the other end; nothing jumps.
    expect(planSidebarPush(midway, 'c', W, 1)).toEqual([
      { key: 'a', from: -120, to: 300 },
      { key: 'b', from: 180, to: 600 },
      { key: 'c', from: -420, to: 0 },
    ]);
  });

  it('pulls a panel still on the strip back from where it is', () => {
    expect(planSidebarPush([{ key: 'a', x: -120 }, { key: 'b', x: 180 }], 'a', W, 1)).toEqual([
      { key: 'b', from: 180, to: 300 },
      { key: 'a', from: -120, to: 0 },
    ]);
  });

  it('leaves panels already outside the pane behind', () => {
    expect(planSidebarPush([{ key: 'a', x: 300 }, { key: 'b', x: 0 }], 'c', W, -1)).toEqual([
      { key: 'b', from: 0, to: -300 },
      { key: 'c', from: 300, to: 0 },
    ]);
  });
});
