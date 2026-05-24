import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import type { Storyline } from '../domain/storyline';
import type { BookNode } from '../domain/book-node';
import { CHAPTER_ORDER_STRIDE, isChapter, isDrift } from '../domain/book-node';
import { useDataStore, type EntityRelationLink } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { useAuthStore } from '../store/auth';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookNode } from '../usecase/useBookNode';
import { useStoryline } from '../usecase/useStoryline';
import { useEntityRelations } from '../usecase/useEntityRelations';
import { useTimelineMarkers } from '../hooks/useTimelineMarkers';
import { useEdgeKindMeta, UNCATEGORIZED_META_KEY } from '../hooks/useEdgeKindMeta';
import { FullBookLane } from '../components/BottomTimeline/FullBookLane';
import { NodeCardPopover, type AnchorRect } from '../components/graph/NodeCardPopover';
import { EntityCellContextMenu } from '../components/leftBars/EntityCellContextMenu';
import { useEntityCellAction } from '../hooks/useEntityCellAction';
import { EdgeKindManager } from '../components/graph/EdgeKindManager';
import { GraphTimelinePin } from '../components/graph/GraphTimelinePin';
import { DriftPanel, useDriftPanelAnim } from '../components/DriftPanel';
import { SuperViewHeader } from '../components/SuperViewHeader';
import loglevel from 'loglevel';
import '../../styles/graph-view.css';

const log = loglevel.getLogger('StoryGraphView');
log.setLevel(loglevel.levels.WARN);

// Edges between nodes (chapter ↔ chapter, chapter ↔ drift, drift ↔ drift) are
// persisted as rows in `entity_relation` with fromKind/toKind = 'node'. Each
// carries a free-form user-defined `kind` that drives the filter chips; the
// renderer derives geometry from the current node positions and uses a fixed
// bezier formula for the path. Edge creation is shift-click-to-pair:
// shift-click a tile to set it as source, click another tile to open the
// new-edge dialog.

// View-side projection of a graph edge — chapter↔chapter and chapter↔drift
// links pulled out of `entityRelations` and pinned to node id endpoints.
type GraphEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string | null;
};

function toGraphEdges(
  refs: EntityRelationLink[],
  nodeIds: Set<string>,
): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const ref of refs) {
    if (ref.fromKind !== 'node' || ref.toKind !== 'node') continue;
    if (!nodeIds.has(ref.fromId) || !nodeIds.has(ref.toId)) continue;
    out.push({
      id: ref.id,
      sourceNodeId: ref.fromId,
      targetNodeId: ref.toId,
      kind: ref.kind ?? null,
    });
  }
  return out;
}

type StoryGraphViewMode = 'book' | 'narrative';

const VIEW_STORAGE_KEY = 'graph-view-mode';

const GRAPH_CONFIG = {
  // Wider grid units than BottomTimeline — fullscreen has room to breathe.
  GRID_UNIT: 32,
  // Tile width in grid units; same convention as BottomTimeline.
  TILE_WIDTH_UNITS: 4,
  // Bigger tiles than Phase 3: StoryGraphView is intended to grow into the
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

function readPersistedView(): StoryGraphViewMode {
  if (typeof localStorage === 'undefined') return 'book';
  const v = localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'narrative' ? 'narrative' : 'book';
}

// BookNode is a discriminated union; `extends` doesn't accept unions, so we
// use an intersection. PositionedNode keeps either variant intact and adds
// the StoryGraphView's per-node layout fields on top.
type PositionedNode = BookNode & {
  storyline: Storyline | null;
  storylines: Storyline[];
  rowIndex: number;
  x: number; // tile left, in canvas pixels (already includes padding)
  y: number; // track center, in canvas pixels
};

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

// Slot width used to compute the live shift when dragging drift cards.
// Card flex-basis 168 + gap 10. Module-scoped because the cards are
// fixed-size; if we ever make them responsive we should measure instead.
const DRIFT_SLOT_WIDTH = 168 + 10;

// Synthetic lane sentinels — see BottomTimeline for the full rationale. The
// two views render lanes in lockstep so the IDs are duplicated rather than
// shared (the two files don't share a constants module today).
const DEFAULT_LANE_ID = '__default__';
const UNAFFILIATED_LANE_ID = '__unaffiliated__';

export function StoryGraphView() {
  const { bookNodes, storylines, nodeStorylineMapping, entityRelations, primaryStorylineByNode } =
    useDataStore();
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const { user } = useAuthStore();
  const { projectId, openEntity } = useProjectNavigation();
  const { updateNode } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { addRelation, removeRelation, updateRelationKind } = useEntityRelations({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const edgeKindMeta = useEdgeKindMeta(projectId);
  const { setNodeStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { markers, addMarker, updateMarker, deleteMarker } = useTimelineMarkers(projectId);

  // Story-graph edges are the subset of manual entity references that connect
  // two node rows (chapter or drift); kept as a stable derived array so the
  // memos and effects below can treat them like the old `nodeEdges` store
  // slice. Building the id set once also lets us drop rows whose endpoints
  // were deleted out from under the edge.
  const nodeEdges = useMemo<GraphEdge[]>(() => {
    const nodeIds = new Set(bookNodes.map((n) => n.id));
    return toGraphEdges(entityRelations, nodeIds);
  }, [entityRelations, bookNodes]);

  // Thin adapters so the shift-click create flow and edge-mgr delete flow
  // keep their call shape. `addRelation` returns the new EntityRelationLink;
  // `removeRelation` takes an id; both are already optimistic-update aware.
  const createEdge = useCallback(
    (
      sourceNodeId: string,
      targetNodeId: string,
      kind: string | null,
    ) => addRelation('node', sourceNodeId, 'node', targetNodeId, { kind }),
    [addRelation],
  );
  const deleteEdge = useCallback((id: string) => removeRelation(id), [removeRelation]);
  const updateEdgeKind = useCallback(
    (id: string, kind: string | null) => updateRelationKind(id, kind),
    [updateRelationKind],
  );

  // Color resolver that prefers user overrides from `useEdgeKindMeta`
  // before falling back to the deterministic palette hash. Both the
  // storyline and drift edge renderers consult this, plus the legend
  // chips and the edge-management menu — so a color change in one
  // place is reflected everywhere immediately.
  const resolveKindColor = useCallback(
    (kind: string | null): string => {
      const k = kind ?? UNCATEGORIZED_META_KEY;
      const override = edgeKindMeta.meta[k]?.color;
      if (override) return override;
      return colorForKind(kind);
    },
    [edgeKindMeta.meta],
  );

  const [viewMode, setViewMode] = useState<StoryGraphViewMode>(readPersistedView);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Drift panel state machine — shared with SuperElementView via the
  // useDriftPanelAnim hook. The closePanel returned by the hook only handles
  // its own animation; StoryGraphView wraps it below to also reset the drag-
  // reorder state.
  const {
    mounted: driftPanelMounted,
    open: driftPanelOpen,
    closing: driftPanelClosing,
    openPanel: openDriftPanel,
    closePanel: closeDriftPanelBase,
    closePanelRef: closeDriftPanelRef,
  } = useDriftPanelAnim();
  // Pending source for shift-click edge creation. The first shift-click sets
  // this; the next plain click on a different tile opens the new-edge dialog.
  const [linkSource, setLinkSource] = useState<string | null>(null);
  // Drift card right-click — mirrors SuperElementView's drift cmenu: same
  // unified EntityCellContextMenu, with `startEdgeFrom` appended so users
  // can wire a drift into a chapter from the bottom drawer.
  const [driftContextMenu, setDriftContextMenu] = useState<
    | {
        x: number;
        y: number;
        nodeId: string;
        nodeTitle?: string;
        nodeSummary?: string;
        writingStatus: BookNode['writingStatus'];
      }
    | null
  >(null);
  const [newEdgePair, setNewEdgePair] = useState<{ source: string; target: string } | null>(null);
  const [newEdgeKind, setNewEdgeKind] = useState('');
  // Suggestions popover for the new-edge dialog's kind input. Default
  // closed; opens on focus and closes when focus leaves the wrapper.
  const [newEdgeSuggestOpen, setNewEdgeSuggestOpen] = useState(false);
  // Set of kinds the user has TOGGLED OFF. Default = empty (all visible).
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  // Popover targeting a single tile. `anchor` is the tile's viewport rect at
  // the moment of click — the popover positions itself relative to it.
  const [popover, setPopover] = useState<{ nodeId: string; anchor: AnchorRect } | null>(null);
  // Two kinds of right-click menu live here: per-chapter (node) and per-row
  // (storyline). Discriminated by `kind` so the render branch can pick the
  // correct EntityCellContextMenu shape.
  type GraphCmenuState =
    | {
        kind: 'node';
        x: number;
        y: number;
        nodeId: string;
        nodeTitle?: string | null;
        nodeSummary?: string | null;
        nodeStorylines?: Storyline[];
        hasNarrativeOrder: boolean;
        mainStorylineId: string | null;
      }
    | {
        kind: 'storyline';
        x: number;
        y: number;
        storylineId: string;
      };
  const [contextMenu, setContextMenu] = useState<GraphCmenuState | null>(null);
  const dispatchEntityAction = useEntityCellAction();
  const [edgeMgrOpen, setEdgeMgrOpen] = useState(false);
  const edgeMgrBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!edgeMgrOpen) edgeMgrBtnRef.current?.blur();
  }, [edgeMgrOpen]);
  // Click-to-select edge. While selected, the edge highlights, its two
  // endpoint cards get a solid accent border, and a floating × badge
  // appears at the edge midpoint — click that to delete immediately.
  // Clicking anywhere else deselects.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // "未放置" (unplaced chapters) popover anchored to the head button.
  // Narrative-mode only — the concept doesn't apply in book view.
  const unplacedPopoverRef = useRef<HTMLDivElement>(null);
  const unplacedBtnRef = useRef<HTMLButtonElement>(null);
  // Blur the trigger buttons after the popover/dropdown closes, so
  // they don't keep a :focus-visible outline after an ESC dismiss
  // (browsers flip into keyboard-nav mode once you press ESC and
  // re-evaluate focus-visible against the click-focused button).
  useEffect(() => {
    if (!drawerOpen) unplacedBtnRef.current?.blur();
  }, [drawerOpen]);

  // Dismiss the edge selection on ESC or on any click that doesn't
  // land on an edge / × badge. Edge onClick handlers stopPropagation;
  // the badge's own onClick runs first because it's a descendant of
  // document — by the time this fires, the delete has already kicked
  // off (or the user clicked elsewhere intentionally).
  useEffect(() => {
    if (!selectedEdgeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedEdgeId(null);
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (
        t.closest('.graph-edge-grp') ||
        t.closest('.graph-drift-edge') ||
        t.closest('.graph-edge-delete')
      ) {
        return;
      }
      setSelectedEdgeId(null);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [selectedEdgeId]);

  // Endpoint IDs of the selected edge — used to apply a solid accent
  // border to the two connected tiles / drift cards.
  const selectedEdgeEndpoints = useMemo(() => {
    if (!selectedEdgeId) return null as null | { source: string; target: string };
    const e = nodeEdges.find((edge) => edge.id === selectedEdgeId);
    if (!e) return null;
    return { source: e.sourceNodeId, target: e.targetNodeId };
  }, [selectedEdgeId, nodeEdges]);

  const isEdgeSelected = (edgeId: string) => selectedEdgeId === edgeId;
  const isNodeEdgeSelected = useCallback(
    (nodeId: string) =>
      !!selectedEdgeEndpoints &&
      (selectedEdgeEndpoints.source === nodeId ||
        selectedEdgeEndpoints.target === nodeId),
    [selectedEdgeEndpoints],
  );

  // Outside-click dismissal for the unplaced popover. ESC handling is
  // delegated to the central ESC router above so multiple overlays
  // pop off the stack in LIFO order.
  useEffect(() => {
    if (!drawerOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (unplacedPopoverRef.current?.contains(e.target as Node)) return;
      setDrawerOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [drawerOpen]);

  const isNarrative = viewMode === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';

  // Vertical offset from the scroll content's top to a tile's CENTER y,
  // used only for the SVG edge geometry (tiles themselves are now flow
  // children of their lane row, positioned via `top: TRACK_HEIGHT −
  // TILE_HEIGHT`). The formula `tileTopOffset + node.y` happens to yield
  // the same global tile-center y under both layouts:
  //   book mode  → 0 (no leading axis) + (rowIdx*TRACK_HEIGHT + 112)
  //              = AXIS_HEIGHT + node.y         (with tileTopOffset = AXIS_HEIGHT)
  //   narrative  → AXIS_HEIGHT + (rowIdx*TRACK_HEIGHT + 112)
  //              = AXIS_HEIGHT*2 + node.y       (with tileTopOffset = AXIS_HEIGHT*2)
  // Kept as a derived constant so the SVG / delete-badge code reads the
  // same as it did pre-refactor.
  const tileTopOffset = isNarrative
    ? GRAPH_CONFIG.AXIS_HEIGHT * 2
    : GRAPH_CONFIG.AXIS_HEIGHT;

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  // ESC routing. Overlays opt in to "close self" behavior — when any
  // of them are open, ESC closes the most-recently-opened one. The
  // state is read through a ref so the listener (registered once)
  // always sees fresh values without re-registering on every overlay
  // state change, and there's no stale-closure race against React 18's
  // automatic batching.
  // NodeCardPopover handles its own ESC at capture + stopPropagation,
  // so it's NOT in the candidates here — the event simply never
  // reaches this listener while the popover is open.
  const overlayOpenTimes = useRef<Record<string, number>>({});
  const escStateRef = useRef({
    newEdgePair: null as typeof newEdgePair,
    drawerOpen: false,
    edgeMgrOpen: false,
    driftPanelMounted: false,
    driftPanelClosing: false,
  });
  // Mirror open-state into the ref so the centralized ESC listener
  // (registered once, no closure deps) reads fresh values each ESC.
  useLayoutEffect(() => {
    escStateRef.current = {
      newEdgePair,
      drawerOpen,
      edgeMgrOpen,
      driftPanelMounted,
      driftPanelClosing,
    };
  }, [newEdgePair, drawerOpen, edgeMgrOpen, driftPanelMounted, driftPanelClosing]);
  useLayoutEffect(() => {
    if (newEdgePair) overlayOpenTimes.current.newEdge = Date.now();
  }, [newEdgePair]);
  useLayoutEffect(() => {
    if (drawerOpen) overlayOpenTimes.current.unplaced = Date.now();
  }, [drawerOpen]);
  useLayoutEffect(() => {
    if (edgeMgrOpen) overlayOpenTimes.current.edgeMgr = Date.now();
  }, [edgeMgrOpen]);
  useLayoutEffect(() => {
    if (driftPanelMounted && !driftPanelClosing) overlayOpenTimes.current.drift = Date.now();
  }, [driftPanelClosing, driftPanelMounted]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = escStateRef.current;
      const candidates: Array<[string, boolean, () => void]> = [
        ['newEdge', !!s.newEdgePair, () => setNewEdgePair(null)],
        ['unplaced', s.drawerOpen, () => setDrawerOpen(false)],
        ['edgeMgr', s.edgeMgrOpen, () => setEdgeMgrOpen(false)],
        [
          'drift',
          s.driftPanelMounted && !s.driftPanelClosing,
          () => closeDriftPanelRef.current?.(),
        ],
      ];
      const opened = candidates.filter(([, isOpen]) => isOpen);
      if (opened.length === 0) return;
      // Most-recent-first; the top of the stack closes.
      opened.sort(
        ([a], [b]) =>
          (overlayOpenTimes.current[b] ?? 0) - (overlayOpenTimes.current[a] ?? 0),
      );
      opened[0][2]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Outside-click / Esc dismissal is handled inside EntityCellContextMenu
  // itself, so no separate effect is needed for the graph cmenu state.

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
      const declared = primaryStorylineByNode[node.id] ?? null;
      return declared && sls.some((sl) => sl.id === declared) ? declared : fallback;
    },
    [nodeStorylines, primaryStorylineByNode],
  );

  const orderOf = useCallback(
    (node: BookNode): number | null => {
      const v = node[orderField];
      return typeof v === 'number' ? v : null;
    },
    [orderField],
  );

  const { placedNodes, unplacedNodes, driftNodes } = useMemo(() => {
    const placed: BookNode[] = [];
    const unplaced: BookNode[] = [];
    const drift: BookNode[] = [];
    for (const n of bookNodes) {
      // Drift kind always surfaces in the bottom drift panel only. Chapters
      // without a primary storyline are NOT drift — they belong on the main
      // canvas (in the default lane when no storylines exist, or the 未归属
      // lane when storylines do exist).
      if (isDrift(n)) {
        drift.push(n);
        continue;
      }
      if (orderOf(n) === null) unplaced.push(n);
      else placed.push(n);
    }
    // Drift nodes have no reading-order axis (bookOrder is null) — sort by
    // recency so newly-touched drifts surface, matching DriftPanel.
    drift.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    return { placedNodes: placed, unplacedNodes: unplaced, driftNodes: drift };
  }, [bookNodes, orderOf]);

  const driftIds = useMemo(() => new Set(driftNodes.map((n) => n.id)), [driftNodes]);

  // Whole-project lookup. positionedById only covers storyline nodes that
  // have an order in the current view, so dialogs and edge endpoints that
  // could be drift nodes use this instead.
  const nodeById = useMemo(() => {
    const m = new Map<string, BookNode>();
    for (const n of bookNodes) m.set(n.id, n);
    return m;
  }, [bookNodes]);

  // Lane-based layout: real storylines plus at most one synthetic lane.
  //   storylines.length === 0  →  single "本书" default lane.
  //   storylines.length >= 1   →  always append 未归属 lane (even when empty)
  //                               so drawer drags from "未放置" 未归属
  //                               chapters have a place to land.
  const unaffiliatedChapters = useMemo(() => {
    if (storylines.length === 0) return [] as BookNode[];
    return placedNodes.filter((n) => !primaryStorylineId(n));
  }, [storylines.length, placedNodes, primaryStorylineId]);

  type Lane = { id: string; name: string; color: string; synthetic: boolean };
  const lanesToRender = useMemo<Lane[]>(() => {
    if (storylines.length === 0) {
      return [
        { id: DEFAULT_LANE_ID, name: '本书', color: 'hsl(var(--accent))', synthetic: true },
      ];
    }
    const real: Lane[] = storylines.map((s) => ({
      id: s.id,
      name: s.name || 'Untitled',
      color: s.color || 'hsl(var(--story-4))',
      synthetic: false,
    }));
    real.push({
      id: UNAFFILIATED_LANE_ID,
      name: '未归属',
      color: 'hsl(var(--ink-3))',
      synthetic: true,
    });
    return real;
  }, [storylines]);

  const storylineRowIndex = useMemo(() => {
    const map = new Map<string, number>();
    lanesToRender.forEach((lane, i) => map.set(lane.id, i));
    return map;
  }, [lanesToRender]);

  // Resolves which lane row index a chapter belongs to: its primary if it has
  // one, else the synthetic default/未归属 lane.
  const laneRowForNode = useCallback(
    (node: BookNode): number | undefined => {
      const primary = primaryStorylineId(node);
      if (primary) return storylineRowIndex.get(primary);
      const fallbackLaneId = storylines.length === 0 ? DEFAULT_LANE_ID : UNAFFILIATED_LANE_ID;
      return storylineRowIndex.get(fallbackLaneId);
    },
    [primaryStorylineId, storylineRowIndex, storylines.length],
  );

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
        // Resolve the lane row this chapter belongs to. Chapters without a
        // primary land on the synthetic default/未归属 lane via laneRowForNode.
        const rowIndex = laneRowForNode(node);
        if (rowIndex === undefined) return null;
        const ord = orderOf(node);
        if (ord === null) return null;
        const mainId = primaryStorylineId(node);
        const sl = mainId ? storylineById.get(mainId) ?? null : null;
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
  }, [placedNodes, primaryStorylineId, laneRowForNode, orderOf, storylineById, nodeStorylines, orderToX]);

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

  // Split kinds into two groups so the legend can visually separate them:
  //   · regularKinds — has at least one storyline-only edge; always shown
  //   · driftOnlyKinds — exclusive to drift-touching edges; only shown
  //     while the drift panel is open (the edges themselves only render
  //     in that state, so the toggle is meaningless otherwise)
  // A kind that appears in BOTH drift and storyline edges lives in the
  // regular group — its toggle still hides drift edges of that kind
  // when the panel is open, since `hiddenKinds` is kind-keyed.
  const { regularKinds, driftOnlyKinds } = useMemo(() => {
    type KindInfo = { storyline: boolean; drift: boolean };
    const info = new Map<string | null, KindInfo>();
    for (const e of nodeEdges) {
      const isDriftEdge =
        driftIds.has(e.sourceNodeId) || driftIds.has(e.targetNodeId);
      const cur = info.get(e.kind) ?? { storyline: false, drift: false };
      if (isDriftEdge) cur.drift = true;
      else cur.storyline = true;
      info.set(e.kind, cur);
    }
    const reg = new Set<string>();
    const drift = new Set<string>();
    let hasNullReg = false;
    let hasNullDrift = false;
    for (const [kind, kinfo] of info) {
      if (kinfo.storyline) {
        if (kind === null) hasNullReg = true;
        else reg.add(kind);
      } else {
        if (kind === null) hasNullDrift = true;
        else drift.add(kind);
      }
    }
    const r = [...reg].sort();
    if (hasNullReg) r.push(UNCATEGORIZED_KIND);
    const d = [...drift].sort();
    if (hasNullDrift) d.push(UNCATEGORIZED_KIND);
    return { regularKinds: r, driftOnlyKinds: d };
  }, [nodeEdges, driftIds]);

  const visibleEdges = useMemo(() => {
    const halfTile = (GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT) / 2;
    type LaidEdge = {
      edge: GraphEdge;
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
        color: resolveKindColor(edge.kind),
      });
    }
    return out;
  }, [nodeEdges, positionedById, hiddenKinds, resolveKindColor]);

  // ---- Narrative time pins ----
  // Mirrors BottomTimeline's TimelinePin behavior: integer snap values
  // come from the placed-node range; pins drag against those snaps;
  // dragging shows a transient cursor-following line, and the pin only
  // commits to its new slot on mouseup.
  const snapValues = useMemo(() => {
    if (!isNarrative || placedNodes.length === 0) return [] as number[];
    const lo = Math.floor(orderSpan.min);
    const hi = Math.ceil(orderSpan.max);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [isNarrative, placedNodes.length, orderSpan.min, orderSpan.max]);
  const [pinDragXs, setPinDragXs] = useState<Map<string, number>>(new Map());
  const [newlyAddedPinId, setNewlyAddedPinId] = useState<string | null>(null);
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
  // creation spacing and adjacent tiles sit a single grid unit apart. Shared
  // semantics with BottomTimeline's handleSpread.
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
      log.error('Failed to spread graph nodes', err);
    }
  }, [placedNodes, orderOf, updateNode, orderField]);

  const handleAddPin = useCallback(() => {
    if (!isNarrative || snapValues.length === 0) return;
    const canvas = canvasRef.current;
    let target = snapValues[0];
    if (canvas) {
      const centerContentX = canvas.scrollLeft + canvas.clientWidth / 2;
      let bestDist = Infinity;
      for (const s of snapValues) {
        const d = Math.abs(orderToX(s) - centerContentX);
        if (d < bestDist) {
          bestDist = d;
          target = s;
        }
      }
    }
    const created = addMarker(target, '标记');
    if (created) setNewlyAddedPinId(created.id);
  }, [isNarrative, snapValues, addMarker, orderToX]);

  // ---- Drag / drop ----
  // Both book and narrative views support tile drag-to-reorder; the
  // `orderField` (bookOrder | narrativeOrder) decides which value the drop
  // mutates. Drags originating from the narrative-view "未放置" drawer are
  // additionally constrained to the node's primary storyline row (mirrors
  // BottomTimeline's UX) so the canvas doesn't accept ambiguous placements.
  const [draggedNode, setDraggedNode] = useState<BookNode | null>(null);
  const [draggedFromDrawer, setDraggedFromDrawer] = useState(false);
  const [dragOver, setDragOver] = useState<{
    order: number;
    storylineId: string | null;
    // Cursor X in scroll-content coords (includes RAIL_WIDTH + the
    // intentional left padding). Drives the drop indicator so it tracks
    // the cursor / drag ghost rather than the snapped tile-left position.
    indicatorX: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Refs into every rendered tile / drift card so the fixed-position drift
  // edge SVG can read live viewport rects via getBoundingClientRect. Tiles
  // live in scrolling canvas-content coordinates; drift cards live in fixed
  // panel-viewport coordinates — both are normalized to viewport here.
  const tileRefs = useRef(new Map<string, HTMLDivElement>());
  const driftCardRefs = useRef(new Map<string, HTMLDivElement>());
  // The drift card row scrolls horizontally inside .drift-panel__hand;
  // the drift-edge SVG sits in viewport coordinates, so we need to
  // recompute endpoint geometry whenever the row scrolls (otherwise the
  // edges visibly lag the cards as you scroll sideways).
  const driftHandRef = useRef<HTMLDivElement | null>(null);

  // Drift card reorder. Reuses bookOrder values: we permute the bookOrders
  // that already belong to the drift set so the resulting integers don't
  // collide with placed-node orders. `dropTargetIndex` is the *insertion*
  // index in the post-removal list (so it ranges 0..driftNodes.length).
  const [draggedDrift, setDraggedDrift] = useState<{ id: string; index: number } | null>(null);
  const [driftDropIndex, setDriftDropIndex] = useState<number | null>(null);

  // macOS-Dock-style reorder. Live shifts (inline transform via render-
  // time computation) make neighbour cards slide aside DURING the drag,
  // anchored by `draggedDrift` + `driftDropIndex`. On drop, the dragged
  // card's pre-commit rect is stashed so a brief FLIP can settle it into
  // its new slot — the other cards land in place naturally because their
  // pre-commit shifted positions equal their post-commit DOM slots.
  const draggedIdAtDropRef = useRef<string | null>(null);
  const draggedCardRectAtDropRef = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const id = draggedIdAtDropRef.current;
    const prevRect = draggedCardRectAtDropRef.current;
    draggedIdAtDropRef.current = null;
    draggedCardRectAtDropRef.current = null;
    if (!id || !prevRect) return;
    const el = driftCardRefs.current.get(id);
    if (!el) return;
    const newRect = el.getBoundingClientRect();
    const dx = prevRect.left - newRect.left;
    const dy = prevRect.top - newRect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.style.opacity = '1';
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s';
      el.style.transform = '';
    });
  }, [driftNodes]);

  const computeDriftShift = useCallback(
    (index: number): string => {
      if (!draggedDrift || driftDropIndex == null) return '';
      if (index === draggedDrift.index) return '';
      const from = draggedDrift.index;
      const to = driftDropIndex;
      if (from < to && index > from && index < to)
        return `translateX(-${DRIFT_SLOT_WIDTH}px)`;
      if (from > to && index >= to && index < from)
        return `translateX(${DRIFT_SLOT_WIDTH}px)`;
      return '';
    },
    [draggedDrift, driftDropIndex],
  );

  // Wrap the shared close-panel callback so it ALSO clears the drag-reorder
  // state when the panel slides out. The base close (from useDriftPanelAnim)
  // is generic; StoryGraphView's drift cards layer drag-and-drop on top, and we
  // don't want a half-finished drag lingering once the panel comes back.
  const closeDriftPanel = useCallback(() => {
    setDraggedDrift(null);
    setDriftDropIndex(null);
    closeDriftPanelBase();
  }, [closeDriftPanelBase]);

  // Drift edges that touch at least one drift endpoint. Other edges are
  // already handled by `visibleEdges` (which skips them because drift nodes
  // aren't in `positionedById`).
  type DriftEdgeGeom = {
    id: string;
    kind: string | null;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
  };
  const [driftEdgeGeom, setDriftEdgeGeom] = useState<DriftEdgeGeom[]>([]);

  // Recompute viewport-space endpoints for every drift edge while the drift
  // panel is mounted: an rAF loop captures the open/close slide animation and
  // any tile movement; scroll + resize listeners cover everything afterward.
  // Cheap — each tick reads a handful of bounding rects.
  useLayoutEffect(() => {
    if (!driftPanelMounted) return;
    let raf = 0;
    let stopRaf = false;
    const recompute = () => {
      const out: DriftEdgeGeom[] = [];
      for (const edge of nodeEdges) {
        const srcIsDrift = driftIds.has(edge.sourceNodeId);
        const tgtIsDrift = driftIds.has(edge.targetNodeId);
        if (!srcIsDrift && !tgtIsDrift) continue;
        // Respect kind-toggle visibility: when the user hides a kind via
        // a legend chip, drift edges of that kind drop out of the SVG
        // too. Storyline edges are filtered in `visibleEdges` the same
        // way; this keeps the two paths consistent.
        const filterKey = edge.kind ?? UNCATEGORIZED_KIND;
        if (hiddenKinds.has(filterKey)) continue;
        const srcEl =
          driftCardRefs.current.get(edge.sourceNodeId) ??
          tileRefs.current.get(edge.sourceNodeId);
        const tgtEl =
          driftCardRefs.current.get(edge.targetNodeId) ??
          tileRefs.current.get(edge.targetNodeId);
        if (!srcEl || !tgtEl) continue;
        const r1 = srcEl.getBoundingClientRect();
        const r2 = tgtEl.getBoundingClientRect();
        // Color precedence:
        //   1. Per-kind override (from the edge-management menu) — when
        //      the user assigns a kind color, drift edges of that kind
        //      should match.
        //   2. Storyline-side endpoint's color — the default look ties
        //      drift edges visually to whichever track they land on.
        //   3. --accent fallback for drift↔drift links.
        const srcPos = positionedById.get(edge.sourceNodeId);
        const tgtPos = positionedById.get(edge.targetNodeId);
        const k = edge.kind ?? UNCATEGORIZED_META_KEY;
        const override = edgeKindMeta.meta[k]?.color;
        const storylineColor =
          override ||
          srcPos?.storyline?.color ||
          tgtPos?.storyline?.color ||
          'hsl(var(--accent))';
        out.push({
          id: edge.id,
          kind: edge.kind,
          x1: r1.left + r1.width / 2,
          y1: r1.top + r1.height / 2,
          x2: r2.left + r2.width / 2,
          y2: r2.top + r2.height / 2,
          color: storylineColor,
        });
      }
      setDriftEdgeGeom(out);
    };
    const tick = () => {
      if (stopRaf) return;
      recompute();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Stop the rAF loop after the slide animation settles; rely on
    // scroll/resize listeners thereafter to keep the geometry fresh.
    const stopTimer = window.setTimeout(() => {
      stopRaf = true;
      cancelAnimationFrame(raf);
    }, 500);
    const onScrollOrResize = () => recompute();
    window.addEventListener('resize', onScrollOrResize);
    const canvas = canvasRef.current;
    canvas?.addEventListener('scroll', onScrollOrResize);
    const driftHand = driftHandRef.current;
    driftHand?.addEventListener('scroll', onScrollOrResize);
    return () => {
      stopRaf = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(stopTimer);
      window.removeEventListener('resize', onScrollOrResize);
      canvas?.removeEventListener('scroll', onScrollOrResize);
      driftHand?.removeEventListener('scroll', onScrollOrResize);
    };
  }, [driftPanelMounted, nodeEdges, driftIds, positionedById, hiddenKinds, edgeKindMeta.meta]);

  const draggedMainStorylineId = useMemo(
    () => (draggedNode ? primaryStorylineId(draggedNode) : null),
    [draggedNode, primaryStorylineId],
  );

  const canDropOnStoryline = useCallback(
    (storylineId: string | null) => {
      if (!draggedNode) return false;
      if (storylineId === DEFAULT_LANE_ID) return true;
      if (storylineId === UNAFFILIATED_LANE_ID) {
        // Drawer drag: only 未归属 chapters belong in 未归属. A chapter
        // with a primary storyline shouldn't escape to the orphan lane
        // through a narrative-axis placement; the dedicated 转移至未归属
        // context-menu action covers that intent for axis-to-axis drags.
        if (draggedFromDrawer) return draggedMainStorylineId == null;
        return true;
      }
      if (!draggedFromDrawer) return true;
      // Drawer drag with no primary (unaffiliated chapter) is allowed on
      // any real storyline — the drop handler promotes the target to
      // primary. Mirrors BottomTimeline's canDropOnStoryline.
      if (draggedMainStorylineId == null) return true;
      return storylineId === draggedMainStorylineId;
    },
    [draggedNode, draggedFromDrawer, draggedMainStorylineId],
  );

  const handleTileDragStart = (e: React.DragEvent, node: BookNode) => {
    setDraggedNode(node);
    setDraggedFromDrawer(false);
    e.dataTransfer.effectAllowed = 'move';
    // Pin the drag image's grab point to the tile's center so the ghost
    // tracks the cursor at the SAME spot the drop logic snaps to. Without
    // this the ghost follows whatever (x, y) the user clicked on (e.g.
    // bottom-right corner) while the drop centers the tile on the
    // cursor — the two visuals drift apart.
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    e.dataTransfer.setDragImage(el, rect.width / 2, rect.height / 2);
  };

  const handleChipDragStart = (e: React.DragEvent, node: BookNode) => {
    setDraggedNode(node);
    setDraggedFromDrawer(true);
    e.dataTransfer.effectAllowed = 'move';
    // Same recipe as tile drags: anchor the chip ghost at its center so
    // the drag preview aligns with the drop indicator over the tracks.
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    e.dataTransfer.setDragImage(el, rect.width / 2, rect.height / 2);
  };

  // Map a mouse Y (in scroll-content coordinates) to the lane whose row
  // contains it. Returns null when above the axis or below the last row.
  // Synthetic lane ids (DEFAULT_LANE_ID / UNAFFILIATED_LANE_ID) are valid
  // drop targets and resolve like any other lane.
  const storylineAtY = useCallback(
    (yInContent: number): string | null => {
      const offset = isNarrative ? GRAPH_CONFIG.AXIS_HEIGHT : 0;
      const relative = yInContent - offset;
      if (relative < 0) return null;
      const idx = Math.floor(relative / GRAPH_CONFIG.TRACK_HEIGHT);
      if (idx < 0 || idx >= lanesToRender.length) return null;
      return lanesToRender[idx]?.id ?? null;
    },
    [isNarrative, lanesToRender],
  );

  const handleTracksDragOver = (e: React.DragEvent) => {
    if (!draggedNode || !canvasRef.current) return;
    const scroll = canvasRef.current;
    const rect = scroll.getBoundingClientRect();
    // Cursor X in full scroll-content coords (includes the sticky rail
    // width on the left). Used directly as the drop-indicator left so
    // the indicator tracks the cursor.
    const cursorContentX = e.clientX - rect.left + scroll.scrollLeft;
    // Subtract RAIL_WIDTH + CANVAS_PADDING_X to get the cursor X within
    // the track-cell's order grid. Snap on the *center* of the dropped
    // tile rather than its left edge: the drag ghost is centered on the
    // cursor, so centering the drop keeps ghost + indicator + final
    // tile visually aligned.
    const cursorTrackX =
      cursorContentX - GRAPH_CONFIG.RAIL_WIDTH - GRAPH_CONFIG.CANVAS_PADDING_X;
    const tileWidth = GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT;
    const tileLeftTrackX = cursorTrackX - tileWidth / 2;
    const order = Math.max(
      orderSpan.min,
      Math.round(tileLeftTrackX / GRAPH_CONFIG.GRID_UNIT) + orderSpan.min,
    );
    const yInContent = e.clientY - rect.top + scroll.scrollTop;
    const storylineId = storylineAtY(yInContent);
    if (!canDropOnStoryline(storylineId)) {
      // Drawer drag landed on a non-primary row — implicit reject (don't
      // preventDefault, don't surface a drop indicator).
      setDragOver(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver({ order, storylineId, indicatorX: cursorContentX });
  };

  const handleTracksDrop = async (e: React.DragEvent) => {
    if (!draggedNode || !dragOver) return;
    if (!canDropOnStoryline(dragOver.storylineId)) return;
    e.preventDefault();
    try {
      const currentMain = draggedMainStorylineId;
      const targetRow = dragOver.storylineId;

      if (targetRow === DEFAULT_LANE_ID) {
        // Single-lane mode — only reorder, no storyline membership change.
        await updateNode(draggedNode.id, { [orderField]: dragOver.order });
      } else if (targetRow === UNAFFILIATED_LANE_ID) {
        // Drag INTO 未归属 = clear primary + clear all other memberships per
        // the "no auto-fallback" rule. Null the primary first so
        // setNodeStorylines doesn't auto-pin it back into the membership set.
        await updateNode(draggedNode.id, { mainStorylineId: null });
        await setNodeStorylines(draggedNode.id, []);
        await updateNode(draggedNode.id, { [orderField]: dragOver.order });
      } else if (targetRow && targetRow !== currentMain) {
        // Real-row → real-row reroute. Two cases collapsed into one:
        //   (a) target already a secondary membership → promote it
        //   (b) target is brand new → promote it AND drop the source
        //       membership so the chapter physically moves to its new
        //       lane (mirrors BottomTimeline's drag semantics).
        // Drawer drags only land here when canDropOnStoryline allows
        // (drawer → main row), so no fromDrawer guard needed.
        //
        // To avoid a flicker of a multi-storyline membership — which would
        // briefly draw a dashed cross-storyline edge — we replace the
        // membership set in a SINGLE state apply via setNodeStorylines and
        // override its auto-pin to point at the new target. The follow-up
        // updateNode call brings the store's primary state into agreement
        // with the link table; in between, primaryStorylineId() falls back
        // to the only membership (target), so nothing observably wrong
        // renders.
        const existingMemberIds = nodeStorylines(draggedNode.id).map((sl) => sl.id);
        const nextMemberIds = existingMemberIds.includes(targetRow)
          ? existingMemberIds.filter((id) => id !== currentMain)
          : existingMemberIds
              .filter((id) => id !== currentMain)
              .concat(targetRow);
        await setNodeStorylines(draggedNode.id, nextMemberIds, {
          primaryStorylineId: targetRow,
        });
        await updateNode(draggedNode.id, {
          [orderField]: dragOver.order,
          mainStorylineId: targetRow,
        });
      } else {
        await updateNode(draggedNode.id, { [orderField]: dragOver.order });
      }
    } catch (err) {
      log.error('Failed to update order on drop', err);
    } finally {
      setDraggedNode(null);
      setDraggedFromDrawer(false);
      setDragOver(null);
    }
  };

  const handleDragEnd = () => {
    setDraggedNode(null);
    setDraggedFromDrawer(false);
    setDragOver(null);
  };

  // Drift cards used to persist their order by permuting bookOrder, but
  // drift no longer carries bookOrder at all — that axis is chapter-only.
  // The drag UX is kept so a future drift-order axis (e.g. a dedicated
  // sort_key on DriftNode) can re-wire persistence here without touching
  // the renderer. For now the drop is a visual no-op: drift cards always
  // re-sort by updatedAt on the next render.
  const commitDriftReorder = useCallback(async () => {
    setDraggedDrift(null);
    setDriftDropIndex(null);
  }, []);

  const totalsLabel = `${storylines.length} ${storylines.length === 1 ? '故事线' : '故事线'} · ${placedNodes.length}/${bookNodes.length} 章`;

  const renderKindChip = (kind: string) => {
    const isUncategorized = kind === UNCATEGORIZED_KIND;
    const label = isUncategorized ? '未分类' : kind;
    const color = resolveKindColor(isUncategorized ? null : kind);
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
  };

  return (
    <div className="graph-overlay" data-view={viewMode}>
      <SuperViewHeader
        title="叙事结构图"
        meta={totalsLabel}
        onBack={close}
        leftSlot={
          <>
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
            <button
              type="button"
              className="graph-head__spread-btn"
              disabled={placedNodes.length < 2}
              onClick={() => {
                void handleSpread();
              }}
              title={
                placedNodes.length < 2
                  ? '至少两个章节才能打散'
                  : `打散：把${isNarrative ? '叙事时' : '书序'}重排，让重叠的节点拉开间距`
              }
              aria-label="打散节点"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden
              >
                <line x1="3" y1="8" x2="1.5" y2="8" />
                <line x1="14.5" y1="8" x2="13" y2="8" />
                <path d="M4 5l-2 3 2 3" />
                <path d="M12 5l2 3-2 3" />
                <line x1="7" y1="8" x2="9" y2="8" />
              </svg>
              <span>打散</span>
            </button>

            {/* Unplaced chapters — narrative mode only. Same role as the
                equivalent control in BottomTimeline: surface chapters
                that have no narrativeOrder yet so they can be dragged
                into a track. Renders as a popover anchored to the head
                button rather than the old below-head drawer. */}
            {isNarrative && (
              <div
                className="graph-head__unplaced super-view-head__no-drag"
                ref={unplacedPopoverRef}
              >
                <button
                  ref={unplacedBtnRef}
                  type="button"
                  className={`graph-head__unplaced-btn${drawerOpen ? ' is-open' : ''}`}
                  onClick={() => setDrawerOpen((v) => !v)}
                  title="未放置的章节（拖入下方时间轴）"
                  aria-haspopup="menu"
                  aria-expanded={drawerOpen}
                >
                  <span>未放置</span>
                  <span className="graph-head__unplaced-count">{unplacedNodes.length}</span>
                </button>
                {drawerOpen && (
                  <div
                    className="graph-head__unplaced-popover super-view-head__no-drag"
                    role="menu"
                  >
                    {unplacedNodes.length === 0 ? (
                      <div className="graph-head__unplaced-empty">
                        所有章节都在叙事时间轴上
                      </div>
                    ) : (
                      unplacedNodes.map((node) => {
                        const primaryId = primaryStorylineId(node);
                        const sl = primaryId ? storylineById.get(primaryId) : null;
                        const color = sl?.color || 'hsl(var(--ink-4))';
                        return (
                          <div
                            key={node.id}
                            className="graph-head__unplaced-chip"
                            draggable
                            onDragStart={(e) => handleChipDragStart(e, node)}
                            onDragEnd={handleDragEnd}
                            style={{ ['--chip-color' as string]: color } as React.CSSProperties}
                            title={node.title || '未命名'}
                          >
                            <span className="graph-head__unplaced-chip-dot" />
                            <span className="graph-head__unplaced-chip-num">
                              § {String(node.bookOrder).padStart(2, '0')}
                            </span>
                            <span className="graph-head__unplaced-chip-title">
                              {node.title || '未命名'}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        }
        rightSlot={
          // Layout left → right:
          //   · hint chip — only when there are no user edges
          //   · drift-only kind chips — only when drift panel is open; sit
          //     to the LEFT of regular chips, separated by a small
          //     whitespace gap (the wrapping container's gap)
          //   · regular kind chips — toggleable; visible whenever the kind
          //     has at least one storyline-only edge
          //   · edge-management button — rightmost; opens a dropdown where
          //     users can rename / recolor / delete kinds, and where the
          //     storyline-transit legend lives in locked read-only form
          <>
            {nodeEdges.length === 0 && (
              <div className="graph-head__filters">
                <div
                  className="graph-head__filter is-hint"
                  title="按住 Shift 点击两个节点即可建立关联"
                >
                  Shift + 点击两节点 = 创建关联
                </div>
              </div>
            )}
            {driftPanelOpen && driftOnlyKinds.length > 0 && (
              <div className="graph-head__filters">
                {driftOnlyKinds.map((kind) => renderKindChip(kind))}
              </div>
            )}
            {regularKinds.length > 0 && (
              <div className="graph-head__filters">
                {regularKinds.map((kind) => renderKindChip(kind))}
              </div>
            )}
            <div className="graph-head__edge-mgr-wrap super-view-head__no-drag">
              <button
                ref={edgeMgrBtnRef}
                type="button"
                className={`graph-head__edge-mgr-btn${edgeMgrOpen ? ' is-open' : ''}`}
                onClick={() => setEdgeMgrOpen((v) => !v)}
                title="管理关联类型"
                aria-haspopup="menu"
                aria-expanded={edgeMgrOpen}
              >
                <span aria-hidden>≡</span>
                <span>类型</span>
              </button>
              <EdgeKindManager
                open={edgeMgrOpen}
                onClose={() => setEdgeMgrOpen(false)}
                anchorRef={edgeMgrBtnRef}
                kinds={[...regularKinds, ...driftOnlyKinds]}
                resolveKindColor={resolveKindColor}
                setKindColor={edgeKindMeta.setColor}
                clearKindColor={edgeKindMeta.clearColor}
                reassignMeta={edgeKindMeta.reassign}
                removeMeta={edgeKindMeta.remove}
                nodeEdges={entityRelations.filter(
                  (r) => r.fromKind === 'node' && r.toKind === 'node',
                )}
                updateEdgeKind={updateEdgeKind}
                deleteEdge={deleteEdge}
              />
            </div>
          </>
        }
      />

      <div className="graph-body">
        {/* Book-mode reading-order summary. Sibling of (not inside) the
            scroll container so its own horizontal scroll stays independent
            of the storyline tracks — chips are packed in book order, not
            positioned by it, so scrolling them shouldn't move the rows
            beneath and vice versa. Matches BottomTimeline's placement. */}
        {!isNarrative && (
          <FullBookLane
            nodes={placedNodes}
            storylines={storylines}
            primaryStorylineId={(n) => primaryStorylineId(n)}
            activeNodeId={null}
            trackOffsetX={GRAPH_CONFIG.RAIL_WIDTH}
            onNodeClick={(id) => {
              const target = positionedNodes.find((n) => n.id === id);
              const scroll = canvasRef.current;
              if (!target || !scroll) return;
              const tileW = GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT;
              const left =
                GRAPH_CONFIG.RAIL_WIDTH +
                target.x +
                tileW / 2 -
                scroll.clientWidth / 2;
              scroll.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
            }}
            height={GRAPH_CONFIG.FULL_BOOK_LANE_HEIGHT}
            railLabel="阅读"
          />
        )}

        {/* Single scroll container for the whole grid (vertical for
            many storylines, horizontal for many chapters). Rail labels
            stick to the left via `position: sticky` so they stay aligned
            with their tracks at all scroll positions. The narrative
            axis row stickies to the top. No JS sync; no height-spacer
            hacks — the layout is genuinely one surface. */}
        <div
          ref={canvasRef}
          className="graph-scroll"
          onDragOver={handleTracksDragOver}
          onDrop={handleTracksDrop}
          onContextMenu={(e) => {
            // Tile/rail handlers stopPropagation, so this only fires
            // on empty track area. Map cursor → lane and open the
            // same storyline cmenu the rail uses (synthetic lanes
            // have no entity behind them, so silently skip).
            const scroll = canvasRef.current;
            if (!scroll) return;
            const rect = scroll.getBoundingClientRect();
            const yInContent = e.clientY - rect.top + scroll.scrollTop;
            const sid = storylineAtY(yInContent);
            if (!sid || sid === DEFAULT_LANE_ID || sid === UNAFFILIATED_LANE_ID) {
              return;
            }
            e.preventDefault();
            setContextMenu({
              kind: 'storyline',
              x: e.clientX + 2,
              y: e.clientY - 2,
              storylineId: sid,
            });
          }}
        >
          {/* Narrative time-axis row — sticky-top.
              Rail cell is sticky-left + sticky-top (the corner); the
              track cell carries the draggable pin heads/labels. */}
          {isNarrative && (
            <div
              className="graph-axis-row"
              style={{ height: GRAPH_CONFIG.AXIS_HEIGHT }}
            >
              <div
                className="graph-axis-rail-cell"
                style={{ width: GRAPH_CONFIG.RAIL_WIDTH }}
                title="叙事时间标记：点击 + 添加可拖动的时间 pin"
              >
                <span className="graph-rail__axis-name">时间</span>
                <button
                  type="button"
                  className="graph-rail__axis-add"
                  disabled={snapValues.length === 0}
                  title={snapValues.length === 0 ? '需要至少一个章节才能添加 pin' : '添加时间 pin'}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddPin();
                  }}
                >
                  +
                </button>
              </div>
              <div
                className="graph-axis-track-cell"
                style={{ width: canvasContentWidth }}
              >
                {markers
                  .filter(
                    (m) =>
                      m.narrativeOrder >= orderSpan.min &&
                      m.narrativeOrder <= orderSpan.max,
                  )
                  .map((m) => (
                    <GraphTimelinePin
                      key={`pin-${m.id}`}
                      marker={m}
                      snapValues={snapValues}
                      orderToX={orderToX}
                      pinHeight={GRAPH_CONFIG.AXIS_HEIGHT}
                      isDragging={pinDragXs.has(m.id)}
                      editOnMount={m.id === newlyAddedPinId}
                      onChange={(patch) => {
                        if (m.id === newlyAddedPinId) setNewlyAddedPinId(null);
                        updateMarker(m.id, patch);
                      }}
                      onDelete={() => {
                        if (m.id === newlyAddedPinId) setNewlyAddedPinId(null);
                        deleteMarker(m.id);
                      }}
                      onDragMove={(nextX) => handlePinDragMove(m.id, nextX)}
                    />
                  ))}
              </div>
            </div>
          )}

          {/* Vertical pin lines spanning every lane row (narrative only).
              Absolute children of the scroll container; left is in scroll
              content coords (so we add RAIL_WIDTH to the track-relative
              orderToX value). Explicit `height` because absolute children
              of `.graph-scroll` only see its viewport height, not its
              scrollHeight — `bottom: 0` alone would clip vertically. */}
          {isNarrative &&
            markers.map((m) => {
              const dragX = pinDragXs.get(m.id);
              const isDragging = dragX !== undefined;
              const x = dragX ?? orderToX(m.narrativeOrder);
              return (
                <div
                  key={`pinline-${m.id}`}
                  className={`graph-pin-line${isDragging ? ' is-dragging' : ''}`}
                  style={{
                    left: GRAPH_CONFIG.RAIL_WIDTH + x,
                    height:
                      GRAPH_CONFIG.AXIS_HEIGHT +
                      lanesToRender.length * GRAPH_CONFIG.TRACK_HEIGHT,
                  }}
                  aria-hidden
                />
              );
            })}

          {/* Lane rows — each is a flex row of [sticky-left rail cell |
              track cell with tiles]. The vertical scroll naturally moves
              both halves together because they share the same scroll
              container. */}
          {lanesToRender.map((lane, rowIdx) => {
            const laneNodes =
              lane.id === DEFAULT_LANE_ID
                ? placedNodes
                : lane.id === UNAFFILIATED_LANE_ID
                  ? unaffiliatedChapters
                  : (sortedNodesByStoryline.get(lane.id) ?? []);
            const tilesInLane = positionedNodes.filter(
              (n) => n.rowIndex === rowIdx,
            );
            const dimmed =
              !!draggedNode && draggedFromDrawer && !canDropOnStoryline(lane.id);
            return (
              <div
                key={lane.id}
                className={`graph-lane-row${dimmed ? ' is-drop-disabled' : ''}${
                  lane.synthetic ? ' is-synthetic' : ''
                }`}
                style={
                  {
                    height: GRAPH_CONFIG.TRACK_HEIGHT,
                    ['--track-color' as string]: lane.color,
                  } as React.CSSProperties
                }
              >
                <div
                  className="graph-rail-cell"
                  style={{ width: GRAPH_CONFIG.RAIL_WIDTH }}
                  onContextMenu={(e) => {
                    if (lane.synthetic) {
                      e.preventDefault();
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({
                      kind: 'storyline',
                      x: e.clientX + 2,
                      y: e.clientY - 2,
                      storylineId: lane.id,
                    });
                  }}
                >
                  <div className="graph-rail__name">
                    <span
                      className="graph-rail__name-dot"
                      style={{ background: lane.color }}
                    />
                    <span>{lane.name}</span>
                  </div>
                  <div className="graph-rail__meta">{laneNodes.length} 章</div>
                </div>
                <div
                  className="graph-track-cell"
                  style={{ width: canvasContentWidth }}
                >
                  {tilesInLane.map((node) => {
                    const status = node.writingStatus;
                    const isDiscarded = status === 'discarded';
                    const isDraft = !isDiscarded && status !== 'finished';
                    const color = node.storyline?.color || 'hsl(var(--story-4))';
                    const isLinkSource = linkSource === node.id;
                    return (
                      <div
                        key={node.id}
                        ref={(el) => {
                          if (el) tileRefs.current.set(node.id, el);
                          else tileRefs.current.delete(node.id);
                        }}
                        className={[
                          'graph-tile',
                          isDraft ? 'is-draft' : '',
                          isDiscarded ? 'is-discarded' : '',
                          isLinkSource ? 'is-link-source' : '',
                          isNodeEdgeSelected(node.id) ? 'is-edge-selected' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        draggable
                        onDragStart={(e) => handleTileDragStart(e, node)}
                        onDragEnd={handleDragEnd}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setContextMenu({
                            kind: 'node',
                            x: e.clientX + 2,
                            y: e.clientY - 2,
                            nodeId: node.id,
                            nodeTitle: node.title,
                            nodeSummary: node.summary,
                            nodeStorylines: node.storylines,
                            hasNarrativeOrder: typeof node.narrativeOrder === 'number',
                            mainStorylineId: node.storyline?.id ?? null,
                          });
                        }}
                        onClick={(e) => {
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
                          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                          setPopover({
                            nodeId: node.id,
                            anchor: {
                              left: rect.left,
                              top: rect.top,
                              width: rect.width,
                              height: rect.height,
                            },
                          });
                        }}
                        onDoubleClick={() => {
                          openEntity({ entityType: 'node', id: node.id }, { preview: false });
                          close();
                        }}
                        style={
                          {
                            left: node.x,
                            // Tile sits flush with the bottom of its lane:
                            // top = TRACK_HEIGHT − TILE_HEIGHT. Leaves the
                            // upper half empty so the dotted reading line
                            // at the lane's vertical center traces along
                            // the tile's upper edge (book-mode look).
                            top: GRAPH_CONFIG.TRACK_HEIGHT - GRAPH_CONFIG.TILE_HEIGHT,
                            width: GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT,
                            height: GRAPH_CONFIG.TILE_HEIGHT,
                            ['--tile-color' as string]: color,
                          } as React.CSSProperties
                        }
                        title={`${node.title || '未命名'} · ${node.wordCount ?? 0} 字`}
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
            );
          })}

          {/* Cross-storyline trails + user-authored relation edges.
              Absolute SVG overlay; positioned at left=RAIL_WIDTH so its
              internal x coords match the track-relative orderToX values
              (no rail offset needed inside path d). y coords are in
              scroll-content space — same formula as before, because the
              global tile-center Y equals tileTopOffset + node.y in both
              the old and the new layout. */}
          {(crossLinks.length > 0 || visibleEdges.length > 0) && (
            <svg
              className="graph-edges"
              width={canvasContentWidth}
              height={
                (isNarrative ? GRAPH_CONFIG.AXIS_HEIGHT : 0) +
                lanesToRender.length * GRAPH_CONFIG.TRACK_HEIGHT
              }
              style={{ top: 0, left: GRAPH_CONFIG.RAIL_WIDTH }}
            >
              {crossLinks.map((link) => {
                const y1 = tileTopOffset + link.fromY;
                const y2 = tileTopOffset + link.toY;
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
              {visibleEdges.map(({ edge, x1, y1, x2, y2, color }) => {
                const yy1 = tileTopOffset + y1;
                const yy2 = tileTopOffset + y2;
                const midY = (yy1 + yy2) / 2;
                const d = `M ${x1} ${yy1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${yy2}`;
                const selected = isEdgeSelected(edge.id);
                return (
                  <g
                    key={edge.id}
                    className={`graph-edge-grp${selected ? ' is-selected' : ''}`}
                  >
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth="10"
                      fill="none"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEdgeId(edge.id);
                      }}
                    >
                      <title>{edge.kind ?? '未分类'}</title>
                    </path>
                    <path
                      d={d}
                      stroke={color}
                      strokeWidth={selected ? 2.4 : 1.8}
                      fill="none"
                      opacity={selected ? 1 : 0.85}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                );
              })}
            </svg>
          )}

          {/* Floating × badge at the midpoint of the selected storyline
              edge. Click → delete immediately. Left is in scroll-content
              coords, so we add RAIL_WIDTH to the SVG's track-relative
              midX. */}
          {selectedEdgeId &&
            (() => {
              const sel = visibleEdges.find((v) => v.edge.id === selectedEdgeId);
              if (!sel) return null;
              const yy1 = tileTopOffset + sel.y1;
              const yy2 = tileTopOffset + sel.y2;
              const midX = (sel.x1 + sel.x2) / 2;
              const midY = (yy1 + yy2) / 2;
              return (
                <button
                  type="button"
                  className="graph-edge-delete"
                  style={{ left: GRAPH_CONFIG.RAIL_WIDTH + midX, top: midY }}
                  title="删除关联"
                  onClick={(e) => {
                    e.stopPropagation();
                    const id = selectedEdgeId;
                    setSelectedEdgeId(null);
                    void deleteEdge(id);
                  }}
                  aria-label="删除关联"
                >
                  ×
                </button>
              );
            })()}

          {/* Drop indicator while dragging — `indicatorX` is already the
              cursor's full scroll-content x (includes the rail), so it
              positions directly without an extra offset. */}
          {dragOver && draggedNode && dragOver.storylineId && (() => {
            const rowIdx = storylineRowIndex.get(dragOver.storylineId) ?? 0;
            const rowStoryline = storylineById.get(dragOver.storylineId);
            return (
              <div
                className="graph-drop-indicator"
                style={{
                  left: dragOver.indicatorX,
                  top: (isNarrative ? GRAPH_CONFIG.AXIS_HEIGHT : 0) + rowIdx * GRAPH_CONFIG.TRACK_HEIGHT,
                  height: GRAPH_CONFIG.TRACK_HEIGHT,
                  background: rowStoryline?.color || 'hsl(var(--accent))',
                }}
              />
            );
          })()}
        </div>
      </div>

      {/* ---------------- Drift drawer (floating, bottom-center) ----------------
          Shared shell with SuperElementView via <DriftPanel>. The cards
          rendered as children keep StoryGraphView's drag-and-drop reorder + edge-
          selection visual language; the hand-level drop handler is passed
          through handDragHandlers. */}
      <DriftPanel
        count={driftNodes.length}
        mounted={driftPanelMounted}
        open={driftPanelOpen}
        closing={driftPanelClosing}
        onOpen={openDriftPanel}
        onClose={closeDriftPanel}
        closeDisabled={driftPanelClosing}
        panelAriaHidden={!driftPanelOpen || driftPanelClosing}
        handRef={driftHandRef}
        handDragHandlers={{
          onDragOver: (e) => {
            // Drop in empty space at the ends — per-card handlers cover
            // the between-cards case.
            if (!draggedDrift) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          },
          onDrop: (e) => {
            if (!draggedDrift) return;
            e.preventDefault();
            // Snapshot dragged card rect for the FLIP settle.
            const draggedEl = driftCardRefs.current.get(draggedDrift.id);
            if (draggedEl) {
              draggedIdAtDropRef.current = draggedDrift.id;
              draggedCardRectAtDropRef.current = draggedEl.getBoundingClientRect();
            }
            void commitDriftReorder();
          },
        }}
      >
        {driftNodes.length === 0 ? (
          <div className="drift-card__empty">
            还没有浮缀卡片 · 在左侧 Drift 面板新建灵感笔记
          </div>
        ) : (
          driftNodes.map((node, index) => {
            const isLinkSource = linkSource === node.id;
            const isDragged = draggedDrift?.id === node.id;
            const isResting = node.writingStatus === 'resting';
            const shift = computeDriftShift(index);
            return (
              <div
                key={node.id}
                ref={(el) => {
                  if (el) driftCardRefs.current.set(node.id, el);
                  else driftCardRefs.current.delete(node.id);
                }}
                className={[
                  'drift-card',
                  isLinkSource ? 'is-link-source' : '',
                  isDragged ? 'is-dragged' : '',
                  isResting ? 'is-resting' : '',
                  isNodeEdgeSelected(node.id) ? 'is-edge-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  transform: shift || undefined,
                  cursor: 'grab',
                  // CSS transition lives on the class; we only set the
                  // transform value at render-time so the live shift
                  // smoothly transitions when the drop target moves.
                }}
                draggable
                onDragStart={(e) => {
                  setDraggedDrift({ id: node.id, index });
                  setDriftDropIndex(index);
                  e.dataTransfer.effectAllowed = 'move';
                  const el = e.currentTarget as HTMLElement;
                  const rect = el.getBoundingClientRect();
                  e.dataTransfer.setDragImage(el, rect.width / 2, rect.height / 2);
                }}
                onDragEnd={() => {
                  // Cancelled drag (released outside any drop target):
                  // just clear state, no commit, no FLIP.
                  setDraggedDrift(null);
                  setDriftDropIndex(null);
                }}
                onDragOver={(e) => {
                  if (!draggedDrift) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  const beforeHalf = e.clientX - rect.left < rect.width / 2;
                  setDriftDropIndex(beforeHalf ? index : index + 1);
                }}
                onDrop={(e) => {
                  if (!draggedDrift) return;
                  e.preventDefault();
                  e.stopPropagation();
                  // Snapshot the dragged card's pre-commit rect so the
                  // FLIP effect can slide it from its old slot to its
                  // new slot. Other cards stay in place visually
                  // (their inline shift becomes the new DOM slot).
                  const draggedEl = driftCardRefs.current.get(draggedDrift.id);
                  if (draggedEl) {
                    draggedIdAtDropRef.current = draggedDrift.id;
                    draggedCardRectAtDropRef.current = draggedEl.getBoundingClientRect();
                  }
                  void commitDriftReorder();
                }}
                onClick={(e) => {
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
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  setPopover({
                    nodeId: node.id,
                    anchor: {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                    },
                  });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDriftContextMenu({
                    x: e.clientX + 2,
                    y: e.clientY - 2,
                    nodeId: node.id,
                    nodeTitle: node.title ?? undefined,
                    nodeSummary: node.summary ?? undefined,
                    writingStatus: node.writingStatus,
                  });
                }}
                onDoubleClick={() => {
                  openEntity({ entityType: 'node', id: node.id }, { preview: false });
                  close();
                }}
                title={`${node.title || '未命名'} · ${node.wordCount ?? 0} 字 · shift+点击起关联`}
              >
                <div className="drift-card__num">
                  §{String(node.bookOrder).padStart(2, '0')}
                </div>
                <div className="drift-card__title">{node.title || '未命名'}</div>
                {node.summary && (
                  <div className="drift-card__summary">{node.summary}</div>
                )}
              </div>
            );
          })
        )}
      </DriftPanel>

      {/* Fixed-position SVG overlay for drift edges. Endpoints are in
          viewport coordinates (computed in the rAF loop above), so this SVG
          fills the viewport and ignores scroll. pointer-events: none on
          the SVG; the path itself opts in so users can click to delete. */}
      {driftPanelOpen && driftEdgeGeom.length > 0 && (
        <svg className="graph-drift-edges" aria-hidden>
          <defs>
            <filter id="drift-edge-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="2.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {driftEdgeGeom.map((g) => {
            // Cubic curve with vertical handles so the curve eases out of
            // each endpoint along the y-axis — feels right when one end is
            // in the bottom panel and the other up in the canvas.
            const midY = (g.y1 + g.y2) / 2;
            const d = `M ${g.x1} ${g.y1} C ${g.x1} ${midY}, ${g.x2} ${midY}, ${g.x2} ${g.y2}`;
            const selected = isEdgeSelected(g.id);
            return (
              <g
                key={g.id}
                className={`graph-drift-edge${selected ? ' is-selected' : ''}`}
              >
                <path
                  className="graph-drift-edge__hit"
                  d={d}
                  stroke="transparent"
                  strokeWidth={12}
                  fill="none"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedEdgeId(g.id);
                  }}
                >
                  <title>{g.kind ?? '未分类'}</title>
                </path>
                <path className="graph-drift-edge__halo" d={d} stroke={g.color} />
                <path
                  className="graph-drift-edge__line"
                  d={d}
                  stroke={g.color}
                />
              </g>
            );
          })}
        </svg>
      )}

      {/* Fixed-position × badge for the selected drift edge. Mirrors
          the storyline-edge badge but rides at viewport coordinates
          since the drift edge SVG itself does. */}
      {driftPanelOpen &&
        selectedEdgeId &&
        (() => {
          const sel = driftEdgeGeom.find((g) => g.id === selectedEdgeId);
          if (!sel) return null;
          const midX = (sel.x1 + sel.x2) / 2;
          const midY = (sel.y1 + sel.y2) / 2;
          return (
            <button
              type="button"
              className="graph-edge-delete is-floating"
              style={{ left: midX, top: midY }}
              title="删除关联"
              onClick={(e) => {
                e.stopPropagation();
                const id = selectedEdgeId;
                setSelectedEdgeId(null);
                void deleteEdge(id);
              }}
              aria-label="删除关联"
            >
              ×
            </button>
          );
        })()}


      {/* Status banner when a relation-source tile has been picked. */}
      {linkSource && !newEdgePair && (
        <div className="graph-linkbar">
          <span>已选中起点：</span>
          <strong>{nodeById.get(linkSource)?.title || '未命名'}</strong>
          <span>· 点击另一节点创建关联</span>
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
          <div className="graph-newedge">
            <div className="graph-newedge__head">新建关联</div>
            <div className="graph-newedge__pair">
              <span>{nodeById.get(newEdgePair.source)?.title || '未命名'}</span>
              <span aria-hidden>→</span>
              <span>{nodeById.get(newEdgePair.target)?.title || '未命名'}</span>
            </div>
            <label className="graph-newedge__label">分类（留空 = 未分类）</label>
            <div
              className="graph-newedge__select"
              onFocus={() => setNewEdgeSuggestOpen(true)}
              onBlur={(e) => {
                // Close only when focus actually leaves the wrapper —
                // clicking a suggestion (which lives inside) shouldn't
                // dismiss before the value is committed.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setNewEdgeSuggestOpen(false);
                }
              }}
            >
              <input
                autoFocus
                className="graph-newedge__input"
                type="text"
                value={newEdgeKind}
                placeholder="如：同人物 / 引用 / 时序 …"
                onChange={(e) => setNewEdgeKind(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // First ESC while the input is focused → just
                    // blur the field. We stopPropagation so the
                    // central ESC handler doesn't ALSO see the event
                    // and close the modal in the same press; a
                    // second ESC (with focus now on the body) goes
                    // through the central handler and closes the
                    // modal as expected.
                    e.preventDefault();
                    e.stopPropagation();
                    (e.currentTarget as HTMLInputElement).blur();
                    return;
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const trimmed = newEdgeKind.trim();
                    void createEdge(
                      newEdgePair.source,
                      newEdgePair.target,
                      trimmed || null,
                    );
                    setNewEdgePair(null);
                  }
                }}
              />
              {/* Custom suggestions list — mirrors `.edge-kind-mgr` rows
                  so picking a kind here looks like the management menu.
                  Only opens when the input has focus; filtered against
                  the current input. */}
              {newEdgeSuggestOpen && (() => {
                const allKinds = [...regularKinds, ...driftOnlyKinds].filter(
                  (k) => k !== UNCATEGORIZED_KIND,
                );
                const filter = newEdgeKind.trim().toLowerCase();
                const matches = filter
                  ? allKinds.filter((k) => k.toLowerCase().includes(filter))
                  : allKinds;
                if (matches.length === 0) return null;
                return (
                  <div className="graph-newedge__suggestions" role="listbox">
                    {matches.map((k) => (
                      <button
                        key={k}
                        type="button"
                        className="graph-newedge__suggestion"
                        onMouseDown={(e) => {
                          // mousedown (not click) so the input doesn't
                          // lose focus before we read the value.
                          e.preventDefault();
                          setNewEdgeKind(k);
                        }}
                      >
                        <span
                          className="graph-newedge__suggestion-dot"
                          style={{ background: resolveKindColor(k) }}
                        />
                        <span>{k}</span>
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="graph-newedge__actions">
              <button onClick={() => setNewEdgePair(null)}>取消</button>
              <button
                className="is-primary"
                onClick={() => {
                  const trimmed = newEdgeKind.trim();
                  void createEdge(
                    newEdgePair.source,
                    newEdgePair.target,
                    trimmed || null,
                  );
                  setNewEdgePair(null);
                }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {contextMenu && contextMenu.kind === 'node' && (() => {
        const node = bookNodes.find((n) => n.id === contextMenu.nodeId);
        if (!node) return null;
        const edgeCount = nodeEdges.filter(
          (e) => e.sourceNodeId === contextMenu.nodeId || e.targetNodeId === contextMenu.nodeId,
        ).length;
        const hasAnyStoryline = (contextMenu.nodeStorylines?.length ?? 0) > 0;
        return (
          <EntityCellContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            editorType="node"
            nodeStatusKind={isChapter(node) ? 'chapter' : 'drift'}
            nodeWritingStatus={node.writingStatus}
            header={{
              title: contextMenu.nodeTitle ?? undefined,
              subtitle: contextMenu.nodeSummary ?? undefined,
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
                ...(isNarrative && contextMenu.hasNarrativeOrder
                  ? [{ action: 'detachFromNarrative', label: '回到未放置' }]
                  : []),
              ],
              [
                { action: 'startEdgeFrom', label: '从此节点新建关联' },
                {
                  action: 'deleteAllEdges',
                  label: `删除此节点的所有关联 (${edgeCount})`,
                  danger: true,
                  disabled: edgeCount === 0,
                },
              ],
            ]}
            onAction={async (action) => {
              const nid = contextMenu.nodeId;
              try {
                switch (action) {
                  case 'moveToUnaffiliated':
                    await updateNode(nid, { mainStorylineId: null });
                    await setNodeStorylines(nid, []);
                    return;
                  case 'detachFromNarrative':
                    await updateNode(nid, { narrativeOrder: null });
                    return;
                  case 'startEdgeFrom':
                    setLinkSource(nid);
                    return;
                  case 'deleteAllEdges': {
                    const related = nodeEdges.filter(
                      (e) => e.sourceNodeId === nid || e.targetNodeId === nid,
                    );
                    for (const e of related) {
                      await deleteEdge(e.id);
                    }
                    return;
                  }
                  default:
                    // Shared per-entity actions (status / edit storylines /
                    // delete) flow through the canonical dispatcher.
                    void dispatchEntityAction({
                      entityType: 'node',
                      id: nid,
                      action,
                    });
                }
              } catch (err) {
                log.error('Graph context menu action failed', err);
              }
            }}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {contextMenu && contextMenu.kind === 'storyline' &&
        contextMenu.storylineId !== DEFAULT_LANE_ID &&
        contextMenu.storylineId !== UNAFFILIATED_LANE_ID && (
          <EntityCellContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            editorType="storyline"
            onAction={(action) => {
              void dispatchEntityAction({
                entityType: 'storyline',
                id: contextMenu.storylineId,
                action,
              });
            }}
            onClose={() => setContextMenu(null)}
          />
        )}

      {driftContextMenu && (
        <EntityCellContextMenu
          x={driftContextMenu.x}
          y={driftContextMenu.y}
          editorType="node"
          nodeStatusKind="drift"
          nodeWritingStatus={driftContextMenu.writingStatus}
          header={{
            title: driftContextMenu.nodeTitle,
            subtitle: driftContextMenu.nodeSummary,
          }}
          extraGroups={[
            [{ action: 'startEdgeFrom', label: '从此浮缀新建关联' }],
          ]}
          onAction={(action) => {
            const nid = driftContextMenu.nodeId;
            if (action === 'startEdgeFrom') {
              setLinkSource(nid);
              return;
            }
            void dispatchEntityAction({ entityType: 'node', id: nid, action });
          }}
          onClose={() => setDriftContextMenu(null)}
        />
      )}

      {/* Node card popover — opened by tile click. Renders fixed-position
          over the graph; the inner upgrade state expands to a modal. */}
      {popover && projectId && user?.id && (() => {
        const node = bookNodes.find((n) => n.id === popover.nodeId);
        if (!node) return null;
        return (
          <NodeCardPopover
            node={node}
            projectId={projectId}
            userId={user.id}
            anchorRect={popover.anchor}
            onClose={() => setPopover(null)}
            onOpenInEditor={(id) => {
              setPopover(null);
              openEntity({ entityType: 'node', id }, { preview: false });
              close();
            }}
          />
        );
      })()}
    </div>
  );
}
