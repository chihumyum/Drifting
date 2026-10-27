import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { useDataStoreFields } from '../store/use-data-store-fields';
import { requestConfirmation } from '../store/confirmation-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookContent } from '../usecase/useBookContent';
import { useBookNode } from '../usecase/useBookNode';
import { useProjectStore } from '../store/project-store';
import { useSettingsStore } from '../store/settings-store';
import { useUiStore } from '../store/ui-store';
import { EditorTopBar, SET_STATUS_ACTION_PREFIX } from '../components/editor/EditorTopBar';
import { EditorOutlineRail } from '../components/editor/EditorOutlineRail';
import { nestHeadings, type OutlineEntry } from '../components/editor/outline-rail-model';
import {
  createAllChaptersNavigator,
  type AllChaptersDestination,
} from '../components/editor/all-chapters-navigation';
import { VirtualChapterRow } from '../components/editor/VirtualChapterRow';
import { CommentAnchorHighlights } from '../components/editor/CommentAnchorHighlights';
import {
  useEditorSurfaceLifecycle,
  useReportEditorSurfaceReady,
} from '../components/editor/editor-surface-lifecycle-context';
import { AllChaptersFindPanel, type FindChapter } from '../components/search/AllChaptersFindPanel';
import { useShortcutsStore } from '../store/shortcuts-store';
import { matchesAccelerator } from '../lib/shortcuts';
import {
  canonicalWordCount,
  isChapter,
  CHAPTER_WRITING_STATUSES,
  type BookNode,
  type ChapterNode,
  type ChapterWritingStatus,
  type WritingStatus,
} from '../domain/book-node';
import { deriveActSegments, type BookAct } from '../domain/book-act';
import type { NodeContent } from '../domain/node-content';
import type { EntityLinkRef } from '../lib/extensions/entity-link';
import { openEntityLinkTarget } from '../features/editor/open-entity-link';
import { useChapterInsert } from '../features/editor/useChapterInsert';
import { ChapterEndActions } from '../features/editor/ChapterEndActions';
import { useWholeBookEditingChapter } from '../features/editor/whole-book-editing';
import { getPlatformRuntime } from '../platform/runtime';
import type { OutlineItem } from '../lib/outline';
import { parseOutline } from '../lib/outline';
import { saveActiveEditor } from '../lib/active-editor';
import {
  createMobileAllChaptersLoader,
  readMobileAllChaptersPosition,
  writeMobileAllChaptersPosition,
  type MobileAllChaptersReadPosition,
} from '../shells/mobile/workspace/mobile-all-chapters';
import { createMobileAllChaptersSearchOwner } from '../shells/mobile/workspace/mobile-all-chapters-search';
import { registerMobilePaperSearchOwner } from '../shells/mobile/workspace/mobile-paper-search';
import { publishMobileAllChaptersContext } from '../shells/mobile/workspace/mobile-all-chapters-context';
import {
  buildEntityLinkColorSignature,
  resolveEntityLinkTargetColor,
} from '../lib/entity-link-appearance';

const log = loglevel.getLogger('AllChaptersEditorView');
log.setLevel(loglevel.levels.WARN);

const ROMAN_NUMERALS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function toRoman(n: number): string {
  if (n <= 0) return String(n);
  if (n < ROMAN_NUMERALS.length) return ROMAN_NUMERALS[n];
  const map: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = n;
  for (const [v, s] of map) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
}

function anchorId(nodeId: string): string {
  return `all-chap-${nodeId}`;
}

// Outline-entry id namespace for act rows. Node ids are uuids, so the `act:`
// prefix never collides with a chapter entry id — the TOC click dispatcher
// and the act expand state both key off it.
const ACT_TOC_PREFIX = 'act:';
function actTocId(actId: string): string {
  return `${ACT_TOC_PREFIX}${actId}`;
}

// Where the reader was in 通览全书, kept in module scope so it survives closing
// and reopening the tab (and the mobile shell's paper unmounts). Ordinary
// desktop tab switches now preserve the mounted view directly. Keyed by project.
const readPositionByProject = new Map<string, MobileAllChaptersReadPosition>();

// "Read the whole book" mode — every chapter in bookOrder concatenated into
// one vertical scroller. Rows render canonical static prose in the same page
// geometry as ChapterEditor; only the focused row upgrades to a live TipTap/Yjs
// editor, and content reads are admitted through the bounded loader.
//
// Sidebar / timeline chapter clicks land here as scrolls instead of route
// changes: useProjectNavigation.openEntity and EditorShell's nav effect both
// detect `view === 'all-chapters-editor'` and update nodeUi.selectedId in
// place. This view watches that selection and scrolls to the matching row.
export function AllChaptersEditorView() {
  const { t } = useTranslation();
  const { isCommandActive, isPreparing } = useEditorSurfaceLifecycle();
  const [readyContentNodeIds, setReadyContentNodeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, navigateToHome, openEntity } = useProjectNavigation();
  if (!projectId) throw new Error('AllChaptersEditorView requires a projectId');
  if (!userId) throw new Error('AllChaptersEditorView requires a logged-in user');

  const {
    bookNodes,
    storylines,
    primaryStorylineByNode,
    bookElements,
    bookElementCategories,
    driftGroups,
  } = useDataStoreFields(
    'bookNodes',
    'storylines',
    'primaryStorylineByNode',
    'bookElements',
    'bookElementCategories',
    'driftGroups',
  );
  const bookActs = useDataStore((s) => s.bookActs);
  const entityLinkColorMode = useSettingsStore((s) => s.entityLinkColorMode);
  const entityLinkKindColors = useSettingsStore((s) => s.entityLinkKindColors);
  const entityLinkColorSignature = useMemo(
    () =>
      buildEntityLinkColorSignature(
        {
          bookElements,
          bookElementCategories,
          bookNodes,
          storylines,
          primaryStorylineByNode,
          driftGroups,
        },
        entityLinkColorMode,
        entityLinkKindColors,
      ),
    [
      bookElements,
      bookElementCategories,
      bookNodes,
      storylines,
      primaryStorylineByNode,
      driftGroups,
      entityLinkColorMode,
      entityLinkKindColors,
    ],
  );
  const resolveEntityLinkColor = useCallback(
    (kind: Parameters<typeof resolveEntityLinkTargetColor>[0], id: string) => {
      // Capture the minimal visual signature so static rows reserialize when
      // an owner/category color changes, without reacting to prose metadata.
      void entityLinkColorSignature;
      return resolveEntityLinkTargetColor(
        kind,
        id,
        useDataStore.getState(),
        entityLinkColorMode,
        entityLinkKindColors,
      );
    },
    [entityLinkColorMode, entityLinkKindColors, entityLinkColorSignature],
  );
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const projectName = currentProject?.name || projects.find((p) => p.id === projectId)?.name || 'Untitled';

  // Reference-link styling toggle, mirroring the single-entity editors. The
  // setting is global (applied to <html> in App.tsx); without this switch the
  // read-through had no way to turn mention styling on, so links rendered as
  // plain prose with no affordance.
  const entityLinkInteractive = useSettingsStore((s) => s.entityLinkInteractive);
  const setEntityLinkInteractive = useSettingsStore((s) => s.setEntityLinkInteractive);
  const toggleEntityLinkInteractive = useCallback(
    () => setEntityLinkInteractive(!entityLinkInteractive),
    [entityLinkInteractive, setEntityLinkInteractive],
  );

  const { getContentByNodeId, getOutlineByNodeId } =
    useBookContent({
      userId,
      projectId,
    });
  const { renameNode, updateNodeSummary, updateNode, deleteNode } = useBookNode({ projectId, userId });
  const insertChapter = useChapterInsert({ projectId, userId });
  const setChapterStorylineEditorNodeId = useUiStore((s) => s.setChapterStorylineEditorNodeId);

  // Stable per-node content cache so repeat fetches (after unmount/remount)
  // skip another roundtrip. Tracked by nodeId; null means "fetched, no row".
  const contentCacheRef = useRef<Map<string, NodeContent | null>>(new Map());
  const boundedContentLoad = useMemo(
    () =>
      createMobileAllChaptersLoader(async (nodeId: string) => {
        const content = await getContentByNodeId(nodeId);
        return content ?? null;
      }),
    [getContentByNodeId],
  );
  const fetchContent = useCallback(
    async (nodeId: string): Promise<NodeContent | null> => {
      const cached = contentCacheRef.current.get(nodeId);
      if (cached !== undefined) return cached;
      try {
        const c = await boundedContentLoad(nodeId);
        contentCacheRef.current.set(nodeId, c ?? null);
        return c ?? null;
      } catch (error) {
        log.error('[AllChapters] fetch content failed', nodeId, error);
        return null;
      }
    },
    [boundedContentLoad],
  );

  // The one chapter the user is actively editing. Only that row mounts a live
  // ChapterEditor; every other row renders cheap static prose at its real
  // height. `caret` carries the click point that promoted it, so the editor can
  // drop the cursor where the user pressed. Null = nothing focused (pure
  // read-through).
  const [focus, setFocus] = useState<{
    nodeId: string;
    caret: { clientX: number; clientY: number } | null;
  } | null>(null);
  const focusRef = useRef(focus);
  const promotionRef = useRef<Promise<void>>(Promise.resolve());
  const promotionRequestRef = useRef(0);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
  const handleActivate = useCallback(
    (nodeId: string, coords: { clientX: number; clientY: number }) => {
      const request = ++promotionRequestRef.current;
      promotionRef.current = promotionRef.current.then(async () => {
        const previous = focusRef.current?.nodeId ?? null;
        if (previous && previous !== nodeId) await saveActiveEditor();
        if (request !== promotionRequestRef.current) return;
        const next = { nodeId, caret: coords };
        focusRef.current = next;
        setFocus(next);
      });
    },
    [],
  );

  // Drift nodes (mainStorylineId == null) live outside the book's structural
  // ordering and surface in a dedicated sidebar tab — they shouldn't appear in
  // 通览全书, which is a chapter-by-chapter read-through.
  const orderedNodes = useMemo<ChapterNode[]>(
    () => bookNodes.filter(isChapter).sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );
  const hasCanonicalProseForCurrentBook =
    orderedNodes.length === 0 ||
    orderedNodes.some((node) => readyContentNodeIds.has(node.id));
  useReportEditorSurfaceReady(hasCanonicalProseForCurrentBook);

  const handleContentReady = useCallback((nodeId: string) => {
    setReadyContentNodeIds((current) => {
      if (current.has(nodeId)) return current;
      const next = new Set(current);
      next.add(nodeId);
      return next;
    });
  }, []);

  // Interleave act dividers into the read-through. Chapter indices keep
  // counting straight through (the Roman numeral sequence ignores acts);
  // empty acts still render their divider — a planned 幕 with no chapters
  // is a deliberate authoring signal, not a data glitch. No acts → plain
  // chapter list, zero overhead.
  type ReadRow =
    | { kind: 'act'; act: BookAct; seq: number; count: number; words: number | null }
    | { kind: 'chapter'; node: ChapterNode; idx: number };
  const readRows = useMemo<ReadRow[]>(() => {
    const segments = deriveActSegments(bookActs, orderedNodes);
    if (segments.length === 0) {
      return orderedNodes.map((node, idx) => ({ kind: 'chapter' as const, node, idx }));
    }
    const rows: ReadRow[] = [];
    const assignedIds = new Set(segments.flatMap((segment) => segment.chapters.map((node) => node.id)));
    const chapterIndexById = new Map(orderedNodes.map((node, idx) => [node.id, idx]));
    // A finite first act boundary intentionally leaves a book-head interval
    // without an act. Those chapters remain in the whole-book reader.
    for (const node of orderedNodes) {
      if (!assignedIds.has(node.id)) {
        rows.push({ kind: 'chapter', node, idx: chapterIndexById.get(node.id) ?? 0 });
      }
    }
    segments.forEach((seg, segIdx) => {
      rows.push({
        kind: 'act',
        act: seg.act,
        seq: segIdx + 1,
        count: seg.chapters.length,
        words: seg.chapters.every((chapter) => canonicalWordCount(chapter) != null)
          ? seg.chapters.reduce((sum, chapter) => sum + (canonicalWordCount(chapter) ?? 0), 0)
          : null,
      });
      for (const node of seg.chapters) {
        rows.push({ kind: 'chapter', node, idx: chapterIndexById.get(node.id) ?? 0 });
      }
    });
    return rows;
  }, [bookActs, orderedNodes]);

  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );

  // Outline = TOC of the focused chapter. We track per-chapter outline by
  // node id (only the rows that are currently mounted publish one), then
  // pick the one matching the scroll-spy's active chapter. Mirrors the
  // single-chapter NodeEditorView outline, but scoped to whichever section
  // the user is currently reading.
  const [outlineByNodeId, setOutlineByNodeId] = useState<Record<string, OutlineItem[]>>({});
  const handleOutlineChange = useCallback((nodeId: string, items: OutlineItem[]) => {
    setOutlineByNodeId((prev) => {
      const existing = prev[nodeId];
      if (sameOutline(existing, items)) return prev;
      return { ...prev, [nodeId]: items };
    });
  }, []);

  // Prefetch every chapter's persisted outline so the TOC can show a
  // collapse chevron for any chapter with headings — not just the one
  // currently scrolled into view. Without this, unmounted chapters have
  // no entry in outlineByNodeId and the chevron silently disappears.
  // Mounted rows still publish fresher outlines via handleOutlineChange;
  // we never overwrite an entry the row has already populated.
  //
  // No per-effect cancellation: bookNodes churns during initial sync, and
  // an aborted populate would strand the IDs in prefetchedOutlineRef (the
  // next effect run sees them already marked and skips). Letting the
  // populate fire regardless of dep churn is fine — setState on an
  // unmounted component is a no-op.
  const prefetchedOutlineRef = useRef<Set<string>>(new Set());
  const boundedOutlineLoad = useMemo(
    () => createMobileAllChaptersLoader((nodeId: string) => getOutlineByNodeId(nodeId)),
    [getOutlineByNodeId],
  );
  useEffect(() => {
    const toFetch = orderedNodes.filter((n) => !prefetchedOutlineRef.current.has(n.id));
    if (toFetch.length === 0) return;
    toFetch.forEach((n) => prefetchedOutlineRef.current.add(n.id));
    void (async () => {
      const buffered: Record<string, OutlineItem[]> = {};
      await Promise.all(
        toFetch.map(async (n) => {
          try {
            const json = await boundedOutlineLoad(n.id);
            if (!json) return;
            const items = parseOutline(json);
            if (items.length > 0) buffered[n.id] = items;
          } catch (err) {
            log.warn('[AllChapters] prefetch outline failed', n.id, err);
          }
        }),
      );
      if (Object.keys(buffered).length === 0) return;
      setOutlineByNodeId((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [id, items] of Object.entries(buffered)) {
          if (next[id]) continue; // VirtualChapterRow already published a fresher one
          next[id] = items;
          changed = true;
        }
        return changed ? next : prev;
      });
    })();
  }, [boundedOutlineLoad, orderedNodes]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Comment highlights need a render when the scroller mounts; the ref alone does not.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  // The chapter holding the caret drives the footer's word count.
  const getScrollRoot = useCallback(() => scrollRef.current, []);
  useWholeBookEditingChapter(projectId, getScrollRoot);
  const [navigationChapterId, setNavigationChapterId] = useState<string | null>(null);
  const navigatorRef = useRef<ReturnType<typeof createAllChaptersNavigator> | null>(null);
  useEffect(() => {
    const navigator = createAllChaptersNavigator({
      getRoot: () => scrollRef.current,
      prepareChapter: (nodeId) => {
        setNavigationChapterId(nodeId);
        return fetchContent(nodeId);
      },
    });
    navigatorRef.current = navigator;
    return () => {
      navigator.cancel();
      navigatorRef.current = null;
    };
  }, [fetchContent]);
  useEffect(() => {
    if (!isCommandActive && !isPreparing) navigatorRef.current?.cancel();
  }, [isCommandActive, isPreparing]);

  // Persisted headings can be in the TOC before their chapter's prose exists
  // in the DOM. Resolve their owner without relying on a rendered block.
  const outlineDestinations = useMemo(() => {
    const destinations = new Map<string, AllChaptersDestination>();
    for (const node of orderedNodes) {
      destinations.set(node.id, { chapterId: node.id });
      for (const heading of outlineByNodeId[node.id] ?? []) {
        destinations.set(heading.id, { chapterId: node.id, blockId: heading.id });
      }
    }
    readRows.forEach((row, index) => {
      if (row.kind !== 'act') return;
      const neighbour = readRows.slice(index + 1).find((item) => item.kind === 'chapter') ??
        readRows.slice(0, index).reverse().find((item) => item.kind === 'chapter');
      destinations.set(actTocId(row.act.id), {
        actId: row.act.id,
        chapterId: neighbour?.kind === 'chapter' ? neighbour.node.id : null,
      });
    });
    return destinations;
  }, [orderedNodes, outlineByNodeId, readRows]);

  // Whole-book Cmd+F. The single-editor find (App.tsx → EditorFindPanel) only
  // searches the one live editor; in 通览全书 that's at most the focused chapter
  // (and nothing when reading). So this view intercepts the same `findInEditor`
  // accelerator in the CAPTURE phase and stops it before App's window-level
  // (bubble) handler runs, opening a panel that searches every chapter's
  // title/summary/prose instead — but never other entities (that's Cmd+Shift+F).
  const [find, setFind] = useState<{ open: boolean; nonce: number }>({ open: false, nonce: 0 });
  const hasChaptersRef = useRef(false);
  useEffect(() => {
    hasChaptersRef.current = orderedNodes.length > 0;
  }, [orderedNodes.length]);
  useEffect(() => {
    if (!isCommandActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!hasChaptersRef.current) return;
      if (!matchesAccelerator(e, useShortcutsStore.getState().bindings.findInEditor)) return;
      e.preventDefault();
      e.stopPropagation();
      setFind((f) => ({ open: true, nonce: f.nonce + 1 }));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isCommandActive]);

  // Chapter snapshot for the find panel: reading order + title/summary; prose is
  // pulled from the content cache (already prefetched per row) on demand.
  const findChapters = useMemo<FindChapter[]>(
    () =>
      orderedNodes.map((n, index) => ({
        nodeId: n.id,
        index,
        title: n.title || '',
        summary: n.summary || '',
      })),
    [orderedNodes],
  );

  useEffect(() => {
    if (!isCommandActive) return;
    const mobileSearchOwner = createMobileAllChaptersSearchOwner({
      chapters: findChapters,
      fetchContent,
      getScrollRoot: () => scrollRef.current,
    });
    const unregister = registerMobilePaperSearchOwner(mobileSearchOwner);
    return () => {
      unregister();
      mobileSearchOwner.destroy?.();
    };
  }, [fetchContent, findChapters, isCommandActive]);

  // Snapshot the saved read-position ONCE at mount, before any effect (the
  // scroll-spy fires on mount and would overwrite the shared map with the
  // top-of-book position before the restore effect could read it).
  const savedPositionRef = useRef<MobileAllChaptersReadPosition | null | undefined>(undefined);
  if (savedPositionRef.current === undefined) {
    savedPositionRef.current =
      readPositionByProject.get(projectId) ?? readMobileAllChaptersPosition(projectId);
  }
  const didRestoreRef = useRef(false);

  // Note: we deliberately do NOT subscribe to nodeUi.selectedId here to
  // scroll on sidebar clicks. The all-chapters view used to be a magnet
  // for outside selections (sidebar / timeline clicks while reading) but
  // that overloaded "click a chapter" with two different meanings
  // depending on context, which the user found confusing. Sidebar /
  // timeline node clicks now always navigate. In-view navigation between
  // chapters lives in the hierarchical TOC below.

  // Scroll-spy: highlight the current reading position in the outline. Unlike a
  // plain chapter highlight this can resolve to a heading id deep inside a
  // chapter — the spy tracks the deepest heading above the reading line so the
  // highlight reaches into the expanded scene/beat/note rows (the panel lights
  // the chapter→…→heading path) instead of stopping at the chapter (L2).
  // Reading the intro before any heading keeps the chapter itself active.
  // Deliberately does NOT push selection to the global ui-store: letting scroll
  // position drive the left sidebar's node panel highlight was confusing —
  // reading through 通览全书 silently moved the selected node, which read as a
  // navigation.
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const activeOutlineIdRef = useRef<string | null>(null);
  const setActiveOutline = useCallback((id: string | null) => {
    if (id === activeOutlineIdRef.current) return;
    activeOutlineIdRef.current = id;
    setActiveOutlineId(id);
  }, []);
  // The chapter (not heading) at the reading line — what the top-bar three-dot
  // menu acts on. Tracked separately from activeOutlineId, which can resolve to
  // a heading deep inside the chapter.
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const activeChapterIdRef = useRef<string | null>(null);
  const setActiveChapter = useCallback((id: string | null) => {
    if (id === activeChapterIdRef.current) return;
    activeChapterIdRef.current = id;
    setActiveChapterId(id);
  }, []);
  // Latest per-chapter outline, read by the spy without re-subscribing the
  // scroll listener every time a chapter publishes its headings.
  const outlineByNodeIdRef = useRef(outlineByNodeId);
  useEffect(() => {
    outlineByNodeIdRef.current = outlineByNodeId;
  }, [outlineByNodeId]);
  // A clicked heading we hold selected until it scrolls out of the viewport.
  const pinnedOutlineRef = useRef<string | null>(null);
  const jumpToOutline = useCallback((id: string) => {
    const destination = outlineDestinations.get(id);
    if (!destination) return false;
    pinnedOutlineRef.current = destination.blockId ?? null;
    setActiveOutline(id);
    if (destination.chapterId) setActiveChapter(destination.chapterId);
    void navigatorRef.current?.navigate(destination);
    return true;
  }, [outlineDestinations, setActiveChapter, setActiveOutline]);
  const handleOutlineClick = useCallback((id: string) => {
    // A deliberate click supersedes a still-pending saved-heading restore.
    didRestoreRef.current = true;
    jumpToOutline(id);
  }, [jumpToOutline]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    let raf = 0;
    const recompute = () => {
      raf = 0;
      // Loading/layout of a TOC destination can emit intermediate scrolls.
      if (navigatorRef.current?.isNavigating()) return;
      const rootRect = root.getBoundingClientRect();
      // A pinned (just-clicked) heading wins while it is still on-screen — this
      // is what lets a click on a heading already fully in view take the
      // highlight, instead of the threshold rule holding a higher heading. Once
      // it leaves the viewport, drop the pin and resume normal tracking.
      // Chapters are never pinned: they're tall, so a pin would freeze heading
      // tracking for the whole chapter.
      const pinned = pinnedOutlineRef.current;
      if (pinned) {
        const el = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(pinned)}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.bottom > rootRect.top && r.top < rootRect.bottom) {
            setActiveOutline(pinned);
            return;
          }
        }
        pinnedOutlineRef.current = null;
      }
      const rows = root.querySelectorAll<HTMLElement>('[data-chapter-id]');
      if (rows.length === 0) return;
      // The chapter "in focus" is the last one whose top is above the reading
      // line (upper third of the viewport).
      const threshold = rootRect.top + rootRect.height * 0.33;
      let chapterId: string | null = null;
      for (const row of Array.from(rows)) {
        if (row.getBoundingClientRect().top <= threshold) chapterId = row.dataset.chapterId || null;
        else break;
      }
      setActiveChapter(chapterId);
      // Within that chapter, the deepest heading above the reading line — the
      // last/closest one — so the highlight extends down into the expanded inner
      // rows. No heading above the line (chapter intro) → the chapter stays active.
      let headingId: string | null = null;
      if (chapterId) {
        let bestDist = Infinity;
        for (const h of outlineByNodeIdRef.current[chapterId] ?? []) {
          const el = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(h.id)}"]`);
          if (!el) continue;
          const top = el.getBoundingClientRect().top;
          if (top <= threshold + 24) {
            const dist = threshold - top;
            if (dist < bestDist) {
              bestDist = dist;
              headingId = h.id;
            }
          }
        }
      }
      setActiveOutline(headingId ?? chapterId);
    };
    const onScroll = () => {
      if (navigatorRef.current?.isNavigating()) return;
      if (raf) return;
      raf = requestAnimationFrame(recompute);
    };
    recompute();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [orderedNodes.length, setActiveOutline, setActiveChapter]);

  // Restore the reader's last position on return to this tab. Runs once, after
  // chapters are available (the empty-state early-return keeps scrollRef
  // unmounted until then). We resolve the anchor by ELEMENT, not raw scrollTop:
  // content-visibility leaves offscreen rows at an estimated height until
  // they're measured, so a saved pixel offset would land in the wrong place,
  // whereas scrolling a known chapter/heading element into view is exact.
  useEffect(() => {
    if (didRestoreRef.current) return;
    if (!isCommandActive && !isPreparing) return;
    if (orderedNodes.length === 0) return; // wait for chapters to load
    const saved = savedPositionRef.current;
    if (!saved) {
      didRestoreRef.current = true;
      return;
    }
    // Re-open the chapter that was being edited (no caret coords → no jump; the
    // row's autoFocus is off, so mounting its editor won't steal scroll).
    if (saved.focusNodeId && orderedNodes.some((n) => n.id === saved.focusNodeId)) {
      setFocus({ nodeId: saved.focusNodeId, caret: null });
    }
    // A saved heading needs the persisted outline to identify its chapter.
    // Leave restoration pending until that metadata is available.
    if (!saved.outlineId || jumpToOutline(saved.outlineId)) didRestoreRef.current = true;
  }, [isCommandActive, isPreparing, orderedNodes, jumpToOutline]);

  // Persist the read-position whenever it changes, so tab close/reopen and the
  // mobile paper lifecycle restore it. The reading anchor comes from the spy;
  // focusNodeId tracks the chapter open for editing.
  useEffect(() => {
    const position: MobileAllChaptersReadPosition = {
      outlineId: activeOutlineId,
      focusNodeId: focus?.nodeId ?? null,
      caretIntent: focus?.nodeId ? 'restore-selection' : null,
    };
    readPositionByProject.set(projectId, position);
    writeMobileAllChaptersPosition(projectId, position);
  }, [projectId, activeOutlineId, focus]);

  // Wire chapter content / title / summary updates back to the data layer.
  // These mirror NodeEditorView's handlers but operate on whichever chapter
  // was edited (the row passes nodeId).
  const handleContentUpdate = useCallback(
    async (
      nodeId: string,
      _pmJson: string,
      _outlineJson: string,
      _nextWordCount: number,
    ) => {
      try {
        const persisted = await getContentByNodeId(nodeId);
        contentCacheRef.current.set(nodeId, persisted ?? null);
      } catch (error) {
        log.error('[AllChapters] materialized content reload failed', nodeId, error);
      }
    },
    [getContentByNodeId],
  );

  const handleTitleUpdate = useCallback(
    async (nodeId: string, title: string) => {
      try {
        await renameNode(nodeId, title);
      } catch (error) {
        log.error('[AllChapters] title update failed', nodeId, error);
      }
    },
    [renameNode],
  );

  const handleSummaryUpdate = useCallback(
    async (nodeId: string, summary: string) => {
      try {
        await updateNodeSummary(nodeId, summary);
      } catch (error) {
        log.error('[AllChapters] summary update failed', nodeId, error);
      }
    },
    [updateNodeSummary],
  );

  const handleEntityClick = useCallback(
    (ref: EntityLinkRef) => openEntityLinkTarget(openEntity, ref),
    [openEntity],
  );

  // The ⁂ menu's "new chapter after" (and the empty-book prompt) inserts a
  // chapter without leaving 通览全书: the new row becomes the live editor —
  // through the same save-then-promote queue as a click — with its title
  // selected, and the TOC navigator brings it to the reading line. The touch
  // shell keeps the decorative ⁂ and its own creation flows.
  const handleInsertAfter = useCallback(
    async (afterNodeId: string | null) => {
      const id = await insertChapter(afterNodeId);
      if (!id) return;
      didRestoreRef.current = true;
      const request = ++promotionRequestRef.current;
      promotionRef.current = promotionRef.current.then(async () => {
        if (focusRef.current) await saveActiveEditor();
        if (request !== promotionRequestRef.current) return;
        const next = { nodeId: id, caret: null };
        focusRef.current = next;
        setFocus(next);
      });
      pinnedOutlineRef.current = null;
      setActiveOutline(id);
      setActiveChapter(id);
      void navigatorRef.current?.navigate({ chapterId: id });
    },
    [insertChapter, setActiveChapter, setActiveOutline],
  );
  const handleSetStatus = useCallback(
    (nodeId: string, writingStatus: ChapterWritingStatus) => {
      void updateNode(nodeId, { writingStatus }).catch((error: unknown) => {
        log.error('[AllChapters] Failed to set writing status', nodeId, error);
      });
    },
    [updateNode],
  );
  const canInsertChapters = !getPlatformRuntime().isMobileShell;
  const renderChapterEnd = useCallback(
    (node: BookNode) =>
      isChapter(node) ? (
        <ChapterEndActions
          projectId={projectId}
          node={node}
          onInsertAfter={handleInsertAfter}
          onSetStatus={handleSetStatus}
        />
      ) : null,
    [handleInsertAfter, handleSetStatus, projectId],
  );

  // The top-bar three-dot menu acts on whichever chapter is at the reading line
  // (falling back to the first chapter before the spy has resolved one). Drift
  // nodes never appear in 通览全书 — orderedNodes is chapters only — so this is
  // always the chapter menu: writing status / edit storylines / delete node.
  const menuTargetNode = useMemo(
    () => orderedNodes.find((n) => n.id === activeChapterId) ?? orderedNodes[0] ?? null,
    [orderedNodes, activeChapterId],
  );
  const mobileActName = useMemo(() => {
    if (!menuTargetNode) return null;
    return (
      deriveActSegments(bookActs, orderedNodes).find((segment) =>
        segment.chapters.some((chapter) => chapter.id === menuTargetNode.id),
      )?.act.name ?? null
    );
  }, [bookActs, menuTargetNode, orderedNodes]);
  useEffect(() => {
    if (!isCommandActive) return;
    publishMobileAllChaptersContext({
      actName: mobileActName,
      chapterId: menuTargetNode?.id ?? null,
      chapterTitle: menuTargetNode?.title || null,
    });
    return () => publishMobileAllChaptersContext(null);
  }, [isCommandActive, menuTargetNode?.id, menuTargetNode?.title, mobileActName]);
  const handleChapterMenuAction = useCallback(
    async (action: string) => {
      const target = menuTargetNode;
      if (!target) return;

      if (action === 'editNodeStorylines' || action === 'threadPicker') {
        setChapterStorylineEditorNodeId(target.id);
        return;
      }

      if (action.startsWith(SET_STATUS_ACTION_PREFIX)) {
        const next = action.slice(SET_STATUS_ACTION_PREFIX.length) as WritingStatus;
        if (!CHAPTER_WRITING_STATUSES.includes(next as never) || next === target.writingStatus) return;
        try {
          await updateNode(target.id, { writingStatus: next });
        } catch (error) {
          log.error('[AllChapters] Failed to set writing status', error);
        }
        return;
      }

      if (action === 'deleteNode') {
        const confirmed = await requestConfirmation(`Delete chapter "${target.title}"?`);
        if (!confirmed) return;
        try {
          await deleteNode(target.id);
          // If the deleted chapter was the live editor, drop the dangling focus.
          setFocus((prev) => (prev?.nodeId === target.id ? null : prev));
        } catch (error) {
          log.error('[AllChapters] Failed to delete chapter', error);
        }
      }
    },
    [menuTargetNode, setChapterStorylineEditorNodeId, updateNode, deleteNode],
  );

  // Whole-book outline → a flat sequence of act dividers (L1) interleaved
  // with chapter rows (L2); each chapter nests its TipTap H1/H2/H3 outline as
  // scene/beat/note (L3-L5). Acts are centred dividers, NOT containers — the
  // chapters that follow an act belong to it visually, the way readRows lays
  // them out. EditorOutlineRail owns dynamic density: render every nested row
  // while it fits, then keep only the active chapter's children, and finally a
  // chapter window with omission handles. No acts → a plain chapter list.
  const outlineItems = useMemo<OutlineEntry[]>(() => {
    const buildChapter = (n: ChapterNode): OutlineEntry => ({
      id: n.id,
      level: 2,
      kind: 'chapter',
      text: n.title || 'Untitled',
      children: nestHeadings(outlineByNodeId[n.id] ?? []),
    });
    const segments = deriveActSegments(bookActs, orderedNodes);
    if (segments.length === 0) {
      return orderedNodes.map(buildChapter);
    }
    const rows: OutlineEntry[] = [];
    const assignedIds = new Set(segments.flatMap((segment) => segment.chapters.map((node) => node.id)));
    for (const node of orderedNodes) {
      if (!assignedIds.has(node.id)) rows.push(buildChapter(node));
    }
    for (const seg of segments) {
      rows.push({ id: actTocId(seg.act.id), level: 1, kind: 'act', text: seg.act.name });
      for (const n of seg.chapters) rows.push(buildChapter(n));
    }
    return rows;
  }, [orderedNodes, outlineByNodeId, bookActs]);

  if (orderedNodes.length === 0) {
    return (
      <div className="editor-shell" style={{ position: 'relative' }}>
        <EditorTopBar editorType="node" />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'hsl(var(--ink-4))',
            fontSize: 14,
          }}
        >
          {t('allChapters.empty.noChapters')}
          {canInsertChapters && (
            <button
              type="button"
              onClick={() => void handleInsertAfter(null)}
              style={{
                marginLeft: 12,
                background: 'transparent',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                color: 'hsl(var(--ink-2))',
              }}
            >
              {t('chapterEnd.firstChapter')}
            </button>
          )}
          <button
            type="button"
            onClick={() => navigateToHome()}
            style={{
              marginLeft: 12,
              background: 'transparent',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
              color: 'hsl(var(--ink-2))',
            }}
          >
            {t('allChapters.actions.backHome')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell" style={{ position: 'relative' }}>
      <EditorTopBar
        editorType="node"
        onMenuAction={handleChapterMenuAction}
        shareTarget={{ projectId, kind: 'book', title: projectName }}
        nodeWritingStatus={menuTargetNode?.writingStatus}
        nodeStatusKind={menuTargetNode ? 'chapter' : undefined}
        menuHeader={
          menuTargetNode
            ? t('allChapters.menuHeader', {
                title: menuTargetNode.title || t('allChapters.untitledChapter'),
              })
            : undefined
        }
        referenceLinkToggle={{
          enabled: entityLinkInteractive,
          onToggle: toggleEntityLinkInteractive,
        }}
      />

      <div className="editor-body">
        <EditorOutlineRail
          title={t('allChapters.outlineTitle')}
          items={outlineItems}
          activeId={activeOutlineId}
          onItemClick={handleOutlineClick}
          emptyHint={t('allChapters.empty.noChaptersShort')}
        />
        <div className="editor-scroll" ref={attachScroll}>
          {readRows.map((row) => {
            if (row.kind === 'act') {
              return (
                <div
                  key={`act-${row.act.id}`}
                  data-act-id={row.act.id}
                  className="act-break"
                >
                  <div className="act-break__num">{toRoman(row.seq)}</div>
                  <div className="act-break__label">{row.act.name}</div>
                  <div className="act-break__meta">
                    {t('storylineEditor.meta.chapters', { count: row.count })}
                    <span className="d">·</span>
                    {row.words == null
                      ? t('common.counting')
                      : t('storylineEditor.meta.kWords', { count: (row.words / 1000).toFixed(1) })}
                  </div>
                </div>
              );
            }
            const { node, idx } = row;
            const primaryId = primaryStorylineByNode[node.id] ?? null;
            const storyline = primaryId ? storylineById.get(primaryId) : undefined;
            return (
              <section
                key={node.id}
                id={anchorId(node.id)}
                style={{
                  scrollMarginTop: 24,
                  borderBottom:
                    idx < orderedNodes.length - 1
                      ? '1px solid hsl(var(--rule))'
                      : 'none',
                }}
              >
                <VirtualChapterRow
                  node={node}
                  projectId={projectId}
                  index={idx}
                  fetchContent={fetchContent}
                  onContentReady={handleContentReady}
                  isNavigationTarget={navigationChapterId === node.id}
                  isFocused={focus?.nodeId === node.id}
                  onActivate={handleActivate}
                  activateCaret={focus?.nodeId === node.id ? focus.caret : null}
                  onContentUpdate={handleContentUpdate}
                  onTitleUpdate={handleTitleUpdate}
                  onSummaryUpdate={handleSummaryUpdate}
                  onEntityClick={handleEntityClick}
                  onOutlineChange={handleOutlineChange}
                  renderEnd={canInsertChapters ? renderChapterEnd : undefined}
                  storylineColor={storyline?.color || undefined}
                  storylineName={storyline?.name || undefined}
                  chapterRoman={toRoman(idx + 1)}
                  resolveEntityLinkColor={resolveEntityLinkColor}
                />
              </section>
            );
          })}
        </div>
        <CommentAnchorHighlights
          scrollEl={scrollEl}
          projectId={projectId}
          targetKind="node"
          targetId={null}
        />
      </div>

      {find.open && (
        <AllChaptersFindPanel
          scrollRef={scrollRef}
          chapters={findChapters}
          fetchContent={fetchContent}
          focusNonce={find.nonce}
          onClose={() => setFind((f) => ({ ...f, open: false }))}
        />
      )}
    </div>
  );
}

// Stable-ish comparison so onOutlineChange doesn't churn state on each
// TipTap mount/unmount cycle when nothing structural changed.
function sameOutline(a: OutlineItem[] | undefined, b: OutlineItem[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].level !== b[i].level || a[i].text !== b[i].text) return false;
  }
  return true;
}
