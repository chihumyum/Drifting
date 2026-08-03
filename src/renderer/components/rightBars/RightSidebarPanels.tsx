import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../store/data-store';
import { isDrift, isChapter, deriveStatus, type DerivedStatus } from '../../domain/book-node';
import { deriveActSegments, type BookAct } from '../../domain/book-act';
import { useWritingStatsStore } from '../../store/writing-stats-store';
import { getChapterContentJson } from '../../lib/agent/chapter-prose';
import { computeProseStats, type ProseStats } from '../../lib/prose-stats';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import { ReferencesPanel } from '../editor/ReferencesPanel';
import { getWritingStatusLabel } from '../editor/EditorTopBar';
import { events } from '../../lib/events';
import type { ProseEntityType } from '../../lib/yjs-doc-id';
import { useUiStore, useProjectTabs, focusedLeafOf, tabKey } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { RightSidebarHeader } from './RightSidebarHeader';
import { LibraryPanel, type FocusedEntity } from './MemoMaterialPanel';
import { TodoPanel } from './TodoPanel';
import { CompanionPanel } from '../agent/CompanionPanel';
import { ShadowPanel } from './ShadowPanel';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { EmptyState } from '../ui/EmptyState';

interface ResolvedTarget {
  kind: 'chapter' | 'storyline' | 'element' | 'category' | 'drift' | 'all-chapters' | 'none';
  id: string | null;
  title: string;
  kicker: string;
  color?: string;
}

export function RightSidebarPanels() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const { activeTabKey, openTabs } = useProjectTabs(projectId);
  const rightPanelGroup = useUiStore((s) => s.rightPanelGroup);
  const activeRightPanel = useUiStore((s) => s.activeRightPanel);
  const activeAgentPanel = useUiStore((s) => s.activeAgentPanel);
  const splitRatio = useUiStore((s) => s.rightPanelSplitRatio);
  const setSplitRatio = useUiStore((s) => s.setRightPanelSplitRatio);

  const {
    bookNodes,
    bookActs,
    bookElements,
    storylines,
    bookElementCategories,
    storylineNodeMapping,
    primaryStorylineByNode,
  } = useDataStore();

  // Decode the active tab into a resolved target so the right panel can show
  // entity-specific context. Falls back to "no target" on the project home.
  const target = useMemo<ResolvedTarget>(() => {
    // Per the focused-only selection model, the right sidebar tracks the
    // focused side of the active tab regardless of whether it's a single
    // leaf or a split. The non-focused half of a split doesn't reflect here.
    const activeTab = openTabs.find((t) => tabKey(t) === activeTabKey);
    if (!activeTab) {
      return { kind: 'none', id: null, title: '—', kicker: t('rightSidebar.kickers.noTab') };
    }
    const leaf = focusedLeafOf(activeTab);
    if (leaf.entityType === 'dashboard') {
      return {
        kind: 'none',
        id: null,
        title: t('rightSidebar.targets.dashboard'),
        kicker: t('rightSidebar.kickers.dashboard'),
      };
    }
    if (leaf.entityType === 'all-chapters') {
      // kicker only surfaces in the stats tab (library/todo use hardcoded
      // project-wide kickers), so phrase it for the aggregate stats view.
      return {
        kind: 'all-chapters',
        id: null,
        title: t('rightSidebar.targets.allChapters'),
        kicker: t('rightSidebar.kickers.allChapters'),
      };
    }
    if (leaf.entityType === 'node') {
      const node = bookNodes.find((n) => n.id === leaf.id);
      if (!node) return { kind: 'none', id: leaf.id, title: '—', kicker: '—' };
      const drift = isDrift(node);
      const primaryId = primaryStorylineByNode[node.id] ?? null;
      const storyline = primaryId ? storylines.find((s) => s.id === primaryId) : undefined;
      return {
        kind: drift ? 'drift' : 'chapter',
        id: node.id,
        title:
          node.title ||
          (drift ? t('topTimeline.untitled.drift') : t('topTimeline.untitled.chapter')),
        kicker: drift
          ? t('rightSidebar.kickers.driftContent')
          : t('rightSidebar.kickers.chapterContent'),
        color: storyline?.color,
      };
    }
    if (leaf.entityType === 'storyline') {
      const s = storylines.find((sl) => sl.id === leaf.id);
      return {
        kind: 'storyline',
        id: leaf.id,
        title: s?.name || t('topTimeline.untitled.storyline'),
        kicker: t('rightSidebar.kickers.storylineContent'),
        color: s?.color,
      };
    }
    if (leaf.entityType === 'element') {
      const e = bookElements.find((el) => el.id === leaf.id);
      const cat = e ? bookElementCategories.find((c) => c.id === e.categoryId) : undefined;
      return {
        kind: 'element',
        id: leaf.id,
        title: e?.name || t('topTimeline.untitled.element'),
        kicker: t('rightSidebar.kickers.elementContent'),
        color: cat?.color,
      };
    }
    if (leaf.entityType === 'category') {
      const c = bookElementCategories.find((cat) => cat.id === leaf.id);
      return {
        kind: 'category',
        id: leaf.id,
        title: c?.name || leaf.id,
        kicker: t('rightSidebar.kickers.categoryContent'),
        color: c?.color,
      };
    }
    return { kind: 'none', id: null, title: '—', kicker: '—' };
  }, [
    activeTabKey,
    openTabs,
    bookNodes,
    bookElements,
    storylines,
    bookElementCategories,
    primaryStorylineByNode,
    t,
  ]);

  const focusedForPanel: FocusedEntity = useMemo(() => {
    if (!target.kind || target.kind === 'none' || !target.id) {
      return { kind: null, id: null };
    }
    const kindMap: Record<string, EntityKind | null> = {
      chapter: 'node',
      drift: 'node',
      storyline: 'storyline',
      element: 'element',
      category: 'category',
    };
    const kind = kindMap[target.kind] ?? null;
    return { kind, id: target.id };
  }, [target.kind, target.id]);
  const [fragmentCountFlash] = useState(false);

  const isAgentGroup = rightPanelGroup === 'agent';
  const isFragmentTab =
    !isAgentGroup && (activeRightPanel === 'todo' || activeRightPanel === 'library');
  // Agent panels render their own headers, so hide the kicker/title block there.
  const hideTitleBlock = isAgentGroup || isFragmentTab;
  const headerKicker = isAgentGroup
    ? ''
    : activeRightPanel === 'stats'
      ? t(`rightSidebar.kickers.stats.${target.kind}`, {
          defaultValue: t('rightSidebar.kickers.stats.none'),
        })
      : activeRightPanel === 'todo'
        ? t('rightSidebar.kickers.todo')
        : t('rightSidebar.kickers.library');
  const headerTitle = isAgentGroup
    ? ''
    : activeRightPanel === 'todo'
      ? 'TODO'
      : activeRightPanel === 'library'
        ? t('rightSidebar.tabs.library')
        : target.title;

  // Wide right panel → show both groups side by side. Triggered by the panel's
  // own rendered width (not the screen width). Below the threshold it collapses
  // back to a single column + the group switch.
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => setPanelWidth(node.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const isSplit = panelWidth >= 600;
  // Whenever the panel isn't wide enough to split into two columns it stays a
  // single column with ALL five tabs laid flat in one row — no group switch.
  // The tab labels compact down as the tray tightens (see RightSidebarHeader),
  // so this holds together all the way down to the 200px min width.

  // Drag the divider between the two columns to reallocate width. Mirrors the
  // editor split-pane divider (EditorMainArea/SplitView): ref-tracked rect so
  // the move listener never reads a stale closure, and the store setter clamps
  // the ratio to keep both columns usable. The ratio persists via the store.
  const draggingRef = useRef(false);
  const onDividerMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      draggingRef.current = true;
      const onMove = (e: MouseEvent) => {
        if (!draggingRef.current) return;
        const el = rootRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return;
        setSplitRatio((e.clientX - rect.left) / rect.width);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [setSplitRatio],
  );
  const leftColWidth = `${Math.round(splitRatio * 100)}%`;
  const rightColWidth = `${100 - Math.round(splitRatio * 100)}%`;

  const contentBody = (
    <>
      {activeRightPanel === 'todo' && <TodoPanel focused={focusedForPanel} />}
      {activeRightPanel === 'library' && <LibraryPanel focused={focusedForPanel} />}
      {activeRightPanel === 'stats' && (
        <StatsView
          target={target}
          bookNodes={bookNodes}
          bookActs={bookActs}
          bookElements={bookElements}
          storylines={storylines}
          categories={bookElementCategories}
          storylineNodeMapping={storylineNodeMapping}
          primaryStorylineByNode={primaryStorylineByNode}
        />
      )}
    </>
  );
  const agentBody = (
    <>
      {activeAgentPanel === 'companion' && <CompanionPanel projectId={projectId} />}
      {activeAgentPanel === 'shadow' && <ShadowAgentView />}
    </>
  );

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        flexDirection: isSplit ? 'row' : 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--workspace-ui-bg)',
      }}
    >
      {isSplit ? (
        <>
          <div
            style={{
              width: leftColWidth,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <RightSidebarHeader group="content" kicker="" title="" hideTitleBlock />
            <div className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {contentBody}
            </div>
          </div>
          <ColumnDivider onMouseDown={onDividerMouseDown} />
          <div
            style={{
              width: rightColWidth,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <RightSidebarHeader group="agent" kicker="" title="" hideTitleBlock />
            <div className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {agentBody}
            </div>
          </div>
        </>
      ) : (
        <>
          <RightSidebarHeader
            flat
            kicker={headerKicker}
            title={headerTitle}
            fragmentCountFlash={fragmentCountFlash}
            hideTitleBlock={hideTitleBlock}
          />
          <div className="scroll-no-bar" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {rightPanelGroup === 'content' ? contentBody : agentBody}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats (per-entity)

interface StatsViewProps {
  target: ResolvedTarget;
  bookNodes: ReturnType<typeof useDataStore.getState>['bookNodes'];
  bookActs: ReturnType<typeof useDataStore.getState>['bookActs'];
  bookElements: ReturnType<typeof useDataStore.getState>['bookElements'];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
  storylineNodeMapping: ReturnType<typeof useDataStore.getState>['storylineNodeMapping'];
  primaryStorylineByNode: ReturnType<typeof useDataStore.getState>['primaryStorylineByNode'];
}

function StatsView({
  target,
  bookNodes,
  bookActs,
  bookElements,
  storylines,
  categories,
  storylineNodeMapping,
  primaryStorylineByNode,
}: StatsViewProps) {
  const { t } = useTranslation();
  if (target.kind === 'all-chapters') {
    return <AllChaptersStats bookNodes={bookNodes} bookActs={bookActs} />;
  }
  if (target.kind === 'chapter' || target.kind === 'drift') {
    const node = bookNodes.find((n) => n.id === target.id);
    if (!node) return <EmptyState message={t('rightSidebar.empty.missingChapter')} />;
    // Reading-order rank among chapters (1-based). bookOrder is a sparse,
    // dev-only sort key; surface the chapter's position instead. Drifts have
    // a null bookOrder and are excluded, so they get no chapter number.
    const chapterNumber =
      node.bookOrder != null
        ? bookNodes
            .filter((n): n is typeof n & { bookOrder: number } => n.bookOrder != null)
            .sort((a, b) => a.bookOrder - b.bookOrder)
            .findIndex((n) => n.id === node.id) + 1
        : null;
    return (
      <ChapterStats
        node={node}
        storylines={storylines}
        bookElements={bookElements}
        categories={categories}
        target={target}
        primaryStorylineId={primaryStorylineByNode[node.id] ?? null}
        chapterNumber={chapterNumber}
      />
    );
  }
  if (target.kind === 'storyline') {
    const storyline = storylines.find((s) => s.id === target.id);
    if (!storyline) return <EmptyState message={t('rightSidebar.empty.missingStoryline')} />;
    const nodeIds = storylineNodeMapping[storyline.id] ?? [];
    const nodes = nodeIds
      .map((id) => bookNodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n));
    return (
      <StorylineStats
        storyline={storyline}
        nodes={nodes}
        bookElements={bookElements}
        categories={categories}
      />
    );
  }
  if (target.kind === 'element') {
    const element = bookElements.find((e) => e.id === target.id);
    if (!element) return <EmptyState message={t('rightSidebar.empty.missingElement')} />;
    const category = categories.find((c) => c.id === element.categoryId);
    return <ElementStats element={element} category={category} />;
  }
  if (target.kind === 'category') {
    const category = categories.find((c) => c.id === target.id);
    if (!category) return <EmptyState message={t('rightSidebar.empty.missingCategory')} />;
    const cElements = bookElements.filter((e) => e.categoryId === category.id);
    return (
      <CategoryStats
        category={category}
        elements={cElements}
        storylines={storylines}
        primaryStorylineByNode={primaryStorylineByNode}
      />
    );
  }
  return <EmptyState message={t('rightSidebar.empty.noStats')} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// All-chapters (长卷阅读) aggregate stats — book-wide pacing, NOT a per-entity
// panel. Deliberately a different lens from the project dashboard: it describes
// the linear reading axis (act balance, chapter-length rhythm) the long-form
// view renders, rather than project-management progress. Everything here is
// derived from already-loaded store data — no async queries.

const ALL_CHAPTERS_ACT_TOKENS = [
  '--story-1',
  '--story-2',
  '--story-3',
  '--story-4',
  '--story-5',
  '--story-6',
] as const;

/** An act's stored color, or a stable hue cycled by reading position. */
function actColorAt(act: BookAct, i: number): string {
  if (act.color && act.color.trim().length > 0) return act.color;
  return `hsl(var(${ALL_CHAPTERS_ACT_TOKENS[i % ALL_CHAPTERS_ACT_TOKENS.length]}))`;
}

/**
 * Smooth-scroll the long-form reading view to an act divider / chapter. That
 * scroll container lives in AllChaptersEditorView; scrollIntoView walks
 * ancestors, so a document-level lookup reaches it without threading a ref
 * across the panel boundary. No-op if the row isn't mounted yet (lazy rows).
 */
function scrollReadingViewTo(selector: string) {
  const el = document.querySelector(selector);
  if (el) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
}

type RhythmChapter = { id: string; title?: string | null; wordCount?: number | null };

/**
 * Chapter-length rhythm — one horizontal bar per chapter, laid out as a
 * vertical list so it scales to any chapter count without the bars thinning to
 * unhoverable slivers; each bar's width is scaled to the longest chapter.
 * Hovering a bar reads its title + word count out in the caption below and dims
 * the rest; clicking smooth-scrolls the long-form reading view to that chapter,
 * reusing the same jump path as the act rows and the TOC.
 */
function ChapterRhythmChart({
  chapters,
  maxWc,
  colorByChapter,
  longest,
  shortest,
}: {
  chapters: RhythmChapter[];
  maxWc: number;
  colorByChapter: Map<string, string>;
  longest: RhythmChapter | null;
  shortest: RhythmChapter | null;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered != null ? chapters[hovered] : null;
  const untitled = t('common.untitled');

  return (
    <>
      <div style={{ padding: '2px 0' }} onMouseLeave={() => setHovered(null)}>
        {chapters.map((n, i) => {
          const w = maxWc > 0 ? Math.max(2, ((n.wordCount || 0) / maxWc) * 100) : 2;
          const isHovered = hovered === i;
          return (
            <div
              key={n.id}
              role="button"
              tabIndex={-1}
              title={t('rightSidebar.stats.jumpTo', { name: n.title || untitled })}
              onMouseEnter={() => setHovered(i)}
              onClick={() => scrollReadingViewTo(`[data-chapter-id="${CSS.escape(n.id)}"]`)}
              // Contiguous full-width rows (no gaps) keep the whole column a
              // single easy hover/click strip; the visible bar stays thin.
              style={{
                padding: '1px 0',
                cursor: 'pointer',
                opacity: hovered == null ? 0.85 : isHovered ? 1 : 0.3,
                transition: 'opacity 0.12s ease',
              }}
            >
              <div
                style={{
                  width: `${w}%`,
                  minWidth: 2,
                  height: 3,
                  background: colorByChapter.get(n.id) || 'hsl(var(--ink-4))',
                  borderRadius: 1,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        // Reserve two lines so the readout swapping in on hover doesn't shift
        // the layout.
        style={{
          marginTop: 8,
          minHeight: 34,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-3))',
          lineHeight: 1.7,
        }}
      >
        {active ? (
          <div style={{ color: 'hsl(var(--ink-1))' }}>
            {t('rightSidebar.stats.titleWithWords', {
              title: active.title || untitled,
              words: (active.wordCount || 0).toLocaleString(),
            })}
          </div>
        ) : longest ? (
          <>
            <div>
              {t('rightSidebar.stats.longestWithWords', {
                title: longest.title || untitled,
                words: (longest.wordCount || 0).toLocaleString(),
              })}
            </div>
            {shortest && shortest.id !== longest.id && (
              <div>
                {t('rightSidebar.stats.shortestWithWords', {
                  title: shortest.title || untitled,
                  words: (shortest.wordCount || 0).toLocaleString(),
                })}
              </div>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

const STATUS_BUCKET_ORDER = ['done', 'draft', 'todo'] as const;
const STATUS_BUCKET_LABEL_KEY: Record<DerivedStatus, string> = {
  done: 'rightSidebar.status.done',
  draft: 'rightSidebar.status.draft',
  todo: 'rightSidebar.status.todo',
  discarded: 'rightSidebar.status.discarded',
};
const STATUS_BUCKET_OPACITY: Record<(typeof STATUS_BUCKET_ORDER)[number], number> = {
  done: 1,
  draft: 0.5,
  todo: 0.18,
};

function AllChaptersStats({
  bookNodes,
  bookActs,
}: {
  bookNodes: ReturnType<typeof useDataStore.getState>['bookNodes'];
  bookActs: ReturnType<typeof useDataStore.getState>['bookActs'];
}) {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const projectWordTarget = useWritingStatsStore((s) =>
    projectId ? s.plans[projectId]?.projectWordTarget : undefined,
  );

  // Reading order = chapters only (drifts live off the bookOrder axis), sorted
  // by bookOrder. Mirrors AllChaptersEditorView so the stats describe exactly
  // what the long-form view puts on screen.
  const chapters = useMemo(
    () => bookNodes.filter(isChapter).sort((a, b) => a.bookOrder - b.bookOrder),
    [bookNodes],
  );
  type Ch = (typeof chapters)[number];

  const totalWc = useMemo(() => chapters.reduce((a, n) => a + (n.wordCount || 0), 0), [chapters]);
  const count = chapters.length;
  const avgWc = count ? Math.round(totalWc / count) : 0;
  const targetPct =
    projectWordTarget && projectWordTarget > 0
      ? Math.min(100, (totalWc / projectWordTarget) * 100)
      : null;

  const segments = useMemo(() => deriveActSegments(bookActs, chapters), [bookActs, chapters]);

  // Per-act aggregates + a chapterId→color map that ties the act bar and the
  // chapter-rhythm bars to one palette.
  const { actRows, colorByChapter } = useMemo(() => {
    const rows = segments.map((seg, i) => {
      const words = seg.chapters.reduce((a, c) => a + (c.wordCount || 0), 0);
      const cnt = seg.chapters.length;
      return {
        act: seg.act,
        color: actColorAt(seg.act, i),
        words,
        cnt,
        pct: totalWc ? (words / totalWc) * 100 : 0,
      };
    });
    const map = new Map<string, string>();
    rows.forEach((r, i) => {
      for (const c of segments[i].chapters) map.set(c.id, r.color);
    });
    return { actRows: rows, colorByChapter: map };
  }, [segments, totalWc]);

  // Chapter-length rhythm: bars scaled to the longest chapter, floored so a
  // zero/short chapter still shows a sliver.
  const maxWc = useMemo(
    () => chapters.reduce((m, n) => Math.max(m, n.wordCount || 0), 0),
    [chapters],
  );
  const { longest, shortest } = useMemo(() => {
    let lo: Ch | null = null;
    let sh: Ch | null = null;
    for (const n of chapters) {
      if (!lo || (n.wordCount || 0) > (lo.wordCount || 0)) lo = n;
      if (!sh || (n.wordCount || 0) < (sh.wordCount || 0)) sh = n;
    }
    return { longest: lo, shortest: sh };
  }, [chapters]);

  const statusCounts = useMemo(() => {
    const m: Record<DerivedStatus, number> = { done: 0, draft: 0, todo: 0, discarded: 0 };
    for (const n of chapters) m[deriveStatus(n)] += 1;
    return m;
  }, [chapters]);
  const activeTotal = STATUS_BUCKET_ORDER.reduce((a, s) => a + statusCounts[s], 0);
  const donePct = count ? Math.round((statusCounts.done / count) * 100) : 0;

  if (count === 0) {
    return <EmptyState message={t('rightSidebar.stats.noChapters')} />;
  }

  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={t('rightSidebar.stats.bookOverview')}>
        <MetaGrid>
          <MetaK>{t('rightSidebar.stats.totalWords')}</MetaK>
          <MetaV>{t('rightSidebar.stats.wordsValue', { count: totalWc.toLocaleString() })}</MetaV>
          <MetaK>{t('rightSidebar.stats.chapterCount')}</MetaK>
          <MetaV>{t('rightSidebar.stats.chaptersValue', { count })}</MetaV>
          <MetaK>{t('rightSidebar.stats.averagePerChapter')}</MetaK>
          <MetaV>{t('rightSidebar.stats.wordsValue', { count: avgWc.toLocaleString() })}</MetaV>
        </MetaGrid>
        {targetPct != null && (
          <div style={{ marginTop: 8 }}>
            <StatsRow
              k={t('rightSidebar.stats.writtenTarget')}
              v={`${totalWc.toLocaleString()} / ${projectWordTarget!.toLocaleString()}`}
            >
              <ProgressBar pct={targetPct} />
            </StatsRow>
          </div>
        )}
      </StatsSection>

      {actRows.length > 0 && (
        <StatsSection title={t('rightSidebar.stats.actRhythm')} topBorder>
          <div
            style={{
              display: 'flex',
              height: 5,
              borderRadius: 2,
              overflow: 'hidden',
              background: 'hsl(var(--rule))',
              marginBottom: 10,
            }}
          >
            {actRows.map((r) =>
              r.pct > 0 ? (
                <div
                  key={r.act.id}
                  title={t('rightSidebar.stats.actTooltip', {
                    name: r.act.name,
                    chapters: r.cnt,
                    words: r.words.toLocaleString(),
                  })}
                  style={{ width: `${r.pct}%`, background: r.color }}
                />
              ) : null,
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {actRows.map((r) => (
              <StatsLinkRow
                key={r.act.id}
                name={r.act.name}
                color={r.color}
                meta={t('rightSidebar.stats.actMeta', {
                  chapters: r.cnt,
                  wordsK: (r.words / 1000).toFixed(1),
                  pct: Math.round(r.pct),
                })}
                title={t('rightSidebar.stats.jumpTo', { name: r.act.name })}
                onOpen={() => scrollReadingViewTo(`[data-act-id="${CSS.escape(r.act.id)}"]`)}
              />
            ))}
          </div>
        </StatsSection>
      )}

      <StatsSection title={t('rightSidebar.stats.completion')} topBorder>
        {activeTotal === 0 ? (
          <Notes>{t('rightSidebar.stats.noActiveProgress')}</Notes>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                height: 5,
                borderRadius: 2,
                overflow: 'hidden',
                background: 'hsl(var(--rule))',
                marginBottom: 8,
              }}
            >
              {STATUS_BUCKET_ORDER.map((s) =>
                statusCounts[s] > 0 ? (
                  <div
                    key={s}
                    title={t('rightSidebar.stats.statusCount', {
                      status: t(STATUS_BUCKET_LABEL_KEY[s]),
                      count: statusCounts[s],
                    })}
                    style={{
                      width: `${(statusCounts[s] / activeTotal) * 100}%`,
                      background: 'hsl(var(--accent))',
                      opacity: STATUS_BUCKET_OPACITY[s],
                    }}
                  />
                ) : null,
              )}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'hsl(var(--ink-3))',
                lineHeight: 1.7,
              }}
            >
              {STATUS_BUCKET_ORDER.filter((s) => statusCounts[s] > 0)
                .map((s) =>
                  t('rightSidebar.stats.statusCount', {
                    status: t(STATUS_BUCKET_LABEL_KEY[s]),
                    count: statusCounts[s],
                  }),
                )
                .join(' · ') || '—'}
              {statusCounts.discarded > 0 &&
                t('rightSidebar.stats.discardedParen', { count: statusCounts.discarded })}
            </div>
            <StatsRow k={t('rightSidebar.status.done')} v={`${donePct}%`} />
          </>
        )}
      </StatsSection>

      <StatsSection title={t('rightSidebar.stats.chapterLengthRhythm')} topBorder>
        <ChapterRhythmChart
          chapters={chapters}
          maxWc={maxWc}
          colorByChapter={colorByChapter}
          longest={longest}
          shortest={shortest}
        />
      </StatsSection>
    </div>
  );
}

/** One element mentioned in the chapter's prose, with its mention count. */
interface ChapterElementStat {
  elementId: string;
  mentionCount: number;
}

/**
 * Loads the chapter's CURRENT prose (Yjs truth, falling back to the
 * contentJson cache) and its inline-mention rows, and derives the prose-shape
 * stats + per-element mention counts. Re-runs when the node is touched
 * (updatedAt) so the panel tracks edits without subscribing to the live doc.
 */
function useChapterStatsData(nodeId: string, updatedAt: string | number | Date) {
  const [stats, setStats] = useState<ProseStats | null>(null);
  const [elements, setElements] = useState<ChapterElementStat[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [contentJson, mentions] = await Promise.all([
          getChapterContentJson(nodeId, null),
          createInlineMentionRepository().listMentionsFromSource('node', nodeId),
        ]);
        if (!alive) return;
        setStats(computeProseStats(contentJson));
        const counts = new Map<string, number>();
        for (const m of mentions) {
          if (m.toKind !== 'element') continue;
          let n = 1;
          try {
            const spans: unknown = JSON.parse(m.fromSpansJson);
            if (Array.isArray(spans)) n = Math.max(1, spans.length);
          } catch {
            /* malformed spans row — count the row itself */
          }
          counts.set(m.toId, (counts.get(m.toId) ?? 0) + n);
        }
        setElements(
          [...counts.entries()]
            .map(([elementId, mentionCount]) => ({ elementId, mentionCount }))
            .sort((a, b) => b.mentionCount - a.mentionCount),
        );
      } catch {
        if (!alive) return;
        setStats(null);
        setElements(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [nodeId, updatedAt]);

  return { stats, elements };
}

/**
 * Aggregated element mentions across a set of chapters — the storyline's
 * "core cast". One listMentionsFromSource query per member chapter, async.
 * null while loading.
 */
function useStorylineCoreElements(nodeIds: string[]) {
  const [rows, setRows] = useState<ChapterElementStat[] | null>(null);
  const idsKey = nodeIds.join(',');
  useEffect(() => {
    let alive = true;
    const ids = idsKey ? idsKey.split(',') : [];
    void (async () => {
      try {
        const repo = createInlineMentionRepository();
        // Promise.all([]) resolves in a microtask, so the empty case still
        // sets state asynchronously (no sync setState inside the effect).
        const perNode = await Promise.all(ids.map((id) => repo.listMentionsFromSource('node', id)));
        if (!alive) return;
        const counts = new Map<string, number>();
        for (const mentions of perNode) {
          for (const m of mentions) {
            if (m.toKind !== 'element') continue;
            let n = 1;
            try {
              const spans: unknown = JSON.parse(m.fromSpansJson);
              if (Array.isArray(spans)) n = Math.max(1, spans.length);
            } catch {
              /* malformed spans row — count the row itself */
            }
            counts.set(m.toId, (counts.get(m.toId) ?? 0) + n);
          }
        }
        setRows(
          [...counts.entries()]
            .map(([elementId, mentionCount]) => ({ elementId, mentionCount }))
            .sort((a, b) => b.mentionCount - a.mentionCount),
        );
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [idsKey]);
  return rows;
}

interface CategoryHealth {
  /** Elements with ≥1 prose appearance (mentioned from a chapter/drift). */
  appearedIds: Set<string>;
  /** elementId → distinct chapters it appears in. */
  chapterCounts: Map<string, number>;
  /** primary storylineId ('' = 未归线/漂浮) → distinct elements appearing there. */
  byStoryline: Map<string, number>;
}

/**
 * Appearance health for a category's elements: one backlink query per element
 * (categories are small), nodes mapped to their primary storyline for the
 * per-storyline distribution. null while loading.
 */
function useCategoryHealth(
  elementIds: string[],
  primaryStorylineByNode: Record<string, string | null>,
) {
  const [health, setHealth] = useState<CategoryHealth | null>(null);
  const idsKey = elementIds.join(',');
  useEffect(() => {
    let alive = true;
    const ids = idsKey ? idsKey.split(',') : [];
    void (async () => {
      try {
        const repo = createInlineMentionRepository();
        const perElement = await Promise.all(
          ids.map((id) => repo.listBacklinksToTarget('element', id)),
        );
        if (!alive) return;
        const appearedIds = new Set<string>();
        const chapterCounts = new Map<string, number>();
        const byStorylineSets = new Map<string, Set<string>>();
        ids.forEach((elId, i) => {
          const fromNodes = new Set(
            perElement[i].filter((b) => b.fromKind === 'node').map((b) => b.fromId),
          );
          if (fromNodes.size === 0) return;
          appearedIds.add(elId);
          chapterCounts.set(elId, fromNodes.size);
          for (const nodeId of fromNodes) {
            const sl = primaryStorylineByNode[nodeId] ?? '';
            let set = byStorylineSets.get(sl);
            if (!set) {
              set = new Set();
              byStorylineSets.set(sl, set);
            }
            set.add(elId);
          }
        });
        setHealth({
          appearedIds,
          chapterCounts,
          byStoryline: new Map([...byStorylineSets.entries()].map(([k, v]) => [k, v.size])),
        });
      } catch {
        if (alive) setHealth(null);
      }
    })();
    return () => {
      alive = false;
    };
    // primaryStorylineByNode identity churns with the store; idsKey is the
    // meaningful trigger and the mapping is read fresh on each run anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  return health;
}

/**
 * The stats panel's entry into the entity time machine — opens the globally
 * mounted EntitySnapshotHistoryModal. This is the ONLY entry point (the
 * editor / cell context menus deliberately don't carry it).
 */
function SnapshotEntryButton({
  entityKind,
  entityId,
}: {
  entityKind: ProseEntityType;
  entityId: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => events.emit('snapshot-history:open', { entityKind, entityId })}
      title={t('rightSidebar.stats.snapshotTitle')}
      style={{
        width: '100%',
        marginTop: 14,
        padding: '7px 10px',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 4,
        background: 'transparent',
        color: 'hsl(var(--ink-2))',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.06em',
        cursor: 'pointer',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--rule) / 0.3)';
        e.currentTarget.style.color = 'hsl(var(--ink-1))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'hsl(var(--ink-2))';
      }}
    >
      ↺ {t('rightSidebar.stats.snapshotButton')}
    </button>
  );
}

function ChapterStats({
  node,
  storylines,
  bookElements,
  categories,
  target,
  primaryStorylineId,
  chapterNumber,
}: {
  node: ReturnType<typeof useDataStore.getState>['bookNodes'][number];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  bookElements: ReturnType<typeof useDataStore.getState>['bookElements'];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
  target: ResolvedTarget;
  primaryStorylineId: string | null;
  chapterNumber: number | null;
}) {
  const { t } = useTranslation();
  const storyline = primaryStorylineId
    ? storylines.find((s) => s.id === primaryStorylineId)
    : undefined;
  const { stats, elements } = useChapterStatsData(node.id, node.updatedAt);
  const dialoguePct = stats ? Math.round(stats.dialogueRatio * 100) : 0;
  const { openEntity } = useProjectNavigation();
  return (
    <div style={{ padding: 12 }}>
      <StatsSection
        title={
          target.kind === 'drift'
            ? t('rightSidebar.stats.driftCoordinates')
            : t('rightSidebar.stats.chapterCoordinates')
        }
      >
        <MetaGrid>
          {storyline ? (
            <>
              <MetaK>{t('rightSidebar.stats.storyline')}</MetaK>
              <MetaV>
                <Dot color={storyline.color} />
                <DetailValue>{storyline.name}</DetailValue>
              </MetaV>
            </>
          ) : (
            <>
              <MetaK>{t('rightSidebar.stats.type')}</MetaK>
              <MetaV>
                <DetailValue>
                  {target.kind === 'drift'
                    ? t('rightSidebar.stats.driftFreeFragment')
                    : t('rightSidebar.stats.chapter')}
                </DetailValue>
              </MetaV>
            </>
          )}
          {chapterNumber != null && (
            <>
              <MetaK>{t('rightSidebar.stats.bookPosition')}</MetaK>
              <MetaV>{t('rightSidebar.stats.chapterOrdinal', { count: chapterNumber })}</MetaV>
            </>
          )}
          <MetaK>{t('rightSidebar.stats.lastModified')}</MetaK>
          <MetaV>
            <DetailValue>{formatDateTime(node.updatedAt)}</DetailValue>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      <StatsSection title={t('rightSidebar.stats.wordRhythm')} topBorder>
        <StatsRow
          k={t('rightSidebar.stats.chapterWordCount')}
          v={node.wordCount.toLocaleString()}
        />
        <StatsRow
          k={t('rightSidebar.stats.paragraphSentence')}
          v={
            stats
              ? t('rightSidebar.stats.paragraphSentenceValue', {
                  paragraphs: stats.paragraphs,
                  sentences: stats.sentences,
                })
              : '—'
          }
          placeholder={!stats}
        />
        <StatsRow
          k={t('rightSidebar.stats.dialogueRatio')}
          v={stats ? `${dialoguePct}%` : '—'}
          placeholder={!stats}
        >
          {stats && <ProgressBar pct={dialoguePct} />}
        </StatsRow>
      </StatsSection>

      <StatsSection
        title={
          target.kind === 'drift'
            ? t('rightSidebar.stats.thisFragmentElements')
            : t('rightSidebar.stats.thisChapterElements')
        }
        topBorder
      >
        {elements && elements.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {elements.map(({ elementId, mentionCount }) => {
              const el = bookElements.find((e) => e.id === elementId);
              if (!el) return null;
              const cat = categories.find((c) => c.id === el.categoryId);
              return (
                <StatsLinkRow
                  key={elementId}
                  name={el.name || t('common.untitled')}
                  color={cat?.color}
                  meta={`×${mentionCount}`}
                  onOpen={() => openEntity({ entityType: 'element', id: elementId })}
                />
              );
            })}
          </div>
        ) : (
          <Notes>
            {elements
              ? t('rightSidebar.stats.noMentionedElements')
              : t('rightSidebar.stats.loading')}
          </Notes>
        )}
      </StatsSection>

      <SnapshotEntryButton entityKind="node" entityId={node.id} />
    </div>
  );
}

/** "● name ……… meta" navigable row used by the stats lists (本章元素 /
 *  本线核心元素 / 未出场元素 / 故事线分布). */
function StatsLinkRow({
  name,
  color,
  meta,
  onOpen,
  title,
}: {
  name: string;
  color?: string;
  /** Optional right-aligned mono annotation, e.g. "×12" or "3 个元素". */
  meta?: string;
  onOpen: () => void;
  /** Hover tooltip; defaults to the element-open phrasing. */
  title?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen();
      }}
      title={title ?? t('rightSidebar.stats.openEntity', { name })}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 2px',
        borderBottom: '1px dotted hsl(var(--rule))',
        fontSize: 12,
        minWidth: 0,
        cursor: 'pointer',
        transition: 'background 0.12s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--rule) / 0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <Dot color={color} />
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          color: 'hsl(var(--ink-1))',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {name}
      </span>
      {meta && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'hsl(var(--ink-3))',
            flexShrink: 0,
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
}

/** Manual-pick chapter statuses, in stacked-bar order (most → least done). */
const STORYLINE_STATUS_ORDER = ['finished', 'revising', 'waiting_review', 'draft'] as const;
const STORYLINE_STATUS_OPACITY: Record<(typeof STORYLINE_STATUS_ORDER)[number], number> = {
  finished: 1,
  revising: 0.65,
  waiting_review: 0.4,
  draft: 0.18,
};

function StorylineStats({
  storyline,
  nodes,
  bookElements,
  categories,
}: {
  storyline: ReturnType<typeof useDataStore.getState>['storylines'][number];
  nodes: ReturnType<typeof useDataStore.getState>['bookNodes'];
  bookElements: ReturnType<typeof useDataStore.getState>['bookElements'];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
}) {
  const { t } = useTranslation();
  const total = nodes.length;
  const totalWc = nodes.reduce((a, n) => a + (n.wordCount || 0), 0);
  const avgWc = total ? Math.round(totalWc / total) : 0;
  const { openEntity } = useProjectNavigation();

  // Writing-status distribution over the member chapters. Discarded chapters
  // are parked, not progress — they're excluded from the bar and listed as a
  // trailing count instead.
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      if (isDrift(n)) continue;
      counts.set(n.writingStatus, (counts.get(n.writingStatus) ?? 0) + 1);
    }
    return counts;
  }, [nodes]);
  const discarded = statusCounts.get('discarded') ?? 0;
  const activeTotal = STORYLINE_STATUS_ORDER.reduce((a, s) => a + (statusCounts.get(s) ?? 0), 0);

  const coreElements = useStorylineCoreElements(useMemo(() => nodes.map((n) => n.id), [nodes]));

  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={t('rightSidebar.stats.storylineCoordinates')}>
        <MetaGrid>
          <MetaK>{t('rightSidebar.stats.storyline')}</MetaK>
          <MetaV>
            <Dot color={storyline.color} />
            <DetailValue>{storyline.name}</DetailValue>
          </MetaV>
          <MetaK>{t('rightSidebar.stats.chapterCount')}</MetaK>
          <MetaV>{t('rightSidebar.stats.chaptersValue', { count: total })}</MetaV>
          <MetaK>{t('rightSidebar.stats.recent')}</MetaK>
          <MetaV>
            <DetailValue>{formatDateTime(storyline.updatedAt)}</DetailValue>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      <StatsSection title={t('rightSidebar.stats.writingProgress')} topBorder>
        {activeTotal === 0 ? (
          <Notes>{t('rightSidebar.stats.storylineNoChapters')}</Notes>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                height: 5,
                borderRadius: 2,
                overflow: 'hidden',
                background: 'hsl(var(--rule))',
                marginBottom: 8,
              }}
            >
              {STORYLINE_STATUS_ORDER.map((s) => {
                const n = statusCounts.get(s) ?? 0;
                if (n === 0) return null;
                return (
                  <div
                    key={s}
                    title={t('rightSidebar.stats.statusCount', {
                      status: getWritingStatusLabel(s, t),
                      count: n,
                    })}
                    style={{
                      width: `${(n / activeTotal) * 100}%`,
                      background: storyline.color,
                      opacity: STORYLINE_STATUS_OPACITY[s],
                    }}
                  />
                );
              })}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'hsl(var(--ink-3))',
                lineHeight: 1.7,
              }}
            >
              {STORYLINE_STATUS_ORDER.filter((s) => (statusCounts.get(s) ?? 0) > 0)
                .map((s) =>
                  t('rightSidebar.stats.statusCount', {
                    status: getWritingStatusLabel(s, t),
                    count: statusCounts.get(s),
                  }),
                )
                .join(' · ') || '—'}
              {discarded > 0 && t('rightSidebar.stats.discardedParen', { count: discarded })}
            </div>
            <StatsRow
              k={t('rightSidebar.stats.averageWords')}
              v={t('rightSidebar.stats.wordsPerChapterValue', {
                words: avgWc.toLocaleString(),
              })}
            />
          </>
        )}
      </StatsSection>

      <StatsSection title={t('rightSidebar.stats.storylineCoreElements')} topBorder>
        {coreElements === null ? (
          <Notes>{t('rightSidebar.stats.loading')}</Notes>
        ) : coreElements.length === 0 ? (
          <Notes>{t('rightSidebar.stats.storylineNoMentionedElements')}</Notes>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {coreElements.slice(0, 8).map(({ elementId, mentionCount }) => {
              const el = bookElements.find((e) => e.id === elementId);
              if (!el) return null;
              const cat = categories.find((c) => c.id === el.categoryId);
              return (
                <StatsLinkRow
                  key={elementId}
                  name={el.name || t('common.untitled')}
                  color={cat?.color}
                  meta={`×${mentionCount}`}
                  onOpen={() => openEntity({ entityType: 'element', id: elementId })}
                />
              );
            })}
            {coreElements.length > 8 && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'hsl(var(--ink-4))',
                  padding: '6px 2px 0',
                }}
              >
                {t('rightSidebar.stats.moreLowAppearanceElements', {
                  count: coreElements.length - 8,
                })}
              </div>
            )}
          </div>
        )}
      </StatsSection>

      <SnapshotEntryButton entityKind="storyline" entityId={storyline.id} />
    </div>
  );
}

function ElementStats({
  element,
  category,
}: {
  element: ReturnType<typeof useDataStore.getState>['bookElements'][number];
  category?: ReturnType<typeof useDataStore.getState>['bookElementCategories'][number];
}) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={t('rightSidebar.stats.elementCoordinates')}>
        <MetaGrid>
          <MetaK>{t('rightSidebar.stats.category')}</MetaK>
          <MetaV>
            {category && <Dot color={category.color} />}
            <DetailValue>{category?.name ?? '—'}</DetailValue>
          </MetaV>
          <MetaK>{t('rightSidebar.stats.name')}</MetaK>
          <MetaV>
            <DetailValue>{element.name}</DetailValue>
          </MetaV>
          <MetaK>{t('rightSidebar.stats.updated')}</MetaK>
          <MetaV>
            <DetailValue>{formatDateTime(element.updatedAt)}</DetailValue>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      {/* 被引用 / 引用其他 — the same read-only projections the element
          editor used to host in its body; the editor keeps only the
          editable 关联 section. */}
      <StatsSection title={t('rightSidebar.stats.references')} topBorder>
        <ReferencesPanel
          entityKind="element"
          entityId={element.id}
          projectId={element.projectId}
          sections={['incoming', 'outgoing']}
        />
      </StatsSection>

      <SnapshotEntryButton entityKind="element" entityId={element.id} />
    </div>
  );
}

function CategoryStats({
  category,
  elements,
  storylines,
  primaryStorylineByNode,
}: {
  category: ReturnType<typeof useDataStore.getState>['bookElementCategories'][number];
  elements: ReturnType<typeof useDataStore.getState>['bookElements'];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  primaryStorylineByNode: ReturnType<typeof useDataStore.getState>['primaryStorylineByNode'];
}) {
  const { t } = useTranslation();
  const total = elements.length;
  const { openEntity } = useProjectNavigation();
  const health = useCategoryHealth(
    useMemo(() => elements.map((e) => e.id), [elements]),
    primaryStorylineByNode,
  );

  const appeared = health?.appearedIds.size ?? 0;
  const unappeared = health ? elements.filter((e) => !health.appearedIds.has(e.id)) : [];
  const avgChapters =
    health && appeared > 0
      ? [...health.chapterCounts.values()].reduce((a, n) => a + n, 0) / appeared
      : 0;
  // Storyline distribution rows, count desc; '' bucket = chapters without a
  // primary storyline (drift / unaffiliated).
  const storylineRows = useMemo(() => {
    if (!health) return [];
    return [...health.byStoryline.entries()]
      .map(([slId, count]) => ({
        slId,
        count,
        storyline: slId ? storylines.find((s) => s.id === slId) : undefined,
      }))
      .sort((a, b) => b.count - a.count);
  }, [health, storylines]);

  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={t('rightSidebar.stats.categoryCoordinates')}>
        <MetaGrid>
          <MetaK>{t('rightSidebar.stats.category')}</MetaK>
          <MetaV>
            <Dot color={category.color} />
            <DetailValue>{category.name}</DetailValue>
          </MetaV>
          <MetaK>{t('rightSidebar.stats.elementCount')}</MetaK>
          <MetaV>{t('rightSidebar.stats.elementsValue', { count: total })}</MetaV>
        </MetaGrid>
      </StatsSection>

      <StatsSection title={t('rightSidebar.stats.health')} topBorder>
        {health === null ? (
          <Notes>{t('rightSidebar.stats.loading')}</Notes>
        ) : total === 0 ? (
          <Notes>{t('rightSidebar.stats.categoryNoElements')}</Notes>
        ) : (
          <>
            <StatsRow k={t('rightSidebar.stats.appeared')} v={`${appeared} / ${total}`}>
              <ProgressBar pct={(appeared / total) * 100} color={category.color} />
            </StatsRow>
            <StatsRow
              k={t('rightSidebar.stats.averageAppearance')}
              v={
                appeared > 0
                  ? t('rightSidebar.stats.avgChaptersPerElement', {
                      count: avgChapters.toFixed(1),
                    })
                  : '—'
              }
              placeholder={appeared === 0}
            />
          </>
        )}
      </StatsSection>

      {health !== null && total > 0 && (
        <StatsSection title={t('rightSidebar.stats.unappearedElements')} topBorder>
          {unappeared.length === 0 ? (
            <Notes>{t('rightSidebar.stats.allElementsAppeared')}</Notes>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {unappeared.slice(0, 20).map((el) => (
                <StatsLinkRow
                  key={el.id}
                  name={el.name || t('common.untitled')}
                  color={category.color}
                  onOpen={() => openEntity({ entityType: 'element', id: el.id })}
                />
              ))}
              {unappeared.length > 20 && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'hsl(var(--ink-4))',
                    padding: '6px 2px 0',
                  }}
                >
                  {t('rightSidebar.stats.moreUnappearedElements', {
                    count: unappeared.length - 20,
                  })}
                </div>
              )}
            </div>
          )}
        </StatsSection>
      )}

      {storylineRows.length > 0 && (
        <StatsSection title={t('rightSidebar.stats.storylineDistribution')} topBorder>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {storylineRows.map(({ slId, count, storyline }) =>
              storyline ? (
                <StatsLinkRow
                  key={slId}
                  name={storyline.name}
                  color={storyline.color}
                  meta={t('rightSidebar.stats.elementsValue', { count })}
                  onOpen={() => openEntity({ entityType: 'storyline', id: slId })}
                />
              ) : (
                <div
                  key="unaffiliated"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 2px',
                    borderBottom: '1px dotted hsl(var(--rule))',
                    fontSize: 12,
                  }}
                >
                  <Dot color="hsl(var(--ink-4))" />
                  <span
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      color: 'hsl(var(--ink-3))',
                      flex: 1,
                    }}
                  >
                    {t('rightSidebar.stats.floatingStoryline')}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'hsl(var(--ink-3))',
                    }}
                  >
                    {t('rightSidebar.stats.elementsValue', { count })}
                  </span>
                </div>
              ),
            )}
          </div>
        </StatsSection>
      )}

      <SnapshotEntryButton entityKind="category" entityId={category.id} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow tab — real task queue lands here (mock list removed)

function ShadowAgentView() {
  // The real shadow task queue: persisted review jobs, each expandable to its
  // evidence-gathering + decision trail. See ShadowPanel.
  return <ShadowPanel />;
}

// Shadow notification stack (bottom-pinned card pile) used to live here.
// Removed when the shadow-mode toggle was consolidated onto the bottom
// status bar. Reintroduce a real notification surface only when there's a
// backing store to populate it.

// ─────────────────────────────────────────────────────────────────────────────
// Small shared bits

// Draggable separator between the content / agent columns in dual-column mode.
// Visually just a 1px hairline (same weight as a normal column border, no
// filled bar / backdrop). The element is wider for a comfortable grab target
// but transparent, with negative margins so it nets ~1px of layout width —
// the columns sit flush against the hairline.
function ColumnDivider({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      style={{
        width: 7,
        marginLeft: -3,
        marginRight: -3,
        flexShrink: 0,
        cursor: 'col-resize',
        display: 'flex',
        justifyContent: 'center',
        background: 'transparent',
      }}
    >
      <div style={{ width: 1, height: '100%', background: 'hsl(var(--rule))' }} />
    </div>
  );
}

function StatsSection({
  title,
  topBorder,
  children,
}: {
  title: string;
  topBorder?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: topBorder ? '14px 0 16px' : '0 0 16px',
        borderTop: topBorder ? '1px solid hsl(var(--rule))' : 'none',
        borderBottom: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: 'hsl(var(--ink-3))',
        }}
      >
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function StatsRow({
  k,
  v,
  children,
  placeholder,
}: {
  k: string;
  v: string;
  children?: React.ReactNode;
  placeholder?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: '4px 12px',
        padding: '6px 0',
        borderBottom: '1px dotted hsl(var(--rule))',
        fontSize: 12,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'hsl(var(--ink-3))',
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          color: placeholder ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-1))',
          fontStyle: placeholder ? 'italic' : 'normal',
        }}
      >
        {v}
      </span>
      {children && <div style={{ gridColumn: '1 / -1', marginTop: 2 }}>{children}</div>}
    </div>
  );
}

function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div
      style={{
        height: 4,
        background: 'hsl(var(--rule))',
        borderRadius: 2,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: '100%',
          background: color || 'hsl(var(--accent))',
          transition: 'width 0.25s ease',
        }}
      />
    </div>
  );
}

function MetaGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '6px 12px' }}>
      {children}
    </div>
  );
}

function MetaK({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'hsl(var(--ink-4))',
        paddingTop: 1,
      }}
    >
      {children}
    </div>
  );
}

function MetaV({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: 'hsl(var(--ink-2))',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {children}
    </div>
  );
}

function DetailValue({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontStyle: 'italic' }}>
      {children}
    </span>
  );
}

function Dot({ color }: { color?: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: 2,
        background: color || 'hsl(var(--ink-3))',
        display: 'inline-block',
      }}
    />
  );
}

function Notes({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-sans)',
        fontStyle: 'italic',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'hsl(var(--ink-2))',
        padding: '8px 10px',
        background: 'hsl(var(--ink-1) / 0.03)',
        borderRadius: 'var(--radius-xs)',
      }}
    >
      {children}
    </div>
  );
}

function formatDateTime(input: string | number | Date): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return sameYear ? `${m}/${day} ${hh}:${mm}` : `${d.getFullYear()}/${m}/${day} ${hh}:${mm}`;
}
