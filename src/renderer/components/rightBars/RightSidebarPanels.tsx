import { useEffect, useMemo, useState } from 'react';
import { useDataStore } from '../../store/data-store';
import { useUiStore, useProjectTabs, focusedLeafOf, tabKey } from '../../store/ui-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { RightSidebarHeader } from './RightSidebarHeader';

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
  const activeRightPanel = useUiStore((s) => s.activeRightPanel);
  const setActiveRightPanel = useUiStore((s) => s.setActiveRightPanel);
  const shadowMode = useUiStore((s) => s.shadowMode);

  const { bookNodes, bookElements, storylines, bookElementCategories, storylineNodeMapping } =
    useDataStore();

  // Decode the active tab into a resolved target so the right panel can show
  // entity-specific context. Falls back to "no target" on the project home.
  const target = useMemo<ResolvedTarget>(() => {
    // Per the focused-only selection model, the right sidebar tracks the
    // focused side of the active tab regardless of whether it's a single
    // leaf or a split. The non-focused half of a split doesn't reflect here.
    const activeTab = openTabs.find((t) => tabKey(t) === activeTabKey);
    if (!activeTab) {
      return { kind: 'none', id: null, title: '项目主页', kicker: '本项目 · 概览' };
    }
    const leaf = focusedLeafOf(activeTab);
    if (leaf.entityType === 'node') {
      const node = bookNodes.find((n) => n.id === leaf.id);
      if (!node) return { kind: 'none', id: leaf.id, title: '—', kicker: '—' };
      const isDrift = node.mainStorylineId == null;
      const storyline = node.mainStorylineId
        ? storylines.find((s) => s.id === node.mainStorylineId)
        : undefined;
      return {
        kind: isDrift ? 'drift' : 'chapter',
        id: node.id,
        title: node.title || (isDrift ? 'Untitled Drift' : 'Untitled Chapter'),
        kicker: isDrift ? '本灵感 · 片段与参考' : '本章 · 片段与参考',
        color: storyline?.color,
      };
    }
    if (leaf.entityType === 'storyline') {
      const s = storylines.find((sl) => sl.id === leaf.id);
      return {
        kind: 'storyline',
        id: leaf.id,
        title: s?.name || 'Untitled Storyline',
        kicker: '本故事线 · 片段与参考',
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
        kicker: '本元素 · 片段与参考',
        color: cat?.color,
      };
    }
    if (leaf.entityType === 'category') {
      const c = bookElementCategories.find((cat) => cat.id === leaf.id);
      return {
        kind: 'category',
        id: leaf.id,
        title: c?.name || leaf.id,
        kicker: '本类目 · 片段与参考',
        color: c?.color,
      };
    }
    return { kind: 'none', id: null, title: '—', kicker: '—' };
  }, [activeTabKey, openTabs, bookNodes, bookElements, storylines, bookElementCategories]);

  // Fragments are per-entity. Backing data isn't wired yet, so we synthesize
  // mock fragments keyed by target.id and let the user mark/uncheck locally.
  const fragments = useMemo(() => makeMockFragments(target), [target]);
  const [fragmentCountFlash, setFragmentCountFlash] = useState(false);
  const [shadowJustAppeared, setShadowJustAppeared] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [flyingId, setFlyingId] = useState<string | null>(null);

  const initialShadowOutput = useMemo<ShadowStackItem[]>(
    () => [
      { id: 'so1', kind: 'patch', title: '陆秋白年龄前后不一致', ctx: '本章 § 段二 ↔ 卷一 § 03' },
      { id: 'so2', kind: 'note', title: '"霓虹店"建议登记为元素 · 地点', ctx: '卷三 § 02 暗示真实' },
      { id: 'so3', kind: 'patch', title: '段五林望舒视角越界（描写沈砚心理）', ctx: '建议改第三人称受限' },
      { id: 'so4', kind: 'note', title: '霞飞路英文拼写本章为 "Joffr"，前文为 "Joffre"', ctx: '需统一' },
      { id: 'so5', kind: 'note', title: '可裁剪：第六段对话冗余 ~ 120 字', ctx: 'shadow 建议' },
    ],
    [],
  );
  const [shadowOutput, setShadowOutput] = useState<ShadowStackItem[]>(initialShadowOutput);
  const shadowReviewCount = shadowOutput.length;

  // Pulse the Shadow tab the first ~4.5s after the user invokes shadow mode.
  useEffect(() => {
    if (!shadowMode) {
      setShadowJustAppeared(false);
      return;
    }
    setShadowJustAppeared(true);
    const id = window.setTimeout(() => setShadowJustAppeared(false), 4500);
    return () => window.clearTimeout(id);
  }, [shadowMode]);

  // If we land on the right panel with shadow off and stale "shadow" selection
  // (defensive — store should already coerce), step it back to fragments.
  useEffect(() => {
    if (!shadowMode && activeRightPanel === 'shadow') {
      setActiveRightPanel('fragments');
    }
  }, [shadowMode, activeRightPanel, setActiveRightPanel]);

  const handleConvertToFragment = (item: ShadowStackItem) => {
    setFlyingId(item.id);
    window.setTimeout(() => {
      setShadowOutput((prev) => prev.filter((s) => s.id !== item.id));
      setFlyingId(null);
      setFragmentCountFlash(true);
      window.setTimeout(() => setFragmentCountFlash(false), 700);
    }, 460);
  };

  const handleApply = (item: ShadowStackItem) => {
    setFlyingId(item.id);
    window.setTimeout(() => {
      setShadowOutput((prev) => prev.filter((s) => s.id !== item.id));
      setFlyingId(null);
    }, 460);
  };

  const headerKicker = activeRightPanel === 'shadow'
    ? 'Shadow Agent · 跨章节任务'
    : activeRightPanel === 'stats'
      ? target.kicker.replace('片段与参考', '详细统计')
      : target.kicker;
  const headerTitle = activeRightPanel === 'shadow' ? '全书 · 跨章节' : target.title;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'hsl(var(--paper))',
      }}
    >
      {activeRightPanel === 'shadow' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: 'hsl(var(--accent))',
            background: 'hsl(var(--accent) / 0.06)',
            borderBottom: '1px solid hsl(var(--accent) / 0.18)',
          }}
        >
          <span style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12 }}>
            ◐
          </span>
          <span>GLOBAL · 不限本章 · SHADOW 跨章节</span>
        </div>
      )}

      <RightSidebarHeader
        fragmentCount={fragments.length}
        shadowReviewCount={shadowReviewCount}
        kicker={headerKicker}
        title={headerTitle}
        fragmentCountFlash={fragmentCountFlash}
        shadowJustAppeared={shadowJustAppeared}
      />

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {activeRightPanel === 'fragments' && <FragmentsView fragments={fragments} />}
        {activeRightPanel === 'stats' && (
          <StatsView
            target={target}
            bookNodes={bookNodes}
            bookElements={bookElements}
            storylines={storylines}
            categories={bookElementCategories}
            storylineNodeMapping={storylineNodeMapping}
          />
        )}
        {activeRightPanel === 'shadow' && <ShadowAgentView />}
      </div>

      {shadowOutput.length > 0 && (
        <ShadowStack
          items={shadowOutput}
          open={stackOpen}
          flyingId={flyingId}
          onToggle={() => setStackOpen((v) => !v)}
          onConvert={handleConvertToFragment}
          onApply={handleApply}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragments

type Fragment = {
  id: string;
  kind: 'idea' | 'todo' | 'ref';
  tag: string;
  title: string;
  quote?: string;
  meta: string;
  done?: boolean;
};

function makeMockFragments(target: ResolvedTarget): Fragment[] {
  // Tie a stable seed of fragments to the target id so switching entities
  // doesn't shuffle them around. These are placeholders until the real
  // fragments backend ships.
  if (!target.id) return [];
  const base: Fragment[] = [
    {
      id: 'f1',
      kind: 'idea',
      tag: '灵感',
      title: '写到沈砚出场时，可以让雨势骤然变小 — 衬"决断"的安静。',
      meta: '今早 · 未分配',
    },
    {
      id: 'f2',
      kind: 'todo',
      tag: 'TODO',
      title: '补"号外"那个报童的几行外貌描写。',
      meta: '昨天 · 章节内',
      done: false,
    },
    {
      id: 'f3',
      kind: 'ref',
      tag: '参考',
      title: '《上海一日》1937 街市夜景',
      quote: '"雨水打在霓虹店招上，像把朱红颜色泼散开来。"',
      meta: '从资料库 → 当前章节',
    },
    {
      id: 'f4',
      kind: 'todo',
      tag: 'TODO',
      title: '把对话节奏从"急促"调整为"绵延"，少用句号。',
      meta: '修订建议',
      done: true,
    },
  ];
  return base;
}

function FragmentsView({ fragments }: { fragments: Fragment[] }) {
  if (fragments.length === 0) {
    return (
      <EmptyState message="当前条目还没有片段。从灵感、TODO 或资料库添加。" />
    );
  }
  return (
    <div style={{ padding: 12 }}>
      {fragments.map((f) => (
        <FragmentCard key={f.id} fragment={f} />
      ))}
    </div>
  );
}

function FragmentCard({ fragment }: { fragment: Fragment }) {
  const accent =
    fragment.kind === 'idea' ? 'hsl(var(--story-5))'
    : fragment.kind === 'todo' ? 'hsl(var(--story-2))'
    : 'hsl(var(--story-4))';
  return (
    <div
      style={{
        padding: '10px 12px',
        margin: '0 0 8px',
        borderRadius: 4,
        border: '1px solid hsl(var(--rule))',
        borderLeft: `2px solid ${accent}`,
        background: 'hsl(var(--surface))',
        cursor: 'pointer',
        transition: 'border-color 0.15s, background 0.15s',
        opacity: fragment.done ? 0.55 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsl(var(--paper-deep) / 0.4)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'hsl(var(--surface))';
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
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
              background: accent,
              display: 'inline-block',
            }}
          />
          {fragment.tag}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'hsl(var(--ink-4))' }}>
          {fragment.kind === 'todo' ? (fragment.done ? '✓ DONE' : '○ TODO') : '⋯'}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 13.5,
          color: 'hsl(var(--ink-1))',
          lineHeight: 1.4,
          letterSpacing: '0.005em',
          textDecoration: fragment.done ? 'line-through' : 'none',
        }}
      >
        {fragment.title}
      </div>
      {fragment.quote && (
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 12.5,
            color: 'hsl(var(--ink-3))',
            lineHeight: 1.5,
            paddingLeft: 8,
            borderLeft: '2px solid hsl(var(--rule))',
            marginTop: 6,
          }}
        >
          {fragment.quote}
        </div>
      )}
      <div
        style={{
          marginTop: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
          letterSpacing: '0.04em',
        }}
      >
        {fragment.meta}
      </div>
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
}

function StatsView({
  target,
  bookNodes,
  bookElements,
  storylines,
  categories,
  storylineNodeMapping,
}: StatsViewProps) {
  if (target.kind === 'chapter' || target.kind === 'drift') {
    const node = bookNodes.find((n) => n.id === target.id);
    if (!node) return <EmptyState message="找不到当前章节。" />;
    return <ChapterStats node={node} storylines={storylines} target={target} />;
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
}: {
  node: ReturnType<typeof useDataStore.getState>['bookNodes'][number];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  target: ResolvedTarget;
}) {
  const storyline = node.mainStorylineId
    ? storylines.find((s) => s.id === node.mainStorylineId)
    : undefined;
  const targetWc = 3000; // placeholder until per-chapter goals exist
  const wcPct = Math.min(100, (node.wordCount / targetWc) * 100);
  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={target.kind === 'drift' ? '灵感坐标' : '章节坐标'}>
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
                <SerifSpan>{target.kind === 'drift' ? '灵感 · 自由片段' : '章节'}</SerifSpan>
              </MetaV>
            </>
          )}
          <MetaK>书序</MetaK>
          <MetaV>第 {node.bookOrder} 章</MetaV>
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

// ─────────────────────────────────────────────────────────────────────────────
// Shadow stack — bottom-pinned notification pile (mock)

type ShadowStackItem = {
  id: string;
  kind: 'patch' | 'note';
  title: string;
  ctx: string;
};

/**
 * iOS-lockscreen-style notification pile. Front (newest) card is fully visible
 * and interactive; up to STACK_MAX_VISIBLE older cards peek out behind, scaled
 * and faded so the user reads them as a "queue." Clicking the front card (or
 * the drag handle) expands the stack into a scrollable list with per-card
 * actions visible.
 */
const STACK_MAX_VISIBLE = 3; // how many cards peek out behind the front one
const STACK_BACK_OFFSET = 8; // px each back card pokes above the front card
const STACK_BACK_SCALE = 0.04; // scale step per back card
const STACK_FRONT_HEIGHT = 92; // approximate front-card height incl. padding

function ShadowStack({
  items,
  open,
  flyingId,
  onToggle,
  onConvert,
  onApply,
}: {
  items: ShadowStackItem[];
  open: boolean;
  flyingId: string | null;
  onToggle: () => void;
  onConvert: (item: ShadowStackItem) => void;
  onApply: (item: ShadowStackItem) => void;
}) {
  // Cap how many cards we render in the collapsed peek (rest only appear on
  // expand, to keep the absolute-positioned pile readable).
  const peekDepth = Math.min(items.length, STACK_MAX_VISIBLE);
  const collapsedHeight = STACK_FRONT_HEIGHT + (peekDepth - 1) * STACK_BACK_OFFSET;

  return (
    <>
      <style>{`
        @keyframes shadow-card-fly {
          0%   { transform: translateY(0) scale(1); opacity: 1; }
          70%  { transform: translateY(-180px) scale(0.85); opacity: 0.6; }
          100% { transform: translateY(-360px) scale(0.4); opacity: 0; }
        }
        .shadow-card--flying { pointer-events: none; animation: shadow-card-fly 480ms cubic-bezier(0.4, 0, 0.6, 1) forwards; z-index: 30; }
      `}</style>
      <div
        style={{
          flexShrink: 0,
          padding: '0 12px 12px',
          background: 'transparent',
          borderTop: open ? '1px solid hsl(var(--rule))' : 'none',
          position: 'relative',
        }}
      >
        {open && (
          <div
            onClick={onToggle}
            style={{
              position: 'absolute',
              top: 4,
              right: 14,
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
              padding: '2px 6px',
              borderRadius: 3,
              zIndex: 10,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'hsl(var(--paper-deep))';
              e.currentTarget.style.color = 'hsl(var(--ink-1))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'hsl(var(--ink-4))';
            }}
          >
            收起 ▾
          </div>
        )}

        <div
          onClick={() => !open && onToggle()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 14,
            cursor: 'pointer',
            opacity: 0.6,
          }}
          title={open ? '收起' : '展开'}
        >
          <span
            style={{
              width: 36,
              height: 3,
              background: 'hsl(var(--ink-5))',
              borderRadius: 2,
              display: 'inline-block',
            }}
          />
        </div>

        {/* Two layout modes share the same data so cards animate between them
            smoothly: collapsed = absolutely-positioned pile; open = scrollable
            flow list. */}
        {open ? (
          <div
            style={{
              maxHeight: '50vh',
              overflowY: 'auto',
              paddingTop: 4,
              transition: 'max-height 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          >
            {items.map((it) => (
              <ShadowCard
                key={it.id}
                item={it}
                flying={flyingId === it.id}
                onConvert={onConvert}
                onApply={onApply}
              />
            ))}
          </div>
        ) : (
          <div
            style={{
              position: 'relative',
              height: collapsedHeight,
              transition: 'height 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          >
            {items.slice(0, STACK_MAX_VISIBLE).map((it, idx) => {
              const isFront = idx === 0;
              // Front card pins to the bottom; back cards rise above it.
              const bottomPx = idx * STACK_BACK_OFFSET;
              const scale = 1 - idx * STACK_BACK_SCALE;
              const opacity = idx === 0 ? 1 : idx === 1 ? 0.75 : 0.45;
              return (
                <div
                  key={it.id}
                  className={flyingId === it.id ? 'shadow-card--flying' : undefined}
                  onClick={isFront ? onToggle : undefined}
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: bottomPx,
                    transform: `scale(${scale})`,
                    transformOrigin: 'bottom center',
                    opacity,
                    zIndex: STACK_MAX_VISIBLE - idx,
                    pointerEvents: isFront ? 'auto' : 'none',
                    transition:
                      'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1), bottom 280ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 220ms ease',
                  }}
                >
                  <ShadowCard
                    item={it}
                    flying={false /* fly anim handled on the wrapper */}
                    showActions={isFront}
                    onConvert={onConvert}
                    onApply={onApply}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function ShadowCard({
  item,
  flying,
  showActions = true,
  onConvert,
  onApply,
}: {
  item: ShadowStackItem;
  flying?: boolean;
  showActions?: boolean;
  onConvert: (item: ShadowStackItem) => void;
  onApply: (item: ShadowStackItem) => void;
}) {
  return (
    <div
      className={flying ? 'shadow-card--flying' : undefined}
      style={{
        background: 'hsl(var(--surface))',
        border: '1px solid hsl(var(--rule))',
        borderLeft: `2px solid ${
          item.kind === 'patch' ? 'hsl(var(--accent))' : 'hsl(var(--story-2))'
        }`,
        borderRadius: 5,
        padding: '8px 10px',
        marginBottom: 6,
        boxShadow: '0 -2px 8px -3px hsl(var(--ink-1) / 0.10), 0 -8px 16px -10px hsl(var(--ink-1) / 0.10)',
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'hsl(var(--ink-4))',
          marginBottom: 3,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 12,
            fontStyle: 'italic',
            color: 'hsl(var(--accent))',
          }}
        >
          {item.kind === 'patch' ? '◐' : '✦'}
        </span>
        {item.kind === 'patch' ? '修订建议' : '观察'}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 13.5,
          color: 'hsl(var(--ink-1))',
          lineHeight: 1.35,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.title}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-3))',
          marginTop: 3,
        }}
      >
        {item.ctx}
      </div>
      {showActions && (
        <div
          style={{ display: 'flex', gap: 6, marginTop: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          <ShadowCardBtn>查看</ShadowCardBtn>
          <ShadowCardBtn onClick={() => onConvert(item)}>转为片段</ShadowCardBtn>
          <ShadowCardBtn primary onClick={() => onApply(item)}>
            应用
          </ShadowCardBtn>
        </div>
      )}
    </div>
  );
}

function ShadowCardBtn({
  primary,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        padding: '4px 8px',
        borderRadius: 3,
        border: '1px solid hsl(var(--rule))',
        background: primary ? 'hsl(var(--ink-1))' : 'transparent',
        color: primary ? 'hsl(var(--paper))' : 'hsl(var(--ink-2))',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared bits

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
