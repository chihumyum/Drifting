import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book-node';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookNode } from '../usecase/useBookNode';
import { useTimelineMarkers } from '../hooks/useTimelineMarkers';
import loglevel from 'loglevel';
import '../../styles/graph-view.css';

const log = loglevel.getLogger('GraphView');
log.setLevel(loglevel.levels.WARN);

// Phase 3 rewrite: GraphView is no longer a force-directed network. It now
// mirrors the BottomTimeline layout (storyline tracks + chapter tiles) at
// fullscreen scale, with both book-order and narrative-time views. Edge
// relations (同人物 / 引用 / 时序 / 物件 / 回响) come in Phase 4 once the
// node_relation table is in place — for now the filter chips and legend
// are visible scaffolding that don't draw any edges.

type GraphView = 'book' | 'narrative';

const VIEW_STORAGE_KEY = 'graph-view-mode';

const GRAPH_CONFIG = {
  // Wider grid units than BottomTimeline — fullscreen has room to breathe.
  GRID_UNIT: 32,
  // Tile width in grid units; same convention as BottomTimeline.
  TILE_WIDTH_UNITS: 4,
  TILE_HEIGHT: 64,
  TRACK_HEIGHT: 88,
  RAIL_WIDTH: 158,
  AXIS_HEIGHT: 32,
  CANVAS_PADDING_X: 24,
};

function readPersistedView(): GraphView {
  if (typeof localStorage === 'undefined') return 'book';
  const v = localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'narrative' ? 'narrative' : 'book';
}

interface PositionedNode extends BookNode {
  storyline: Storyline | null;
  storylines: Storyline[];
  rowIndex: number;
  x: number; // tile left, in canvas pixels (already includes padding)
  y: number; // track center, in canvas pixels
}

export function GraphView() {
  const { bookNodes, storylines, nodeStorylineMapping } = useDataStore();
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const setNodeSelection = useUiStore((s) => s.setNodeSelection);
  const selectedNodeUiId = useUiStore((s) => s.nodeUi.selectedId);
  const { user } = useAuthStore();
  const { projectId, openEntity } = useProjectNavigation();
  const { updateNode } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { markers } = useTimelineMarkers(projectId);

  const [viewMode, setViewMode] = useState<GraphView>(readPersistedView);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Placeholder filter state — Phase 4 wires these to real edges.
  const [activeFilters, setActiveFilters] = useState({
    character: true,
    reference: true,
    temporal: true,
    object: true,
    echo: true,
  });

  const isNarrative = viewMode === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  // ESC closes the super-view, returning to the regular editor layout.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveSuperView('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveSuperView]);

  const close = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);

  // ---- Node positioning ----
  const storylineById = useMemo(() => new Map(storylines.map((s) => [s.id, s])), [storylines]);
  const nodeStorylines = useCallback(
    (nodeId: string): Storyline[] => {
      const ids = nodeStorylineMapping[nodeId] || [];
      return ids
        .map((id) => storylineById.get(id))
        .filter((sl): sl is Storyline => Boolean(sl));
    },
    [nodeStorylineMapping, storylineById],
  );

  const primaryStorylineId = useCallback(
    (node: BookNode): string | null => {
      const sls = nodeStorylines(node.id);
      if (sls.length === 0) return null;
      const fallback = sls[0]?.id ?? null;
      return sls.some((sl) => sl.id === node.mainStorylineId) ? node.mainStorylineId : fallback;
    },
    [nodeStorylines],
  );

  const orderOf = useCallback(
    (node: BookNode): number | null => {
      const v = node[orderField];
      return typeof v === 'number' ? v : null;
    },
    [orderField],
  );

  const { placedNodes, unplacedNodes } = useMemo(() => {
    const placed: BookNode[] = [];
    const unplaced: BookNode[] = [];
    for (const n of bookNodes) {
      // Drift nodes (no storyline) don't appear in the structural graph —
      // they're meant for the inspiration panel.
      if (!primaryStorylineId(n)) continue;
      if (orderOf(n) === null) unplaced.push(n);
      else placed.push(n);
    }
    return { placedNodes: placed, unplacedNodes: unplaced };
  }, [bookNodes, primaryStorylineId, orderOf]);

  const storylineRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    storylines.forEach((s, i) => map.set(s.id, i));
    return map;
  }, [storylines]);

  // Compute the order span across all placed nodes; canvas width derives
  // from this. Pads either side so tiles don't hug the edges.
  const orderSpan = useMemo(() => {
    if (placedNodes.length === 0) return { min: 1, max: 1 + GRAPH_CONFIG.TILE_WIDTH_UNITS };
    const values = placedNodes.map((n) => orderOf(n) ?? 0);
    return {
      min: Math.min(...values, 1),
      max: Math.max(...values) + GRAPH_CONFIG.TILE_WIDTH_UNITS,
    };
  }, [placedNodes, orderOf]);

  const canvasContentWidth =
    (orderSpan.max - orderSpan.min) * GRAPH_CONFIG.GRID_UNIT + GRAPH_CONFIG.CANVAS_PADDING_X * 2;

  const orderToX = useCallback(
    (order: number) => GRAPH_CONFIG.CANVAS_PADDING_X + (order - orderSpan.min) * GRAPH_CONFIG.GRID_UNIT,
    [orderSpan.min],
  );

  const positionedNodes = useMemo<PositionedNode[]>(() => {
    return placedNodes
      .map((node) => {
        const mainId = primaryStorylineId(node);
        if (!mainId) return null;
        const rowIndex = storylineRowIndex.get(mainId);
        if (rowIndex === undefined) return null;
        const ord = orderOf(node);
        if (ord === null) return null;
        const sl = storylineById.get(mainId) ?? null;
        return {
          ...node,
          storyline: sl,
          storylines: nodeStorylines(node.id),
          rowIndex,
          x: orderToX(ord),
          y: rowIndex * GRAPH_CONFIG.TRACK_HEIGHT + GRAPH_CONFIG.TRACK_HEIGHT / 2,
        } as PositionedNode;
      })
      .filter((n): n is PositionedNode => Boolean(n));
  }, [placedNodes, primaryStorylineId, storylineRowIndex, orderOf, storylineById, nodeStorylines, orderToX]);

  // ---- Cross-storyline trails ----
  // Same semantic as BottomTimeline: a node on its main storyline appears
  // as a tile; on every secondary storyline it belongs to, it surfaces as
  // a transit curve from the previous node on that storyline to N, and
  // from N to the next. Adjacency comes from each storyline's order-sorted
  // lane so ties resolve deterministically.
  const sortedNodesByStoryline = useMemo(() => {
    const m = new Map<string, PositionedNode[]>();
    storylines.forEach((s) => m.set(s.id, []));
    positionedNodes.forEach((node) => {
      node.storylines.forEach((sl) => {
        const arr = m.get(sl.id);
        if (arr) arr.push(node);
      });
    });
    m.forEach((arr) => arr.sort((a, b) => (orderOf(a) ?? 0) - (orderOf(b) ?? 0)));
    return m;
  }, [positionedNodes, storylines, orderOf]);

  const crossLinks = useMemo(() => {
    type Link = {
      key: string;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      color: string;
    };
    const links: Link[] = [];
    const halfTile = (GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT) / 2;

    for (const node of positionedNodes) {
      if (node.storylines.length <= 1) continue;
      const mainId = primaryStorylineId(node);
      if (!mainId) continue;
      const nodeMidX = node.x + halfTile;
      const nodeY = node.y;

      for (const sl of node.storylines) {
        if (sl.id === mainId) continue;
        const rowIdx = storylineRowIndex.get(sl.id);
        if (rowIdx === undefined) continue;
        const sY = rowIdx * GRAPH_CONFIG.TRACK_HEIGHT + GRAPH_CONFIG.TRACK_HEIGHT / 2;

        const lane = sortedNodesByStoryline.get(sl.id) ?? [];
        const idx = lane.findIndex((n) => n.id === node.id);
        if (idx < 0) continue;
        const prev = idx > 0 ? lane[idx - 1] : null;
        const next = idx < lane.length - 1 ? lane[idx + 1] : null;
        const color = sl.color || 'hsl(var(--ink-4))';

        if (prev) {
          links.push({
            key: `${sl.id}:${prev.id}->${node.id}`,
            fromX: prev.x + halfTile,
            fromY: sY,
            toX: nodeMidX,
            toY: nodeY,
            color,
          });
        }
        if (next) {
          links.push({
            key: `${sl.id}:${node.id}->${next.id}`,
            fromX: nodeMidX,
            fromY: nodeY,
            toX: next.x + halfTile,
            toY: sY,
            color,
          });
        }
      }
    }
    return links;
  }, [positionedNodes, primaryStorylineId, storylineRowIndex, sortedNodesByStoryline]);

  // ---- Narrative time axis labels ----
  // In narrative view we surface user-defined TimelineMarkers as time
  // labels along the axis. Book view's axis just shows §-style book-order
  // ticks every few units.
  const axisLabels = useMemo(() => {
    if (isNarrative) {
      return markers
        .filter((m) => m.narrativeOrder >= orderSpan.min && m.narrativeOrder <= orderSpan.max)
        .map((m) => ({ x: orderToX(m.narrativeOrder), label: m.label, major: /\d/.test(m.label) }));
    }
    // Book view: show §-markers every 5 units across the span.
    const out: { x: number; label: string; major: boolean }[] = [];
    const step = 5;
    const lo = Math.ceil(orderSpan.min / step) * step;
    const hi = Math.floor(orderSpan.max / step) * step;
    for (let i = lo; i <= hi; i += step) {
      out.push({ x: orderToX(i), label: `§ ${String(i).padStart(2, '0')}`, major: i % 10 === 0 });
    }
    return out;
  }, [isNarrative, markers, orderSpan.min, orderSpan.max, orderToX]);

  // ---- Drag / drop (narrative view only — set narrativeOrder by dropping) ----
  const [draggedNode, setDraggedNode] = useState<BookNode | null>(null);
  const [dragOverOrder, setDragOverOrder] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const handleTileDragStart = (e: React.DragEvent, node: BookNode) => {
    if (!isNarrative) {
      e.preventDefault();
      return;
    }
    setDraggedNode(node);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleChipDragStart = (e: React.DragEvent, node: BookNode) => {
    setDraggedNode(node);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleTracksDragOver = (e: React.DragEvent) => {
    if (!draggedNode || !canvasRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasRef.current.scrollLeft - GRAPH_CONFIG.CANVAS_PADDING_X;
    const order = Math.max(orderSpan.min, Math.round(x / GRAPH_CONFIG.GRID_UNIT) + orderSpan.min);
    setDragOverOrder(order);
  };

  const handleTracksDrop = async (e: React.DragEvent) => {
    if (!draggedNode || dragOverOrder === null) return;
    e.preventDefault();
    try {
      await updateNode(draggedNode.id, { narrativeOrder: dragOverOrder });
    } catch (err) {
      log.error('Failed to set narrativeOrder', err);
    } finally {
      setDraggedNode(null);
      setDragOverOrder(null);
    }
  };

  const handleDragEnd = () => {
    setDraggedNode(null);
    setDragOverOrder(null);
  };

  // ---- Active node (for active-tile outline) ----
  const activeId = selectedNodeUiId ?? null;

  const totalsLabel = `${storylines.length} ${storylines.length === 1 ? '故事线' : '故事线'} · ${placedNodes.length}/${bookNodes.length} 章`;

  return (
    <div className="graph-overlay" data-view={viewMode}>
      <div className="graph-head">
        <div className="graph-head__left">
          <button className="graph-head__back" onClick={close} title="Esc 返回">
            <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 16, lineHeight: 1 }}>
              ‹
            </span>
            <span>返回</span>
          </button>
          <div className="graph-head__title">
            叙事结构图
            <em>{totalsLabel}</em>
          </div>
          <div className="graph-head__view-toggle">
            <button
              className={viewMode === 'book' ? 'is-active' : ''}
              onClick={() => setViewMode('book')}
              title="按阅读顺序排列"
            >
              书序
            </button>
            <button
              className={viewMode === 'narrative' ? 'is-active' : ''}
              onClick={() => setViewMode('narrative')}
              title="按 in-world 时间排列"
            >
              叙事时
            </button>
          </div>
        </div>

        <div className="graph-head__filters">
          {/* Phase 4: these will toggle edges of the corresponding relation
              type. For now they're visible-but-inert placeholders so the
              user sees the planned shape. */}
          {[
            { id: 'character' as const, label: '同人物', color: 'hsl(var(--ink-4))' },
            { id: 'reference' as const, label: '引用', color: 'hsl(var(--story-4))' },
            { id: 'temporal' as const, label: '时序', color: 'hsl(var(--story-2))' },
            { id: 'object' as const, label: '物件', color: 'hsl(var(--story-4))' },
            { id: 'echo' as const, label: '回响', color: 'hsl(var(--story-5))' },
          ].map((f) => (
            <button
              key={f.id}
              className={`graph-head__filter${activeFilters[f.id] ? ' is-active' : ''}`}
              onClick={() => setActiveFilters((p) => ({ ...p, [f.id]: !p[f.id] }))}
              title={`${f.label}（Phase 4 启用）`}
            >
              <span className="graph-head__filter-dot" style={{ background: f.color }} />
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      {isNarrative && (
        <div className={`graph-drawer${drawerOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="graph-drawer__tab"
            onClick={() => setDrawerOpen((v) => !v)}
            title="未放置的章节（拖入下方时间轴来安排叙事时间）"
          >
            <span className="graph-drawer__arrow">{drawerOpen ? '▾' : '▸'}</span>
            <span>未放置</span>
            <span className="graph-drawer__count">{unplacedNodes.length}</span>
          </button>
          {drawerOpen && (
            <div className="graph-drawer__list">
              {unplacedNodes.length === 0 ? (
                <div className="graph-drawer__empty">所有章节都在叙事时间轴上</div>
              ) : (
                unplacedNodes.map((node) => {
                  const primaryId = primaryStorylineId(node);
                  const sl = primaryId ? storylineById.get(primaryId) : null;
                  const color = sl?.color || 'hsl(var(--ink-4))';
                  return (
                    <div
                      key={node.id}
                      className="graph-drawer__chip"
                      draggable
                      onDragStart={(e) => handleChipDragStart(e, node)}
                      onDragEnd={handleDragEnd}
                      onClick={() => setNodeSelection(node.id, 'ui')}
                      style={{ ['--chip-color' as string]: color } as React.CSSProperties}
                      title={node.title || '未命名'}
                    >
                      <span className="graph-drawer__chip-dot" />
                      <span className="graph-drawer__chip-num">
                        § {String(node.bookOrder).padStart(2, '0')}
                      </span>
                      <span className="graph-drawer__chip-title">{node.title || '未命名'}</span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      <div className="graph-body">
        <div className="graph-rail">
          {/* Spacer above the rail so storyline names align with their
              respective track centers (axis row sits above the tracks). */}
          <div style={{ height: GRAPH_CONFIG.AXIS_HEIGHT, borderBottom: '1px solid hsl(var(--rule))' }} />
          {storylines.map((s) => {
            const lane = sortedNodesByStoryline.get(s.id) ?? [];
            return (
              <div key={s.id} className="graph-rail__row" style={{ height: GRAPH_CONFIG.TRACK_HEIGHT }}>
                <div className="graph-rail__name">
                  <span
                    className="graph-rail__name-dot"
                    style={{ background: s.color || 'hsl(var(--story-4))' }}
                  />
                  <span>{s.name || 'Untitled'}</span>
                </div>
                <div className="graph-rail__meta">{lane.length} 章</div>
              </div>
            );
          })}
        </div>

        <div
          ref={canvasRef}
          className="graph-canvas"
          onDragOver={isNarrative ? handleTracksDragOver : undefined}
          onDrop={isNarrative ? handleTracksDrop : undefined}
        >
          <div className="graph-tracks" style={{ width: Math.max(canvasContentWidth, 100), minWidth: '100%' }}>
            {/* Time axis */}
            <div className="graph-axis" style={{ height: GRAPH_CONFIG.AXIS_HEIGHT }}>
              {axisLabels.map((m, i) => (
                <div key={i} className="graph-axis__col" style={{ left: m.x }}>
                  <div className="graph-axis__tick" />
                  <div className={`graph-axis__label${m.major ? ' is-major' : ''}`}>{m.label}</div>
                </div>
              ))}
            </div>

            {/* One row per storyline with the dotted reading-line behind tiles */}
            {storylines.map((s) => (
              <div
                key={s.id}
                className="graph-track"
                style={
                  {
                    height: GRAPH_CONFIG.TRACK_HEIGHT,
                    ['--track-color' as string]: s.color || 'hsl(var(--story-4))',
                  } as React.CSSProperties
                }
              />
            ))}

            {/* Cross-storyline trails (SVG, behind tiles) */}
            {crossLinks.length > 0 && (
              <svg
                className="graph-edges"
                width={canvasContentWidth}
                height={GRAPH_CONFIG.AXIS_HEIGHT + storylines.length * GRAPH_CONFIG.TRACK_HEIGHT}
                style={{ top: 0, left: 0 }}
              >
                {crossLinks.map((link) => {
                  const y1 = GRAPH_CONFIG.AXIS_HEIGHT + link.fromY;
                  const y2 = GRAPH_CONFIG.AXIS_HEIGHT + link.toY;
                  const midY = (y1 + y2) / 2;
                  const d = `M ${link.fromX} ${y1} C ${link.fromX} ${midY}, ${link.toX} ${midY}, ${link.toX} ${y2}`;
                  return (
                    <path
                      key={link.key}
                      d={d}
                      stroke={link.color}
                      strokeWidth="1.4"
                      strokeDasharray="2 3"
                      fill="none"
                      opacity="0.55"
                    />
                  );
                })}
              </svg>
            )}

            {/* Drop indicator while dragging in narrative view */}
            {isNarrative && dragOverOrder !== null && draggedNode && (
              <div
                className="graph-drop-indicator"
                style={{
                  left: orderToX(dragOverOrder),
                  top: GRAPH_CONFIG.AXIS_HEIGHT,
                  height: storylines.length * GRAPH_CONFIG.TRACK_HEIGHT,
                }}
              />
            )}

            {/* Tiles */}
            {positionedNodes.map((node) => {
              const isActive = node.id === activeId;
              const isTransfer = node.storylines.length > 1;
              const isDraft = node.wordCount === 0;
              const color = node.storyline?.color || 'hsl(var(--story-4))';
              return (
                <div
                  key={node.id}
                  className={[
                    'graph-tile',
                    isActive ? 'is-active' : '',
                    isTransfer ? 'is-transfer' : '',
                    isDraft ? 'is-draft' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={isNarrative}
                  onDragStart={(e) => handleTileDragStart(e, node)}
                  onDragEnd={handleDragEnd}
                  onClick={() => setNodeSelection(node.id, 'ui')}
                  onDoubleClick={() => {
                    openEntity({ entityType: 'node', id: node.id }, { preview: false });
                    close();
                  }}
                  style={
                    {
                      left: node.x,
                      top: GRAPH_CONFIG.AXIS_HEIGHT + node.y - GRAPH_CONFIG.TILE_HEIGHT / 2,
                      width: GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT,
                      height: GRAPH_CONFIG.TILE_HEIGHT,
                      ['--tile-color' as string]: color,
                    } as React.CSSProperties
                  }
                  title={`${node.title || '未命名'} · ${node.wordCount ?? 0} 字${isTransfer ? ' · 多线' : ''}`}
                >
                  <div className="graph-tile__stripe" />
                  <div className="graph-tile__num">§ {String(node.bookOrder).padStart(2, '0')}</div>
                  <div className="graph-tile__title">{node.title || '未命名'}</div>
                  {node.summary && <div className="graph-tile__summary">{node.summary}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend — Phase 4 will document real edge styles; for now the
          rows match the placeholder filter chips and serve as a visual
          contract for what Phase 4 will produce. */}
      <div className="graph-legend">
        <div className="graph-legend__title">关联类型</div>
        {[
          { label: '同人物 / 共同场景', color: 'hsl(var(--ink-4))', dash: undefined },
          { label: '引用 · 提及', color: 'hsl(var(--story-4))', dash: '5 4' },
          { label: '时序 · 叙事时', color: 'hsl(var(--story-2))', dash: '1 3' },
          { label: '物件传承', color: 'hsl(var(--story-4))', dash: '8 3 1 3' },
          { label: '回响 · 主题呼应', color: 'hsl(var(--story-5))', dash: undefined },
        ].map((l, i) => (
          <div key={i} className="graph-legend__row">
            <span className="graph-legend__swatch">
              <svg viewBox="0 0 22 4">
                <path
                  d="M0 2 L22 2"
                  stroke={l.color}
                  strokeWidth="1.6"
                  fill="none"
                  strokeDasharray={l.dash}
                />
              </svg>
            </span>
            <span>{l.label}</span>
          </div>
        ))}
        <div className="graph-legend__hint">多线 = 实心边框 · 当前 = 朱红环</div>
      </div>
    </div>
  );
}
