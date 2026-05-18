import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useMatch } from 'react-router-dom';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookNode } from '../../usecase/useBookNode';
import type { Storyline } from '../../domain/storyline';
import { useAuthStore } from '../../store/auth';
import { NodeHoverPreview } from '../NodeHoverPreview';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useTimelineExpandedScale } from './useTimelineExpandedScale';
import { useBottomTimelineContextMenuActions } from './useBottomTimelineContextMenuActions';
import { useBottomTimelineSelectors } from './useBottomTimelineSelectors';
import { useBottomTimelineInteractionState } from './useBottomTimelineInteractionState';
import { BottomTimelineContextMenu } from './BottomTimelineContextMenu';
import type { BottomTimelineContextMenuAction, TimelineNode } from './types';
import { useUiStore } from '../../store/ui-store';
import { useTimelineMarkers } from '../../hooks/useTimelineMarkers';
import loglevel from 'loglevel';
import '../../../styles/bottom-timeline.css';
const log = loglevel.getLogger('BottomTimeline');
log.setLevel(loglevel.levels.WARN);

// Phase 2: BottomTimeline now hosts two independent timeline views:
//   - book      — sorted by node.bookOrder (always set; mirrors reading order)
//   - narrative — sorted by node.narrativeOrder (nullable; author-authored
//                 chronological order; flashbacks / non-linear layouts live here)
// TimelinePin markers are exclusive to the narrative view (they label
// in-world time points like "1937" or "卷二"). Nodes without a narrativeOrder
// surface in the holding drawer so the author can drag them onto the axis.
type TimelineState = 'collapsed' | 'expanded';
type TimelineView = 'book' | 'narrative';
const TIMELINE_STATE_STORAGE_KEY = 'timeline-mode';
const TIMELINE_VIEW_STORAGE_KEY = 'timeline-view';
const TIMELINE_HEIGHT_STORAGE_KEY = 'timeline-total-height';

const TIMELINE_CONFIG = {
  GRID_UNIT: 20,
  // Fixed tile width in grid units. Tiles no longer carry an `end`, so all
  // tiles in book-order view occupy the same horizontal span.
  NODE_DEFAULT_WIDTH: 4,
  NODE_MIN_HEIGHT: 18,
  NODE_COMPACT_HEIGHT: 6,
  STORYLINE_GAP: 2,
  RAIL_WIDTH: 148,
  RAIL_WIDTH_STRIP: 8,
  HEAD_HEIGHT: 30,
  AXIS_HEIGHT: 22,
  MINIMAP_HEIGHT: 60,
  // Default expanded height includes head + minimap + a comfortable rows area.
  DEFAULT_EXPANDED_HEIGHT: 340,
};

function readPersistedMode(): TimelineState {
  if (typeof localStorage === 'undefined') return 'expanded';
  const v = localStorage.getItem(TIMELINE_STATE_STORAGE_KEY);
  if (v === 'collapsed' || v === 'strip') return 'collapsed';
  return 'expanded';
}

function readPersistedView(): TimelineView {
  if (typeof localStorage === 'undefined') return 'book';
  const v = localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY);
  return v === 'narrative' ? 'narrative' : 'book';
}

interface TimelinePinProps {
  marker: import('../../domain/timeline-marker').TimelineMarker;
  snapValues: number[];
  orderToPosition: (order: number) => number;
  // x-offset added before each pin's order-derived x (rail width) so pins
  // line up with the chapter tracks, not the rail.
  xOffset: number;
  // Live display order — equals marker.narrativeOrder at rest, the
  // tentative snap target during drag. Lifted to parent so the per-track
  // vertical line can track the drag in lockstep.
  displayOrder: number;
  isDragging: boolean;
  pinHeight: number;
  editOnMount?: boolean;
  onChange: (patch: { narrativeOrder?: number; label?: string }) => void;
  onDelete: () => void;
  // Report drag start/move (number) and drag end (null) so the parent
  // can update its lifted drag map.
  onDragMove: (nextOrder: number | null) => void;
}

// One draggable pin head (label + triangle). The pin's vertical grid line
// is rendered separately inside each storyline track so it paints behind
// the chapter clips. Drag the head/label horizontally to snap to the
// nearest valid order; double-click the label to rename; clearing the
// label saves as delete.
function TimelinePin({
  marker,
  snapValues,
  orderToPosition,
  xOffset,
  displayOrder,
  isDragging,
  pinHeight,
  editOnMount = false,
  onChange,
  onDelete,
  onDragMove,
}: TimelinePinProps) {
  const [editing, setEditing] = useState(editOnMount);
  const labelRef = useRef<HTMLDivElement>(null);
  const x = xOffset + orderToPosition(displayOrder);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      if (snapValues.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startMouseX = e.clientX;
      const startPixel = orderToPosition(marker.narrativeOrder);
      let nearest = marker.narrativeOrder;
      const onMove = (ev: MouseEvent) => {
        const newPixel = startPixel + (ev.clientX - startMouseX);
        let best = snapValues[0];
        let bestDist = Infinity;
        for (const s of snapValues) {
          const d = Math.abs(orderToPosition(s) - newPixel);
          if (d < bestDist) {
            bestDist = d;
            best = s;
          }
        }
        nearest = best;
        onDragMove(best);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        onDragMove(null);
        if (nearest !== marker.narrativeOrder) onChange({ narrativeOrder: nearest });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, snapValues, marker.narrativeOrder, orderToPosition, onChange, onDragMove],
  );

  useEffect(() => {
    if (editing && labelRef.current) {
      labelRef.current.focus();
      const r = document.createRange();
      r.selectNodeContents(labelRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }, [editing]);

  const className = ['btl-pin', isDragging ? 'is-dragging' : '', editing ? 'is-editing' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={{ left: x, height: pinHeight }}>
      <div
        ref={labelRef}
        className="btl-pin__label"
        contentEditable={editing}
        suppressContentEditableWarning
        onMouseDown={editing ? (e) => e.stopPropagation() : startDrag}
        onDoubleClick={(e) => {
          if (!editing) {
            e.stopPropagation();
            setEditing(true);
          }
        }}
        onBlur={(e) => {
          const text = (e.currentTarget.textContent ?? '').trim();
          setEditing(false);
          if (!text) onDelete();
          else if (text !== marker.label) onChange({ label: text });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).textContent = marker.label;
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
        title={editing ? '回车保存，留空删除' : '双击编辑名称'}
      >
        {marker.label}
      </div>
      <div className="btl-pin__head" onMouseDown={startDrag} title="拖动调整位置" />
    </div>
  );
}

export function BottomTimeline() {
  // BottomTimeline is rendered inside Layout, which is a SIBLING of the
  // route Outlet — so useParams() here only sees the parent route's params.
  const editorMatch = useMatch('/project/:projectId/editor/:nodeId');
  const storylineMatch = useMatch('/project/:projectId/editor/storyline/:storylineId');
  const nodeId = editorMatch?.params.nodeId;
  const storylineId = storylineMatch?.params.storylineId;
  const user = useAuthStore((state) => state.user);
  const { bookNodes, storylines, nodeStorylineMapping } = useDataStore();
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const { projectId, navigateToNode, navigateToHome } = useProjectNavigation();
  const { markers, addMarker, updateMarker, deleteMarker } = useTimelineMarkers(projectId);
  const { createNode, updateNode, deleteNode } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { addNodeToStoryline, getStorylinesByNode, removeNodeFromStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const activeSelectedNodeId = nodeId;

  const nodesWithStorylines = useMemo<TimelineNode[]>(() => {
    const storylineById = new Map(storylines.map((sl) => [sl.id, sl]));
    return bookNodes.map((node) => ({
      ...node,
      storylines: (nodeStorylineMapping[node.id] || [])
        .map((slId) => storylineById.get(slId))
        .filter((sl): sl is Storyline => Boolean(sl)),
    }));
  }, [bookNodes, nodeStorylineMapping, storylines]);

  const [timelineMode, setTimelineMode] = useState<TimelineState>(readPersistedMode);
  const [viewMode, setViewMode] = useState<TimelineView>(readPersistedView);
  const [isResizingHeight, setIsResizingHeight] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [customExpandedHeight, setCustomExpandedHeight] = useState<number | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    return v ? parseInt(v, 10) : null;
  });

  const isExpanded = timelineMode === 'expanded';
  const isNarrative = viewMode === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';

  useEffect(() => {
    localStorage.setItem(TIMELINE_STATE_STORAGE_KEY, timelineMode);
  }, [timelineMode]);

  useEffect(() => {
    localStorage.setItem(TIMELINE_VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  const {
    draggedNode,
    dragOverPosition,
    contextMenu,
    hoveredNodeId,
    hoverPosition,
    setDraggedNode,
    setDragOverPosition,
    clearDragState,
    setContextMenu,
    clearContextMenu,
    setHoverPreview,
    clearHoverPreview,
  } = useBottomTimelineInteractionState();

  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const { expandedScale, touchHandlers } = useTimelineExpandedScale({
    isExpanded,
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

  // Cmd+J toggles collapsed ↔ expanded
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setTimelineMode((prev) => (prev === 'collapsed' ? 'expanded' : 'collapsed'));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isResizingHeight) return;
    let lastValue: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      const windowHeight = window.innerHeight;
      const minHeight =
        TIMELINE_CONFIG.HEAD_HEIGHT +
        TIMELINE_CONFIG.MINIMAP_HEIGHT +
        Math.max(storylines.length, 1) *
          (TIMELINE_CONFIG.NODE_MIN_HEIGHT + TIMELINE_CONFIG.STORYLINE_GAP);
      const next = Math.max(minHeight, windowHeight - e.clientY);
      lastValue = next;
      setCustomExpandedHeight(next);
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
  }, [isResizingHeight, storylines.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let timeoutId: number;
    const handleScroll = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        saveScrollPosition();
      }, 300);
    };

    container.addEventListener('scroll', handleScroll);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearTimeout(timeoutId);
    };
  }, [saveScrollPosition]);

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
  } = useBottomTimelineSelectors({
    nodesWithStorylines,
    storylines,
    isExpanded,
    expandedScale,
    gridUnit: TIMELINE_CONFIG.GRID_UNIT,
    nodeDefaultWidth: TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
    orderField,
  });

  const getTimelineHeight = () => {
    if (storylines.length === 0) return TIMELINE_CONFIG.HEAD_HEIGHT + 40;

    if (timelineMode === 'collapsed') {
      return (
        TIMELINE_CONFIG.HEAD_HEIGHT +
        Math.max(20, storylines.length * (TIMELINE_CONFIG.NODE_COMPACT_HEIGHT + 1))
      );
    }
    return customExpandedHeight ?? TIMELINE_CONFIG.DEFAULT_EXPANDED_HEIGHT;
  };

  const getContextMenuPosition = (x: number, y: number, menuWidth: number, menuHeight: number) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8;

    let adjustedX = x;
    let adjustedY = y;
    if (x + menuWidth + padding > viewportWidth) adjustedX = Math.max(padding, x - menuWidth);
    if (y + menuHeight + padding > viewportHeight)
      adjustedY = Math.max(padding, viewportHeight - menuHeight - padding);
    if (adjustedX < padding) adjustedX = padding;
    if (adjustedY < padding) adjustedY = padding;
    return { x: adjustedX, y: adjustedY };
  };

  const { handleContextMenuAction } = useBottomTimelineContextMenuActions({
    contextMenu,
    projectId,
    currentRouteNodeId: nodeId,
    nodesWithStorylines,
    scrollContainerRef,
    createNode,
    addNodeToStoryline,
    getStorylinesByNode,
    deleteNode,
    removeNodeFromStoryline,
    updateNode,
    navigateToNode,
    navigateToHome,
    onCloseMenu: clearContextMenu,
    onError: (message, error) => log.error(message, error),
  });

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDownCapture = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) return;
      clearContextMenu();
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearContextMenu();
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu, clearContextMenu]);

  const handleNodeDragStart = (e: React.DragEvent, node: TimelineNode, storylineId: string) => {
    clearHoverPreview();
    setDraggedNode({ node, storylineId });
    e.dataTransfer.effectAllowed = 'move';
  };

  // Drag from the holding drawer: source storyline is the node's mainStoryline
  // since the drawer item isn't anchored to any specific row.
  const handleDrawerDragStart = (e: React.DragEvent, node: TimelineNode) => {
    clearHoverPreview();
    const fallbackPrimaryId = node.storylines[0]?.id ?? '';
    const primaryId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
      ? (node.mainStorylineId as string)
      : fallbackPrimaryId;
    setDraggedNode({ node, storylineId: primaryId });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleNodeDragOver = (e: React.DragEvent, storylineId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedNode) return;

    const container = (e.currentTarget as HTMLElement).querySelector(
      '[data-node-container]',
    ) as HTMLElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const nodeLeftX = mouseX - nodeWidth / 2;
    const order = Math.max(
      minOrder,
      Math.round(nodeLeftX / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor)) + minOrder,
    );

    setDragOverPosition({ storylineId, order, x: mouseX });
  };

  const handleDrop = async (e: React.DragEvent, targetStorylineId: string) => {
    e.preventDefault();
    clearHoverPreview();
    if (!draggedNode || !dragOverPosition) return;

    const { node, storylineId: sourceStorylineId } = draggedNode;
    const targetOrder = dragOverPosition.order;
    const currentOrder = orderOf(node);

    try {
      const fallbackPrimaryId = node.storylines[0]?.id;
      const primaryStorylineId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
        ? node.mainStorylineId
        : fallbackPrimaryId;
      const isPrimaryStoryline = primaryStorylineId === sourceStorylineId;
      const isTargetInNodeStorylines = node.storylines.some((t) => t.id === targetStorylineId);

      // Allow dragging from drawer (currentOrder === null, so source row is
      // synthetic); also allow primary-storyline dragging on the axis.
      const isFromDrawer = currentOrder === null;
      if (!isFromDrawer && !isPrimaryStoryline) {
        log.warn('Can only drag from primary storyline');
        return;
      }

      // Moving across storyline rows reroutes the node's main storyline.
      // We only do this when the row genuinely changes (skip drawer drops
      // that happen to land on the node's current main row).
      if (!isFromDrawer && sourceStorylineId !== targetStorylineId) {
        await updateNode(node.id, { mainStorylineId: targetStorylineId });
        if (!isTargetInNodeStorylines) {
          await removeNodeFromStoryline(node.id, sourceStorylineId);
        }
      }

      if (targetOrder !== currentOrder) {
        await updateNode(node.id, { [orderField]: targetOrder });
      }
    } catch (error) {
      log.error('Failed to handle drop:', error);
    } finally {
      clearHoverPreview();
      clearDragState();
    }
  };

  const handleDragEnd = () => {
    clearHoverPreview();
    clearDragState();
  };

  const handleNodeClick = (clickedNodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    clearContextMenu();
    setNodeSelection(clickedNodeId, 'ui');
  };

  const handleNodeMouseEnter = (node: TimelineNode, e: React.MouseEvent) => {
    if (draggedNode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverPreview({
      nodeId: node.id,
      position: { x: rect.left + rect.width / 2, y: rect.top - 8 },
    });
  };

  const handleNodeMouseLeave = () => {
    clearHoverPreview();
  };

  const handleTimelineClick = () => {
    clearContextMenu();
  };

  const isPrimaryStorylineForNode = (node: TimelineNode, storylineId: string): boolean => {
    const fallbackPrimaryId = node.storylines[0]?.id;
    const primaryId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
      ? node.mainStorylineId
      : fallbackPrimaryId;
    return primaryId === storylineId;
  };

  const storylineRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    storylines.forEach((s, idx) => map.set(s.id, idx));
    return map;
  }, [storylines]);

  // Per-storyline lanes sorted by the active order field. Only placed
  // nodes participate; unplaced (null narrativeOrder) nodes live in the
  // holding drawer.
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
      arr.sort((a, b) => (orderOf(a) ?? 0) - (orderOf(b) ?? 0)),
    );
    return m;
  }, [placedNodes, storylines, orderOf]);

  // Cross-storyline link paths: same logic as before, but adjacency now
  // comes from the active-view sort order. Endpoints with null order
  // (only possible in narrative view) are skipped — they're in the drawer.
  const crossStorylineLinks = useMemo(() => {
    if (!isExpanded) return [];

    type Link = {
      key: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      color: string;
      markFrom: boolean;
      markTo: boolean;
    };
    const links: Link[] = [];

    for (const node of placedNodes) {
      if (node.storylines.length <= 1) continue;
      const fallbackMainId = node.storylines[0]?.id;
      const mainId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
        ? node.mainStorylineId
        : fallbackMainId;
      if (!mainId) continue;
      const mainRowIdx = storylineRowIndex.get(mainId);
      if (mainRowIdx === undefined) continue;

      const nodeOrder = orderOf(node);
      if (nodeOrder === null) continue;
      const nodeMidX = orderToPosition(nodeOrder) + nodeWidth / 2;

      for (const sl of node.storylines) {
        if (sl.id === mainId) continue;
        const sRowIdx = storylineRowIndex.get(sl.id);
        if (sRowIdx === undefined) continue;

        const lane = sortedNodesByStoryline.get(sl.id) ?? [];
        const idxInLane = lane.findIndex((n) => n.id === node.id);
        if (idxInLane < 0) continue;
        const prev = idxInLane > 0 ? lane[idxInLane - 1] : null;
        const next = idxInLane < lane.length - 1 ? lane[idxInLane + 1] : null;
        const color = sl.color || 'hsl(var(--ink-4))';

        if (prev) {
          const prevOrder = orderOf(prev);
          if (prevOrder !== null) {
            const prevMidX = orderToPosition(prevOrder) + nodeWidth / 2;
            links.push({
              key: `${sl.id}:${prev.id}->${node.id}`,
              fromX: prevMidX,
              fromY: sRowIdx,
              toX: nodeMidX,
              toY: mainRowIdx,
              color,
              markFrom: true,
              markTo: false,
            });
          }
        }
        if (next) {
          const nextOrder = orderOf(next);
          if (nextOrder !== null) {
            const nextMidX = orderToPosition(nextOrder) + nodeWidth / 2;
            links.push({
              key: `${sl.id}:${node.id}->${next.id}`,
              fromX: nodeMidX,
              fromY: mainRowIdx,
              toX: nextMidX,
              toY: sRowIdx,
              color,
              markFrom: false,
              markTo: true,
            });
          }
        }
      }
    }
    return links;
  }, [
    placedNodes,
    storylineRowIndex,
    sortedNodesByStoryline,
    orderToPosition,
    nodeWidth,
    isExpanded,
    orderOf,
  ]);

  const renderNodeCard = (node: TimelineNode, storylineId: string) => {
    const storyline = storylineById.get(storylineId);
    const isSelected = activeSelectedNodeId === node.id;
    const isPrimary = isPrimaryStorylineForNode(node, storylineId);

    if (!isPrimary) return null;

    const order = orderOf(node);
    if (order === null) return null; // surfaced in the drawer instead

    const defaultColor = '#2D4A6B';
    const clipColor = storyline?.color || defaultColor;
    const leftPosition = orderToPosition(order);
    const isDraft = node.wordCount === 0;

    const handleMouseMove = (e: React.MouseEvent) => {
      if (draggedNode) {
        clearHoverPreview();
        return;
      }
      if (hoveredNodeId !== node.id) {
        handleNodeMouseEnter(node, e);
      }
    };

    const className = ['btl-clip', isSelected ? 'is-selected' : '', isDraft ? 'is-draft' : '']
      .filter(Boolean)
      .join(' ');

    return (
      <div
        key={`${node.id}-${storylineId}`}
        data-node-card
        className={className}
        draggable={isPrimary && isExpanded}
        onDragStart={(e) => isExpanded && handleNodeDragStart(e, node, storylineId)}
        onDragEnd={handleDragEnd}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleNodeMouseLeave}
        onClick={(e) => handleNodeClick(node.id, e)}
        style={
          {
            left: leftPosition,
            width: nodeWidth,
            cursor: isPrimary && isExpanded ? 'grab' : 'pointer',
            ['--clip-color' as string]: clipColor,
          } as React.CSSProperties
        }
      >
        {isExpanded && (
          <div className="btl-clip__content">
            <div className="btl-clip__num">§ {String(node.bookOrder).padStart(2, '0')}</div>
            <div className="btl-clip__title">{node.title || '未命名'}</div>
          </div>
        )}
      </div>
    );
  };

  const renderStorylineRow = (storyline: Storyline) => {
    const nodesInStoryline = getNodesInStoryline(storyline.id);
    const isRouteActive = storylineId === storyline.id;
    const railColor = storyline.color || 'hsl(var(--story-4))';

    const selectedNode = activeSelectedNodeId ? (nodeById.get(activeSelectedNodeId) ?? null) : null;
    const selectedNodeBelongsToStoryline =
      selectedNode?.storylines.some((t) => t.id === storyline.id) ?? false;

    const trackBg = isExpanded ? 'hsl(var(--page))' : 'transparent';

    return (
      <div
        key={storyline.id}
        className="btl-row"
        onDragOver={(e) => isExpanded && handleNodeDragOver(e, storyline.id)}
        onDrop={(e) => isExpanded && handleDrop(e, storyline.id)}
        onClick={(e) => {
          e.stopPropagation();
          clearContextMenu();
        }}
        onContextMenu={(e) => {
          if (!isExpanded) return;
          e.preventDefault();
          const container = e.currentTarget.querySelector('[data-node-container]') as HTMLElement;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const position = Math.max(
            minOrder,
            Math.round(x / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor)) + minOrder,
          );
          const clickedNode = nodesInStoryline.find((node) => {
            const ord = orderOf(node);
            if (ord === null) return false;
            const nl = orderToPosition(ord);
            return x >= nl && x <= nl + nodeWidth;
          });
          if (clickedNode) {
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'node',
              nodeId: clickedNode.id,
              storylineId: storyline.id,
              nodeTitle: clickedNode.title,
              nodeSummary: clickedNode.summary,
              nodeStorylines: clickedNode.storylines,
            });
          } else {
            setContextMenu({
              x: e.clientX + 2,
              y: e.clientY - 2,
              type: 'storyline',
              storylineId: storyline.id,
              position,
              canAddCurrentNode: Boolean(activeSelectedNodeId && !selectedNodeBelongsToStoryline),
            });
          }
        }}
      >
        <div
          data-track-rail
          className={`btl-rail ${isRouteActive ? 'is-active' : ''}`}
          onClick={(e) => e.stopPropagation()}
          title={storyline.name || 'Untitled Storyline'}
          style={{
            width: isExpanded ? TIMELINE_CONFIG.RAIL_WIDTH : TIMELINE_CONFIG.RAIL_WIDTH_STRIP,
            gap: isExpanded ? 9 : 0,
            paddingLeft: isExpanded ? 16 : 0,
            paddingRight: isExpanded ? 10 : 0,
          }}
        >
          <span aria-hidden className="btl-rail__stripe" style={{ background: railColor }} />
          {isExpanded && (
            <>
              <span
                aria-hidden
                className="btl-rail__dot"
                style={{ background: railColor, marginLeft: 4 }}
              />
              <div className="btl-rail__main">
                <div className="btl-rail__name">{storyline.name || 'Untitled'}</div>
                <div className="btl-rail__count">
                  {nodesInStoryline.length} {nodesInStoryline.length === 1 ? 'ch' : 'chs'}
                </div>
              </div>
            </>
          )}
        </div>

        <div
          data-node-container
          className="btl-track"
          style={{ background: trackBg, minWidth: timelineWidth }}
        >
          {/* Pin grid lines (narrative view only) — drawn BEFORE tiles so
              tiles paint on top. Position tracks the lifted drag state. */}
          {isNarrative &&
            isExpanded &&
            markers.map((m) => {
              const isDragging = pinDragStarts.has(m.id);
              const displayOrder = getPinDisplayOrder(m.id, m.narrativeOrder);
              return (
                <div
                  key={`pinline-${m.id}`}
                  className={`btl-pin-line${isDragging ? ' is-dragging' : ''}`}
                  style={{ left: orderToPosition(displayOrder) }}
                />
              );
            })}

          {dragOverPosition && dragOverPosition.storylineId === storyline.id && (
            <div
              className="btl-drop-indicator"
              style={{ left: dragOverPosition.x, background: railColor }}
            />
          )}
          {nodesInStoryline.map((node) => renderNodeCard(node, storyline.id))}
          {nodesInStoryline.length === 0 && !draggedNode && isExpanded && (
            <div className="btl-empty">No chapters in this storyline</div>
          )}
        </div>
      </div>
    );
  };

  // ---- Layout math ----
  const totalHeight = getTimelineHeight();
  const minimapHeight =
    isExpanded && storylines.length > 0 ? TIMELINE_CONFIG.MINIMAP_HEIGHT : 0;
  const axisHeight =
    isExpanded && isNarrative && storylines.length > 0 ? TIMELINE_CONFIG.AXIS_HEIGHT : 0;
  const rowsAreaHeight = Math.max(
    0,
    totalHeight - TIMELINE_CONFIG.HEAD_HEIGHT - minimapHeight - axisHeight,
  );
  const rowHeight = storylines.length > 0 ? rowsAreaHeight / storylines.length : 0;
  // SVG overlay sits inside the scroll container which may have the axis
  // row as a sibling; offset Y so overlays align with the rows area.
  const overlayTopOffset = axisHeight;
  const rowCenterY = (idx: number) => overlayTopOffset + idx * rowHeight + rowHeight / 2;
  const scrollContentWidth = TIMELINE_CONFIG.RAIL_WIDTH + timelineWidth;
  const railOffset = isExpanded ? TIMELINE_CONFIG.RAIL_WIDTH : TIMELINE_CONFIG.RAIL_WIDTH_STRIP;

  const activeNode = activeSelectedNodeId ? (nodeById.get(activeSelectedNodeId) ?? null) : null;
  const activeOrder = activeNode ? orderOf(activeNode) : null;
  // Playhead — hidden when the active node has no position in the current
  // view (e.g. in narrative view with no narrativeOrder yet).
  const playheadX =
    activeOrder != null && isExpanded
      ? railOffset + orderToPosition(activeOrder) + nodeWidth / 2
      : null;

  const renderMinimap = () => {
    if (!isExpanded || storylines.length === 0) return null;
    const totalWidth = timelineWidth || 1;
    const playheadPct =
      activeOrder != null
        ? ((orderToPosition(activeOrder) + nodeWidth / 2) / totalWidth) * 100
        : null;

    return (
      <div className="btl-minimap" aria-hidden>
        {storylines.map((s) => {
          const lane = sortedNodesByStoryline.get(s.id) ?? [];
          const color = s.color || 'hsl(var(--story-4))';
          return (
            <div key={s.id} className="btl-minimap__lane">
              {lane.map((n) => {
                const ord = orderOf(n);
                if (ord === null) return null;
                const left = (orderToPosition(ord) / totalWidth) * 100;
                const w = Math.max(0.4, (nodeWidth / totalWidth) * 100);
                return (
                  <div
                    key={n.id}
                    className="btl-minimap__seg"
                    style={
                      {
                        left: `${left}%`,
                        width: `${w}%`,
                        ['--clip-color' as string]: color,
                        opacity: n.wordCount === 0 ? 0.35 : 0.85,
                      } as React.CSSProperties
                    }
                  />
                );
              })}
              {playheadPct != null && (
                <div className="btl-minimap__playhead" style={{ left: `${playheadPct}%` }} />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ---- TimelinePin support (narrative view only) ----
  // Snap positions: every integer in the placed range plus the immediate
  // tail. Gives smooth drag without sub-pixel placement.
  const snapValues = useMemo(() => {
    if (placedNodes.length === 0) return [] as number[];
    const lo = Math.floor(minOrder);
    const hi = Math.ceil(maxOrder);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [placedNodes.length, minOrder, maxOrder]);

  const [newlyAddedMarkerId, setNewlyAddedMarkerId] = useState<string | null>(null);
  const [pinDragStarts, setPinDragStarts] = useState<Map<string, number>>(new Map());
  const handlePinDragMove = useCallback((id: string, nextOrder: number | null) => {
    setPinDragStarts((prev) => {
      const next = new Map(prev);
      if (nextOrder === null) next.delete(id);
      else next.set(id, nextOrder);
      return next;
    });
  }, []);
  const getPinDisplayOrder = (markerId: string, persistedOrder: number) =>
    pinDragStarts.get(markerId) ?? persistedOrder;

  const handleAddPin = useCallback(() => {
    if (snapValues.length === 0) return;
    const container = scrollContainerRef.current;
    let target = snapValues[0];
    if (container) {
      const centerX =
        container.scrollLeft + container.clientWidth / 2 - TIMELINE_CONFIG.RAIL_WIDTH;
      let bestDist = Infinity;
      for (const s of snapValues) {
        const d = Math.abs(orderToPosition(s) - centerX);
        if (d < bestDist) {
          bestDist = d;
          target = s;
        }
      }
    }
    const created = addMarker(target, '标记');
    if (created) setNewlyAddedMarkerId(created.id);
  }, [snapValues, addMarker, orderToPosition]);

  const renderTimeAxis = () => {
    if (!isExpanded || !isNarrative || storylines.length === 0) return null;
    return (
      <div className="btl-axis">
        <div
          className="btl-axis__rail"
          style={{ width: TIMELINE_CONFIG.RAIL_WIDTH }}
          title="叙事时间标记：点击 + 添加可拖动的时间 pin"
        >
          <span>Time</span>
          <button
            type="button"
            className="btl-axis__rail-add"
            title={snapValues.length === 0 ? '需要至少一个章节才能添加 pin' : '添加时间 pin'}
            disabled={snapValues.length === 0}
            onClick={(e) => {
              e.stopPropagation();
              handleAddPin();
            }}
          >
            +
          </button>
        </div>
        <div className="btl-axis__track" style={{ minWidth: timelineWidth }} />
      </div>
    );
  };

  // ---- Holding drawer (narrative view only) ----
  const renderHoldingDrawer = () => {
    if (!isNarrative || !isExpanded) return null;
    const count = unplacedNodes.length;
    return (
      <div className={`btl-drawer${drawerOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="btl-drawer__tab"
          title="未放置的章节（拖入下方时间轴来安排叙事时间）"
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <span className="btl-drawer__tab-arrow">{drawerOpen ? '▾' : '▸'}</span>
          <span className="btl-drawer__tab-label">未放置</span>
          <span className="btl-drawer__tab-count">{count}</span>
        </button>
        {drawerOpen && (
          <div className="btl-drawer__list">
            {count === 0 ? (
              <div className="btl-drawer__empty">所有章节都在叙事时间轴上</div>
            ) : (
              unplacedNodes.map((node) => {
                const fallbackPrimaryId = node.storylines[0]?.id;
                const primaryId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
                  ? node.mainStorylineId
                  : fallbackPrimaryId;
                const sl = primaryId ? storylineById.get(primaryId) : null;
                const color = sl?.color || 'hsl(var(--ink-4))';
                return (
                  <div
                    key={node.id}
                    className="btl-drawer__chip"
                    draggable
                    onDragStart={(e) => handleDrawerDragStart(e, node)}
                    onDragEnd={handleDragEnd}
                    onClick={() => setNodeSelection(node.id, 'ui')}
                    style={{ ['--clip-color' as string]: color } as React.CSSProperties}
                    title={node.title || '未命名'}
                  >
                    <span className="btl-drawer__chip-dot" />
                    <span className="btl-drawer__chip-num">
                      § {String(node.bookOrder).padStart(2, '0')}
                    </span>
                    <span className="btl-drawer__chip-title">{node.title || '未命名'}</span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  };

  const renderHead = () => {
    const totalNodes = nodesWithStorylines.length;
    const total = `${storylines.length} ${storylines.length === 1 ? 'storyline' : 'storylines'} · ${totalNodes} ${totalNodes === 1 ? 'chapter' : 'chapters'}`;
    return (
      <div className="btl__head" onClick={(e) => e.stopPropagation()}>
        <div className="btl__head-left">
          <span className="btl__head-title">Storyline Timeline</span>
          <span className="btl__head-meta">{total}</span>
          <div className="btl__view-toggle" title="视图：书序 / 叙事时">
            <button
              className={viewMode === 'book' ? 'is-active' : ''}
              onClick={() => setViewMode('book')}
              title="书序：按阅读顺序排列"
            >
              书序
            </button>
            <button
              className={viewMode === 'narrative' ? 'is-active' : ''}
              onClick={() => setViewMode('narrative')}
              title="叙事时：按 in-world 时间排列（允许倒叙）"
            >
              叙事时
            </button>
          </div>
        </div>
        <div className="btl__head-right">
          <button
            className="btl__head-btn"
            title="定位到当前章节"
            onClick={() => {
              if (activeOrder == null || !scrollContainerRef.current) return;
              const left =
                TIMELINE_CONFIG.RAIL_WIDTH +
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
          <div className="btl__state-toggle" title="时间线状态 (⌘J)">
            <button
              className={timelineMode === 'collapsed' ? 'is-active' : ''}
              onClick={() => setTimelineMode('collapsed')}
              title="收起"
            >
              ▬
            </button>
            <button
              className={timelineMode === 'expanded' ? 'is-active' : ''}
              onClick={() => setTimelineMode('expanded')}
              title="展开"
            >
              ▣
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={timelineRef}
      className="btl"
      data-state={timelineMode}
      data-view={viewMode}
      onClick={handleTimelineClick}
      style={{ height: totalHeight }}
    >
      {isExpanded && (
        <div
          className="btl__resize"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsResizingHeight(true);
          }}
        />
      )}

      {renderHead()}
      {renderMinimap()}
      {renderHoldingDrawer()}

      <div
        ref={scrollContainerRef}
        data-timeline-container
        className="btl__scroll"
        onTouchStart={touchHandlers.onTouchStart}
        onTouchMove={touchHandlers.onTouchMove}
        onTouchEnd={touchHandlers.onTouchEnd}
        onTouchCancel={touchHandlers.onTouchCancel}
        style={{
          touchAction: isExpanded ? 'pan-x pinch-zoom' : 'pan-x',
        }}
      >
        {renderTimeAxis()}

        {storylines.length > 0 ? (
          storylines.map((storyline) => renderStorylineRow(storyline))
        ) : (
          <div className="btl-loading">Loading storylines…</div>
        )}

        {/* TimelinePin labels/heads (narrative view only). Grid lines are
            rendered inside each track so they paint behind clips. */}
        {isNarrative &&
          isExpanded &&
          storylines.length > 0 &&
          markers.map((m) => (
            <TimelinePin
              key={`pin-${m.id}`}
              marker={m}
              snapValues={snapValues}
              orderToPosition={orderToPosition}
              xOffset={railOffset}
              displayOrder={getPinDisplayOrder(m.id, m.narrativeOrder)}
              isDragging={pinDragStarts.has(m.id)}
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
              onDragMove={(nextOrder) => handlePinDragMove(m.id, nextOrder)}
            />
          ))}

        {/* Playhead — vertical accent line at the currently-editing tile. */}
        {playheadX != null && (
          <div
            className="btl-playhead"
            style={{ left: playheadX, top: overlayTopOffset, height: rowsAreaHeight }}
          />
        )}

        {/* Cross-storyline links overlay */}
        {crossStorylineLinks.length > 0 &&
          storylines.length > 0 &&
          rowHeight > 0 &&
          isExpanded && (
            <svg
              className="btl-crosslinks"
              width={scrollContentWidth}
              height={overlayTopOffset + rowsAreaHeight}
              style={{ width: scrollContentWidth, height: overlayTopOffset + rowsAreaHeight }}
            >
              {crossStorylineLinks.map((link) => {
                const x1 = railOffset + link.fromX;
                const x2 = railOffset + link.toX;
                const y1 = rowCenterY(link.fromY);
                const y2 = rowCenterY(link.toY);
                const midY = (y1 + y2) / 2;
                const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
                return (
                  <g key={link.key}>
                    <path
                      d={d}
                      stroke={link.color}
                      strokeWidth="1"
                      strokeDasharray="2 3"
                      strokeLinecap="round"
                      fill="none"
                      opacity="0.6"
                    />
                    {link.markFrom && (
                      <circle cx={x1} cy={y1} r="2" fill={link.color} opacity="0.85" />
                    )}
                    {link.markTo && (
                      <circle cx={x2} cy={y2} r="2" fill={link.color} opacity="0.85" />
                    )}
                  </g>
                );
              })}
            </svg>
          )}
      </div>

      <BottomTimelineContextMenu
        contextMenu={contextMenu}
        contextMenuRef={contextMenuRef}
        getContextMenuPosition={getContextMenuPosition}
        onAction={(action: BottomTimelineContextMenuAction) => {
          void handleContextMenuAction(action);
        }}
      />

      <NodeHoverPreview
        node={hoveredNodeId ? (nodeById.get(hoveredNodeId) ?? null) : null}
        position={hoverPosition}
        showAbove={true}
      />
    </div>
  );
}
