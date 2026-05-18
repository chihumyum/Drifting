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
import loglevel from 'loglevel';
import '../../../styles/bottom-timeline.css';
const log = loglevel.getLogger('BottomTimeline');
log.setLevel(loglevel.levels.WARN);

// Phase 1: BottomTimeline is the **book-order** view only. Narrative-time
// view, holding drawer for unplaced nodes, and TimelinePin markers all live
// in Phase 2. Tiles here are fixed-width (no resize, no `end`) — the only
// horizontal data per node is its `bookOrder`.
type TimelineState = 'collapsed' | 'expanded';
const TIMELINE_STATE_STORAGE_KEY = 'timeline-mode';
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

export function BottomTimeline() {
  // BottomTimeline is rendered inside Layout, which is a SIBLING of the
  // route Outlet — so useParams() here only sees the parent route's
  // params (projectId), not the child route's (nodeId / storylineId).
  // Use useMatch against the known child-route patterns to recover them.
  const editorMatch = useMatch('/project/:projectId/editor/:nodeId');
  const storylineMatch = useMatch('/project/:projectId/editor/storyline/:storylineId');
  const nodeId = editorMatch?.params.nodeId;
  const storylineId = storylineMatch?.params.storylineId;
  const user = useAuthStore((state) => state.user);
  const { bookNodes, storylines, nodeStorylineMapping } = useDataStore();
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const { projectId, navigateToNode, navigateToHome } = useProjectNavigation();
  const { createNode, updateNode, deleteNode } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { addNodeToStoryline, getStorylinesByNode, removeNodeFromStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const activeSelectedNodeId = nodeId;

  // Node↔storyline relationships derived from the store; the mapping is
  // pre-loaded once at app boot (App.tsx -> loadNodeStorylineMapping).
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
  const [isResizingHeight, setIsResizingHeight] = useState(false);
  const [customExpandedHeight, setCustomExpandedHeight] = useState<number | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    return v ? parseInt(v, 10) : null;
  });

  const isExpanded = timelineMode === 'expanded';

  useEffect(() => {
    localStorage.setItem(TIMELINE_STATE_STORAGE_KEY, timelineMode);
  }, [timelineMode]);

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

  // Save scroll position to localStorage
  const saveScrollPosition = useCallback(() => {
    if (scrollContainerRef.current) {
      const scrollLeft = scrollContainerRef.current.scrollLeft;
      localStorage.setItem('timeline-scroll-position', scrollLeft.toString());
    }
  }, []);

  // Restore scroll position from localStorage
  useEffect(() => {
    const savedPosition = localStorage.getItem('timeline-scroll-position');
    if (savedPosition && scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = parseInt(savedPosition, 10);
    }
  }, [storylines.length]); // Restore after storylines are loaded

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

  // Drag-resize top edge to change expanded dock height (no-op when collapsed)
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

  // Save scroll position on scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let timeoutId: number;
    const handleScroll = () => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        saveScrollPosition();
      }, 300); // Debounce saves
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
    minOrder,
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
  });

  // Total dock height per mode
  const getTimelineHeight = () => {
    if (storylines.length === 0) return TIMELINE_CONFIG.HEAD_HEIGHT + 40;

    if (timelineMode === 'collapsed') {
      // header + tiny color bars (one per storyline)
      return (
        TIMELINE_CONFIG.HEAD_HEIGHT +
        Math.max(20, storylines.length * (TIMELINE_CONFIG.NODE_COMPACT_HEIGHT + 1))
      );
    }
    return customExpandedHeight ?? TIMELINE_CONFIG.DEFAULT_EXPANDED_HEIGHT;
  };

  // Clamp context menu placement so it stays inside the viewport.
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

  // Close context menu on outside click
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

  // Compute the bookOrder slot the dragged tile would snap into based on
  // the pointer X within the track container.
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

    try {
      const fallbackPrimaryId = node.storylines[0]?.id;
      const primaryStorylineId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
        ? node.mainStorylineId
        : fallbackPrimaryId;
      const isPrimaryStoryline = primaryStorylineId === sourceStorylineId;
      const isTargetInNodeStorylines = node.storylines.some((t) => t.id === targetStorylineId);

      if (!isPrimaryStoryline) {
        log.warn('Can only drag from primary storyline');
        return;
      }

      if (sourceStorylineId !== targetStorylineId) {
        // Change main first. updateNode auto-links the target into the
        // node_storyline_link table, so the row exists before we remove the
        // old main (otherwise removeNodeFromStoryline rejects the unlink).
        await updateNode(node.id, { mainStorylineId: targetStorylineId });
        if (!isTargetInNodeStorylines) {
          await removeNodeFromStoryline(node.id, sourceStorylineId);
        }
      }

      if (targetOrder !== node.bookOrder) {
        await updateNode(node.id, { bookOrder: targetOrder });
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

  // Left-click on the timeline background only dismisses menus — never
  // navigates. Timeline is for viewing/editing structure, not routing.
  const handleTimelineClick = () => {
    clearContextMenu();
  };

  // A node lands on its `mainStorylineId` row by default; in storylines
  // where it's only a transit point, the cross-storyline curves represent
  // it instead of a tile.
  const isPrimaryStorylineForNode = (node: TimelineNode, storylineId: string): boolean => {
    const fallbackPrimaryId = node.storylines[0]?.id;
    const primaryId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
      ? node.mainStorylineId
      : fallbackPrimaryId;
    return primaryId === storylineId;
  };

  // Storyline row index (top-to-bottom)
  const storylineRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    storylines.forEach((s, idx) => map.set(s.id, idx));
    return map;
  }, [storylines]);

  // Pre-sorted node list per storyline (ascending by bookOrder), used to
  // find the "next node by book order" on each non-main storyline.
  const sortedNodesByStoryline = useMemo(() => {
    const m = new Map<string, TimelineNode[]>();
    storylines.forEach((s) => m.set(s.id, []));
    nodesWithStorylines.forEach((node) => {
      node.storylines.forEach((sl) => {
        const arr = m.get(sl.id);
        if (arr) arr.push(node);
      });
    });
    m.forEach((arr) => arr.sort((a, b) => a.bookOrder - b.bookOrder));
    return m;
  }, [nodesWithStorylines, storylines]);

  // Cross-storyline link paths: for each node N that belongs to multiple
  // storylines (main = M, secondary = S₁…Sₖ), draw curves that visualise
  // N's role as a transit point on every secondary storyline.
  // For each secondary storyline S:
  //   prev (on S row)  →  N (on M row, where the tile lives)
  //   N (on M row)     →  next (on S row)
  // If prev/next is missing (N is first/last on S), that half is omitted.
  // Adjacency comes from N's index in S's bookOrder-sorted lane so ties
  // are handled deterministically.
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

    for (const node of nodesWithStorylines) {
      if (node.storylines.length <= 1) continue;
      const fallbackMainId = node.storylines[0]?.id;
      const mainId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
        ? node.mainStorylineId
        : fallbackMainId;
      if (!mainId) continue;
      const mainRowIdx = storylineRowIndex.get(mainId);
      if (mainRowIdx === undefined) continue;

      const nodeMidX = orderToPosition(node.bookOrder) + nodeWidth / 2;

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
          const prevMidX = orderToPosition(prev.bookOrder) + nodeWidth / 2;
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
        if (next) {
          const nextMidX = orderToPosition(next.bookOrder) + nodeWidth / 2;
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
    return links;
  }, [
    nodesWithStorylines,
    storylineRowIndex,
    sortedNodesByStoryline,
    orderToPosition,
    nodeWidth,
    isExpanded,
  ]);

  // Render a single node tile. Fixed-width — no resize handles, no summary
  // body. Title + §number + storyline color are the only payload.
  const renderNodeCard = (node: TimelineNode, storylineId: string) => {
    const storyline = storylineById.get(storylineId);
    const isSelected = activeSelectedNodeId === node.id;
    const isPrimary = isPrimaryStorylineForNode(node, storylineId);

    // Multi-storyline nodes only show their tile on the main storyline.
    if (!isPrimary) return null;

    const defaultColor = '#2D4A6B'; // matches --story-2
    const clipColor = storyline?.color || defaultColor;
    const leftPosition = orderToPosition(node.bookOrder);
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

  // Render a single storyline row with absolute-positioned tiles.
  const renderStorylineRow = (storyline: Storyline) => {
    const nodesInStoryline = getNodesInStoryline(storyline.id);
    const isRouteActive = storylineId === storyline.id;
    const railColor = storyline.color || 'hsl(var(--story-4))';

    const selectedNode = activeSelectedNodeId ? (nodeById.get(activeSelectedNodeId) ?? null) : null;
    const selectedNodeBelongsToStoryline =
      selectedNode?.storylines.some((t) => t.id === storyline.id) ?? false;

    // Tracks render on a near-white page color when expanded. Collapsed
    // mode keeps the dock background showing through.
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
            const nl = orderToPosition(node.bookOrder);
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
        {/* Rail — sticky left, shows storyline identity */}
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

        {/* Track — fixed-width tiles only; no grid lines, no edge handles */}
        <div
          data-node-container
          className="btl-track"
          style={{ background: trackBg, minWidth: timelineWidth }}
        >
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

  // ---- Layout math for SVG overlay & playhead ----
  const totalHeight = getTimelineHeight();
  const minimapHeight =
    isExpanded && storylines.length > 0 ? TIMELINE_CONFIG.MINIMAP_HEIGHT : 0;
  const rowsAreaHeight = Math.max(0, totalHeight - TIMELINE_CONFIG.HEAD_HEIGHT - minimapHeight);
  const rowHeight = storylines.length > 0 ? rowsAreaHeight / storylines.length : 0;
  const rowCenterY = (idx: number) => idx * rowHeight + rowHeight / 2;
  const scrollContentWidth = TIMELINE_CONFIG.RAIL_WIDTH + timelineWidth;
  const railOffset = isExpanded ? TIMELINE_CONFIG.RAIL_WIDTH : TIMELINE_CONFIG.RAIL_WIDTH_STRIP;

  // Playhead — vertical accent line aligned with the currently-editing
  // node's tile center. Hidden when nothing is selected or the active node
  // isn't in the dataset (e.g. we're on a storyline route).
  const activeNode = activeSelectedNodeId ? (nodeById.get(activeSelectedNodeId) ?? null) : null;
  const playheadX =
    activeNode != null && isExpanded
      ? railOffset + orderToPosition(activeNode.bookOrder) + nodeWidth / 2
      : null;

  const renderMinimap = () => {
    if (!isExpanded || storylines.length === 0) return null;
    const totalWidth = timelineWidth || 1;
    const playheadPct =
      activeNode != null
        ? ((orderToPosition(activeNode.bookOrder) + nodeWidth / 2) / totalWidth) * 100
        : null;

    return (
      <div className="btl-minimap" aria-hidden>
        {storylines.map((s) => {
          const lane = sortedNodesByStoryline.get(s.id) ?? [];
          const color = s.color || 'hsl(var(--story-4))';
          return (
            <div key={s.id} className="btl-minimap__lane">
              {lane.map((n) => {
                const left = (orderToPosition(n.bookOrder) / totalWidth) * 100;
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

  const renderHead = () => {
    const totalNodes = nodesWithStorylines.length;
    const total = `${storylines.length} ${storylines.length === 1 ? 'storyline' : 'storylines'} · ${totalNodes} ${totalNodes === 1 ? 'chapter' : 'chapters'}`;
    return (
      <div className="btl__head" onClick={(e) => e.stopPropagation()}>
        <div className="btl__head-left">
          <span className="btl__head-title">Storyline Timeline</span>
          <span className="btl__head-meta">{total}</span>
        </div>
        <div className="btl__head-right">
          <button
            className="btl__head-btn"
            title="定位到当前章节"
            onClick={() => {
              if (!activeNode || !scrollContainerRef.current) return;
              const left =
                TIMELINE_CONFIG.RAIL_WIDTH +
                orderToPosition(activeNode.bookOrder) -
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
      onClick={handleTimelineClick}
      style={{ height: totalHeight }}
    >
      {/* Resize handle — only meaningful when expanded */}
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
        {storylines.length > 0 ? (
          storylines.map((storyline) => renderStorylineRow(storyline))
        ) : (
          <div className="btl-loading">Loading storylines…</div>
        )}

        {/* Playhead — vertical accent line at the currently-editing tile.
            Sits above tracks but below sticky rails (z-index in CSS). */}
        {playheadX != null && (
          <div className="btl-playhead" style={{ left: playheadX, height: rowsAreaHeight }} />
        )}

        {/* Cross-storyline links overlay — sits above the tracks area, below
            sticky rails. */}
        {crossStorylineLinks.length > 0 &&
          storylines.length > 0 &&
          rowHeight > 0 &&
          isExpanded && (
            <svg
              className="btl-crosslinks"
              width={scrollContentWidth}
              height={rowsAreaHeight}
              style={{ width: scrollContentWidth, height: rowsAreaHeight }}
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
