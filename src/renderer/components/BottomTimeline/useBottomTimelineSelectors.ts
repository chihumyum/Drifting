import { useMemo, useCallback } from 'react';
import type { Storyline } from '../../domain/storyline';
import type { TimelineNode } from './types';

export type TimelineOrderField = 'bookOrder' | 'narrativeOrder';

interface UseBottomTimelineSelectorsParams {
  nodesWithStorylines: TimelineNode[];
  storylines: Storyline[];
  isExpanded: boolean;
  expandedScale: number;
  gridUnit: number;
  // Fixed tile width in grid units. Tiles no longer have an `end`, so the
  // visual span is constant rather than derived from start/end.
  nodeDefaultWidth: number;
  // Which integer field on a node drives x-position. Book order is always
  // set; narrative order is nullable — nodes with null are filtered out of
  // `placedNodes` (and surface in `unplacedNodes` for the holding drawer).
  orderField: TimelineOrderField;
}

export function useBottomTimelineSelectors({
  nodesWithStorylines,
  storylines,
  isExpanded,
  expandedScale,
  gridUnit,
  nodeDefaultWidth,
  orderField,
}: UseBottomTimelineSelectorsParams) {
  const orderOf = useCallback(
    (node: TimelineNode): number | null => {
      const v = node[orderField];
      return typeof v === 'number' ? v : null;
    },
    [orderField],
  );

  const { placedNodes, unplacedNodes } = useMemo(() => {
    const placed: TimelineNode[] = [];
    const unplaced: TimelineNode[] = [];
    for (const n of nodesWithStorylines) {
      if (orderOf(n) === null) unplaced.push(n);
      else placed.push(n);
    }
    return { placedNodes: placed, unplacedNodes: unplaced };
  }, [nodesWithStorylines, orderOf]);

  const nodeById = useMemo(() => {
    const map = new Map<string, TimelineNode>();
    nodesWithStorylines.forEach((node) => {
      map.set(node.id, node);
    });
    return map;
  }, [nodesWithStorylines]);

  const storylineById = useMemo(() => {
    const map = new Map<string, Storyline>();
    storylines.forEach((storyline) => {
      map.set(storyline.id, storyline);
    });
    return map;
  }, [storylines]);

  // Only placed nodes participate in storyline rows; unplaced narrative
  // nodes still belong to their storylines but live in the holding drawer.
  const nodesByStoryline = useMemo(() => {
    const map = new Map<string, TimelineNode[]>();
    storylines.forEach((storyline) => {
      map.set(storyline.id, []);
    });

    placedNodes.forEach((node) => {
      node.storylines.forEach((storyline) => {
        const existing = map.get(storyline.id);
        if (!existing) return;
        existing.push(node);
      });
    });

    return map;
  }, [placedNodes, storylines]);

  const minNodeOrder = useMemo(() => {
    if (placedNodes.length === 0) return 1;
    return Math.min(...placedNodes.map((node) => orderOf(node) ?? 0));
  }, [placedNodes, orderOf]);

  // Keep the timeline baseline stable so moving the earliest node right does
  // not "zoom" the whole axis.
  const minOrder = Math.min(minNodeOrder, 1);

  const maxNodeOrder = useMemo(() => {
    if (placedNodes.length === 0) return minOrder + nodeDefaultWidth;
    return Math.max(...placedNodes.map((node) => orderOf(node) ?? 0));
  }, [placedNodes, minOrder, nodeDefaultWidth, orderOf]);

  // Each tile occupies `nodeDefaultWidth` grid units, so the rightmost edge
  // is one tile-width past the last node's order value.
  const maxOrder = Math.max(maxNodeOrder + nodeDefaultWidth, minOrder + nodeDefaultWidth);
  const timelineRange = Math.max(maxOrder - minOrder, nodeDefaultWidth);
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const availableWidth = viewportWidth - 40;

  // 收起时固定自动缩放；展开时使用手势缩放值
  const collapsedAutoScale = Math.min(1, availableWidth / (timelineRange * gridUnit));
  const scaleFactor = isExpanded ? expandedScale : collapsedAutoScale;
  const extraSpace = isExpanded ? viewportWidth * 0.25 : 40;
  const timelineWidth = timelineRange * gridUnit * scaleFactor + extraSpace;

  // Fixed tile width — tiles no longer have an `end`, so the visual span
  // is `nodeDefaultWidth` grid units regardless of node.
  const nodeWidth = nodeDefaultWidth * gridUnit * scaleFactor;

  const orderToPosition = useCallback(
    (order: number) => {
      return (order - minOrder) * gridUnit * scaleFactor;
    },
    [minOrder, gridUnit, scaleFactor],
  );

  const getNodesInStoryline = useCallback(
    (storylineId: string) => {
      return nodesByStoryline.get(storylineId) ?? [];
    },
    [nodesByStoryline],
  );

  return {
    nodeById,
    storylineById,
    nodesByStoryline,
    getNodesInStoryline,
    placedNodes,
    unplacedNodes,
    orderOf,
    minOrder,
    maxOrder,
    timelineRange,
    scaleFactor,
    timelineWidth,
    nodeWidth,
    orderToPosition,
  };
}
