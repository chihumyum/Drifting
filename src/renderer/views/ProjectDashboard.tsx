import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilterChip } from '../components/ui/FilterChip';
import { useDataStore } from '../store/data-store';
import { useStoryline } from '../usecase/useStoryline';
import { useProject } from '../usecase/useProject';
import { useElementCategory } from '../usecase/useElementCategory';
import { useAuthStore } from '../store/auth';
import { useProjectStore } from '../store/project-store';
import { useUiStore } from '../store/ui-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useRecentEntitiesStore } from '../store/recent-entities-store';
import { useWritingStatsStore, deriveWritingStats } from '../store/writing-stats-store';
import { KvEditor } from '../components/editor/KvEditor';
import {
  canonicalWordCount,
  deriveStatus,
  isChapter,
  sumCanonicalChapterWordCounts,
  type BookNode,
} from '../domain/book-node';
import { getPlatformRuntime } from '../platform/runtime';
import { useSyncObserver } from '../services/sync-observer.service';
import {
  BookOpen,
  Boxes,
  GitBranch,
  LayoutDashboard,
  ListTree,
  Plus,
  Settings2,
} from 'lucide-react';
import loglevel from 'loglevel';
import '../../styles/dashboard.css';

const log = loglevel.getLogger('ProjectDashboard');
type DashboardView = 'overview' | 'structure';

const STORY_TOKENS = [
  '--story-1',
  '--story-2',
  '--story-3',
  '--story-4',
  '--story-5',
  '--story-6',
] as const;

function hashToToken(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i) * (i + 7)) >>> 0;
  return STORY_TOKENS[h % STORY_TOKENS.length];
}

/** Resolve a stored color (hex / css color) or fall back to a hashed story token. */
function resolveColor(rawColor: string | undefined, fallbackKey: string): string {
  if (rawColor && rawColor.trim().length > 0) return rawColor;
  return `hsl(var(${hashToToken(fallbackKey)}))`;
}

function isZh(locale: string): boolean {
  return locale.startsWith('zh');
}

function formatRelativeTime(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  const zh = isZh(locale);
  if (diffSec < 60) return zh ? '刚刚' : 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return zh ? `${diffMin} 分钟前` : `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return zh ? `${diffHr} 小时前` : `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return zh ? `${diffDay} 天前` : `${diffDay} days ago`;
  return new Date(iso).toLocaleDateString(locale);
}

interface ProjectProfileEditorProps {
  summary: string;
  onPersist: (nextSummary: string) => void;
}

function ProjectProfileEditor({ summary, onPersist }: ProjectProfileEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(summary);

  const persistDraft = () => {
    const nextSummary = draft.trim();
    if (nextSummary !== summary) onPersist(nextSummary);
  };

  return (
    <div className="dash-profile">
      <label className="dash-profile__field">
        <textarea
          className="dash-profile__textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={persistDraft}
          placeholder={t('dashboard.profilePlaceholder')}
          rows={5}
        />
      </label>
    </div>
  );
}

export function ProjectDashboard() {
  const { t, i18n } = useTranslation();
  const { projectId, openEntity, navigateToAllChapters } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const {
    storylines,
    bookElements,
    bookElementCategories,
    bookNodes,
    storylineNodeMapping,
    primaryStorylineByNode,
  } = useDataStore();
  const recentItems = useRecentEntitiesStore((s) => s.items);
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const syncMetrics = useSyncObserver((s) => s.metrics);
  const appVersion = getPlatformRuntime().appInfo?.version ?? '0.1.0';

  // Writing plan + per-day stats are stored alongside settings (localStorage)
  // so they survive app restarts but don't require a SQLite migration.
  const writingHistory = useWritingStatsStore((s) => s.history[projectId ?? ''] ?? undefined);
  const writingPlans = useWritingStatsStore((s) => s.plans);
  const setProjectWordTarget = useWritingStatsStore((s) => s.setProjectWordTarget);
  const setDailyWordGoal = useWritingStatsStore((s) => s.setDailyWordGoal);
  const projectPlan = projectId
    ? (writingPlans[projectId] ?? { projectWordTarget: 120000, dailyWordGoal: 1500 })
    : { projectWordTarget: 120000, dailyWordGoal: 1500 };

  const { createStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { updateProject } = useProject({ userId: userId ?? '' });
  const { createCategory } = useElementCategory({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  // Project-level KV / template KV editors. Both write through updateProject
  // which short-circuits no-op writes inside the usecase, so we can hand the
  // raw JSON back without guarding here.
  const commitProjectKv = useCallback(
    (nextJson: string) => {
      if (!currentProject || nextJson === currentProject.kvJson) return;
      void updateProject(currentProject.id, {
        name: currentProject.name,
        summary: currentProject.summary,
        kvJson: nextJson,
        storylineTemplateKvJson: currentProject.storylineTemplateKvJson,
      });
    },
    [currentProject, updateProject],
  );
  const commitStorylineTemplateKv = useCallback(
    (nextJson: string) => {
      if (!currentProject || nextJson === currentProject.storylineTemplateKvJson) return;
      void updateProject(currentProject.id, {
        name: currentProject.name,
        summary: currentProject.summary,
        kvJson: currentProject.kvJson,
        storylineTemplateKvJson: nextJson,
      });
    },
    [currentProject, updateProject],
  );
  const commitProjectSummary = useCallback(
    (nextSummary: string) => {
      if (!currentProject || nextSummary === currentProject.summary) return;
      void updateProject(currentProject.id, { summary: nextSummary });
    },
    [currentProject, updateProject],
  );

  const [chip, setChip] = useState<'all' | 'draft' | 'todo' | 'done'>('all');
  const [dashboardView, setDashboardView] = useState<DashboardView>('overview');

  // ─── Hero / aggregate stats ────────────────────────────
  // Dashboard treats drift nodes as out-of-band (they live in their own
  // panel) — filter before counting so totals match what the storylines
  // grid actually shows.
  const chapterNodes = useMemo(() => bookNodes.filter(isChapter), [bookNodes]);
  const totalNodes = chapterNodes.length;
  const totalWordsMetric = useMemo(
    () => sumCanonicalChapterWordCounts(chapterNodes),
    [chapterNodes],
  );
  const totalWc = totalWordsMetric.count;
  const metricsReady = totalWordsMetric.ready;
  const targetWc = projectPlan.projectWordTarget || 0;

  const nodeStatuses = useMemo(() => chapterNodes.map((n) => deriveStatus(n)), [chapterNodes]);
  const doneNodes = nodeStatuses.filter((s) => s === 'done').length;
  const draftNodes = nodeStatuses.filter((s) => s === 'draft').length;
  const todoNodes = nodeStatuses.filter((s) => s === 'todo').length;
  const donePct = totalNodes ? Math.round((doneNodes / totalNodes) * 100) : 0;
  const draftPctTtl = totalNodes ? Math.round(((doneNodes + draftNodes) / totalNodes) * 100) : 0;

  // ─── Writing stats (today / week / streak) ─────────────
  const writingStats = useMemo(
    () => deriveWritingStats(writingHistory, totalWc),
    [writingHistory, totalWc],
  );
  const dailyGoal = projectPlan.dailyWordGoal || 0;
  const todayGoalPct =
    metricsReady && dailyGoal > 0 ? Math.min(100, (writingStats.todayWords / dailyGoal) * 100) : 0;
  const projectGoalPct =
    metricsReady && targetWc > 0 ? Math.min(100, (totalWc / targetWc) * 100) : 0;
  const syncFooter =
    syncMetrics.inflight > 0
      ? t('dashboard.footer.syncing')
      : syncMetrics.lastFailureAt !== null &&
          (syncMetrics.lastSuccessAt === null ||
            syncMetrics.lastFailureAt > syncMetrics.lastSuccessAt)
        ? t('dashboard.footer.syncNeedsAttention')
        : syncMetrics.lastSuccessAt !== null
          ? t('dashboard.footer.syncedAt', {
              time: new Date(syncMetrics.lastSuccessAt).toLocaleTimeString(i18n.language, {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })
          : t('dashboard.footer.localReady');

  // ─── Continue card — most recent node ──────────────────
  const continueNode = useMemo(() => {
    const recentNodeIds = recentItems
      .filter((r) => r.projectId === projectId && r.entityType === 'node')
      .map((r) => r.entityId);
    for (const id of recentNodeIds) {
      const node = bookNodes.find((n) => n.id === id);
      if (node) return node;
    }
    // Fallback: first node we have any data on.
    return bookNodes[0] ?? null;
  }, [recentItems, bookNodes, projectId]);

  const continueStoryline = useMemo(() => {
    if (!continueNode) return null;
    const slId = primaryStorylineByNode[continueNode.id] ?? null;
    return slId ? (storylines.find((s) => s.id === slId) ?? null) : null;
  }, [continueNode, primaryStorylineByNode, storylines]);

  const continueStorylineColor = continueStoryline
    ? resolveColor(continueStoryline.color, continueStoryline.id)
    : 'hsl(var(--accent))';

  // ─── Per-storyline stats ───────────────────────────────
  const storylineStats = useMemo(
    () =>
      storylines.map((s, index) => {
        const nodeIds = storylineNodeMapping[s.id] || [];
        const sNodes = nodeIds
          .map((nid) => bookNodes.find((n) => n.id === nid))
          .filter((n): n is NonNullable<typeof n> => Boolean(n));
        const done = sNodes.filter((n) => deriveStatus(n) === 'done').length;
        const draft = sNodes.filter((n) => deriveStatus(n) === 'draft').length;
        const todo = sNodes.length - done - draft;
        const wordCounts = sNodes.filter(isChapter).map(canonicalWordCount);
        const wc = wordCounts.every((value) => value != null)
          ? wordCounts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
          : null;
        return {
          s,
          index,
          sNodes,
          done,
          draft,
          todo,
          total: sNodes.length,
          wc,
          color: resolveColor(s.color, s.id),
        };
      }),
    [storylines, storylineNodeMapping, bookNodes],
  );

  const visibleStorylineStats = useMemo(
    () =>
      storylineStats
        .map((row) => ({
          ...row,
          visibleNodes:
            chip === 'all' ? row.sNodes : row.sNodes.filter((node) => deriveStatus(node) === chip),
        }))
        .filter((row) => chip === 'all' || row.visibleNodes.length > 0),
    [chip, storylineStats],
  );

  // ─── Filter chips ──────────────────────────────────────
  const chips: { id: typeof chip; label: string; count: number }[] = [
    { id: 'all', label: t('dashboard.chips.all'), count: totalNodes },
    { id: 'draft', label: t('dashboard.chips.draft'), count: draftNodes },
    { id: 'todo', label: t('dashboard.chips.todo'), count: todoNodes },
    { id: 'done', label: t('dashboard.chips.done'), count: doneNodes },
  ];

  // ─── Derived hero meta ─────────────────────────────────
  // The hero title doubles as an inline rename field — mirrors the storyline
  // editor's name pattern (controlled draft + IME composition guard).
  const editableProjectId = currentProject?.id ?? projectId ?? null;
  const currentProjectName =
    currentProject?.name ?? projects.find((p) => p.id === projectId)?.name ?? '';
  const [nameDraft, setNameDraft] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [isComposingName, setIsComposingName] = useState(false);
  const displayedName = isEditingName ? nameDraft : currentProjectName;

  const commitName = async () => {
    const next = nameDraft.trim();
    // Persist BEFORE leaving edit mode. If we dropped out of editing first,
    // `displayedName` would briefly fall back to the stale `currentProjectName`
    // (the store hasn't taken the write yet) and the title would flash the old
    // name until the async update lands. Awaiting keeps the draft on screen
    // until the store holds the new value, so the swap is seamless.
    if (editableProjectId && next && next !== currentProjectName) {
      await updateProject(editableProjectId, { name: next });
    }
    setIsEditingName(false);
  };

  const heroProjectSummary = currentProject?.summary;
  const lastTouchedNode = useMemo(() => {
    if (!bookNodes.length) return null;
    return [...bookNodes].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  }, [bookNodes]);
  const lastTouchedRel = lastTouchedNode
    ? formatRelativeTime(lastTouchedNode.updatedAt, i18n.language)
    : '—';
  const lastTouchedTitle = lastTouchedNode?.title || '—';
  const projectSinceLabel = currentProject?.createdAt
    ? new Date(currentProject.createdAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
      })
    : '—';

  const handleCreateStoryline = async () => {
    try {
      const newStoryline = await createStoryline({
        name: 'Untitled Storyline',
        summary: '',
      });
      openEntity({ entityType: 'storyline', id: newStoryline.id }, { preview: false });
    } catch (e) {
      log.error('Failed to create storyline', e);
    }
  };

  const handleCreateCategory = async () => {
    try {
      const created = await createCategory({});
      openEntity({ entityType: 'category', id: created.id }, { preview: false });
    } catch (e) {
      log.error('Failed to create element category', e);
    }
  };

  const openStoryGraph = () => setActiveSuperView('graph');
  const openElementOverview = () => setActiveSuperView('element');
  const openAllChapters = () => navigateToAllChapters();

  const todayDateLabel = new Date().toLocaleDateString(i18n.language, {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  // Recent activity feed — derived from the most-recently-updated chapter
  // nodes (drifts excluded; they have their own panel). Acts as a "what did
  // I last touch" surface until a proper activity log lands.
  const recentActivity = useMemo(() => {
    return [...chapterNodes]
      .sort((a: BookNode, b: BookNode) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 6)
      .map((n) => {
        const primaryId = primaryStorylineByNode[n.id] ?? null;
        const sl = primaryId ? storylines.find((s) => s.id === primaryId) : undefined;
        return {
          id: n.id,
          dateLabel: formatRelativeTime(n.updatedAt, i18n.language),
          mark: '',
          desc: n.title || 'Untitled',
          tail: sl ? ` · ${sl.name}` : '',
          meta:
            canonicalWordCount(n) == null
              ? t('common.counting')
              : canonicalWordCount(n)! > 0
                ? t('dashboard.wordCount', { count: canonicalWordCount(n)!.toLocaleString() })
                : t('dashboard.chips.draft'),
          metaCls: ((canonicalWordCount(n) ?? 0) > 0 ? 'pos' : 'neg') as 'pos' | 'neg',
          accent: sl ? resolveColor(sl.color, sl.id) : 'hsl(var(--accent))',
        };
      });
  }, [chapterNodes, primaryStorylineByNode, storylines, i18n.language, t]);

  return (
    <div className="dash">
      <div className="dash__inner">
        {/* ════════ HERO ════════ */}
        <header className="dash-hero">
          <div>
            <div className="dash-hero__kicker">
              <span className="dash-hero__kicker-dot"></span>
              <span>{t('dashboard.hero.projectHome')}</span>
              <span className="dash-hero__kicker-sep">·</span>
              <span>{t('dashboard.hero.draft')}</span>
              <span className="dash-hero__kicker-sep">·</span>
              <span>{t('dashboard.hero.since', { date: projectSinceLabel })}</span>
            </div>

            <input
              type="text"
              className="dash-hero__title dash-hero__title-input"
              value={displayedName}
              readOnly={!editableProjectId}
              placeholder="Drifting"
              aria-label={t('dashboard.hero.projectName')}
              title={t('dashboard.hero.renameProject')}
              onFocus={() => {
                setNameDraft(currentProjectName);
                setIsEditingName(true);
              }}
              onChange={(e) => setNameDraft(e.target.value)}
              onCompositionStart={() => setIsComposingName(true)}
              onCompositionEnd={(e) => {
                setIsComposingName(false);
                setNameDraft(e.currentTarget.value);
              }}
              onBlur={() => {
                if (isComposingName) setIsEditingName(false);
                else void commitName();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isComposingName) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === 'Escape') {
                  setNameDraft(currentProjectName);
                  e.currentTarget.blur();
                }
              }}
            />

            {heroProjectSummary && <p className="dash-hero__sub">{heroProjectSummary}</p>}

            <div className="dash-hero__meta">
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">{t('dashboard.metrics.storylines')}</span>
                <span className="dash-hero__metric-v">{storylines.length}</span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">{t('dashboard.metrics.nodes')}</span>
                <span className="dash-hero__metric-v">
                  {totalNodes}
                  <em>{t('common.chapters')}</em>
                </span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">{t('dashboard.metrics.elements')}</span>
                <span className="dash-hero__metric-v">
                  {bookElements.length}
                  <em>
                    · {bookElementCategories.length} {t('common.categoriesUnit')}
                  </em>
                </span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">{t('dashboard.metrics.words')}</span>
                <span className="dash-hero__metric-v">
                  {metricsReady ? (
                    <>
                      {(totalWc / 1000).toFixed(1)}
                      <em>k{targetWc > 0 ? ` / ${(targetWc / 1000).toFixed(0)}k` : ''}</em>
                    </>
                  ) : (
                    t('common.counting')
                  )}
                </span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">{t('dashboard.metrics.lastTouched')}</span>
                <span className="dash-hero__metric-v">
                  {lastTouchedRel}
                  <em>· {lastTouchedTitle}</em>
                </span>
              </div>
            </div>
          </div>

          <div className="dash-hero__aside">
            <div
              className="dash-hero__progress"
              style={
                {
                  '--p-done': `${donePct}%`,
                  '--p-with-draft': `${draftPctTtl}%`,
                } as React.CSSProperties
              }
            >
              <div className="dash-hero__progress-inner">
                <span className="dash-hero__progress-pct">
                  {donePct}
                  <em>%</em>
                </span>
                <span className="dash-hero__progress-k">{t('dashboard.chips.done')}</span>
              </div>
            </div>
            <div className="dash-hero__btns">
              <button className="dash-hero__btn" onClick={openStoryGraph}>
                <GitBranch size={16} aria-hidden="true" />
                {t('dashboard.actions.storyGraph')}
              </button>
              <button className="dash-hero__btn" onClick={openElementOverview}>
                <Boxes size={16} aria-hidden="true" />
                {t('dashboard.actions.elementOverview')}
              </button>
              <button className="dash-hero__btn" onClick={openAllChapters}>
                <BookOpen size={16} aria-hidden="true" />
                {t('dashboard.actions.allChapters')}
              </button>
              <button
                className="dash-hero__btn dash-hero__btn--primary"
                onClick={() =>
                  continueNode
                    ? openEntity({ entityType: 'node', id: continueNode.id })
                    : openAllChapters()
                }
              >
                {t('dashboard.continue.resume')}
              </button>
            </div>
          </div>
        </header>

        <div className="dash-view-tabs" role="tablist" aria-label={t('dashboard.hero.projectHome')}>
          {(
            [
              ['overview', isZh(i18n.language) ? '概览' : 'Overview', LayoutDashboard],
              ['structure', isZh(i18n.language) ? '结构与设定' : 'Structure', ListTree],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={dashboardView === id}
              className={`dash-view-tab${dashboardView === id ? ' dash-view-tab--active' : ''}`}
              onClick={() => setDashboardView(id)}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ))}
          <button
            type="button"
            className="dash-view-tabs__settings"
            onClick={() => setDashboardView('structure')}
          >
            <Settings2 size={16} aria-hidden="true" />
            {isZh(i18n.language) ? '项目设置' : 'Project settings'}
          </button>
        </div>

        {dashboardView === 'overview' && (
          <>
            {/* Chapter filters apply to the storyline chapter sequence below. */}
            <div className="dash-chips">
              {chips.map((c) => (
                <FilterChip
                  key={c.id}
                  active={chip === c.id}
                  count={`· ${c.count}`}
                  onClick={() => setChip(c.id)}
                >
                  {c.label}
                </FilterChip>
              ))}
            </div>

            {/* ════════ ROW 1 — CONTINUE + TODAY ════════ */}
            <div className="dash-row">
              {/* CONTINUE */}
              {continueNode ? (
                <article
                  className="dash-continue"
                  style={{ '--c-color': continueStorylineColor } as React.CSSProperties}
                  onClick={() => openEntity({ entityType: 'node', id: continueNode.id })}
                >
                  <div className="dash-continue__kicker">
                    <span>{t('dashboard.continue.kicker')}</span>
                    <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
                    <em>{formatRelativeTime(continueNode.updatedAt, i18n.language)}</em>
                  </div>
                  <div className="dash-continue__path">
                    {continueStoryline ? `${continueStoryline.name} · ` : ''}§
                    {String(continueNode.bookOrder || 1).padStart(2, '0')}
                  </div>
                  <h2 className="dash-continue__title">{continueNode.title || 'Untitled'}</h2>
                  {continueNode.summary && (
                    <div className="dash-continue__sub">{continueNode.summary}</div>
                  )}
                  {/* TODO: snippet currently re-uses summary; pull first paragraph from node content once exposed. */}
                  <p className="dash-continue__snippet">
                    {continueNode.summary || t('dashboard.continue.noBody')}
                  </p>
                  <div className="dash-continue__foot">
                    <div className="dash-continue__meta">
                      <span>
                        <b>
                          {canonicalWordCount(continueNode)?.toLocaleString() ??
                            t('common.counting')}
                        </b>
                        {canonicalWordCount(continueNode) != null && (
                          <span style={{ color: 'hsl(var(--ink-4))' }}>{t('common.words')}</span>
                        )}
                      </span>
                      {/* TODO: revisions count not yet tracked. */}
                      <span>
                        <b>—</b>
                        {t('dashboard.continue.revisions')}
                      </span>
                    </div>
                    <div className="dash-continue__resume">
                      {t('dashboard.continue.resume')}
                      <span className="dash-continue__resume-arrow">→</span>
                    </div>
                  </div>
                </article>
              ) : (
                <article className="dash-continue" style={{ cursor: 'default' }}>
                  <div className="dash-continue__kicker">
                    <span>{t('dashboard.continue.kicker')}</span>
                  </div>
                  <div className="dash-continue__path">{t('dashboard.continue.noChapters')}</div>
                  <h2 className="dash-continue__title">{t('dashboard.continue.emptyTitle')}</h2>
                  <div className="dash-continue__sub">{t('dashboard.continue.emptySub')}</div>
                  <div className="dash-continue__foot">
                    <div className="dash-continue__resume" onClick={handleCreateStoryline}>
                      {t('dashboard.actions.newStoryline')}
                      <span className="dash-continue__resume-arrow">→</span>
                    </div>
                  </div>
                </article>
              )}

              {/* TODAY */}
              <aside className="dash-today">
                <div className="dash-today__kicker">{t('dashboard.today.kicker')}</div>
                <div className="dash-today__date">{todayDateLabel}</div>
                <div className="dash-today__main">
                  <span className="dash-today__big">
                    {metricsReady ? writingStats.todayWords.toLocaleString() : t('common.counting')}
                  </span>
                  <span className="dash-today__unit">{t('common.words')}</span>
                </div>
                <div className="dash-today__goal">
                  {t('dashboard.today.goal')} <b>{dailyGoal.toLocaleString()}</b>{' '}
                  {t('common.words')}
                </div>
                <div className="dash-today__bar">
                  <div className="dash-today__bar-fill" style={{ width: `${todayGoalPct}%` }}></div>
                </div>
                <div className="dash-today__streak">
                  <div className="dash-today__streak-cell">
                    <span className="dash-today__streak-k">{t('dashboard.today.streak')}</span>
                    <span className="dash-today__streak-v">
                      {metricsReady ? writingStats.streakDays : '—'}
                      <em>{t('common.days')}</em>
                    </span>
                  </div>
                  <div className="dash-today__streak-cell">
                    <span className="dash-today__streak-k">{t('dashboard.today.week')}</span>
                    <span className="dash-today__streak-v">
                      {metricsReady ? (writingStats.weekWords / 1000).toFixed(1) : '—'}
                      <em>k{t('common.words')}</em>
                    </span>
                  </div>
                  <div className="dash-today__streak-cell">
                    <span className="dash-today__streak-k">{t('dashboard.today.month')}</span>
                    <span className="dash-today__streak-v">
                      {metricsReady ? writingStats.monthDaysWritten : '—'}
                      <em>{t('common.days')}</em>
                    </span>
                  </div>
                </div>
              </aside>
            </div>

            {/* ════════ STORYLINES ════════ */}
            <section className="dash-section">
              <div className="dash-section__head">
                <div className="dash-section__title">
                  <GitBranch className="dash-section__title-mark" size={18} aria-hidden="true" />
                  <span className="dash-section__title-cn">
                    {t('dashboard.sections.storylines')}
                  </span>
                  <span className="dash-section__title-en">
                    {t('dashboard.sections.storylinesShort')}
                  </span>
                  <span className="dash-section__count">
                    · <em>{storylines.length}</em> {t('common.storylinesUnit')} /{' '}
                    <em>{totalNodes}</em> {t('common.chapters')} /{' '}
                    <em>
                      {metricsReady ? `${(totalWc / 1000).toFixed(1)}k` : t('common.counting')}
                    </em>{' '}
                    {metricsReady ? t('common.words') : ''}
                  </span>
                </div>
                <div className="dash-section__actions">
                  <button className="dash-section__btn" onClick={openStoryGraph}>
                    <GitBranch size={15} aria-hidden="true" /> {t('dashboard.actions.storyGraph')}
                  </button>
                  <button className="dash-section__btn" onClick={openAllChapters}>
                    <BookOpen size={15} aria-hidden="true" /> {t('dashboard.actions.allChapters')}
                  </button>
                  <button
                    className="dash-section__btn dash-section__btn--accent"
                    onClick={handleCreateStoryline}
                  >
                    <Plus size={15} aria-hidden="true" /> {t('dashboard.actions.newStoryline')}
                  </button>
                </div>
              </div>

              <div className="dash-tracks">
                {visibleStorylineStats.map(
                  ({ s, index, visibleNodes, done, draft, total, wc, color }) => {
                    const trackDonePct = total ? (done / total) * 100 : 0;
                    const trackDraftPct = total ? (draft / total) * 100 : 0;
                    return (
                      <div
                        key={s.id}
                        className="dash-track"
                        style={{ '--s-color': color } as React.CSSProperties}
                        onClick={() => openEntity({ entityType: 'storyline', id: s.id })}
                      >
                        <div className="dash-track__no">
                          {(index + 1).toString().padStart(2, '0')}
                        </div>

                        <div className="dash-track__name">
                          <div className="dash-track__name-main">
                            <span>{s.name || 'Untitled Storyline'}</span>
                          </div>
                          <div className="dash-track__name-sub">
                            {s.summary
                              ? s.summary
                              : t('dashboard.storylineSummary', {
                                  total,
                                  done,
                                  draft,
                                  todo: total - done - draft,
                                })}
                          </div>
                        </div>

                        <div
                          className="dash-track__chapters"
                          title={t('dashboard.chaptersTitle', { count: total })}
                        >
                          {visibleNodes.map((n) => {
                            const status = deriveStatus(n);
                            const isActive = n.id === continueNode?.id;
                            return (
                              <span
                                key={n.id}
                                className={`dash-track__ch dash-track__ch--${status} ${
                                  isActive ? 'dash-track__ch--active' : ''
                                }`}
                                title={`§${n.bookOrder} · ${n.title} · ${status}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEntity({ entityType: 'node', id: n.id });
                                }}
                              ></span>
                            );
                          })}
                        </div>

                        <div className="dash-track__bar-wrap">
                          <div className="dash-track__bar-label">
                            <span>
                              <b>
                                {done}/{total}
                              </b>{' '}
                              {t('common.chapters')}
                            </span>
                            <span>{Math.round(trackDonePct)}%</span>
                          </div>
                          <div className="dash-track__bar">
                            <div
                              className="dash-track__bar-done"
                              style={{ width: `${trackDonePct}%` }}
                            ></div>
                            <div
                              className="dash-track__bar-draft"
                              style={{ left: `${trackDonePct}%`, width: `${trackDraftPct}%` }}
                            ></div>
                          </div>
                        </div>

                        <div className="dash-track__wc">
                          <span className="dash-track__wc-v">
                            {wc == null ? t('common.counting') : (wc / 1000).toFixed(1)}
                            {wc != null && <em>k</em>}
                          </span>
                          <span className="dash-track__wc-k">{t('dashboard.wordsLabel')}</span>
                        </div>
                      </div>
                    );
                  },
                )}

                <div className="dash-track dash-track--new" onClick={handleCreateStoryline}>
                  <span className="dash-track--new-glyph">
                    <Plus size={16} aria-hidden="true" />
                  </span>
                  <span>{t('dashboard.actions.newStorylineLong')}</span>
                </div>
              </div>
            </section>

            {/* ════════ ELEMENT CATEGORIES + ACTIVITY ════════ */}
            <div className="dash-row dash-row--2">
              {/* Element categories */}
              <section className="dash-section" style={{ marginBottom: 0 }}>
                <div className="dash-section__head">
                  <div className="dash-section__title">
                    <Boxes className="dash-section__title-mark" size={18} aria-hidden="true" />
                    <span className="dash-section__title-cn">
                      {t('dashboard.sections.elementCategories')}
                    </span>
                    <span className="dash-section__title-en">
                      {t('dashboard.sections.elementCategoriesShort')}
                    </span>
                    <span className="dash-section__count">
                      · <em>{bookElementCategories.length}</em> {t('common.categoriesUnit')} /{' '}
                      <em>{bookElements.length}</em> {t('common.itemsUnit')}
                    </span>
                  </div>
                  <div className="dash-section__actions">
                    <button
                      className="dash-section__btn dash-section__btn--accent"
                      onClick={handleCreateCategory}
                    >
                      <Plus size={15} aria-hidden="true" /> {t('dashboard.actions.newCategory')}
                    </button>
                  </div>
                </div>

                <div className="dash-cats">
                  {bookElementCategories.map((c) => {
                    const cEls = bookElements.filter((e) => e.categoryId === c.id);
                    const samples = cEls.slice(0, 3).map((e) => e.name);
                    const more = Math.max(0, cEls.length - 3);
                    const catColor = resolveColor(c.color, c.id);
                    return (
                      <div
                        key={c.id}
                        className="dash-cat"
                        style={{ '--c-color': catColor } as React.CSSProperties}
                        onClick={() => openEntity({ entityType: 'category', id: c.id })}
                      >
                        <div className="dash-cat__head">
                          <span className="dash-cat__dot"></span>
                          <span className="dash-cat__name">{c.name}</span>
                          <span className="dash-cat__count">
                            <b>{cEls.length}</b>
                          </span>
                        </div>
                        <div className="dash-cat__samples">
                          {samples.length === 0 ? (
                            <span className="dash-cat__samples-empty">
                              — {t('dashboard.empty.noElements')} —
                            </span>
                          ) : (
                            samples.map((nm, i) => (
                              <span key={i}>
                                {i > 0 && <span className="dash-cat__samples-sep">·</span>}
                                <span>{nm || 'Untitled'}</span>
                              </span>
                            ))
                          )}
                          {more > 0 && <span className="dash-cat__samples-more">+{more}</span>}
                        </div>
                      </div>
                    );
                  })}
                  <div className="dash-cat dash-cat--new" onClick={handleCreateCategory}>
                    <span className="dash-cat--new__glyph">
                      <Plus size={16} aria-hidden="true" />
                    </span>
                    <span>{t('dashboard.actions.newCategory')}</span>
                  </div>
                </div>
              </section>

              {/* Recent activity */}
              <section className="dash-section" style={{ marginBottom: 0 }}>
                <div className="dash-section__head">
                  <div className="dash-section__title">
                    <LayoutDashboard
                      className="dash-section__title-mark"
                      size={18}
                      aria-hidden="true"
                    />
                    <span className="dash-section__title-cn">{t('dashboard.sections.recent')}</span>
                    <span className="dash-section__title-en">
                      {t('dashboard.sections.recentShort')}
                    </span>
                    <span className="dash-section__count">
                      · <em>{recentActivity.length}</em> {t('common.itemsUnit')}
                    </span>
                  </div>
                  <div className="dash-section__actions">
                    <button className="dash-section__btn" onClick={openAllChapters}>
                      {t('dashboard.actions.allChapters')} →
                    </button>
                  </div>
                </div>

                <div className="dash-act">
                  {recentActivity.length === 0 ? (
                    <div className="dash-act-row" style={{ gridTemplateColumns: '1fr' }}>
                      <span className="dash-cat__samples-empty">
                        — {t('dashboard.empty.noActivity')} —
                      </span>
                    </div>
                  ) : (
                    recentActivity.map((r) => (
                      <div
                        key={r.id}
                        className="dash-act-row"
                        style={{ '--a-color': r.accent } as React.CSSProperties}
                        onClick={() => openEntity({ entityType: 'node', id: r.id })}
                      >
                        <div className="dash-act-row__date">
                          <b>{r.dateLabel}</b>
                        </div>
                        <div className="dash-act-row__desc">
                          <span className="dash-act-row__desc-mark">{r.mark}</span>
                          <span className="dash-act-row__desc-main">{r.desc}</span>
                          <span className="dash-act-row__desc-tail">{r.tail}</span>
                        </div>
                        <div className={`dash-act-row__meta dash-act-row__meta--${r.metaCls}`}>
                          {r.meta}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}

        {/* ════════ WRITING PLAN ════════
            Per-project goals (project word target + daily quota). Both are
            stored in writing-stats-store (localStorage), independent of
            the Project model, so a fresh project picks reasonable defaults
            without a DB migration. */}
        {dashboardView === 'structure' && projectId && (
          <section className="dash-section">
            <div className="dash-section__head">
              <div className="dash-section__title">
                <Settings2 className="dash-section__title-mark" size={18} aria-hidden="true" />
                <span className="dash-section__title-cn">
                  {t('dashboard.sections.writingPlan')}
                </span>
                <span className="dash-section__title-en">
                  {t('dashboard.sections.writingPlanShort')}
                </span>
                <span className="dash-section__count">
                  · {t('dashboard.plan.project')}{' '}
                  <em>{metricsReady ? `${(totalWc / 1000).toFixed(1)}k` : t('common.counting')}</em>
                  {targetWc > 0 ? ` / ${(targetWc / 1000).toFixed(0)}k` : ''} {t('common.words')}
                </span>
              </div>
            </div>

            <div className="dash-plan">
              <label className="dash-plan__field">
                <span className="dash-plan__label">{t('dashboard.plan.projectTarget')}</span>
                <span className="dash-plan__input-wrap">
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    className="dash-plan__input"
                    value={projectPlan.projectWordTarget}
                    onChange={(e) => setProjectWordTarget(projectId, Number(e.target.value) || 0)}
                  />
                  <span className="dash-plan__unit">{t('common.words')}</span>
                </span>
                <span className="dash-plan__hint">{t('dashboard.plan.projectHint')}</span>
              </label>

              <label className="dash-plan__field">
                <span className="dash-plan__label">{t('dashboard.plan.dailyTarget')}</span>
                <span className="dash-plan__input-wrap">
                  <input
                    type="number"
                    min={0}
                    step={100}
                    className="dash-plan__input"
                    value={projectPlan.dailyWordGoal}
                    onChange={(e) => setDailyWordGoal(projectId, Number(e.target.value) || 0)}
                  />
                  <span className="dash-plan__unit">{t('dashboard.plan.wordsPerDay')}</span>
                </span>
                <span className="dash-plan__hint">{t('dashboard.plan.dailyHint')}</span>
              </label>

              <div className="dash-plan__progress">
                <div className="dash-plan__progress-row">
                  <span className="dash-plan__progress-k">
                    {t('dashboard.plan.projectProgress')}
                  </span>
                  <span className="dash-plan__progress-v">
                    {!metricsReady
                      ? t('common.counting')
                      : targetWc > 0
                        ? `${projectGoalPct.toFixed(1)}%`
                        : t('dashboard.plan.noProjectGoal')}
                  </span>
                </div>
                <div className="dash-plan__bar">
                  <div
                    className="dash-plan__bar-fill"
                    style={{ width: `${projectGoalPct}%` }}
                  ></div>
                </div>
                <div className="dash-plan__progress-row">
                  <span className="dash-plan__progress-k">{t('dashboard.plan.todayProgress')}</span>
                  <span className="dash-plan__progress-v">
                    {!metricsReady
                      ? t('common.counting')
                      : dailyGoal > 0
                        ? `${writingStats.todayWords.toLocaleString()} / ${dailyGoal.toLocaleString()}`
                        : t('dashboard.plan.noDailyGoal')}
                  </span>
                </div>
                <div className="dash-plan__bar">
                  <div
                    className="dash-plan__bar-fill dash-plan__bar-fill--day"
                    style={{ width: `${todayGoalPct}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ════════ PROJECT PROFILE ════════ */}
        {dashboardView === 'structure' && currentProject && (
          <section className="dash-section">
            <div className="dash-section__head">
              <div className="dash-section__title">
                <BookOpen className="dash-section__title-mark" size={18} aria-hidden="true" />
                <span className="dash-section__title-cn">
                  {t('dashboard.sections.projectProfile')}
                </span>
                <span className="dash-section__title-en">
                  {t('dashboard.sections.projectProfileShort')}
                </span>
              </div>
            </div>
            <ProjectProfileEditor
              key={`project-profile-${currentProject.id}:${currentProject.summary}`}
              summary={currentProject.summary}
              onPersist={commitProjectSummary}
            />
          </section>
        )}

        {/* ════════ PROJECT KV ════════
            Project-level facts (own KV) and the storyline template KV new
            storylines inherit. Mirrors the same KvEditor used on storyline /
            element / category, plumbed through updateProject. */}
        {dashboardView === 'structure' && currentProject && (
          <div className="dash-row dash-row--2">
            <section className="dash-section" style={{ marginBottom: 0 }}>
              <div className="dash-section__head">
                <div className="dash-section__title">
                  <Settings2 className="dash-section__title-mark" size={18} aria-hidden="true" />
                  <span className="dash-section__title-cn">
                    {t('dashboard.sections.projectFacts')}
                  </span>
                  <span className="dash-section__title-en">
                    {t('dashboard.sections.projectFactsShort')}
                  </span>
                </div>
              </div>
              <div style={{ padding: '0 4px' }}>
                <KvEditor
                  key={`proj-kv-${currentProject.id}`}
                  valueJson={currentProject.kvJson}
                  onPersist={commitProjectKv}
                  emptyHint={`— ${t('dashboard.empty.noFields')} —`}
                />
              </div>
            </section>

            <section className="dash-section" style={{ marginBottom: 0 }}>
              <div className="dash-section__head">
                <div className="dash-section__title">
                  <ListTree className="dash-section__title-mark" size={18} aria-hidden="true" />
                  <span className="dash-section__title-cn">
                    {t('dashboard.sections.storylineTemplate')}
                  </span>
                  <span className="dash-section__title-en">
                    {t('dashboard.sections.storylineTemplateShort')}
                  </span>
                </div>
              </div>
              <div style={{ padding: '0 4px' }}>
                <KvEditor
                  key={`proj-sl-tpl-${currentProject.id}`}
                  valueJson={currentProject.storylineTemplateKvJson}
                  onPersist={commitStorylineTemplateKv}
                  variant="template"
                  emptyHint={`— ${t('dashboard.empty.noTemplateFields')} —`}
                />
              </div>
            </section>
          </div>
        )}

        {/* ════════ FOOTER ════════ */}
        <footer className="dash-foot">
          <span>Drifting · v{appVersion} · pre-alpha</span>
          <span>{syncFooter}</span>
        </footer>
      </div>
    </div>
  );
}
