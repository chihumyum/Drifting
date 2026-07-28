import { CHAPTER_ORDER_STRIDE } from './book-node';

interface SpreadableTimelineNode {
  id: string;
}

export interface TimelineSpreadPlan {
  updates: Array<{ id: string; newOrder: number }>;
  oldOrderById: Map<string, number>;
  newOrderById: Map<string, number>;
}

export function buildTimelineSpreadPlan<T extends SpreadableTimelineNode>(
  nodes: readonly T[],
  orderOf: (node: T) => number | null | undefined,
  spacing = CHAPTER_ORDER_STRIDE,
): TimelineSpreadPlan {
  const sorted = [...nodes].sort((a, b) => (orderOf(a) ?? 0) - (orderOf(b) ?? 0));
  const startOrder = sorted.length > 0 ? Math.min(orderOf(sorted[0]) ?? 1, 1) : 1;
  const oldOrderById = new Map<string, number>();
  const newOrderById = new Map<string, number>();
  const updates: Array<{ id: string; newOrder: number }> = [];

  sorted.forEach((node, index) => {
    const oldOrder = orderOf(node) ?? 0;
    const newOrder = startOrder + index * spacing;
    oldOrderById.set(node.id, oldOrder);
    newOrderById.set(node.id, newOrder);
    if (oldOrder !== newOrder) updates.push({ id: node.id, newOrder });
  });

  return { updates, oldOrderById, newOrderById };
}

interface SpreadTimelineNodesOptions<T extends SpreadableTimelineNode> {
  nodes: readonly T[];
  orderOf: (node: T) => number | null | undefined;
  updateOrder: (id: string, newOrder: number) => Promise<unknown>;
  remapAfterSpread?: (
    oldOrderById: Map<string, number>,
    newOrderById: Map<string, number>,
  ) => Promise<unknown>;
}

/**
 * Single spread command for every timeline surface. Callers supply only the
 * active axis adapter; book-axis callers additionally supply act remapping.
 */
export async function spreadTimelineNodes<T extends SpreadableTimelineNode>({
  nodes,
  orderOf,
  updateOrder,
  remapAfterSpread,
}: SpreadTimelineNodesOptions<T>): Promise<TimelineSpreadPlan> {
  const plan = buildTimelineSpreadPlan(nodes, orderOf);
  for (const update of plan.updates) {
    await updateOrder(update.id, update.newOrder);
  }
  if (plan.updates.length > 0 && remapAfterSpread) {
    await remapAfterSpread(plan.oldOrderById, plan.newOrderById);
  }
  return plan;
}
