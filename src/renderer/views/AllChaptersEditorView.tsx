import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookContent } from '../usecase/useBookContent';
import { useBookNode } from '../usecase/useBookNode';
import { useProjectStore } from '../store/project-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { EditorOutlinePanel, nestHeadings, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { VirtualChapterRow } from '../components/editor/VirtualChapterRow';
import { isChapter, type ChapterNode } from '../domain/book-node';
import { deriveActSegments, type BookAct } from '../domain/book-act';
import type { NodeContent } from '../domain/node-content';
import type { EntityLinkRef } from '../lib/extensions/entity-link';
import type { OutlineItem } from '../lib/outline';
import { parseOutline } from '../lib/outline';
import { countWordsInPmJson } from '../lib/word-count';

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
  const userId = useAuthStore((s) => s.user?.id);
  const { projectId, navigateToHome, navigateToStoryline, navigateToElement, navigateToNode, navigateToCategory } =
    useProjectNavigation();
  if (!projectId) throw new Error('AllChaptersEditorView requires a projectId');
  if (!userId) throw new Error('AllChaptersEditorView requires a logged-in user');

  const { bookNodes, storylines, primaryStorylineByNode } = useDataStore();
  const bookActs = useDataStore((s) => s.bookActs);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const projectName = currentProject?.name || projects.find((p) => p.id === projectId)?.name || 'Untitled';

  const { getContentByNodeId, updateContentByNodeId, createContent, getOutlineByNodeId } =
    useBookContent({
      userId,
      projectId,
    });
  const { renameNode, updateNodeSummary, updateNode } = useBookNode({ projectId, userId });

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

  // Last-measured height per chapter, reused when a row unmounts so the
  // placeholder doesn't snap back to the wordCount estimate.
  const [heightCache, setHeightCache] = useState<Record<string, number>>({});
  const handleHeightMeasured = useCallback((nodeId: string, height: number) => {
    setHeightCache((prev) => {
      const existing = prev[nodeId];
      // Only update on meaningful diffs to avoid render churn on sub-pixel
      // measurement noise (ResizeObserver fires on every layout pass).
      if (existing && Math.abs(existing - height) < 4) return prev;
      return { ...prev, [nodeId]: height };
    });
  }, []);

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
    | { kind: 'act'; act: BookAct; count: number; words: number }
    | { kind: 'chapter'; node: ChapterNode; idx: number };
  const readRows = useMemo<ReadRow[]>(() => {
    const segments = deriveActSegments(bookActs, orderedNodes);
    if (segments.length === 0) {
      return orderedNodes.map((node, idx) => ({ kind: 'chapter' as const, node, idx }));
    }
    const rows: ReadRow[] = [];
    let idx = 0;
    for (const seg of segments) {
      rows.push({
        kind: 'act',
        act: seg.act,
        count: seg.chapters.length,
        words: seg.chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0),
      });
      for (const node of seg.chapters) {
        rows.push({ kind: 'chapter', node, idx });
        idx += 1;
      }
    }
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

  // Scroll-spy: highlight the chapter whose top edge is just above the
  // viewport's top (i.e. "current reading position"). Updates the outline
  // active row only — deliberately does NOT push selection to the global
  // ui-store. Letting scroll position drive the left sidebar's node panel
  // highlight was confusing: reading through 通览全书 silently moved the
  // selected node in the sidebar, which made it look like a navigation.
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;

    let raf = 0;
    const recompute = () => {
      raf = 0;
      const rows = root.querySelectorAll<HTMLElement>('[data-chapter-id]');
      if (rows.length === 0) return;
      // The chapter "in focus" is the last one whose top is above the
      // viewport's top by less than the viewport height — i.e. the chapter
      // currently occupying the upper third of the screen.
      const rootRect = root.getBoundingClientRect();
      const threshold = rootRect.top + rootRect.height * 0.33;
      let candidateId: string | null = null;
      for (const row of Array.from(rows)) {
        const rect = row.getBoundingClientRect();
        if (rect.top <= threshold) candidateId = row.dataset.chapterId || null;
        else break;
      }
      if (candidateId !== activeNodeId) {
        setActiveNodeId(candidateId);
      }
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(recompute);
    };
    recompute();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [activeNodeId, orderedNodes.length]);

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

  // Whole-book outline → a flat sequence of act dividers (L1) interleaved
  // with chapter rows (L2); each chapter nests its TipTap H1/H2/H3 outline as
  // scene/beat/note (L3-L5). Acts are centred dividers, NOT containers — the
  // chapters that follow an act belong to it visually, the way readRows lays
  // them out. Expansion is owned by EditorOutlinePanel (autoCollapseInactive),
  // so only the chapter you're reading expands its subtree. No acts → a plain
  // chapter list (matching readRows' no-act path).
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
        scrollToActId(id.slice(ACT_TOC_PREFIX.length));
      } else if (orderedNodeIds.has(id)) {
        scrollToNodeId(id);
      } else {
        scrollToOutlineAnchor(id, scrollRef.current);
      }
    },
    [orderedNodeIds, scrollToNodeId, scrollToActId],
  );

  if (orderedNodes.length === 0) {
    return (
      <div className="editor-shell" style={{ position: 'relative' }}>
        <EditorTopBar editorType="node">
          <EditorCrumb>
            <span>{projectName}</span>
          </EditorCrumb>
          <EditorCrumb>
            <span className="editor-crumb-title">通览全书</span>
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
          本项目尚无章节。
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
            回到首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell" style={{ position: 'relative' }}>
      <EditorTopBar
        editorType="node"
        right={
          <>
            <span>{orderedNodes.length} 章</span>
            <span className="editor-bar__sep">·</span>
            <span>{(totalWordCount / 1000).toFixed(1)}k 字</span>
          </>
        }
      >
        <EditorCrumb>
          <span>{projectName}</span>
        </EditorCrumb>
        <EditorCrumb>
          <span className="editor-crumb-title">通览全书</span>
        </EditorCrumb>
      </EditorTopBar>

      <div className="editor-body">
        <EditorOutlinePanel
          title="通览全书 · OUTLINE"
          items={outlineItems}
          activeId={activeNodeId}
          onItemClick={handleOutlineClick}
          autoCollapseInactive
          emptyHint="— 尚无章节 —"
        />
        <div className="editor-scroll" ref={scrollRef}>
          {readRows.map((row) => {
            if (row.kind === 'act') {
              const tint = row.act.color || 'hsl(var(--ink-4))';
              return (
                <div
                  key={`act-${row.act.id}`}
                  data-act-id={row.act.id}
                  style={{
                    padding: '52px 24px 28px',
                    textAlign: 'center',
                    borderBottom: '1px solid hsl(var(--rule))',
                    scrollMarginTop: 24,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 2,
                      margin: '0 auto 14px',
                      background: tint,
                      opacity: 0.7,
                    }}
                  />
                  <div
                    style={{
                      fontSize: 17,
                      fontWeight: 600,
                      letterSpacing: '0.12em',
                      color: 'hsl(var(--ink-1))',
                    }}
                  >
                    {row.act.name}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'hsl(var(--ink-4))',
                    }}
                  >
                    {row.count} 章 · {(row.words / 1000).toFixed(1)}k 字
                  </div>
                  {row.act.summary && (
                    <div
                      style={{
                        margin: '10px auto 0',
                        maxWidth: 480,
                        fontSize: 12.5,
                        lineHeight: 1.7,
                        color: 'hsl(var(--ink-3))',
                      }}
                    >
                      {row.act.summary}
                    </div>
                  )}
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
                  onContentUpdate={handleContentUpdate}
                  onTitleUpdate={handleTitleUpdate}
                  onSummaryUpdate={handleSummaryUpdate}
                  onEntityClick={handleEntityClick}
                  onHeightMeasured={handleHeightMeasured}
                  onOutlineChange={handleOutlineChange}
                  cachedHeight={heightCache[node.id]}
                  storylineColor={storyline?.color || undefined}
                  storylineName={storyline?.name || undefined}
                  chapterRoman={toRoman(idx + 1)}
                />
              </section>
            );
          })}
        </div>
      </div>
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
