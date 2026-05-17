import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useStoryline } from '../../usecase/useStoryline';
import { useBookNode } from '../../usecase/useBookNode';
import { useBookContent } from '../../usecase/useBookContent';
import { parseOutline } from '../../lib/outline';
import type { OutlineItem } from '../../domain/node-content';
import type { Storyline } from '../../domain/storyline';
import type { BookNode } from '../../domain/book-node';
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

type TimelineState = 'strip' | 'normal' | 'max';
const TIMELINE_STATE_STORAGE_KEY = 'timeline-mode';
const TIMELINE_HEIGHT_STORAGE_KEY = 'timeline-total-height';
const TIMELINE_MAX_HEIGHT_STORAGE_KEY = 'timeline-max-height';

const TIMELINE_CONFIG = {
  GRID_UNIT: 20,
  NODE_MIN_WIDTH: 40,
  NODE_DEFAULT_WIDTH: 4,
  NODE_MIN_HEIGHT: 18,
  NODE_COMPACT_HEIGHT: 6,
  STORYLINE_GAP: 2,
  STORYLINE_GAP_COMPACT: 0,
  RESIZE_HANDLE_WIDTH: 8,
  RAIL_WIDTH: 148,
  RAIL_WIDTH_STRIP: 8,
  HEAD_HEIGHT: 30,
  AXIS_HEIGHT: 22,
  MINIMAP_HEIGHT: 60,
  // Defaults already include head + axis + a comfortable rows area.
  DEFAULT_NORMAL_HEIGHT: 260,
  DEFAULT_MAX_HEIGHT: 440,
};

function readPersistedMode(): TimelineState {
  if (typeof localStorage === 'undefined') return 'normal';
  const v = localStorage.getItem(TIMELINE_STATE_STORAGE_KEY);
  if (v === 'strip' || v === 'normal' || v === 'max') return v;
  return 'normal';
}

function nextMode(current: TimelineState): TimelineState {
  return current === 'strip' ? 'normal' : current === 'normal' ? 'max' : 'strip';
}

interface RulerTick {
  left: string;
  level: number;
  isParagraph?: boolean;
}

// Compute outline ruler tick positions for a chapter clip background.
// Same hierarchy logic as the previous inline version; extracted so the
// render path stays readable.
function computeOutlineRulerPositions(outline: OutlineItem[]): RulerTick[] {
  const h1Items = outline.filter((i) => i.level === 1);
  const h2Items = outline.filter((i) => i.level === 2);
  const h3Items = outline.filter((i) => i.level === 3);
  const positions: RulerTick[] = [];

  h1Items.forEach((h1, index) => {
    const h1Start = (index / h1Items.length) * 100;
    const h1End = ((index + 1) / h1Items.length) * 100;
    positions.push({ left: `${((index + 0.5) / h1Items.length) * 100}%`, level: 1 });

    const h1Pos = outline.indexOf(h1);
    const nextH1Pos =
      index < h1Items.length - 1 ? outline.indexOf(h1Items[index + 1]) : outline.length;

    const h2InThisH1 = h2Items.filter((h2) => {
      const p = outline.indexOf(h2);
      return p > h1Pos && p < nextH1Pos;
    });

    if (h2InThisH1.length > 0) {
      h2InThisH1.forEach((h2, h2Index) => {
        const h2Start = h1Start + (h2Index / h2InThisH1.length) * (h1End - h1Start);
        const h2End = h1Start + ((h2Index + 1) / h2InThisH1.length) * (h1End - h1Start);
        positions.push({
          left: `${h1Start + ((h2Index + 0.5) / h2InThisH1.length) * (h1End - h1Start)}%`,
          level: 2,
        });

        const h2Pos = outline.indexOf(h2);
        const nextH2Pos =
          h2Index < h2InThisH1.length - 1
            ? outline.indexOf(h2InThisH1[h2Index + 1])
            : nextH1Pos;

        const h3InThisH2 = h3Items.filter((h3) => {
          const p = outline.indexOf(h3);
          return p > h2Pos && p < nextH2Pos;
        });

        if (h3InThisH2.length > 0) {
          h3InThisH2.forEach((h3, h3Index) => {
            const h3Start = h2Start + (h3Index / h3InThisH2.length) * (h2End - h2Start);
            const h3End = h2Start + ((h3Index + 1) / h3InThisH2.length) * (h2End - h2Start);
            positions.push({
              left: `${h2Start + ((h3Index + 0.5) / h3InThisH2.length) * (h2End - h2Start)}%`,
              level: 3,
            });
            const pCount = h3.paragraphsAfter || 0;
            for (let p = 0; p < pCount; p++) {
              positions.push({
                left: `${h3Start + ((p + 1) / (pCount + 1)) * (h3End - h3Start)}%`,
                level: 3,
                isParagraph: true,
              });
            }
          });
        } else {
          const pCount = h2.paragraphsAfter || 0;
          for (let p = 0; p < pCount; p++) {
            positions.push({
              left: `${h2Start + ((p + 1) / (pCount + 1)) * (h2End - h2Start)}%`,
              level: 2,
              isParagraph: true,
            });
          }
        }
      });
    } else {
      const pCount = h1.paragraphsAfter || 0;
      for (let p = 0; p < pCount; p++) {
        positions.push({
          left: `${h1Start + ((p + 1) / (pCount + 1)) * (h1End - h1Start)}%`,
          level: 1,
          isParagraph: true,
        });
      }
    }
  });
  return positions;
}

interface TimelinePinProps {
  marker: import('../../domain/timeline-marker').TimelineMarker;
  snapStarts: number[];
  startToPosition: (start: number) => number;
  // x-offset added before each pin's start-derived x (the rail width
  // so pins line up with the chapter tracks, not the rail).
  xOffset: number;
  // Live display start — equals marker.start at rest, the tentative snap
  // target during drag. Lifted to parent so the per-track vertical line
  // can track the drag in lockstep.
  displayStart: number;
  // True while the user is actively dragging this pin; lets us style the
  // head/label with the accent color while the per-track line does the
  // same (separate element, but same state).
  isDragging: boolean;
  pinHeight: number;
  editOnMount?: boolean;
  onChange: (patch: { start?: number; label?: string }) => void;
  onDelete: () => void;
  // Report drag start/move (number) and drag end (null) so the parent
  // can update its lifted drag map.
  onDragMove: (nextStart: number | null) => void;
}

// One draggable pin head (label + triangle). The pin's vertical line is
// rendered separately, INSIDE each storyline track, so it paints behind
// the chapter clips. Drag the head/label horizontally to snap to the
// nearest valid start; double-click the label to rename; clearing the
// label saves as delete.
function TimelinePin({
  marker,
  snapStarts,
  startToPosition,
  xOffset,
  displayStart,
  isDragging,
  pinHeight,
  editOnMount = false,
  onChange,
  onDelete,
  onDragMove,
}: TimelinePinProps) {
  const [editing, setEditing] = useState(editOnMount);
  const labelRef = useRef<HTMLDivElement>(null);

  const x = xOffset + startToPosition(displayStart);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return;
      if (snapStarts.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startMouseX = e.clientX;
      const startPixel = startToPosition(marker.start);
      let nearest = marker.start;
      const onMove = (ev: MouseEvent) => {
        const newPixel = startPixel + (ev.clientX - startMouseX);
        let best = snapStarts[0];
        let bestDist = Infinity;
        for (const s of snapStarts) {
          const d = Math.abs(startToPosition(s) - newPixel);
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
        if (nearest !== marker.start) onChange({ start: nearest });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, snapStarts, marker.start, startToPosition, onChange, onDragMove],
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

  const className = [
    'btl-pin',
    isDragging ? 'is-dragging' : '',
    editing ? 'is-editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={{ left: x, height: pinHeight }}>
      {/* Label sits at the top (in the axis row); editable on click */}
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
      {/* Down-pointing triangle below the label, exactly at the pin's x.
          The pin's grid line is NOT here — it's rendered inside each track
          (so it paints behind the chapter clips). */}
      <div className="btl-pin__head" onMouseDown={startDrag} title="拖动调整位置" />
    </div>
  );
}

export function BottomTimeline() {
  const { storylineId, nodeId } = useParams<{ storylineId?: string; nodeId?: string }>();
  const user = useAuthStore((state) => state.user);
  const { bookNodes, storylines, nodeStorylineMapping } = useDataStore();
  const setNodeSelection = useUiStore((state) => state.setNodeSelection);
  const readingProgress = useUiStore((state) => state.readingProgress);
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
  const { getOutlineByNodeId } = useBookContent({
    userId: user?.id ?? '',
    projectId: projectId ?? '',
  });
  const activeSelectedNodeId = nodeId;

  // Drag-time overrides for `start`; cleared automatically when the store
  // update flows back (see useMemo below). Resize uses setStartOverrides to
  // preview without mutating the store mid-drag.
  const [startOverrides, setStartOverrides] = useState<Map<string, number>>(new Map());

  // Node↔storyline relationships derived from the store; the mapping is
  // pre-loaded once at app boot (App.tsx -> loadNodeStorylineMapping).
  const nodesWithStorylines = useMemo<TimelineNode[]>(() => {
    const storylineById = new Map(storylines.map((sl) => [sl.id, sl]));
    return bookNodes.map((node) => ({
      ...node,
      start: startOverrides.get(node.id) ?? node.start,
      storylines: (nodeStorylineMapping[node.id] || [])
        .map((slId) => storylineById.get(slId))
        .filter((sl): sl is Storyline => Boolean(sl)),
    }));
  }, [bookNodes, nodeStorylineMapping, storylines, startOverrides]);

  const [nodeOutlines, setNodeOutlines] = useState<Map<string, OutlineItem[]>>(new Map());

  const [timelineMode, setTimelineMode] = useState<TimelineState>(readPersistedMode);
  const [isResizingHeight, setIsResizingHeight] = useState(false);
  const [customNormalHeight, setCustomNormalHeight] = useState<number | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    return v ? parseInt(v, 10) : null;
  });
  const [customMaxHeight, setCustomMaxHeight] = useState<number | null>(() => {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(TIMELINE_MAX_HEIGHT_STORAGE_KEY);
    return v ? parseInt(v, 10) : null;
  });

  const isExpanded = timelineMode !== 'strip';

  useEffect(() => {
    localStorage.setItem(TIMELINE_STATE_STORAGE_KEY, timelineMode);
  }, [timelineMode]);

  // Load outlines for all nodes
  useEffect(() => {
    async function loadOutlines() {
      try {
        const outlinesMap = new Map<string, OutlineItem[]>();

        for (const node of nodesWithStorylines) {
          const outlineJson = await getOutlineByNodeId(node.id);
          if (outlineJson) {
            try {
              const outline = parseOutline(outlineJson);
              outlinesMap.set(node.id, outline);
            } catch (error) {
              log.error(`Failed to parse outline for node ${node.id}:`, error);
            }
          }
        }

        setNodeOutlines(outlinesMap);
      } catch (error) {
        log.error('Failed to load outlines:', error);
      }
    }

    if (nodesWithStorylines.length > 0) {
      loadOutlines();
    }
  }, [nodesWithStorylines, getOutlineByNodeId]);

  const {
    draggedNode,
    dragOverPosition,
    contextMenu,
    hoveredEdge,
    hoveredNodeId,
    hoverPosition,
    resizingNode,
    setDraggedNode,
    setDragOverPosition,
    clearDragState,
    setContextMenu,
    clearContextMenu,
    setHoveredEdge,
    setHoverPreview,
    clearHoverPreview,
    setResizingNode,
    clearResizingNode,
  } = useBottomTimelineInteractionState();

  // 节点宽度（以 grid 单位计）- 使用 Map 存储每个节点的 end 值
  const [nodeEnds, setNodeEnds] = useState<Map<string, number | null>>(new Map());

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

  // Cmd+J cycles strip → normal → max → strip
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setTimelineMode((prev) => nextMode(prev));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Drag-resize top edge to change total dock height (mode-specific)
  useEffect(() => {
    if (!isResizingHeight) return;
    const setter = timelineMode === 'max' ? setCustomMaxHeight : setCustomNormalHeight;
    const storageKey =
      timelineMode === 'max' ? TIMELINE_MAX_HEIGHT_STORAGE_KEY : TIMELINE_HEIGHT_STORAGE_KEY;
    let lastValue: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      const windowHeight = window.innerHeight;
      const minHeight =
        TIMELINE_CONFIG.HEAD_HEIGHT +
        TIMELINE_CONFIG.AXIS_HEIGHT +
        (timelineMode === 'max' ? TIMELINE_CONFIG.MINIMAP_HEIGHT : 0) +
        Math.max(storylines.length, 1) * (TIMELINE_CONFIG.NODE_MIN_HEIGHT + TIMELINE_CONFIG.STORYLINE_GAP);
      const next = Math.max(minHeight, windowHeight - e.clientY);
      lastValue = next;
      setter(next);
    };

    const handleMouseUp = () => {
      setIsResizingHeight(false);
      if (lastValue !== null) {
        localStorage.setItem(storageKey, lastValue.toString());
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingHeight, timelineMode, storylines.length]);

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
    minStart,
    maxEnd,
    scaleFactor,
    timelineWidth,
    getNodeWidth,
    startToPosition,
  } = useBottomTimelineSelectors({
    nodesWithStorylines,
    storylines,
    nodeEnds,
    isExpanded,
    expandedScale,
    gridUnit: TIMELINE_CONFIG.GRID_UNIT,
    nodeMinWidth: TIMELINE_CONFIG.NODE_MIN_WIDTH,
    nodeDefaultWidth: TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
  });

  // Total dock height per mode
  const getTimelineHeight = () => {
    if (storylines.length === 0) return TIMELINE_CONFIG.HEAD_HEIGHT + 40;

    if (timelineMode === 'strip') {
      // header + tiny color bars (one per storyline)
      return (
        TIMELINE_CONFIG.HEAD_HEIGHT +
        Math.max(20, storylines.length * (TIMELINE_CONFIG.NODE_COMPACT_HEIGHT + 1))
      );
    }
    if (timelineMode === 'max') {
      return customMaxHeight ?? TIMELINE_CONFIG.DEFAULT_MAX_HEIGHT;
    }
    return customNormalHeight ?? TIMELINE_CONFIG.DEFAULT_NORMAL_HEIGHT;
  };

  // 计算 Context Menu 的位置，防止溢出视口
  const getContextMenuPosition = (x: number, y: number, menuWidth: number, menuHeight: number) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8; // 距离视口边缘的最小距离

    let adjustedX = x;
    let adjustedY = y;

    // 检查右侧溢出
    if (x + menuWidth + padding > viewportWidth) {
      adjustedX = Math.max(padding, x - menuWidth);
    }

    // 检查底部溢出
    if (y + menuHeight + padding > viewportHeight) {
      adjustedY = Math.max(padding, viewportHeight - menuHeight - padding);
    }

    // 检查左侧溢出
    if (adjustedX < padding) {
      adjustedX = padding;
    }

    // 检查顶部溢出
    if (adjustedY < padding) {
      adjustedY = padding;
    }

    return { x: adjustedX, y: adjustedY };
  };

  const { handleContextMenuAction } = useBottomTimelineContextMenuActions({
    contextMenu,
    projectId,
    currentRouteNodeId: nodeId,
    nodesWithStorylines,
    scrollContainerRef,
    nodeDefaultWidth: TIMELINE_CONFIG.NODE_DEFAULT_WIDTH,
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

  // 点击其他地方关闭 context menu
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

  // Handle drag start
  const handleNodeDragStart = (e: React.DragEvent, node: TimelineNode, storylineId: string) => {
    clearHoverPreview();
    setHoveredEdge(null);
    setDraggedNode({ node, storylineId });
    e.dataTransfer.effectAllowed = 'move';
  };

  // Handle drag over - 计算应该放在哪个 start 位置
  const handleNodeDragOver = (e: React.DragEvent, storylineId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedNode) return;

    // 获取节点容器的位置
    const container = (e.currentTarget as HTMLElement).querySelector(
      '[data-node-container]',
    ) as HTMLElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left; // 鼠标相对于节点容器的位置

    // 从鼠标位置（节点中心）反推节点左边缘的位置
    const nodeWidth = getNodeWidth(draggedNode.node.id);
    const nodeLeftX = mouseX - nodeWidth / 2;
    // 考虑缩放和偏移：将像素位置转换回 start 值
    const start = Math.max(
      minStart,
      Math.round(nodeLeftX / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor)) + minStart,
    );

    setDragOverPosition({ storylineId, start, x: mouseX });
  };

  // Handle drop
  const handleDrop = async (e: React.DragEvent, targetStorylineId: string) => {
    e.preventDefault();
    clearHoverPreview();
    setHoveredEdge(null);
    if (!draggedNode || !dragOverPosition) return;

    const { node, storylineId: sourceStorylineId } = draggedNode;
    const targetStart = dragOverPosition.start;

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
        // old main (otherwise removeNodeFromStoryline would reject the unlink).
        await updateNode(node.id, { mainStorylineId: targetStorylineId });
        if (!isTargetInNodeStorylines) {
          // Source was the old main and isn't supposed to remain as a secondary
          // membership; unlink it now that the node's main has moved.
          await removeNodeFromStoryline(node.id, sourceStorylineId);
        }
      }

      if (targetStart !== node.start) {
        const currentEnd = nodeEnds.get(node.id) ?? node.end;
        const width =
          currentEnd !== null ? currentEnd - node.start : TIMELINE_CONFIG.NODE_DEFAULT_WIDTH;
        const newEnd = targetStart + width;

        await updateNode(node.id, { start: targetStart, end: newEnd });
      }
    } catch (error) {
      log.error('Failed to handle drop:', error);
    } finally {
      clearHoverPreview();
      setHoveredEdge(null);
      clearDragState();
    }
  };

  const handleDragEnd = () => {
    clearHoverPreview();
    setHoveredEdge(null);
    clearDragState();
  };

  // Handle resize start
  const handleNodeResizeStart = (
    e: React.MouseEvent,
    nodeId: string,
    storylineId: string,
    edge: 'left' | 'right',
  ) => {
    e.stopPropagation();
    e.preventDefault();

    const node = nodesWithStorylines.find((n) => n.id === nodeId);
    if (!node) return;

    const end = nodeEnds.get(nodeId) ?? node.end ?? node.start + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH;

    setResizingNode({
      nodeId,
      storylineId,
      edge,
      startX: e.clientX,
      startStart: node.start,
      startEnd: end,
    });
  };

  // Handle resize move - 添加到 document 上的监听
  useEffect(() => {
    let lastUpdateTime = 0;
    const UPDATE_THROTTLE = 16; // ~60fps

    const handleResizeMove = (e: MouseEvent) => {
      if (!resizingNode || !timelineRef.current) return;

      // 节流优化 - 限制更新频率
      const now = Date.now();
      if (now - lastUpdateTime < UPDATE_THROTTLE) return;
      lastUpdateTime = now;

      const deltaX = e.clientX - resizingNode.startX;
      const deltaGridUnits = Math.round(deltaX / TIMELINE_CONFIG.GRID_UNIT);

      if (resizingNode.edge === 'right') {
        // 调整右侧 - 只改变 end，start 保持不变
        const newEnd = Math.max(
          resizingNode.startStart + 1,
          (resizingNode.startEnd ?? resizingNode.startStart + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH) +
            deltaGridUnits,
        );
        setNodeEnds((prev) => {
          const next = new Map(prev);
          next.set(resizingNode.nodeId, newEnd);
          return next;
        });
      } else {
        // 调整左侧 - 只改变 start，end 保持不变
        const newStart = Math.max(1, resizingNode.startStart + deltaGridUnits);
        const originalEnd =
          resizingNode.startEnd ?? resizingNode.startStart + TIMELINE_CONFIG.NODE_DEFAULT_WIDTH;

        // 确保 start 不会超过 end
        const validStart = Math.min(newStart, originalEnd - 1);

        // 只更新节点位置，end 保持不变
        setStartOverrides((prev) => {
          const next = new Map(prev);
          next.set(resizingNode.nodeId, validStart);
          return next;
        });
      }
    };

    const handleNodeResizeEnd = async () => {
      if (resizingNode) {
        const node = nodesWithStorylines.find((n) => n.id === resizingNode.nodeId);
        if (!node) {
          clearResizingNode();
          return;
        }

        // 获取当前的 end
        const currentEnd = nodeEnds.get(resizingNode.nodeId) ?? node.end;

        // 准备更新数据
        const updates: Partial<BookNode> = {};

        // 如果 start 变化了，更新它
        if (node.start !== resizingNode.startStart) {
          updates.start = node.start;
        }

        // 如果 end 变化了，更新它
        if (currentEnd !== resizingNode.startEnd && currentEnd !== null) {
          updates.end = currentEnd;
        }

        // 如果有任何更新，写入数据库
        if (Object.keys(updates).length > 0) {
          await updateNode(resizingNode.nodeId, updates);
        }

        // 清理本次 drag 的临时覆盖（store 更新会把 node.start 同步到目标值）
        setStartOverrides((prev) => {
          if (!prev.has(resizingNode.nodeId)) return prev;
          const next = new Map(prev);
          next.delete(resizingNode.nodeId);
          return next;
        });

        // 保存滚动位置
        const scrollContainer = scrollContainerRef.current;
        const savedScrollLeft = scrollContainer?.scrollLeft || 0;

        // 恢复滚动位置
        if (scrollContainer) {
          requestAnimationFrame(() => {
            scrollContainer.scrollLeft = savedScrollLeft;
          });
        }

        clearResizingNode();
      }
    };

    if (resizingNode) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleNodeResizeEnd);

      return () => {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleNodeResizeEnd);
      };
    }
  }, [resizingNode, nodesWithStorylines, nodeEnds, updateNode, clearResizingNode]);

  // Handle node click
  const handleNodeClick = (clickedNodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    clearContextMenu();
    setNodeSelection(clickedNodeId, 'ui');
  };

  // 悬停预览事件处理
  const handleNodeMouseEnter = (node: TimelineNode, e: React.MouseEvent) => {
    if (draggedNode) return;

    const rect = e.currentTarget.getBoundingClientRect();
    setHoverPreview({
      nodeId: node.id,
      position: {
        x: rect.left + rect.width / 2,
        y: rect.top - 8, // 显示在上方
      },
    });
  };

  const handleNodeMouseLeave = () => {
    clearHoverPreview();
  };

  // Handle timeline background click — only dismiss menus, never navigate.
  // Left-click navigation on the timeline was removed by user request: the
  // timeline is for viewing/editing structure, not routing.
  const handleTimelineClick = () => {
    clearContextMenu();
  };

  // 判断一个 node 是否应该在当前 storyline 上作为"主显示"
  // 规则：在 node.mainStorylineId 上完整显示，其他 storylines 上只画 trail
  const isPrimaryStorylineForNode = (node: TimelineNode, storylineId: string): boolean => {
    const fallbackPrimaryId = node.storylines[0]?.id;
    const primaryId = node.storylines.some((sl) => sl.id === node.mainStorylineId)
      ? node.mainStorylineId
      : fallbackPrimaryId;
    return primaryId === storylineId;
  };

  // Storyline index lookup (row order on screen)
  const storylineRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    storylines.forEach((s, idx) => map.set(s.id, idx));
    return map;
  }, [storylines]);

  // Pre-sorted node list per storyline (ascending by start), used to find
  // the "next node by start order" on each non-main storyline.
  const sortedNodesByStoryline = useMemo(() => {
    const m = new Map<string, TimelineNode[]>();
    storylines.forEach((s) => m.set(s.id, []));
    nodesWithStorylines.forEach((node) => {
      node.storylines.forEach((sl) => {
        const arr = m.get(sl.id);
        if (arr) arr.push(node);
      });
    });
    m.forEach((arr) => arr.sort((a, b) => a.start - b.start));
    return m;
  }, [nodesWithStorylines, storylines]);

  // No default background grid — the only grid lines on the timeline are
  // the vertical lines drawn by user-added time pins. Adding/removing a
  // pin adds/removes a divider; the grid is whatever the user defines.

  // Cross-storyline link paths: for each node N that belongs to multiple
  // storylines (main = M, secondary = S₁…Sₖ), draw curves that visualise
  // N's role as a transit point on every secondary storyline.
  // For each secondary storyline S:
  //   prev (on S row)  →  N (on M row, where the tile lives)
  //   N (on M row)     →  next (on S row)
  // If prev/next is missing (N is first/last on S), that half is omitted.
  // We compute adjacency from N's index in the start-sorted lane on S
  // rather than start comparisons so ties are handled deterministically.
  const crossStorylineLinks = useMemo(() => {
    if (timelineMode === 'strip') return [];

    type Link = {
      key: string;
      fromX: number;
      fromY: number; // row index
      toX: number;
      toY: number; // row index
      color: string;
      // endpoint marker rules: only mark the secondary-row end. The other
      // end lands on the tile, which is its own visual anchor.
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

      const nodeMidX = startToPosition(node.start) + getNodeWidth(node.id) / 2;

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
          const prevMidX = startToPosition(prev.start) + getNodeWidth(prev.id) / 2;
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
          const nextMidX = startToPosition(next.start) + getNodeWidth(next.id) / 2;
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
    startToPosition,
    getNodeWidth,
    timelineMode,
  ]);

  // Render a single node card
  const renderNodeCard = (node: TimelineNode, storylineId: string) => {
    const storyline = storylineById.get(storylineId);
    const isSelected = activeSelectedNodeId === node.id;
    const isPrimary = isPrimaryStorylineForNode(node, storylineId);

    // Multi-storyline nodes only show their tile on the main storyline.
    // On every other storyline they belong to, the cross-storyline trails
    // (prev→node, node→next) represent the node's transit instead.
    if (!isPrimary) return null;

    const defaultColor = '#2D4A6B'; // matches --story-2; hex form needed for `${color}xx` alpha concatenation
    const clipColor = storyline?.color || defaultColor;

    // startToPosition 已经处理了 minStart 偏移和缩放
    const leftPosition = startToPosition(node.start);
    const nodeWidth = getNodeWidth(node.id);

    const edgeHover = hoveredEdge?.nodeId === node.id ? hoveredEdge.edge : null;
    const isDraft = node.wordCount === 0;

    const handleMouseMove = (e: React.MouseEvent) => {
      if (draggedNode) {
        clearHoverPreview();
        setHoveredEdge(null);
        return;
      }
      if (isExpanded) {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const edgeWidth = TIMELINE_CONFIG.RESIZE_HANDLE_WIDTH;
        if (x <= edgeWidth) setHoveredEdge({ nodeId: node.id, edge: 'left' });
        else if (x >= nodeWidth - edgeWidth) setHoveredEdge({ nodeId: node.id, edge: 'right' });
        else setHoveredEdge(null);
      }
      if (!edgeHover && hoveredNodeId !== node.id) {
        handleNodeMouseEnter(node, e);
      }
    };

    const outline = nodeOutlines.get(node.id);
    const rulerPositions =
      timelineMode !== 'strip' && outline && outline.length > 0
        ? computeOutlineRulerPositions(outline)
        : null;
    const tickColor = isDraft ? clipColor : 'hsl(var(--paper))';
    const paragraphTickColor = isDraft
      ? 'hsl(var(--ink-4) / 0.55)'
      : 'hsl(var(--paper) / 0.5)';

    const className = [
      'btl-clip',
      isSelected ? 'is-selected' : '',
      isDraft ? 'is-draft' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        key={`${node.id}-${storylineId}`}
        data-node-card
        className={className}
        draggable={!edgeHover && isPrimary && isExpanded}
        onDragStart={(e) => isExpanded && handleNodeDragStart(e, node, storylineId)}
        onDragEnd={handleDragEnd}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setHoveredEdge(null);
          handleNodeMouseLeave();
        }}
        onMouseDown={(e) => {
          if (edgeHover && isExpanded) {
            handleNodeResizeStart(e, node.id, storylineId, edgeHover);
          }
        }}
        onClick={(e) => {
          if (!edgeHover) handleNodeClick(node.id, e);
        }}
        style={
          {
            left: leftPosition,
            width: nodeWidth,
            cursor: edgeHover ? 'ew-resize' : isPrimary && isExpanded ? 'grab' : 'pointer',
            ['--clip-color' as string]: clipColor,
          } as React.CSSProperties
        }
      >
        {/* Outline ruler ticks at the bottom — readable on both filled and draft clips */}
        {rulerPositions && (
          <div className="btl-clip__ruler">
            {rulerPositions.map((pos, idx) => (
              <div
                key={idx}
                className="btl-clip__tick"
                style={{
                  left: pos.left,
                  width: pos.isParagraph ? 0.5 : 1,
                  height: pos.isParagraph ? 4 : pos.level === 1 ? 8 : pos.level === 2 ? 6 : 4,
                  background: pos.isParagraph ? paragraphTickColor : tickColor,
                  opacity: pos.isParagraph ? 0.6 : 0.85,
                }}
              />
            ))}
          </div>
        )}

        {timelineMode !== 'strip' && (
          <div className="btl-clip__content">
            <div className="btl-clip__num">§ {String(node.start).padStart(2, '0')}</div>
            <div className="btl-clip__title">{node.title || '未命名'}</div>
            {timelineMode === 'max' && node.summary && (
              <div className="btl-clip__summary">{node.summary}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Render a single storyline row using absolute positioning
  const renderStorylineRow = (storyline: Storyline) => {
    const nodesInStoryline = getNodesInStoryline(storyline.id);
    const isRouteActive = storylineId === storyline.id;
    const railColor = storyline.color || 'hsl(var(--story-4))';

    // 检查选中的节点是否属于当前 storyline
    const selectedNode = activeSelectedNodeId ? (nodeById.get(activeSelectedNodeId) ?? null) : null;
    const selectedNodeBelongsToStoryline =
      selectedNode?.storylines.some((t) => t.id === storyline.id) ?? false;

    // Tracks render on a near-white page color in normal/max, matching the
    // design's clean grid look. Strip mode stays transparent so the dock
    // bg shows through.
    const trackBg = timelineMode === 'strip' ? 'transparent' : 'hsl(var(--page))';

    return (
      <div
        key={storyline.id}
        className="btl-row"
        onDragOver={(e) => isExpanded && handleNodeDragOver(e, storyline.id)}
        onDrop={(e) => isExpanded && handleDrop(e, storyline.id)}
        onClick={(e) => {
          // Left-click on a storyline row does NOT navigate. Clip clicks still
          // navigate to the node (handled in renderNodeCard).
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
            minStart,
            Math.round(x / (TIMELINE_CONFIG.GRID_UNIT * scaleFactor)) + minStart,
          );
          const clickedNode = nodesInStoryline.find((node) => {
            const nl = startToPosition(node.start);
            return x >= nl && x <= nl + getNodeWidth(node.id);
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
        {/* Rail — sticky left, shows storyline identity (no nav on click) */}
        <div
          data-track-rail
          className={`btl-rail ${isRouteActive ? 'is-active' : ''}`}
          onClick={(e) => e.stopPropagation()}
          title={storyline.name || 'Untitled Storyline'}
          style={{
            width:
              timelineMode === 'strip'
                ? TIMELINE_CONFIG.RAIL_WIDTH_STRIP
                : TIMELINE_CONFIG.RAIL_WIDTH,
            gap: timelineMode === 'strip' ? 0 : 9,
            paddingLeft: timelineMode === 'strip' ? 0 : 16,
            paddingRight: timelineMode === 'strip' ? 0 : 10,
          }}
        >
          <span aria-hidden className="btl-rail__stripe" style={{ background: railColor }} />
          {timelineMode !== 'strip' && (
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

        {/* Track — absolute-positioned grid lines (behind) + clips (in front) */}
        <div
          data-node-container
          className="btl-track"
          style={{ background: trackBg, minWidth: timelineWidth }}
        >
          {/* Time-pin grid lines — one per marker, rendered BEFORE clips
              so the chapter tiles paint on top. Position tracks the lifted
              drag state so the line follows the pin head/label live. */}
          {timelineMode !== 'strip' &&
            markers.map((m) => {
              const isDragging = pinDragStarts.has(m.id);
              const displayStart = getPinDisplayStart(m.id, m.start);
              return (
                <div
                  key={`pinline-${m.id}`}
                  className={`btl-pin-line${isDragging ? ' is-dragging' : ''}`}
                  style={{ left: startToPosition(displayStart) }}
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
          {nodesInStoryline.length === 0 && !draggedNode && timelineMode !== 'strip' && (
            <div className="btl-empty">No chapters in this storyline</div>
          )}
        </div>
      </div>
    );
  };

  // ---- Layout math for SVG overlay ----
  const totalHeight = getTimelineHeight();
  const minimapHeight =
    timelineMode === 'max' && storylines.length > 0 ? TIMELINE_CONFIG.MINIMAP_HEIGHT : 0;
  const axisHeight =
    timelineMode !== 'strip' && storylines.length > 0 ? TIMELINE_CONFIG.AXIS_HEIGHT : 0;
  const rowsAreaHeight = Math.max(
    0,
    totalHeight - TIMELINE_CONFIG.HEAD_HEIGHT - minimapHeight - axisHeight,
  );
  const rowHeight = storylines.length > 0 ? rowsAreaHeight / storylines.length : 0;

  // SVG overlay sits inside the scroll container which now has the axis
  // row as a sibling; offset Y so the overlay aligns with the rows area.
  const overlayTopOffset = axisHeight;
  const rowCenterY = (idx: number) => overlayTopOffset + idx * rowHeight + rowHeight / 2;
  const scrollContentWidth = TIMELINE_CONFIG.RAIL_WIDTH + timelineWidth;
  const railOffset = timelineMode === 'strip'
    ? TIMELINE_CONFIG.RAIL_WIDTH_STRIP
    : TIMELINE_CONFIG.RAIL_WIDTH;

  const renderMinimap = () => {
    if (timelineMode !== 'max' || storylines.length === 0) return null;
    const totalWidth = timelineWidth || 1;
    const activeNode = activeSelectedNodeId ? nodeById.get(activeSelectedNodeId) ?? null : null;
    const playheadPct =
      activeNode != null
        ? ((startToPosition(activeNode.start) + getNodeWidth(activeNode.id) / 2) / totalWidth) * 100
        : null;

    return (
      <div className="btl-minimap" aria-hidden>
        {storylines.map((s) => {
          const lane = sortedNodesByStoryline.get(s.id) ?? [];
          const color = s.color || 'hsl(var(--story-4))';
          return (
            <div key={s.id} className="btl-minimap__lane">
              {lane.map((n) => {
                const left = (startToPosition(n.start) / totalWidth) * 100;
                const w = Math.max(0.4, (getNodeWidth(n.id) / totalWidth) * 100);
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

  // Pin snap positions — every integer in the visible timeline range.
  // Using just node.start values gives only a handful of drop targets
  // (one per chapter); since `start` is an integer-unit grid (1 unit =
  // 20px at scale 1), enumerating every integer in [minStart, maxEnd]
  // gives smooth, predictable drag without sub-pixel placement.
  const snapStarts = useMemo(() => {
    if (nodesWithStorylines.length === 0) return [];
    const lo = Math.floor(minStart);
    const hi = Math.ceil(maxEnd);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [nodesWithStorylines, minStart, maxEnd]);

  // Track of newly-added marker id so it opens in edit mode on mount.
  const [newlyAddedMarkerId, setNewlyAddedMarkerId] = useState<string | null>(null);

  // Lifted drag state for time pins: TimelinePin reports its tentative
  // start during drag, and the per-track vertical line reads it so the
  // line and the head/label stay aligned through the drag.
  const [pinDragStarts, setPinDragStarts] = useState<Map<string, number>>(new Map());
  const handlePinDragMove = useCallback((id: string, nextStart: number | null) => {
    setPinDragStarts((prev) => {
      const next = new Map(prev);
      if (nextStart === null) next.delete(id);
      else next.set(id, nextStart);
      return next;
    });
  }, []);
  const getPinDisplayStart = (markerId: string, persistedStart: number) =>
    pinDragStarts.get(markerId) ?? persistedStart;

  const handleAddPin = useCallback(() => {
    if (snapStarts.length === 0) return;
    // Default placement: the start nearest to the current scroll-viewport center
    const container = scrollContainerRef.current;
    let target = snapStarts[0];
    if (container) {
      const centerX =
        container.scrollLeft + container.clientWidth / 2 - TIMELINE_CONFIG.RAIL_WIDTH;
      let bestDist = Infinity;
      for (const s of snapStarts) {
        const d = Math.abs(startToPosition(s) - centerX);
        if (d < bestDist) {
          bestDist = d;
          target = s;
        }
      }
    }
    const created = addMarker(target, '标记');
    if (created) setNewlyAddedMarkerId(created.id);
  }, [snapStarts, addMarker, startToPosition]);

  const renderTimeAxis = () => {
    if (timelineMode === 'strip' || storylines.length === 0) return null;
    return (
      <div className="btl-axis">
        <div
          className="btl-axis__rail"
          style={{ width: TIMELINE_CONFIG.RAIL_WIDTH }}
          title="时间标记：点击 + 添加可拖动的时间 pin"
        >
          <span>Time</span>
          <button
            type="button"
            className="btl-axis__rail-add"
            title={snapStarts.length === 0 ? '需要至少一个章节才能添加 pin' : '添加时间 pin'}
            disabled={snapStarts.length === 0}
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
        </div>
        <div className="btl__head-right">
          <button
            className="btl__head-btn"
            title="定位到当前章节"
            onClick={() => {
              const activeNode = activeSelectedNodeId
                ? nodeById.get(activeSelectedNodeId) ?? null
                : null;
              if (!activeNode || !scrollContainerRef.current) return;
              const left =
                TIMELINE_CONFIG.RAIL_WIDTH +
                startToPosition(activeNode.start) -
                scrollContainerRef.current.clientWidth / 2 +
                getNodeWidth(activeNode.id) / 2;
              scrollContainerRef.current.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="3" />
              <line x1="8" y1="1" x2="8" y2="4" />
              <line x1="8" y1="12" x2="8" y2="15" />
              <line x1="1" y1="8" x2="4" y2="8" />
              <line x1="12" y1="8" x2="15" y2="8" />
            </svg>
          </button>
          <div className="btl__state-toggle" title="时间线状态 (⌘J)">
            <button
              className={timelineMode === 'strip' ? 'is-active' : ''}
              onClick={() => setTimelineMode('strip')}
              title="色带"
            >
              ▬
            </button>
            <button
              className={timelineMode === 'normal' ? 'is-active' : ''}
              onClick={() => setTimelineMode('normal')}
              title="轨道"
            >
              ≡
            </button>
            <button
              className={timelineMode === 'max' ? 'is-active' : ''}
              onClick={() => setTimelineMode('max')}
              title="最大化"
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
      {/* Resize handle — only meaningful in normal/max (strip is auto-sized) */}
      {timelineMode !== 'strip' && (
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
        {renderTimeAxis()}

        {storylines.length > 0 ? (
          storylines.map((storyline) => renderStorylineRow(storyline))
        ) : (
          <div className="btl-loading">Loading storylines…</div>
        )}

        {/* Time pin heads (label + triangle). The grid line is rendered
            inside each storyline track so it paints below clips; this
            overlay only carries the interactive head/label. */}
        {timelineMode !== 'strip' &&
          storylines.length > 0 &&
          markers.map((m) => (
            <TimelinePin
              key={`pin-${m.id}`}
              marker={m}
              snapStarts={snapStarts}
              startToPosition={startToPosition}
              xOffset={railOffset}
              displayStart={getPinDisplayStart(m.id, m.start)}
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
              onDragMove={(nextStart) => handlePinDragMove(m.id, nextStart)}
            />
          ))}

        {/* Playhead — anchored to whichever node the user is currently
            viewing/editing. Prefers live reading-progress (set by
            NodeEditorView on scroll); falls back to the route node at
            percent=0 so the playhead is still visible the moment a
            chapter is opened. */}
        {(() => {
          if (storylines.length === 0) return null;
          const targetId = readingProgress?.nodeId ?? activeSelectedNodeId ?? null;
          if (!targetId) return null;
          const node = nodesWithStorylines.find((n) => n.id === targetId);
          if (!node) return null;
          const percent = readingProgress?.nodeId === node.id ? readingProgress.percent : 0;
          const x =
            railOffset + startToPosition(node.start) + getNodeWidth(node.id) * percent;
          // Spans axis + rows so the triangle pin sits at the top of the
          // dock (above the axis labels) and the line drops through the
          // chapter tracks below, matching the design.
          const fullHeight = overlayTopOffset + rowsAreaHeight;
          return (
            <div
              className="btl-playhead"
              style={{ left: x, top: 0, height: fullHeight }}
              aria-hidden
            >
              <div className="btl-playhead__head" />
              <div className="btl-playhead__glow" />
            </div>
          );
        })()}

        {/* Cross-storyline links overlay — sits above the tracks area, below
            sticky rails (rails z-index 5, SVG z-index 4). Grid lines are
            rendered inside each track div so they paint behind clips.
            The SVG spans the full scroll content so rowCenterY can include
            the axis offset; this keeps coordinates aligned with rows. */}
        {crossStorylineLinks.length > 0 &&
          storylines.length > 0 &&
          rowHeight > 0 &&
          timelineMode !== 'strip' && (
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
                // Smooth S-curve: anchors held vertical for a literary,
                // hand-drawn feel rather than diagonal straight lines.
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
