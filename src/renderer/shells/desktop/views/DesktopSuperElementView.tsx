import { SuperElementDriftCards, type SuperElementDriftCardsProps } from '../../../features/graph/SuperElementDriftCards';
import {
  CELL_W, CELL_H, BAND_PILL_PX, BAND_SLOT_PX, BAND_RAIL_PX,
  GROUP_HEADER_PX, DESKTOP_CATEGORY_INNER_PAD_Y_TOP,
  CATEGORY_INNER_PAD_Y_BOTTOM, CATEGORY_GAP_X,
  cardColStep, ZOOM_MIN, ZOOM_MAX, BAND_PAD_CELLS,
  BAND_PAD_PX, BAND_OUTER_PAD_PX, BAND_OUTER_RESERVE_CELLS, STICKY_PAD_CELLS_X,
  STICKY_PAD_CELLS_Y, EDGE_HIT_WIDTH, SUPER_ELEMENT_EDGE_WIDTHS,
} from '../../../features/graph/super-element-metrics';
import { SuperElementChapterBand, type ChapterBandProps } from '../../../features/graph/SuperElementChapterBand';
import { SuperElementCategoryBox, type CategoryBoxProps } from '../../../features/graph/SuperElementCategoryBox';
import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/data-store';
import { useDataStoreFields } from '../../../store/use-data-store-fields';
import { useSuperViewNavigation } from '../../../hooks/useSuperViewNavigation';
import { useAuthStore } from '../../../store/auth';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useTimelineMarkers } from '../../../hooks/useTimelineMarkers';
import { useRelationTypePresentation } from '../../../hooks/useRelationTypePresentation';
import { useSuperViewEscapeStack } from '../../../hooks/useSuperViewEscapeStack';
import { actBoundDriftIds } from '../../../domain/book-act';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import { isChapter, isDrift } from '../../../domain/book-node';
import { entityHoverActions } from '../../../components/leftBars/entity-hover-actions';
import { useEntityCellAction } from '../../../hooks/useEntityCellAction';
import { EntityHoverCard } from '../../../features/entities/hover/EntityHoverCard';
import type { EntityHoverTarget } from '../../../features/entities/hover/entity-hover-card-model';
import { withDriftGroupChoices, withElementCategoryChoices, withElementGroupChoices } from '../../../features/entities/hover/hover-choices';
import { SuperElementIsleLines } from '../../../features/graph/SuperElementIsleLines';
import {
  SuperElementRelateLayer,
  type RelateEdgeView,
  type SuperElementRelateLayerHandle,
} from '../../../features/graph/SuperElementRelateLayer';
import { RELATE_MOVE_MS, relateEase, useElementRelateLayout } from '../../../features/graph/useElementRelateLayout';
import {
  relateBend,
  relateBounds,
  relateCellHalf,
  type ElementLayoutMode,
  type RelateNodeInput,
  type RelatePoint,
  type RelateSpring,
} from '../../../features/graph/element-relate-layout';
import {
  ISLES_LOD_ZOOM,
  isleCompanions,
  isleMarkWeight,
  isleNeighbours,
  islePairs,
  islesLod,
  isleTicks,
  type IslesLod,
} from '../../../features/graph/element-isles-model';
import { useElementMentionGraph } from '../../../usecase/useElementMentionGraph';
import { useBookElement } from '../../../usecase/useBookElement';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { SuperElementLineThreshold } from '../components/SuperElementLineThreshold';
import { SuperElementLayoutSwitch, SuperElementLinesRow } from '../components/SuperElementCanvasTools';
import { CategoryIsleDetail, CategoryIsleStrip, ElementIsleDetail, ElementIsleStrip } from '../components/ElementIsleDetail';
import { SuperElementIsland } from '../components/SuperElementIsland';
import { readIslandWidth } from '../components/super-element-island-width';
import { ElementEditorView } from '../../../views/ElementEditorView';
import { CategoryEditorView } from '../../../views/CategoryEditorView';
import { useDriftGroup } from '../../../usecase/useDriftGroup';
import { findById } from '../../../lib/immutable-id-index';
import {
  solveSuperElementLayout,
  type LayoutInput,
  type LayoutPlacement,
} from '../../../lib/super-element-layout';
import type { AnchorRect } from './ElementCardPopover';
import type { RelationEdgePopoverAnchor } from '../../../components/graph/RelationEdgePopover';
import { useEntityRelations } from '../../../usecase/useEntityRelations';
import { useEntityRelationTypes } from '../../../usecase/useEntityRelationTypes';
import type { GraphViewProps } from '../../../features/graph/graph-ui-components.types';
import { DesktopSuperViewHeader } from '../components/DesktopSuperViewHeader';
import { SuperViewShell } from '../../../components/SuperViewShell';
import { Button } from '../../../components/ui/Button';
import { RelationTypeField } from '../../../components/ui/RelationTypeField';
import {
  validateRelationAgainstType,
  validateRelationTypeDefinitionAgainstRelation,
} from '../../../domain/entity-relation-type';
import { RelationTypeEditor } from '../../../components/ui/RelationKindMenu';
import { defaultRelationTypeColor } from '../../../components/ui/relation-type-color';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../../components/ui/Modal';
import { GhostIconButton } from '../../../components/ui/GhostIconButton';
import {
  buildSuperElementCategoryModel,
  type SuperElementCategoryModel as CategoryRenderModel,
} from '../../../features/graph/super-element-category-model';
import { useSuperElementTransform } from '../../../features/graph/useSuperElementTransform';
import { projectSuperElementDriftEdges } from '../../../features/graph/super-element-drift-model';
import { useSuperViewRelationUi } from '../../../features/graph/super-view-relation-ui-context';
import {
  beginSuperViewPinch,
  updateSuperViewPinch,
  type SuperViewPinchOrigin,
} from '../../../features/graph/super-view-canvas-gesture';
import { getPlatformRuntime } from '../../../platform/runtime';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { KindMark } from '../../../components/ui/KindMark';
import { EmptyState } from '../../../components/ui/EmptyState';
import '../../../../styles/super-element.css';

// localStorage key for the viewport (pan + zoom) per project. Restoring on
// re-entry preserves the user's mental map — they don't have to re-pan to
// the iceberg every time they pop the view.
function viewportStorageKey(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return `super-element-view:viewport:${projectId}`;
}

// Fitting the islands or the 关系 layout to the window leaves the legend of
// the lines (top right) clear; the layout switch is in the header.
const CANVAS_FIT_LEFT = 24;
const CANVAS_FIT_RIGHT = 180;
// Past this many relation lines in the window the role names follow the
// element under the pointer or in focus only.
const RELATE_LABEL_BUDGET = 60;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function buildCategoryRenderModel(
  categoryId: string,
  category: BookElementCategory | null,
  elements: BookElement[],
  paddingTop: number,
): CategoryRenderModel {
  return buildSuperElementCategoryModel(categoryId, category, elements, {
    cellHeight: CELL_H,
    groupHeaderHeight: GROUP_HEADER_PX,
    paddingTop,
    paddingBottom: CATEGORY_INNER_PAD_Y_BOTTOM,
  });
}

export function DesktopSuperElementView({ graphUi, driftPanel, SuperViewRelationLegend }: GraphViewProps) {
  const { DriftPanel, NodeCardPopover, RelationEdgePopover, RelationArrowMarker, relationArrowMarkerId, relationEdgePath, ElementCardPopover, SuperElementDriftEdges, SuperElementViewportEdges, buildSuperElementWorldEdges, useCanvasHoverCard } = graphUi;
  const { t } = useTranslation();
  const mobileShell = getPlatformRuntime().isMobileShell;
  const { setActive: setActiveSuperView } = useSuperViewNavigation();
  const close = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);
  const { openEntity, projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const {
    edgeKindMeta,
    hiddenRelationTypeIds,
    setDriftPanelOpen: setSharedDriftPanelOpen,
  } = useSuperViewRelationUi('element');
  const presentRelationType = useRelationTypePresentation();

  const {
    bookElements,
    bookElementCategories,
    bookNodes,
    storylines,
    nodeStorylineMapping,
    entityRelations,
    entityRelationTypes,
    primaryStorylineByNode,
    driftGroups,
  } = useDataStoreFields(
    'bookElements',
    'bookElementCategories',
    'bookNodes',
    'storylines',
    'nodeStorylineMapping',
    'entityRelations',
    'entityRelationTypes',
    'primaryStorylineByNode',
    'driftGroups',
  );
  const relationTypeById = useMemo(
    () => new Map(entityRelationTypes.map((type) => [type.id, type])),
    [entityRelationTypes],
  );
  const relationEndpointLabel = useCallback(
    (kind: string, id: string) => {
      if (kind === 'element') return findById(bookElements, id)?.name ?? '?';
      if (kind === 'node') return findById(bookNodes, id)?.title ?? '?';
      return '?';
    },
    [bookElements, bookNodes],
  );

  // Active popover state. Card click opens the two-tier editor; the popover
  // itself owns ESC + outside-click dismissal, but the SuperElementView ESC
  // listener below also closes it as a safety net.
  const [activePopover, setActivePopover] = useState<{
    elementId: string;
    anchor: AnchorRect;
  } | null>(null);

  // Desktop islands (element-isles-model.ts): a click focuses an element
  // instead of opening its popover; the detail card at the right edge offers
  // the popover's editing as one of its actions.
  const [isleFocus, setIsleFocus] = useState<string | null>(null);
  const [isolated, setIsolated] = useState(false);
  const [linesOn, setLinesOn] = useState(true);
  const [lineThreshold, setLineThreshold] = useState(2);
  const [findQuery, setFindQuery] = useState('');
  // The floating island (SuperElementIsland) holds the focused element or a
  // clicked category: a small card first, 编辑 grows it into the sheet with
  // the workspace's own editor, at the width the author last dragged it to.
  const [isleCategory, setIsleCategory] = useState<string | null>(null);
  const [islandMode, setIslandMode] = useState<'peek' | 'sheet'>('peek');
  const [islandWidth, setIslandWidth] = useState(readIslandWidth);
  const closeIsland = useCallback(() => {
    setIsleFocus(null);
    setIsleCategory(null);
    setIsolated(false);
    setIslandMode('peek');
  }, []);

  // Click-focus neighborhood: while an element's popover is open, the
  // elements it shares an edge with — and those edges — light up so the
  // clicked card's graph neighborhood reads at a glance. Cleared with the
  // popover.
  const focusedElementId = mobileShell ? (activePopover?.elementId ?? null) : isleFocus;
  const focusConnected = useMemo(() => {
    if (!focusedElementId) return null;
    const elementIds = new Set<string>();
    const edgeIds = new Set<string>();
    for (const r of entityRelations) {
      const fromHit = r.fromKind === 'element' && r.fromId === focusedElementId;
      const toHit = r.toKind === 'element' && r.toId === focusedElementId;
      if (!fromHit && !toHit) continue;
      edgeIds.add(r.id);
      if (fromHit && r.toKind === 'element') elementIds.add(r.toId);
      if (toHit && r.fromKind === 'element') elementIds.add(r.fromId);
    }
    return { elementIds, edgeIds };
  }, [focusedElementId, entityRelations]);

  // Selection / linking / drift-panel state — declared up front so the ESC
  // stack and pointer-dismiss listener below can reference them. Their
  // commit handlers (confirmPendingLink / deleteSelectedEdge) and derived
  // edge data come later, after layout is computed.
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
  const [mobileLinkMode, setMobileLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<{ kind: 'element' | 'node'; id: string } | null>(
    null,
  );
  // Element, category and drift cards offer the same per-entity actions as
  // the left panels and the editor's ⋯ menu, on their hover cards (there
  // are no right-click menus). Starting a relation from the card is this
  // view's own extra.
  const dispatchEntityAction = useEntityCellAction();
  const { moveDriftToGroup } = useDriftGroup({ projectId: projectId ?? '' });
  const [pendingLink, setPendingLink] = useState<{
    source: { kind: 'element' | 'node'; id: string };
    target: { kind: 'element' | 'node'; id: string };
  } | null>(null);
  const [pendingLinkTypeId, setPendingLinkTypeId] = useState<string | null>(null);
  const [pendingLinkReversed, setPendingLinkReversed] = useState(false);
  const [pendingLinkCreatingType, setPendingLinkCreatingType] = useState(false);
  const closePendingLink = useCallback(() => {
    setPendingLink(null);
    setPendingLinkTypeId(null);
    setPendingLinkReversed(false);
    setPendingLinkCreatingType(false);
  }, []);
  const configuredRelationTypes = entityRelationTypes;
  const pendingLinkTypeOptions = useMemo(() => {
    if (!pendingLink) return configuredRelationTypes;
    const source = pendingLinkReversed ? pendingLink.target : pendingLink.source;
    const target = pendingLinkReversed ? pendingLink.source : pendingLink.target;
    return configuredRelationTypes.filter(
      (type) =>
        validateRelationAgainstType(type, {
          fromKind: source.kind,
          fromId: source.id,
          toKind: target.kind,
          toId: target.id,
        }).ok,
    );
  }, [configuredRelationTypes, pendingLink, pendingLinkReversed]);
  // Sticky band toggle. ON = band detaches from world transform so it can
  // snap to the top/bottom viewport edge when the canvas pans past it; pan
  // and zoom are also clamped so the band's x extent always covers the
  // viewport, plus y stays within the categories' vertical extent.
  // OFF = current behaviour (band rides with world).
  const [bandSticky, setBandSticky] = useState(false);
  // Edge focus toggle. ON = only render edges whose element endpoint is
  // currently inside the viewport (and not behind the sticky band, when
  // sticky is also on). OFF = render every edge in world space, regardless
  // of visibility. Independent from bandSticky — users may want one
  // without the other.
  const [edgesViewportOnly, setEdgesViewportOnly] = useState(false);
  // Drift panel state machine + open/close helpers come from the shared
  // hook so SuperElementView and StoryGraphView stay in sync.
  const {
    mounted: driftPanelMounted,
    open: driftPanelOpen,
    closing: driftPanelClosing,
    openPanel: openDriftPanel,
    closePanel: closeDriftPanel,
  } = driftPanel;
  useEffect(() => {
    setSharedDriftPanelOpen(driftPanelOpen);
    return () => setSharedDriftPanelOpen(false);
  }, [driftPanelOpen, setSharedDriftPanelOpen]);
  // Drift-node popover (two-tier name + summary + body editor). Mirrors the
  // popover anchor pattern used for element cards.
  const [activeDriftPopover, setActiveDriftPopover] = useState<{
    nodeId: string;
    anchor: AnchorRect;
  } | null>(null);
  // No hover card opens while a card popover, link picking or the relation
  // dialog is up; presses, pans and zooms close a showing one.
  const {
    preview: hoverPreview,
    onEnter: hoverEnter,
    onLeave: hoverLeave,
    dismiss: hoverDismiss,
    card: hoverCard,
  } = useCanvasHoverCard(
    activePopover !== null ||
      activeDriftPopover !== null ||
      linkSource !== null ||
      mobileLinkMode ||
      pendingLink !== null ||
      selectedEdgeId !== null,
  );
  useSuperViewEscapeStack(
    [
      {
        id: `element-popover:${activePopover?.elementId ?? ''}`,
        active: activePopover !== null,
        onEscape: () => setActivePopover(null),
      },
      {
        id: `drift-popover:${activeDriftPopover?.nodeId ?? ''}`,
        active: activeDriftPopover !== null,
        onEscape: () => setActiveDriftPopover(null),
      },
      {
        id: pendingLink
          ? `pending-link:${pendingLink.source.kind}:${pendingLink.source.id}:${pendingLink.target.kind}:${pendingLink.target.id}`
          : 'pending-link',
        active: pendingLink !== null,
        onEscape: closePendingLink,
      },
      {
        id: `selected-edge:${selectedEdgeId ?? ''}`,
        active: selectedEdgeId !== null,
        onEscape: clearSelectedEdge,
      },
      {
        id: linkSource ? `link-source:${linkSource.kind}:${linkSource.id}` : 'link-source',
        active: linkSource !== null,
        onEscape: () => setLinkSource(null),
      },
      {
        id: 'mobile-link-mode',
        active: mobileLinkMode,
        onEscape: () => setMobileLinkMode(false),
      },
      {
        id: `isle-focus:${isleFocus ?? ''}`,
        active: !mobileShell && isleFocus !== null,
        onEscape: closeIsland,
      },
      {
        id: `isle-category:${isleCategory ?? ''}`,
        active: !mobileShell && isleCategory !== null,
        onEscape: closeIsland,
      },
      {
        // After the focus layers so a subject switched inside the sheet is
        // still collapsed back to its card before the island closes.
        id: `island-sheet:${isleFocus ?? isleCategory ?? ''}`,
        active: !mobileShell && islandMode === 'sheet' && (isleFocus !== null || isleCategory !== null),
        onEscape: () => setIslandMode('peek'),
      },
      {
        id: 'drift-panel',
        active: driftPanelMounted && !driftPanelClosing,
        onEscape: closeDriftPanel,
      },
    ],
    close,
  );

  // Dismiss the edge selection on any click that doesn't land on an edge or
  // its body-portaled detail surface.
  useEffect(() => {
    if (!selectedEdgeId) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest('[data-super-edge]') || t.closest('[data-relation-edge-popover]')) return;
      clearSelectedEdge();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [clearSelectedEdge, selectedEdgeId]);

  // ---- Build category render models (size + internal layout) ----
  // Sentinel bucket for elements with categoryId === null ("未分类").
  // Surfaced by SuperElementView as a category-less group at the tail.
  const UNCATEGORIZED_KEY = '__uncategorized__';

  const elementsByCategory = useMemo(() => {
    const m = new Map<string, BookElement[]>();
    for (const cat of bookElementCategories) m.set(cat.id, []);
    for (const el of bookElements) {
      const key = el.categoryId ?? UNCATEGORIZED_KEY;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(el);
    }
    return m;
  }, [bookElements, bookElementCategories]);

  // A taller name plate is set into the frame's top edge.
  const categoryPadTop = DESKTOP_CATEGORY_INNER_PAD_Y_TOP;
  const categoryModels = useMemo<CategoryRenderModel[]>(() => {
    const known = new Set(bookElementCategories.map((c) => c.id));
    const models: CategoryRenderModel[] = [];
    for (const cat of bookElementCategories) {
      const items = elementsByCategory.get(cat.id) ?? [];
      models.push(buildCategoryRenderModel(cat.id, cat, items, categoryPadTop));
    }
    // Two flavors of "no category":
    //   * `categoryId === null` → the new "未分类" bucket (post-trash refactor)
    //   * `categoryId === <id of a missing category>` → orphan from a stale row
    // Both render as a category-less group with category=null.
    const orphanBuckets = new Map<string, BookElement[]>();
    for (const el of bookElements) {
      const key = el.categoryId ?? UNCATEGORIZED_KEY;
      if (el.categoryId != null && known.has(el.categoryId)) continue;
      const list = orphanBuckets.get(key) ?? [];
      list.push(el);
      orphanBuckets.set(key, list);
    }
    orphanBuckets.forEach((items, cid) => {
      models.push(buildCategoryRenderModel(cid, null, items, categoryPadTop));
    });
    return models;
  }, [bookElementCategories, bookElements, elementsByCategory, categoryPadTop]);

  // ---- Layout ----
  // Band height in cells: one row per storyline plus BAND_PAD_CELLS of
  // breathing space (split half above the storyline rows, half below) so
  // categories don't bump straight into the band. Empty-state minimum: 2 cells.
  const bandHeightCells = Math.max(2, storylines.length + BAND_PAD_CELLS);

  // Band width in cells: spans the bookOrder range of placed nodes, plus
  // 2 cells slack on each side for the pill width.
  const placedNodes = useMemo(() => bookNodes.filter(isChapter), [bookNodes]);
  // bandWidthCells is now purely a fallback for the empty-state band; when
  // there are chapters, the band sizes itself to the slot count via the
  // ChapterBand component's internal math.
  const bandWidthCells = Math.max(8, placedNodes.length);

  // The band's leftmost edge in WORLD pixels. We center the band on world
  // x=0 so the category solver's anchorX=0 corresponds to the band's visual
  // center, giving the iceberg shape the right balance point.
  // The band opens with the storyline name rail (BAND_RAIL_PX).
  const bandRailPx = BAND_RAIL_PX;
  const bandPxWidth = bandRailPx + bandWidthCells * BAND_SLOT_PX;
  const bandWorldLeft = -bandPxWidth / 2;
  // Band's visible top in world coords — offset down by BAND_OUTER_PAD_PX
  // so categories above land a half-cell-equivalent above the band's visible
  // edge (and bottom-strip categories the same distance below).
  const bandTopWorldY = BAND_OUTER_PAD_PX;
  const bandWorldCenterY = bandTopWorldY + (bandHeightCells * CELL_H) / 2;

  // Solver-reserved band space — actual visible band height plus an extra
  // BAND_OUTER_RESERVE_CELLS cells so categories sit a bit further away,
  // leaving a visible gap on both sides of the band.
  // The desktop has no chapter band: the islands above and below leave one
  // cell of sea between them, and where an element appears lives on its
  // detail card instead.
  const bandReservedHeightCells = mobileShell ? bandHeightCells + BAND_OUTER_RESERVE_CELLS : 1;
  const layout = useMemo(() => {
    const inputs: LayoutInput[] = categoryModels.map((m) => ({
      id: m.categoryId,
      widthCells: m.widthCells,
      heightCells: m.heightCells,
      pinned:
        m.category?.layoutMode === 'pinned' &&
        m.category.gridX !== null &&
        m.category.gridY !== null
          ? { gridX: m.category.gridX, gridY: m.category.gridY }
          : undefined,
    }));
    return solveSuperElementLayout(inputs, {
      bandHeightCells: bandReservedHeightCells,
      anchorX: 0, // categories cluster around world x=0 (== band center)
      searchExtent: 96,
      balanceAlpha: 1.0,
    });
  }, [categoryModels, bandReservedHeightCells]);

  const placementById = useMemo(() => {
    const m = new Map<string, LayoutPlacement>();
    layout.placements.forEach((p) => m.set(p.id, p));
    return m;
  }, [layout]);

  // ---- World-space coordinate maps for edge rendering ----
  // Element card center (world pixels). Computed by walking the same
  // groups/columns/rows layout the renderer uses in CategoryBox.
  const elementCenters = useMemo(() => {
    const m = new Map<string, { x: number; y: number; categoryId: string }>();
    for (const model of categoryModels) {
      const placement = placementById.get(model.categoryId);
      if (!placement) continue;
      // Mirrors CategoryBox: visible box is inset by CATEGORY_GAP_X/2 on
      // its left edge, and cards are laid out on a compressed colStep so
      // the rightmost column sits 3px shy of the visible right border.
      const boxX = placement.gridX * CELL_W + CATEGORY_GAP_X / 2;
      const boxY = placement.gridY * CELL_H;
      const colStep = cardColStep(model.widthCells);
      for (const g of model.groups) {
        g.items.forEach((el, idx) => {
          const col = idx % model.widthCells;
          const rowOffset = Math.floor(idx / model.widthCells);
          const x = boxX + col * colStep + colStep / 2;
          const y = boxY + g.cardRowsTopPx + rowOffset * CELL_H + CELL_H / 2;
          m.set(el.id, { x, y, categoryId: model.categoryId });
        });
      }
    }
    return m;
  }, [categoryModels, placementById]);

  // Chapter pill center (world pixels). Drift nodes (mainStorylineId=null)
  // are excluded — they live in the optional drift panel and use a
  // viewport-space SVG layer instead.
  const sortedPlacedNodesAll = useMemo(
    () => placedNodes.slice().sort((a, b) => a.bookOrder - b.bookOrder),
    [placedNodes],
  );
  const nodeCenters = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (!mobileShell) return m;
    const rowIndex = new Map<string, number>();
    storylines.forEach((s, i) => rowIndex.set(s.id, i));
    sortedPlacedNodesAll.forEach((n, idx) => {
      const rowIdx = rowIndex.get(primaryStorylineByNode[n.id] ?? '');
      if (rowIdx === undefined) return;
      const x = bandWorldLeft + bandRailPx + idx * BAND_SLOT_PX + BAND_PILL_PX / 2;
      // Band top in world coords sits at bandTopWorldY (outer pad). Inside
      // the band, storyline rows are offset by BAND_PAD_PX (inner pad).
      const y = bandTopWorldY + BAND_PAD_PX + rowIdx * CELL_H + CELL_H / 2;
      m.set(n.id, { x, y });
    });
    return m;
  }, [mobileShell, sortedPlacedNodesAll, storylines, bandWorldLeft, bandRailPx, bandTopWorldY, primaryStorylineByNode]);

  // Drift no longer has a bookOrder — sort by recency (matches DriftPanel).
  // Drifts BOUND to a timeline marker OR an act are excluded: they've
  // "landed" (narrative axis / act notes) and shouldn't float in the drawer
  // too. Bound-ness derives from the marker + act tables — no status flag.
  const { boundDriftIds } = useTimelineMarkers(projectId);
  const bookActs = useDataStore((s) => s.bookActs);
  const allBoundDriftIds = useMemo(() => {
    const ids = new Set(boundDriftIds);
    for (const id of actBoundDriftIds(bookActs)) ids.add(id);
    return ids;
  }, [boundDriftIds, bookActs]);
  const driftNodes = useMemo(
    () =>
      bookNodes
        .filter(isDrift)
        .filter((n) => !allBoundDriftIds.has(n.id))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [bookNodes, allBoundDriftIds],
  );

  // ---- Reference / edge state ----
  const { addRelation, removeRelation } = useEntityRelations({
    projectId: projectId ?? '',
    userId,
  });
  const relationTypeUsecases = useEntityRelationTypes({ projectId: projectId ?? '' });
  const resolveRelationTypeColor = useCallback(
    (relationTypeId: string): string => {
      return (
        edgeKindMeta.meta[relationTypeId]?.color ??
        defaultRelationTypeColor(relationTypeId)
      );
    },
    [edgeKindMeta.meta],
  );
  const resolveRelationTypeLabel = useCallback(
    (relationTypeId: string): string => {
      const relationType = relationTypeById.get(relationTypeId);
      return relationType
        ? presentRelationType(relationType).name
        : t('relationTypes.missing');
    },
    [presentRelationType, relationTypeById, t],
  );

  // Filter & build edges sourced from the manual-reference store. v1 only
  // pulls non-inline refs (fromBlockId IS NULL — that's the store filter);
  // inline @-mention refs live in reference-index.service and aren't
  // surfaced here yet. The edge endpoints must be either element ↔ element
  // or element ↔ node (we don't render pure node ↔ node, that's StoryGraphView's
  // job). Drift-touching edges are also dropped here and rendered by the
  // viewport-space drift layer instead.
  // FULL drift set on purpose (not the panel-filtered list above): the edge
  // filters below must keep treating a marker-bound drift as a drift, or its
  // refs would leak into the world-edge layer with no position to anchor to.
  const driftIds = useMemo(() => new Set(bookNodes.filter(isDrift).map((n) => n.id)), [bookNodes]);

  const worldEdges = useMemo(() => buildSuperElementWorldEdges({
    entityRelations, hiddenRelationTypeIds, bookElements, bookNodes, elementCenters, nodeCenters,
    driftIds, relationTypeById, resolveRelationTypeColor,
    cellWidth: CELL_W, cellHeight: CELL_H, bandPillWidth: BAND_PILL_PX,
  }), [
    entityRelations,
    hiddenRelationTypeIds,
    elementCenters,
    nodeCenters,
    driftIds,
    bookElements,
    bookNodes,
    resolveRelationTypeColor,
    relationTypeById,
  ]);

  // ---- Islands (desktop) ----
  // Lines from the prose: two elements mentioned in the same paragraph of a
  // chapter. Their weight sizes each mark from far away; the relations the
  // author drew stay their own coloured lines on top.
  const { graph: mentionGraph } = useElementMentionGraph(projectId, !mobileShell);
  const { updateElement, createElement } = useBookElement({ projectId: projectId ?? '', userId });
  const { updateCategory } = useElementCategory({ projectId: projectId ?? '', userId });
  const presentElementIds = useMemo(() => new Set(bookElements.map((el) => el.id)), [bookElements]);
  const thresholdLines = useMemo(
    () => (!mobileShell && mentionGraph ? islePairs(mentionGraph.pairs, lineThreshold, presentElementIds) : []),
    [mobileShell, mentionGraph, lineThreshold, presentElementIds],
  );
  const isleLines = useMemo(() => (linesOn ? thresholdLines : []), [linesOn, thresholdLines]);
  const markWeights = useMemo(() => {
    if (mobileShell || !mentionGraph) return null;
    let most = 0;
    for (const entry of mentionGraph.elements.values()) most = Math.max(most, entry.mentions);
    const weights = new Map<string, number>();
    for (const [id, entry] of mentionGraph.elements) {
      if (entry.mentions > 0) weights.set(id, isleMarkWeight(entry.mentions, most));
    }
    return weights;
  }, [mobileShell, mentionGraph]);
  const relationPairs = useMemo(
    () => entityRelations
      .filter((r) => r.fromKind === 'element' && r.toKind === 'element' && !hiddenRelationTypeIds.has(r.relationTypeId))
      .map((r) => ({ a: r.fromId, b: r.toId })),
    [entityRelations, hiddenRelationTypeIds],
  );
  // ---- The 关系 layout (desktop) ----
  // Beside the islands the elements can be laid out by their relations
  // (element-relate-layout.ts): the relations the author drew pull hard,
  // the sand lines' paragraphs a little, every element keeps the others
  // away and rests near its island's place on a small map of the islands.
  // What a relation line says: a directed relation its two roles, one at
  // each end (师父 / 徒弟); a symmetric one, whose shared role often only
  // names the kind of endpoint, its type's name once in the middle (呼应).
  const relateRoles = useCallback((relationTypeId: string): string[] => {
    const type = relationTypeById.get(relationTypeId);
    if (!type) return [];
    const presented = presentRelationType(type);
    const source = presented.sourceRole.trim();
    const target = presented.targetRole.trim();
    if (type.orientation === 'directed' && source && target && source !== target) return [source, target];
    return [presented.name];
  }, [presentRelationType, relationTypeById]);
  const relateNodes = useMemo<RelateNodeInput[]>(
    () => (mobileShell ? [] : bookElements.map((el) => ({ id: el.id, name: el.name, anchor: elementCenters.get(el.id) ?? { x: 0, y: 0 } }))),
    [mobileShell, bookElements, elementCenters],
  );
  const relateSprings = useMemo<RelateSpring[]>(() => {
    if (mobileShell) return [];
    const springs: RelateSpring[] = [];
    for (const r of entityRelations) {
      if (r.fromKind !== 'element' || r.toKind !== 'element' || hiddenRelationTypeIds.has(r.relationTypeId)) continue;
      if (!presentElementIds.has(r.fromId) || !presentElementIds.has(r.toId)) continue;
      springs.push({ a: r.fromId, b: r.toId, kind: 'relation', roles: relateRoles(r.relationTypeId) });
    }
    for (const pair of isleLines) springs.push({ a: pair.a, b: pair.b, kind: 'prose', count: pair.count });
    return springs;
  }, [mobileShell, entityRelations, hiddenRelationTypeIds, presentElementIds, relateRoles, isleLines]);
  const relateLayerRef = useRef<SuperElementRelateLayerHandle | null>(null);
  const relate = useElementRelateLayout({
    projectId,
    enabled: !mobileShell,
    nodes: relateNodes,
    springs: relateSprings,
    aspect: () => {
      const viewport = viewportRef.current;
      return viewport && viewport.clientHeight > 0 ? viewport.clientWidth / viewport.clientHeight : 1.6;
    },
    reducedMotion: prefersReducedMotion,
    onFrame: () => relateLayerRef.current?.paint(),
  });
  const {
    mode: relateMode, setMode: setRelateMode, live: relateLive, rest: relateRest, pins: relatePins,
    moving: relateMoving, current: relateCurrent, settle: settleRelateLayout, moveTo: moveRelateTo, place: placeRelate,
    beginDrag: beginRelateDrag, dragTo: dragRelateTo, endDrag: endRelateDrag, unpin: unpinRelate, relayout: relayoutRelate,
  } = relate;
  // Leaving 关系, the cells first travel back to their islands.
  const [relateLeaving, setRelateLeaving] = useState(false);
  const layoutMode: ElementLayoutMode = mobileShell ? 'isles' : relateMode;
  const relateShown = !mobileShell && (layoutMode === 'relate' || relateLeaving);
  const [relateDragging, setRelateDragging] = useState<string | null>(null);
  const relatePinnedIds = useMemo(() => new Set(relatePins.keys()), [relatePins]);

  const isleNeighbourhood = useMemo(
    () => (!mobileShell && isleFocus ? isleNeighbours(isleFocus, isleLines, relationPairs) : null),
    [mobileShell, isleFocus, isleLines, relationPairs],
  );
  const findHits = useMemo(() => {
    const query = findQuery.trim().toLocaleLowerCase();
    if (mobileShell || !query) return null;
    return new Set(
      bookElements
        .filter((el) => [el.name, ...(el.aliases ?? [])].some((name) => name.toLocaleLowerCase().includes(query)))
        .map((el) => el.id),
    );
  }, [mobileShell, findQuery, bookElements]);
  const dimmedElementIds = useMemo(() => {
    const keep = findHits ?? isleNeighbourhood;
    if (!keep) return null;
    return new Set(bookElements.filter((el) => !keep.has(el.id)).map((el) => el.id));
  }, [findHits, isleNeighbourhood, bookElements]);
  const hiddenElementIds = useMemo(() => {
    if (!isolated || !isleNeighbourhood) return null;
    return new Set(bookElements.filter((el) => !isleNeighbourhood.has(el.id)).map((el) => el.id));
  }, [isolated, isleNeighbourhood, bookElements]);
  const worldBounds = useMemo(() => {
    const { minX, maxX, minY, maxY } = layout.bounds;
    return {
      left: minX * CELL_W - CELL_W,
      top: minY * CELL_H - CELL_H,
      width: (maxX - minX + 2) * CELL_W,
      height: (maxY - minY + 2) * CELL_H,
    };
  }, [layout.bounds]);

  const relateNames = useMemo(() => new Map(bookElements.map((el) => [el.id, el.name])), [bookElements]);
  // In 关系 the sand lines are drawn where the layout last came to rest.
  const relateLineBounds = useMemo(() => {
    if (!relateRest) return worldBounds;
    const b = relateBounds(relateRest, relateNames);
    return { left: b.minX - CELL_W, top: b.minY - CELL_H, width: b.maxX - b.minX + CELL_W * 2, height: b.maxY - b.minY + CELL_H * 2 };
  }, [relateRest, relateNames, worldBounds]);

  // ---- Pan + zoom ----
  // Lazy initial state seeds the world transform so the FIRST frame already
  // has the band roughly in viewport center (rather than at world origin,
  // which would put it offscreen-top-left for one frame). The persistence
  // restore effect below refines this to the exact saved spot.
  const [pan, setPan] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  });
  const [zoom, setZoom] = useState(1);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const touchPointsRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<SuperViewPinchOrigin | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Refs mirror the latest pan/zoom for the native wheel listener (registered
  // once, no React closure deps) so it always sees fresh values.
  //
  // CRITICAL: ref sync uses useLayoutEffect, NOT useEffect. The mirror layout
  // effect below (writes DOM transform from refs) runs in the same layout
  // phase as state-driven re-renders. If the refs were synced via useEffect
  // (post-paint), the mirror would read STALE refs after a state-driven
  // update — most visibly on first mount: state restores to saved pan, but
  // refs still hold the lazy-init value, so the DOM gets painted at the
  // default position and only "jumps" to the saved value after the user
  // pans (because panning starts from panRef which is then in sync).
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => {
    panRef.current = pan;
  }, [pan]);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // ---- Viewport persistence ----
  // Persist (pan, zoom) per project so popping back into the view keeps the
  // user's spot on the iceberg. We gate the save on a `restored` STATE
  // (not a ref) so that the save effect waits for the restore's setPan/
  // setZoom to actually commit before its first write — otherwise the same
  // render that restores would also save the pre-restore default and clobber
  // whatever was previously stored.
  const [restoredForKey, setRestoredForKey] = useState<string | null>(null);

  const initialCenter = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return { pan: { x: 0, y: 0 }, zoom: 1 };
    if (!mobileShell) {
      // The islands fit the window, no closer than the middle distance.
      const { minX, maxX, minY, maxY } = layout.bounds;
      const width = Math.max(1, (maxX - minX) * CELL_W);
      const height = Math.max(1, (maxY - minY) * CELL_H);
      const room = viewport.clientWidth - CANVAS_FIT_LEFT - CANVAS_FIT_RIGHT;
      const zoom = Math.max(
        ZOOM_MIN,
        Math.min(ISLES_LOD_ZOOM.mid, room / width, (viewport.clientHeight - 96) / height),
      );
      return {
        pan: {
          x: CANVAS_FIT_LEFT + room / 2 - ((minX + maxX) / 2) * CELL_W * zoom,
          y: viewport.clientHeight / 2 - ((minY + maxY) / 2) * CELL_H * zoom,
        },
        zoom,
      };
    }
    return {
      pan: {
        // World x=0 lands at the band's horizontal center.
        x: viewport.clientWidth / 2,
        // Band's vertical midpoint is at world y = bandWorldCenterY.
        y: viewport.clientHeight / 2 - bandWorldCenterY,
      },
      zoom: 1,
    };
  }, [bandWorldCenterY, layout.bounds, mobileShell]);

  // useLayoutEffect (not useEffect) so the restored viewport is committed
  // to state + DOM BEFORE the first paint. Otherwise the lazy-init position
  // (window/2 fallback) shows for one frame, looking like a brief jump.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const key = viewportStorageKey(projectId);
    if (!key) return;
    if (restoredForKey === key) return;
    let next: {
      pan: { x: number; y: number };
      zoom: number;
      bandSticky?: boolean;
      edgesViewportOnly?: boolean;
    } | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          pan?: { x: number; y: number };
          zoom?: number;
          bandSticky?: boolean;
          edgesViewportOnly?: boolean;
        };
        if (
          parsed &&
          parsed.pan &&
          typeof parsed.pan.x === 'number' &&
          typeof parsed.pan.y === 'number' &&
          typeof parsed.zoom === 'number'
        ) {
          next = {
            pan: parsed.pan,
            zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parsed.zoom)),
            bandSticky: typeof parsed.bandSticky === 'boolean' ? parsed.bandSticky : false,
            edgesViewportOnly:
              typeof parsed.edgesViewportOnly === 'boolean' ? parsed.edgesViewportOnly : false,
          };
        }
      }
    } catch {
      /* corrupt storage — fall through to default centering */
    }
    if (!next) next = { ...initialCenter(), bandSticky: false, edgesViewportOnly: false };
    setPan(next.pan);
    setZoom(next.zoom);
    // The desktop has neither the band nor its 聚焦 filter any more.
    setBandSticky(mobileShell && next.bandSticky === true);
    setEdgesViewportOnly(mobileShell && next.edgesViewportOnly === true);
    setRestoredForKey(key);
  }, [projectId, initialCenter, restoredForKey, mobileShell]);

  // Save whenever pan / zoom / toggles change — but only after restore
  // has committed for the current project. localStorage writes are fast
  // enough that we don't bother debouncing pan drags.
  useEffect(() => {
    const key = viewportStorageKey(projectId);
    if (!key) return;
    if (restoredForKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ pan, zoom, bandSticky, edgesViewportOnly }));
    } catch {
      /* quota or privacy mode — ignore */
    }
  }, [projectId, pan, zoom, bandSticky, edgesViewportOnly, restoredForKey]);

  // Perf-critical: pan/zoom mutates a ref + the world div's style.transform
  // DIRECTLY (no setState) so cards + edges don't re-render on every
  // pointermove tick. State is committed once at gesture end so persistence
  // + derived computations (drift edge endpoints) catch up.
  const worldRef = useRef<HTMLDivElement>(null);
  // Separate band DOM node when sticky is ON — pulled out of the world so
  // its y can clamp to viewport edges independently while the world keeps
  // panning behind it.
  const bandRef = useRef<HTMLDivElement>(null);
  // Refs mirror the latest layout sizes / sticky flag so applyTransform and
  // the clamp helpers can read fresh values without bloating their dep arrays.
  const bandStickyRef = useRef(bandSticky);
  const bandWorldLeftRef = useRef(bandWorldLeft);
  const bandPxWidthRef = useRef(bandPxWidth);
  const bandHeightCellsRef = useRef(bandHeightCells);
  const bandTopWorldYRef = useRef(bandTopWorldY);
  // Cache layout's vertical bounds (in cell units) so the y clamp helper
  // below can read them without re-binding when the layout changes.
  const layoutBoundsRef = useRef(layout.bounds);
  useLayoutEffect(() => {
    bandStickyRef.current = bandSticky;
  }, [bandSticky]);
  useLayoutEffect(() => {
    bandWorldLeftRef.current = bandWorldLeft;
    bandPxWidthRef.current = bandPxWidth;
    bandHeightCellsRef.current = bandHeightCells;
    bandTopWorldYRef.current = bandTopWorldY;
  }, [bandWorldLeft, bandPxWidth, bandHeightCells, bandTopWorldY]);
  useLayoutEffect(() => {
    layoutBoundsRef.current = layout.bounds;
  }, [layout]);

  /** Sticky-mode min zoom: band must be at least as wide as the viewport
   *  so the viewport can stay fully contained in band's x range. */
  const clampZoomForSticky = useCallback((zoom: number): number => {
    if (!bandStickyRef.current || !viewportRef.current) return zoom;
    const vw = viewportRef.current.clientWidth;
    const bWidth = bandPxWidthRef.current;
    if (bWidth <= 0) return zoom;
    const minStickyZoom = vw / bWidth;
    return Math.max(minStickyZoom, zoom);
  }, []);

  /** Sticky-mode x bounds: pan.x clamped to the band's x range plus a few
   *  element-cards of breathing space on each side, so the layout doesn't
   *  feel caged against the viewport edges. */
  const clampPanXForSticky = useCallback((panX: number, zoom: number): number => {
    if (!bandStickyRef.current || !viewportRef.current) return panX;
    const vw = viewportRef.current.clientWidth;
    const bWidth = bandPxWidthRef.current;
    const bLeft = bandWorldLeftRef.current;
    if (bWidth <= 0) return panX;
    // Without pad: viewport ⊆ band in screen x.
    //   leftBand ≤ 0  →  pan.x ≤ -zoom*bLeft
    //   rightBand ≥ vw →  pan.x ≥ vw - zoom*(bLeft+bWidth)
    // With pad: allow the viewport edges to extend STICKY_PAD_CELLS_X cells
    // past the band — relaxes the hard clamp by `pad` on each side.
    const pad = STICKY_PAD_CELLS_X * CELL_W * zoom;
    const maxPanX = -zoom * bLeft + pad;
    const minPanX = vw - zoom * (bLeft + bWidth) - pad;
    if (minPanX > maxPanX) return (minPanX + maxPanX) / 2; // band narrower than viewport — center it
    return Math.max(minPanX, Math.min(maxPanX, panX));
  }, []);

  /** Sticky-mode y bounds: pan.y clamped to the category skyline's vertical
   *  extent, plus a few cards of breathing space top + bottom. */
  const clampPanYForSticky = useCallback((panY: number, zoom: number): number => {
    if (!bandStickyRef.current || !viewportRef.current) return panY;
    const vh = viewportRef.current.clientHeight;
    const bounds = layoutBoundsRef.current;
    if (!bounds) return panY;
    const minLayoutY = bounds.minY * CELL_H * zoom; // typically negative (top strip)
    const maxLayoutY = bounds.maxY * CELL_H * zoom; // positive (bottom strip)
    const layoutH = maxLayoutY - minLayoutY;
    if (layoutH <= 0) return panY;
    const pad = STICKY_PAD_CELLS_Y * CELL_H * zoom;
    if (layoutH >= vh) {
      // Tall layout — bound scroll to layout extent, with `pad` of slack.
      const maxPanY = -minLayoutY + pad; // topmost element near viewport top (+pad room)
      const minPanY = vh - maxLayoutY - pad; // bottommost near viewport bottom (+pad room)
      return Math.max(minPanY, Math.min(maxPanY, panY));
    }
    // Layout shorter than viewport — vertically center it.
    return (vh - layoutH) / 2 - minLayoutY;
  }, []);

  const applyTransform = useSuperElementTransform({ geometry: graphUi, worldRef, bandRef, viewportRef, panRef, zoomRef,
    bandStickyRef, bandHeightCellsRef, bandTopWorldYRef, bandWorldLeftRef, cellHeight: CELL_H });

  // Mirror committed state → DOM. Runs for non-gesture updates (restore,
  // reset, initial center, sticky toggle). Gesture-time updates bypass this
  // by writing ref + DOM directly.
  useLayoutEffect(() => {
    applyTransform();
  }, [pan, zoom, bandSticky, applyTransform]);

  // When sticky flips ON, the current pan/zoom might be outside the sticky
  // bounds — clamp them in one go so the band lands inside the viewport
  // immediately rather than waiting for the user to pan/zoom.
  useLayoutEffect(() => {
    if (!bandSticky) return;
    const nextZoom = clampZoomForSticky(zoomRef.current);
    const nextPanX = clampPanXForSticky(panRef.current.x, nextZoom);
    const nextPanY = clampPanYForSticky(panRef.current.y, nextZoom);
    if (
      nextZoom !== zoomRef.current ||
      nextPanX !== panRef.current.x ||
      nextPanY !== panRef.current.y
    ) {
      zoomRef.current = nextZoom;
      panRef.current = { x: nextPanX, y: nextPanY };
      setPan(panRef.current);
      setZoom(nextZoom);
    }
  }, [bandSticky, clampPanXForSticky, clampPanYForSticky, clampZoomForSticky]);

  // Toggle data-panning on the viewport-space edge SVGs (drift edges
  // always; the sticky-band edge layer when bandSticky is on). Their CSS
  // visibility flips on this attribute so we hide them during pan/zoom
  // without re-rendering anything — recomputing viewport endpoints on
  // every frame is expensive AND the lines are momentarily wrong anyway
  // because element positions are mid-transform.
  const setPanningVisual = useCallback((panning: boolean) => {
    edgePanningRef.current = panning;
    // A card would be left behind by the moving canvas.
    if (panning) hoverDismiss();
    // Each layer reveals itself only after fresh geometry reaches the DOM.
    const layers = [driftEdgeLayerRef.current, viewportEdgeLayerRef.current];
    for (const layer of layers) {
      if (!layer) continue;
      if (panning) layer.setAttribute('data-panning', '1');
    }
  }, [hoverDismiss]);

  // Wheel: same gesture-ref pattern. Commit state after a brief idle so
  // persistence + drift-edge recompute don't fire on every tick.
  const wheelCommitTimerRef = useRef<number | null>(null);
  const scheduleWheelCommit = useCallback(() => {
    if (wheelCommitTimerRef.current !== null) {
      window.clearTimeout(wheelCommitTimerRef.current);
    }
    wheelCommitTimerRef.current = window.setTimeout(() => {
      wheelCommitTimerRef.current = null;
      setPan(panRef.current);
      setZoom(zoomRef.current);
      setPanningVisual(false);
      window.dispatchEvent(new Event('super-element:pan-end'));
    }, 140);
  }, [setPanningVisual]);
  useEffect(
    () => () => {
      if (wheelCommitTimerRef.current !== null) {
        window.clearTimeout(wheelCommitTimerRef.current);
      }
    },
    [],
  );

  // ---- Camera moves between layouts ----
  // Switching layout carries the camera to the new layout's fit on the same
  // ease as the elements; a wheel or a press takes the camera back.
  const cameraFrameRef = useRef(0);
  const stopCamera = useCallback(() => {
    if (!cameraFrameRef.current) return;
    cancelAnimationFrame(cameraFrameRef.current);
    cameraFrameRef.current = 0;
    setPan(panRef.current);
    setZoom(zoomRef.current);
    setPanningVisual(false);
    window.dispatchEvent(new Event('super-element:pan-end'));
  }, [setPanningVisual]);
  const moveCamera = useCallback((to: { pan: { x: number; y: number }; zoom: number } | null, ms = RELATE_MOVE_MS) => {
    if (!to) return;
    if (cameraFrameRef.current) cancelAnimationFrame(cameraFrameRef.current);
    cameraFrameRef.current = 0;
    if (prefersReducedMotion()) {
      panRef.current = to.pan;
      zoomRef.current = to.zoom;
      setPan(to.pan);
      setZoom(to.zoom);
      return;
    }
    const from = { pan: { ...panRef.current }, zoom: zoomRef.current };
    const t0 = performance.now();
    setPanningVisual(true);
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const k = relateEase(t);
      panRef.current = { x: from.pan.x + (to.pan.x - from.pan.x) * k, y: from.pan.y + (to.pan.y - from.pan.y) * k };
      zoomRef.current = from.zoom + (to.zoom - from.zoom) * k;
      applyTransform();
      if (t < 1) {
        cameraFrameRef.current = requestAnimationFrame(frame);
        return;
      }
      cameraFrameRef.current = 0;
      setPan(panRef.current);
      setZoom(zoomRef.current);
      setPanningVisual(false);
      window.dispatchEvent(new Event('super-element:pan-end'));
    };
    cameraFrameRef.current = requestAnimationFrame(frame);
  }, [applyTransform, setPanningVisual]);
  useEffect(() => () => {
    if (cameraFrameRef.current) cancelAnimationFrame(cameraFrameRef.current);
  }, []);
  /** The camera that fits a 关系 layout into the window between the layout switch and the legend. */
  const fitRelate = useCallback((positions: ReadonlyMap<string, RelatePoint>) => {
    const viewport = viewportRef.current;
    if (!viewport || positions.size === 0) return null;
    const b = relateBounds(positions, relateNames);
    const room = viewport.clientWidth - CANVAS_FIT_LEFT - CANVAS_FIT_RIGHT;
    const width = Math.max(1, b.maxX - b.minX);
    const height = Math.max(1, b.maxY - b.minY);
    const zoom = Math.max(ZOOM_MIN, Math.min(ISLES_LOD_ZOOM.mid, room / width, (viewport.clientHeight - 96) / height));
    return {
      pan: {
        x: CANVAS_FIT_LEFT + (room - width * zoom) / 2 - b.minX * zoom,
        y: (viewport.clientHeight - height * zoom) / 2 - b.minY * zoom,
      },
      zoom,
    };
  }, [relateNames]);

  // Native wheel listener with passive:false so preventDefault is honored.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      // The island's editor scrolls itself.
      if ((e.target as Element | null)?.closest?.('[data-super-modal]')) return;
      stopCamera();
      if (e.ctrlKey || e.metaKey) {
        // ⌘/Ctrl + wheel → zoom around cursor. Trackpad pinch-zoom on
        // macOS dispatches wheel with ctrlKey=true regardless of physical
        // ⌘ state, so the same path covers both gestures.
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const prevZoom = zoomRef.current;
        let nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
        // Sticky mode bumps the min so band-x can still cover viewport.
        nextZoom = clampZoomForSticky(nextZoom);
        if (nextZoom === prevZoom) return;
        const realFactor = nextZoom / prevZoom;
        const prevPan = panRef.current;
        // Pivot: world point under the cursor stays put.
        let nextPan = {
          x: cx - (cx - prevPan.x) * realFactor,
          y: cy - (cy - prevPan.y) * realFactor,
        };
        nextPan = {
          x: clampPanXForSticky(nextPan.x, nextZoom),
          y: clampPanYForSticky(nextPan.y, nextZoom),
        };
        panRef.current = nextPan;
        zoomRef.current = nextZoom;
      } else {
        e.preventDefault();
        const prev = panRef.current;
        const z = zoomRef.current;
        panRef.current = {
          x: clampPanXForSticky(prev.x - e.deltaX, z),
          y: clampPanYForSticky(prev.y - e.deltaY, z),
        };
      }
      applyTransform();
      setPanningVisual(true);
      scheduleWheelCommit();
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [
    applyTransform,
    scheduleWheelCommit,
    setPanningVisual,
    clampPanXForSticky,
    clampPanYForSticky,
    clampZoomForSticky,
    stopCamera,
  ]);

  // ---- Carrying (desktop) ----
  // An element carried onto another island joins that category; an island
  // carried by its name is pinned where it lands (layoutMode 'pinned', the
  // solver packs the rest around it). Neither captures the pointer until it
  // has moved, so a plain click still reaches the card or the name.
  const elementDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  // In 关系 an element carried by the pointer is put where it lands (a pin);
  // its neighbours follow while it moves.
  const relateDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean; offX: number; offY: number } | null>(null);
  const islandDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const dragEndedAtRef = useRef(0);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [carried, setCarried] = useState<{ id: string; name: string; color?: string; x: number; y: number } | null>(null);
  const [dropCategoryId, setDropCategoryId] = useState<string | null>(null);
  const dropCategoryRef = useRef<string | null>(null);
  const categoryAtWorld = useCallback(
    (x: number, y: number): string | null => {
      for (const model of categoryModels) {
        if (!model.category) continue;
        const placement = placementById.get(model.categoryId);
        if (!placement) continue;
        const left = placement.gridX * CELL_W + CATEGORY_GAP_X / 2 - 16;
        const top = placement.gridY * CELL_H - 16;
        if (x >= left && x <= left + model.widthCells * CELL_W + 32 && y >= top && y <= top + model.heightCells * CELL_H + 32) {
          return model.categoryId;
        }
      }
      return null;
    },
    [categoryModels, placementById],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      stopCamera();
      if (!mobileShell && e.pointerType !== 'touch' && e.button === 0 && !e.shiftKey && !linkSource) {
        const target = e.target as Element | null;
        const card = target?.closest<HTMLElement>('[data-element-id]');
        if (card?.dataset.elementId && relateShown) {
          if (relateLeaving) return;
          relateDragRef.current = { id: card.dataset.elementId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false, offX: 0, offY: 0 };
          return;
        }
        if (card?.dataset.elementId) {
          elementDragRef.current = { id: card.dataset.elementId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          return;
        }
        const island = target?.closest('.se-category__legend')?.closest<HTMLElement>('[data-se-category]');
        const islandId = island?.dataset.seCategory;
        if (islandId && bookElementCategories.some((category) => category.id === islandId)) {
          islandDragRef.current = { id: islandId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          return;
        }
      }
      if (e.pointerType === 'touch') {
        const points = touchPointsRef.current;
        points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (points.size === 2) {
          const [a, b] = [...points.values()];
          if (!a || !b) return;
          const rect = e.currentTarget.getBoundingClientRect();
          pinchRef.current = beginSuperViewPinch({
            points: [a, b],
            viewportOrigin: { x: rect.left, y: rect.top },
            pan: panRef.current,
            zoom: zoomRef.current,
          });
          isPanningRef.current = false;
          panStartRef.current = null;
          for (const pointerId of points.keys()) {
            try {
              e.currentTarget.setPointerCapture(pointerId);
            } catch {
              // WebKit can already have released a synthetic or interrupted
              // pointer; the tracked midpoint still owns the gesture.
            }
          }
          setPanningVisual(true);
          return;
        }
      }
      // Middle-click → always pan.
      // Left-click → pan UNLESS the target is an explicitly interactive
      // descendant (element card, edge hit-target, header button, modal,
      // …). Band node pills, category box backgrounds, group dividers,
      // and bare viewport area all count as "pannable" — that's how the
      // user gets to drag-pan from the band or empty category space.
      if (e.button !== 0 && e.button !== 1) return;
      if (e.button === 0) {
        const target = e.target as Element | null;
        if (
          target?.closest(
            // Match interactive things — these own their click/drag.
            '[data-super-card]',
          ) ||
          target?.closest('[data-super-edge]') ||
          target?.closest('[data-relation-edge-popover]') ||
          target?.closest('[data-super-modal]') ||
          target?.closest('[data-super-view-legend]') ||
          target?.closest('button') ||
          target?.closest('a') ||
          target?.closest('input') ||
          target?.closest('textarea')
        ) {
          return;
        }
      }
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanningVisual(true);
    },
    [setPanningVisual, mobileShell, linkSource, bookElementCategories, stopCamera, relateShown, relateLeaving],
  );
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const held = relateDragRef.current;
      if (held && held.pointerId === e.pointerId) {
        const rect = e.currentTarget.getBoundingClientRect();
        const world = {
          x: (e.clientX - rect.left - panRef.current.x) / zoomRef.current,
          y: (e.clientY - rect.top - panRef.current.y) / zoomRef.current,
        };
        if (!held.moved) {
          if (Math.abs(e.clientX - held.x) + Math.abs(e.clientY - held.y) < 5) return;
          held.moved = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* the pointer may already be gone */
          }
          hoverDismiss();
          const at = relateLive.current.get(held.id) ?? world;
          held.offX = at.x - world.x;
          held.offY = at.y - world.y;
          beginRelateDrag(held.id);
          setRelateDragging(held.id);
        }
        dragRelateTo(held.id, { x: world.x + held.offX, y: world.y + held.offY });
        return;
      }
      const carry = elementDragRef.current ?? islandDragRef.current;
      if (carry && carry.pointerId === e.pointerId) {
        const rect = e.currentTarget.getBoundingClientRect();
        if (!carry.moved) {
          if (Math.abs(e.clientX - carry.x) + Math.abs(e.clientY - carry.y) < 5) return;
          carry.moved = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* the pointer may already be gone */
          }
          hoverDismiss();
          if (carry === elementDragRef.current) {
            const element = findById(bookElements, carry.id);
            const category = element?.categoryId ? findById(bookElementCategories, element.categoryId) : undefined;
            setCarried({ id: carry.id, name: element?.name ?? '', color: category?.color, x: e.clientX - rect.left, y: e.clientY - rect.top });
          }
        }
        if (carry === elementDragRef.current) {
          if (ghostRef.current) {
            ghostRef.current.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px)`;
          }
          const zoomNow = zoomRef.current;
          const at = categoryAtWorld(
            (e.clientX - rect.left - panRef.current.x) / zoomNow,
            (e.clientY - rect.top - panRef.current.y) / zoomNow,
          );
          const current = findById(bookElements, carry.id)?.categoryId ?? null;
          const next = at && at !== current ? at : null;
          if (next !== dropCategoryRef.current) {
            dropCategoryRef.current = next;
            setDropCategoryId(next);
          }
        } else {
          const box = worldRef.current?.querySelector<HTMLElement>(`[data-se-category="${CSS.escape(carry.id)}"]`);
          if (box) {
            const zoomNow = zoomRef.current;
            box.classList.add('is-carried');
            box.style.transform = `translate(${(e.clientX - carry.x) / zoomNow}px, ${(e.clientY - carry.y) / zoomNow}px)`;
          }
        }
        return;
      }
      if (e.pointerType === 'touch' && touchPointsRef.current.has(e.pointerId)) {
        touchPointsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pinch = pinchRef.current;
        if (pinch && touchPointsRef.current.size >= 2) {
          const [a, b] = [...touchPointsRef.current.values()];
          if (!a || !b) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const next = updateSuperViewPinch({
            origin: pinch,
            points: [a, b],
            viewportOrigin: { x: rect.left, y: rect.top },
            minZoom: ZOOM_MIN,
            maxZoom: ZOOM_MAX,
          });
          let nextZoom = next.zoom;
          nextZoom = clampZoomForSticky(nextZoom);
          panRef.current = {
            x: clampPanXForSticky(
              next.pan.x + pinch.world.x * (next.zoom - nextZoom),
              nextZoom,
            ),
            y: clampPanYForSticky(
              next.pan.y + pinch.world.y * (next.zoom - nextZoom),
              nextZoom,
            ),
          };
          zoomRef.current = nextZoom;
          applyTransform();
          e.preventDefault();
          return;
        }
      }
      if (!isPanningRef.current || !panStartRef.current) return;
      const start = panStartRef.current;
      const rawX = start.panX + (e.clientX - start.x);
      const rawY = start.panY + (e.clientY - start.y);
      panRef.current = {
        x: clampPanXForSticky(rawX, zoomRef.current),
        y: clampPanYForSticky(rawY, zoomRef.current),
      };
      // Direct DOM write — bypasses React reconciliation entirely. The
      // committed pan state catches up at pointerUp.
      applyTransform();
    },
    [applyTransform, clampPanXForSticky, clampPanYForSticky, clampZoomForSticky, hoverDismiss, bookElements,
      bookElementCategories, categoryAtWorld, relateLive, beginRelateDrag, dragRelateTo],
  );
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const held = relateDragRef.current;
      if (held && held.pointerId === e.pointerId) {
        relateDragRef.current = null;
        if (!held.moved) return;
        dragEndedAtRef.current = performance.now();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be gone */
        }
        endRelateDrag(held.id);
        setRelateDragging(null);
        return;
      }
      const carry = elementDragRef.current ?? islandDragRef.current;
      if (carry && carry.pointerId === e.pointerId) {
        const isElement = carry === elementDragRef.current;
        elementDragRef.current = null;
        islandDragRef.current = null;
        if (!carry.moved) return;
        dragEndedAtRef.current = performance.now();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be gone */
        }
        if (isElement) {
          const target = dropCategoryRef.current;
          dropCategoryRef.current = null;
          setDropCategoryId(null);
          setCarried(null);
          if (target) {
            updateElement(carry.id, { categoryId: target }).catch(() => {
              /* the store keeps the old category; nothing to undo here */
            });
          }
          return;
        }
        const box = worldRef.current?.querySelector<HTMLElement>(`[data-se-category="${CSS.escape(carry.id)}"]`);
        if (box) {
          box.classList.remove('is-carried');
          box.style.transform = '';
        }
        const placement = placementById.get(carry.id);
        const zoomNow = zoomRef.current;
        const dx = Math.round((e.clientX - carry.x) / zoomNow / CELL_W);
        const dy = Math.round((e.clientY - carry.y) / zoomNow / CELL_H);
        if (placement && (dx !== 0 || dy !== 0)) {
          updateCategory(carry.id, { layoutMode: 'pinned', gridX: placement.gridX + dx, gridY: placement.gridY + dy }).catch(() => {
            /* the store keeps the island where it was */
          });
        }
        return;
      }
      if (e.pointerType === 'touch') {
        const points = touchPointsRef.current;
        points.delete(e.pointerId);
        if (pinchRef.current) {
          pinchRef.current = null;
          setPan(panRef.current);
          setZoom(zoomRef.current);
          setPanningVisual(false);
          window.dispatchEvent(new Event('super-element:pan-end'));
          const remaining = [...points.values()][0];
          if (remaining) {
            isPanningRef.current = true;
            panStartRef.current = {
              x: remaining.x,
              y: remaining.y,
              panX: panRef.current.x,
              panY: panRef.current.y,
            };
            setPanningVisual(true);
          } else {
            isPanningRef.current = false;
            panStartRef.current = null;
          }
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* pointer capture may already be gone */
          }
          return;
        }
      }
      if (!isPanningRef.current) return;
      isPanningRef.current = false;
      panStartRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* element may have lost capture mid-drag — ignore */
      }
      // Commit the latest pan to React state. Persistence + drift-edge
      // recompute fire here, exactly once per gesture.
      setPan(panRef.current);
      setPanningVisual(false);
      window.dispatchEvent(new Event('super-element:pan-end'));
    },
    [setPanningVisual, updateElement, updateCategory, placementById, endRelateDrag],
  );

  // Reset view on demand — centers the band and resets zoom.
  const resetView = useCallback(() => {
    const initial = (relateShown ? fitRelate(relateLive.current) : null) ?? initialCenter();
    setPan(initial.pan);
    setZoom(initial.zoom);
  }, [initialCenter, relateShown, fitRelate, relateLive]);

  // ---- Entity click router ----
  // All shift-click pairing + popover-opening flows through here so element
  // and node cards share the same state machine.
  const handleEntityClick = useCallback(
    (kind: 'element' | 'node', id: string, rect: DOMRect, opts: { shiftKey: boolean }) => {
      hoverDismiss();
      if (opts.shiftKey) {
        setLinkSource((prev) => {
          if (prev && prev.kind === kind && prev.id === id) return null; // toggle off
          return { kind, id };
        });
        return;
      }
      if (mobileLinkMode) {
        if (!linkSource || (linkSource.kind === kind && linkSource.id === id)) {
          setLinkSource((prev) =>
            prev && prev.kind === kind && prev.id === id ? null : { kind, id },
          );
        } else {
          setPendingLink({
            source: linkSource,
            target: { kind, id },
          });
          setPendingLinkTypeId(null);
          setPendingLinkReversed(false);
          setPendingLinkCreatingType(false);
          setLinkSource(null);
          setMobileLinkMode(false);
        }
        return;
      }
      if (linkSource && !(linkSource.kind === kind && linkSource.id === id)) {
        setPendingLink({
          source: linkSource,
          target: { kind, id },
        });
        setPendingLinkTypeId(null);
        setPendingLinkReversed(false);
        setPendingLinkCreatingType(false);
        setLinkSource(null);
        return;
      }
      // Plain click → open the appropriate popover.
      //   • element       → ElementCardPopover (two-tier name/summary/editor)
      //   • drift node    → NodeCardPopover (same two-tier UX, for nodes)
      //   • chapter pill  → no-op (band is read-only per design)
      if (kind === 'element' && !mobileShell) {
        // The sheet stays open and turns to the clicked element; the card
        // toggles.
        setIsleFocus((current) => (current === id && islandMode === 'peek' ? null : id));
        setIsleCategory(null);
        setIsolated(false);
      } else if (kind === 'element') {
        setActivePopover({
          elementId: id,
          anchor: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
        });
      } else if (kind === 'node' && driftIds.has(id)) {
        setActiveDriftPopover({
          nodeId: id,
          anchor: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
        });
      }
    },
    [driftIds, linkSource, mobileLinkMode, hoverDismiss, mobileShell, islandMode],
  );

  const handleNodeClick = useCallback<ChapterBandProps['onNodeClick']>((node, rect, opts) => {
    handleEntityClick('node', node.id, rect, opts);
  }, [handleEntityClick]);
  const handleElementClick = useCallback<CategoryBoxProps['onElementClick']>((element, rect, opts) => {
    if (dragEndedAtRef.current > performance.now() - 250) return;
    handleEntityClick('element', element.id, rect, opts);
  }, [handleEntityClick]);
  const handleCategoryClick = useCallback<CategoryBoxProps['onCategoryClick']>(id => {
    if (dragEndedAtRef.current > performance.now() - 250) return;
    if (!mobileShell) {
      setIsleCategory((current) => (current === id && islandMode === 'peek' ? null : id));
      setIsleFocus(null);
      setIsolated(false);
      return;
    }
    openEntity({ entityType: 'category', id });
    close();
  }, [openEntity, close, mobileShell, islandMode]);
  const handleStorylineClick = useCallback<NonNullable<ChapterBandProps['onStorylineClick']>>(id => {
    hoverDismiss();
    openEntity({ entityType: 'storyline', id });
    close();
  }, [openEntity, close, hoverDismiss]);
  const handleElementPreviewEnter = useCallback<NonNullable<CategoryBoxProps['onElementPreviewEnter']>>((element, anchor) => {
    if (isPanningRef.current || pinchRef.current) return;
    hoverEnter({ kind: 'element', id: element.id }, anchor);
  }, [hoverEnter]);
  const handleCategoryPreviewEnter = useCallback<NonNullable<CategoryBoxProps['onCategoryPreviewEnter']>>((categoryId, anchor) => {
    if (isPanningRef.current || pinchRef.current) return;
    hoverEnter({ kind: 'category', id: categoryId }, anchor);
  }, [hoverEnter]);

  const handleDriftClick = useCallback<SuperElementDriftCardsProps['onClick']>((e, node) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    handleEntityClick('node', node.id, rect, { shiftKey: e.shiftKey });
  }, [handleEntityClick]);
  const handleDriftPreviewEnter = useCallback<SuperElementDriftCardsProps['onPreviewEnter']>((event, node) => {
    hoverEnter({ kind: 'node', id: node.id }, event.currentTarget);
  }, [hoverEnter]);

  const hoverActionsFor = (target: EntityHoverTarget) => {
    if (target.kind === 'element') {
      const groups = entityHoverActions({
        editorType: 'element',
        extraGroups: [[{ action: 'startEdgeFrom', label: t('superElement.startEdgeFromElement') }]],
        onAction: (action) => {
          if (action === 'startEdgeFrom') {
            setLinkSource({ kind: 'element', id: target.id });
            return;
          }
          void dispatchEntityAction({ entityType: 'element', id: target.id, action });
        },
        t,
      });
      if (mobileShell) return groups;
      const element = findById(bookElements, target.id);
      // 改类目 moves it to another island right here; 改分组 chooses among the
      // island's named groups (a new name is typed in the editor's picker).
      const withCategories = withElementCategoryChoices(groups, {
        categoryId: element?.categoryId ?? null,
        categories: bookElementCategories,
        onMove: (categoryId) => {
          updateElement(target.id, { categoryId }).catch(() => {
            /* the store keeps the old category */
          });
        },
      });
      if (!element) return withCategories;
      const groupNames = [...new Set(bookElements
        .filter((candidate) => (candidate.categoryId ?? null) === (element.categoryId ?? null))
        .map((candidate) => candidate.groupName?.trim())
        .filter((name): name is string => Boolean(name)))];
      return withElementGroupChoices(withCategories, {
        groupName: element.groupName,
        groupNames,
        onMove: (groupName) => {
          updateElement(target.id, { groupName }).catch(() => {
            /* the store keeps the old group */
          });
        },
        onNewGroup: () => void dispatchEntityAction({ entityType: 'element', id: target.id, action: 'groupPicker' }),
        t,
      });
    }
    if (target.kind === 'category') {
      const category = findById(bookElementCategories, target.id);
      const pinned = category?.layoutMode === 'pinned';
      return entityHoverActions({
        editorType: 'category',
        extraGroups: mobileShell
          ? undefined
          : [[
            { action: 'newElement', label: t('superElement.isles.newElement') },
            ...(pinned ? [{ action: 'unpin', label: t('superElement.isles.unpin') }] : []),
          ]],
        onAction: (action) => {
          if (action === 'newElement') {
            createElement({ categoryId: target.id })
              .then((created) => {
                setIsleFocus(created.id);
                setIsolated(false);
              })
              .catch(() => {
                /* nothing was created */
              });
            return;
          }
          if (action === 'unpin') {
            updateCategory(target.id, { layoutMode: 'auto', gridX: null, gridY: null }).catch(() => {
              /* the island stays pinned */
            });
            return;
          }
          void dispatchEntityAction({ entityType: 'category', id: target.id, action });
        },
        t,
      });
    }
    const node = target.kind === 'node' ? findById(bookNodes, target.id) : undefined;
    if (!node) return undefined;
    return withDriftGroupChoices(
      entityHoverActions({
        editorType: 'node',
        nodeStatusKind: 'drift',
        nodeWritingStatus: node.writingStatus,
        extraGroups: [[{ action: 'startEdgeFrom', label: t('superElement.startEdgeFromDrift') }]],
        onAction: (action) => {
          if (action === 'startEdgeFrom') {
            setLinkSource({ kind: 'node', id: node.id });
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
          moveDriftToGroup(node.id, groupId).catch(() => {
            /* the store keeps the old group; nothing to undo here */
          });
        },
        t,
      },
    );
  };

  // Commit a typed entity relation for the pending pair. The modal either
  // selects an existing compatible definition or creates one in place; every
  // shift-click relation remains a manual-origin write.
  const confirmPendingLink = useCallback(async () => {
    if (!pendingLink || !pendingLinkTypeId) return;
    const source = pendingLinkReversed ? pendingLink.target : pendingLink.source;
    const target = pendingLinkReversed ? pendingLink.source : pendingLink.target;
    try {
      await addRelation(source.kind, source.id, target.kind, target.id, {
        relationTypeId: pendingLinkTypeId,
      });
    } catch {
      /* surfaced through optimistic-update rollback — UI is already reverted */
    } finally {
      closePendingLink();
    }
  }, [pendingLink, pendingLinkReversed, pendingLinkTypeId, addRelation, closePendingLink]);

  const deleteSelectedEdge = useCallback(async () => {
    if (!selectedEdgeId) return;
    const id = selectedEdgeId;
    clearSelectedEdge();
    try {
      await removeRelation(id);
    } catch {
      /* rollback handles UI; nothing to undo here */
    }
  }, [clearSelectedEdge, selectedEdgeId, removeRelation]);

  // ---- Drift edges (viewport-space) ----
  // Drift node cards live in the bottom panel (position: fixed, NOT in the
  // world transform), so the SVG that connects drift cards to their linked
  // elements has to be in viewport coordinates. We measure both endpoints
  // in a dedicated layer, which owns bounded animation measurement and state.
  const driftCardRefs = useRef(new Map<string, HTMLDivElement>());
  const elementCardRefs = useRef(new Map<string, HTMLDivElement>());
  const driftEdgeLayerRef = useRef<SVGSVGElement | null>(null);
  const edgePanningRef = useRef(false);
  const driftEdges = useMemo(() => projectSuperElementDriftEdges({ entityRelations,
    hiddenRelationTypeIds, driftIds, relationTypeById, resolveRelationTypeColor }),
  [entityRelations, hiddenRelationTypeIds, driftIds, relationTypeById, resolveRelationTypeColor]);
  const driftLayoutRevision = useMemo(
    () => ({ elementCenters: relateShown ? relateRest : elementCenters, driftNodes }),
    [relateShown, relateRest, elementCenters, driftNodes],
  );

  const viewportEdgeLayerRef = useRef<SVGSVGElement | null>(null);
  const viewportConfig = useMemo(() => ({ bandSticky, edgesViewportOnly, bandHeightCells, bandTopWorldY,
    cellWidth: CELL_W, cellHeight: CELL_H }), [bandSticky, edgesViewportOnly, bandHeightCells, bandTopWorldY]);
  const viewportRevision = useMemo(() => ({ pan, zoom }), [pan, zoom]);
  const edgeWidths = SUPER_ELEMENT_EDGE_WIDTHS.desktop;

  // Desktop names an entity by its sand mark + name (the link-mode hint, the
  // new-relation dialog, the relation popover): an element's square in its
  // category's colour, a chapter's seal in its storyline's, a drift's eddy.
  const storylineColorOfNode = useCallback(
    (id: string) => {
      const storylineId = primaryStorylineByNode[id];
      return (storylineId ? findById(storylines, storylineId)?.color : undefined) || undefined;
    },
    [primaryStorylineByNode, storylines],
  );
  const entityMark = useCallback(
    (kind: string, id: string): React.ReactNode => {
      if (kind === 'element') {
        const categoryId = findById(bookElements, id)?.categoryId;
        const color = categoryId ? findById(bookElementCategories, categoryId)?.color : undefined;
        return <KindMark kind="element" color={color} />;
      }
      if (kind !== 'node') return undefined;
      if (driftIds.has(id)) return <KindMark kind="drift" />;
      return <KindMark kind="chapter" seed={id} color={storylineColorOfNode(id)} />;
    },
    [bookElements, bookElementCategories, driftIds, storylineColorOfNode],
  );

  // ---- Distance, travel and the focused element (desktop) ----
  const lod: IslesLod = islesLod(zoom);
  const flyToElement = useCallback((id: string) => {
    const viewport = viewportRef.current;
    const center = relateShown ? (relateLive.current.get(id) ?? elementCenters.get(id)) : elementCenters.get(id);
    if (!viewport || !center) return;
    const target = Math.max(zoomRef.current, ISLES_LOD_ZOOM.mid);
    setPan({ x: viewport.clientWidth / 2 - center.x * target, y: viewport.clientHeight / 2 - center.y * target });
    setZoom(target);
    setIsleFocus(id);
    setIsleCategory(null);
    setIsolated(false);
  }, [elementCenters, relateShown, relateLive]);
  // The island's subject stays in the canvas left of the island: when it
  // sits under the sheet (or the card) or off screen, the canvas slides it
  // into the middle of what is left. `sheetRatio` is null for the card.
  const revealBesideIsland = useCallback((subject: { kind: 'element' | 'category'; id: string }, sheetRatio: number | null) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let x: number;
    let y: number;
    if (subject.kind === 'element') {
      const center = relateShown ? (relateLive.current.get(subject.id) ?? elementCenters.get(subject.id)) : elementCenters.get(subject.id);
      if (!center) return;
      x = center.x * zoomRef.current + panRef.current.x;
      y = center.y * zoomRef.current + panRef.current.y;
    } else {
      const box = worldRef.current
        ?.querySelector(`[data-se-category="${CSS.escape(subject.id)}"]`)
        ?.getBoundingClientRect();
      if (!box) return;
      const area = viewport.getBoundingClientRect();
      x = box.left + box.width / 2 - area.left;
      y = box.top - area.top + Math.min(box.height, viewport.clientHeight) / 2;
    }
    const free = sheetRatio === null
      ? viewport.clientWidth - 332
      : viewport.clientWidth * (1 - sheetRatio) - 12;
    const margin = 48;
    const insideX = x > margin && x < free - margin;
    const insideY = y > margin && y < viewport.clientHeight - margin;
    if (insideX && insideY) return;
    setPan({
      x: panRef.current.x + (insideX ? 0 : free / 2 - x),
      y: panRef.current.y + (insideY ? 0 : viewport.clientHeight / 2 - y),
    });
  }, [elementCenters, relateShown, relateLive]);
  const focusIsleElement = useCallback((id: string) => {
    setIsleFocus(id);
    setIsleCategory(null);
    revealBesideIsland({ kind: 'element', id }, islandMode === 'sheet' ? islandWidth : null);
  }, [revealBesideIsland, islandMode, islandWidth]);
  // Where an island shows an element's mark and name at a distance: a 关系
  // cell starts from there and goes back there, so a change of layout
  // never jumps.
  const isleStartsAt = useCallback((at: IslesLod) => {
    const out = new Map<string, RelatePoint>();
    if (mobileShell) return out;
    const widthOf = new Map(categoryModels.map((model) => [model.categoryId, model.widthCells]));
    for (const el of bookElements) {
      const center = elementCenters.get(el.id);
      if (!center) continue;
      if (at === 'far') {
        out.set(el.id, { x: center.x, y: center.y });
        continue;
      }
      // The island cell sits 3px into its column with 7px of padding; a 关系
      // cell has 8px. Close up the island cell's title rides at its top.
      const colStep = cardColStep(widthOf.get(center.categoryId) ?? 1);
      out.set(el.id, {
        x: center.x - colStep / 2 + 3 + 7 - 8 + relateCellHalf(el.name).hw,
        y: at === 'near' ? center.y - CELL_H / 2 + 3 + 5 + 7 : center.y,
      });
    }
    return out;
  }, [mobileShell, categoryModels, bookElements, elementCenters]);
  const isleStarts = useMemo(() => isleStartsAt(lod), [isleStartsAt, lod]);
  const [islesPhase, setIslesPhase] = useState<'leaving' | 'arriving' | null>(null);
  const islesPhaseTimer = useRef(0);
  const fadeIsles = useCallback((phase: 'leaving' | 'arriving') => {
    window.clearTimeout(islesPhaseTimer.current);
    if (prefersReducedMotion()) {
      setIslesPhase(null);
      return;
    }
    setIslesPhase(phase);
    islesPhaseTimer.current = window.setTimeout(() => setIslesPhase(null), 340);
  }, []);
  useEffect(() => () => window.clearTimeout(islesPhaseTimer.current), []);
  const chooseLayout = useCallback((next: ElementLayoutMode) => {
    if (mobileShell || next === layoutMode) return;
    hoverDismiss();
    clearSelectedEdge();
    if (next === 'relate') {
      setRelateMode('relate');
      setRelateLeaving(false);
      // From the islands the cells start where the islands show them; caught
      // on their way back, they turn round where they are.
      if (!relateShown) {
        fadeIsles('leaving');
        placeRelate(isleStarts);
      }
      if (relateRest) {
        // The layout this book was last left in, newcomers on their islands.
        const target = new Map(relateRest);
        for (const [id, point] of isleStarts) if (!target.has(id)) target.set(id, point);
        moveRelateTo(target);
        moveCamera(fitRelate(target));
      } else {
        moveCamera(fitRelate(settleRelateLayout(isleStarts, 1)), 900);
      }
      return;
    }
    setRelateMode('isles');
    setRelateLeaving(true);
    const camera = initialCenter();
    moveRelateTo(isleStartsAt(islesLod(camera.zoom)), () => {
      setRelateLeaving(false);
      fadeIsles('arriving');
    });
    moveCamera(camera);
  }, [mobileShell, layoutMode, relateShown, hoverDismiss, clearSelectedEdge, setRelateMode, fadeIsles, placeRelate, isleStarts,
    relateRest, moveRelateTo, moveCamera, fitRelate, settleRelateLayout, initialCenter, isleStartsAt]);
  // Opened in 关系 with no layout yet, or what pulls on it changed (a new
  // relation, a filter, the threshold): settle again from where the
  // elements are, newcomers starting from their islands. The prose has to
  // be read first, or its lines would arrive as a second change.
  const mentionsRead = mentionGraph !== null;
  useEffect(() => {
    if (!relateShown || relateLeaving || relateMoving || relateDragging || relateCurrent || !mentionsRead) return;
    const first = relateLive.current.size === 0;
    const start = new Map(relateLive.current);
    for (const [id, point] of isleStarts) if (!start.has(id)) start.set(id, point);
    const end = settleRelateLayout(start, first ? 1 : 0.4);
    if (first) moveCamera(fitRelate(end), 900);
  }, [relateShown, relateLeaving, relateMoving, relateDragging, relateCurrent, mentionsRead, relateLive, isleStarts,
    settleRelateLayout, moveCamera, fitRelate]);
  const rearrangeRelate = useCallback(() => {
    hoverDismiss();
    moveCamera(fitRelate(relayoutRelate()), 900);
  }, [hoverDismiss, moveCamera, fitRelate, relayoutRelate]);

  const hoveredElementId = hoverPreview?.data.kind === 'element' ? hoverPreview.data.id : null;
  const activeIsleElement = mobileShell ? null : (carried?.id ?? hoveredElementId ?? isleFocus);
  const relateEdges = useMemo<RelateEdgeView[]>(() => {
    if (mobileShell) return [];
    const elementEdges = worldEdges.filter((edge) => edge.fromKind === 'element' && edge.toKind === 'element');
    const pairs = new Map<string, string[]>();
    const pairOf = (edge: (typeof elementEdges)[number]) => (edge.fromId < edge.toId ? `${edge.fromId}|${edge.toId}` : `${edge.toId}|${edge.fromId}`);
    for (const edge of elementEdges) {
      const key = pairOf(edge);
      const group = pairs.get(key);
      if (group) group.push(edge.id); else pairs.set(key, [edge.id]);
    }
    return elementEdges.map((edge) => {
      const group = pairs.get(pairOf(edge)) ?? [edge.id];
      return {
        id: edge.id,
        fromId: edge.fromId,
        toId: edge.toId,
        color: edge.color,
        roles: relateRoles(edge.relationTypeId),
        bend: relateBend(group.indexOf(edge.id), group.length),
        title: `${edge.fromName} → ${edge.toName}  ·  ${resolveRelationTypeLabel(edge.relationTypeId)}`,
      };
    });
  }, [mobileShell, worldEdges, relateRoles, resolveRelationTypeLabel]);
  // Role names on every line while the window holds few; in a crowded one,
  // and from far away, only on the lines of the element under the pointer
  // or in focus. The window is the whole Super View, so its size is the
  // window's.
  const relateCrowded = useMemo(() => {
    if (!relateShown || !relateRest || typeof window === 'undefined') return false;
    const inView = (point: RelatePoint) => {
      const x = point.x * zoom + pan.x;
      const y = point.y * zoom + pan.y;
      return x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight;
    };
    let count = 0;
    for (const edge of relateEdges) {
      const a = relateRest.get(edge.fromId);
      const b = relateRest.get(edge.toId);
      if (a && b && inView(a) && inView(b)) count += 1;
    }
    return count > RELATE_LABEL_BUDGET;
  }, [relateShown, relateRest, relateEdges, pan, zoom]);
  const categoryColorById = useMemo(
    () => new Map(bookElementCategories.map((category) => [category.id, category.color])),
    [bookElementCategories],
  );
  const relateColorOf = useCallback(
    (element: BookElement) => (element.categoryId ? categoryColorById.get(element.categoryId) : undefined) ?? undefined,
    [categoryColorById],
  );
  // From far away the 关系 layout keeps a dozen names, the most mentioned.
  const relateMajorIds = useMemo(() => {
    if (!relateShown || !mentionGraph) return new Set<string>();
    return new Set([...mentionGraph.elements]
      .filter(([id, entry]) => entry.mentions > 0 && presentElementIds.has(id))
      .sort((a, b) => b[1].mentions - a[1].mentions)
      .slice(0, 12)
      .map(([id]) => id));
  }, [relateShown, mentionGraph, presentElementIds]);
  // Names and role names read from far away at the size they have up close.
  const relateFarScale = lod === 'far' ? Math.min(2.4, ISLES_LOD_ZOOM.mid / zoom) : 1;
  const relateSelectedEdges = useMemo(() => {
    const ids = new Set(focusConnected?.edgeIds ?? []);
    if (selectedEdgeId) ids.add(selectedEdgeId);
    return ids;
  }, [focusConnected, selectedEdgeId]);

  const isleChapters = useMemo(
    () => sortedPlacedNodesAll.map((node) => ({ id: node.id, title: node.title, color: storylineColorOfNode(node.id) ?? null })),
    [sortedPlacedNodesAll, storylineColorOfNode],
  );
  const isleDetail = (() => {
    if (mobileShell || !isleFocus) return null;
    const element = findById(bookElements, isleFocus);
    if (!element) return null;
    const category = element.categoryId ? findById(bookElementCategories, element.categoryId) : undefined;
    const entry = mentionGraph?.elements.get(element.id);
    const companions = mentionGraph
      ? isleCompanions(element.id, mentionGraph.pairs, 5).flatMap(({ id, count }) => {
        const other = findById(bookElements, id);
        if (!other) return [];
        const otherCategory = other.categoryId ? findById(bookElementCategories, other.categoryId) : undefined;
        return [{ id, name: other.name, color: otherCategory?.color, count }];
      })
      : [];
    const relations = entityRelations
      .filter((r) => (r.fromKind === 'element' && r.fromId === element.id) || (r.toKind === 'element' && r.toId === element.id))
      .map((r) => {
        const incoming = !(r.fromKind === 'element' && r.fromId === element.id);
        const otherKind = incoming ? r.fromKind : r.toKind;
        const otherId = incoming ? r.fromId : r.toId;
        return {
          id: r.id,
          typeName: resolveRelationTypeLabel(r.relationTypeId),
          color: resolveRelationTypeColor(r.relationTypeId),
          incoming,
          otherName: relationEndpointLabel(otherKind, otherId),
          otherMark: entityMark(otherKind, otherId),
          onSelect: otherKind === 'element' ? () => focusIsleElement(otherId) : undefined,
        };
      });
    return {
      element,
      categoryName: category?.name ?? t('superElement.uncategorized'),
      color: category?.color,
      mentions: entry?.mentions ?? 0,
      ticks: isleTicks(isleChapters, entry?.byChapter),
      companions,
      relations,
    };
  })();
  const isleCategoryDetail = (() => {
    if (mobileShell || isleFocus || !isleCategory) return null;
    const category = findById(bookElementCategories, isleCategory);
    if (!category) return null;
    const members = bookElements
      .filter((element) => element.categoryId === category.id)
      .map((element) => ({ id: element.id, name: element.name, mentions: mentionGraph?.elements.get(element.id)?.mentions ?? 0 }))
      .sort((a, b) => b.mentions - a.mentions);
    return { category, members };
  })();
  const islandSubject = isleDetail
    ? { kind: 'element' as const, id: isleDetail.element.id }
    : isleCategoryDetail
      ? { kind: 'category' as const, id: isleCategoryDetail.category.id }
      : null;
  const growIsland = () => {
    if (!islandSubject) return;
    setIslandMode('sheet');
    revealBesideIsland(islandSubject, islandWidth);
  };
  const openIslandInTab = () => {
    if (!islandSubject) return;
    openEntity({ entityType: islandSubject.kind, id: islandSubject.id });
    close();
  };

  return (
    <SuperViewShell className="super-element-overlay">
      {/* Header — back + Super tabs + stats + filter controls. */}
      <DesktopSuperViewHeader
        // 群岛 / 关系 sit in the header, before the counts.
        metaLead={!mobileShell && <SuperElementLayoutSwitch layout={layoutMode} onLayout={chooseLayout} />}
        meta={t('superElement.meta', {
          categories: bookElementCategories.length,
          elements: bookElements.length,
        })}
        onBack={close}
        // The relation types stay with the lines they name: the legend in
        // the canvas's corner (SuperElementCanvasTools).
        relationControl={false}
        rightSlot={
          <>
            {/* A touch screen has no Shift + click: the mobile shell links
                two things through an explicit relation mode. */}
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
            {/* Linking hint — surfaces when a link is mid-flight, so users
                know they need to click a second target: one unframed
                sentence; the source is its sand mark and name. */}
            {linkSource && (
              <span className="super-view-head__hint" role="status">
                <span>{t('superElement.linkHintFrom')}</span>
                <span className="super-view-head__hint-source">
                  {entityMark(linkSource.kind, linkSource.id)}
                  <span>{relationEndpointLabel(linkSource.kind, linkSource.id)}</span>
                </span>
                <span>{t('superElement.linkHintTo')}</span>
              </span>
            )}

            {/* The band's 聚焦 / 粘带 belong to the mobile shell's band layout;
                the desktop islands search and thin their prose lines. */}
            {mobileShell ? (
              <>
                <button
                  className={`super-element-toggle${edgesViewportOnly ? ' is-on' : ''}`}
                  onClick={() => setEdgesViewportOnly((v) => !v)}
                  title={
                    edgesViewportOnly ? t('superElement.focusOffTitle') : t('superElement.focusOnTitle')
                  }
                  aria-pressed={edgesViewportOnly}
                >
                  {t('superElement.focusToggle', {
                    state: edgesViewportOnly ? t('superElement.stateOn') : t('superElement.stateOff'),
                  })}
                </button>
                <button
                  className={`super-element-toggle${bandSticky ? ' is-on' : ''}`}
                  onClick={() => setBandSticky((v) => !v)}
                  title={
                    bandSticky ? t('superElement.stickyOffTitle') : t('superElement.stickyOnTitle')
                  }
                  aria-pressed={bandSticky}
                >
                  {t('superElement.stickyToggle', {
                    state: bandSticky ? t('superElement.stateOn') : t('superElement.stateOff'),
                  })}
                </button>
              </>
            ) : (
              <>
                <label className="ui-field glass glass--rest glass--field se-find">
                  <BrushIcon name="search" size={13} />
                  <input
                    type="text"
                    value={findQuery}
                    placeholder={t('superElement.isles.find')}
                    aria-label={t('superElement.isles.find')}
                    onChange={(event) => setFindQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && findQuery) {
                        event.preventDefault();
                        setFindQuery('');
                      } else if (event.key === 'Enter' && findHits && findHits.size > 0) {
                        const first = bookElements.find((el) => findHits.has(el.id));
                        if (first) flyToElement(first.id);
                      }
                    }}
                  />
                </label>
                <SuperElementLineThreshold value={lineThreshold} onChange={setLineThreshold} />
                {layoutMode === 'relate' && (
                  <Button variant="ghost" size="sm" onClick={rearrangeRelate} title={t('superElement.relate.relayoutTitle')}>
                    <BrushIcon name="spread" size={13} />
                    {t('superElement.relate.relayout')}
                  </Button>
                )}
              </>
            )}
            <Button variant="ghost" size="sm" onClick={resetView} title={t('superElement.resetTitle')}>
              <BrushIcon name="rotate" size={13} />
              {t('superElement.reset')}
            </Button>
          </>
        }
      />

      {/* Canvas viewport. `.super-view-body` keeps it aligned with the shared
          flat full-screen shell. The position:absolute child (`worldRef`) is
          unaffected by the class's `display: flex` since it's out of flow. */}
      <div
        ref={viewportRef}
        className="super-view-body"
        data-se-lod={mobileShell ? undefined : lod}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          background: 'hsl(var(--paper))',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          ...(relateShown ? { '--se-far-scale': relateFarScale.toFixed(3) } : null),
        } as React.CSSProperties}
      >
        {/* World transform — pan + zoom about origin. The transform string
            is written directly via ref by pan/zoom handlers; React state
            only catches up at gesture end (see applyTransform / useLayoutEffect
            mirror above). This keeps panning at 60fps even with hundreds
            of element cards in the tree. */}
        <div
          ref={worldRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            willChange: 'transform',
            pointerEvents: 'auto',
          }}
        >
          {/* Chapter band — anchored so its horizontal midpoint sits at world
              x=0; vertically occupies [0, bandHeightCells * CELL_H). When
              the user toggles sticky on, the band is hoisted OUT of the
              world transform (rendered below as a sibling) so it can clamp
              y to the viewport edges independently. */}
          {mobileShell && !bandSticky && (
            <div
              style={{
                position: 'absolute',
                left: bandWorldLeft,
                top: bandTopWorldY,
                width: bandPxWidth,
                height: bandHeightCells * CELL_H,
              }}
            >
              <SuperElementChapterBand
                storylines={storylines}
                nodes={bookNodes}
                nodeStorylineMapping={nodeStorylineMapping}
                primaryStorylineByNode={primaryStorylineByNode}
                bandWidthCells={bandWidthCells}
                bandHeightCells={bandHeightCells}
                onNodeClick={handleNodeClick}
                linkSourceNodeId={linkSource?.kind === 'node' ? linkSource.id : null}
                onStorylineClick={handleStorylineClick}
              />
            </div>
          )}

          {/* Desktop: the lines the prose draws, in sand, under the islands' marks. */}
          {!mobileShell && (
            <SuperElementIsleLines
              pairs={isleLines}
              centers={relateShown ? (relateRest ?? elementCenters) : elementCenters}
              bounds={relateShown ? relateLineBounds : worldBounds}
              active={activeIsleElement}
              visible={isolated ? isleNeighbourhood : null}
              hidden={relateShown && (relateMoving || relateLeaving || !relateRest)}
            />
          )}

          {/* Categories above + below; their washes fade while the elements
              leave for 关系 or come back. */}
          {(!relateShown || islesPhase === 'leaving') && categoryModels.map((model) => {
            const placement = placementById.get(model.categoryId);
            if (!placement) return null;
            const leaving = relateShown;
            return (
              <SuperElementCategoryBox
                key={model.categoryId}
                model={model}
                placement={placement}
                phase={leaving ? 'leaving' : islesPhase === 'arriving' ? 'arriving' : undefined}
                linkSourceElementId={linkSource?.kind === 'element' ? linkSource.id : null}
                focusedElementId={focusedElementId}
                connectedElementIds={mobileShell ? (focusConnected?.elementIds ?? null) : isleNeighbourhood}
                dimmedElementIds={mobileShell ? null : dimmedElementIds}
                hiddenElementIds={mobileShell ? null : hiddenElementIds}
                markWeights={markWeights}
                dropTarget={dropCategoryId === model.categoryId}
                draggingElementId={carried?.id ?? null}
                pinnedLabel={model.category?.layoutMode === 'pinned' ? t('superElement.isles.pinned') : null}
                elementCardRefs={leaving ? undefined : elementCardRefs}
                onElementClick={handleElementClick}
                onCategoryClick={handleCategoryClick}
                onElementPreviewEnter={handleElementPreviewEnter}
                onCategoryPreviewEnter={handleCategoryPreviewEnter}
                onPreviewLeave={hoverLeave}
              />
            );
          })}

          {/* World-space edge layer. Lives INSIDE the world transform so
              edges scale + pan with everything else. SVG is sized to a
              dummy 1x1 with overflow visible so its children can extend
              into negative-x territory (top-strip categories) without
              being clipped.

              When bandSticky is ON, this layer renders NOTHING — the band
              moves independently of the world transform, so any edge with
              a node endpoint would visually disconnect from the (clamped)
              node. The viewport-space edge layer below takes over in that
              case, with endpoints recomputed from the sticky-clamped band
              position. Same handover happens when 聚焦 is on — that mode
              filters edges by viewport visibility, which also needs the
              committed pan/zoom for the math. */}
          {relateShown && (
            <SuperElementRelateLayer
              ref={relateLayerRef}
              elements={bookElements}
              colorOf={relateColorOf}
              live={relateLive}
              fallback={isleStarts}
              edges={relateEdges}
              roleLabels={lod === 'far' || relateCrowded ? 'active' : 'all'}
              labelScale={relateFarScale}
              activeElementId={relateDragging ?? activeIsleElement}
              selectedEdgeIds={relateSelectedEdges}
              receding={isolated && isleFocus ? 'hide' : isleFocus !== null ? 'recede' : 'none'}
              focusedElementId={focusedElementId}
              connectedElementIds={isleNeighbourhood}
              dimmedElementIds={dimmedElementIds}
              hiddenElementIds={hiddenElementIds}
              markWeights={markWeights}
              linkSourceElementId={linkSource?.kind === 'element' ? linkSource.id : null}
              draggingElementId={relateDragging}
              pinnedElementIds={relatePinnedIds}
              majorElementIds={relateMajorIds}
              elementCardRefs={elementCardRefs}
              edgeWidths={edgeWidths}
              onElementClick={handleElementClick}
              onElementPreviewEnter={handleElementPreviewEnter}
              onPreviewLeave={hoverLeave}
              selectEdge={selectEdge}
            />
          )}

          {!relateShown && !bandSticky && !edgesViewportOnly && (
            <svg
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                overflow: 'visible',
                pointerEvents: 'none',
              }}
            >
              {worldEdges.map((edge) => {
                // Click-focus: edges touching the popover's element render at
                // selected strength so the lit neighborhood includes its links.
                const selected =
                  selectedEdgeId === edge.id || !!focusConnected?.edgeIds.has(edge.id);
                // Islands: with an element in focus the other relations recede,
                // and leave altogether while only its neighbourhood is shown.
                if (!mobileShell && isolated && isleFocus && !selected) return null;
                const receded = !mobileShell && isleFocus !== null && !selected;
                // Islands draw relations without arrowheads; the direction reads on the
                // detail card. The mobile shell's band layout has no island card, so its
                // arrowheads carry the direction.
                const directed = mobileShell && edge.directed;
                const markerId = relationArrowMarkerId('super-world-arrow', edge.id);
                const d = relationEdgePath({
                  x1: edge.x1,
                  y1: edge.y1,
                  x2: edge.x2,
                  y2: edge.y2,
                  directed,
                  targetInsetX: edge.targetInsetX,
                  targetInsetY: edge.targetInsetY,
                });
                const typeLabel = resolveRelationTypeLabel(edge.relationTypeId);
                return (
                  <g key={edge.id} data-super-edge>
                    {directed && (
                      <defs>
                        <RelationArrowMarker id={markerId} color={edge.color} />
                      </defs>
                    )}
                    {/* Invisible wide stroke for hit-testing — same trick as
                      StoryGraphView. The visible path below sits on top and is
                      pointer-events:none so it doesn't intercept clicks. */}
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth={EDGE_HIT_WIDTH}
                      fill="none"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectEdge(edge.id, e.clientX, e.clientY);
                      }}
                    >
                      <title>{`${edge.fromName} → ${edge.toName}  ·  ${typeLabel}`}</title>
                    </path>
                    <path
                      d={d}
                      stroke={edge.color}
                      strokeWidth={selected ? edgeWidths.selected : edgeWidths.normal}
                      fill="none"
                      opacity={selected ? 1 : receded ? 0.14 : 0.78}
                      markerEnd={directed ? `url(#${markerId})` : undefined}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* The legend of the lines, top right; while the floating island is
            open it steps left of the island (its card is 248px at 16px from
            the edge, its sheet a share of the canvas at 12px). */}
        {/* The prose lines (and their row) come from the mention graph,
            which the mobile shell does not compute. */}
        <SuperViewRelationLegend
          canvas="element"
          style={{
            right: !islandSubject
              ? 12
              : islandMode === 'sheet'
                ? `calc(${(islandWidth * 100).toFixed(2)}% + 24px)`
                : 276,
          }}
          lead={mobileShell ? undefined : (
            <SuperElementLinesRow
              linesOn={linesOn}
              linesCount={thresholdLines.length}
              onToggleLines={() => setLinesOn((value) => !value)}
            />
          )}
        />

        {/* Viewport-space edge layer — rendered when EITHER 粘带 or 聚焦
            is on. Mirrors the world-space edge SVG above (path + hit-target
            + × delete badge) but with endpoints in viewport coords:
              · sticky on → node endpoint y uses the sticky-clamped band y
                so edges stay attached as the band sticks
              · 聚焦 on   → edges whose element endpoint isn't in viewport
                are dropped before rendering
            Layer is hidden via data-panning during the pan gesture; the
            line layer measures committed geometry before revealing itself. */}
        {(bandSticky || edgesViewportOnly) && (
          <SuperElementViewportEdges edges={worldEdges} config={viewportConfig} panRef={panRef} zoomRef={zoomRef}
            viewportRef={viewportRef} layerRef={viewportEdgeLayerRef} panningRef={edgePanningRef}
            revision={viewportRevision} selectedEdgeId={selectedEdgeId} focusedEdgeIds={focusConnected?.edgeIds}
            selectEdge={selectEdge} resolveRelationTypeLabel={resolveRelationTypeLabel}
            widths={edgeWidths} hitWidth={EDGE_HIT_WIDTH} />
        )}

        {/* Sticky chapter band — rendered as a SIBLING of the world transform
            so its y can clamp to viewport edges independently. The transform
            is written by applyTransform() (band x tracks pan.x; band y is
            clamped). Opaque background so elements panning behind it are
            hidden — that's the "elements 被 band 吞掉" behaviour. */}
        {bandSticky && (
          <div
            ref={bandRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: bandPxWidth,
              height: bandHeightCells * CELL_H,
              transformOrigin: '0 0',
              willChange: 'transform',
              background: 'hsl(var(--paper))',
              zIndex: 5,
            }}
          >
            <SuperElementChapterBand
              storylines={storylines}
              nodes={bookNodes}
              nodeStorylineMapping={nodeStorylineMapping}
              primaryStorylineByNode={primaryStorylineByNode}
              bandWidthCells={bandWidthCells}
              bandHeightCells={bandHeightCells}
              onNodeClick={handleNodeClick}
              linkSourceNodeId={linkSource?.kind === 'node' ? linkSource.id : null}
              onStorylineClick={handleStorylineClick}
            />
          </div>
        )}

        {/* The element in the hand while it is carried to another island. */}
        {carried && (
          <div
            ref={ghostRef}
            className="se-carried glass"
            aria-hidden
            style={{ transform: `translate(${carried.x}px, ${carried.y}px)` }}
          >
            <KindMark kind="element" color={carried.color} />
            <span>{carried.name}</span>
          </div>
        )}

        {islandSubject && projectId && (
          <SuperElementIsland
            mode={islandMode}
            title={isleDetail ? (
              <>
                <KindMark kind="element" color={isleDetail.color} />
                <span className="se-island__name">{isleDetail.element.name}</span>
              </>
            ) : isleCategoryDetail && (
              <>
                <KindMark kind="category" color={isleCategoryDetail.category.color} />
                <span className="se-island__name">{isleCategoryDetail.category.name}</span>
              </>
            )}
            kindLabel={isleDetail
              ? `${t('superElement.isles.island.element')} · ${isleDetail.categoryName}`
              : t('superElement.isles.island.category')}
            peek={isleDetail ? (
              <ElementIsleDetail
                name={isleDetail.element.name}
                summary={isleDetail.element.summary ?? ''}
                categoryName={isleDetail.categoryName}
                color={isleDetail.color}
                mentions={isleDetail.mentions}
                ticks={isleDetail.ticks}
                companions={isleDetail.companions}
                relations={isleDetail.relations}
                isolated={isolated}
                pinnedLabel={relateShown && relatePins.has(isleDetail.element.id) ? t('superElement.isles.pinned') : null}
                onUnpin={relateShown && relatePins.has(isleDetail.element.id) ? () => unpinRelate(isleDetail.element.id) : undefined}
                onIsolate={() => setIsolated((value) => !value)}
                onFocus={focusIsleElement}
                onEdit={growIsland}
                onOpen={openIslandInTab}
                onClose={closeIsland}
              />
            ) : isleCategoryDetail && (
              <CategoryIsleDetail
                name={isleCategoryDetail.category.name}
                color={isleCategoryDetail.category.color}
                members={isleCategoryDetail.members}
                onFocus={focusIsleElement}
                onEdit={growIsland}
                onOpen={openIslandInTab}
                onClose={closeIsland}
              />
            )}
            strip={isleDetail ? (
              <ElementIsleStrip ticks={isleDetail.ticks} companions={isleDetail.companions} onFocus={focusIsleElement} />
            ) : isleCategoryDetail && (
              <CategoryIsleStrip
                color={isleCategoryDetail.category.color}
                members={isleCategoryDetail.members}
                onFocus={focusIsleElement}
              />
            )}
            editor={islandSubject.kind === 'element'
              ? <ElementEditorView key={islandSubject.id} elementIdOverride={islandSubject.id} />
              : <CategoryEditorView key={islandSubject.id} categoryIdOverride={islandSubject.id} />}
            widthRatio={islandWidth}
            onWidthRatio={(ratio) => {
              setIslandWidth(ratio);
              revealBesideIsland(islandSubject, ratio);
            }}
            onCollapse={() => setIslandMode('peek')}
            onClose={closeIsland}
            onOpenInTab={openIslandInTab}
          />
        )}

        {/* Empty-state hint when there's literally nothing to show */}
        {categoryModels.length === 0 && (
          <div className="se-canvas-empty">
            <EmptyState mark="category" message={t('superElement.empty.noCategories')} />
          </div>
        )}
      </div>

      {/* Element popover — two-tier editor mirroring StoryGraphView's
          NodeCardPopover. Positioned fixed so pan/zoom don't drag it. */}
      {activePopover &&
        projectId &&
        (() => {
          const element = bookElements.find((el) => el.id === activePopover.elementId);
          if (!element) return null;
          const category = bookElementCategories.find((c) => c.id === element.categoryId);
          const accent = category?.color ?? 'hsl(var(--ink-4))';
          return (
            <ElementCardPopover
              element={element}
              projectId={projectId}
              userId={userId}
              accentColor={accent}
              anchorRect={activePopover.anchor}
              onClose={() => setActivePopover(null)}
              onOpenInEditor={(id) => {
                setActivePopover(null);
                openEntity({ entityType: 'element', id });
                close();
              }}
            />
          );
        })()}

      {/* Pending link modal — confirms a typed, direction-aware relation for
          a shift-click pairing. */}
      {pendingLink &&
        (() => {
          const from = pendingLinkReversed ? pendingLink.target : pendingLink.source;
          const to = pendingLinkReversed ? pendingLink.source : pendingLink.target;
          const end = (endpoint: { kind: 'element' | 'node'; id: string }) => (
            <span className="relation-pair__end">
              {entityMark(endpoint.kind, endpoint.id)}
              <span>{relationEndpointLabel(endpoint.kind, endpoint.id)}</span>
            </span>
          );
          return (
            <ModalRoot onClose={closePendingLink} ariaLabel={t('storyGraph.edge.newTitle')}>
              <ModalCard
                width={pendingLinkCreatingType ? 560 : 420}
                className="relation-type-create-modal"
              >
                <ModalHeader
                  title={t('superElement.manualRelationTitle')}
                  onClose={closePendingLink}
                  closeLabel={t('common.close')}
                />
                <ModalBody className="relation-pair-body">
                  <div className="relation-pair">
                    {end(from)}
                    <GhostIconButton
                      className="relation-pair__swap"
                      icon={<BrushIcon name="swap" size={15} />}
                      title={t('relationTypes.swap')}
                      aria-label={t('relationTypes.swap')}
                      onClick={() => {
                        setPendingLinkReversed((value) => !value);
                        setPendingLinkTypeId(null);
                        setPendingLinkCreatingType(false);
                      }}
                    />
                    {end(to)}
                  </div>
                  <div className="relation-pair__label">
                    <span>{t('storyGraph.edge.kindLabel')}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="relation-pair__create"
                      onClick={() => setPendingLinkCreatingType((value) => !value)}
                    >
                      {pendingLinkCreatingType ? (
                        t('relationTypes.chooseExisting')
                      ) : (
                        <>
                          <BrushIcon name="plus" size={11} inline /> {t('relationTypes.createInline')}
                        </>
                      )}
                    </Button>
                  </div>
                  {pendingLinkCreatingType ? (
                    <RelationTypeEditor
                      key={`${from.kind}:${to.kind}:${pendingLinkReversed ? 'reversed' : 'forward'}`}
                      initialSourceKinds={[from.kind]}
                      initialTargetKinds={[to.kind]}
                      onCancel={() => setPendingLinkCreatingType(false)}
                      onSave={async (definition) => {
                        const checked = validateRelationTypeDefinitionAgainstRelation(definition, {
                          fromKind: from.kind,
                          fromId: from.id,
                          toKind: to.kind,
                          toId: to.id,
                        });
                        if (!checked.ok) throw new Error(checked.message);
                        const created = await relationTypeUsecases.createRelationType(definition);
                        setPendingLinkTypeId(created.id);
                        setPendingLinkCreatingType(false);
                      }}
                    />
                  ) : (
                    <RelationTypeField
                      autoFocus
                      value={pendingLinkTypeId}
                      onChange={setPendingLinkTypeId}
                      options={pendingLinkTypeOptions}
                      resolveOptionColor={resolveRelationTypeColor}
                      placeholder={t('storyGraph.edge.kindPlaceholder')}
                      ariaLabel={t('storyGraph.edge.kindLabel')}
                      buttonClassName="relation-type-field__button relation-type-field__button--select ui-field glass glass--rest glass--small"
                    />
                  )}
                </ModalBody>
                {!pendingLinkCreatingType && (
                  <ModalActions>
                    <Button variant="ghost" size="sm" onClick={closePendingLink}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!pendingLinkTypeId}
                      onClick={() => {
                        void confirmPendingLink();
                      }}
                    >
                      {t('storyGraph.edge.create')}
                    </Button>
                  </ModalActions>
                )}
              </ModalCard>
            </ModalRoot>
          );
        })()}

      {/* Drift bottom-affordance — shared DriftPanel shell. Card content executes only inside
          the mounted panel; click / shift-click / popover commands stay here. */}
      {driftNodes.length > 0 && (
        <DriftPanel
          count={driftNodes.length}
          mounted={driftPanelMounted}
          open={driftPanelOpen}
          closing={driftPanelClosing}
          onOpen={openDriftPanel}
          onClose={closeDriftPanel}
        >
          <SuperElementDriftCards nodes={driftNodes} linkSourceId={linkSource?.kind === 'node' ? linkSource.id : null}
            cardRefs={driftCardRefs} onClick={handleDriftClick}
            onPreviewEnter={handleDriftPreviewEnter} onPreviewLeave={hoverLeave} />
        </DriftPanel>
      )}

      {/* Drift edges layer — viewport-space SVG that connects drift cards
          (in the fixed bottom panel) to their linked element cards (which
          live inside the pan/zoom world). Endpoints are recomputed via
          one shared read per DOM endpoint during each slide-in frame
          and on coalesced scroll/resize/pan-end thereafter. While the
          user is mid-pan, data-panning on the SVG hides it via CSS — no
          React re-render involved. Each edge has a halo + animated dash
          line, mirroring StoryGraphView's drift-edge visual language. */}
      {driftPanelOpen && (
        <SuperElementDriftEdges edges={driftEdges} driftCardRefs={driftCardRefs} elementCardRefs={elementCardRefs}
          layerRef={driftEdgeLayerRef} panningRef={edgePanningRef} viewportRef={viewportRef}
          layoutRevision={driftLayoutRevision} selectedEdgeId={selectedEdgeId}
          resolveRelationTypeLabel={resolveRelationTypeLabel} selectEdge={selectEdge} />
      )}

      {selectedEdgeAnchor && selectedEdgeRelation && selectedEdgeType && (
        <RelationEdgePopover
          anchor={selectedEdgeAnchor}
          relation={selectedEdgeRelation}
          relationType={selectedEdgeType}
          sourceLabel={relationEndpointLabel(
            selectedEdgeRelation.fromKind,
            selectedEdgeRelation.fromId,
          )}
          targetLabel={relationEndpointLabel(
            selectedEdgeRelation.toKind,
            selectedEdgeRelation.toId,
          )}
          color={resolveRelationTypeColor(selectedEdgeRelation.relationTypeId)}
          sourceMark={entityMark(selectedEdgeRelation.fromKind, selectedEdgeRelation.fromId)}
          targetMark={entityMark(selectedEdgeRelation.toKind, selectedEdgeRelation.toId)}
          onDelete={() => {
            void deleteSelectedEdge();
          }}
        />
      )}

      {/* Drift node popover — clicking a drift card opens the two-tier
          NodeCardPopover (same component StoryGraphView uses), so drift nodes
          get the same name + summary + body editor flow as chapter nodes. */}
      {activeDriftPopover &&
        projectId &&
        (() => {
          const node = bookNodes.find((n) => n.id === activeDriftPopover.nodeId);
          if (!node) return null;
          return (
            <NodeCardPopover
              node={node}
              projectId={projectId}
              userId={userId}
              markColor={storylineColorOfNode(node.id)}
              anchorRect={activeDriftPopover.anchor}
              onClose={() => setActiveDriftPopover(null)}
              onOpenInEditor={(id) => {
                setActiveDriftPopover(null);
                openEntity({ entityType: 'node', id });
                close();
              }}
            />
          );
        })()}

      {/* Elements show their card beside them, a category's above its
          legend, a drift's above the bottom drawer. */}
      {hoverPreview && (
        <EntityHoverCard
          target={hoverPreview.data}
          anchor={hoverPreview.anchor}
          placement={hoverPreview.data.kind === 'element' ? 'right-start' : 'top-center'}
          pointer={hoverCard}
          onDismiss={hoverDismiss}
          actions={hoverActionsFor(hoverPreview.data)}
        />
      )}
    </SuperViewShell>
  );
}
