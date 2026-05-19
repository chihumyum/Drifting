import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import loglevel from 'loglevel';

import { useAuthStore } from '../store/auth';
import { useDataStore } from '../store/data-store';
import { useUiStore } from '../store/ui-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useBookContent } from '../usecase/useBookContent';
import { useBookNode } from '../usecase/useBookNode';
import { useProjectStore } from '../store/project-store';
import { EditorCrumb, EditorTopBar } from '../components/editor/EditorTopBar';
import { EditorOutlinePanel, type OutlineEntry } from '../components/editor/EditorOutlinePanel';
import { scrollToOutlineAnchor } from '../components/editor/outline-scroll';
import { VirtualChapterRow } from '../components/editor/VirtualChapterRow';
import type { BookNode } from '../domain/book-node';
import type { NodeContent } from '../domain/node-content';
import type { EntityLinkRef } from '../lib/extensions/entity-link';
import type { OutlineItem } from '../lib/outline';
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

  const { bookNodes, storylines } = useDataStore();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const projectName = currentProject?.name || projects.find((p) => p.id === projectId)?.name || 'Untitled';

  const { getContentByNodeId, updateContentByNodeId, createContent } = useBookContent({
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

  const orderedNodes = useMemo<BookNode[]>(
    () => [...bookNodes].sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );

  const totalWordCount = useMemo(
    () => orderedNodes.reduce((sum, n) => sum + (n.wordCount || 0), 0),
    [orderedNodes],
  );

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

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const scrollToNodeId = useCallback((nodeId: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector(`[data-chapter-id="${CSS.escape(nodeId)}"]`);
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
  // active row + the active rail on the chapter card. Throttled via rAF.
  const setNodeSelection = useUiStore((s) => s.setNodeSelection);
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
        // Update the scroll-position selection silently (source: 'system')
        // so other UI (left rail highlight) reflects it without retriggering
        // the scroll effect above.
        if (candidateId) setNodeSelection(candidateId, 'system');
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
  }, [activeNodeId, setNodeSelection, orderedNodes.length]);

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

  // Hierarchical outline: each chapter is a top-level entry; its TipTap
  // body's H1/H2/H3 outline nests under it. Chapters are collapsed by
  // default. The scroll-spy-focused chapter is auto-expanded, but the
  // user can override that per-chapter via the chevron.
  //
  // We store the manual override only — if the user toggled an entry, the
  // map remembers that boolean; otherwise the entry falls back to the
  // default ("expanded iff this is the currently scrolled-to chapter").
  // Derived state instead of an effect-driven set so the active chapter
  // change cascades to the outline naturally without an extra render.
  const [manualExpand, setManualExpand] = useState<Map<string, boolean>>(new Map());
  const isChapterExpanded = useCallback(
    (nodeId: string): boolean => {
      if (manualExpand.has(nodeId)) return manualExpand.get(nodeId)!;
      return nodeId === activeNodeId;
    },
    [manualExpand, activeNodeId],
  );
  const toggleExpand = useCallback(
    (id: string) => {
      setManualExpand((prev) => {
        const current = prev.has(id) ? prev.get(id)! : id === activeNodeId;
        const next = new Map(prev);
        next.set(id, !current);
        return next;
      });
    },
    [activeNodeId],
  );

  // Map orderedNodes → outline entries. Chapter-row id is the bare nodeId
  // (so toggleExpand can use it directly); nested heading ids are TipTap
  // block-ids straight from `outlineByNodeId`.
  const outlineItems = useMemo<OutlineEntry[]>(
    () =>
      orderedNodes.map((n, idx) => {
        const headings = outlineByNodeId[n.id] ?? [];
        return {
          id: n.id,
          level: 2,
          num: toRoman(idx + 1),
          text: n.title || 'Untitled',
          isExpanded: isChapterExpanded(n.id),
          children: headings.map((h) => ({ id: h.id, level: h.level, text: h.text })),
        };
      }),
    [orderedNodes, outlineByNodeId, isChapterExpanded],
  );

  // TOC click dispatcher: top-level entries scroll to the chapter section;
  // nested entries are TipTap heading anchors — scope to this view's scroll
  // container so a parallel split pane isn't accidentally scrolled.
  const orderedNodeIds = useMemo(() => new Set(orderedNodes.map((n) => n.id)), [orderedNodes]);
  const handleOutlineClick = useCallback(
    (id: string) => {
      if (orderedNodeIds.has(id)) {
        scrollToNodeId(id);
      } else {
        scrollToOutlineAnchor(id, scrollRef.current);
      }
    },
    [orderedNodeIds, scrollToNodeId],
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
          onToggleExpand={toggleExpand}
          footLeft={`${orderedNodes.length} 章`}
          footRight={`${(totalWordCount / 1000).toFixed(1)}k 字`}
          emptyHint="— 尚无章节 —"
        />
        <div className="editor-scroll" ref={scrollRef}>
          {orderedNodes.map((node, idx) => {
            const storyline = node.mainStorylineId ? storylineById.get(node.mainStorylineId) : undefined;
            const isActive = node.id === activeNodeId;
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
                  isActive={isActive}
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
