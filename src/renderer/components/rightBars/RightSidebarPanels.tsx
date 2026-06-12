import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataStore } from '../../store/data-store';
import { isDrift } from '../../domain/book-node';
import { getChapterContentJson } from '../../lib/agent/chapter-prose';
import { computeProseStats, type ProseStats } from '../../lib/prose-stats';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import { ReferencesPanel } from '../editor/ReferencesPanel';
import { WRITING_STATUS_LABELS } from '../editor/EditorTopBar';
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

interface ResolvedTarget {
  kind: 'chapter' | 'storyline' | 'element' | 'category' | 'drift' | 'none';
  id: string | null;
  title: string;
  kicker: string;
  color?: string;
}

export function RightSidebarPanels() {
  const { projectId } = useProjectNavigation();
  const { activeTabKey, openTabs } = useProjectTabs(projectId);
  const rightPanelGroup = useUiStore((s) => s.rightPanelGroup);
  const activeRightPanel = useUiStore((s) => s.activeRightPanel);
  const activeAgentPanel = useUiStore((s) => s.activeAgentPanel);
  const shadowMode = useUiStore((s) => s.shadowMode);
  const splitRatio = useUiStore((s) => s.rightPanelSplitRatio);
  const setSplitRatio = useUiStore((s) => s.setRightPanelSplitRatio);

  const {
    bookNodes,
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
      return { kind: 'none', id: null, title: '—', kicker: '未打开标签页' };
    }
    const leaf = focusedLeafOf(activeTab);
    if (leaf.entityType === 'dashboard') {
      return { kind: 'none', id: null, title: '项目主页', kicker: '本项目 · 概览' };
    }
    if (leaf.entityType === 'all-chapters') {
      return { kind: 'none', id: null, title: '通览全书', kicker: '全书 · 长卷阅读' };
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
        title: node.title || (drift ? 'Untitled Drift' : 'Untitled Chapter'),
        kicker: drift ? '本浮缀 · 片段与材料' : '本章 · 片段与材料',
        color: storyline?.color,
      };
    }
    if (leaf.entityType === 'storyline') {
      const s = storylines.find((sl) => sl.id === leaf.id);
      return {
        kind: 'storyline',
        id: leaf.id,
        title: s?.name || 'Untitled Storyline',
        kicker: '本故事线 · 片段与材料',
        color: s?.color,
      };
    }
    if (leaf.entityType === 'element') {
      const e = bookElements.find((el) => el.id === leaf.id);
      const cat = e ? bookElementCategories.find((c) => c.id === e.categoryId) : undefined;
      return {
        kind: 'element',
        id: leaf.id,
        title: e?.name || 'Untitled Element',
        kicker: '本元素 · 片段与材料',
        color: cat?.color,
      };
    }
    if (leaf.entityType === 'category') {
      const c = bookElementCategories.find((cat) => cat.id === leaf.id);
      return {
        kind: 'category',
        id: leaf.id,
        title: c?.name || leaf.id,
        kicker: '本类目 · 片段与材料',
        color: c?.color,
      };
    }
    return { kind: 'none', id: null, title: '—', kicker: '—' };
  }, [activeTabKey, openTabs, bookNodes, bookElements, storylines, bookElementCategories]);

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
  const [shadowJustAppeared, setShadowJustAppeared] = useState(false);


  // Pulse the Shadow tab the first ~4.5s after the user invokes shadow mode.
  // Syncing a UI pulse to an external trigger (shadowMode) — the setState is
  // intentional here, not a derived-render smell.
  useEffect(() => {
    if (!shadowMode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShadowJustAppeared(false);
      return;
    }
    setShadowJustAppeared(true);
    const id = window.setTimeout(() => setShadowJustAppeared(false), 4500);
    return () => window.clearTimeout(id);
  }, [shadowMode]);


  const isAgentGroup = rightPanelGroup === 'agent';
  const isFragmentTab =
    !isAgentGroup && (activeRightPanel === 'todo' || activeRightPanel === 'library');
  // Agent panels render their own headers, so hide the kicker/title block there.
  const hideTitleBlock = isAgentGroup || isFragmentTab;
  const headerKicker = isAgentGroup
    ? ''
    : activeRightPanel === 'stats'
      ? target.kicker.replace('片段与材料', '详细统计')
      : activeRightPanel === 'todo'
        ? '全项目 · TODO'
        : '全项目 · 素材库';
  const headerTitle = isAgentGroup
    ? ''
    : activeRightPanel === 'todo'
      ? 'TODO'
      : activeRightPanel === 'library'
        ? '素材库'
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
        background: 'hsl(var(--paper))',
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
            <RightSidebarHeader
              group="content"
              kicker=""
              title=""
              hideTitleBlock
            />
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
            <RightSidebarHeader
              group="agent"
              shadowJustAppeared={shadowJustAppeared}
              kicker=""
              title=""
              hideTitleBlock
            />
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
            shadowJustAppeared={shadowJustAppeared}
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
  bookElements: ReturnType<typeof useDataStore.getState>['bookElements'];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
  storylineNodeMapping: ReturnType<typeof useDataStore.getState>['storylineNodeMapping'];
  primaryStorylineByNode: ReturnType<
    typeof useDataStore.getState
  >['primaryStorylineByNode'];
}

function StatsView({
  target,
  bookNodes,
  bookElements,
  storylines,
  categories,
  storylineNodeMapping,
  primaryStorylineByNode,
}: StatsViewProps) {
  if (target.kind === 'chapter' || target.kind === 'drift') {
    const node = bookNodes.find((n) => n.id === target.id);
    if (!node) return <EmptyState message="找不到当前章节。" />;
    return (
      <ChapterStats
        node={node}
        storylines={storylines}
        bookElements={bookElements}
        categories={categories}
        target={target}
        primaryStorylineId={primaryStorylineByNode[node.id] ?? null}
      />
    );
  }
  if (target.kind === 'storyline') {
    const storyline = storylines.find((s) => s.id === target.id);
    if (!storyline) return <EmptyState message="找不到当前故事线。" />;
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
    if (!element) return <EmptyState message="找不到当前元素。" />;
    const category = categories.find((c) => c.id === element.categoryId);
    return <ElementStats element={element} category={category} />;
  }
  if (target.kind === 'category') {
    const category = categories.find((c) => c.id === target.id);
    if (!category) return <EmptyState message="找不到当前类目。" />;
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
  return <EmptyState message="项目主页暂无单项统计。打开一个章节、元素或故事线查看详情。" />;
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
  return (
    <button
      type="button"
      onClick={() => events.emit('snapshot-history:open', { entityKind, entityId })}
      title="浏览并恢复这个实体的历史版本（30 天）"
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
      ↺ 历史快照…
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
}: {
  node: ReturnType<typeof useDataStore.getState>['bookNodes'][number];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  bookElements: ReturnType<typeof useDataStore.getState>['bookElements'];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
  target: ResolvedTarget;
  primaryStorylineId: string | null;
}) {
  const storyline = primaryStorylineId
    ? storylines.find((s) => s.id === primaryStorylineId)
    : undefined;
  const targetWc = 3000; // placeholder until per-chapter goals exist
  const wcPct = Math.min(100, (node.wordCount / targetWc) * 100);
  const { stats, elements } = useChapterStatsData(node.id, node.updatedAt);
  const dialoguePct = stats ? Math.round(stats.dialogueRatio * 100) : 0;
  const { openEntity } = useProjectNavigation();
  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={target.kind === 'drift' ? '浮缀坐标' : '章节坐标'}>
        <MetaGrid>
          {storyline ? (
            <>
              <MetaK>Storyline</MetaK>
              <MetaV>
                <Dot color={storyline.color} />
                <SerifSpan>{storyline.name}</SerifSpan>
              </MetaV>
            </>
          ) : (
            <>
              <MetaK>类型</MetaK>
              <MetaV>
                <SerifSpan>{target.kind === 'drift' ? '浮缀 · 自由片段' : '章节'}</SerifSpan>
              </MetaV>
            </>
          )}
          {node.bookOrder != null && (
            <>
              <MetaK>书序</MetaK>
              <MetaV>第 {node.bookOrder} 章</MetaV>
            </>
          )}
          <MetaK>最近修改</MetaK>
          <MetaV>
            <SerifSpan>{formatDateTime(node.updatedAt)}</SerifSpan>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      <StatsSection title="字数 · 节奏" topBorder>
        <StatsRow k="已写 / 目标" v={`${node.wordCount.toLocaleString()} / ${targetWc.toLocaleString()}`}>
          <ProgressBar pct={wcPct} />
        </StatsRow>
        <StatsRow
          k="段落 / 句"
          v={stats ? `${stats.paragraphs} 段 · ${stats.sentences} 句` : '—'}
          placeholder={!stats}
        />
        <StatsRow k="对白比" v={stats ? `${dialoguePct}%` : '—'} placeholder={!stats}>
          {stats && <ProgressBar pct={dialoguePct} />}
        </StatsRow>
      </StatsSection>

      <StatsSection title={target.kind === 'drift' ? '本篇元素' : '本章元素'} topBorder>
        {elements && elements.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {elements.map(({ elementId, mentionCount }) => {
              const el = bookElements.find((e) => e.id === elementId);
              if (!el) return null;
              const cat = categories.find((c) => c.id === el.categoryId);
              return (
                <StatsLinkRow
                  key={elementId}
                  name={el.name || 'Untitled'}
                  color={cat?.color}
                  meta={`×${mentionCount}`}
                  onOpen={() => openEntity({ entityType: 'element', id: elementId })}
                />
              );
            })}
          </div>
        ) : (
          <Notes>{elements ? '正文尚未 @ 提及任何元素。' : '统计加载中…'}</Notes>
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
}: {
  name: string;
  color?: string;
  /** Optional right-aligned mono annotation, e.g. "×12" or "3 个元素". */
  meta?: string;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen();
      }}
      title={`打开元素「${name}」`}
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
          fontFamily: 'var(--font-serif)',
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
  const activeTotal = STORYLINE_STATUS_ORDER.reduce(
    (a, s) => a + (statusCounts.get(s) ?? 0),
    0,
  );

  const coreElements = useStorylineCoreElements(useMemo(() => nodes.map((n) => n.id), [nodes]));

  return (
    <div style={{ padding: 12 }}>
      <StatsSection title="故事线坐标">
        <MetaGrid>
          <MetaK>Storyline</MetaK>
          <MetaV>
            <Dot color={storyline.color} />
            <SerifSpan>{storyline.name}</SerifSpan>
          </MetaV>
          <MetaK>章数</MetaK>
          <MetaV>{total} 章</MetaV>
          <MetaK>最近</MetaK>
          <MetaV>
            <SerifSpan>{formatDateTime(storyline.updatedAt)}</SerifSpan>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      <StatsSection title="写作进度" topBorder>
        {activeTotal === 0 ? (
          <Notes>这条线还没有章节。</Notes>
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
                    title={`${WRITING_STATUS_LABELS[s]} ${n} 章`}
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
                .map((s) => `${WRITING_STATUS_LABELS[s]} ${statusCounts.get(s)}`)
                .join(' · ') || '—'}
              {discarded > 0 && `（弃用 ${discarded}）`}
            </div>
            <StatsRow k="平均字数" v={`${avgWc.toLocaleString()} 字 / 章`} />
          </>
        )}
      </StatsSection>

      <StatsSection title="本线核心元素" topBorder>
        {coreElements === null ? (
          <Notes>统计加载中…</Notes>
        ) : coreElements.length === 0 ? (
          <Notes>本线章节正文尚未 @ 提及任何元素。</Notes>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {coreElements.slice(0, 8).map(({ elementId, mentionCount }) => {
              const el = bookElements.find((e) => e.id === elementId);
              if (!el) return null;
              const cat = categories.find((c) => c.id === el.categoryId);
              return (
                <StatsLinkRow
                  key={elementId}
                  name={el.name || 'Untitled'}
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
                还有 {coreElements.length - 8} 个元素出场较少
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
  return (
    <div style={{ padding: 12 }}>
      <StatsSection title="元素坐标">
        <MetaGrid>
          <MetaK>类目</MetaK>
          <MetaV>
            {category && <Dot color={category.color} />}
            <SerifSpan>{category?.name ?? '—'}</SerifSpan>
          </MetaV>
          <MetaK>名称</MetaK>
          <MetaV>
            <SerifSpan>{element.name}</SerifSpan>
          </MetaV>
          <MetaK>更新</MetaK>
          <MetaV>
            <SerifSpan>{formatDateTime(element.updatedAt)}</SerifSpan>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      {/* 被引用 / 引用其他 — the same read-only projections the element
          editor used to host in its body; the editor keeps only the
          editable 关联 section. */}
      <StatsSection title="引用" topBorder>
        <ReferencesPanel
          entityKind="element"
          entityId={element.id}
          projectId={element.projectId}
          sections={['incoming', 'outgoing']}
          numStart={null}
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
  primaryStorylineByNode: ReturnType<
    typeof useDataStore.getState
  >['primaryStorylineByNode'];
}) {
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
      <StatsSection title="类目坐标">
        <MetaGrid>
          <MetaK>Category</MetaK>
          <MetaV>
            <Dot color={category.color} />
            <SerifSpan>{category.name}</SerifSpan>
          </MetaV>
          <MetaK>元素数</MetaK>
          <MetaV>{total} 个</MetaV>
        </MetaGrid>
      </StatsSection>

      <StatsSection title="健康度" topBorder>
        {health === null ? (
          <Notes>统计加载中…</Notes>
        ) : total === 0 ? (
          <Notes>类目下还没有元素。</Notes>
        ) : (
          <>
            <StatsRow k="已出场" v={`${appeared} / ${total}`}>
              <ProgressBar pct={(appeared / total) * 100} color={category.color} />
            </StatsRow>
            <StatsRow
              k="平均出场"
              v={appeared > 0 ? `${avgChapters.toFixed(1)} 章 / 元素` : '—'}
              placeholder={appeared === 0}
            />
          </>
        )}
      </StatsSection>

      {health !== null && total > 0 && (
        <StatsSection title="未出场元素" topBorder>
          {unappeared.length === 0 ? (
            <Notes>所有元素都已在正文出场。</Notes>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {unappeared.slice(0, 20).map((el) => (
                <StatsLinkRow
                  key={el.id}
                  name={el.name || 'Untitled'}
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
                  还有 {unappeared.length - 20} 个未出场
                </div>
              )}
            </div>
          )}
        </StatsSection>
      )}

      {storylineRows.length > 0 && (
        <StatsSection title="故事线分布" topBorder>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {storylineRows.map(({ slId, count, storyline }) =>
              storyline ? (
                <StatsLinkRow
                  key={slId}
                  name={storyline.name}
                  color={storyline.color}
                  meta={`${count} 个元素`}
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
                      fontFamily: 'var(--font-serif)',
                      fontSize: 13,
                      color: 'hsl(var(--ink-3))',
                      flex: 1,
                    }}
                  >
                    漂浮 / 未归线
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'hsl(var(--ink-3))',
                    }}
                  >
                    {count} 个元素
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
          fontFamily: 'var(--font-serif)',
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
      style={{ fontSize: 12, color: 'hsl(var(--ink-2))', display: 'flex', alignItems: 'center', gap: 6 }}
    >
      {children}
    </div>
  );
}

function SerifSpan({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: 'var(--font-serif)', fontSize: 13, fontStyle: 'italic' }}>
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
        fontFamily: 'var(--font-serif)',
        fontStyle: 'italic',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'hsl(var(--ink-2))',
        padding: '8px 10px',
        background: 'hsl(var(--ink-1) / 0.03)',
        borderLeft: '2px solid hsl(var(--ink-5))',
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '40px 20px',
        textAlign: 'center',
        fontFamily: 'var(--font-serif)',
        fontStyle: 'italic',
        fontSize: 12,
        color: 'hsl(var(--ink-3))',
      }}
    >
      {message}
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
