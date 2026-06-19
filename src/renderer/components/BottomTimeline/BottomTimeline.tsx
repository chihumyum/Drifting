import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useMatch } from 'react-router-dom';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookNode } from '../../usecase/useBookNode';
import type { Storyline } from '../../domain/storyline';
import { CHAPTER_ORDER_STRIDE, isChapter, isDrift } from '../../domain/book-node';
import { useAuthStore } from '../../store/auth';
import { NodeHoverPreview } from '../NodeHoverPreview';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useTimelineExpandedScale } from './useTimelineExpandedScale';
import { useBottomTimelineContextMenuActions } from './useBottomTimelineContextMenuActions';
import { useBottomTimelineSelectors } from './useBottomTimelineSelectors';
import { useBottomTimelineInteractionState } from './useBottomTimelineInteractionState';
import { EntityCellContextMenu } from '../leftBars/EntityCellContextMenu';
import { useEntityCellAction } from '../../hooks/useEntityCellAction';
import { TimelinePinMenu } from '../graph/TimelinePinMenu';
import { ActRail } from './ActRail';
import { useBookAct } from '../../usecase/useBookAct';
import { events } from '../../lib/events';
import type { TimelineNode } from './types';
import { useUiStore, usePromoteCurrentTab } from '../../store/ui-store';
import { useTimelineMarkers } from '../../hooks/useTimelineMarkers';
import loglevel from 'loglevel';
import '../../../styles/bottom-timeline.css';
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
  NODE_MIN_HEIGHT: 30,
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
  onChange: (patch: {
    narrativeOrder?: number;
    label?: string;
    driftNodeId?: string | null;
  }) => void;
  onDelete: () => void;
  onDragMove: (nextPixelX: number | null) => void;
  // ---- Drift binding (see domain/timeline-marker.ts) ----
  boundDriftTitle?: string | null;
  onRequestBind?: () => void;
  onOpenDrift?: () => void;
}

// A pin bound to a drift node renders the DRIFT's title instead of its own
// label; double-click OPENS the drift's editor instead of inline-renaming,
// and the context menu offers 解绑/打开 instead of 绑定/重命名.
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
  boundDriftTitle = null,
  onRequestBind,
  onOpenDrift,
}: TimelinePinProps) {
  const isBound = Boolean(marker.driftNodeId);
  const [editing, setEditing] = useState(editOnMount && !isBound);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  // Pin head/label stays anchored to the persisted narrativeOrder during a
  // drag. A separate timeline-level overlay follows the cursor as the drop
  // indicator; on mouseup the pin "jumps" to the new slot.
  const x = xOffset + orderToPosition(marker.narrativeOrder);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      // Left button only. A right-click must fall through to onContextMenu —
      // if startDrag runs it flips the pin into is-dragging (opacity:0,
      // pointer-events:none) synchronously, so the contextmenu event then
      // resolves to whatever sits BEHIND the pin and the menu never opens.
      if (e.button !== 0) return;
      if (editing) return;
      if (snapValues.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startMouseX = e.clientX;
      const startPixel = orderToPosition(marker.narrativeOrder);
      let nearest = marker.narrativeOrder;
      // Don't enter drag state until the mouse passes a small threshold.
      // Calling onDragMove on mousedown flips the pin to is-dragging
      // (opacity:0, pointer-events:none) before any movement, which swallowed
      // plain clicks / double-clicks — so the pin felt "drag only".
      let dragging = false;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startMouseX;
        if (!dragging && Math.abs(dx) < 4) return;
        dragging = true;
        const newPixel = startPixel + dx;
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
        if (!dragging) return; // a click, not a drag — leave it for dblclick
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

  // Unbind keeps the pin captioned: an own label wins, else the drift title.
  const handleUnbind = useCallback(() => {
    onChange({
      driftNodeId: null,
      label: marker.label.trim() ? marker.label : (boundDriftTitle ?? '标记'),
    });
  }, [onChange, marker.label, boundDriftTitle]);

  const className = [
    'btl-pin',
    isDragging ? 'is-dragging' : '',
    editing ? 'is-editing' : '',
    isBound ? 'is-bound' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const displayLabel = isBound ? (boundDriftTitle || '未命名') : marker.label;

  return (
    <div
      className={className}
      style={{ left: x, height: pinHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX + 2, y: e.clientY - 2 });
      }}
    >
      <div
        ref={labelRef}
        className="btl-pin__label"
        contentEditable={editing}
        suppressContentEditableWarning
        onMouseDown={editing ? (e) => e.stopPropagation() : startDrag}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (isBound) {
            onOpenDrift?.();
            return;
          }
          if (!editing) setEditing(true);
        }}
        onBlur={(e) => {
          if (isBound) return;
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
        title={
          isBound
            ? '已绑定漂浮节点 · 双击打开'
            : editing
              ? '回车保存，留空删除'
              : '双击编辑名称'
        }
      >
        {displayLabel}
      </div>
      <div className="btl-pin__head" onMouseDown={startDrag} title="拖动调整位置" />
      {menu && (
        <TimelinePinMenu
          x={menu.x}
          y={menu.y}
          isBound={isBound}
          onOpenDrift={() => onOpenDrift?.()}
          onUnbind={handleUnbind}
          onRequestBind={() => onRequestBind?.()}
          onRename={() => setEditing(true)}
          onDelete={onDelete}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// Synthetic lane sentinels. These never hit the DB — they're virtual lanes
// for the two edge cases the storyline rendering needs to handle:
//   • DEFAULT_LANE_ID: project has zero storylines (single-lane writing mode).
//     All chapters render in one lane labelled "本书".
//   • UNAFFILIATED_LANE_ID: project has ≥ 1 storyline AND some chapters have
//     no primary storyline link ("未归属"). Default collapsed.
const DEFAULT_LANE_ID = '__default__';
const UNAFFILIATED_LANE_ID = '__unaffiliated__';

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

export function BottomTimeline() {
  const editorMatch = useMatch('/project/:projectId/editor/:nodeId');
  const storylineMatch = useMatch('/project/:projectId/editor/storyline/:storylineId');
  const nodeId = editorMatch?.params.nodeId;
  const storylineId = storylineMatch?.params.storylineId;
  const user = useAuthStore((state) => state.user);
  const { bookNodes, storylines, nodeStorylineMapping, primaryStorylineByNode } = useDataStore();
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
  const { createNode, updateNode } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const {
    removeNodeFromStoryline,
    setNodeStorylines,
  } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });

  const nodesWithStorylines = useMemo<TimelineNode[]>(() => {
    const storylineById = new Map(storylines.map((sl) => [sl.id, sl]));
    return bookNodes
      .filter(isChapter)
      .map((node) => ({
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
  // flush with the viewport edge — `BottomStatusBar` sits below it — so we
  // can't compute height from `window.innerHeight`. The bottom is fixed
  // during the drag (only the top edge moves), so capturing once is enough.
  const resizeBottomYRef = useRef(0);
  const [unplacedPopoverOpen, setUnplacedPopoverOpen] = useState(false);
  // Anchor coords for the unplaced popover. We render the popover with
  // position: fixed so it escapes the modern-skin `.app-island { overflow:
  // hidden }` that otherwise clips it against the editor island above.
  const [unplacedAnchor, setUnplacedAnchor] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  // Unaffiliated lane (chapters with no primary storyline) visibility is
  // persisted in ui-store so the toggle decision sticks across sessions —
  // users who keep the lane open shouldn't have to re-toggle it every time
  // they reopen the app.
  const unaffiliatedVisible = useUiStore((s) => s.bottomTimelineUnaffiliatedVisible);
  const setUnaffiliatedVisible = useUiStore((s) => s.setBottomTimelineUnaffiliatedVisible);
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
      const minHeight =
        TIMELINE_CONFIG.HEAD_HEIGHT +
        TIMELINE_CONFIG.FULL_BOOK_LANE_HEIGHT +
        Math.max(storylines.length, 1) *
          (TIMELINE_CONFIG.NODE_MIN_HEIGHT + TIMELINE_CONFIG.STORYLINE_GAP);
      // height = (bottom edge) − (new top edge), where the new top edge is
      // `e.clientY − grabOffset` so the originally-grabbed pixel stays under
      // the cursor.
      const next = Math.max(
        Math.max(minHeight, TIMELINE_CONFIG.MIN_HEIGHT),
        resizeBottomYRef.current - e.clientY + resizeGrabOffsetRef.current,
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

  // Helper: which storyline owns this node as its "main" row. Reads the
  // primary from the link table (via the store), falling back to the first
  // storyline in the membership list when no primary is set.
  const primaryStorylineId = useCallback(
    (node: { id: string; storylines: Storyline[] }) => {
      const declared = primaryStorylineByNode[node.id] ?? null;
      if (declared && node.storylines.some((sl) => sl.id === declared)) return declared;
      return node.storylines[0]?.id ?? null;
    },
    [primaryStorylineByNode],
  );

  const getTimelineHeight = () =>
    Math.max(TIMELINE_CONFIG.MIN_HEIGHT, customHeight ?? TIMELINE_CONFIG.DEFAULT_HEIGHT);

  const dispatchEntityAction = useEntityCellAction();
  const { handleContextMenuAction } = useBottomTimelineContextMenuActions({
    contextMenu,
    projectId,
    scrollContainerRef,
    createNode,
    setNodeStorylines,
    updateNode,
    navigateToNode,
    onCloseMenu: clearContextMenu,
    onError: (message, error) => log.error(message, error),
  });

  // Outside-click / Esc dismissal is handled inside EntityCellContextMenu
  // itself, so no separate effect is needed for the timeline cmenu state.

  // Close the unplaced popover on outside click or ESC.
  const unplacedPopoverRef = useRef<HTMLDivElement>(null);
  const unplacedBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!unplacedPopoverOpen) unplacedBtnRef.current?.blur();
  }, [unplacedPopoverOpen]);
  // Sync the fixed-position anchor to the button's viewport rect whenever the
  // popover is open. Recompute on resize so the popover follows the button if
  // the user reshapes the window while it's open.
  useEffect(() => {
    if (!unplacedPopoverOpen) {
      setUnplacedAnchor(null);
      return;
    }
    const compute = () => {
      const rect = unplacedBtnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setUnplacedAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
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
    if (rowStorylineId === DEFAULT_LANE_ID) return true; // default lane: always
    if (rowStorylineId === UNAFFILIATED_LANE_ID) {
      // Drawer drag: only 未归属 chapters belong in 未归属 — a chapter with
      // a primary storyline shouldn't escape to the orphan lane via a
      // narrative-axis placement. Axis-to-axis drags handle 未归属 via the
      // dedicated context-menu action instead.
      if (isDraggedFromDrawer) return draggedNodePrimaryStorylineId == null;
      return true;
    }
    if (!isDraggedFromDrawer) return true; // axis-to-axis drag: any row
    // Drawer drag with no primary storyline: the chapter is 未归属, so
    // there's no "main row" to constrain to. Drop is allowed on any real
    // storyline — the drop handler promotes the target to mainStoryline.
    if (draggedNodePrimaryStorylineId == null) return true;
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
      const targetIsDefault = targetStorylineId === DEFAULT_LANE_ID;
      const targetIsUnaffiliated = targetStorylineId === UNAFFILIATED_LANE_ID;
      // Drawer drag for an unaffiliated chapter: dropping on a real storyline
      // is the implicit "assign primary" gesture, so the chapter doesn't get
      // a narrativeOrder without a home. Default / unaffiliated targets keep
      // their existing semantics (no membership change).
      if (
        fromDrawer &&
        primaryStorylineId(node) == null &&
        !targetIsDefault &&
        !targetIsUnaffiliated
      ) {
        await updateNode(node.id, { mainStorylineId: targetStorylineId });
      }
      if (!fromDrawer) {
        const sourceIsSynthetic =
          sourceStorylineId === DEFAULT_LANE_ID ||
          sourceStorylineId === UNAFFILIATED_LANE_ID;

        if (targetIsDefault) {
          // Single-lane mode — no storyline membership state to track. Only
          // reorder fires below.
        } else if (targetIsUnaffiliated) {
          // Drag INTO 未归属 = demote primary (and clear other memberships per
          // the "no auto-fallback" rule). Order matters: setNodeStorylines
          // auto-pins the current primary back into the membership set, so
          // we must null the primary FIRST, otherwise the chapter snaps
          // straight back to its old storyline.
          await updateNode(node.id, { mainStorylineId: null });
          await setNodeStorylines(node.id, []);
        } else if (sourceIsSynthetic) {
          // Drag OUT of a synthetic lane onto a real storyline = promote it
          // to primary. The link repo's setPrimaryStoryline (invoked via
          // updateNode below with the mainStorylineId signal) creates the
          // link row if it's missing.
          await updateNode(node.id, { mainStorylineId: targetStorylineId });
        } else {
          // Real-storyline → real-storyline drag may re-route the node's
          // primary alongside the order update.
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
    // Synthetic lanes (本书 / 未归属) host nodes that have no real primary
    // storyline — the lane itself is the visible "primary". Skipping the
    // primary check ensures these tiles render; clip color falls back to
    // the synthetic lane's color below.
    const isSyntheticLane =
      storylineId === DEFAULT_LANE_ID || storylineId === UNAFFILIATED_LANE_ID;
    const isPrimary = isSyntheticLane || isPrimaryStorylineForNode(node, storylineId);

    if (!isPrimary) return null;

    const order = orderOf(node);
    if (order === null) return null;

    const defaultColor = '#2D4A6B';
    const clipColor = storyline?.color || defaultColor;
    const leftPosition = orderToPosition(order);
    // Mutually-exclusive status classes. waiting_review / revising are
    // visually treated as draft until the AI-review pipeline ships its own
    // affordances.
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

    const isDropDisabled = !!draggedNode && !canDropOnStoryline(storyline.id);

    return (
      <div
        key={storyline.id}
        className={`btl-row${isDropDisabled ? ' is-drop-disabled' : ''}${
          isSynthetic ? ' is-synthetic' : ''
        }`}
        onDragOver={(e) => handleNodeDragOver(e, storyline.id)}
        onDrop={(e) => handleDrop(e, storyline.id)}
        onClick={(e) => {
          e.stopPropagation();
          clearContextMenu();
        }}
        onContextMenu={(e) => {
          // Synthetic lanes don't expose the storyline-level context menu
          // (no rename / recolor / add-node-to-this-storyline operations).
          // Node-level interactions still need to work, so we plumb those
          // through but stop here for the storyline-level fallback.
          if (isSynthetic) {
            e.preventDefault();
            const container = e.currentTarget.querySelector(
              '[data-node-container]',
            ) as HTMLElement | null;
            if (!container) return;
            const rect = container.getBoundingClientRect();
            const x = e.clientX - rect.left;
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
            }
            return;
          }
          e.preventDefault();
          const container = e.currentTarget.querySelector('[data-node-container]') as HTMLElement;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const position = Math.max(
            minOrder,
            Math.round(x / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor)) + minOrder,
          );
          // Only the primary storyline's row renders a tile for a chapter, so
          // a hit at the chapter's x-position on a secondary row should fall
          // through to the storyline-level menu — not the node menu.
          const clickedNode = nodesInStoryline.find((node) => {
            if (!isPrimaryStorylineForNode(node, storyline.id)) return false;
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
            });
          }
        }}
      >
        <div
          data-track-rail
          className={`btl-rail ${isRouteActive ? 'is-active' : ''}${
            isSynthetic ? '' : ' is-clickable'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            // Real storylines: clicking the rail navigates to the storyline
            // editor tab (mirrors ChapterPanel's storyline-group click).
            // Synthetic lanes have no entity behind them, so they no-op.
            if (!isSynthetic) {
              openEntity({ entityType: 'storyline', id: storyline.id });
            }
          }}
          onDoubleClick={() => {
            if (!isSynthetic) promoteCurrentTab();
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
              : `点击打开「${storyline.name || 'Untitled Storyline'}」`
          }
          style={{ width: TIMELINE_CONFIG.RAIL_WIDTH, cursor: isSynthetic ? 'default' : 'pointer' }}
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
  // ActRail (幕) replaced FullBookLane as the book-mode top strip. Unlike
  // the old packed lane it lives INSIDE the scroll container, in track
  // coordinate space, so act bands align with the chapter columns below.
  // Always present in book mode (even with zero acts — the empty rail keeps
  // the 幕 feature discoverable and invites a first split); narrative mode
  // never shows it (acts segment bookOrder, and projecting them onto the
  // narrative axis would shred them across flashbacks).
  const actRailHeight = !isNarrative ? TIMELINE_CONFIG.FULL_BOOK_LANE_HEIGHT : 0;
  const axisHeight = isNarrative ? TIMELINE_CONFIG.AXIS_HEIGHT : 0;

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
          storyline: makeSyntheticStoryline(DEFAULT_LANE_ID, '本书', 'hsl(var(--accent))'),
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
        storyline: makeSyntheticStoryline(UNAFFILIATED_LANE_ID, '未归属', 'hsl(var(--ink-3))'),
        nodes: unaffiliatedChapters,
        synthetic: true,
      });
    }
    return real;
  }, [storylines, placedNodes, getNodesInStoryline, unaffiliatedChapters, unaffiliatedVisible]);

  const rowsAreaHeight = Math.max(
    0,
    totalHeight - TIMELINE_CONFIG.HEAD_HEIGHT - actRailHeight - axisHeight,
  );
  const rowHeight = lanesToRender.length > 0 ? rowsAreaHeight / lanesToRender.length : 0;
  // Vertical offset of the lane rows inside the scroll content: the time
  // axis (narrative) or the act rail (book) renders above them in-flow.
  const overlayTopOffset = axisHeight + actRailHeight;
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
    // Full old→new maps (not just the changed subset): the act-boundary
    // repair below needs every chapter's position to find the straddling
    // pair for each boundary.
    const oldOrderById = new Map<string, number>();
    const newOrderById = new Map<string, number>();
    const updates: Array<{ id: string; newOrder: number }> = [];
    sorted.forEach((node, i) => {
      const newOrder = startOrder + i * SPACING;
      oldOrderById.set(node.id, orderOf(node) ?? 0);
      newOrderById.set(node.id, newOrder);
      if (orderOf(node) !== newOrder) updates.push({ id: node.id, newOrder });
    });
    try {
      for (const u of updates) {
        await updateNode(u.id, { [orderField]: u.newOrder });
      }
      // Spread rewrote the bookOrder axis — remap act boundaries against the
      // same old→new mapping so each boundary keeps sitting between the same
      // two chapters. Narrative spread doesn't touch bookOrder; skip.
      if (!isNarrative && updates.length > 0) {
        await remapAfterSpread(oldOrderById, newOrderById);
      }
    } catch (err) {
      log.error('Failed to spread timeline nodes', err);
    }
  }, [placedNodes, orderOf, updateNode, orderField, isNarrative, remapAfterSpread]);

  // "+幕" head button — drops an act boundary at the chapter nearest the
  // viewport center (same center-pick as handleAddPin). The bootstrap path
  // for projects with zero acts; precise placement lives on the track
  // context menu (从此处开始新幕) and on the rail itself afterwards.
  const handleAddActSplit = useCallback(() => {
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
    void splitAtOrder(target);
  }, [snapValues, orderToPosition, splitAtOrder]);

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
    if (!isNarrative) return null;
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
    return (
      <div className="btl__head" onClick={(e) => e.stopPropagation()}>
        <div className="btl__head-left">
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
                  const base = customHeight ?? TIMELINE_CONFIG.DEFAULT_HEIGHT;
                  const adjusted = Math.max(TIMELINE_CONFIG.MIN_HEIGHT, base + delta);
                  setCustomHeight(adjusted);
                  if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, adjusted.toString());
                  }
                }
                setUnaffiliatedVisible(next);
              }}
              title={unaffiliatedVisible ? '隐藏未归属轨道' : '显示未归属轨道'}
            >
              {unaffiliatedVisible ? (
                '隐藏未归属'
              ) : (
                <>
                  显示未归属
                  <span className="btl__unaffiliated-toggle-count">
                    {unaffiliatedChapters.length}
                  </span>
                </>
              )}
            </button>
          )}
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
              {unplacedPopoverOpen && unplacedAnchor && (
                <div
                  className="btl__unplaced-popover"
                  style={{
                    position: 'fixed',
                    left: unplacedAnchor.left,
                    bottom: unplacedAnchor.bottom,
                  }}
                >
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
          {/* New-storyline action lives on the ChapterPanel subheader's primary
              create button now; the 「+幕」act-create action moved into the
              act rail's head cell (mirrors the narrative TIME ＋). The header
              keeps only the layout / navigation controls below. */}
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
          // Cursor lands somewhere within the 4px-tall handle (which itself
          // sits flush with the timeline's top border). Capture how far below
          // the top edge the grab happened so handleMouseMove can subtract it
          // and keep the grabbed point glued to the cursor. Also pin the
          // dock's bottom in viewport coords — `BottomStatusBar` sits below
          // it, so `window.innerHeight` is not the right anchor.
          const rect = timelineRef.current?.getBoundingClientRect();
          resizeGrabOffsetRef.current = rect ? e.clientY - rect.top : 0;
          resizeBottomYRef.current = rect ? rect.bottom : window.innerHeight;
          setIsResizingHeight(true);
        }}
      />

      {renderHead()}

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
        {/* Act rail (幕) — book mode, always present (empty rail when no acts).
            Lives inside the scroll container in track coordinate space so the
            bands align with the chapter columns and scroll with them. The ＋
            in its head cell is the create entry. */}
        {actRailHeight > 0 && (
          <ActRail
            acts={bookActs}
            chapters={placedNodes}
            railWidth={TIMELINE_CONFIG.RAIL_WIDTH}
            trackWidth={timelineWidth}
            height={actRailHeight}
            orderToX={orderToPosition}
            snapOrders={snapValues}
            onRenameAct={(id, name) => void updateAct(id, { name })}
            onMoveBoundary={(id, startOrder) => void moveBoundary(id, startOrder)}
            onDeleteAct={(id) => void deleteAct(id)}
            onSplitAt={(startOrder) => void splitAtOrder(startOrder)}
            onAddAct={handleAddActSplit}
            driftTitleById={(id) => driftById.get(id)?.title ?? null}
            onRequestBind={(id) =>
              events.emit('drift-bind:open', { target: { kind: 'act', id } })
            }
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

      {contextMenu?.type === 'node' && contextMenu.nodeId && (() => {
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
                  ? [{ action: 'moveToUnaffiliated', label: '转移至未归属' }]
                  : []),
                ...(isNarrative && hasNarrativeOrder
                  ? [{ action: 'detachFromNarrative', label: '回到未放置' }]
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

      {contextMenu?.type === 'storyline' && contextMenu.storylineId && !(() => {
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
                  { action: 'createChapterHere', label: '在此处新建章节' },
                  // Acts live on the bookOrder axis only — narrative-mode
                  // positions are narrativeOrder values, wrong axis.
                  ...(!isNarrative
                    ? [{ action: 'startActHere', label: '从此处开始新幕' }]
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

      <NodeHoverPreview
        node={hoveredNodeId ? (nodeById.get(hoveredNodeId) ?? null) : null}
        position={hoverPosition}
        showAbove={true}
      />
    </div>
  );
}
