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
  // An order anchor on the active axis that should extend the right extent
  // PAST the chapters — the furthest timeline marker (narrative view) or act
  // boundary (book view). Lets pins/acts be dragged or planned beyond the
  // last chapter; null when nothing sits past the chapters.
  extraMaxOrder?: number | null;
  // Fixed runway, in grid units, added beyond the furthest content anchor so
  // there is always room to drop a pin / plan an act past the end. The track
  // width derives from the same value, so the droppable range and the visible
  // range stay in sync and the persisted order is viewport-independent (a
  // narrower window just scrolls instead of re-clamping).
  runwayUnits?: number;
}

export function useBottomTimelineSelectors({
  nodesWithStorylines,
  storylines,
  isExpanded,
  expandedScale,
  gridUnit,
  nodeDefaultWidth,
  orderField,
  extraMaxOrder = null,
  runwayUnits = 0,
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

  // Right extent in order units: the last chapter's tile edge (one tile-width
  // past its order value), OR a caller-supplied anchor (the furthest marker /
  // planning act) when it sits past the chapters — PLUS a fixed runway so pins
  // and acts can always be dropped or planned beyond the last chapter. The
  // track width below derives from this, so the visible range == the droppable
  // range and the order stays viewport-independent.
  const contentMaxOrder = Math.max(
    maxNodeOrder + nodeDefaultWidth,
    extraMaxOrder ?? Number.NEGATIVE_INFINITY,
  );
  const maxOrder = Math.max(contentMaxOrder, minOrder + nodeDefaultWidth) + runwayUnits;
  const timelineRange = Math.max(maxOrder - minOrder, nodeDefaultWidth);
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const availableWidth = viewportWidth - 40;

  // 收起时固定自动缩放；展开时使用手势缩放值
  const collapsedAutoScale = Math.min(1, availableWidth / (timelineRange * gridUnit));
  const scaleFactor = isExpanded ? expandedScale : collapsedAutoScale;
  // Trailing pixel pad so the right-most pin's label (which now flows to the
  // RIGHT of the pin, like an act band) isn't clipped at the track edge. Fixed
  // rather than viewport-derived — the runway folded into maxOrder already
  // supplies the "place past the end" room, so this is just label breathing.
  const extraSpace = isExpanded ? 240 : 40;
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
