import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import type { BookNode, BookNodeEdge } from '../domain/book-node';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookNode } from '../usecase/useBookNode';
import { useTimelineMarkers } from '../hooks/useTimelineMarkers';
import { FullBookLane } from '../components/BottomTimeline/FullBookLane';
import { v7 as uuidv7 } from 'uuid';
import loglevel from 'loglevel';
import '../../styles/graph-view.css';

const log = loglevel.getLogger('GraphView');
log.setLevel(loglevel.levels.WARN);

// Phase 4: GraphView now reads node-to-node relation edges from the
// `book_node_edge` table and renders them on top of the storyline-track
// canvas. Edges carry a free-form user-defined `kind` (no fixed vocabulary);
// the filter chips list whatever distinct kinds exist in the project.
// Edge creation is shift-click-to-pair: shift-click a tile to set it as
// source, click another tile to open the new-edge dialog.

type GraphView = 'book' | 'narrative';

const VIEW_STORAGE_KEY = 'graph-view-mode';

const GRAPH_CONFIG = {
  // Wider grid units than BottomTimeline — fullscreen has room to breathe.
  GRID_UNIT: 32,
  // Tile width in grid units; same convention as BottomTimeline.
  TILE_WIDTH_UNITS: 5,
  // Bigger tiles than Phase 3: GraphView is intended to grow into the
  // primary editing surface for inter-node relationship graphs, so each
  // tile needs room to host more attribute UI later.
  TILE_HEIGHT: 96,
  // Default storyline row height. Generous so the gaps between rows can
  // host relationship edges + inline UI without the layout feeling
  // cramped. Per-storyline overrides via TRACK_OVERRIDES below grow the
  // row dynamically (e.g. when the user expands a storyline to author
  // its relationship graph).
  TRACK_HEIGHT: 160,
  // Per-storyline track-height overrides keyed by storyline id. Reserved
  // for the future "expand this row to author relationships" affordance;
  // an empty record now means every row uses TRACK_HEIGHT.
  RAIL_WIDTH: 158,
  AXIS_HEIGHT: 32,
  FULL_BOOK_LANE_HEIGHT: 32,
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

// Sentinel used in the filter map for edges with `kind === null`.
const UNCATEGORIZED_KIND = '__uncategorized__';

// Stable color from a kind string so two edges of the same kind always
// share a color across renders. djb2-ish hash → palette index.
const KIND_PALETTE = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
  'hsl(var(--ink-3))',
];
function colorForKind(kind: string | null): string {
  if (!kind) return 'hsl(var(--ink-4))';
  let h = 5381;
  for (let i = 0; i < kind.length; i++) {
    h = ((h << 5) + h) ^ kind.charCodeAt(i);
  }
  return KIND_PALETTE[Math.abs(h) % KIND_PALETTE.length];
}

export function GraphView() {
  const { bookNodes, storylines, nodeStorylineMapping, nodeEdges } = useDataStore();
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const setNodeSelection = useUiStore((s) => s.setNodeSelection);
  const selectedNodeUiId = useUiStore((s) => s.nodeUi.selectedId);
  const { user } = useAuthStore();
  const { projectId, openEntity } = useProjectNavigation();
  const { updateNode, createEdge, deleteEdge } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { markers } = useTimelineMarkers(projectId);

  const [viewMode, setViewMode] = useState<GraphView>(readPersistedView);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Pending source for shift-click edge creation. The first shift-click sets
  // this; the next plain click on a different tile opens the new-edge dialog.
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [newEdgePair, setNewEdgePair] = useState<{ source: string; target: string } | null>(null);
  const [newEdgeKind, setNewEdgeKind] = useState('');
  // Set of kinds the user has TOGGLED OFF. Default = empty (all visible).
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());

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

    // Iterate lane edges (not per-node) and connect actual tiles. See the
    // BottomTimeline equivalent: the old per-node approach emitted phantom
    // endpoints on secondary rows where neither node had a tile, which the
    // user noticed as dashed lines coming from nowhere.
    for (const sl of storylines) {
      const lane = sortedNodesByStoryline.get(sl.id) ?? [];
      if (lane.length < 2) continue;
      const color = sl.color || 'hsl(var(--ink-4))';
      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const aMain = primaryStorylineId(a);
        const bMain = primaryStorylineId(b);
        // Skip the redundant case where both A and B have S as their main:
        // their adjacency is already visible from the row's tile sequence.
        if (aMain === sl.id && bMain === sl.id) continue;
        if (!aMain || !bMain) continue;
        links.push({
          key: `xlink:${sl.id}:${a.id}->${b.id}`,
          fromX: a.x + halfTile,
          fromY: a.y,
          toX: b.x + halfTile,
          toY: b.y,
          color,
        });
      }
    }
    return links;
  }, [storylines, sortedNodesByStoryline, primaryStorylineId]);

  // ---- Relation edges (user-defined kinds) ----
  // Index positioned nodes for fast endpoint lookup. Edges whose endpoint
  // isn't placed in the current view (e.g. narrative view with null
  // narrativeOrder on one end) are skipped.
  const positionedById = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    positionedNodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [positionedNodes]);

  const distinctKinds = useMemo(() => {
    const set = new Set<string>();
    let hasNull = false;
    for (const e of nodeEdges) {
      if (e.kind) set.add(e.kind);
      else hasNull = true;
    }
    const out = [...set].sort();
    if (hasNull) out.push(UNCATEGORIZED_KIND);
    return out;
  }, [nodeEdges]);

  const visibleEdges = useMemo(() => {
    const halfTile = (GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT) / 2;
    type LaidEdge = {
      edge: BookNodeEdge;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    };
    const out: LaidEdge[] = [];
    for (const edge of nodeEdges) {
      const filterKey = edge.kind ?? UNCATEGORIZED_KIND;
      if (hiddenKinds.has(filterKey)) continue;
      const source = positionedById.get(edge.sourceNodeId);
      const target = positionedById.get(edge.targetNodeId);
      if (!source || !target) continue;
      out.push({
        edge,
        x1: source.x + halfTile,
        y1: source.y,
        x2: target.x + halfTile,
        y2: target.y,
        color: colorForKind(edge.kind),
      });
    }
    return out;
  }, [nodeEdges, positionedById, hiddenKinds]);

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

        {/* Dynamic filter chips — one per distinct kind in the project,
            plus "未分类" for edges with kind=null. Chips collapse when the
            project has no edges yet so the header doesn't show empty UI. */}
        {distinctKinds.length > 0 && (
          <div className="graph-head__filters">
            {distinctKinds.map((kind) => {
              const isUncategorized = kind === UNCATEGORIZED_KIND;
              const label = isUncategorized ? '未分类' : kind;
              const color = colorForKind(isUncategorized ? null : kind);
              const active = !hiddenKinds.has(kind);
              return (
                <button
                  key={kind}
                  className={`graph-head__filter${active ? ' is-active' : ''}`}
                  onClick={() =>
                    setHiddenKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                  title={active ? `隐藏「${label}」` : `显示「${label}」`}
                >
                  <span className="graph-head__filter-dot" style={{ background: color }} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        )}
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

        <div className="graph-content">
          {/* Book mode: FullBookLane spans the content width and scrolls
              independently from .graph-canvas below. Narrative mode skips
              it (the lane is book-order-only per user direction). */}
          {!isNarrative && (
            <FullBookLane
              nodes={placedNodes}
              storylines={storylines}
              primaryStorylineId={(n) => primaryStorylineId(n)}
              activeNodeId={activeId}
              trackOffsetX={0}
              onNodeClick={(id) => {
                setNodeSelection(id, 'ui');
                const target = positionedNodes.find((n) => n.id === id);
                const canvas = canvasRef.current;
                if (!target || !canvas) return;
                const tileW = GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT;
                const left = target.x + tileW / 2 - canvas.clientWidth / 2;
                canvas.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
              }}
              height={GRAPH_CONFIG.FULL_BOOK_LANE_HEIGHT}
              railLabel=""
            />
          )}

          <div
            ref={canvasRef}
            className="graph-canvas"
            onDragOver={isNarrative ? handleTracksDragOver : undefined}
            onDrop={isNarrative ? handleTracksDrop : undefined}
          >
            <div
              className="graph-tracks"
              style={{ width: Math.max(canvasContentWidth, 100), minWidth: '100%' }}
            >
              {/* Time axis — narrative mode only. Book mode uses the
                  FullBookLane above for the same "what's the axis" role. */}
              {isNarrative && (
                <div className="graph-axis" style={{ height: GRAPH_CONFIG.AXIS_HEIGHT }}>
                  {axisLabels.map((m, i) => (
                    <div key={i} className="graph-axis__col" style={{ left: m.x }}>
                      <div className="graph-axis__tick" />
                      <div className={`graph-axis__label${m.major ? ' is-major' : ''}`}>
                        {m.label}
                      </div>
                    </div>
                  ))}
                </div>
              )}

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
            {(crossLinks.length > 0 || visibleEdges.length > 0) && (
              <svg
                className="graph-edges"
                width={canvasContentWidth}
                height={GRAPH_CONFIG.AXIS_HEIGHT + storylines.length * GRAPH_CONFIG.TRACK_HEIGHT}
                style={{ top: 0, left: 0 }}
              >
                {/* Cross-storyline transit trails (dashed, behind relation
                    edges). They visualise multi-storyline membership rather
                    than authored relations. */}
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
                      opacity="0.45"
                    />
                  );
                })}
                {/* User-authored relation edges (solid, click to delete). */}
                {visibleEdges.map(({ edge, x1, y1, x2, y2, color }) => {
                  const yy1 = GRAPH_CONFIG.AXIS_HEIGHT + y1;
                  const yy2 = GRAPH_CONFIG.AXIS_HEIGHT + y2;
                  const midY = (yy1 + yy2) / 2;
                  const d = `M ${x1} ${yy1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${yy2}`;
                  return (
                    <g key={edge.id} className="graph-edge-grp">
                      {/* Invisible wider hit-target so the path is easy to click. */}
                      <path
                        d={d}
                        stroke="transparent"
                        strokeWidth="10"
                        fill="none"
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`删除关联「${edge.kind ?? '未分类'}」?`)) {
                            void deleteEdge(edge.id);
                          }
                        }}
                      >
                        <title>{edge.kind ? `${edge.kind} · 点击删除` : '未分类 · 点击删除'}</title>
                      </path>
                      <path
                        d={d}
                        stroke={color}
                        strokeWidth="1.8"
                        fill="none"
                        opacity="0.85"
                        style={{ pointerEvents: 'none' }}
                      />
                    </g>
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
              const isLinkSource = linkSource === node.id;
              return (
                <div
                  key={node.id}
                  className={[
                    'graph-tile',
                    isActive ? 'is-active' : '',
                    isTransfer ? 'is-transfer' : '',
                    isDraft ? 'is-draft' : '',
                    isLinkSource ? 'is-link-source' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={isNarrative}
                  onDragStart={(e) => handleTileDragStart(e, node)}
                  onDragEnd={handleDragEnd}
                  onClick={(e) => {
                    // Shift-click sets/clears the relation source. A subsequent
                    // plain click on a different tile opens the new-edge
                    // dialog; click on the same tile clears.
                    if (e.shiftKey) {
                      setLinkSource((prev) => (prev === node.id ? null : node.id));
                      return;
                    }
                    if (linkSource && linkSource !== node.id) {
                      setNewEdgePair({ source: linkSource, target: node.id });
                      setNewEdgeKind('');
                      setLinkSource(null);
                      return;
                    }
                    setNodeSelection(node.id, 'ui');
                  }}
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
      </div>

      {/* Legend — dynamic; lists whatever kinds exist in the project plus
          a constant footnote about transit/active styling. Hidden when
          there are no edges so the chrome stays out of the way. */}
      {distinctKinds.length > 0 ? (
        <div className="graph-legend">
          <div className="graph-legend__title">关联类型</div>
          {distinctKinds.map((kind) => {
            const isUncategorized = kind === UNCATEGORIZED_KIND;
            const label = isUncategorized ? '未分类' : kind;
            const color = colorForKind(isUncategorized ? null : kind);
            return (
              <div key={kind} className="graph-legend__row">
                <span className="graph-legend__swatch">
                  <svg viewBox="0 0 22 4">
                    <path d="M0 2 L22 2" stroke={color} strokeWidth="1.8" fill="none" />
                  </svg>
                </span>
                <span>{label}</span>
              </div>
            );
          })}
          <div className="graph-legend__hint">
            多线 = 实心边框 · 当前 = 朱红环 · Shift+点击章节起关联
          </div>
        </div>
      ) : (
        <div className="graph-legend">
          <div className="graph-legend__title">尚无关联</div>
          <div className="graph-legend__hint">Shift+点击两个章节即可创建</div>
        </div>
      )}

      {/* Status banner when a relation-source tile has been picked. */}
      {linkSource && !newEdgePair && (
        <div className="graph-linkbar">
          <span>已选中起点：</span>
          <strong>{positionedById.get(linkSource)?.title || '未命名'}</strong>
          <span>· 点击另一章节创建关联</span>
          <button onClick={() => setLinkSource(null)} title="取消">×</button>
        </div>
      )}

      {/* New-edge dialog: prompts for the user-defined `kind`. Empty input
          means "uncategorized" (null kind). */}
      {newEdgePair && (
        <div
          className="graph-newedge-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setNewEdgePair(null);
          }}
        >
          <div
            className="graph-newedge"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setNewEdgePair(null);
            }}
          >
            <div className="graph-newedge__head">新建关联</div>
            <div className="graph-newedge__pair">
              <span>{positionedById.get(newEdgePair.source)?.title || '未命名'}</span>
              <span aria-hidden>→</span>
              <span>{positionedById.get(newEdgePair.target)?.title || '未命名'}</span>
            </div>
            <label className="graph-newedge__label">分类（留空 = 未分类）</label>
            <input
              autoFocus
              className="graph-newedge__input"
              type="text"
              value={newEdgeKind}
              placeholder="如：同人物 / 引用 / 时序 …"
              list="graph-newedge-kinds"
              onChange={(e) => setNewEdgeKind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const trimmed = newEdgeKind.trim();
                  void createEdge({
                    id: uuidv7(),
                    projectId: projectId ?? '',
                    sourceNodeId: newEdgePair.source,
                    targetNodeId: newEdgePair.target,
                    label: '',
                    kind: trimmed || null,
                    weight: 1,
                    isDirected: true,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  });
                  setNewEdgePair(null);
                }
              }}
            />
            <datalist id="graph-newedge-kinds">
              {distinctKinds
                .filter((k) => k !== UNCATEGORIZED_KIND)
                .map((k) => (
                  <option key={k} value={k} />
                ))}
            </datalist>
            <div className="graph-newedge__actions">
              <button onClick={() => setNewEdgePair(null)}>取消</button>
              <button
                className="is-primary"
                onClick={() => {
                  const trimmed = newEdgeKind.trim();
                  void createEdge({
                    id: uuidv7(),
                    projectId: projectId ?? '',
                    sourceNodeId: newEdgePair.source,
                    targetNodeId: newEdgePair.target,
                    label: '',
                    kind: trimmed || null,
                    weight: 1,
                    isDirected: true,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  });
                  setNewEdgePair(null);
                }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
