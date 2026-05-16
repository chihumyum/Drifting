import { useMemo, useCallback } from 'react';
import type { Storyline } from '../../domain/storyline';
import type { TimelineNode } from './types';

interface UseBottomTimelineSelectorsParams {
  nodesWithStorylines: TimelineNode[];
  storylines: Storyline[];
  nodeEnds: Map<string, number | null>;
  isExpanded: boolean;
  expandedScale: number;
  gridUnit: number;
  nodeMinWidth: number;
  nodeDefaultWidth: number;
}

export function useBottomTimelineSelectors({
  nodesWithStorylines,
  storylines,
  nodeEnds,
  isExpanded,
  expandedScale,
  gridUnit,
  nodeMinWidth,
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

  const minNodeStart = useMemo(() => {
    if (nodesWithStorylines.length === 0) return 1;
    return Math.min(...nodesWithStorylines.map((node) => node.start));
  }, [nodesWithStorylines]);

  // Keep timeline baseline stable so moving the earliest node right does not "zoom" the whole axis.
  const minStart = Math.min(minNodeStart, 1);

  const maxNodeEnd = useMemo(() => {
    if (nodesWithStorylines.length === 0) return minStart + nodeDefaultWidth;
    return Math.max(
      ...nodesWithStorylines.map((node) => node.end ?? node.start + nodeDefaultWidth),
    );
  }, [nodesWithStorylines, minStart, nodeDefaultWidth]);

  const maxEnd = Math.max(maxNodeEnd, minStart + nodeDefaultWidth);
  const timelineRange = Math.max(maxEnd - minStart, nodeDefaultWidth);
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const availableWidth = viewportWidth - 40;

  // 收起时固定自动缩放；展开时使用手势缩放值
  const collapsedAutoScale = Math.min(1, availableWidth / (timelineRange * gridUnit));
  const scaleFactor = isExpanded ? expandedScale : collapsedAutoScale;
  const extraSpace = isExpanded ? viewportWidth * 0.25 : 40;
  const timelineWidth = timelineRange * gridUnit * scaleFactor + extraSpace;

  const getNodeWidth = useCallback(
    (nodeId: string): number => {
      const node = nodeById.get(nodeId);
      if (!node) return nodeDefaultWidth * gridUnit * scaleFactor;

      const end = nodeEnds.get(nodeId) ?? node.end;
      if (end === null || end === undefined) {
        return nodeDefaultWidth * gridUnit * scaleFactor;
      }

      const width = (end - node.start) * gridUnit * scaleFactor;
      return Math.max(width, nodeMinWidth);
    },
    [nodeById, nodeEnds, nodeDefaultWidth, gridUnit, scaleFactor, nodeMinWidth],
  );

  const startToPosition = useCallback(
    (start: number) => {
      return (start - minStart) * gridUnit * scaleFactor;
    },
    [minStart, gridUnit, scaleFactor],
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
    minStart,
    maxEnd,
    timelineRange,
    scaleFactor,
    timelineWidth,
    getNodeWidth,
    startToPosition,
  };
}
