import { useMemo, useCallback } from 'react';
import type { Storyline } from '../../domain/storyline';
import type { TimelineNode } from './types';

interface UseBottomTimelineSelectorsParams {
  nodesWithStorylines: TimelineNode[];
  storylines: Storyline[];
  isExpanded: boolean;
  expandedScale: number;
  gridUnit: number;
  // Fixed tile width in grid units. Tiles no longer have an `end`, so the
  // visual span is constant rather than derived from start/end.
  nodeDefaultWidth: number;
}

export function useBottomTimelineSelectors({
  nodesWithStorylines,
  storylines,
  isExpanded,
  expandedScale,
  gridUnit,
  nodeDefaultWidth,
}: UseBottomTimelineSelectorsParams) {
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

  const nodesByStoryline = useMemo(() => {
    const map = new Map<string, TimelineNode[]>();
    storylines.forEach((storyline) => {
      map.set(storyline.id, []);
    });

    nodesWithStorylines.forEach((node) => {
      node.storylines.forEach((storyline) => {
        const existing = map.get(storyline.id);
        if (!existing) return;
        existing.push(node);
      });
    });

    return map;
  }, [nodesWithStorylines, storylines]);

  const minNodeOrder = useMemo(() => {
    if (nodesWithStorylines.length === 0) return 1;
    return Math.min(...nodesWithStorylines.map((node) => node.bookOrder));
  }, [nodesWithStorylines]);

  // Keep the timeline baseline stable so moving the earliest node right does
  // not "zoom" the whole axis.
  const minOrder = Math.min(minNodeOrder, 1);

  const maxNodeOrder = useMemo(() => {
    if (nodesWithStorylines.length === 0) return minOrder + nodeDefaultWidth;
    return Math.max(...nodesWithStorylines.map((node) => node.bookOrder));
  }, [nodesWithStorylines, minOrder, nodeDefaultWidth]);

  // Each tile occupies `nodeDefaultWidth` grid units, so the rightmost edge
  // is one tile-width past the last node's bookOrder.
  const maxOrder = Math.max(maxNodeOrder + nodeDefaultWidth, minOrder + nodeDefaultWidth);
  const timelineRange = Math.max(maxOrder - minOrder, nodeDefaultWidth);
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const availableWidth = viewportWidth - 40;

  // 收起时固定自动缩放；展开时使用手势缩放值
  const collapsedAutoScale = Math.min(1, availableWidth / (timelineRange * gridUnit));
  const scaleFactor = isExpanded ? expandedScale : collapsedAutoScale;
  const extraSpace = isExpanded ? viewportWidth * 0.25 : 40;
  const timelineWidth = timelineRange * gridUnit * scaleFactor + extraSpace;

  // Fixed tile width — book-order tiles have no `end`, so the visual span
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
    minOrder,
    maxOrder,
    timelineRange,
    scaleFactor,
    timelineWidth,
    nodeWidth,
    orderToPosition,
  };
}
