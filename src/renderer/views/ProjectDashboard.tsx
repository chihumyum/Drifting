import { useCallback, useMemo, useState } from 'react';
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
import { ShadowRulesSection } from '../components/dashboard/ShadowRulesSection';
import { isChapter, deriveStatus, type BookNode } from '../domain/book-node';
import loglevel from 'loglevel';
import '../../styles/dashboard.css';

const log = loglevel.getLogger('ProjectDashboard');

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

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return new Date(iso).toLocaleDateString();
}

interface ProjectProfileEditorProps {
  summary: string;
  onPersist: (nextSummary: string) => void;
}

function ProjectProfileEditor({ summary, onPersist }: ProjectProfileEditorProps) {
  const [draft, setDraft] = useState(summary);

  const persistDraft = () => {
    const nextSummary = draft.trim();
    if (nextSummary !== summary) onPersist(nextSummary);
  };

  return (
    <div className="dash-profile">
      <label className="dash-profile__field">
        <span className="dash-profile__label">图书简介 · SUMMARY</span>
        <textarea
          className="dash-profile__textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={persistDraft}
          placeholder="写下项目简介、核心命题或故事梗概"
          rows={5}
        />
      </label>

      <span className="dash-profile__hint">失焦后自动保存。副标题、体裁等扩展信息可在本书字段中维护。</span>
    </div>
  );
}

export function ProjectDashboard() {
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

  // ─── Hero / aggregate stats ────────────────────────────
  // Dashboard treats drift nodes as out-of-band (they live in their own
  // panel) — filter before counting so totals match what the storylines
  // grid actually shows.
  const chapterNodes = useMemo(() => bookNodes.filter(isChapter), [bookNodes]);
  const totalNodes = chapterNodes.length;
  const totalWc = chapterNodes.reduce((a, n) => a + (n.wordCount || 0), 0);
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
  const todayGoalPct = dailyGoal > 0 ? Math.min(100, (writingStats.todayWords / dailyGoal) * 100) : 0;
  const projectGoalPct = targetWc > 0 ? Math.min(100, (totalWc / targetWc) * 100) : 0;

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
    return slId ? storylines.find((s) => s.id === slId) ?? null : null;
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
        const wc = sNodes.reduce((a, n) => a + (n.wordCount || 0), 0);
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

  // ─── Filter chips ──────────────────────────────────────
  const chips: { id: typeof chip; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: totalNodes },
    { id: 'draft', label: '草稿', count: draftNodes },
    { id: 'todo', label: '未起', count: todoNodes },
    { id: 'done', label: '已完成', count: doneNodes },
  ];

  // ─── Derived hero meta ─────────────────────────────────
  const heroProjectTitle =
    currentProject?.name || projects.find((p) => p.id === projectId)?.name || 'Drifting';
  const heroProjectSummary = currentProject?.summary;
  const lastTouchedNode = useMemo(() => {
    if (!bookNodes.length) return null;
    return [...bookNodes].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  }, [bookNodes]);
  const lastTouchedRel = lastTouchedNode ? formatRelativeTime(lastTouchedNode.updatedAt) : '—';
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

  const todayDateLabel = new Date().toLocaleDateString(undefined, {
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
          dateLabel: formatRelativeTime(n.updatedAt),
          mark: '§',
          desc: n.title || 'Untitled',
          tail: sl ? ` · ${sl.name}` : '',
          meta: n.wordCount ? `${n.wordCount.toLocaleString()} 字` : '草稿',
          metaCls: (n.wordCount > 0 ? 'pos' : 'neg') as 'pos' | 'neg',
          accent: sl ? resolveColor(sl.color, sl.id) : 'hsl(var(--accent))',
        };
      });
  }, [chapterNodes, primaryStorylineByNode, storylines]);

  return (
    <div className="dash">
      <div className="dash__inner">
        {/* ════════ HERO ════════ */}
        <header className="dash-hero">
          <div>
            <div className="dash-hero__kicker">
              <span className="dash-hero__kicker-dot"></span>
              <span>PROJECT HOME</span>
              <span className="dash-hero__kicker-sep">·</span>
              <span>VOL. I — DRAFT</span>
              <span className="dash-hero__kicker-sep">·</span>
              <span>SINCE {projectSinceLabel}</span>
            </div>

            <h1 className="dash-hero__title">
              {heroProjectTitle}
            </h1>

            {heroProjectSummary && (
              <p className="dash-hero__sub">
                {heroProjectSummary}
              </p>
            )}

            <div className="dash-hero__meta">
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">Storylines · 故事线</span>
                <span className="dash-hero__metric-v">{storylines.length}</span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">Nodes · 章节节点</span>
                <span className="dash-hero__metric-v">
                  {totalNodes}
                  <em>章</em>
                </span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">Elements · 元素</span>
                <span className="dash-hero__metric-v">
                  {bookElements.length}
                  <em>· {bookElementCategories.length} 类</em>
                </span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">Words · 已写</span>
                <span className="dash-hero__metric-v">
                  {(totalWc / 1000).toFixed(1)}
                  <em>
                    k{targetWc > 0 ? ` / ${(targetWc / 1000).toFixed(0)}k` : ''}
                  </em>
                </span>
              </div>
              <div className="dash-hero__metric">
                <span className="dash-hero__metric-k">Last touched</span>
                <span className="dash-hero__metric-v">
                  {lastTouchedRel.replace(' 分钟前', '')}
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
                <span className="dash-hero__progress-k">DONE</span>
              </div>
            </div>
            <div className="dash-hero__btns">
              <button className="dash-hero__btn" onClick={openStoryGraph}>
                ⌬ 叙事图
              </button>
              <button className="dash-hero__btn" onClick={openElementOverview}>
                ⊞ 元素总览
              </button>
              <button className="dash-hero__btn" onClick={openAllChapters}>
                ☷ 通览全书
              </button>
              <button
                className="dash-hero__btn dash-hero__btn--primary"
                onClick={handleCreateStoryline}
              >
                ＋ 新章节
              </button>
            </div>
          </div>
        </header>

        {/* ════════ Chip filter row ════════ */}
        <div className="dash-chips">
          {chips.map((c) => (
            <div
              key={c.id}
              className={`dash-chip ${chip === c.id ? 'dash-chip--active' : ''}`}
              onClick={() => setChip(c.id)}
            >
              <span>{c.label}</span>
              <span className="dash-chip__count">· {c.count}</span>
            </div>
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
                <span>CONTINUE WRITING</span>
                <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
                <em>{formatRelativeTime(continueNode.updatedAt)}</em>
              </div>
              <div className="dash-continue__path">
                {continueStoryline ? `${continueStoryline.name} · ` : ''}
                §{String(continueNode.bookOrder || 1).padStart(2, '0')}
              </div>
              <h2 className="dash-continue__title">{continueNode.title || 'Untitled'}</h2>
              {continueNode.summary && (
                <div className="dash-continue__sub">{continueNode.summary}</div>
              )}
              {/* TODO: snippet currently re-uses summary; pull first paragraph from node content once exposed. */}
              <p className="dash-continue__snippet">
                {continueNode.summary || '未写入正文'}
              </p>
              <div className="dash-continue__foot">
                <div className="dash-continue__meta">
                  <span>
                    <b>{(continueNode.wordCount || 0).toLocaleString()}</b>
                    <span style={{ color: 'hsl(var(--ink-4))' }}>字</span>
                  </span>
                  {/* TODO: revisions count not yet tracked. */}
                  <span>
                    <b>—</b>次修订
                  </span>
                </div>
                <div className="dash-continue__resume">
                  继续写作
                  <span className="dash-continue__resume-arrow">→</span>
                </div>
              </div>
            </article>
          ) : (
            <article className="dash-continue" style={{ cursor: 'default' }}>
              <div className="dash-continue__kicker">
                <span>CONTINUE WRITING</span>
              </div>
              <div className="dash-continue__path">尚无章节</div>
              <h2 className="dash-continue__title">从一篇空白开始</h2>
              <div className="dash-continue__sub">建一条故事线，写下第一章。</div>
              <div className="dash-continue__foot">
                <div className="dash-continue__resume" onClick={handleCreateStoryline}>
                  新建故事线
                  <span className="dash-continue__resume-arrow">→</span>
                </div>
              </div>
            </article>
          )}

          {/* TODAY */}
          <aside className="dash-today">
            <div className="dash-today__kicker">TODAY · 今日</div>
            <div className="dash-today__date">{todayDateLabel}</div>
            <div className="dash-today__main">
              <span className="dash-today__big">
                {writingStats.todayWords.toLocaleString()}
              </span>
              <span className="dash-today__unit">字</span>
            </div>
            <div className="dash-today__goal">
              目标 <b>{dailyGoal.toLocaleString()}</b> 字
            </div>
            <div className="dash-today__bar">
              <div
                className="dash-today__bar-fill"
                style={{ width: `${todayGoalPct}%` }}
              ></div>
            </div>
            <div className="dash-today__streak">
              <div className="dash-today__streak-cell">
                <span className="dash-today__streak-k">连续写作</span>
                <span className="dash-today__streak-v">
                  {writingStats.streakDays}
                  <em>天</em>
                </span>
              </div>
              <div className="dash-today__streak-cell">
                <span className="dash-today__streak-k">本周</span>
                <span className="dash-today__streak-v">
                  {(writingStats.weekWords / 1000).toFixed(1)}
                  <em>k字</em>
                </span>
              </div>
              <div className="dash-today__streak-cell">
                <span className="dash-today__streak-k">月内</span>
                <span className="dash-today__streak-v">
                  {writingStats.monthDaysWritten}
                  <em>天</em>
                </span>
              </div>
            </div>
          </aside>
        </div>

        {/* ════════ STORYLINES ════════ */}
        <section className="dash-section">
          <div className="dash-section__head">
            <div className="dash-section__title">
              <span className="dash-section__title-mark">§</span>
              <span className="dash-section__title-cn">故事线</span>
              <span className="dash-section__title-en">Storylines</span>
              <span className="dash-section__count">
                · <em>{storylines.length}</em> 线 / <em>{totalNodes}</em> 章 /{' '}
                <em>{(totalWc / 1000).toFixed(1)}k</em> 字
              </span>
            </div>
            <div className="dash-section__actions">
              <button className="dash-section__btn" onClick={openStoryGraph}>
                ⌬ 叙事图
              </button>
              <button className="dash-section__btn" onClick={openAllChapters}>
                ☷ 通览全书
              </button>
              <button
                className="dash-section__btn dash-section__btn--accent"
                onClick={handleCreateStoryline}
              >
                <span className="dash-section__btn-mark">＋</span> 新故事线
              </button>
            </div>
          </div>

          <div className="dash-tracks">
            {storylineStats.map(({ s, index, sNodes, done, draft, total, wc, color }) => {
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
                        : `${total} 章 · ${done} 完成 · ${draft} 草稿 · ${total - done - draft} 未起`}
                    </div>
                  </div>

                  <div className="dash-track__chapters" title={`${total} chapters`}>
                    {sNodes.map((n) => {
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
                        章
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
                      {(wc / 1000).toFixed(1)}
                      <em>k</em>
                    </span>
                    <span className="dash-track__wc-k">字 · words</span>
                  </div>
                </div>
              );
            })}

            <div className="dash-track dash-track--new" onClick={handleCreateStoryline}>
              <span className="dash-track--new-glyph">＋</span>
              <span>新建故事线 · NEW STORYLINE</span>
            </div>
          </div>
        </section>

        {/* ════════ ELEMENT CATEGORIES + ACTIVITY ════════ */}
        <div className="dash-row dash-row--2">
          {/* Element categories */}
          <section className="dash-section" style={{ marginBottom: 0 }}>
            <div className="dash-section__head">
              <div className="dash-section__title">
                <span className="dash-section__title-mark">◆</span>
                <span className="dash-section__title-cn">元素类目</span>
                <span className="dash-section__title-en">Element Categories</span>
                <span className="dash-section__count">
                  · <em>{bookElementCategories.length}</em> 类 / <em>{bookElements.length}</em> 个
                </span>
              </div>
              <div className="dash-section__actions">
                <button
                  className="dash-section__btn dash-section__btn--accent"
                  onClick={handleCreateCategory}
                >
                  <span className="dash-section__btn-mark">＋</span> 新类目
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
                        <span className="dash-cat__samples-empty">— 暂无元素 —</span>
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
                <span className="dash-cat--new__glyph">＋</span>
                <span>新建类目</span>
              </div>
            </div>
          </section>

          {/* Recent activity */}
          <section className="dash-section" style={{ marginBottom: 0 }}>
            <div className="dash-section__head">
              <div className="dash-section__title">
                <span className="dash-section__title-mark">✦</span>
                <span className="dash-section__title-cn">近日动向</span>
                <span className="dash-section__title-en">Recent</span>
                <span className="dash-section__count">
                  · <em>{recentActivity.length}</em> 条
                </span>
              </div>
              <div className="dash-section__actions">
                <button className="dash-section__btn" onClick={openAllChapters}>
                  通览全书 →
                </button>
              </div>
            </div>

            <div className="dash-act">
              {recentActivity.length === 0 ? (
                <div className="dash-act-row" style={{ gridTemplateColumns: '1fr' }}>
                  <span className="dash-cat__samples-empty">— 暂无动向 —</span>
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

        {/* ════════ WRITING PLAN ════════
            Per-project goals (project word target + daily quota). Both are
            stored in writing-stats-store (localStorage), independent of
            the Project model, so a fresh project picks reasonable defaults
            without a DB migration. */}
        {projectId && (
          <section className="dash-section">
            <div className="dash-section__head">
              <div className="dash-section__title">
                <span className="dash-section__title-mark">◷</span>
                <span className="dash-section__title-cn">写作计划</span>
                <span className="dash-section__title-en">Writing Plan</span>
                <span className="dash-section__count">
                  · 项目 <em>{(totalWc / 1000).toFixed(1)}k</em>
                  {targetWc > 0 ? ` / ${(targetWc / 1000).toFixed(0)}k` : ''} 字
                </span>
              </div>
            </div>

            <div className="dash-plan">
              <label className="dash-plan__field">
                <span className="dash-plan__label">项目总目标 · TARGET</span>
                <span className="dash-plan__input-wrap">
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    className="dash-plan__input"
                    value={projectPlan.projectWordTarget}
                    onChange={(e) =>
                      setProjectWordTarget(projectId, Number(e.target.value) || 0)
                    }
                  />
                  <span className="dash-plan__unit">字</span>
                </span>
                <span className="dash-plan__hint">
                  整书规模上限。设为 0 关闭目标进度条。
                </span>
              </label>

              <label className="dash-plan__field">
                <span className="dash-plan__label">每日目标 · DAILY</span>
                <span className="dash-plan__input-wrap">
                  <input
                    type="number"
                    min={0}
                    step={100}
                    className="dash-plan__input"
                    value={projectPlan.dailyWordGoal}
                    onChange={(e) =>
                      setDailyWordGoal(projectId, Number(e.target.value) || 0)
                    }
                  />
                  <span className="dash-plan__unit">字 / 天</span>
                </span>
                <span className="dash-plan__hint">
                  今日进度与连续写作天数都依此判定。
                </span>
              </label>

              <div className="dash-plan__progress">
                <div className="dash-plan__progress-row">
                  <span className="dash-plan__progress-k">项目进度</span>
                  <span className="dash-plan__progress-v">
                    {targetWc > 0 ? `${projectGoalPct.toFixed(1)}%` : '未设目标'}
                  </span>
                </div>
                <div className="dash-plan__bar">
                  <div
                    className="dash-plan__bar-fill"
                    style={{ width: `${projectGoalPct}%` }}
                  ></div>
                </div>
                <div className="dash-plan__progress-row">
                  <span className="dash-plan__progress-k">今日进度</span>
                  <span className="dash-plan__progress-v">
                    {dailyGoal > 0
                      ? `${writingStats.todayWords.toLocaleString()} / ${dailyGoal.toLocaleString()}`
                      : '未设每日目标'}
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
        {currentProject && (
          <section className="dash-section">
            <div className="dash-section__head">
              <div className="dash-section__title">
                <span className="dash-section__title-mark">¶</span>
                <span className="dash-section__title-cn">本书简介</span>
                <span className="dash-section__title-en">Project Profile</span>
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
        {currentProject && (
          <div className="dash-row dash-row--2">
            <section className="dash-section" style={{ marginBottom: 0 }}>
              <div className="dash-section__head">
                <div className="dash-section__title">
                  <span className="dash-section__title-mark">⁂</span>
                  <span className="dash-section__title-cn">本书字段</span>
                  <span className="dash-section__title-en">Project Facts</span>
                </div>
              </div>
              <div style={{ padding: '0 4px' }}>
                <KvEditor
                  key={`proj-kv-${currentProject.id}`}
                  valueJson={currentProject.kvJson}
                  onPersist={commitProjectKv}
                  emptyHint="— 暂无字段 —"
                />
              </div>
            </section>

            <section className="dash-section" style={{ marginBottom: 0 }}>
              <div className="dash-section__head">
                <div className="dash-section__title">
                  <span className="dash-section__title-mark">§</span>
                  <span className="dash-section__title-cn">故事线字段模版</span>
                  <span className="dash-section__title-en">Storyline Template</span>
                </div>
              </div>
              <div style={{ padding: '0 4px' }}>
                <KvEditor
                  key={`proj-sl-tpl-${currentProject.id}`}
                  valueJson={currentProject.storylineTemplateKvJson}
                  onPersist={commitStorylineTemplateKv}
                  variant="template"
                  emptyHint="— 尚未定义模版字段。可加 视角 / 主角 / 时间线 等 —"
                />
              </div>
            </section>
          </div>
        )}

        {/* ════════ SHADOW RULES ════════
            Temporary authoring surface for shadow review rules (freeform; an LLM
            compiles each into a checklist). Parked here until a dedicated UX. */}
        {currentProject && <ShadowRulesSection projectId={currentProject.id} />}

        {/* ════════ FOOTER ════════ */}
        <footer className="dash-foot">
          <span>Drifting · v3.2 · draft</span>
          <span className="dash-foot__ornament">⁂</span>
          {/* TODO: surface real backup status from the sync subsystem. */}
          <span>本地 · 自动备份</span>
        </footer>
      </div>
    </div>
  );
}
