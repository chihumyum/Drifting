import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronRight, Crosshair, MoreHorizontal, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnchoredPopover } from '../../../../components/ui/AnchoredPopover';
import { SegmentedControl } from '../../../../components/ui/SegmentedControl';
import { useBottomTimelineSelectors } from '../../../../components/BottomTimeline/useBottomTimelineSelectors';
import { useTimelineExpandedScale } from '../../../../components/BottomTimeline/useTimelineExpandedScale';
import type { TimelineNode } from '../../../../components/BottomTimeline/types';
import { deriveActSegments, sortActs, type BookAct } from '../../../../domain/book-act';
import {
  CHAPTER_ORDER_STRIDE,
  canonicalWordCount,
  isChapter,
  isDrift,
  type BookNode,
  type ChapterWritingStatus,
} from '../../../../domain/book-node';
import { resolvePrimaryStorylineId } from '../../../../domain/node-storyline-state';
import type { Storyline } from '../../../../domain/storyline';
import { spreadTimelineNodes } from '../../../../domain/timeline-spread';
import {
  DEFAULT_STORYLINE_LANE_ID,
  commitChapterLaneDrop,
  startChapterLanePointerDrag,
  type ChapterLanePointerDragHandle,
} from '../../../../features/graph/chapter-lane-drag';
import type { WorkspaceTarget } from '../../../../features/workspace/navigation/workspace-target';
import { useProjectNavigation } from '../../../../hooks/useProjectNavigation';
import { useTimelineMarkers } from '../../../../hooks/useTimelineMarkers';
import { events } from '../../../../lib/events';
import { useAuthStore } from '../../../../store/auth';
import { useDataStore } from '../../../../store/data-store';
import { useBookAct } from '../../../../usecase/useBookAct';
import { useBookNode } from '../../../../usecase/useBookNode';
import { useStoryline } from '../../../../usecase/useStoryline';
import type { MobileWorkspaceAction, MobileWorkspaceUiState } from '../mobile-workspace-controller';
import { useMobilePaperPresentation } from '../MobilePaperContent';
import { usePaperGlyph } from '../mobile-paper-glyph';
import {
  MobileTimelineActSheet,
  MobileTimelineChapterSheet,
  MobileTimelineCreateSheet,
  MobileTimelineMarkerSheet,
  type TimelineView,
} from './MobileTimelineSheets';
import {
  VERTICAL_TIMELINE_LEVELS,
  projectVerticalTimeline,
  verticalTimelineContentHeight,
  type VerticalTimelineEntry,
  type VerticalTimelineItem,
} from './vertical-timeline-projection';
import {
  VERTICAL_TIMELINE_DOT_HIT_PX,
  nearestVerticalDot,
  startVerticalHandleDrag,
  startVerticalLongPress,
  verticalTimelineSlots,
} from './vertical-timeline-gestures';

/**
 * The phone timeline: the desktop coordinate system turned vertical.
 *
 * Dots in the track gutter sit at exactly orderToPosition(order) and own every
 * gesture (long-press drag, tap for the menu); the entries on the right are a
 * projection of the dots (see vertical-timeline-projection.ts) and only accept
 * taps. Coordinates, writers, the pointer drag controller, the gesture intent
 * table and the pinch scale are the shared desktop modules.
 */
const TIMELINE_VIEW_STORAGE_KEY = 'timeline-view';
const VERTICAL_SCALE_STORAGE_KEY = 'timeline-vertical-scale';
const UNAFFILIATED_STORAGE_KEY = 'timeline-vertical-unaffiliated';
const GRID_UNIT = 20;
const NODE_DEFAULT_WIDTH = 4;
const RUNWAY_UNITS = 12;
const TOP_PAD = 24;
const BOTTOM_PAD = 96;
const TRACK_X0 = 16;
const TRACK_STEP = 15;
const MAX_TRACKS = 6;
const CHANNEL_OFFSET = 4;
const ENTRY_OFFSET = 12;
const OTHER_TRACK_ID = '__other__';
export const MOBILE_TIMELINE_SHEET_TRANSIENT_ID = 'tool:timeline-sheet';

type SheetState =
  | { kind: 'chapter'; id: string }
  | { kind: 'act'; id: string }
  | { kind: 'marker'; id: string }
  | { kind: 'create'; order: number | null }
  | null;

interface Track {
  id: string;
  color: string | null;
  name: string;
}

function readPersistedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readPersistedView(): TimelineView {
  try {
    return localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY) === 'narrative' ? 'narrative' : 'book';
  } catch {
    return 'book';
  }
}

export function MobileVerticalTimeline({
  projectId,
  target,
  workspaceUi,
  onWorkspaceUiAction,
  onClose,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
  workspaceUi: MobileWorkspaceUiState;
  onWorkspaceUiAction: Dispatch<MobileWorkspaceAction>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const { bookNodes, storylines, nodeStorylineMapping, primaryStorylineByNode, bookActs } =
    useDataStore();
  // Device-local like the desktop ui-store flag; the mobile shell never
  // reaches into the desktop navigation store.
  const [unaffiliatedVisible, setUnaffiliatedVisible] = useState(() =>
    readPersistedFlag(UNAFFILIATED_STORAGE_KEY),
  );
  const { openEntity } = useProjectNavigation();
  const { createNode, updateNode, moveChapterOnTimeline } = useBookNode({ projectId, userId });
  const { setNodeStorylines } = useStoryline({ projectId, userId });
  const { splitAtOrder, updateAct, moveBoundary, unbindDrift, deleteAct, remapAfterSpread } =
    useBookAct({ projectId });
  const { markers, addMarker, updateMarker, deleteMarker } = useTimelineMarkers(projectId);
  const presentation = useMobilePaperPresentation(
    target ?? { entityType: 'node', id: '' },
  );
  const glyph = usePaperGlyph(target ?? { entityType: 'node', id: '' });

  const [view, setView] = useState<TimelineView>(readPersistedView);
  const [filter, setFilter] = useState<string>('all');
  const [hiddenStorylines, setHiddenStorylines] = useState<ReadonlySet<string>>(() => new Set());
  const [sheet, setSheet] = useState<SheetState>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [drag, setDrag] = useState<{ id: string; y: number; order: number } | null>(null);
  const [handleDrag, setHandleDrag] = useState<{ id: string; y: number } | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const moreAnchorRef = useRef<HTMLButtonElement>(null);
  const dragHandleRef = useRef<ChapterLanePointerDragHandle | null>(null);
  const suppressClickRef = useRef(false);
  const pendingAnchorRef = useRef<{ order: number; viewportY: number } | null>(null);

  const isNarrative = view === 'narrative';
  const orderField: 'bookOrder' | 'narrativeOrder' = isNarrative ? 'narrativeOrder' : 'bookOrder';
  useEffect(() => {
    try {
      localStorage.setItem(TIMELINE_VIEW_STORAGE_KEY, view);
      localStorage.setItem(UNAFFILIATED_STORAGE_KEY, unaffiliatedVisible ? '1' : '0');
    } catch {
      // Preference only.
    }
  }, [unaffiliatedVisible, view]);

  const { expandedScale, setExpandedScale, touchHandlers } = useTimelineExpandedScale({
    isExpanded: true,
    scrollContainerRef: scrollRef,
    axis: 'y',
    storageKey: VERTICAL_SCALE_STORAGE_KEY,
  });

  const nodesWithStorylines = useMemo<TimelineNode[]>(() => {
    const storylineById = new Map(storylines.map((sl) => [sl.id, sl]));
    return bookNodes.filter(isChapter).map((node) => ({
      ...node,
      storylines: (nodeStorylineMapping[node.id] || [])
        .map((slId) => storylineById.get(slId))
        .filter((sl): sl is Storyline => Boolean(sl)),
    }));
  }, [bookNodes, nodeStorylineMapping, storylines]);

  const rightAnchorOrder = useMemo(() => {
    const vals = isNarrative
      ? markers.map((m) => m.narrativeOrder)
      : bookActs.map((a) => a.startOrder ?? Number.NEGATIVE_INFINITY);
    return vals.length ? Math.max(...vals) : null;
  }, [isNarrative, markers, bookActs]);

  const {
    placedNodes,
    unplacedNodes,
    orderOf,
    minOrder,
    maxOrder,
    timelineWidth,
    orderToPosition,
    positionToOrder,
  } = useBottomTimelineSelectors({
    nodesWithStorylines,
    storylines,
    isExpanded: true,
    expandedScale,
    gridUnit: GRID_UNIT,
    nodeDefaultWidth: NODE_DEFAULT_WIDTH,
    orderField,
    extraMaxOrder: rightAnchorOrder,
    runwayUnits: RUNWAY_UNITS,
  });

  const dotY = useCallback((order: number) => TOP_PAD + orderToPosition(order), [orderToPosition]);
  const yToOrder = useCallback(
    (clientY: number) => {
      const rect = axisRef.current?.getBoundingClientRect();
      const y = rect ? clientY - rect.top : 0;
      return positionToOrder(y - TOP_PAD);
    },
    [positionToOrder],
  );

  const primaryOf = useCallback(
    (nodeId: string) =>
      resolvePrimaryStorylineId(primaryStorylineByNode[nodeId], nodeStorylineMapping[nodeId] ?? []),
    [nodeStorylineMapping, primaryStorylineByNode],
  );

  const sortedStorylines = useMemo(
    () => [...storylines].sort((a, b) => a.orderKey - b.orderKey),
    [storylines],
  );
  const chapterIndexById = useMemo(() => {
    const chapters = bookNodes.filter(isChapter).sort((a, b) => a.bookOrder - b.bookOrder);
    return new Map(chapters.map((node, index) => [node.id, index + 1]));
  }, [bookNodes]);
  const driftTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of bookNodes) if (isDrift(node)) map.set(node.id, node.title);
    return map;
  }, [bookNodes]);

  // Tracks: visible storylines (capped) plus one dashed "other" track for
  // unaffiliated chapters and chapters whose storyline is hidden.
  const visibleStorylines = useMemo(
    () => sortedStorylines.filter((sl) => !hiddenStorylines.has(sl.id)).slice(0, MAX_TRACKS),
    [hiddenStorylines, sortedStorylines],
  );
  const needsOtherTrack = useMemo(
    () =>
      placedNodes.some((node) => {
        const primary = primaryOf(node.id);
        return primary === null ? unaffiliatedVisible : !visibleStorylines.some((sl) => sl.id === primary);
      }),
    [placedNodes, primaryOf, unaffiliatedVisible, visibleStorylines],
  );
  const tracks = useMemo<Track[]>(() => {
    const list: Track[] = visibleStorylines.map((sl) => ({ id: sl.id, color: sl.color, name: sl.name }));
    if (needsOtherTrack) {
      list.push({ id: OTHER_TRACK_ID, color: null, name: t('bottomTimeline.synthetic.unaffiliated') });
    }
    return list;
  }, [needsOtherTrack, t, visibleStorylines]);
  const gutterWidth = Math.max(68, TRACK_X0 + TRACK_STEP * Math.max(0, tracks.length - 1) + 20);
  const trackX = (index: number) => TRACK_X0 + TRACK_STEP * index;
  const trackIndexOf = useCallback(
    (nodeId: string) => {
      const primary = primaryOf(nodeId);
      const index = tracks.findIndex((track) => track.id === primary);
      if (index >= 0) return index;
      if (primary === null && !unaffiliatedVisible) return -1;
      return tracks.findIndex((track) => track.id === OTHER_TRACK_ID);
    },
    [primaryOf, tracks, unaffiliatedVisible],
  );

  const visibleChapters = useMemo(
    () =>
      placedNodes
        .map((node) => ({ node, trackIndex: trackIndexOf(node.id), order: orderOf(node) ?? 0 }))
        .filter((item) => item.trackIndex >= 0),
    [orderOf, placedNodes, trackIndexOf],
  );

  const actSegments = useMemo(
    () => (isNarrative ? [] : deriveActSegments(bookActs, placedNodes)),
    [bookActs, isNarrative, placedNodes],
  );
  const sortedActs = useMemo(() => sortActs(bookActs), [bookActs]);

  // Live positions: a dragged dot (or handle) follows the finger before the
  // write commits, and the entries re-project from that position each frame.
  const chapterY = useCallback(
    (id: string, order: number) => (drag?.id === id ? drag.y : dotY(order)),
    [dotY, drag],
  );
  const items = useMemo<VerticalTimelineItem[]>(() => {
    const list: VerticalTimelineItem[] = visibleChapters.map(({ node, order }) => ({
      id: node.id,
      kind: 'chapter',
      y: chapterY(node.id, order),
    }));
    if (!isNarrative) {
      for (const segment of actSegments) {
        const order = segment.act.startOrder ?? minOrder;
        list.push({
          id: `act:${segment.act.id}`,
          kind: 'act',
          y: handleDrag?.id === segment.act.id ? handleDrag.y : dotY(order),
        });
      }
    } else {
      for (const marker of markers) {
        list.push({
          id: `marker:${marker.id}`,
          kind: 'marker',
          y: handleDrag?.id === marker.id ? handleDrag.y : dotY(marker.narrativeOrder),
        });
      }
    }
    if (drag && !visibleChapters.some(({ node }) => node.id === drag.id)) {
      // A chip dragged out of the unplaced drawer projects while it hovers.
      list.push({ id: drag.id, kind: 'chapter', y: drag.y });
    }
    return list;
  }, [actSegments, chapterY, dotY, drag, handleDrag, isNarrative, markers, minOrder, visibleChapters]);

  const entries = useMemo(() => projectVerticalTimeline(items, { minTop: 8 }), [items]);
  const axisHeight = Math.max(
    TOP_PAD + timelineWidth + BOTTOM_PAD,
    verticalTimelineContentHeight(entries) + BOTTOM_PAD,
  );

  const nodeById = useMemo(() => new Map(bookNodes.map((node) => [node.id, node])), [bookNodes]);
  const actById = useMemo(() => new Map(bookActs.map((act) => [act.id, act])), [bookActs]);
  const markerById = useMemo(() => new Map(markers.map((m) => [m.id, m])), [markers]);
  const currentNodeId = target?.entityType === 'node' ? target.id : null;

  // ---- sheets ride the tool as a popover transient (Back closes them first) ----
  const transientId = workspaceUi.transient.kind === 'popover' ? workspaceUi.transient.id : null;
  useEffect(() => {
    if (sheet && transientId !== MOBILE_TIMELINE_SHEET_TRANSIENT_ID) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- controller-owned dismissal
      setSheet(null);
    }
  }, [sheet, transientId]);
  const openSheet = (next: NonNullable<SheetState>) => {
    setSheet(next);
    if (transientId !== MOBILE_TIMELINE_SHEET_TRANSIENT_ID) {
      onWorkspaceUiAction({
        type: 'set-transient',
        transient: { kind: 'popover', id: MOBILE_TIMELINE_SHEET_TRANSIENT_ID },
      });
    }
  };
  const closeSheet = () => {
    setSheet(null);
    if (transientId === MOBILE_TIMELINE_SHEET_TRANSIENT_ID) {
      onWorkspaceUiAction({ type: 'set-transient', transient: { kind: 'none' } });
    }
  };

  // ---- cluster zoom keeps the first dot under the same viewport y ----
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const scroller = scrollRef.current;
    if (!anchor || !scroller) return;
    pendingAnchorRef.current = null;
    scroller.scrollTop = Math.max(0, dotY(anchor.order) - anchor.viewportY);
  }, [dotY, expandedScale]);

  const zoomIntoCluster = (entry: VerticalTimelineEntry) => {
    if (!entry.bracket) return;
    const span = Math.max(8, entry.bracket.toY - entry.bracket.fromY);
    const needed = entry.ids.length * VERTICAL_TIMELINE_LEVELS.S.height + (entry.ids.length - 1) * 2;
    const next = Math.min(3, Math.max(0.5, expandedScale * (needed / span)));
    const first = nodeById.get(entry.ids[0]!);
    const scroller = scrollRef.current;
    if (next <= expandedScale + 0.001 || !first) {
      openSheet({ kind: 'chapter', id: entry.ids[0]! });
      return;
    }
    const order = orderOf(first as TimelineNode) ?? 0;
    pendingAnchorRef.current = {
      order,
      viewportY: scroller ? dotY(order) - scroller.scrollTop : 80,
    };
    setExpandedScale(next);
  };

  // ---- writes ----
  const placeAt = useCallback(
    async (nodeId: string, order: number) => {
      await commitChapterLaneDrop({
        nodeId,
        targetLaneId: DEFAULT_STORYLINE_LANE_ID,
        targetOrder: order,
        orderField,
        moveChapterOnTimeline,
      });
    },
    [moveChapterOnTimeline, orderField],
  );
  const changeStoryline = async (nodeId: string, storylineId: string | null) => {
    if (storylineId === null) {
      await updateNode(nodeId, { mainStorylineId: null });
      await setNodeStorylines(nodeId, []);
      return;
    }
    const memberships = nodeStorylineMapping[nodeId] ?? [];
    await setNodeStorylines(
      nodeId,
      memberships.includes(storylineId) ? memberships : [...memberships, storylineId],
      { primaryStorylineId: storylineId },
    );
  };
  const lastChapterOrder = useMemo(
    () => (placedNodes.length ? Math.max(...placedNodes.map((n) => orderOf(n) ?? 0)) : null),
    [orderOf, placedNodes],
  );
  const endOrder = () => (lastChapterOrder ?? 0) + CHAPTER_ORDER_STRIDE;
  const nextBookOrder = useMemo(() => {
    const chapters = bookNodes.filter(isChapter);
    return chapters.length ? Math.max(...chapters.map((c) => c.bookOrder)) + CHAPTER_ORDER_STRIDE : 0;
  }, [bookNodes]);
  const createChapterAt = async (order: number | null) => {
    const storylineId =
      filter !== 'all' && filter !== OTHER_TRACK_ID ? filter : (visibleStorylines[0]?.id ?? null);
    const at = order ?? endOrder();
    await createNode({
      kind: 'chapter',
      bookOrder: isNarrative ? nextBookOrder : at,
      ...(isNarrative ? { narrativeOrder: at } : {}),
      mainStorylineId: storylineId,
      position: { x: 0, y: 0 },
    });
  };
  const handleSpread = async () => {
    await spreadTimelineNodes({
      nodes: placedNodes,
      orderOf,
      updateOrder: (id, newOrder) => updateNode(id, { [orderField]: newOrder }),
      remapAfterSpread: isNarrative ? undefined : remapAfterSpread,
    });
  };

  // ---- gestures: only the gutter (dots, handles, empty track) ----
  const dotCandidates = useMemo(
    () => visibleChapters.map(({ node, order }) => ({ id: node.id, y: dotY(order) })),
    [dotY, visibleChapters],
  );
  const startDotDrag = (
    event: ReactPointerEvent<HTMLElement>,
    nodeId: string,
    sourceElement: HTMLElement,
  ) => {
    if (placing) return;
    dragHandleRef.current?.cancel();
    const startOrder = orderOf(nodeById.get(nodeId) as TimelineNode) ?? null;
    dragHandleRef.current = startChapterLanePointerDrag({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startClientX: event.clientX,
      startClientY: event.clientY,
      sourceElement,
      grabOffsetX: 0,
      resolveTarget: (_clientX, clientY) => {
        const order = yToOrder(clientY);
        const rect = axisRef.current?.getBoundingClientRect();
        setDrag({ id: nodeId, y: rect ? clientY - rect.top : 0, order });
        return { storylineId: DEFAULT_STORYLINE_LANE_ID, order };
      },
      onDragStart: () => {
        suppressClickRef.current = true;
        setLifted(nodeId);
      },
      onDrop: async ({ order }) => {
        if (startOrder !== null && Math.abs(order - startOrder) < 1e-6) return;
        await placeAt(nodeId, order);
      },
      onDragEnd: () => {
        setDrag(null);
        setLifted(null);
        dragHandleRef.current = null;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      },
      mobileTouch: {
        axis: 'y',
        holdBehavior: 'lift',
        onLift: () => {
          suppressClickRef.current = true;
          setLifted(nodeId);
          navigator.vibrate?.(8);
        },
        onLiftCancel: () => {
          setLifted(null);
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        },
        onMenu: () => undefined,
        scrollContainer: scrollRef.current,
      },
    });
  };
  const onGutterPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (placing) return;
    const rect = axisRef.current?.getBoundingClientRect();
    const y = rect ? event.clientY - rect.top : 0;
    const dot = nearestVerticalDot(dotCandidates, y, VERTICAL_TIMELINE_DOT_HIT_PX);
    if (dot) {
      const element = axisRef.current?.querySelector<HTMLElement>(
        `[data-dot-id="${CSS.escape(dot.id)}"]`,
      );
      if (element) startDotDrag(event, dot.id, element);
      return;
    }
    const order = yToOrder(event.clientY);
    startVerticalLongPress({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startClientX: event.clientX,
      startClientY: event.clientY,
      onLongPress: () => {
        navigator.vibrate?.(8);
        openSheet({ kind: 'create', order });
      },
    });
  };
  const onGutterClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current || lifted) {
      suppressClickRef.current = false;
      return;
    }
    const rect = axisRef.current?.getBoundingClientRect();
    const y = rect ? event.clientY - rect.top : 0;
    const dot = nearestVerticalDot(dotCandidates, y, VERTICAL_TIMELINE_DOT_HIT_PX);
    if (dot) openSheet({ kind: 'chapter', id: dot.id });
  };
  const onHandlePointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    kind: 'act' | 'marker',
    id: string,
  ) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.stopPropagation();
    if (placing) return;
    startVerticalHandleDrag({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startClientX: event.clientX,
      startClientY: event.clientY,
      onMove: (clientY) => {
        const rect = axisRef.current?.getBoundingClientRect();
        setHandleDrag({ id, y: rect ? clientY - rect.top : 0 });
      },
      onDrop: (clientY) => {
        const order = yToOrder(clientY);
        if (kind === 'act') void moveBoundary(id, order);
        else updateMarker(id, { narrativeOrder: order });
      },
      onTap: () => openSheet({ kind, id }),
      onEnd: () => setHandleDrag(null),
    });
  };
  const startChipDrag = (event: ReactPointerEvent<HTMLButtonElement>, nodeId: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startDotDrag(event, nodeId, event.currentTarget);
  };

  const locateCurrent = () => {
    const scroller = scrollRef.current;
    if (!scroller || !currentNodeId) return;
    const node = nodeById.get(currentNodeId);
    const order = node && isChapter(node) ? orderOf(node as TimelineNode) : null;
    if (order === null || order === undefined) return;
    scroller.scrollTo({ top: Math.max(0, dotY(order) - scroller.clientHeight / 2), behavior: 'smooth' });
  };

  // ---- rendering helpers ----
  const filterMatches = (nodeId: string) => {
    if (filter === 'all') return true;
    const primary = primaryOf(nodeId);
    if (filter === OTHER_TRACK_ID) return primary === null || !visibleStorylines.some((sl) => sl.id === primary);
    return primary === filter;
  };
  const slots = placing
    ? verticalTimelineSlots(
        visibleChapters.filter(({ node }) => node.id !== placing).map(({ order }) => order),
        CHAPTER_ORDER_STRIDE,
      )
    : [];
  const placingNode = placing ? nodeById.get(placing) : null;
  const dragOrderLabel = drag
    ? t('mobileTimeline.dragOrder', {
        view: t(isNarrative ? 'bottomTimeline.view.narrative' : 'bottomTimeline.view.book'),
        order: Math.round(drag.order * 10) / 10,
      })
    : null;
  const leaderPoints = (entry: VerticalTimelineEntry, dotX: number) => {
    const channel = gutterWidth + CHANNEL_OFFSET;
    const left = gutterWidth + ENTRY_OFFSET;
    return `${dotX},${entry.leader.fromY} ${channel},${entry.leader.fromY} ${channel},${entry.leader.toY} ${left},${entry.leader.toY}`;
  };

  const sheetNode = sheet?.kind === 'chapter' ? nodeById.get(sheet.id) : null;
  const sheetAct = sheet?.kind === 'act' ? actById.get(sheet.id) : null;
  const sheetMarker = sheet?.kind === 'marker' ? markerById.get(sheet.id) : null;

  return (
    <section
      className="m-tools-face m-paper-tool-surface m-vtl"
      role="dialog"
      aria-modal="true"
      data-debug-id="mobile-paper-timeline"
      data-view={view}
      data-placing={placing ? 'true' : 'false'}
      aria-label={t('mobileWorkspace.paperAgent.timeline')}
      style={{ ['--m-vtl-gutter' as string]: `${gutterWidth}px` } as CSSProperties}
    >
      <header className="m-tools-face__header m-vtl__header">
        <span className="m-tools-face__identity m-vtl__identity">
          {target && (
            <>
              <span aria-hidden="true">{glyph}</span> {presentation.title}
            </>
          )}
        </span>
        <span className="m-vtl__title">{t('mobileWorkspace.paperAgent.timeline')}</span>
        <button
          type="button"
          className="m-tools-face__close"
          onClick={onClose}
          aria-label={t('findPanel.closeTitle')}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      {placingNode ? (
        <div className="m-vtl__banner" data-debug-id="mobile-timeline-placing">
          {t('mobileTimeline.placing', { title: placingNode.title || t('common.untitled') })}
          <button type="button" onClick={() => setPlacing(null)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : drag ? (
        <div className="m-vtl__banner" data-debug-id="mobile-timeline-dragging">
          {t('mobileTimeline.moving', {
            title: nodeById.get(drag.id)?.title || t('common.untitled'),
          })}
          <span>{dragOrderLabel}</span>
        </div>
      ) : (
        <div className="m-vtl__controls">
          <SegmentedControl
            size="sm"
            value={view}
            ariaLabel={t('bottomTimeline.view.toggleTitle')}
            options={[
              { value: 'book', label: t('bottomTimeline.view.book'), title: t('bottomTimeline.view.bookTitle') },
              {
                value: 'narrative',
                label: t('bottomTimeline.view.narrative'),
                title: t('bottomTimeline.view.narrativeTitle'),
              },
            ]}
            onChange={(next) => {
              setView(next);
              setPlacing(null);
            }}
          />
          <span className="m-vtl__spacer" />
          <button
            type="button"
            className="m-vtl__ibtn"
            aria-label={t('mobileTimeline.create')}
            onClick={() => openSheet({ kind: 'create', order: null })}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="m-vtl__ibtn"
            aria-label={t('bottomTimeline.locateCurrent')}
            disabled={!currentNodeId}
            onClick={locateCurrent}
          >
            <Crosshair size={18} aria-hidden="true" />
          </button>
          <button
            ref={moreAnchorRef}
            type="button"
            className="m-vtl__ibtn"
            aria-label={t('mobileTimeline.more')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
          <AnchoredPopover
            anchorRef={moreAnchorRef}
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            placement="bottom-end"
            className="menu-surface menu-surface--standard m-vtl__more"
            role="menu"
            ariaLabel={t('mobileTimeline.more')}
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={unaffiliatedVisible}
              className="menu-surface__item"
              onClick={() => setUnaffiliatedVisible(!unaffiliatedVisible)}
            >
              {t(unaffiliatedVisible ? 'bottomTimeline.unaffiliated.hide' : 'bottomTimeline.unaffiliated.show')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-surface__item"
              disabled={placedNodes.length < 2}
              onClick={() => {
                setMoreOpen(false);
                void handleSpread();
              }}
            >
              {t('mobileTimeline.spread')}
            </button>
            {sortedStorylines.length > 1 && (
              <>
                <div className="menu-surface__label m-vtl__more-label">
                  {t('mobileTimeline.visibleStorylines')}
                </div>
                {sortedStorylines.map((storyline) => {
                  const visible = !hiddenStorylines.has(storyline.id);
                  return (
                    <button
                      key={storyline.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={visible}
                      className="menu-surface__item"
                      onClick={() =>
                        setHiddenStorylines((current) => {
                          const next = new Set(current);
                          if (visible) next.add(storyline.id);
                          else next.delete(storyline.id);
                          return next;
                        })
                      }
                    >
                      <i className="m-vtl__more-dot" style={{ background: storyline.color, opacity: visible ? 1 : 0.3 }} />
                      {storyline.name}
                    </button>
                  );
                })}
              </>
            )}
          </AnchoredPopover>
        </div>
      )}

      <div className="m-vtl__legend" role="group" aria-label={t('mobileTimeline.tracksLabel')}>
        <button
          type="button"
          className={`m-vtl-pill m-vtl-pill--all${filter === 'all' ? ' is-on' : ''}`}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          {t('mobileTimeline.filterAll')}
        </button>
        {tracks.map((track) => (
          <button
            key={track.id}
            type="button"
            className={`m-vtl-pill${track.id === OTHER_TRACK_ID ? ' m-vtl-pill--none' : ''}${filter === track.id ? ' is-on' : ''}`}
            style={track.color ? ({ ['--c' as string]: track.color } as CSSProperties) : undefined}
            aria-pressed={filter === track.id}
            onClick={() => setFilter((current) => (current === track.id ? 'all' : track.id))}
          >
            <i aria-hidden="true" />
            {track.name}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="m-vtl__scroll"
        data-debug-id="mobile-timeline-scroll"
        {...touchHandlers}
      >
        <div ref={axisRef} className="m-vtl__axis" style={{ height: axisHeight }}>
          {/* tracks */}
          {tracks.map((track, index) => (
            <i
              key={track.id}
              className={`m-vtl__trk${track.id === OTHER_TRACK_ID ? ' m-vtl__trk--none' : ''}`}
              style={{ left: trackX(index), ...(track.color ? { ['--c' as string]: track.color } : {}) } as CSSProperties}
              aria-hidden="true"
            />
          ))}

          {/* gutter lines + handles for acts / markers */}
          {!isNarrative &&
            actSegments.map((segment) => {
              const order = segment.act.startOrder ?? minOrder;
              const y = handleDrag?.id === segment.act.id ? handleDrag.y : dotY(order);
              return (
                <span key={segment.act.id} className="m-vtl__gline" style={{ top: y }} aria-hidden="true">
                  <button
                    type="button"
                    className="m-vtl__handle m-vtl__handle--act"
                    aria-label={segment.act.name}
                    tabIndex={-1}
                    onPointerDown={(event) => onHandlePointerDown(event, 'act', segment.act.id)}
                  />
                </span>
              );
            })}
          {isNarrative &&
            markers.map((marker) => {
              const y = handleDrag?.id === marker.id ? handleDrag.y : dotY(marker.narrativeOrder);
              return (
                <span key={marker.id} className="m-vtl__gline m-vtl__gline--mk" style={{ top: y }} aria-hidden="true">
                  <button
                    type="button"
                    className="m-vtl__handle m-vtl__handle--mk"
                    aria-label={marker.label}
                    tabIndex={-1}
                    onPointerDown={(event) => onHandlePointerDown(event, 'marker', marker.id)}
                  />
                </span>
              );
            })}

          {/* dots (gesture owners) */}
          <div
            className="m-vtl__gutter"
            style={{ width: gutterWidth }}
            data-debug-id="mobile-timeline-gutter"
            onPointerDown={onGutterPointerDown}
            onClick={onGutterClick}
          >
            {visibleChapters.map(({ node, trackIndex, order }) => {
              const primary = primaryOf(node.id);
              const track = tracks[trackIndex];
              const hollow = track?.id === OTHER_TRACK_ID;
              return (
                <b
                  key={node.id}
                  className={`m-vtl__dot${hollow ? ' m-vtl__dot--hollow' : ''}${node.id === currentNodeId ? ' m-vtl__dot--cur' : ''}${lifted === node.id ? ' m-vtl__dot--lift' : ''}${filterMatches(node.id) ? '' : ' is-dim'}`}
                  data-dot-id={node.id}
                  data-storyline={primary ?? ''}
                  style={{ left: trackX(trackIndex), top: chapterY(node.id, order), ...(track?.color ? { ['--c' as string]: track.color } : {}) } as CSSProperties}
                  aria-hidden="true"
                />
              );
            })}
          </div>

          {/* guide line while a dot or chip is dragged */}
          {drag && <span className="m-vtl__guide" style={{ top: drag.y }} aria-hidden="true" />}

          {/* leaders: every entry connects back to its dot */}
          <svg className="m-vtl__leads" aria-hidden="true">
            {entries.map((entry) => {
              if (entry.kind === 'act' || entry.kind === 'marker') return null;
              const first = visibleChapters.find(({ node }) => node.id === entry.ids[0]);
              const dotX = first ? trackX(first.trackIndex) : trackX(0);
              const channel = gutterWidth + CHANNEL_OFFSET;
              return (
                <g key={`lead:${entry.id}`}>
                  {entry.bracket && (
                    <path
                      className="m-vtl__bracket"
                      d={`M${channel - 6},${entry.bracket.fromY} H${channel} V${entry.bracket.toY} H${channel - 6}`}
                    />
                  )}
                  <polyline points={leaderPoints(entry, dotX)} />
                </g>
              );
            })}
          </svg>

          {/* projected entries */}
          {entries.map((entry) => {
            if (entry.kind === 'act') {
              const act = actById.get(entry.id.slice(4));
              const segment = actSegments.find((s) => s.act.id === act?.id);
              if (!act) return null;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="m-vtl__chip m-vtl__chip--act"
                  style={{ top: entry.top }}
                  onClick={() => openSheet({ kind: 'act', id: act.id })}
                >
                  {act.name}
                  <span className="m-vtl__chip-n">
                    {t('bottomTimeline.act.chapterCount', { count: segment?.chapters.length ?? 0 })}
                  </span>
                  {act.driftNodeId && <span className="m-vtl__chip-a">⚓</span>}
                </button>
              );
            }
            if (entry.kind === 'marker') {
              const marker = markerById.get(entry.id.slice(7));
              if (!marker) return null;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="m-vtl__chip m-vtl__chip--mk"
                  style={{ top: entry.top }}
                  onClick={() => openSheet({ kind: 'marker', id: marker.id })}
                >
                  <b aria-hidden="true" />
                  {marker.driftNodeId ? (driftTitleById.get(marker.driftNodeId) ?? marker.label) : marker.label}
                  {marker.driftNodeId && <span className="m-vtl__chip-a">⚓</span>}
                </button>
              );
            }
            if (entry.kind === 'cluster') {
              const members = entry.ids.map((id) => nodeById.get(id)).filter((n): n is BookNode => Boolean(n));
              const firstIndex = chapterIndexById.get(entry.ids[0]!) ?? 0;
              const lastIndex = chapterIndexById.get(entry.ids[entry.ids.length - 1]!) ?? 0;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="m-vtl__cluster"
                  style={{ top: entry.top, height: entry.height }}
                  data-debug-id="mobile-timeline-cluster"
                  onClick={() => zoomIntoCluster(entry)}
                >
                  <span className="m-vtl__cluster-t">
                    {t('mobileTimeline.clusterTitle', { from: firstIndex, to: lastIndex, count: entry.ids.length })}
                  </span>
                  <span className="m-vtl__cluster-m">
                    {members.map((m) => m.title || t('common.untitled')).join(' · ')} · {t('mobileTimeline.clusterHint')}
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="m-vtl__go" />
                </button>
              );
            }
            const node = nodeById.get(entry.id);
            if (!node || !isChapter(node)) return null;
            const level = entry.level ?? 'X';
            const index = chapterIndexById.get(node.id) ?? 0;
            const words = canonicalWordCount(node);
            const flashback = isNarrative && typeof node.narrativeOrder === 'number';
            return (
              <div
                key={entry.id}
                className={`m-vtl__ent m-vtl__ent--${level}${node.id === currentNodeId ? ' is-current' : ''}${filterMatches(node.id) ? '' : ' is-dim'}${drag?.id === node.id ? ' is-proj' : ''}`}
                style={{ top: entry.top, height: entry.height }}
                data-debug-id="mobile-timeline-entry"
              >
                <button
                  type="button"
                  className="m-vtl__ent-body"
                  onClick={() => openSheet({ kind: 'chapter', id: node.id })}
                >
                  <span className="m-vtl__num">
                    {t('mobileTimeline.chapterNumber', { index })}
                    {node.id === currentNodeId && <em>{t('mobileTimeline.current')}</em>}
                    {flashback && level !== 'X' && (
                      <em className="m-vtl__fb">{t('mobileTimeline.bookIndex', { index })}</em>
                    )}
                  </span>
                  <span className="m-vtl__t">{node.title || t('common.untitled')}</span>
                  {(level === 'L' || level === 'M') && (
                    <span className="m-vtl__meta">
                      {words !== null ? `${t('mobileTimeline.wordCount', { count: words })} · ` : ''}
                      {t(`mobileTimeline.status.${node.writingStatus}`, { defaultValue: node.writingStatus })}
                    </span>
                  )}
                  {level === 'L' && node.summary && <span className="m-vtl__sum">{node.summary}</span>}
                  {drag?.id === node.id && <span className="m-vtl__meta m-vtl__meta--proj">{dragOrderLabel}</span>}
                </button>
                {level !== 'X' && (
                  <button
                    type="button"
                    className="m-vtl__go"
                    aria-label={t('mobileTimeline.openPaper')}
                    onClick={() => openEntity({ entityType: 'node', id: node.id })}
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}

          {/* placement slots (menu fallback) */}
          {placing &&
            slots.map((slot) => {
              const y = dotY(slot.order);
              return (
                <button
                  key={`slot:${slot.afterIndex}`}
                  type="button"
                  className="m-vtl__slot"
                  style={{ top: y }}
                  data-debug-id="mobile-timeline-slot"
                  onClick={() => {
                    const nodeId = placing;
                    setPlacing(null);
                    void placeAt(nodeId, slot.order);
                  }}
                >
                  {t('mobileTimeline.placeHere')}
                </button>
              );
            })}

          {visibleChapters.length === 0 && !drag && (
            <div className="m-vtl__empty">{t('mobileTimeline.noChapters')}</div>
          )}
        </div>
      </div>

      {isNarrative && unplacedNodes.length > 0 && (
        <div className={`m-vtl__tray${drawerOpen ? ' is-open' : ''}`} data-debug-id="mobile-timeline-tray">
          <button type="button" className="m-vtl__tray-h" onClick={() => setDrawerOpen((open) => !open)}>
            <span className="m-sheet__grab" aria-hidden="true" />
            {t('bottomTimeline.unplaced.label')}
            <span className="m-vtl__tray-n">{unplacedNodes.length}</span>
            <span className="m-vtl__tray-hint">{t('mobileTimeline.unplacedHint')}</span>
          </button>
          {drawerOpen && (
            <div className="m-vtl__tray-b">
              {unplacedNodes.map((node) => {
                const primary = primaryOf(node.id);
                const color = storylines.find((sl) => sl.id === primary)?.color ?? null;
                return (
                  <button
                    key={node.id}
                    type="button"
                    className={`m-vtl__uchip${drag?.id === node.id ? ' is-src' : ''}`}
                    data-debug-id="mobile-timeline-unplaced-chip"
                    onPointerDown={(event) => startChipDrag(event, node.id)}
                    onClick={() => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      openSheet({ kind: 'chapter', id: node.id });
                    }}
                  >
                    <b className={`m-vtl__dot m-vtl__dot--static${color ? '' : ' m-vtl__dot--hollow'}`} style={color ? ({ ['--c' as string]: color } as CSSProperties) : undefined} aria-hidden="true" />
                    <span className="m-vtl__num">{t('mobileTimeline.chapterNumber', { index: chapterIndexById.get(node.id) ?? 0 })}</span>
                    <span className="m-vtl__t">{node.title || t('common.untitled')}</span>
                    <MoreHorizontal size={16} aria-hidden="true" className="m-vtl__go" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {sheetNode && isChapter(sheetNode) && (
        <MobileTimelineChapterSheet
          node={sheetNode}
          chapterIndex={chapterIndexById.get(sheetNode.id) ?? 0}
          view={view}
          storylines={sortedStorylines}
          primaryStorylineId={primaryOf(sheetNode.id)}
          showUnaffiliated
          onOpen={() => {
            closeSheet();
            openEntity({ entityType: 'node', id: sheetNode.id });
          }}
          onChangeStoryline={(storylineId) => void changeStoryline(sheetNode.id, storylineId)}
          onMovePosition={() => {
            closeSheet();
            setDrawerOpen(false);
            setPlacing(sheetNode.id);
          }}
          onPlaceAtEnd={() => {
            closeSheet();
            void placeAt(sheetNode.id, endOrder());
          }}
          onUnplace={() => {
            closeSheet();
            void updateNode(sheetNode.id, { narrativeOrder: null });
          }}
          onStartAct={() => {
            closeSheet();
            void splitAtOrder(sheetNode.bookOrder);
          }}
          onSetStatus={(status: ChapterWritingStatus) => void updateNode(sheetNode.id, { writingStatus: status })}
          onClose={closeSheet}
        />
      )}
      {sheetAct && (
        <MobileTimelineActSheet
          act={sheetAct as BookAct}
          position={sortedActs.findIndex((a) => a.id === sheetAct.id) + 1}
          count={sortedActs.length}
          chapterCount={actSegments.find((s) => s.act.id === sheetAct.id)?.chapters.length ?? 0}
          driftTitle={sheetAct.driftNodeId ? (driftTitleById.get(sheetAct.driftNodeId) ?? null) : null}
          onRename={(name) => void updateAct(sheetAct.id, { name })}
          onOpenNote={() => {
            closeSheet();
            if (sheetAct.driftNodeId) openEntity({ entityType: 'node', id: sheetAct.driftNodeId });
          }}
          onBind={() => {
            closeSheet();
            events.emit('drift-bind:open', { target: { kind: 'act', id: sheetAct.id } });
          }}
          onUnbind={() => void unbindDrift(sheetAct.id)}
          onDelete={() => {
            closeSheet();
            void deleteAct(sheetAct.id);
          }}
          onClose={closeSheet}
        />
      )}
      {sheetMarker && (
        <MobileTimelineMarkerSheet
          marker={sheetMarker}
          driftTitle={sheetMarker.driftNodeId ? (driftTitleById.get(sheetMarker.driftNodeId) ?? null) : null}
          onRename={(label) => updateMarker(sheetMarker.id, { label })}
          onOpenDrift={() => {
            closeSheet();
            if (sheetMarker.driftNodeId) openEntity({ entityType: 'node', id: sheetMarker.driftNodeId });
          }}
          onBind={() => {
            closeSheet();
            events.emit('drift-bind:open', { target: { kind: 'marker', id: sheetMarker.id } });
          }}
          onUnbind={() => updateMarker(sheetMarker.id, { driftNodeId: null })}
          onDelete={() => {
            closeSheet();
            deleteMarker(sheetMarker.id);
          }}
          onClose={closeSheet}
        />
      )}
      {sheet?.kind === 'create' && (
        <MobileTimelineCreateSheet
          view={view}
          atEnd={sheet.order === null}
          onCreateChapter={() => {
            const order = sheet.order;
            closeSheet();
            void createChapterAt(order);
          }}
          onCreateAct={() => {
            const order = sheet.order ?? (lastChapterOrder ?? 0) + 1;
            closeSheet();
            void splitAtOrder(order);
          }}
          onCreateMarker={() => {
            const order = sheet.order ?? endOrder();
            closeSheet();
            addMarker(order, t('bottomTimeline.marker.defaultLabel'));
          }}
          onClose={closeSheet}
        />
      )}
      <span className="m-vtl__scale" aria-hidden="true" data-scale={expandedScale.toFixed(2)}>
        {Math.round(expandedScale * 100) / 100}×
      </span>
      <span className="m-vtl__range" hidden data-min={minOrder} data-max={maxOrder} />
    </section>
  );
}
