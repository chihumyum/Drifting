import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useMatch } from 'react-router-dom';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookNode } from '../../usecase/useBookNode';
import type { Storyline } from '../../domain/storyline';
import { CHAPTER_ORDER_STRIDE } from '../../domain/book-node';
import { useAuthStore } from '../../store/auth';
import { NodeHoverPreview } from '../NodeHoverPreview';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useTimelineExpandedScale } from './useTimelineExpandedScale';
import { useBottomTimelineContextMenuActions } from './useBottomTimelineContextMenuActions';
import { useBottomTimelineSelectors } from './useBottomTimelineSelectors';
import { useBottomTimelineInteractionState } from './useBottomTimelineInteractionState';
import { BottomTimelineContextMenu } from './BottomTimelineContextMenu';
import { FullBookLane } from './FullBookLane';
import type { BottomTimelineContextMenuAction, TimelineNode } from './types';
import { useUiStore } from '../../store/ui-store';
import { useTimelineMarkers } from '../../hooks/useTimelineMarkers';
import loglevel from 'loglevel';
import '../../../styles/bottom-timeline.css';
const log = loglevel.getLogger('BottomTimeline');
log.setLevel(loglevel.levels.WARN);

// BottomTimeline hosts two views over the storyline rows:
//   - book      — tiles sorted by node.bookOrder
//   - narrative — tiles sorted by node.narrativeOrder; nodes without one
//                 sit in the holding popover (top-right of the head).
// In book view, a FullBookLane runs across the top — the "global reading
// order" reference and the home of the playhead. Chips pack from the left
// (bookOrder-sorted, not bookOrder-positioned); reordering animates via
// CSS transition. Narrative view skips the lane (its time axis takes the
// same vertical slot instead).
//
// The old collapsed (strip) state is gone — the timeline is either visible
// or hidden, controlled by the global BottomStatusBar. Visibility lives in
// uiStore so the status bar's toggle button can reach it.
type TimelineView = 'book' | 'narrative';
const TIMELINE_VIEW_STORAGE_KEY = 'timeline-view';
const TIMELINE_HEIGHT_STORAGE_KEY = 'timeline-total-height';

const TIMELINE_CONFIG = {
  GRID_UNIT: 20,
  // Fixed tile width in grid units. Tiles no longer carry an `end`, so all
  // tiles occupy the same horizontal span.
  NODE_DEFAULT_WIDTH: 4,
  NODE_MIN_HEIGHT: 18,
  STORYLINE_GAP: 2,
  RAIL_WIDTH: 148,
  HEAD_HEIGHT: 30,
  AXIS_HEIGHT: 22,
  // Match the narrative-axis height (22px) so the lane and axis sit at
  // the same vertical extent regardless of which view is active — visual
  // continuity across mode toggle.
  FULL_BOOK_LANE_HEIGHT: 22,
  DEFAULT_HEIGHT: 340,
  MIN_HEIGHT: 180,
};

function readPersistedView(): TimelineView {
  if (typeof localStorage === 'undefined') return 'book';
  const v = localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY);
  return v === 'narrative' ? 'narrative' : 'book';
}

interface TimelinePinProps {
  marker: import('../../domain/timeline-marker').TimelineMarker;
  snapValues: number[];
  orderToPosition: (order: number) => number;
  xOffset: number;
  isDragging: boolean;
  pinHeight: number;
  editOnMount?: boolean;
  onChange: (patch: { narrativeOrder?: number; label?: string }) => void;
  onDelete: () => void;
  onDragMove: (nextPixelX: number | null) => void;
}

function TimelinePin({
  marker,
  snapValues,
  orderToPosition,
  xOffset,
  isDragging,
  pinHeight,
  editOnMount = false,
  onChange,
  onDelete,
  onDragMove,
}: TimelinePinProps) {
  const [editing, setEditing] = useState(editOnMount);
  const labelRef = useRef<HTMLDivElement>(null);
  // Pin head/label stays anchored to the persisted narrativeOrder during a
  // drag. A separate timeline-level overlay follows the cursor as the drop
  // indicator; on mouseup the pin "jumps" to the new slot.
  const x = xOffset + orderToPosition(marker.narrativeOrder);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      if (snapValues.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startMouseX = e.clientX;
      const startPixel = orderToPosition(marker.narrativeOrder);
      let nearest = marker.narrativeOrder;
      onDragMove(startPixel);
      const onMove = (ev: MouseEvent) => {
        const newPixel = startPixel + (ev.clientX - startMouseX);
        // Smooth drop indicator: report the raw pixel position so the
        // line follows the mouse continuously. Snap is computed locally
        // and only applied on mouseup, matching how chapter-clip drops
        // work (drop indicator at mouse x; snap on drop).
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
        onDragMove(newPixel);
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
  const editorMatch = useMatch('/project/:projectId/editor/:nodeId');
  const storylineMatch = useMatch('/project/:projectId/editor/storyline/:storylineId');
  const nodeId = editorMatch?.params.nodeId;
  const storylineId = storylineMatch?.params.storylineId;
  const user = useAuthStore((state) => state.user);
  const { bookNodes, storylines, nodeStorylineMapping } = useDataStore();
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const selectedNodeUiId = useUiStore((state) => state.nodeUi.selectedId);
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

  const nodesWithStorylines = useMemo<TimelineNode[]>(() => {
    const storylineById = new Map(storylines.map((sl) => [sl.id, sl]));
    return bookNodes
      .filter((node) => node.mainStorylineId != null)
      .map((node) => ({
        ...node,
        storylines: (nodeStorylineMapping[node.id] || [])
          .map((slId) => storylineById.get(slId))
          .filter((sl): sl is Storyline => Boolean(sl)),
      }));
  }, [bookNodes, nodeStorylineMapping, storylines]);

  const [viewMode, setViewMode] = useState<TimelineView>(readPersistedView);
  const [isResizingHeight, setIsResizingHeight] = useState(false);
  const [unplacedPopoverOpen, setUnplacedPopoverOpen] = useState(false);
  const [customHeight, setCustomHeight] = useState<number | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    return v ? parseInt(v, 10) : null;
  });

  const isNarrative = viewMode === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';

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
    if (!isResizingHeight) return;
    let lastValue: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      const windowHeight = window.innerHeight;
      const minHeight =
        TIMELINE_CONFIG.HEAD_HEIGHT +
        TIMELINE_CONFIG.FULL_BOOK_LANE_HEIGHT +
        Math.max(storylines.length, 1) *
          (TIMELINE_CONFIG.NODE_MIN_HEIGHT + TIMELINE_CONFIG.STORYLINE_GAP);
      const next = Math.max(
        Math.max(minHeight, TIMELINE_CONFIG.MIN_HEIGHT),
        windowHeight - e.clientY,
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
  }, [isResizingHeight, storylines.length]);

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
    isExpanded: true,
    expandedScale,
    gridUnit: TIMELINE_CONFIG.GRID_UNIT,
    nodeDefaultWidth: TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
    orderField,
  });

  // Helper: which storyline owns this node as its "main" row.
  const primaryStorylineId = useCallback(
    (node: { mainStorylineId: string | null; storylines: Storyline[] }) => {
      const fallback = node.storylines[0]?.id ?? null;
      return node.storylines.some((sl) => sl.id === node.mainStorylineId)
        ? node.mainStorylineId
        : fallback;
    },
    [],
  );

  // Drift nodes (no storyline) don't appear on the global reading lane —
  // they're floating notes, not part of the book sequence.
  const bookLaneNodes = useMemo(
    () =>
      nodesWithStorylines.filter((n) => primaryStorylineId(n) != null),
    [nodesWithStorylines, primaryStorylineId],
  );

  // Resolver for FullBookLane chip color — looks up the node's primary
  // storyline so the chip dot matches its track on the rows below.
  const laneprimaryStorylineId = useCallback(
    (n: { id: string }) => {
      const tn = nodesWithStorylines.find((nw) => nw.id === n.id);
      if (!tn) return null;
      return primaryStorylineId(tn);
    },
    [nodesWithStorylines, primaryStorylineId],
  );

  const getTimelineHeight = () =>
    Math.max(TIMELINE_CONFIG.MIN_HEIGHT, customHeight ?? TIMELINE_CONFIG.DEFAULT_HEIGHT);

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

  // Close the unplaced popover on outside click or ESC.
  const unplacedPopoverRef = useRef<HTMLDivElement>(null);
  const unplacedBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!unplacedPopoverOpen) unplacedBtnRef.current?.blur();
  }, [unplacedPopoverOpen]);
  useEffect(() => {
    if (!unplacedPopoverOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && unplacedPopoverRef.current?.contains(t)) return;
      setUnplacedPopoverOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      unplacedBtnRef.current?.blur();
      setUnplacedPopoverOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [unplacedPopoverOpen]);

  const handleNodeDragStart = (e: React.DragEvent, node: TimelineNode, storylineId: string) => {
    clearHoverPreview();
    setDraggedNode({ node, storylineId });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrawerDragStart = (e: React.DragEvent, node: TimelineNode) => {
    clearHoverPreview();
    const sourceId = primaryStorylineId(node) ?? '';
    setDraggedNode({ node, storylineId: sourceId });
    e.dataTransfer.effectAllowed = 'move';
    // Do NOT close the popover here: re-rendering during dragstart unmounts
    // the chip we just started dragging, and the browser cancels the drag.
    // The popover closes on dragend (handleDragEnd) instead.
  };

  // Drags from the holding popover can ONLY drop on the node's main
  // storyline — anywhere else, no drop indicator + no drop accepted.
  const draggedNodePrimaryStorylineId = useMemo(
    () => (draggedNode ? primaryStorylineId(draggedNode.node) : null),
    [draggedNode, primaryStorylineId],
  );
  const isDraggedFromDrawer = useMemo(
    () => (draggedNode ? orderOf(draggedNode.node) === null : false),
    [draggedNode, orderOf],
  );
  const canDropOnStoryline = (rowStorylineId: string) => {
    if (!draggedNode) return false;
    if (!isDraggedFromDrawer) return true; // axis-to-axis drag: any row
    return rowStorylineId === draggedNodePrimaryStorylineId;
  };

  const handleNodeDragOver = (e: React.DragEvent, storylineRowId: string) => {
    if (!draggedNode) return;
    if (!canDropOnStoryline(storylineRowId)) return; // implicit reject (no preventDefault)
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

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

    setDragOverPosition({ storylineId: storylineRowId, order, x: mouseX });
  };

  const handleDrop = async (e: React.DragEvent, targetStorylineId: string) => {
    if (!draggedNode || !dragOverPosition) return;
    if (!canDropOnStoryline(targetStorylineId)) return;
    e.preventDefault();
    clearHoverPreview();

    const { node, storylineId: sourceStorylineId } = draggedNode;
    const targetOrder = dragOverPosition.order;
    const currentOrder = orderOf(node);

    try {
      const fromDrawer = currentOrder === null;
      if (!fromDrawer) {
        // Axis-to-axis drag may also re-route the node's primary storyline.
        const isPrimaryStoryline =
          primaryStorylineId(node) === sourceStorylineId;
        if (!isPrimaryStoryline) {
          log.warn('Can only drag from primary storyline');
          return;
        }
        const isTargetInNodeStorylines = node.storylines.some((t) => t.id === targetStorylineId);
        if (sourceStorylineId !== targetStorylineId) {
          await updateNode(node.id, { mainStorylineId: targetStorylineId });
          if (!isTargetInNodeStorylines) {
            await removeNodeFromStoryline(node.id, sourceStorylineId);
          }
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
    // Close the unplaced popover once the drag finishes (whether the drop
    // succeeded or not). Closing earlier — e.g. on dragstart — would
    // unmount the dragged chip mid-flight and the browser would cancel
    // the drag entirely.
    setUnplacedPopoverOpen(false);
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
    m.forEach((arr) => arr.sort((a, b) => (orderOf(a) ?? 0) - (orderOf(b) ?? 0)));
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
    const isSelected = (selectedNodeUiId ?? nodeId) === node.id;
    const isPrimary = isPrimaryStorylineForNode(node, storylineId);

    if (!isPrimary) return null;

    const order = orderOf(node);
    if (order === null) return null;

    const defaultColor = '#2D4A6B';
    const clipColor = storyline?.color || defaultColor;
    const leftPosition = orderToPosition(order);
    // Mutually-exclusive status classes — see FullBookLane for the same
    // logic. waiting_review / revising are visually treated as draft until
    // the AI-review pipeline ships its own affordances.
    const status = node.writingStatus;
    const stateClass =
      status === 'finished'
        ? 'is-finished'
        : status === 'discarded'
          ? 'is-discarded'
          : 'is-draft';

    const handleMouseMove = (e: React.MouseEvent) => {
      if (draggedNode) {
        clearHoverPreview();
        return;
      }
      if (hoveredNodeId !== node.id) {
        handleNodeMouseEnter(node, e);
      }
    };

    const className = ['btl-clip', isSelected ? 'is-selected' : '', stateClass]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        key={`${node.id}-${storylineId}`}
        data-node-card
        className={className}
        draggable={isPrimary}
        onDragStart={(e) => handleNodeDragStart(e, node, storylineId)}
        onDragEnd={handleDragEnd}
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
          <div className="btl-clip__title">{node.title || '未命名'}</div>
        </div>
      </div>
    );
  };

  const renderStorylineRow = (storyline: Storyline) => {
    const nodesInStoryline = getNodesInStoryline(storyline.id);
    const isRouteActive = storylineId === storyline.id;
    const railColor = storyline.color || 'hsl(var(--story-4))';

    const activeId = selectedNodeUiId ?? nodeId;
    const selectedNode = activeId ? (nodeById.get(activeId) ?? null) : null;
    const selectedNodeBelongsToStoryline =
      selectedNode?.storylines.some((t) => t.id === storyline.id) ?? false;

    const isDropDisabled = !!draggedNode && !canDropOnStoryline(storyline.id);

    return (
      <div
        key={storyline.id}
        className={`btl-row${isDropDisabled ? ' is-drop-disabled' : ''}`}
        onDragOver={(e) => handleNodeDragOver(e, storyline.id)}
        onDrop={(e) => handleDrop(e, storyline.id)}
        onClick={(e) => {
          e.stopPropagation();
          clearContextMenu();
        }}
        onContextMenu={(e) => {
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
              canAddCurrentNode: Boolean(activeId && !selectedNodeBelongsToStoryline),
            });
          }
        }}
      >
        <div
          data-track-rail
          className={`btl-rail ${isRouteActive ? 'is-active' : ''}`}
          onClick={(e) => e.stopPropagation()}
          title={storyline.name || 'Untitled Storyline'}
          style={{ width: TIMELINE_CONFIG.RAIL_WIDTH }}
        >
          <span aria-hidden className="btl-rail__stripe" style={{ background: railColor }} />
          <div className="btl-rail__main">
            <div className="btl-rail__name">{storyline.name || 'Untitled'}</div>
            <div className="btl-rail__count">
              {nodesInStoryline.length} {nodesInStoryline.length === 1 ? 'ch' : 'chs'}
            </div>
          </div>
        </div>

        <div
          data-node-container
          className="btl-track"
          style={{ background: 'hsl(var(--page))', minWidth: timelineWidth }}
        >
          {isNarrative &&
            markers.map((m) => {
              const dragX = pinDragXs.get(m.id);
              const isDragging = dragX !== undefined;
              const left = dragX ?? orderToPosition(m.narrativeOrder);
              return (
                <div
                  key={`pinline-${m.id}`}
                  className={`btl-pin-line${isDragging ? ' is-dragging' : ''}`}
                  style={{ left }}
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
          {nodesInStoryline.length === 0 && !draggedNode && (
            <div className="btl-empty">No chapters in this storyline</div>
          )}
        </div>
      </div>
    );
  };

  // ---- Layout math ----
  const totalHeight = getTimelineHeight();
  // FullBookLane is a book-mode-only summary track. Narrative mode skips it
  // — narrativeOrder doesn't define reading order, so a "reading-order"
  // summary above the narrative axis would just be a misleading repetition
  // of bookOrder layout that doesn't match the axis below.
  const fullBookLaneHeight = isNarrative ? 0 : TIMELINE_CONFIG.FULL_BOOK_LANE_HEIGHT;
  const axisHeight = isNarrative && storylines.length > 0 ? TIMELINE_CONFIG.AXIS_HEIGHT : 0;
  const rowsAreaHeight = Math.max(
    0,
    totalHeight - TIMELINE_CONFIG.HEAD_HEIGHT - fullBookLaneHeight - axisHeight,
  );
  const rowHeight = storylines.length > 0 ? rowsAreaHeight / storylines.length : 0;
  const overlayTopOffset = axisHeight;
  const rowCenterY = (idx: number) => overlayTopOffset + idx * rowHeight + rowHeight / 2;
  const scrollContentWidth = TIMELINE_CONFIG.RAIL_WIDTH + timelineWidth;
  const railOffset = TIMELINE_CONFIG.RAIL_WIDTH;

  const snapValues = useMemo(() => {
    if (placedNodes.length === 0) return [] as number[];
    const lo = Math.floor(minOrder);
    const hi = Math.ceil(maxOrder);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [placedNodes.length, minOrder, maxOrder]);

  const [newlyAddedMarkerId, setNewlyAddedMarkerId] = useState<string | null>(null);
  // Live pixel position of each in-flight pin drag (relative to the track).
  // Used to render the vertical drop-indicator line under the cursor; the
  // pin head/label itself stays anchored to the persisted narrativeOrder
  // until mouseup — same UX as chapter clips, no per-step snapping.
  const [pinDragXs, setPinDragXs] = useState<Map<string, number>>(new Map());

  const handlePinDragMove = useCallback((id: string, nextX: number | null) => {
    setPinDragXs((prev) => {
      const next = new Map(prev);
      if (nextX === null) next.delete(id);
      else next.set(id, nextX);
      return next;
    });
  }, []);

  // "打散" — keeps relative ordering, reassigns the active order field
  // (bookOrder or narrativeOrder) with the same stride that new chapters
  // use (CHAPTER_ORDER_STRIDE = tile width + 1), so scatter spacing matches
  // creation spacing and adjacent tiles sit a single grid unit apart.
  const handleSpread = useCallback(async () => {
    if (placedNodes.length < 2) return;
    const sorted = placedNodes
      .slice()
      .sort((a, b) => (orderOf(a) ?? 0) - (orderOf(b) ?? 0));
    const SPACING = CHAPTER_ORDER_STRIDE;
    const startOrder = Math.min(orderOf(sorted[0]) ?? 1, 1);
    const updates: Array<{ id: string; newOrder: number }> = [];
    sorted.forEach((node, i) => {
      const newOrder = startOrder + i * SPACING;
      if (orderOf(node) !== newOrder) updates.push({ id: node.id, newOrder });
    });
    try {
      for (const u of updates) {
        await updateNode(u.id, { [orderField]: u.newOrder });
      }
    } catch (err) {
      log.error('Failed to spread timeline nodes', err);
    }
  }, [placedNodes, orderOf, updateNode, orderField]);

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
    if (!isNarrative || storylines.length === 0) return null;
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
          {isNarrative && (
            <div className="btl__unplaced" ref={unplacedPopoverRef}>
              <button
                ref={unplacedBtnRef}
                type="button"
                className={`btl__unplaced-btn${unplacedPopoverOpen ? ' is-open' : ''}`}
                onClick={() => setUnplacedPopoverOpen((v) => !v)}
                title="未放置到叙事时间轴上的章节"
              >
                <span>未放置</span>
                <span className="btl__unplaced-count">{unplacedNodes.length}</span>
                <span className="btl__unplaced-arrow">▾</span>
              </button>
              {unplacedPopoverOpen && (
                <div className="btl__unplaced-popover">
                  {unplacedNodes.length === 0 ? (
                    <div className="btl__unplaced-empty">所有章节都在叙事时间轴上</div>
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
                            draggable
                            onDragStart={(e) => handleDrawerDragStart(e, node)}
                            onDragEnd={handleDragEnd}
                            onClick={() => setNodeSelection(node.id, 'ui')}
                            style={{ ['--clip-color' as string]: color } as React.CSSProperties}
                            title={node.title || '未命名'}
                          >
                            <span className="btl__unplaced-chip-dot" />
                            <span className="btl__unplaced-chip-num">
                              § {String(node.bookOrder ?? 0).padStart(2, '0')}
                            </span>
                            <span className="btl__unplaced-chip-title">
                              {node.title || '未命名'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="btl__head-right">
          <button
            className="btl__head-btn"
            title={
              placedNodes.length < 2
                ? '至少两个章节才能打散'
                : `打散：把${isNarrative ? '叙事时' : '书序'}重排，让重叠的节点拉开间距`
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
            title="定位到当前章节"
            onClick={() => {
              const activeId = selectedNodeUiId ?? nodeId;
              const activeNode = activeId ? nodeById.get(activeId) ?? null : null;
              const activeOrder = activeNode ? orderOf(activeNode) : null;
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
        </div>
      </div>
    );
  };

  const activeNodeId = selectedNodeUiId ?? nodeId ?? null;

  return (
    <div
      ref={timelineRef}
      className="btl"
      data-view={viewMode}
      onClick={handleTimelineClick}
      style={{ height: totalHeight }}
    >
      <div
        className="btl__resize"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsResizingHeight(true);
        }}
      />

      {renderHead()}

      {/* The lane scrolls independently from the storyline-tracks below —
          it's "the global reading order, packed", so its horizontal
          position has no relation to where the active view's tiles sit.
          Sibling of (not inside) the scroll container. */}
      {!isNarrative && (
        <FullBookLane
          nodes={bookLaneNodes}
          storylines={storylines}
          primaryStorylineId={laneprimaryStorylineId}
          activeNodeId={activeNodeId}
          trackOffsetX={TIMELINE_CONFIG.RAIL_WIDTH}
          onNodeClick={(id) => {
            setNodeSelection(id, 'ui');
            // Scroll the storyline rows below so the clicked chapter's
            // tile lands roughly centered in the viewport. Smooth scroll
            // gives the "fast, dynamic" feel the user asked for.
            const target = nodeById.get(id);
            const container = scrollContainerRef.current;
            if (!target || !container) return;
            const ord = orderOf(target);
            if (ord == null) return;
            const left =
              TIMELINE_CONFIG.RAIL_WIDTH +
              orderToPosition(ord) +
              nodeWidth / 2 -
              container.clientWidth / 2;
            container.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
          }}
          height={fullBookLaneHeight || TIMELINE_CONFIG.FULL_BOOK_LANE_HEIGHT}
        />
      )}

      <div
        ref={scrollContainerRef}
        data-timeline-container
        className="btl__scroll"
        onTouchStart={touchHandlers.onTouchStart}
        onTouchMove={touchHandlers.onTouchMove}
        onTouchEnd={touchHandlers.onTouchEnd}
        onTouchCancel={touchHandlers.onTouchCancel}
        style={{ touchAction: 'pan-x pinch-zoom' }}
      >
        {renderTimeAxis()}

        {storylines.length > 0 ? (
          storylines.map((storyline) => renderStorylineRow(storyline))
        ) : (
          <div className="btl-loading">Loading storylines…</div>
        )}

        {isNarrative &&
          storylines.length > 0 &&
          markers.map((m) => (
            <TimelinePin
              key={`pin-${m.id}`}
              marker={m}
              snapValues={snapValues}
              orderToPosition={orderToPosition}
              xOffset={railOffset}
              isDragging={pinDragXs.has(m.id)}
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
              onDragMove={(nextPixelX) => handlePinDragMove(m.id, nextPixelX)}
            />
          ))}

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
              // SVG sits inside .btl__scroll which contains axis + rows.
              // The FullBookLane is a SIBLING of the scroll container so
              // its height doesn't enter this Y offset.
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

      <BottomTimelineContextMenu
        contextMenu={contextMenu}
        contextMenuRef={contextMenuRef}
        getContextMenuPosition={getContextMenuPosition}
        onAction={(action: BottomTimelineContextMenuAction) => {
          void handleContextMenuAction(action);
        }}
        isNarrative={isNarrative}
        selectedNodeHasNarrativeOrder={(() => {
          if (contextMenu?.type !== 'node' || !contextMenu.nodeId) return false;
          const n = nodeById.get(contextMenu.nodeId);
          return n != null && typeof n.narrativeOrder === 'number';
        })()}
      />

      <NodeHoverPreview
        node={hoveredNodeId ? (nodeById.get(hoveredNodeId) ?? null) : null}
        position={hoverPosition}
        showAbove={true}
      />
    </div>
  );
}
