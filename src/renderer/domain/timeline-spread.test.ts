import { describe, expect, it, vi } from 'vitest';
import { buildTimelineSpreadPlan, spreadTimelineNodes } from './timeline-spread';

describe('timeline spread', () => {
  it('keeps relative order and uses the shared chapter stride', () => {
    const nodes = [
      { id: 'later', order: 30 },
      { id: 'first', order: 10 },
      { id: 'middle', order: 20 },
    ];

    const plan = buildTimelineSpreadPlan(nodes, (node) => node.order);

    expect([...plan.newOrderById.entries()]).toEqual([
      ['first', 1],
      ['middle', 6],
      ['later', 11],
    ]);
    expect(plan.updates).toEqual([
      { id: 'first', newOrder: 1 },
      { id: 'middle', newOrder: 6 },
      { id: 'later', newOrder: 11 },
    ]);
  });

  it('updates nodes before remapping act boundaries', async () => {
    const calls: string[] = [];
    const remap = vi.fn(async () => {
      calls.push('remap');
    });

    await spreadTimelineNodes({
      nodes: [
        { id: 'a', order: 10 },
        { id: 'b', order: 20 },
      ],
      orderOf: (node) => node.order,
      updateOrder: async (id, order) => {
        calls.push(`${id}:${order}`);
      },
      remapAfterSpread: remap,
    });

    expect(calls).toEqual(['a:1', 'b:6', 'remap']);
    expect(remap).toHaveBeenCalledOnce();
  });

  it('does not remap when every order is already canonical', async () => {
    const remap = vi.fn();

    await spreadTimelineNodes({
      nodes: [
        { id: 'a', order: 1 },
        { id: 'b', order: 6 },
      ],
      orderOf: (node) => node.order,
      updateOrder: vi.fn(),
      remapAfterSpread: remap,
    });

    expect(remap).not.toHaveBeenCalled();
  });
});
