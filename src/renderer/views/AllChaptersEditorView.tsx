import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookContent } from '../usecase/useBookContent';
import { useBookNode } from '../usecase/useBookNode';
import { useProjectStore } from '../store/project-store';
import { useSettingsStore } from '../store/settings-store';
import { useUiStore } from '../store/ui-store';
import { EditorCrumb, EditorTopBar, SET_STATUS_ACTION_PREFIX } from '../components/editor/EditorTopBar';
import { EditorOutlineRail } from '../components/editor/EditorOutlineRail';
import { nestHeadings, type OutlineEntry } from '../components/editor/outline-rail-model';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { VirtualChapterRow } from '../components/editor/VirtualChapterRow';
import { AllChaptersFindPanel, type FindChapter } from '../components/search/AllChaptersFindPanel';
import { useShortcutsStore } from '../store/shortcuts-store';
import { matchesAccelerator } from '../lib/shortcuts';
import { isChapter, CHAPTER_WRITING_STATUSES, type ChapterNode, type WritingStatus } from '../domain/book-node';
import { enqueueShadowReview } from '../lib/shadow/job-recorder';
import { deriveActSegments, type BookAct } from '../domain/book-act';
import type { NodeContent } from '../domain/node-content';
import type { EntityLinkRef } from '../lib/extensions/entity-link';
import type { OutlineItem } from '../lib/outline';
import { parseOutline } from '../lib/outline';
import { countWordsInPmJson } from '../lib/word-count';
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

// Where the reader was in 通览全书, kept in module scope so it survives the
// view unmounting on a tab switch (this view is torn down when you leave the
// tab, not just hidden). Keyed by project. Restored on return.
interface AllChaptersReadPosition {
  // The scroll-spy's active outline id: a chapter nodeId, or a heading
  // block-id deeper inside a chapter. Null = top of book (nothing passed the
  // reading line yet).
  outlineId: string | null;
  // The chapter that was promoted to a live editor, if any.
  focusNodeId: string | null;
}
const readPositionByProject = new Map<string, AllChaptersReadPosition>();

// "Read the whole book" mode — every chapter in bookOrder concatenated into
// one vertical scroller. Each chapter is a full ChapterEditor instance
// (matching NodeEditorView's literary page styling) but mounted lazily via
// IntersectionObserver so 100+ chapter books stay responsive.
//
// Sidebar / timeline chapter clicks land here as scrolls instead of route
// changes: useProjectNavigation.openEntity and EditorShell's nav effect both
// detect `view === 'all-chapters-editor'` and update nodeUi.selectedId in
// place. This view watches that selection and scrolls to the matching row.
export function AllChaptersEditorView() {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, navigateToHome, navigateToStoryline, navigateToElement, navigateToNode, navigateToCategory } =
    useProjectNavigation();
  if (!projectId) throw new Error('AllChaptersEditorView requires a projectId');
  if (!userId) throw new Error('AllChaptersEditorView requires a logged-in user');

  const {
    bookNodes,
    storylines,
    primaryStorylineByNode,
    bookElements,
    bookElementCategories,
    driftGroups,
  } = useDataStore();
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

  const { getContentByNodeId, updateContentByNodeId, createContent, getOutlineByNodeId } =
    useBookContent({
      userId,
      projectId,
    });
  const { renameNode, updateNodeSummary, updateNode, deleteNode } = useBookNode({ projectId, userId });
  const setChapterStorylineEditorNodeId = useUiStore((s) => s.setChapterStorylineEditorNodeId);

  // Stable per-node content cache so repeat fetches (after unmount/remount)
  // skip another roundtrip. Tracked by nodeId; null means "fetched, no row".
  const contentCacheRef = useRef<Map<string, NodeContent | null>>(new Map());
  const fetchContent = useCallback(
    async (nodeId: string): Promise<NodeContent | null> => {
      const cached = contentCacheRef.current.get(nodeId);
      if (cached !== undefined) return cached;
      try {
        const c = await getContentByNodeId(nodeId);
        contentCacheRef.current.set(nodeId, c ?? null);
        return c ?? null;
      } catch (error) {
        log.error('[AllChapters] fetch content failed', nodeId, error);
        return null;
      }
    },
    [getContentByNodeId],
  );

  // The one chapter the user is actively editing. Only that row mounts a live
  // ChapterEditor; every other row renders cheap static prose at its real
  // height. `caret` carries the click point that promoted it, so the editor can
  // drop the cursor where the user pressed. Null = nothing focused (pure
  // read-through).
  const [focus, setFocus] = useState<{ nodeId: string; caret: { clientX: number; clientY: number } | null } | null>(null);
  const handleActivate = useCallback(
    (nodeId: string, coords: { clientX: number; clientY: number }) => {
      setFocus({ nodeId, caret: coords });
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

  const totalWordCount = useMemo(
    () => orderedNodes.reduce((sum, n) => sum + (n.wordCount || 0), 0),
    [orderedNodes],
  );

  // Interleave act dividers into the read-through. Chapter indices keep
  // counting straight through (the Roman numeral sequence ignores acts);
  // empty acts still render their divider — a planned 幕 with no chapters
  // is a deliberate authoring signal, not a data glitch. No acts → plain
  // chapter list, zero overhead.
  type ReadRow =
    | { kind: 'act'; act: BookAct; seq: number; count: number; words: number }
    | { kind: 'chapter'; node: ChapterNode; idx: number };
  const readRows = useMemo<ReadRow[]>(() => {
    const segments = deriveActSegments(bookActs, orderedNodes);
    if (segments.length === 0) {
      return orderedNodes.map((node, idx) => ({ kind: 'chapter' as const, node, idx }));
    }
    const rows: ReadRow[] = [];
    let idx = 0;
    segments.forEach((seg, segIdx) => {
      rows.push({
        kind: 'act',
        act: seg.act,
        seq: segIdx + 1,
        count: seg.chapters.length,
        words: seg.chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0),
      });
      for (const node of seg.chapters) {
        rows.push({ kind: 'chapter', node, idx });
        idx += 1;
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
  useEffect(() => {
    const toFetch = orderedNodes.filter((n) => !prefetchedOutlineRef.current.has(n.id));
    if (toFetch.length === 0) return;
    toFetch.forEach((n) => prefetchedOutlineRef.current.add(n.id));
    void (async () => {
      const buffered: Record<string, OutlineItem[]> = {};
      await Promise.all(
        toFetch.map(async (n) => {
          try {
            const json = await getOutlineByNodeId(n.id);
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
  }, [orderedNodes, getOutlineByNodeId]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    const onKey = (e: KeyboardEvent) => {
      if (!hasChaptersRef.current) return;
      if (!matchesAccelerator(e, useShortcutsStore.getState().bindings.findInEditor)) return;
      e.preventDefault();
      e.stopPropagation();
      setFind((f) => ({ open: true, nonce: f.nonce + 1 }));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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

  // Snapshot the saved read-position ONCE at mount, before any effect (the
  // scroll-spy fires on mount and would overwrite the shared map with the
  // top-of-book position before the restore effect could read it).
  const savedPositionRef = useRef<AllChaptersReadPosition | null | undefined>(undefined);
  if (savedPositionRef.current === undefined) {
    savedPositionRef.current = readPositionByProject.get(projectId) ?? null;
  }
  const didRestoreRef = useRef(false);

  // Programmatic-scroll guard for the outline. A TOC click triggers a smooth
  // scrollIntoView that emits a stream of scroll events as it animates; if the
  // scroll-spy reacted to each frame, the active row would race down the whole
  // outline before landing on the target. So a TOC click suppresses the spy for
  // the duration of the jump — re-armed on every scroll event, released once the
  // scroll goes idle, then re-synced. The click also lights the target up front
  // (and, for headings, pins it via pinnedOutlineRef until it scrolls away).
  const spySuppressedRef = useRef(false);
  const spyIdleTimerRef = useRef<number | null>(null);
  const armSpySuppression = useCallback(() => {
    spySuppressedRef.current = true;
    if (spyIdleTimerRef.current != null) window.clearTimeout(spyIdleTimerRef.current);
    // Safety ceiling: a jump whose target is already in place emits no scroll
    // events, so the scroll-driven idle release (in the spy effect) would never
    // fire. Release on a hard timeout too — the up-front setActiveOutline has
    // already lit the target, and the heading pin engages on the next scroll.
    spyIdleTimerRef.current = window.setTimeout(() => {
      spyIdleTimerRef.current = null;
      spySuppressedRef.current = false;
    }, 900);
  }, []);

  const scrollToNodeId = useCallback((nodeId: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector(`[data-chapter-id="${CSS.escape(nodeId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const scrollToActId = useCallback((actId: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector(`[data-act-id="${CSS.escape(actId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    let raf = 0;
    const recompute = () => {
      raf = 0;
      // A TOC click is driving a smooth scroll right now: ignore the transient
      // frames (see armSpySuppression) so the highlight doesn't race.
      if (spySuppressedRef.current) return;
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
      // While a programmatic jump is in flight every scroll frame just bumps the
      // idle timer; once the animation stops emitting events the spy is released
      // and re-synced (which also engages the heading pin set by the click).
      // This is what keeps the destination from flickering open/shut.
      if (spySuppressedRef.current) {
        if (spyIdleTimerRef.current != null) window.clearTimeout(spyIdleTimerRef.current);
        spyIdleTimerRef.current = window.setTimeout(() => {
          spyIdleTimerRef.current = null;
          spySuppressedRef.current = false;
          recompute();
        }, 140);
        return;
      }
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
    if (orderedNodes.length === 0) return; // wait for chapters to load
    didRestoreRef.current = true;
    const saved = savedPositionRef.current;
    if (!saved) return;
    // Re-open the chapter that was being edited (no caret coords → no jump; the
    // row's autoFocus is off, so mounting its editor won't steal scroll).
    if (saved.focusNodeId && orderedNodes.some((n) => n.id === saved.focusNodeId)) {
      setFocus({ nodeId: saved.focusNodeId, caret: null });
    }
    const anchor = saved.outlineId;
    if (!anchor) return;
    // A heading anchor only exists once its chapter's prose has rendered, which
    // is async; chapter rows render immediately. Retry over a bounded window
    // until the element appears, then jump instantly (no smooth animation).
    let frame = 0;
    const restore = () => {
      const root = scrollRef.current;
      if (!root) return;
      const el =
        root.querySelector<HTMLElement>(`[data-chapter-id="${CSS.escape(anchor)}"]`) ??
        root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchor)}"]`);
      if (el) {
        armSpySuppression();
        setActiveOutline(anchor);
        el.scrollIntoView({ block: 'start' });
        return;
      }
      if (frame++ < 180) requestAnimationFrame(restore); // ~3s ceiling
    };
    requestAnimationFrame(restore);
  }, [orderedNodes, armSpySuppression, setActiveOutline]);

  // Persist the read-position whenever it changes, so the next tab switch (which
  // unmounts this view) restores it. The reading anchor comes from the spy
  // (updates as you scroll); focusNodeId tracks the chapter open for editing.
  useEffect(() => {
    readPositionByProject.set(projectId, {
      outlineId: activeOutlineId,
      focusNodeId: focus?.nodeId ?? null,
    });
  }, [projectId, activeOutlineId, focus]);

  // Wire chapter content / title / summary updates back to the data layer.
  // These mirror NodeEditorView's handlers but operate on whichever chapter
  // was edited (the row passes nodeId).
  const handleContentUpdate = useCallback(
    async (
      nodeId: string,
      pmJson: string,
      outlineJson: string,
      nextWordCount: number,
    ) => {
      try {
        const existing = await getContentByNodeId(nodeId);
        if (existing) {
          const updated = await updateContentByNodeId(nodeId, {
            contentJson: pmJson,
            outlineJson,
          });
          contentCacheRef.current.set(nodeId, updated ?? null);
        } else {
          const created = await createContent(nodeId, { contentJson: pmJson, outlineJson });
          contentCacheRef.current.set(nodeId, created ?? null);
        }
        const current = useDataStore.getState().bookNodes.find((n) => n.id === nodeId);
        if (current && current.wordCount !== nextWordCount) {
          await updateNode(nodeId, { wordCount: nextWordCount });
        }
      } catch (error) {
        log.error('[AllChapters] content update failed', nodeId, error);
      }
    },
    [getContentByNodeId, updateContentByNodeId, createContent, updateNode],
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
    (ref: EntityLinkRef) => {
      if (ref.targetKind === 'element') navigateToElement(ref.targetId);
      else if (ref.targetKind === 'node') navigateToNode(ref.targetId);
      else if (ref.targetKind === 'storyline') navigateToStoryline(ref.targetId);
      else if (ref.targetKind === 'category') navigateToCategory(ref.targetId);
    },
    [navigateToCategory, navigateToElement, navigateToNode, navigateToStoryline],
  );

  // One-shot backfill of wordCount when content is loaded for a chapter that
  // still has wordCount=0 but non-empty stored prose. Mirrors the logic in
  // NodeEditorView so the same legacy data heals here too. We piggyback on
  // the cache: once content lands, opportunistically check.
  useEffect(() => {
    const cache = contentCacheRef.current;
    const id = setInterval(() => {
      const nodes = useDataStore.getState().bookNodes;
      for (const node of nodes) {
        if (node.wordCount > 0) continue;
        const c = cache.get(node.id);
        if (!c) continue;
        const computed = countWordsInPmJson(c.contentJson);
        if (computed > 0) {
          void updateNode(node.id, { wordCount: computed }).catch((error) => {
            log.warn('[AllChapters] wordCount backfill failed', node.id, error);
          });
        }
      }
    }, 4000);
    return () => clearInterval(id);
  }, [updateNode]);

  // The top-bar three-dot menu acts on whichever chapter is at the reading line
  // (falling back to the first chapter before the spy has resolved one). Drift
  // nodes never appear in 通览全书 — orderedNodes is chapters only — so this is
  // always the chapter menu: writing status / edit storylines / delete node.
  const menuTargetNode = useMemo(
    () => orderedNodes.find((n) => n.id === activeChapterId) ?? orderedNodes[0] ?? null,
    [orderedNodes, activeChapterId],
  );
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
          // Mirror NodeEditorView: marking a chapter 'finished' optionally runs
          // it through shadow review first (gated by shadowAutoRun) — lock it to
          // waiting_review + enqueue; otherwise set the status directly.
          const autoReviewOnFinish = useSettingsStore.getState().shadowAutoRun;
          if (next === 'finished' && autoReviewOnFinish) {
            await updateNode(target.id, { writingStatus: 'waiting_review' });
            await enqueueShadowReview(target.id, projectId);
          } else {
            await updateNode(target.id, { writingStatus: next });
          }
        } catch (error) {
          log.error('[AllChapters] Failed to set writing status', error);
        }
        return;
      }

      if (action === 'deleteNode') {
        const confirmed = window.confirm(`Delete chapter "${target.title}"?`);
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
    [menuTargetNode, setChapterStorylineEditorNodeId, updateNode, deleteNode, projectId],
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
    for (const seg of segments) {
      rows.push({ id: actTocId(seg.act.id), level: 1, kind: 'act', text: seg.act.name });
      for (const n of seg.chapters) rows.push(buildChapter(n));
    }
    return rows;
  }, [orderedNodes, outlineByNodeId, bookActs]);

  // TOC click dispatcher: top-level entries scroll to the chapter section;
  // nested entries are TipTap heading anchors — scope to this view's scroll
  // container so a parallel split pane isn't accidentally scrolled.
  const orderedNodeIds = useMemo(() => new Set(orderedNodes.map((n) => n.id)), [orderedNodes]);
  const handleOutlineClick = useCallback(
    (id: string) => {
      if (id.startsWith(ACT_TOC_PREFIX)) {
        pinnedOutlineRef.current = null;
        armSpySuppression(); // act jump: let the spy re-sync once it settles
        scrollToActId(id.slice(ACT_TOC_PREFIX.length));
      } else if (orderedNodeIds.has(id)) {
        // Chapter jump: light it up front so it lands directly instead of racing
        // down the outline; don't pin — heading tracking takes over as the
        // reader scrolls into the chapter.
        pinnedOutlineRef.current = null;
        armSpySuppression();
        setActiveOutline(id);
        scrollToNodeId(id);
      } else {
        // Heading jump: pin it so the clicked row stays selected until it
        // scrolls out of view, even if its section was already fully on-screen.
        pinnedOutlineRef.current = id;
        armSpySuppression();
        setActiveOutline(id);
        scrollToOutlineAnchor(id, scrollRef.current);
      }
    },
    [orderedNodeIds, scrollToNodeId, scrollToActId, armSpySuppression, setActiveOutline],
  );

  if (orderedNodes.length === 0) {
    return (
      <div className="editor-shell" style={{ position: 'relative' }}>
        <EditorTopBar editorType="node">
          <EditorCrumb>
            <span>{projectName}</span>
          </EditorCrumb>
          <EditorCrumb>
            <span className="editor-crumb-title">{t('allChapters.title')}</span>
          </EditorCrumb>
        </EditorTopBar>
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
        right={
          <>
            <span>{t('storylineEditor.meta.chapters', { count: orderedNodes.length })}</span>
            <span className="editor-bar__sep">·</span>
            <span>{t('storylineEditor.meta.kWords', { count: (totalWordCount / 1000).toFixed(1) })}</span>
            {menuTargetNode && (
              // The chapter at the reading line — what the three-dot menu acts
              // on. Updates as you scroll.
              <>
                <span className="editor-bar__sep">·</span>
                <span>
                  {t('allChapters.currentAt', {
                    title: menuTargetNode.title || t('allChapters.untitledChapter'),
                  })}
                </span>
              </>
            )}
          </>
        }
      >
        <EditorCrumb>
          <span>{projectName}</span>
        </EditorCrumb>
        <EditorCrumb>
          <span className="editor-crumb-title">{t('allChapters.title')}</span>
        </EditorCrumb>
      </EditorTopBar>

      <div className="editor-body">
        <EditorOutlineRail
          title={t('allChapters.outlineTitle')}
          items={outlineItems}
          activeId={activeOutlineId}
          onItemClick={handleOutlineClick}
          emptyHint={t('allChapters.empty.noChaptersShort')}
        />
        <div className="editor-scroll" ref={scrollRef}>
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
                    {t('storylineEditor.meta.chapters', { count: row.count })}<span className="d">·</span>
                    {t('storylineEditor.meta.kWords', { count: (row.words / 1000).toFixed(1) })}
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
                  isFocused={focus?.nodeId === node.id}
                  onActivate={handleActivate}
                  activateCaret={focus?.nodeId === node.id ? focus.caret : null}
                  onContentUpdate={handleContentUpdate}
                  onTitleUpdate={handleTitleUpdate}
                  onSummaryUpdate={handleSummaryUpdate}
                  onEntityClick={handleEntityClick}
                  onOutlineChange={handleOutlineChange}
                  storylineColor={storyline?.color || undefined}
                  storylineName={storyline?.name || undefined}
                  chapterRoman={toRoman(idx + 1)}
                  resolveEntityLinkColor={resolveEntityLinkColor}
                />
              </section>
            );
          })}
        </div>
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
