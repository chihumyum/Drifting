import { StoryGraphUnplacedChapters, type StoryGraphUnplacedChaptersProps } from '../../../features/graph/StoryGraphUnplacedChapters';
import { createStoryGraphDriftDrag } from '../../../features/graph/story-graph-drift-drag';
import { StoryGraphDriftCards, type StoryGraphDriftCardsProps } from '../../../features/graph/StoryGraphDriftCards';
import { GRAPH_CONFIG, EMPTY_POSITIONED_NODES, groupPositionedNodesByRow, type PositionedNode, type StoryGraphLane } from '../../../features/graph/story-graph-layout';
import { StoryGraphLaneRow, type StoryGraphLaneRowProps } from '../../../features/graph/StoryGraphLaneRow';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { projectStoryGraphDriftEdges } from '../../../features/graph/story-graph-drift-model';
import { useTranslation } from 'react-i18next';
import type { Storyline } from '../../../domain/storyline';
import type { BookNode } from '../../../domain/book-node';
import { isChapter, isDrift } from '../../../domain/book-node';
import { spreadTimelineNodes } from '../../../domain/timeline-spread';
import { useDataStore } from '../../../store/data-store';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { useAuthStore } from '../../../store/auth';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useBookNode } from '../../../usecase/useBookNode';
import { useStoryline } from '../../../usecase/useStoryline';
import { useDriftGroup } from '../../../usecase/useDriftGroup';
import { useEntityRelations } from '../../../usecase/useEntityRelations';
import { useEntityRelationTypes } from '../../../usecase/useEntityRelationTypes';
import { useTimelineMarkers } from '../../../hooks/useTimelineMarkers';
import { useRelationTypePresentation } from '../../../hooks/useRelationTypePresentation';
import { useSuperViewEscapeStack } from '../../../hooks/useSuperViewEscapeStack';
import { ActRail } from '../../../components/BottomTimeline/ActRail';
import {
  TimelineMarkerLines,
  TimelineActDragLine,
} from '../../../components/timeline/TimelineGuideLines';
import { createTimelineDragPreview } from '../../../features/graph/timeline-drag-preview';
import { useBookAct } from '../../../usecase/useBookAct';
import { actBoundDriftIds } from '../../../domain/book-act';
import { events } from '../../../lib/events';
import type { AnchorRect } from '../../../components/graph/NodeCardPopover';
import { entityHoverActions } from '../../../components/leftBars/entity-hover-actions';
import { useEntityCellAction } from '../../../hooks/useEntityCellAction';
import { TimelinePin } from '../../../components/timeline/TimelinePin';
import { EntityHoverCard } from '../../../features/entities/hover/EntityHoverCard';
import type { EntityHoverTarget } from '../../../features/entities/hover/entity-hover-card-model';
import type { EntityHoverCardPlacement } from '../../../components/ui/entity-hover-card-position';
import { useCanvasHoverCard, withDriftGroupChoices } from '../../../features/graph/canvas-hover-card';
import type { RelationEdgePopoverAnchor } from '../../../components/graph/RelationEdgePopover';
import type { GraphViewProps } from '../../../features/graph/graph-ui-components.types';
import { DesktopSuperViewHeader } from '../components/DesktopSuperViewHeader';
import { SuperViewShell } from '../../../components/SuperViewShell';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import { RelationTypeField } from '../../../components/ui/RelationTypeField';
import {
  validateRelationAgainstType,
  validateRelationTypeDefinitionAgainstRelation,
} from '../../../domain/entity-relation-type';
import { RelationTypeEditor } from '../../../components/ui/RelationKindMenu';
import { defaultRelationTypeColor } from '../../../components/ui/relation-type-color';
import loglevel from 'loglevel';
import {
  projectStoryGraphEdges as toGraphEdges,
  type StoryGraphEdge as GraphEdge,
} from '../../../features/graph/story-graph-model';
import {
  DEFAULT_STORYLINE_LANE_ID as DEFAULT_LANE_ID,
  UNAFFILIATED_STORYLINE_LANE_ID as UNAFFILIATED_LANE_ID,
  canDropChapterOnLane,
  chapterLaneGrabOffsetX,
  commitChapterLaneDrop,
  resolveChapterLanePointerTarget,
  startChapterLanePointerDrag,
} from '../../../features/graph/chapter-lane-drag';
import { useSuperViewRelationUi } from '../../../features/graph/super-view-relation-ui-context';
import { getPlatformRuntime } from '../../../platform/runtime';
import '../../../../styles/graph-view.css';
import { BrushIcon } from '../../../components/ui/BrushIcon';

const log = loglevel.getLogger('StoryGraphView');
log.setLevel(loglevel.levels.WARN);

// Edges between nodes (chapter ↔ chapter, chapter ↔ drift, drift ↔ drift) are
// persisted as rows in `entity_relation` with fromKind/toKind = 'node'. Each
// references one project relation type id. The renderer resolves the current
// localized type label for display, derives geometry from the current node positions, and uses a fixed
// bezier formula for the path. Edge creation is shift-click-to-pair:
// shift-click a tile to set it as source, click another tile to open the
// new-edge dialog.

type StoryGraphViewMode = 'book' | 'narrative';

const VIEW_STORAGE_KEY = 'graph-view-mode';

function readPersistedView(): StoryGraphViewMode {
  if (typeof localStorage === 'undefined') return 'book';
  const v = localStorage.getItem(VIEW_STORAGE_KEY);
  return v === 'narrative' ? 'narrative' : 'book';
}

export function DesktopStoryGraphView({ graphUi, driftPanel }: GraphViewProps) {
  const { DriftPanel, NodeCardPopover, RelationEdgePopover, RelationArrowMarker, relationArrowMarkerId, relationEdgePath, StoryGraphDriftEdges } = graphUi;
  const { t } = useTranslation();
  const mobileShell = getPlatformRuntime().isMobileShell;
  const {
    bookNodes,
    storylines,
    nodeStorylineMapping,
    entityRelations,
    entityRelationTypes,
    primaryStorylineByNode,
    driftGroups,
  } = useDataStoreFields(
    'bookNodes',
    'storylines',
    'nodeStorylineMapping',
    'entityRelations',
    'entityRelationTypes',
    'primaryStorylineByNode',
    'driftGroups',
  );
  const bookActs = useDataStore((s) => s.bookActs);
  const { setActive: setActiveSuperView } = useSuperViewNavigation();
  const close = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);
  const { user } = useAuthStore();
  const { projectId, openEntity } = useProjectNavigation();
  const { updateNode, moveChapterOnTimeline } = useBookNode({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { addRelation, removeRelation } = useEntityRelations({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const relationTypeUsecases = useEntityRelationTypes({ projectId: projectId ?? '' });
  const {
    edgeKindMeta,
    hiddenRelationTypeIds,
    setDriftPanelOpen: setSharedDriftPanelOpen,
  } = useSuperViewRelationUi('graph');
  const presentRelationType = useRelationTypePresentation();
  const { setNodeStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: user?.id ?? '',
  });
  const { moveDriftToGroup } = useDriftGroup({ projectId: projectId ?? '' });
  const { markers, addMarker, updateMarker, deleteMarker, boundDriftIds } =
    useTimelineMarkers(projectId);
  const { splitAtOrder, updateAct, moveBoundary, unbindDrift, deleteAct, remapAfterSpread } =
    useBookAct({
      projectId: projectId ?? '',
    });

  // Story-graph edges are the subset of manual entity references that connect
  // two node rows (chapter or drift); kept as a stable derived array so the
  // memos and effects below can treat them like the old `nodeEdges` store
  // slice. Building the id set once also lets us drop rows whose endpoints
  // were deleted out from under the edge.
  const nodeEdges = useMemo<GraphEdge[]>(() => {
    const nodeIds = new Set(bookNodes.map((n) => n.id));
    return toGraphEdges(entityRelations, nodeIds);
  }, [entityRelations, bookNodes]);
  const relationTypeById = useMemo(
    () => new Map(entityRelationTypes.map((type) => [type.id, type])),
    [entityRelationTypes],
  );

  // Thin adapters so the shift-click create flow and edge-mgr delete flow
  // keep their call shape. `addRelation` returns the new EntityRelationLink;
  // `removeRelation` takes an id; both are already optimistic-update aware.
  const createEdge = useCallback(
    (sourceNodeId: string, targetNodeId: string, relationTypeId: string) =>
      addRelation('node', sourceNodeId, 'node', targetNodeId, {
        relationTypeId,
      }),
    [addRelation],
  );
  const deleteEdge = useCallback((id: string) => removeRelation(id), [removeRelation]);
  // Color resolver that prefers user overrides from `useEdgeKindMeta`
  // before falling back to the deterministic palette hash. Both the
  // storyline and drift edge renderers consult this, plus the legend
  // chips and the edge-management menu — so a color change in one
  // place is reflected everywhere immediately.
  const resolveRelationTypeColor = useCallback(
    (relationTypeId: string): string => {
      const override = edgeKindMeta.meta[relationTypeId]?.color;
      if (override) return override;
      return defaultRelationTypeColor(relationTypeId);
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
  } = driftPanel;
  useEffect(() => {
    setSharedDriftPanelOpen(driftPanelOpen);
    return () => setSharedDriftPanelOpen(false);
  }, [driftPanelOpen, setSharedDriftPanelOpen]);
  // Pending source for shift-click edge creation. The first shift-click sets
  // this; the next plain click on a different tile opens the new-edge dialog.
  const [mobileLinkMode, setMobileLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [newEdgePair, setNewEdgePair] = useState<{ source: string; target: string } | null>(null);
  const [newEdgeTypeId, setNewEdgeTypeId] = useState<string | null>(null);
  const [newEdgeReversed, setNewEdgeReversed] = useState(false);
  const [newEdgeCreatingType, setNewEdgeCreatingType] = useState(false);
  const closeNewEdgeDialog = useCallback(() => {
    setNewEdgePair(null);
    setNewEdgeTypeId(null);
    setNewEdgeReversed(false);
    setNewEdgeCreatingType(false);
  }, []);
  const configuredRelationTypes = entityRelationTypes;
  const newEdgeTypeOptions = useMemo(
    () =>
      configuredRelationTypes.filter(
        (type) =>
          validateRelationAgainstType(type, {
            fromKind: 'node',
            fromId: newEdgeReversed ? 'target' : 'source',
            toKind: 'node',
            toId: newEdgeReversed ? 'source' : 'target',
          }).ok,
      ),
    [configuredRelationTypes, newEdgeReversed],
  );
  // Popover targeting a single tile. `anchor` is the tile's viewport rect at
  // the moment of click — the popover positions itself relative to it.
  const [popover, setPopover] = useState<{ nodeId: string; anchor: AnchorRect } | null>(null);
  const dispatchEntityAction = useEntityCellAction();
  // Click-to-select edge. While selected, the edge and endpoint cards
  // highlight and a body-portaled detail popover opens at the click point.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedEdgeAnchor, setSelectedEdgeAnchor] = useState<RelationEdgePopoverAnchor | null>(
    null,
  );
  const clearSelectedEdge = useCallback(() => {
    setSelectedEdgeId(null);
    setSelectedEdgeAnchor(null);
  }, []);
  const selectEdge = useCallback((id: string, clientX: number, clientY: number) => {
    setSelectedEdgeId(id);
    setSelectedEdgeAnchor({ x: clientX, y: clientY });
  }, []);

  // Hover cards on tiles, storyline rail cells and drift cards carry what
  // their right-click menus used to (there are none). They keep out of the
  // way of the click popovers, link picking and the new-edge dialog; clicks
  // and drags close a showing card.
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
    dismiss: hoverDismiss,
    card: hoverCard,
  } = useCanvasHoverCard(
    popover !== null ||
      linkSource !== null ||
      mobileLinkMode ||
      newEdgePair !== null ||
      selectedEdgeId !== null,
  );

  // Dismiss the edge selection on any click that doesn't land on an edge or
  // its portaled detail surface. Escape is routed through the shared stack.
  useEffect(() => {
    if (!selectedEdgeId) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (
        t.closest('.graph-edge-grp') ||
        t.closest('.graph-drift-edge') ||
        t.closest('[data-relation-edge-popover]')
      ) {
        return;
      }
      clearSelectedEdge();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [clearSelectedEdge, selectedEdgeId]);

  const selectedEdgeRelation = useMemo(
    () => entityRelations.find((relation) => relation.id === selectedEdgeId) ?? null,
    [entityRelations, selectedEdgeId],
  );
  const selectedEdgeType = useMemo(
    () =>
      selectedEdgeRelation?.relationTypeId
        ? (relationTypeById.get(selectedEdgeRelation.relationTypeId) ?? null)
        : null,
    [relationTypeById, selectedEdgeRelation],
  );

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
      (selectedEdgeEndpoints.source === nodeId || selectedEdgeEndpoints.target === nodeId),
    [selectedEdgeEndpoints],
  );

  const isNarrative = viewMode === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';

  // Act rail (幕) — book-mode in-flow row at the top of the scroll content
  // (replaced the old FullBookLane sibling). Always present in book mode
  // (even with zero acts — the empty rail keeps the feature discoverable);
  // every content-Y offset below must include it.
  const actRailHeight = !isNarrative ? GRAPH_CONFIG.FULL_BOOK_LANE_HEIGHT : 0;

  // Vertical offset from the scroll content's top to a tile's CENTER y,
  // used only for the SVG edge geometry (tiles themselves are now flow
  // children of their lane row, positioned via `top: TRACK_HEIGHT −
  // TILE_HEIGHT`). The formula `tileTopOffset + node.y` happens to yield
  // the same global tile-center y under both layouts:
  //   book mode  → actRailHeight (leading act rail) + (rowIdx*TRACK_HEIGHT + 112)
  //              = actRailHeight + AXIS_HEIGHT + node.y
  //   narrative  → AXIS_HEIGHT + (rowIdx*TRACK_HEIGHT + 112)
  //              = AXIS_HEIGHT*2 + node.y       (with tileTopOffset = AXIS_HEIGHT*2)
  // Kept as a derived constant so the SVG / delete-badge code reads the
  // same as it did pre-refactor.
  const tileTopOffset = isNarrative
    ? GRAPH_CONFIG.AXIS_HEIGHT * 2
    : GRAPH_CONFIG.AXIS_HEIGHT + actRailHeight;

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  // ---- Node positioning ----
  const storylineById = useMemo(() => new Map(storylines.map((s) => [s.id, s])), [storylines]);
  const nodeStorylines = useCallback(
    (nodeId: string): Storyline[] => {
      const ids = nodeStorylineMapping[nodeId] || [];
      return ids.map((id) => storylineById.get(id)).filter((sl): sl is Storyline => Boolean(sl));
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

  // The bottom drawer hides drifts BOUND to a timeline marker OR an act —
  // they've "landed" (on the narrative axis / as an act's notes) and live
  // there now (deleting or unbinding puts them straight back; both bound
  // sets derive from their tables, no status flag). driftIds above stays the
  // FULL set on purpose: edge classification still needs to know a bound
  // drift is a drift.
  const allBoundDriftIds = useMemo(() => {
    const ids = new Set(boundDriftIds);
    for (const id of actBoundDriftIds(bookActs)) ids.add(id);
    return ids;
  }, [boundDriftIds, bookActs]);
  const visibleDriftNodes = useMemo(
    () => driftNodes.filter((n) => !allBoundDriftIds.has(n.id)),
    [driftNodes, allBoundDriftIds],
  );

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

  const lanesToRender = useMemo<StoryGraphLane[]>(() => {
    if (storylines.length === 0) {
      return [
        {
          id: DEFAULT_LANE_ID,
          name: t('bottomTimeline.synthetic.book'),
          color: 'hsl(var(--accent))',
          synthetic: true,
        },
      ];
    }
    const real: StoryGraphLane[] = storylines.map((s) => ({
      id: s.id,
      name: s.name || 'Untitled',
      color: s.color || 'hsl(var(--story-4))',
      synthetic: false,
    }));
    real.push({
      id: UNAFFILIATED_LANE_ID,
      name: t('bottomTimeline.synthetic.unaffiliated'),
      color: 'hsl(var(--ink-3))',
      synthetic: true,
    });
    return real;
  }, [storylines, t]);

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
    if (placedNodes.length === 0)
      return { min: 1, max: 1 + GRAPH_CONFIG.TILE_WIDTH_UNITS + GRAPH_CONFIG.RUNWAY_UNITS };
    const values = placedNodes.map((n) => orderOf(n) ?? 0);
    // Furthest anchor that should extend the canvas past the chapters: the last
    // marker (narrative view) or act boundary (book view). A fixed runway is
    // added beyond it so pins/acts can be dropped or planned past the end; the
    // canvas grows to match (visible == droppable, order viewport-independent).
    const anchors = isNarrative
      ? markers.map((m) => m.narrativeOrder)
      : bookActs.map((a) => a.startOrder ?? Number.NEGATIVE_INFINITY);
    const contentRight = Math.max(
      Math.max(...values) + GRAPH_CONFIG.TILE_WIDTH_UNITS,
      anchors.length ? Math.max(...anchors) : Number.NEGATIVE_INFINITY,
    );
    return {
      min: Math.min(...values, 1),
      max: contentRight + GRAPH_CONFIG.RUNWAY_UNITS,
    };
  }, [placedNodes, orderOf, isNarrative, markers, bookActs]);

  const canvasContentWidth =
    (orderSpan.max - orderSpan.min) * GRAPH_CONFIG.GRID_UNIT +
    GRAPH_CONFIG.CANVAS_PADDING_X +
    GRAPH_CONFIG.LABEL_PAD;

  const orderToX = useCallback(
    (order: number) =>
      GRAPH_CONFIG.CANVAS_PADDING_X + (order - orderSpan.min) * GRAPH_CONFIG.GRID_UNIT,
    [orderSpan.min],
  );
  const positionToOrder = useCallback(
    (position: number) =>
      Math.max(
        orderSpan.min,
        (position - GRAPH_CONFIG.CANVAS_PADDING_X) / GRAPH_CONFIG.GRID_UNIT + orderSpan.min,
      ),
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
        const sl = mainId ? (storylineById.get(mainId) ?? null) : null;
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
  }, [
    placedNodes,
    primaryStorylineId,
    laneRowForNode,
    orderOf,
    storylineById,
    nodeStorylines,
    orderToX,
  ]);

  const positionedNodesByRow = useMemo(() => groupPositionedNodesByRow(positionedNodes), [positionedNodes]);

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

  // ---- Relation edges (project relation types) ----
  // Index positioned nodes for fast endpoint lookup. Edges whose endpoint
  // isn't placed in the current view (e.g. narrative view with null
  // narrativeOrder on one end) are skipped.
  const positionedById = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    positionedNodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [positionedNodes]);

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
      if (hiddenRelationTypeIds.has(edge.relationTypeId)) continue;
      const source = positionedById.get(edge.sourceNodeId);
      const target = positionedById.get(edge.targetNodeId);
      if (!source || !target) continue;
      out.push({
        edge,
        x1: source.x + halfTile,
        y1: source.y,
        x2: target.x + halfTile,
        y2: target.y,
        color: resolveRelationTypeColor(edge.relationTypeId),
      });
    }
    return out;
  }, [nodeEdges, positionedById, hiddenRelationTypeIds, resolveRelationTypeColor]);

  // ---- Narrative time pins ----
  // Marker and act positions use the same continuous coordinate authority as
  // chapters. The visible grid is presentation only, never a write policy.
  const [dragPreview] = useState(() => createTimelineDragPreview());
  const [newlyAddedPinId, setNewlyAddedPinId] = useState<string | null>(null);
  // "打散" — keeps relative ordering, reassigns the active order field
  // (bookOrder or narrativeOrder) with the same stride that new chapters
  // use (CHAPTER_ORDER_STRIDE = tile width + 1), so scatter spacing matches
  // creation spacing and adjacent tiles sit a single grid unit apart. Shared
  // semantics with BottomTimeline's handleSpread.
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
      log.error('Failed to spread graph nodes', err);
    }
  }, [placedNodes, orderOf, updateNode, orderField, isNarrative, remapAfterSpread]);

  // 「+幕」bootstraps one first act at the book-axis head. Once acts exist, the
  // same head-cell control inserts at the current viewport center.
  const handleAddActSplit = useCallback(() => {
    const canvas = canvasRef.current;
    const centerContentX = canvas ? canvas.scrollLeft + canvas.clientWidth / 2 : 0;
    // Empty rail: one first act at the book-axis head. Populated rail: keep
    // the existing viewport-center convenience.
    const target = bookActs.length === 0 ? orderSpan.min : positionToOrder(centerContentX);
    void splitAtOrder(target);
  }, [bookActs.length, orderSpan.min, positionToOrder, splitAtOrder]);

  const handleAddPin = useCallback(() => {
    if (!isNarrative) return;
    const canvas = canvasRef.current;
    const centerContentX = canvas ? canvas.scrollLeft + canvas.clientWidth / 2 : 0;
    const target = positionToOrder(centerContentX);
    const created = addMarker(target, t('bottomTimeline.marker.defaultLabel'));
    if (created) setNewlyAddedPinId(created.id);
  }, [isNarrative, addMarker, positionToOrder, t]);

  // Drop a marker at a specific order (a double-click on the empty axis), as
  // opposed to handleAddPin's viewport-center pick.
  const handleAddPinAtOrder = useCallback(
    (order: number) => {
      if (!isNarrative) return;
      const created = addMarker(order, t('bottomTimeline.marker.defaultLabel'));
      if (created) setNewlyAddedPinId(created.id);
    },
    [isNarrative, addMarker, t],
  );

  // ---- Drag / drop ----
  // Chapter tiles in this full graph and the compact Bottom Timeline share
  // one pointer lifecycle. The drag visual is an imperative compositor layer,
  // so moving a chapter never re-renders every lane on every pointer event.
  const canvasRef = useRef<HTMLDivElement>(null);
  const suppressChapterClickRef = useRef(false);
  // No hover cards while a chapter is being carried across lanes.
  const chapterDraggingRef = useRef(false);

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

  const [driftDrag] = useState(createStoryGraphDriftDrag);
  useLayoutEffect(() => () => driftDrag.cancel(), [driftDrag, projectId]);
  // Picking a drift card up closes its hover card.
  useEffect(
    () =>
      driftDrag.subscribe(() => {
        if (driftDrag.getSnapshot().dragged) hoverDismiss();
      }),
    [driftDrag, hoverDismiss],
  );

  // Wrap the shared close-panel callback so it ALSO clears the drag-reorder
  // state when the panel slides out. The base close (from useDriftPanelAnim)
  // is generic; StoryGraphView's drift cards layer drag-and-drop on top, and we
  // don't want a half-finished drag lingering once the panel comes back.
  const closeDriftPanel = useCallback(() => {
    driftDrag.cancel();
    closeDriftPanelBase();
  }, [closeDriftPanelBase, driftDrag]);

  useSuperViewEscapeStack(
    [
      {
        id: `node-popover:${popover?.nodeId ?? ''}`,
        active: popover !== null,
        onEscape: () => setPopover(null),
      },
      {
        id: newEdgePair ? `new-edge:${newEdgePair.source}:${newEdgePair.target}` : 'new-edge',
        active: newEdgePair !== null,
        onEscape: closeNewEdgeDialog,
      },
      { id: 'unplaced-drawer', active: drawerOpen, onEscape: () => setDrawerOpen(false) },
      {
        id: `selected-edge:${selectedEdgeId ?? ''}`,
        active: selectedEdgeId !== null,
        onEscape: clearSelectedEdge,
      },
      {
        id: `link-source:${linkSource ?? ''}`,
        active: linkSource !== null,
        onEscape: () => setLinkSource(null),
      },
      {
        id: 'mobile-link-mode',
        active: mobileLinkMode,
        onEscape: () => setMobileLinkMode(false),
      },
      {
        id: 'drift-panel',
        active: driftPanelMounted && !driftPanelClosing,
        onEscape: closeDriftPanel,
      },
    ],
    close,
  );

  const driftEdges = useMemo(() => projectStoryGraphDriftEdges({ edges: nodeEdges, driftIds,
    hiddenRelationTypeIds, relationTypeById, positionedById, typeMeta: edgeKindMeta.meta }),
  [nodeEdges, driftIds, hiddenRelationTypeIds, relationTypeById, positionedById, edgeKindMeta.meta]);
  const driftLayoutRevision = useMemo(() => ({ positionedById, visibleDriftNodes }),
    [positionedById, visibleDriftNodes]);
  const resolveDriftRelationTypeLabel = useCallback((id: string) => {
    const type = relationTypeById.get(id);
    return type ? presentRelationType(type).name : t('relationTypes.missing');
  }, [relationTypeById, presentRelationType, t]);

  const startGraphChapterPointerDrag = useCallback((
    event: React.PointerEvent<HTMLElement>,
    node: BookNode,
    options: { fromDrawer?: boolean } = {},
  ) => {
    if (event.button !== 0) return;
    const fromDrawer = options.fromDrawer ?? false;
    const sourceElement = event.currentTarget;
    const sourceRect = sourceElement.getBoundingClientRect();
    const grabOffsetX = chapterLaneGrabOffsetX(event.clientX, sourceRect);
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
        suppressChapterClickRef.current = true;
        chapterDraggingRef.current = true;
        setPopover(null);
        hoverDismiss();
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
          log.error('Failed to update order on drop', error);
        }
      },
      onDragEnd: () => {
        chapterDraggingRef.current = false;
        if (fromDrawer) setDrawerOpen(false);
        window.setTimeout(() => {
          suppressChapterClickRef.current = false;
        }, 0);
      },
    });
  }, [positionToOrder, primaryStorylineId, orderField, moveChapterOnTimeline, hoverDismiss]);

  const toggleUnplacedChapters = useCallback(() => setDrawerOpen(value => !value), []);
  const closeUnplacedChapters = useCallback(() => setDrawerOpen(false), []);
  const handleUnplacedPointerDown = useCallback<StoryGraphUnplacedChaptersProps['onNodePointerDown']>((event, node) => {
    event.stopPropagation();
    startGraphChapterPointerDrag(event, node, { fromDrawer: true });
  }, [startGraphChapterPointerDrag]);

  const handleChapterPointerDown = useCallback<StoryGraphLaneRowProps['onNodePointerDown']>((event, node) => {
    if (!mobileLinkMode) startGraphChapterPointerDrag(event, node);
  }, [mobileLinkMode, startGraphChapterPointerDrag]);
  const handleChapterClick = useCallback<StoryGraphLaneRowProps['onNodeClick']>((e, node) => {
    hoverDismiss();
    if (suppressChapterClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressChapterClickRef.current = false;
      return;
    }
    if (e.shiftKey) {
      setLinkSource((prev) => (prev === node.id ? null : node.id));
      return;
    }
    if (mobileLinkMode) {
      if (!linkSource || linkSource === node.id) {
        setLinkSource((prev) => (prev === node.id ? null : node.id));
      } else {
        setNewEdgePair({ source: linkSource, target: node.id });
        setNewEdgeTypeId(null);
        setNewEdgeReversed(false);
        setNewEdgeCreatingType(false);
        setLinkSource(null);
        setMobileLinkMode(false);
      }
      return;
    }
    if (linkSource && linkSource !== node.id) {
      setNewEdgePair({ source: linkSource, target: node.id });
      setNewEdgeTypeId(null);
      setNewEdgeReversed(false);
      setNewEdgeCreatingType(false);
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
  }, [mobileLinkMode, linkSource, hoverDismiss]);
  const handleChapterDoubleClick = useCallback<StoryGraphLaneRowProps['onNodeDoubleClick']>((node) => {
    openEntity({ entityType: 'node', id: node.id }, { preview: false });
    close();
  }, [openEntity, close]);
  const handleChapterPreviewEnter = useCallback<StoryGraphLaneRowProps['onNodePreviewEnter']>((event, node) => {
    if (chapterDraggingRef.current) return;
    hoverEnter({ kind: 'node', id: node.id }, event.currentTarget);
  }, [hoverEnter]);
  const handleLanePreviewEnter = useCallback<StoryGraphLaneRowProps['onLanePreviewEnter']>((event, storylineId) => {
    if (chapterDraggingRef.current) return;
    hoverEnter({ kind: 'storyline', id: storylineId }, event.currentTarget);
  }, [hoverEnter]);

  const handleDriftClick = useCallback<StoryGraphDriftCardsProps['onClick']>((e, node) => {
    hoverDismiss();
    if (e.shiftKey) {
      setLinkSource((prev) => (prev === node.id ? null : node.id));
      return;
    }
    if (mobileLinkMode) {
      if (!linkSource || linkSource === node.id) {
        setLinkSource((prev) => (prev === node.id ? null : node.id));
      } else {
        setNewEdgePair({ source: linkSource, target: node.id });
        setNewEdgeTypeId(null);
        setNewEdgeReversed(false);
        setNewEdgeCreatingType(false);
        setLinkSource(null);
        setMobileLinkMode(false);
      }
      return;
    }
    if (linkSource && linkSource !== node.id) {
      setNewEdgePair({ source: linkSource, target: node.id });
      setNewEdgeTypeId(null);
      setNewEdgeReversed(false);
      setNewEdgeCreatingType(false);
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
  }, [mobileLinkMode, linkSource, hoverDismiss]);
  const handleDriftPreviewEnter = useCallback<StoryGraphDriftCardsProps['onPreviewEnter']>((event, node) => {
    if (driftDrag.getSnapshot().dragged) return;
    hoverEnter({ kind: 'node', id: node.id }, event.currentTarget);
  }, [driftDrag, hoverEnter]);
  const handleDriftDoubleClick = useCallback<StoryGraphDriftCardsProps['onDoubleClick']>((node) => {
    openEntity({ entityType: 'node', id: node.id }, { preview: false });
    close();
  }, [openEntity, close]);

  // What a chapter tile's right-click menu used to offer: status, storylines
  // and delete as everywhere else, then the graph's own placement and
  // relation actions.
  const runChapterHoverAction = async (nid: string, action: string) => {
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
          const related = nodeEdges.filter((e) => e.sourceNodeId === nid || e.targetNodeId === nid);
          for (const e of related) {
            await deleteEdge(e.id);
          }
          return;
        }
        default:
          // Shared per-entity actions (status / edit storylines / delete)
          // flow through the canonical dispatcher.
          await dispatchEntityAction({ entityType: 'node', id: nid, action });
      }
    } catch (err) {
      log.error('Graph hover card action failed', err);
    }
  };
  const chapterHoverActions = (node: BookNode) => {
    const edgeCount = nodeEdges.filter(
      (e) => e.sourceNodeId === node.id || e.targetNodeId === node.id,
    ).length;
    return entityHoverActions({
      editorType: 'node',
      nodeStatusKind: isChapter(node) ? 'chapter' : 'drift',
      nodeWritingStatus: node.writingStatus,
      extraGroups: [
        [
          ...(nodeStorylines(node.id).length > 0
            ? [{ action: 'moveToUnaffiliated', label: t('bottomTimeline.menu.moveToUnaffiliated') }]
            : []),
          ...(isNarrative && typeof node.narrativeOrder === 'number'
            ? [{ action: 'detachFromNarrative', label: t('bottomTimeline.menu.detachFromNarrative') }]
            : []),
        ],
        [
          { action: 'startEdgeFrom', label: t('storyGraph.menu.startEdgeFromNode') },
          {
            action: 'deleteAllEdges',
            label: t('storyGraph.menu.deleteAllEdges', { count: edgeCount }),
            danger: true,
            disabled: edgeCount === 0,
          },
        ],
      ],
      onAction: (action) => void runChapterHoverAction(node.id, action),
      t,
    });
  };
  const driftHoverActions = (node: BookNode) =>
    withDriftGroupChoices(
      entityHoverActions({
        editorType: 'node',
        nodeStatusKind: 'drift',
        nodeWritingStatus: node.writingStatus,
        extraGroups: [[{ action: 'startEdgeFrom', label: t('storyGraph.menu.startEdgeFromDrift') }]],
        onAction: (action) => {
          if (action === 'startEdgeFrom') {
            setLinkSource(node.id);
            return;
          }
          void dispatchEntityAction({ entityType: 'node', id: node.id, action });
        },
        t,
      }),
      {
        node,
        driftGroups,
        onMove: (groupId) => {
          moveDriftToGroup(node.id, groupId).catch((err) => {
            log.error('Failed to move drift to group', err);
          });
        },
        t,
      },
    );
  const hoverActionsFor = (target: EntityHoverTarget) => {
    if (target.kind === 'storyline') {
      return entityHoverActions({
        editorType: 'storyline',
        onAction: (action) => void dispatchEntityAction({ entityType: 'storyline', id: target.id, action }),
        t,
      });
    }
    const node = target.kind === 'node' ? nodeById.get(target.id) : undefined;
    if (!node) return undefined;
    return isDrift(node) ? driftHoverActions(node) : chapterHoverActions(node);
  };
  // Rail cells sit at the left edge, tiles at the bottom of their lane (the
  // next lane's upper half is empty), drift cards in the bottom drawer.
  const hoverPlacementFor = (target: EntityHoverTarget): EntityHoverCardPlacement => {
    if (target.kind === 'storyline') return 'right-start';
    const node = nodeById.get(target.id);
    return node && isDrift(node) ? 'top-center' : 'bottom-start';
  };

  const totalsLabel = t('storyGraph.meta', {
    storylines: storylines.length,
    placed: placedNodes.length,
    total: bookNodes.filter(node => node.kind === 'chapter').length,
  });

  return (
    <SuperViewShell className="graph-overlay" data-view={viewMode}>
      <DesktopSuperViewHeader
        meta={totalsLabel}
        onBack={close}
        leftSlot={
          <>
            <SegmentedControl
              className="graph-head__view-toggle"
              size="md"
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
            <button
              type="button"
              className="graph-head__spread-btn"
              disabled={placedNodes.length < 2}
              onClick={() => {
                void handleSpread();
              }}
              title={
                placedNodes.length < 2
                  ? t('bottomTimeline.spread.needTwo')
                  : t('bottomTimeline.spread.title', {
                      mode: isNarrative
                        ? t('bottomTimeline.view.narrative')
                        : t('bottomTimeline.view.book'),
                    })
              }
              aria-label={t('storyGraph.spreadAria')}
            >
              <BrushIcon name="spread" size={11} />
              <span>{t('storyGraph.spread')}</span>
            </button>

            {/* The 「+幕」act-create action moved into the act rail's head cell
                (mirrors the narrative TIME plus), so it's no longer in the header. */}

            {/* Unplaced chapters — narrative mode only. Same role as the
                equivalent control in BottomTimeline: surface chapters
                that have no narrativeOrder yet so they can be dragged
                into a track. Renders as a popover anchored to the head
                button rather than the old below-head drawer. */}
            {isNarrative && (
              <StoryGraphUnplacedChapters nodes={unplacedNodes} primaryStorylineId={primaryStorylineId}
                storylineById={storylineById} open={drawerOpen} onToggle={toggleUnplacedChapters}
                onClose={closeUnplacedChapters} onNodePointerDown={handleUnplacedPointerDown} />
            )}
          </>
        }
        rightSlot={
          <>
            {mobileShell && (
              <button
                type="button"
                className={`m-super-view-link-mode${mobileLinkMode ? ' is-active' : ''}`}
                aria-pressed={mobileLinkMode}
                onClick={() => {
                  setMobileLinkMode((value) => !value);
                  setLinkSource(null);
                }}
              >
                {mobileLinkMode
                  ? t('mobileWorkspace.superView.relationModeOn')
                  : t('mobileWorkspace.superView.relationMode')}
              </button>
            )}
            {nodeEdges.length === 0 && !mobileShell && (
              <div className="graph-head__filters">
                <div className="graph-head__filter is-hint" title={t('storyGraph.edge.hintTitle')}>
                  {t('storyGraph.edge.hint')}
                </div>
              </div>
            )}
          </>
        }
      />

      <div className="super-view-body graph-body">
        {/* Single scroll container for the whole grid (vertical for
            many storylines, horizontal for many chapters). Rail labels
            stick to the left via `position: sticky` so they stay aligned
            with their tracks at all scroll positions. The narrative
            axis row stickies to the top. No JS sync; no height-spacer
            hacks — the layout is genuinely one surface. */}
        <div ref={canvasRef} className="graph-scroll">
          {/* Act rail (幕) — book mode, only when acts exist. In-flow row
              inside the scroll container (track coordinate space, replaced
              the old FullBookLane sibling) so act bands align with chapter
              columns and scroll with them; sticky-top like the time axis. */}
          {actRailHeight > 0 && (
            <ActRail
              key={projectId}
              className="actrail--sticky-top"
              acts={bookActs}
              chapters={placedNodes}
              railWidth={GRAPH_CONFIG.RAIL_WIDTH}
              trackWidth={canvasContentWidth}
              height={actRailHeight}
              orderToX={orderToX}
              minOrder={orderSpan.min}
              maxOrder={orderSpan.max}
              onRenameAct={(id, name) => void updateAct(id, { name })}
              onMoveBoundary={(id, startOrder) => void moveBoundary(id, startOrder)}
              onBoundaryDragMove={dragPreview.setAct}
              onDeleteAct={(id) => void deleteAct(id)}
              onSplitAt={(startOrder) => void splitAtOrder(startOrder)}
              onAddAct={handleAddActSplit}
              driftTitleById={(id) => nodeById.get(id)?.title ?? null}
              onRequestBind={(id) =>
                events.emit('drift-bind:open', { target: { kind: 'act', id } })
              }
              onUnbindDrift={(id) => void unbindDrift(id)}
              onOpenDrift={(driftNodeId, anchor) =>
                // Match the drift-panel card: open the two-step NodeCardPopover
                // anchored to the ⚓, NOT a hard jump to the editor (that's the
                // bottom-timeline behavior). The popover itself offers "open in
                // editor" as its second step.
                setPopover({
                  nodeId: driftNodeId,
                  anchor: anchor ?? {
                    left: window.innerWidth / 2,
                    top: window.innerHeight / 2,
                    width: 0,
                    height: 0,
                  },
                })
              }
            />
          )}

          {/* Narrative time-axis row — sticky-top.
              Rail cell is sticky-left + sticky-top (the corner); the
              track cell carries the draggable pin heads/labels. */}
          {isNarrative && (
            <div className="graph-axis-row" style={{ height: GRAPH_CONFIG.AXIS_HEIGHT }}>
              <div
                className="graph-axis-rail-cell"
                style={{ width: GRAPH_CONFIG.RAIL_WIDTH }}
                title={t('bottomTimeline.axis.title')}
              >
                <span className="graph-rail__axis-name">{t('storyGraph.axis.time')}</span>
                <button
                  type="button"
                  className="graph-rail__axis-add"
                  title={t('bottomTimeline.axis.addPin')}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddPin();
                  }}
                >
                  <BrushIcon name="plus" size={10} />
                </button>
              </div>
              <div
                className="graph-axis-track-cell"
                style={{ width: canvasContentWidth }}
                title={t('storyGraph.axis.addMarkerHint')}
                onDoubleClick={(e) => {
                  // Double-clicking blank axis drops a marker at that spot.
                  // Pins are the track's only children and own their own
                  // double-click (rename), so only the track itself counts.
                  if (e.target !== e.currentTarget) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  handleAddPinAtOrder(positionToOrder(e.clientX - rect.left));
                }}
                onDragOver={(e) => {
                  // Drift card hovering the axis — accept: dropping anchors
                  // the drift as a bound marker at that slot.
                  const draggedDrift = driftDrag.getSnapshot().dragged;
                  if (!draggedDrift) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  const draggedDrift = driftDrag.getSnapshot().dragged;
                  if (!draggedDrift) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                  const px = e.clientX - rect.left;
                  const target = positionToOrder(px);
                  // Label stays empty — a bound pin renders the drift's
                  // live title; the label only matters after a later unbind.
                  addMarker(target, '', { driftNodeId: draggedDrift.id });
                  driftDrag.cancel();
                }}
              >
                {markers
                  .filter(
                    (m) => m.narrativeOrder >= orderSpan.min && m.narrativeOrder <= orderSpan.max,
                  )
                  .map((m) => (
                    <TimelinePin
                      key={`pin-${m.id}`}
                      marker={m}
                      orderToPosition={orderToX}
                      positionToOrder={positionToOrder}
                      variant="graph"
                      pinHeight={GRAPH_CONFIG.AXIS_HEIGHT}
                      editOnMount={m.id === newlyAddedPinId}
                      onChange={(patch) => {
                        if (m.id === newlyAddedPinId) setNewlyAddedPinId(null);
                        updateMarker(m.id, patch);
                      }}
                      onDelete={() => {
                        if (m.id === newlyAddedPinId) setNewlyAddedPinId(null);
                        deleteMarker(m.id);
                      }}
                      boundDriftTitle={
                        m.driftNodeId ? (nodeById.get(m.driftNodeId)?.title ?? null) : null
                      }
                      onRequestBind={() =>
                        events.emit('drift-bind:open', { target: { kind: 'marker', id: m.id } })
                      }
                      onOpenDrift={(anchor) => {
                        // Same two-step NodeCardPopover as a drift-panel card /
                        // a bound act — not a hard editor jump (which read as
                        // "no reaction" inside the super view).
                        if (!m.driftNodeId) return;
                        setPopover({
                          nodeId: m.driftNodeId,
                          anchor: anchor ?? {
                            left: window.innerWidth / 2,
                            top: window.innerHeight / 2,
                            width: 0,
                            height: 0,
                          },
                        });
                      }}
                      onDragMove={(nextX) => dragPreview.setMarker(m.id, nextX)}
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
          {isNarrative && (
            <TimelineMarkerLines preview={dragPreview} markers={markers}
              orderToPosition={orderToX} className="graph-pin-line"
              xOffset={GRAPH_CONFIG.RAIL_WIDTH}
              height={GRAPH_CONFIG.AXIS_HEIGHT + lanesToRender.length * GRAPH_CONFIG.TRACK_HEIGHT}
              ariaHidden />
          )}

          {/* Act boundary lines (book view) — same vertical primitive as a
              marker's line, run down through every lane (behind the sticky act
              rail) so an act boundary reads top-to-bottom like a time marker. */}
          {!isNarrative &&
            bookActs.map((a) =>
              a.startOrder == null ? null : (
                <div
                  key={`actline-${a.id}`}
                  className="graph-pin-line"
                  style={{
                    left: GRAPH_CONFIG.RAIL_WIDTH + orderToX(a.startOrder),
                    height: actRailHeight + lanesToRender.length * GRAPH_CONFIG.TRACK_HEIGHT,
                  }}
                  aria-hidden
                />
              ),
            )}

          {/* Act drop indicator — follows the boundary/chip drag (x lifted from
              ActRail) as one accent line from the rail through every lane (the
              is-dragging z-index lifts it above the sticky act rail). */}
          {!isNarrative && (
            <TimelineActDragLine preview={dragPreview} className="graph-pin-line"
              xOffset={GRAPH_CONFIG.RAIL_WIDTH}
              height={actRailHeight + lanesToRender.length * GRAPH_CONFIG.TRACK_HEIGHT}
              ariaHidden />
          )}

          {/* Lane rows — each is a flex row of [sticky-left rail cell |
              track cell with tiles]. The vertical scroll naturally moves
              both halves together because they share the same scroll
              container. */}
          {lanesToRender.map((lane, rowIdx) => (
            <StoryGraphLaneRow
              key={lane.id}
              lane={lane}
              nodes={positionedNodesByRow.get(rowIdx) ?? EMPTY_POSITIONED_NODES}
              chapterCount={lane.id === DEFAULT_LANE_ID ? placedNodes.length
                : lane.id === UNAFFILIATED_LANE_ID ? unaffiliatedChapters.length
                  : (sortedNodesByStoryline.get(lane.id)?.length ?? 0)}
              canvasContentWidth={canvasContentWidth}
              tileRefs={tileRefs}
              linkSource={linkSource}
              isNodeEdgeSelected={isNodeEdgeSelected}
              onNodePointerDown={handleChapterPointerDown}
              onNodeClick={handleChapterClick}
              onNodeDoubleClick={handleChapterDoubleClick}
              onNodePreviewEnter={handleChapterPreviewEnter}
              onLanePreviewEnter={handleLanePreviewEnter}
              onPreviewLeave={hoverLeave}
            />
          ))}

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
                (isNarrative ? GRAPH_CONFIG.AXIS_HEIGHT : actRailHeight) +
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
                const relationType = relationTypeById.get(edge.relationTypeId);
                const directed = relationType?.orientation === 'directed';
                const markerId = relationArrowMarkerId('story-world-arrow', edge.id);
                const d = relationEdgePath({
                  x1,
                  y1: yy1,
                  x2,
                  y2: yy2,
                  directed,
                  targetInsetX: (GRAPH_CONFIG.TILE_WIDTH_UNITS * GRAPH_CONFIG.GRID_UNIT) / 2 + 7,
                  targetInsetY: GRAPH_CONFIG.TILE_HEIGHT / 2 + 7,
                });
                const selected = isEdgeSelected(edge.id);
                return (
                  <g key={edge.id} className={`graph-edge-grp${selected ? ' is-selected' : ''}`}>
                    {directed && (
                      <defs>
                        <RelationArrowMarker id={markerId} color={color} />
                      </defs>
                    )}
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth="10"
                      fill="none"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectEdge(edge.id, e.clientX, e.clientY);
                      }}
                    >
                      <title>
                        {relationType
                          ? presentRelationType(relationType).name
                          : t('relationTypes.missing')}
                      </title>
                    </path>
                    <path
                      d={d}
                      stroke={color}
                      strokeWidth={selected ? 2.4 : 1.8}
                      fill="none"
                      opacity={selected ? 1 : 0.85}
                      markerEnd={directed ? `url(#${markerId})` : undefined}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                );
              })}
            </svg>
          )}

        </div>
      </div>

      {/* ---------------- Drift drawer (floating, bottom-center) ----------------
          Shared shell with SuperElementView via <DriftPanel>. The cards
          rendered as children keep StoryGraphView's drag-and-drop reorder + edge-
          selection visual language; the hand-level drop handler is passed
          through handDragHandlers. */}
      <DriftPanel
        count={visibleDriftNodes.length}
        mounted={driftPanelMounted}
        open={driftPanelOpen}
        closing={driftPanelClosing}
        onOpen={openDriftPanel}
        onClose={closeDriftPanel}
        closeDisabled={driftPanelClosing}
        panelAriaHidden={!driftPanelOpen || driftPanelClosing}
        handRef={driftHandRef}
        handDragHandlers={{
          onDragOver: (event) => {
            if (!driftDrag.getSnapshot().dragged) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move';
          },
          onDrop: (event) => {
            if (!driftDrag.getSnapshot().dragged) return;
            event.preventDefault(); driftDrag.cancel();
          },
        }}
      >
        <StoryGraphDriftCards nodes={visibleDriftNodes} totalDrifts={driftNodes.length} drag={driftDrag}
          cardRefs={driftCardRefs} linkSourceId={linkSource} isNodeEdgeSelected={isNodeEdgeSelected}
          onClick={handleDriftClick} onDoubleClick={handleDriftDoubleClick}
          onPreviewEnter={handleDriftPreviewEnter} onPreviewLeave={hoverLeave} />
      </DriftPanel>

      {/* Fixed-position SVG overlay for drift edges. Endpoints are in
          viewport coordinates (owned by the isolated line layer), so this SVG
          fills the viewport and ignores scroll. pointer-events: none on
          the SVG; the path itself opts in so users can click to delete. */}
      {driftPanelOpen && (
        <StoryGraphDriftEdges edges={driftEdges} driftCardRefs={driftCardRefs} tileRefs={tileRefs}
          viewportRef={canvasRef} revision={driftLayoutRevision} drag={driftDrag} selectedEdgeId={selectedEdgeId}
          selectEdge={selectEdge} resolveRelationTypeLabel={resolveDriftRelationTypeLabel} />
      )}

      {selectedEdgeAnchor && selectedEdgeRelation && selectedEdgeType && (
        <RelationEdgePopover
          anchor={selectedEdgeAnchor}
          relation={selectedEdgeRelation}
          relationType={selectedEdgeType}
          sourceLabel={nodeById.get(selectedEdgeRelation.fromId)?.title || t('common.untitled')}
          targetLabel={nodeById.get(selectedEdgeRelation.toId)?.title || t('common.untitled')}
          color={resolveRelationTypeColor(selectedEdgeRelation.relationTypeId)}
          onDelete={() => {
            const id = selectedEdgeRelation.id;
            clearSelectedEdge();
            void deleteEdge(id);
          }}
        />
      )}

      {/* Status banner when a relation-source tile has been picked. */}
      {linkSource && !newEdgePair && (
        <div className="graph-linkbar">
          <span>{t('storyGraph.edge.linkSourcePrefix')}</span>
          <strong>{nodeById.get(linkSource)?.title || t('common.untitled')}</strong>
          <span>{t('storyGraph.edge.linkSourceSuffix')}</span>
          <button onClick={() => setLinkSource(null)} title={t('common.cancel')}>
            <BrushIcon name="close" size={10} inline />
          </button>
        </div>
      )}

      {/* New-edge dialog: chooses a compatible project relation type and lets
          the author make directed endpoint intent explicit. */}
      {newEdgePair && (
        <div
          className="graph-newedge-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeNewEdgeDialog();
          }}
        >
          <div className={`graph-newedge${newEdgeCreatingType ? ' is-creating-type' : ''}`}>
            <div className="graph-newedge__head">{t('storyGraph.edge.newTitle')}</div>
            <div className="graph-newedge__pair">
              <span>
                {nodeById.get(newEdgeReversed ? newEdgePair.target : newEdgePair.source)?.title ||
                  t('common.untitled')}
              </span>
              <button
                type="button"
                className="graph-newedge__swap"
                onClick={() => {
                  setNewEdgeReversed((value) => !value);
                  setNewEdgeTypeId(null);
                  setNewEdgeCreatingType(false);
                }}
                title={t('relationTypes.swap')}
              >
                <BrushIcon name="swap" size={12} inline />
              </button>
              <span>
                {nodeById.get(newEdgeReversed ? newEdgePair.source : newEdgePair.target)?.title ||
                  t('common.untitled')}
              </span>
            </div>
            <div className="relation-type-modal__heading">
              <label className="graph-newedge__label">{t('storyGraph.edge.kindLabel')}</label>
              <button
                type="button"
                className="relation-type-modal__create"
                onClick={() => setNewEdgeCreatingType((value) => !value)}
              >
                {newEdgeCreatingType ? (
                  t('relationTypes.chooseExisting')
                ) : (
                  <>
                    <BrushIcon name="plus" size={10} inline /> {t('relationTypes.createInline')}
                  </>
                )}
              </button>
            </div>
            {newEdgeCreatingType ? (
              <RelationTypeEditor
                key={`node:node:${newEdgeReversed ? 'reversed' : 'forward'}`}
                initialSourceKinds={['node']}
                initialTargetKinds={['node']}
                onCancel={() => setNewEdgeCreatingType(false)}
                onSave={async (definition) => {
                  const checked = validateRelationTypeDefinitionAgainstRelation(definition, {
                    fromKind: 'node',
                    fromId: newEdgeReversed ? newEdgePair.target : newEdgePair.source,
                    toKind: 'node',
                    toId: newEdgeReversed ? newEdgePair.source : newEdgePair.target,
                  });
                  if (!checked.ok) throw new Error(checked.message);
                  const created = await relationTypeUsecases.createRelationType(definition);
                  setNewEdgeTypeId(created.id);
                  setNewEdgeCreatingType(false);
                }}
              />
            ) : (
              <RelationTypeField
                className="graph-newedge__select"
                buttonClassName="graph-newedge__input relation-type-field__button"
                autoFocus
                value={newEdgeTypeId}
                onChange={setNewEdgeTypeId}
                options={newEdgeTypeOptions}
                resolveOptionColor={resolveRelationTypeColor}
                placeholder={t('storyGraph.edge.kindPlaceholder')}
                ariaLabel={t('storyGraph.edge.kindLabel')}
              />
            )}
            <div className="graph-newedge__actions">
              <button onClick={closeNewEdgeDialog}>{t('common.cancel')}</button>
              <button
                className="is-primary"
                disabled={!newEdgeTypeId}
                onClick={() => {
                  if (!newEdgeTypeId) return;
                  const source = newEdgeReversed ? newEdgePair.target : newEdgePair.source;
                  const target = newEdgeReversed ? newEdgePair.source : newEdgePair.target;
                  void createEdge(source, target, newEdgeTypeId);
                  closeNewEdgeDialog();
                }}
              >
                {t('storyGraph.edge.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {hoverPreview && (
        <EntityHoverCard
          target={hoverPreview.data}
          anchor={hoverPreview.anchor}
          placement={hoverPlacementFor(hoverPreview.data)}
          pointer={hoverCard}
          onDismiss={hoverDismiss}
          actions={hoverActionsFor(hoverPreview.data)}
        />
      )}

      {/* Node card popover — opened by tile click. Renders fixed-position
          over the graph; the inner upgrade state expands to a modal. */}
      {popover &&
        projectId &&
        user?.id &&
        (() => {
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
    </SuperViewShell>
  );
}
