import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../store/data-store';
import { isDrift } from '../../domain/book-node';
import { getChapterContentJson } from '../../lib/agent/chapter-prose';
import { computeProseStats, type ProseStats } from '../../lib/prose-stats';
import { createInlineMentionRepository } from '../../sqlite-repo/inline-mention-repo';
import { ReferencesPanel } from '../../components/editor/ReferencesPanel';
import { getWritingStatusLabel } from '../../components/editor/EditorTopBar';
import { events } from '../../lib/events';
import type { ProseEntityType } from '../../lib/yjs-doc-id';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { EmptyState } from '../../components/ui/EmptyState';
import type { EntityStatsTarget } from './entity-stats-types';
import { AllChaptersStats } from './AllChaptersStats';
import {
  DetailValue,
  Dot,
  formatDateTime,
  MetaGrid,
  MetaK,
  MetaV,
  Notes,
  ProgressBar,
  StatsLinkRow,
  StatsRow,
  StatsSection,
} from './StatsPrimitives';

interface StatsViewProps {
  target: EntityStatsTarget;
  bookNodes: ReturnType<typeof useDataStore.getState>['bookNodes'];
  bookActs: ReturnType<typeof useDataStore.getState>['bookActs'];
  bookElements: ReturnType<typeof useDataStore.getState>['bookElements'];
  storylines: ReturnType<typeof useDataStore.getState>['storylines'];
  categories: ReturnType<typeof useDataStore.getState>['bookElementCategories'];
  storylineNodeMapping: ReturnType<typeof useDataStore.getState>['storylineNodeMapping'];
  primaryStorylineByNode: ReturnType<typeof useDataStore.getState>['primaryStorylineByNode'];
}

export function EntityStatsContent({
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
  target: EntityStatsTarget;
  primaryStorylineId: string | null;
  chapterNumber: number | null;
}) {
  const { t } = useTranslation();
  const storyline = primaryStorylineId
    ? storylines.find((s) => s.id === primaryStorylineId)
    : undefined;
  const { stats, elements } = useChapterStatsData(node.id, node.updatedAt);
  const dialoguePct = stats ? Math.round(stats.dialogueRatio * 100) : 0;
  const { open: openEntity } = useWorkspaceNavigator();
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

/** Manual-pick chapter statuses, in stacked-bar order (most → least done). */
const STORYLINE_STATUS_ORDER = ['finished', 'draft'] as const;
const STORYLINE_STATUS_OPACITY: Record<(typeof STORYLINE_STATUS_ORDER)[number], number> = {
  finished: 1,
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
  const { open: openEntity } = useWorkspaceNavigator();

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
  const { open: openEntity } = useWorkspaceNavigator();
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
