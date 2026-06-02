import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataStore } from '../../store/data-store';
import { isDrift } from '../../domain/book-node';
import { useUiStore, useProjectTabs, focusedLeafOf, tabKey } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { RightSidebarHeader } from './RightSidebarHeader';
import { LibraryPanel, type FocusedEntity } from './MemoMaterialPanel';
import { TodoPanel } from './TodoPanel';
import { CompanionPanel } from '../agent/CompanionPanel';
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

  // Shadow review count was previously sourced from the mocked notification
  // stack; now that the stack is gone we leave the badge at 0 until a real
  // backing store lands.
  const shadowReviewCount = 0;

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
              shadowReviewCount={shadowReviewCount}
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
              shadowReviewCount={shadowReviewCount}
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
            shadowReviewCount={shadowReviewCount}
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
    return <StorylineStats storyline={storyline} nodes={nodes} />;
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
    return <CategoryStats category={category} elements={cElements} />;
  }
  return <EmptyState message="项目主页暂无单项统计。打开一个章节、元素或故事线查看详情。" />;
}

function ChapterStats({
  node,
  storylines,
  target,
  primaryStorylineId,
}: {
  node: ReturnType<typeof useDataStore.getState>['bookNodes'][number];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  target: ResolvedTarget;
  primaryStorylineId: string | null;
}) {
  const storyline = primaryStorylineId
    ? storylines.find((s) => s.id === primaryStorylineId)
    : undefined;
  const targetWc = 3000; // placeholder until per-chapter goals exist
  const wcPct = Math.min(100, (node.wordCount / targetWc) * 100);
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
        <StatsRow k="段落 / 句" v="—" placeholder />
        <StatsRow k="对白比" v="—" placeholder />
        <StatsRow k="修订" v="—" placeholder />
      </StatsSection>

      <StatsSection title="案头札记" topBorder>
        <Notes>暂未记录札记。</Notes>
      </StatsSection>
    </div>
  );
}

function StorylineStats({
  storyline,
  nodes,
}: {
  storyline: ReturnType<typeof useDataStore.getState>['storylines'][number];
  nodes: ReturnType<typeof useDataStore.getState>['bookNodes'];
}) {
  const total = nodes.length;
  const totalWc = nodes.reduce((a, n) => a + (n.wordCount || 0), 0);
  const targetWc = total > 0 ? total * 2800 : 1;
  const avgWc = total ? Math.round(totalWc / total) : 0;
  const wcPct = Math.min(100, (totalWc / targetWc) * 100);
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
        </MetaGrid>
      </StatsSection>

      <StatsSection title="字数 · 进度" topBorder>
        <StatsRow
          k="已写 / 目标"
          v={`${(totalWc / 1000).toFixed(1)}k / ${(targetWc / 1000).toFixed(0)}k`}
        >
          <ProgressBar pct={wcPct} color={storyline.color} />
        </StatsRow>
        <StatsRow k="平均字数" v={`${avgWc.toLocaleString()} 字 / 章`} />
        <StatsRow k="章节总数" v={`${total}`} />
      </StatsSection>

      <StatsSection title="最近修改" topBorder>
        <MetaGrid>
          <MetaK>最近</MetaK>
          <MetaV>
            <SerifSpan>{formatDateTime(storyline.updatedAt)}</SerifSpan>
          </MetaV>
        </MetaGrid>
      </StatsSection>
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

      <StatsSection title="出场密度" topBorder>
        <StatsRow k="出场次数" v="—" placeholder />
        <StatsRow k="首次出场" v="—" placeholder />
        <StatsRow k="末次出场" v="—" placeholder />
      </StatsSection>
    </div>
  );
}

function CategoryStats({
  category,
  elements,
}: {
  category: ReturnType<typeof useDataStore.getState>['bookElementCategories'][number];
  elements: ReturnType<typeof useDataStore.getState>['bookElements'];
}) {
  const total = elements.length;
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
        <StatsRow k="已出场" v="—" placeholder>
          <ProgressBar pct={0} color={category.color} />
        </StatsRow>
        <StatsRow k="≥10 mentions" v="—" placeholder />
        <StatsRow k="未出场" v="—" placeholder />
        <StatsRow k="平均出场" v="—" placeholder />
      </StatsSection>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow tab (mock)

function ShadowAgentView() {
  const tasks: { id: string; state: 'running' | 'queued' | 'done'; title: string; meta: string }[] = [
    { id: 't1', state: 'running', title: '通读卷一 · 寻找 plot hole', meta: '已读 8/14 章 · 12 分钟前' },
    { id: 't2', state: 'running', title: '核对所有"红绳"出场上下文', meta: '19/27 处 · 3 分钟前' },
    { id: 't3', state: 'queued', title: '检查卷二与卷三之间叙事时连贯性', meta: '排队中' },
    { id: 't4', state: 'done', title: '一处叙述视角越界 (已采纳)', meta: '昨天' },
  ];
  return (
    <div style={{ padding: 12 }}>
      <div
        style={{
          padding: '10px 12px',
          margin: '0 0 12px',
          borderRadius: 4,
          border: '1px dashed hsl(var(--accent))',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.12em',
            color: 'hsl(var(--accent))',
          }}
        >
          ＋ 派发 SHADOW 任务
        </div>
        <div
          style={{
            fontStyle: 'italic',
            color: 'hsl(var(--ink-3))',
            fontSize: 13,
            marginTop: 4,
            fontFamily: 'var(--font-serif)',
          }}
        >
          通读某段，找设定矛盾 / 通读全书，找视角问题 / ⋯
        </div>
      </div>

      {tasks.map((t) => (
        <div
          key={t.id}
          style={{
            padding: '10px 12px',
            margin: '0 0 8px',
            borderRadius: 4,
            border: '1px solid hsl(var(--rule))',
            borderLeft: `2px solid ${
              t.state === 'running'
                ? 'hsl(var(--accent))'
                : t.state === 'queued'
                  ? 'hsl(var(--ink-4))'
                  : 'hsl(var(--story-3))'
            }`,
            background: 'hsl(var(--surface))',
            opacity: t.state === 'done' ? 0.55 : 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'hsl(var(--ink-4))',
              marginBottom: 4,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background:
                    t.state === 'running'
                      ? 'hsl(var(--accent))'
                      : t.state === 'queued'
                        ? 'hsl(var(--ink-4))'
                        : 'hsl(var(--story-3))',
                }}
              />
              {t.state.toUpperCase()}
            </span>
            <span>⋯</span>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 13.5,
              color: 'hsl(var(--ink-1))',
              lineHeight: 1.35,
            }}
          >
            {t.title}
          </div>
          <div
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'hsl(var(--ink-4))',
              letterSpacing: '0.04em',
            }}
          >
            {t.meta}
          </div>
        </div>
      ))}
    </div>
  );
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
