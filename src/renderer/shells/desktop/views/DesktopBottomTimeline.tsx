import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useMatch } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStoryline } from '../../../usecase/useStoryline';
import { useBookNode } from '../../../usecase/useBookNode';
import type { Storyline } from '../../../domain/storyline';
import { CHAPTER_ORDER_STRIDE, isChapter, isDrift } from '../../../domain/book-node';
import { resolvePrimaryStorylineId } from '../../../domain/node-storyline-state';
import { spreadTimelineNodes } from '../../../domain/timeline-spread';
import { useAuthStore } from '../../../store/auth';
import { EntityHoverCard } from '../../../features/entities/hover/EntityHoverCard';
import { useDataStore } from '../../../store/data-store';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useTimelineExpandedScale } from '../../../components/BottomTimeline/useTimelineExpandedScale';
import { useBottomTimelineContextMenuActions } from '../../../components/BottomTimeline/useBottomTimelineContextMenuActions';
import { useBottomTimelineSelectors } from '../../../components/BottomTimeline/useBottomTimelineSelectors';
import { useBottomTimelineInteractionState } from '../../../components/BottomTimeline/useBottomTimelineInteractionState';
import { EntityCellContextMenu } from '../../../components/leftBars/EntityCellContextMenu';
import { useEntityCellAction } from '../../../hooks/useEntityCellAction';
import { TimelineRailMenu } from '../../../components/graph/TimelineRailMenu';
import { TimelinePin as SharedTimelinePin } from '../../../components/timeline/TimelinePin';
import { ActRail } from '../../../components/BottomTimeline/ActRail';
import {
  TimelineMarkerLines,
  TimelineActDragLine,
} from '../../../components/timeline/TimelineGuideLines';
import { createTimelineDragPreview } from '../../../features/graph/timeline-drag-preview';
import { useBookAct } from '../../../usecase/useBookAct';
import { events } from '../../../lib/events';
import {
  clampDimension,
  parsePersistedDimension,
  verticalDockBounds,
} from '../../../lib/layout-geometry';
import type { TimelineNode } from '../../../components/BottomTimeline/types';
import { useUiStore, usePromoteCurrentTab } from '../../../store/ui-store';
import { useTimelineMarkers } from '../../../hooks/useTimelineMarkers';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import {
  DEFAULT_STORYLINE_LANE_ID as DEFAULT_LANE_ID,
  UNAFFILIATED_STORYLINE_LANE_ID as UNAFFILIATED_LANE_ID,
  canDropChapterOnLane,
  chapterLaneGrabOffsetX,
  commitChapterLaneDrop,
  resolveChapterLanePointerTarget,
  startChapterLanePointerDrag,
} from '../../../features/graph/chapter-lane-drag';
import {
  MOBILE_PLANNING_CONTEXT_MENU_MS,
  MOBILE_PLANNING_MOVE_TOLERANCE_PX,
} from '../../../features/graph/mobile-planning-gesture';
import loglevel from 'loglevel';
import '../../../../styles/bottom-timeline.css';
const log = loglevel.getLogger('BottomTimeline');
log.setLevel(loglevel.levels.WARN);

// BottomTimeline hosts two views over the storyline rows:
//   - book      — tiles sorted by node.bookOrder
//   - narrative — tiles sorted by node.narrativeOrder; nodes without one
//                 sit in the holding popover (top-right of the head).
// In book view, the ActRail (幕 strip) runs across the top — act bands in
// track coordinate space, aligned with the chapter columns below (it
// replaced the old packed-chip FullBookLane). Narrative view skips it (its
// time axis takes the same vertical slot instead).
//
// The old collapsed (strip) state is gone — the timeline is either visible
// or hidden, controlled by the full-width BottomStatusBar below the workspace
// row. Visibility lives in uiStore so the footer toggle can reach it.
type TimelineView = 'book' | 'narrative';
const TIMELINE_VIEW_STORAGE_KEY = 'timeline-view';
const TIMELINE_HEIGHT_STORAGE_KEY = 'timeline-total-height';
const MIN_EDITOR_HEIGHT = 240;

const TIMELINE_CONFIG = {
  GRID_UNIT: 20,
  // Fixed tile width in grid units. Tiles no longer carry an `end`, so all
  // tiles occupy the same horizontal span.
  NODE_DEFAULT_WIDTH: 4,
  // Runway (grid units) the axis extends past the furthest chapter / marker /
  // act, so pins can be dragged and acts planned beyond the last chapter.
  RUNWAY_UNITS: 12,
  NODE_MIN_HEIGHT: 30,
  STORYLINE_GAP: 2,
  RAIL_WIDTH: 148,
  HEAD_HEIGHT: 30,
  AXIS_HEIGHT: 22,
  // Match the narrative-axis height (22px) so the lane and axis sit at
  // the same vertical extent regardless of which view is active — visual
  // continuity across mode toggle.
  FULL_BOOK_LANE_HEIGHT: 22,
  DEFAULT_HEIGHT: 180,
  MIN_HEIGHT: 180,
};

function readPersistedView(): TimelineView {
  if (typeof localStorage === 'undefined') return 'book';
  const v = localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY);
  return v === 'narrative' ? 'narrative' : 'book';
}

// Synthetic lane sentinels. These never hit the DB — they're virtual lanes
// for the two edge cases the storyline rendering needs to handle:
//   • DEFAULT_LANE_ID: project has zero storylines (single-lane writing mode).
//     All chapters render in one lane labelled "本书".
//   • UNAFFILIATED_LANE_ID: project has ≥ 1 storyline AND some chapters have
//     no primary storyline link ("未归属"). Default collapsed.
function makeSyntheticStoryline(id: string, name: string, color: string): Storyline {
  // Filling in the Storyline shape with empty/placeholder values for fields
  // the lane renderer reads but the synthetic lane doesn't conceptually have.
  return {
    id,
    projectId: '',
    name,
    color,
    summary: '',
    orderKey: 0,
    contentJson: '{}',
    kvJson: '[]',
    nodeContentTemplateJson: '{}',
    createdAt: '',
    updatedAt: '',
  };
}

export type BottomTimelinePresentation = 'desktop' | 'mobile';

export function DesktopBottomTimeline({
  presentation = 'desktop',
}: {
  presentation?: BottomTimelinePresentation;
} = {}) {
  const { t } = useTranslation();
  const isMobilePresentation = presentation === 'mobile';
  const railWidth = isMobilePresentation ? 104 : TIMELINE_CONFIG.RAIL_WIDTH;
  const headHeight = isMobilePresentation ? 42 : TIMELINE_CONFIG.HEAD_HEIGHT;
  const axisHeightValue = isMobilePresentation ? 36 : TIMELINE_CONFIG.AXIS_HEIGHT;
  const actRailHeightValue = isMobilePresentation ? 36 : TIMELINE_CONFIG.FULL_BOOK_LANE_HEIGHT;
  const nodeMinHeight = isMobilePresentation ? 44 : TIMELINE_CONFIG.NODE_MIN_HEIGHT;
  const editorMatch = useMatch('/project/:projectId/editor/:nodeId');
  const storylineMatch = useMatch('/project/:projectId/editor/storyline/:storylineId');
  const nodeId = editorMatch?.params.nodeId;
  const storylineId = storylineMatch?.params.storylineId;
  const user = useAuthStore((state) => state.user);
  const { bookNodes, storylines, nodeStorylineMapping, primaryStorylineByNode } = useDataStoreFields('bookNodes', 'storylines', 'nodeStorylineMapping', 'primaryStorylineByNode');
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const selectedNodeUiId = useUiStore((state) => state.nodeUi.selectedId);
  const { projectId, navigateToNode, openEntity } = useProjectNavigation();
  const promoteCurrentTab = usePromoteCurrentTab(projectId);
  const { markers, addMarker, updateMarker, deleteMarker } = useTimelineMarkers(projectId);
  // Drift binding lookups for the narrative pins: live titles for bound
  // pins, and the not-yet-bound set for the bind picker.
  const driftById = useMemo(() => {
    const m = new Map<string, { id: string; title: string }>();
    for (const n of bookNodes) {
      if (isDrift(n)) m.set(n.id, { id: n.id, title: n.title });
    }
    return m;
  }, [bookNodes]);
  const bookActs = useDataStore((s) => s.bookActs);
  const { splitAtOrder, updateAct, moveBoundary, unbindDrift, deleteAct, remapAfterSpread } =
    useBookAct({
      projectId: projectId ?? '',
    });
  const { createNode, updateNode, moveChapterOnTimeline } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { setNodeStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });

  const nodesWithStorylines = useMemo<TimelineNode[]>(() => {
    const storylineById = new Map(storylines.map((sl) => [sl.id, sl]));
    return bookNodes.filter(isChapter).map((node) => ({
      ...node,
      storylines: (nodeStorylineMapping[node.id] || [])
        .map((slId) => storylineById.get(slId))
        .filter((sl): sl is Storyline => Boolean(sl)),
    }));
  }, [bookNodes, nodeStorylineMapping, storylines]);

  const [viewMode, setViewMode] = useState<TimelineView>(readPersistedView);
  const [isResizingHeight, setIsResizingHeight] = useState(false);
  // Offset from the mouse cursor to the timeline's top edge at the moment the
  // resize drag started. Preserved across the drag so the grabbed point stays
  // glued to the cursor instead of snapping the top edge onto the mouse y.
  const resizeGrabOffsetRef = useRef(0);
  // The timeline's bottom (in viewport coords) at mousedown. The dock isn't
  // flush with the viewport edge — the full-width `BottomStatusBar` sits below
  // the workspace row — so we
  // can't compute height from `window.innerHeight`. The bottom is fixed
  // during the drag (only the top edge moves), so capturing once is enough.
  const resizeBottomYRef = useRef(0);
  const [unplacedPopoverOpen, setUnplacedPopoverOpen] = useState(false);
  // Unaffiliated lane (chapters with no primary storyline) visibility is
  // persisted in ui-store so the toggle decision sticks across sessions —
  // users who keep the lane open shouldn't have to re-toggle it every time
  // they reopen the app.
  const unaffiliatedVisible = useUiStore((s) => s.bottomTimelineUnaffiliatedVisible);
  const setUnaffiliatedVisible = useUiStore((s) => s.setBottomTimelineUnaffiliatedVisible);
  const [customHeight, setCustomHeight] = useState<number | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const persisted = parsePersistedDimension(localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY));
    if (persisted === null) return null;
    return clampDimension(
      persisted,
      verticalDockBounds(window.innerHeight, TIMELINE_CONFIG.MIN_HEIGHT, MIN_EDITOR_HEIGHT),
    );
  });

  const isNarrative = viewMode === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';
  const nextBookOrder = useMemo(() => {
    const chapters = bookNodes.filter(isChapter);
    if (chapters.length === 0) return 0;
    return Math.max(...chapters.map((chapter) => chapter.bookOrder)) + CHAPTER_ORDER_STRIDE;
  }, [bookNodes]);

  useEffect(() => {
    localStorage.setItem(TIMELINE_VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  const {
    contextMenu,
    hoveredNodeId,
    hoverAnchor,
    setContextMenu,
    clearContextMenu,
    setHoverPreview,
    clearHoverPreview,
  } = useBottomTimelineInteractionState();
  const touchMenuCleanupRef = useRef<(() => void) | null>(null);
  const suppressPointerClickRef = useRef(false);

  useEffect(() => () => touchMenuCleanupRef.current?.(), []);

  const beginTouchMenu = (event: React.PointerEvent, open: () => void) => {
    if (!isMobilePresentation || event.pointerType !== 'touch') return;
    touchMenuCleanupRef.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let timer = window.setTimeout(() => {
      timer = 0;
      suppressPointerClickRef.current = true;
      open();
    }, MOBILE_PLANNING_CONTEXT_MENU_MS);
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      if (touchMenuCleanupRef.current === cleanup) touchMenuCleanupRef.current = null;
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >
        MOBILE_PLANNING_MOVE_TOLERANCE_PX
      ) {
        cleanup();
      }
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup();
    };
    touchMenuCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [mobileTimelineHeight, setMobileTimelineHeight] = useState(0);
  const timelineHeightBounds = useCallback(() => {
    const appMid = timelineRef.current?.closest('.app-mid');
    const containerHeight = appMid?.getBoundingClientRect().height ?? window.innerHeight;
    return verticalDockBounds(containerHeight, TIMELINE_CONFIG.MIN_HEIGHT, MIN_EDITOR_HEIGHT);
  }, []);

  // A height restored on a large monitor must not remain authoritative after
  // the native window moves to a smaller display. ResizeObserver also covers
  // shell changes caused by chrome/timeline layout without a window resize.
  useEffect(() => {
    if (isMobilePresentation) return undefined;
    const normalize = () => {
      const base = customHeight ?? TIMELINE_CONFIG.DEFAULT_HEIGHT;
      const next = clampDimension(base, timelineHeightBounds());
      if (next === base) return;
      setCustomHeight(next);
      localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, next.toString());
    };
    const frame = window.requestAnimationFrame(normalize);
    const appMid = timelineRef.current?.closest('.app-mid');
    const observer =
      appMid && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(normalize) : null;
    if (appMid && observer) observer.observe(appMid);
    window.addEventListener('resize', normalize);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', normalize);
    };
  }, [customHeight, isMobilePresentation, timelineHeightBounds]);

  useEffect(() => {
    if (!isMobilePresentation || !timelineRef.current) return undefined;
    const timeline = timelineRef.current;
    const update = () => setMobileTimelineHeight(timeline.clientHeight);
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(timeline);
    return () => observer?.disconnect();
  }, [isMobilePresentation]);
  const { expandedScale, touchHandlers } = useTimelineExpandedScale({
    isExpanded: true,
    scrollContainerRef,
  });

  const saveScrollPosition = useCallback(() => {
    if (scrollContainerRef.current) {
      const scrollLeft = scrollContainerRef.current.scrollLeft;
      localStorage.setItem('timeline-scroll-position', scrollLeft.toString());
    }
  }, []);

  useEffect(() => {
    const savedPosition = localStorage.getItem('timeline-scroll-position');
    if (savedPosition && scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = parseInt(savedPosition, 10);
    }
  }, [storylines.length]);

  // Drag-resize top edge (visible only — no collapsed mode anymore).
  useEffect(() => {
    if (!isResizingHeight || isMobilePresentation) return;
    let lastValue: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      const minHeight =
        headHeight +
        actRailHeightValue +
        Math.max(storylines.length, 1) * (nodeMinHeight + TIMELINE_CONFIG.STORYLINE_GAP);
      // height = (bottom edge) − (new top edge), where the new top edge is
      // `e.clientY − grabOffset` so the originally-grabbed pixel stays under
      // the cursor.
      const bounds = timelineHeightBounds();
      const next = clampDimension(
        resizeBottomYRef.current - e.clientY + resizeGrabOffsetRef.current,
        {
          min: Math.min(bounds.max, Math.max(minHeight, bounds.min)),
          max: bounds.max,
        },
      );
      lastValue = next;
      setCustomHeight(next);
    };

    const handleMouseUp = () => {
      setIsResizingHeight(false);
      if (lastValue !== null) {
        localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, lastValue.toString());
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    actRailHeightValue,
    headHeight,
    isMobilePresentation,
    isResizingHeight,
    nodeMinHeight,
    storylines.length,
    timelineHeightBounds,
  ]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let timeoutId: number;
    const handleScroll = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => saveScrollPosition(), 300);
    };
    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearTimeout(timeoutId);
    };
  }, [saveScrollPosition]);

  // Furthest order anchor that should push the axis past the chapters: in
  // narrative view the last marker, in book view the last act boundary. Folded
  // into the selectors' right extent so a pin/act placed past the end keeps the
  // axis (and the snap grid) reaching out to it — drag it to the edge and the
  // axis grows another runway, so the reach is effectively unbounded.
  const rightAnchorOrder = useMemo(() => {
    const vals = isNarrative
      ? markers.map((m) => m.narrativeOrder)
      : bookActs.map((a) => a.startOrder ?? Number.NEGATIVE_INFINITY);
    return vals.length ? Math.max(...vals) : null;
  }, [isNarrative, markers, bookActs]);

  const {
    nodeById,
    storylineById,
    getNodesInStoryline,
    placedNodes,
    unplacedNodes,
    orderOf,
    minOrder,
    maxOrder,
    scaleFactor,
    timelineWidth,
    nodeWidth,
    orderToPosition,
    positionToOrder,
  } = useBottomTimelineSelectors({
    nodesWithStorylines,
    storylines,
    isExpanded: true,
    expandedScale,
    gridUnit: TIMELINE_CONFIG.GRID_UNIT,
    nodeDefaultWidth: TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
    orderField,
    extraMaxOrder: rightAnchorOrder,
    runwayUnits: TIMELINE_CONFIG.RUNWAY_UNITS,
  });

  // Helper: which storyline owns this node as its "main" row. Reads the
  // primary from the link table (via the store), falling back to the first
  // storyline in the membership list when no primary is set.
  const primaryStorylineId = useCallback(
    (node: { id: string; storylines: Storyline[] }) =>
      resolvePrimaryStorylineId(
        primaryStorylineByNode[node.id],
        node.storylines.map((storyline) => storyline.id),
      ),
    [primaryStorylineByNode],
  );

  const getTimelineHeight = () =>
    clampDimension(
      customHeight ?? TIMELINE_CONFIG.DEFAULT_HEIGHT,
      verticalDockBounds(
        typeof window === 'undefined' ? 700 : window.innerHeight,
        TIMELINE_CONFIG.MIN_HEIGHT,
        MIN_EDITOR_HEIGHT,
      ),
    );

  const dispatchEntityAction = useEntityCellAction();
  const { handleContextMenuAction } = useBottomTimelineContextMenuActions({
    contextMenu,
    projectId,
    orderField,
    nextBookOrder,
    scrollContainerRef,
    createNode,
    setNodeStorylines,
    updateNode: async (id, updates) => {
      await updateNode(id, updates);
    },
    navigateToNode,
    onCloseMenu: clearContextMenu,
    onError: (message, error) => log.error(message, error),
  });

  // Outside-click / Esc dismissal is handled inside EntityCellContextMenu
  // itself, so no separate effect is needed for the timeline cmenu state.

  const unplacedBtnRef = useRef<HTMLButtonElement>(null);

  const startNodePointerDrag = (
    event: React.PointerEvent<HTMLElement>,
    node: TimelineNode,
    storylineId: string,
    options: { fromDrawer?: boolean } = {},
  ) => {
    const fromDrawer = options.fromDrawer ?? false;
    const isSyntheticLane =
      storylineId === DEFAULT_LANE_ID || storylineId === UNAFFILIATED_LANE_ID;
    if (
      event.button !== 0 ||
      (!fromDrawer && !isSyntheticLane && primaryStorylineId(node) !== storylineId)
    ) {
      return;
    }
    const sourceElement = event.currentTarget;
    const touchMenuPoint = { x: event.clientX + 2, y: event.clientY - 2 };
    if (isMobilePresentation && event.pointerType === 'touch') event.stopPropagation();
    const grabOffsetX = chapterLaneGrabOffsetX(
      event.clientX,
      sourceElement.getBoundingClientRect(),
    );
    startChapterLanePointerDrag({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startClientX: event.clientX,
      startClientY: event.clientY,
      sourceElement,
      grabOffsetX,
      resolveTarget: (clientX, clientY) => {
        const target = resolveChapterLanePointerTarget({
          clientX,
          clientY,
          grabOffsetX,
          positionToOrder,
        });
        if (
          !target ||
          !canDropChapterOnLane({
            targetLaneId: target.storylineId,
            fromDrawer,
            primaryStorylineId: primaryStorylineId(node),
          })
        ) {
          return null;
        }
        return target;
      },
      onDragStart: () => {
        touchMenuCleanupRef.current?.();
        suppressPointerClickRef.current = true;
        clearContextMenu();
        clearHoverPreview();
      },
      onDrop: async (target) => {
        try {
          await commitChapterLaneDrop({
            nodeId: node.id,
            targetLaneId: target.storylineId,
            targetOrder: target.order,
            orderField,
            moveChapterOnTimeline,
          });
        } catch (error) {
          log.error('Failed to handle timeline pointer drop:', error);
        }
      },
      onDragEnd: () => {
        clearHoverPreview();
        if (fromDrawer) setUnplacedPopoverOpen(false);
        window.setTimeout(() => {
          suppressPointerClickRef.current = false;
        }, 0);
      },
      mobileTouch:
        isMobilePresentation && event.pointerType === 'touch'
          ? {
              scrollContainer: scrollContainerRef.current,
              onMenu: () => {
                suppressPointerClickRef.current = true;
                clearHoverPreview();
                setContextMenu({
                  ...touchMenuPoint,
                  type: 'node',
                  nodeId: node.id,
                  storylineId: storylineId || undefined,
                  nodeTitle: node.title,
                  nodeSummary: node.summary,
                  nodeStorylines: node.storylines,
                });
              },
            }
          : undefined,
    });
  };

  const handleNodeClick = (clickedNodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (suppressPointerClickRef.current) {
      suppressPointerClickRef.current = false;
      e.preventDefault();
      return;
    }
    clearContextMenu();
    if (isMobilePresentation) {
      openEntity({ entityType: 'node', id: clickedNodeId });
      return;
    }
    setNodeSelection(clickedNodeId, 'ui');
  };

  const handleNodeMouseEnter = (node: TimelineNode, e: React.MouseEvent<HTMLElement>) => {
    setHoverPreview({
      nodeId: node.id,
      anchor: e.currentTarget,
    });
  };

  const handleNodeMouseLeave = () => {
    clearHoverPreview();
  };

  const handleTimelineClick = (event: React.MouseEvent) => {
    if (suppressPointerClickRef.current) {
      suppressPointerClickRef.current = false;
      event.preventDefault();
      return;
    }
    clearContextMenu();
  };

  const isPrimaryStorylineForNode = (node: TimelineNode, storylineId: string): boolean => {
    return primaryStorylineId(node) === storylineId;
  };

  const storylineRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    storylines.forEach((s, idx) => map.set(s.id, idx));
    return map;
  }, [storylines]);

  const sortedNodesByStoryline = useMemo(() => {
    const m = new Map<string, TimelineNode[]>();
    storylines.forEach((s) => m.set(s.id, []));
    placedNodes.forEach((node) => {
      node.storylines.forEach((sl) => {
        const arr = m.get(sl.id);
        if (arr) arr.push(node);
      });
    });
    m.forEach((arr) =>
      arr.sort((a, b) => {
        const difference = (orderOf(a) ?? 0) - (orderOf(b) ?? 0);
        if (difference !== 0) return difference;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
    );
    return m;
  }, [placedNodes, storylines, orderOf]);

  const crossStorylineLinks = useMemo(() => {
    type Link = {
      key: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      color: string;
    };
    const links: Link[] = [];

    // Iterate by lane edges, not by node. The old per-node iteration
    // emitted four curves per A→B pair (two anchor perspectives × two
    // half-paths), each ending at a PHANTOM point on the secondary row
    // where neither node has a tile — hence the "凭空产生" complaint.
    // Now: for each adjacent (A, B) pair in storyline S's lane, draw ONE
    // curve from A's actual tile (on A's main row) to B's actual tile
    // (on B's main row), colored S, dashed. The curve naturally sweeps
    // through S's row when A and B sit on different main storylines, so
    // the "transit through S" reading still reads visually — but every
    // endpoint lands on a real tile.
    for (const sl of storylines) {
      const lane = sortedNodesByStoryline.get(sl.id) ?? [];
      if (lane.length < 2) continue;
      const color = sl.color || 'hsl(var(--ink-4))';

      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const aMain = primaryStorylineId(a);
        const bMain = primaryStorylineId(b);
        // Skip when both A and B have S as their main storyline — the
        // adjacency is already visible from the row's tile-to-tile
        // sequence, so the curve would just be redundant clutter.
        if (aMain === sl.id && bMain === sl.id) continue;
        if (!aMain || !bMain) continue;

        const aRowIdx = storylineRowIndex.get(aMain);
        const bRowIdx = storylineRowIndex.get(bMain);
        if (aRowIdx === undefined || bRowIdx === undefined) continue;

        const aOrder = orderOf(a);
        const bOrder = orderOf(b);
        if (aOrder === null || bOrder === null) continue;

        links.push({
          key: `xlink:${sl.id}:${a.id}->${b.id}`,
          fromX: orderToPosition(aOrder) + nodeWidth / 2,
          fromY: aRowIdx,
          toX: orderToPosition(bOrder) + nodeWidth / 2,
          toY: bRowIdx,
          color,
        });
      }
    }
    return links;
  }, [
    storylines,
    storylineRowIndex,
    sortedNodesByStoryline,
    orderToPosition,
    nodeWidth,
    primaryStorylineId,
    orderOf,
  ]);

  const renderNodeCard = (node: TimelineNode, storylineId: string) => {
    const storyline = storylineById.get(storylineId);
    const isSelected = (isMobilePresentation ? nodeId : (selectedNodeUiId ?? nodeId)) === node.id;
    // Synthetic lanes (本书 / 未归属) host nodes that have no real primary
    // storyline — the lane itself is the visible "primary". Skipping the
    // primary check ensures these tiles render; clip color falls back to
    // the synthetic lane's color below.
    const isSyntheticLane = storylineId === DEFAULT_LANE_ID || storylineId === UNAFFILIATED_LANE_ID;
    const isPrimary = isSyntheticLane || isPrimaryStorylineForNode(node, storylineId);

    if (!isPrimary) return null;

    const order = orderOf(node);
    if (order === null) return null;

    const defaultColor = '#2D4A6B';
    const clipColor = storyline?.color || defaultColor;
    const leftPosition = orderToPosition(order);
    // Mutually-exclusive author-facing status classes.
    const status = node.writingStatus;
    const stateClass =
      status === 'finished' ? 'is-finished' : status === 'discarded' ? 'is-discarded' : 'is-draft';

    const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
      if (hoveredNodeId !== node.id) {
        handleNodeMouseEnter(node, e);
      }
    };

    const className = [
      'btl-clip',
      isSelected ? 'is-selected' : '',
      stateClass,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        key={`${node.id}-${storylineId}`}
        data-node-card
        className={className}
        onPointerDown={(event) => startNodePointerDrag(event, node, storylineId)}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleNodeMouseLeave}
        onClick={(e) => handleNodeClick(node.id, e)}
        style={
          {
            left: leftPosition,
            width: nodeWidth,
            cursor: isPrimary ? 'grab' : 'pointer',
            ['--clip-color' as string]: clipColor,
          } as React.CSSProperties
        }
      >
        <div className="btl-clip__content">
          <div className="btl-clip__title">{node.title || t('common.untitled')}</div>
        </div>
      </div>
    );
  };

  const renderStorylineRow = (
    storyline: Storyline,
    laneOpts?: { nodes?: TimelineNode[]; synthetic?: boolean },
  ) => {
    // Synthetic lanes pass their nodes in explicitly (they aren't in
    // nodesByStoryline). Real storylines look up via the selector.
    const nodesInStoryline = laneOpts?.nodes ?? getNodesInStoryline(storyline.id);
    const isSynthetic = laneOpts?.synthetic ?? false;
    const isRouteActive = !isSynthetic && storylineId === storyline.id;
    const railColor = storyline.color || 'hsl(var(--story-4))';

    const openRowContextMenu = (row: HTMLElement, clientX: number, clientY: number) => {
      // Synthetic lanes don't expose storyline actions, but their chapter
      // cards still use the shared node menu.
      const container = row.querySelector('[data-node-container]') as HTMLElement | null;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left;
      const clickedNode = nodesInStoryline.find((node) => {
        if (!isSynthetic && !isPrimaryStorylineForNode(node, storyline.id)) return false;
        const ord = orderOf(node);
        if (ord === null) return false;
        const nl = orderToPosition(ord);
        return x >= nl && x <= nl + nodeWidth;
      });
      if (clickedNode) {
        setContextMenu({
          x: clientX + 2,
          y: clientY - 2,
          type: 'node',
          nodeId: clickedNode.id,
          storylineId: storyline.id,
          nodeTitle: clickedNode.title,
          nodeSummary: clickedNode.summary,
          nodeStorylines: clickedNode.storylines,
        });
        return;
      }
      if (isSynthetic) return;
      setContextMenu({
        x: clientX + 2,
        y: clientY - 2,
        type: 'storyline',
        storylineId: storyline.id,
        position: Math.max(
          minOrder,
          x / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor) + minOrder,
        ),
      });
    };

    return (
      <div
        key={storyline.id}
        data-storyline-row={storyline.id}
        className={`btl-row${isSynthetic ? ' is-synthetic' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (suppressPointerClickRef.current) {
            suppressPointerClickRef.current = false;
            e.preventDefault();
            return;
          }
          clearContextMenu();
        }}
        onPointerDown={(event) => {
          const row = event.currentTarget;
          const clientX = event.clientX;
          const clientY = event.clientY;
          beginTouchMenu(event, () => openRowContextMenu(row, clientX, clientY));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openRowContextMenu(e.currentTarget, e.clientX, e.clientY);
        }}
      >
        <div
          className={`btl-rail ${isRouteActive ? 'is-active' : ''}${
            isSynthetic ? '' : ' is-clickable'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressPointerClickRef.current) {
              suppressPointerClickRef.current = false;
              e.preventDefault();
              return;
            }
            // Real storylines: clicking the rail navigates to the storyline
            // editor tab (mirrors ChapterPanel's storyline-group click).
            // Synthetic lanes have no entity behind them, so they no-op.
            if (!isSynthetic) {
              openEntity({ entityType: 'storyline', id: storyline.id });
            }
          }}
          onDoubleClick={() => {
            if (!isSynthetic && !isMobilePresentation) promoteCurrentTab();
          }}
          onPointerDown={(event) => {
            if (!isMobilePresentation || isSynthetic) return;
            event.stopPropagation();
            const clientX = event.clientX;
            const clientY = event.clientY;
            beginTouchMenu(event, () =>
              setContextMenu({
                x: clientX + 2,
                y: clientY - 2,
                type: 'storyline',
                storylineId: storyline.id,
              }),
            );
          }}
          onContextMenu={(e) => {
            // Synthetic rails (本书 / 未归属) have no entity to operate on.
            if (isSynthetic) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            // On a real storyline rail, expose the same cmenu the chapter
            // panel storyline-cell uses — edit / delete / merge — so the
            // rail is a discoverable surface for storyline-level actions.
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'storyline',
              storylineId: storyline.id,
              // position omitted: rail click doesn't carry a bookOrder
              // slot, so the createChapterHere extra is suppressed.
            });
          }}
          title={
            isSynthetic
              ? storyline.name || ''
              : t('bottomTimeline.storyline.openTitle', {
                  name: storyline.name || t('topTimeline.untitled.storyline'),
                })
          }
          style={
            {
              width: railWidth,
              cursor: isSynthetic ? 'default' : 'pointer',
              ['--rail-color' as string]: railColor,
            } as React.CSSProperties
          }
        >
          <div className="btl-rail__main">
            <div className="btl-rail__name">{storyline.name || 'Untitled'}</div>
            <div className="btl-rail__count">
              {nodesInStoryline.length} {nodesInStoryline.length === 1 ? 'ch' : 'chs'}
            </div>
          </div>
        </div>

        <div data-node-container className="btl-track" style={{ minWidth: timelineWidth }}>
          {isNarrative && (
            <TimelineMarkerLines preview={dragPreview} markers={markers}
              orderToPosition={orderToPosition} className="btl-pin-line" />
          )}

          {/* Act boundary lines (book view) — the same vertical primitive as a
              marker's line, run down through every storyline track so an act
              boundary reads top-to-bottom like a time marker. */}
          {!isNarrative &&
            bookActs.map((a) =>
              a.startOrder == null ? null : (
                <div
                  key={`actline-${a.id}`}
                  className="btl-pin-line"
                  style={{ left: orderToPosition(a.startOrder) }}
                />
              ),
            )}

          {/* Lane half of the act drop indicator — follows the boundary/chip
              drag (x lifted from ActRail) so the rail ghost extends down through
              the lanes as one continuous line. */}
          {!isNarrative && (
            <TimelineActDragLine preview={dragPreview} className="btl-pin-line" />
          )}

          {nodesInStoryline.map((node) => renderNodeCard(node, storyline.id))}
          {nodesInStoryline.length === 0 && (
            <div className="btl-empty">{t('bottomTimeline.empty.noChaptersInStoryline')}</div>
          )}
        </div>
      </div>
    );
  };

  // ---- Layout math ----
  const totalHeight = isMobilePresentation ? '100%' : getTimelineHeight();
  // ActRail (幕) replaced FullBookLane as the book-mode top strip. Unlike
  // the old packed lane it lives INSIDE the scroll container, in track
  // coordinate space, so act bands align with the chapter columns below.
  // Always present in book mode (even with zero acts — the empty rail keeps
  // the 幕 feature discoverable and invites a first split); narrative mode
  // never shows it (acts segment bookOrder, and projecting them onto the
  // narrative axis would shred them across flashbacks).
  const actRailHeight = !isNarrative ? actRailHeightValue : 0;
  const axisHeight = isNarrative ? axisHeightValue : 0;

  // Lanes to render: real storylines + at most one synthetic lane.
  //   • 0 storylines → 1 synthetic "本书" default lane (single-lane mode)
  //   • ≥1 storylines + any chapter with no primary → append synthetic
  //     "未归属" lane (collapsed by default; only its header counts toward
  //     row height when collapsed so the storyline lanes don't lose space)
  const unaffiliatedChapters = useMemo(() => {
    if (storylines.length === 0) return [] as TimelineNode[];
    // Use the same primary-resolution as the render path. A chapter with
    // memberships but no DECLARED primary still falls back to `storylines[0]`
    // and renders in that lane — filtering on `primaryStorylineByNode` alone
    // would let such a chapter ALSO show up in 未归属, duplicating it.
    // StoryGraphView's unaffiliated filter is correct for the same reason.
    return placedNodes.filter((n) => primaryStorylineId(n) == null);
  }, [storylines.length, placedNodes, primaryStorylineId]);

  type Lane = { storyline: Storyline; nodes: TimelineNode[]; synthetic: boolean };
  const lanesToRender = useMemo<Lane[]>(() => {
    if (storylines.length === 0) {
      return [
        {
          storyline: makeSyntheticStoryline(
            DEFAULT_LANE_ID,
            t('bottomTimeline.synthetic.book'),
            'hsl(var(--accent))',
          ),
          nodes: placedNodes,
          synthetic: true,
        },
      ];
    }
    const real: Lane[] = storylines.map((sl) => ({
      storyline: sl,
      nodes: getNodesInStoryline(sl.id),
      synthetic: false,
    }));
    // 未归属 is opt-in via the header toggle, but the toggle itself is
    // always available whenever storylines exist — so the lane appears
    // even when no chapter is currently unaffiliated. That keeps the
    // narrative-view drop target reachable for "未放置 + 未归属" chapters
    // dragged out of the holding popover.
    if (unaffiliatedVisible) {
      real.push({
        storyline: makeSyntheticStoryline(
          UNAFFILIATED_LANE_ID,
          t('bottomTimeline.synthetic.unaffiliated'),
          'hsl(var(--ink-3))',
        ),
        nodes: unaffiliatedChapters,
        synthetic: true,
      });
    }
    return real;
  }, [storylines, placedNodes, getNodesInStoryline, unaffiliatedChapters, unaffiliatedVisible, t]);

  const rowsViewportHeight = Math.max(
    0,
    (typeof totalHeight === 'number' ? totalHeight : mobileTimelineHeight) -
      headHeight -
      actRailHeight -
      axisHeight,
  );
  const rowHeight =
    lanesToRender.length > 0
      ? Math.max(
          isMobilePresentation ? nodeMinHeight : 0,
          rowsViewportHeight / lanesToRender.length,
        )
      : 0;
  const rowsAreaHeight = isMobilePresentation
    ? rowHeight * lanesToRender.length
    : rowsViewportHeight;
  // Vertical offset of the lane rows inside the scroll content: the time
  // axis (narrative) or the act rail (book) renders above them in-flow.
  const overlayTopOffset = axisHeight + actRailHeight;
  const rowCenterY = (idx: number) => overlayTopOffset + idx * rowHeight + rowHeight / 2;
  const scrollContentWidth = railWidth + timelineWidth;
  const railOffset = railWidth;

  const [newlyAddedMarkerId, setNewlyAddedMarkerId] = useState<string | null>(null);
  // Right-click on the empty marker rail → "在此处新建标记" at the cursor slot.
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; order: number } | null>(null);
  // Only guide layers subscribe to frame-coalesced preview motion.
  const [dragPreview] = useState(() => createTimelineDragPreview());

  // "打散" — keeps relative ordering and deliberately redistributes the
  // active continuous coordinate. Ordinary dragging never applies this
  // spacing policy; it persists the exact pointer-derived position.
  const handleSpread = useCallback(async () => {
    if (placedNodes.length < 2) return;
    try {
      await spreadTimelineNodes({
        nodes: placedNodes,
        orderOf,
        updateOrder: (id, newOrder) => updateNode(id, { [orderField]: newOrder }),
        remapAfterSpread: isNarrative ? undefined : remapAfterSpread,
      });
    } catch (err) {
      log.error('Failed to spread timeline nodes', err);
    }
  }, [placedNodes, orderOf, updateNode, orderField, isNarrative, remapAfterSpread]);

  // "+幕" head button: bootstrap one first act at the book-axis head, then
  // retain viewport-center insertion once the project already has acts.
  // Precise placement is also available from the track context menu.
  const handleAddActSplit = useCallback(() => {
    const container = scrollContainerRef.current;
    const centerX = container
      ? container.scrollLeft + container.clientWidth / 2 - railWidth
      : 0;
    // The head ＋ bootstraps exactly one first act at the book-axis head.
    // Once acts exist, it retains the convenient viewport-center insertion.
    const target = bookActs.length === 0 ? minOrder : positionToOrder(centerX);
    void splitAtOrder(target);
  }, [bookActs.length, minOrder, positionToOrder, railWidth, splitAtOrder]);

  const handleAddPin = useCallback(() => {
    const container = scrollContainerRef.current;
    const centerX = container
      ? container.scrollLeft + container.clientWidth / 2 - railWidth
      : 0;
    const target = positionToOrder(centerX);
    const created = addMarker(target, t('bottomTimeline.marker.defaultLabel'));
    if (created) setNewlyAddedMarkerId(created.id);
  }, [addMarker, positionToOrder, railWidth, t]);

  // Drop a marker at a specific order (the rail right-click target), as opposed
  // to handleAddPin's viewport-center pick.
  const handleAddPinAtOrder = useCallback(
    (order: number) => {
      const created = addMarker(order, t('bottomTimeline.marker.defaultLabel'));
      if (created) setNewlyAddedMarkerId(created.id);
    },
    [addMarker, t],
  );

  const openTimelineRailMenu = (track: HTMLElement, clientX: number, clientY: number) => {
    const rect = track.getBoundingClientRect();
    const px = clientX - rect.left;
    setRailMenu({ x: clientX + 2, y: clientY - 2, order: positionToOrder(px) });
  };

  const renderTimeAxis = () => {
    if (!isNarrative) return null;
    return (
      <div
        className="btl-axis"
        onContextMenuCapture={
          markers.length === 0
            ? (event) => {
                const track = event.currentTarget.querySelector<HTMLElement>('.btl-axis__track');
                if (!track) return;
                event.preventDefault();
                event.stopPropagation();
                openTimelineRailMenu(track, event.clientX, event.clientY);
              }
            : undefined
        }
      >
        <div
          className="btl-axis__rail"
          style={{ width: railWidth }}
          title={t('bottomTimeline.axis.title')}
        >
          <span>{t('bottomTimeline.axis.time')}</span>
          <button
            type="button"
            className="btl-axis__rail-add"
            title={t('bottomTimeline.axis.addPin')}
            onClick={(e) => {
              e.stopPropagation();
              handleAddPin();
            }}
          >
            +
          </button>
        </div>
        <div
          className="btl-axis__track"
          style={{ minWidth: timelineWidth }}
          onPointerDown={(event) => {
            const track = event.currentTarget;
            const clientX = event.clientX;
            const clientY = event.clientY;
            beginTouchMenu(event, () => openTimelineRailMenu(track, clientX, clientY));
          }}
          onContextMenu={(e) => {
            // Empty-rail right-click → 新建标记. Right-clicking a pin is caught
            // by the pin itself (it stops propagation), so this only fires on
            // blank space.
            e.preventDefault();
            e.stopPropagation();
            openTimelineRailMenu(e.currentTarget, e.clientX, e.clientY);
          }}
        >
          {/* Rail half of the marker drop indicator — the pin's own line hides
              while dragging, so this following line keeps the indicator present
              in the rail; the lane half is rendered per-track below, so the two
              read as one continuous line from rail to bottom. */}
          <TimelineMarkerLines preview={dragPreview} markers={markers}
            orderToPosition={orderToPosition} className="btl-pin-line" onlyDragging />
        </div>
      </div>
    );
  };

  const renderHead = () => {
    return (
      <div className="btl__head" onClick={(e) => e.stopPropagation()}>
        <div className="btl__head-left">
          <SegmentedControl
            className="btl__view-toggle"
            size="sm"
            value={viewMode}
            onChange={setViewMode}
            ariaLabel={t('bottomTimeline.view.toggleTitle')}
            options={[
              {
                value: 'book',
                label: t('bottomTimeline.view.book'),
                title: t('bottomTimeline.view.bookTitle'),
              },
              {
                value: 'narrative',
                label: t('bottomTimeline.view.narrative'),
                title: t('bottomTimeline.view.narrativeTitle'),
              },
            ]}
          />
          {/* 未归属 toggle — only meaningful when there are storylines AND
              chapters with no primary. Click reveals the 未归属 lane in the
              timeline; click again hides it. Hidden by default per UX spec.
              Also resizes the dock by one row so existing tracks keep their
              current height instead of being squeezed/expanded to absorb the
              new lane. */}
          {storylines.length > 0 && (
            <button
              type="button"
              className={`btl__unaffiliated-toggle${unaffiliatedVisible ? ' is-active' : ''}`}
              onClick={() => {
                const next = !unaffiliatedVisible;
                // rowHeight reflects the CURRENT (pre-toggle) per-row slice,
                // so opening adds exactly one of those slices to the total
                // and closing reclaims the slice the lane was occupying —
                // either way, the remaining tracks keep their size.
                const delta = rowHeight > 0 ? (next ? rowHeight : -rowHeight) : 0;
                if (delta !== 0) {
                  if (!isMobilePresentation) {
                    const base = customHeight ?? TIMELINE_CONFIG.DEFAULT_HEIGHT;
                    const adjusted = clampDimension(base + delta, timelineHeightBounds());
                    setCustomHeight(adjusted);
                    if (typeof localStorage !== 'undefined') {
                      localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, adjusted.toString());
                    }
                  }
                }
                setUnaffiliatedVisible(next);
              }}
              title={
                unaffiliatedVisible
                  ? t('bottomTimeline.unaffiliated.hideTitle')
                  : t('bottomTimeline.unaffiliated.showTitle')
              }
            >
              {unaffiliatedVisible ? (
                t('bottomTimeline.unaffiliated.hide')
              ) : (
                <>
                  {t('bottomTimeline.unaffiliated.show')}
                  <span className="btl__unaffiliated-toggle-count">
                    {unaffiliatedChapters.length}
                  </span>
                </>
              )}
            </button>
          )}
          {isNarrative && (
            <div className="btl__unplaced">
              <button
                ref={unplacedBtnRef}
                type="button"
                className={`btl__unplaced-btn${unplacedPopoverOpen ? ' is-open' : ''}`}
                onClick={() => setUnplacedPopoverOpen((v) => !v)}
                title={t('bottomTimeline.unplaced.title')}
                aria-haspopup="menu"
                aria-expanded={unplacedPopoverOpen}
              >
                <span>{t('bottomTimeline.unplaced.label')}</span>
                <span className="btl__unplaced-count">{unplacedNodes.length}</span>
                <span className="btl__unplaced-arrow">▾</span>
              </button>
              <AnchoredPopover
                anchorRef={unplacedBtnRef}
                open={unplacedPopoverOpen}
                onClose={() => setUnplacedPopoverOpen(false)}
                placement="top-start"
                className="menu-surface menu-surface--rich menu-surface--panel btl__unplaced-popover"
                role="menu"
                ariaLabel={t('bottomTimeline.unplaced.title')}
                maxHeight={320}
              >
                {unplacedNodes.length === 0 ? (
                  <div className="btl__unplaced-empty">{t('bottomTimeline.unplaced.empty')}</div>
                ) : (
                  <div className="btl__unplaced-list">
                    {unplacedNodes.map((node) => {
                      const slId = primaryStorylineId(node);
                      const sl = slId ? storylineById.get(slId) : null;
                      const color = sl?.color || 'hsl(var(--ink-4))';
                      return (
                        <div
                          key={node.id}
                          className="btl__unplaced-chip"
                          role="menuitem"
                          tabIndex={0}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            startNodePointerDrag(
                              event,
                              node,
                              primaryStorylineId(node) ?? '',
                              { fromDrawer: true },
                            );
                          }}
                          onClick={(event) => {
                            if (isMobilePresentation) setUnplacedPopoverOpen(false);
                            handleNodeClick(node.id, event);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            setNodeSelection(node.id, 'ui');
                          }}
                          style={
                            {
                              touchAction: 'none',
                              ['--clip-color' as string]: color,
                            } as React.CSSProperties
                          }
                          title={node.title || t('common.untitled')}
                        >
                          <span className="btl__unplaced-chip-dot" />
                          <span className="btl__unplaced-chip-num">
                            § {String(node.bookOrder ?? 0).padStart(2, '0')}
                          </span>
                          <span className="btl__unplaced-chip-title">
                            {node.title || t('common.untitled')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </AnchoredPopover>
            </div>
          )}
        </div>
        <div className="btl__head-right">
          {/* New-storyline action lives on the ChapterPanel subheader's primary
              create button now; the 「+幕」act-create action moved into the
              act rail's head cell (mirrors the narrative TIME ＋). The header
              keeps only the layout / navigation controls below. */}
          <button
            className="btl__head-btn"
            title={
              placedNodes.length < 2
                ? t('bottomTimeline.spread.needTwo')
                : t('bottomTimeline.spread.title', {
                    mode: isNarrative
                      ? t('bottomTimeline.view.narrative')
                      : t('bottomTimeline.view.book'),
                  })
            }
            disabled={placedNodes.length < 2}
            onClick={() => {
              void handleSpread();
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <line x1="3" y1="8" x2="1.5" y2="8" />
              <line x1="14.5" y1="8" x2="13" y2="8" />
              <path d="M4 5l-2 3 2 3" />
              <path d="M12 5l2 3-2 3" />
              <line x1="7" y1="8" x2="9" y2="8" />
            </svg>
          </button>
          <button
            className="btl__head-btn"
            title={t('bottomTimeline.locateCurrent')}
            onClick={() => {
              const activeId = isMobilePresentation ? nodeId : (selectedNodeUiId ?? nodeId);
              const activeNode = activeId ? (nodeById.get(activeId) ?? null) : null;
              const activeOrder = activeNode ? orderOf(activeNode) : null;
              if (activeOrder == null || !scrollContainerRef.current) return;
              const left =
                railWidth +
                orderToPosition(activeOrder) -
                scrollContainerRef.current.clientWidth / 2 +
                nodeWidth / 2;
              scrollContainerRef.current.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="8" cy="8" r="3" />
              <line x1="8" y1="1" x2="8" y2="4" />
              <line x1="8" y1="12" x2="8" y2="15" />
              <line x1="1" y1="8" x2="4" y2="8" />
              <line x1="12" y1="8" x2="15" y2="8" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={timelineRef}
      className={`btl btl--${presentation}`}
      data-view={viewMode}
      data-mobile-planning={isMobilePresentation ? 'complete' : undefined}
      onClick={handleTimelineClick}
      style={{ height: totalHeight }}
    >
      {!isMobilePresentation && (
        <div
          className="btl__resize"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Cursor lands somewhere within the 4px-tall handle (which itself
            // sits flush with the timeline's top border). Capture how far below
            // the top edge the grab happened so handleMouseMove can subtract it
            // and keep the grabbed point glued to the cursor. Also pin the
            // dock's bottom in viewport coords — the full-width `BottomStatusBar`
            // sits below the workspace row, so `window.innerHeight` is not the
            // right anchor.
            const rect = timelineRef.current?.getBoundingClientRect();
            resizeGrabOffsetRef.current = rect ? e.clientY - rect.top : 0;
            resizeBottomYRef.current = rect ? rect.bottom : window.innerHeight;
            setIsResizingHeight(true);
          }}
        />
      )}

      {renderHead()}

      <div
        ref={scrollContainerRef}
        data-timeline-container
        data-mobile-planning-gesture-surface
        className="btl__scroll"
        onTouchStart={touchHandlers.onTouchStart}
        onTouchMove={touchHandlers.onTouchMove}
        onTouchEnd={touchHandlers.onTouchEnd}
        onTouchCancel={touchHandlers.onTouchCancel}
        style={{
          touchAction: isMobilePresentation ? 'pan-x pan-y pinch-zoom' : 'pan-x pinch-zoom',
        }}
      >
        {/* Act rail (幕) — book mode, always present (empty rail when no acts).
            Lives inside the scroll container in track coordinate space so the
            bands align with the chapter columns and scroll with them. The ＋
            in its head cell is the create entry. */}
        {actRailHeight > 0 && (
          <ActRail
            key={projectId}
            acts={bookActs}
            chapters={placedNodes}
            railWidth={railWidth}
            trackWidth={timelineWidth}
            height={actRailHeight}
            orderToX={orderToPosition}
            minOrder={minOrder}
            maxOrder={maxOrder}
            onRenameAct={(id, name) => void updateAct(id, { name })}
            onMoveBoundary={(id, startOrder) => void moveBoundary(id, startOrder)}
            onBoundaryDragMove={dragPreview.setAct}
            onDeleteAct={(id) => void deleteAct(id)}
            onSplitAt={(startOrder) => void splitAtOrder(startOrder)}
            onAddAct={handleAddActSplit}
            driftTitleById={(id) => driftById.get(id)?.title ?? null}
            onRequestBind={(id) => events.emit('drift-bind:open', { target: { kind: 'act', id } })}
            onUnbindDrift={(id) => void unbindDrift(id)}
            onOpenDrift={(driftNodeId) =>
              openEntity({ entityType: 'node', id: driftNodeId }, { preview: false })
            }
          />
        )}

        {renderTimeAxis()}

        {lanesToRender.map((lane) =>
          renderStorylineRow(lane.storyline, {
            nodes: lane.nodes,
            synthetic: lane.synthetic,
          }),
        )}

        {isNarrative &&
          markers.map((m) => (
            <SharedTimelinePin
              key={`pin-${m.id}`}
              marker={m}
              orderToPosition={orderToPosition}
              positionToOrder={positionToOrder}
              variant="bottom"
              xOffset={railOffset}
              pinHeight={overlayTopOffset}
              editOnMount={m.id === newlyAddedMarkerId}
              onChange={(patch) => {
                if (m.id === newlyAddedMarkerId) setNewlyAddedMarkerId(null);
                updateMarker(m.id, patch);
              }}
              onDelete={() => {
                if (m.id === newlyAddedMarkerId) setNewlyAddedMarkerId(null);
                deleteMarker(m.id);
              }}
              onDragMove={(nextPixelX) => dragPreview.setMarker(m.id, nextPixelX)}
              boundDriftTitle={m.driftNodeId ? (driftById.get(m.driftNodeId)?.title ?? null) : null}
              onRequestBind={() =>
                events.emit('drift-bind:open', { target: { kind: 'marker', id: m.id } })
              }
              onOpenDrift={() => {
                if (m.driftNodeId) {
                  openEntity({ entityType: 'node', id: m.driftNodeId }, { preview: false });
                }
              }}
            />
          ))}

        {railMenu && (
          <TimelineRailMenu
            x={railMenu.x}
            y={railMenu.y}
            onAddMarker={() => handleAddPinAtOrder(railMenu.order)}
            onClose={() => setRailMenu(null)}
          />
        )}

        {crossStorylineLinks.length > 0 && storylines.length > 0 && rowHeight > 0 && (
          <svg
            className="btl-crosslinks"
            width={scrollContentWidth}
            height={overlayTopOffset + rowsAreaHeight}
            style={{
              width: scrollContentWidth,
              height: overlayTopOffset + rowsAreaHeight,
            }}
          >
            {crossStorylineLinks.map((link) => {
              const x1 = railOffset + link.fromX;
              const x2 = railOffset + link.toX;
              // SVG sits inside .btl__scroll which contains the act rail /
              // time axis + rows; both leading strips are folded into
              // overlayTopOffset, which rowCenterY already applies.
              const y1 = rowCenterY(link.fromY);
              const y2 = rowCenterY(link.toY);
              const midY = (y1 + y2) / 2;
              const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
              return (
                <path
                  key={link.key}
                  d={d}
                  stroke={link.color}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  strokeLinecap="round"
                  fill="none"
                  opacity="0.6"
                />
              );
            })}
          </svg>
        )}
      </div>

      {contextMenu?.type === 'node' &&
        contextMenu.nodeId &&
        (() => {
          const node = nodeById.get(contextMenu.nodeId);
          if (!node) return null;
          const hasNarrativeOrder = typeof node.narrativeOrder === 'number';
          const hasAnyStoryline = (contextMenu.nodeStorylines?.length ?? 0) > 0;
          return (
            <EntityCellContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              editorType="node"
              nodeStatusKind={isChapter(node) ? 'chapter' : 'drift'}
              nodeWritingStatus={node.writingStatus}
              header={{
                title: contextMenu.nodeTitle,
                subtitle: contextMenu.nodeSummary,
                tags: contextMenu.nodeStorylines?.map((sl) => ({
                  id: sl.id,
                  name: sl.name,
                  color: sl.color,
                })),
              }}
              extraGroups={[
                [
                  ...(hasAnyStoryline
                    ? [
                        {
                          action: 'moveToUnaffiliated',
                          label: t('bottomTimeline.menu.moveToUnaffiliated'),
                        },
                      ]
                    : []),
                  ...(isNarrative && hasNarrativeOrder
                    ? [
                        {
                          action: 'detachFromNarrative',
                          label: t('bottomTimeline.menu.detachFromNarrative'),
                        },
                      ]
                    : []),
                ],
              ]}
              onAction={(action) => {
                // Timeline-local actions stay in handleContextMenuAction; the
                // rest (delete, edit storylines, status flips) route through
                // the shared per-entity dispatcher.
                if (action === 'moveToUnaffiliated' || action === 'detachFromNarrative') {
                  void handleContextMenuAction(action);
                  return;
                }
                const nid = contextMenu.nodeId;
                if (!nid) return;
                void dispatchEntityAction({ entityType: 'node', id: nid, action });
              }}
              onClose={clearContextMenu}
            />
          );
        })()}

      {contextMenu?.type === 'storyline' &&
        contextMenu.storylineId &&
        !(() => {
          // Synthetic lanes don't have a real storyline behind them — no
          // editor actions apply, and createChapterHere is suppressed for
          // 未归属 / 本书 too since they don't own a primary storyline.
          const sid = contextMenu.storylineId;
          return sid === '__default__' || sid === '__unaffiliated__';
        })() && (
          <EntityCellContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            editorType="storyline"
            extraGroups={[
              contextMenu.position !== undefined
                ? [
                    {
                      action: 'createChapterHere',
                      label: t('bottomTimeline.menu.createChapterHere'),
                    },
                    // Acts live on the bookOrder axis only — narrative-mode
                    // positions are narrativeOrder values, wrong axis.
                    ...(!isNarrative
                      ? [{ action: 'startActHere', label: t('bottomTimeline.menu.startActHere') }]
                      : []),
                  ]
                : [],
            ]}
            onAction={(action) => {
              if (action === 'createChapterHere') {
                void handleContextMenuAction(action);
                return;
              }
              if (action === 'startActHere') {
                if (contextMenu.position !== undefined) {
                  void splitAtOrder(contextMenu.position);
                }
                clearContextMenu();
                return;
              }
              const sid = contextMenu.storylineId;
              if (!sid) return;
              void dispatchEntityAction({ entityType: 'storyline', id: sid, action });
            }}
            onClose={clearContextMenu}
          />
        )}

      {hoveredNodeId && hoverAnchor && (
        <EntityHoverCard
          target={{ kind: 'node', id: hoveredNodeId }}
          anchor={hoverAnchor}
          placement="top-center"
        />
      )}
    </div>
  );
}
