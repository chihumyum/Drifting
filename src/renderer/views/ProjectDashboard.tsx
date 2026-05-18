import { useMemo, useState } from 'react';
import { useDataStore } from '../store/data-store';
import { useStoryline } from '../usecase/useStoryline';
import { useAuthStore } from '../store/auth';
import { useProjectStore } from '../store/project-store';
import { useProjectNavigation } from '../hooks/useProjectNavigation';
import { useRecentEntitiesStore } from '../store/recent-entities-store';
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

// TODO: replace with real per-node status once the schema tracks done/draft/todo.
type DerivedStatus = 'done' | 'draft' | 'todo';
function deriveStatus(wordCount: number): DerivedStatus {
  if (wordCount >= 2000) return 'done';
  if (wordCount > 0) return 'draft';
  return 'todo';
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

export function ProjectDashboard() {
  const { projectId, openEntity } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const { storylines, bookElements, bookElementCategories, bookNodes, storylineNodeMapping } =
    useDataStore();
  const recentItems = useRecentEntitiesStore((s) => s.items);

  const { createStoryline } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  const [chip, setChip] = useState<'all' | 'draft' | 'todo' | 'done'>('all');

  // ─── Hero / aggregate stats ────────────────────────────
  const totalNodes = bookNodes.length;
  const totalWc = bookNodes.reduce((a, n) => a + (n.wordCount || 0), 0);
  // TODO: surface project target word count from settings; placeholder 120k.
  const targetWc = 120000;

  // TODO: derive done/draft/todo from a real status field once added to BookNode.
  const nodeStatuses = useMemo(() => bookNodes.map((n) => deriveStatus(n.wordCount || 0)), [bookNodes]);
  const doneNodes = nodeStatuses.filter((s) => s === 'done').length;
  const draftNodes = nodeStatuses.filter((s) => s === 'draft').length;
  const todoNodes = nodeStatuses.filter((s) => s === 'todo').length;
  const donePct = totalNodes ? Math.round((doneNodes / totalNodes) * 100) : 0;
  const draftPctTtl = totalNodes ? Math.round(((doneNodes + draftNodes) / totalNodes) * 100) : 0;

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
    const slId = continueNode.mainStorylineId;
    return storylines.find((s) => s.id === slId) ?? null;
  }, [continueNode, storylines]);

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
        const done = sNodes.filter((n) => deriveStatus(n.wordCount || 0) === 'done').length;
        const draft = sNodes.filter((n) => deriveStatus(n.wordCount || 0) === 'draft').length;
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

  const todayDateLabel = new Date().toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  // TODO: real activity log not yet wired. Placeholder feed derived from
  // the most-recently-updated nodes so the surface isn't fully empty.
  const recentActivity = useMemo(() => {
    return [...bookNodes]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 6)
      .map((n) => {
        const sl = storylines.find((s) => s.id === n.mainStorylineId);
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
  }, [bookNodes, storylines]);

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
              <span className="dash-hero__title-glyph">渡</span>
              {heroProjectTitle}
            </h1>

            {currentProject?.descriptionJson && (
              <p className="dash-hero__sub">
                {/* TODO: descriptionJson is currently raw JSON; render plain summary once parsed. */}
                {currentProject.descriptionJson.slice(0, 200)}
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
                  <em>k / {targetWc / 1000}k</em>
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
              {/* TODO: hook ⌬ 叙事图 to graph view once route exists from this page. */}
              <button className="dash-hero__btn">⌬ 叙事图</button>
              <button className="dash-hero__btn">⊞ 总览</button>
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
          <div className="dash-chip" style={{ marginLeft: 'auto' }}>
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 L14 14" />
            </svg>
            <span>搜索…</span>
            <span className="dash-chip__count" style={{ marginLeft: 4 }}>
              ⌘K
            </span>
          </div>
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
              {/* TODO: real today's word count comes from a writing-session log we don't yet have. */}
              <span className="dash-today__big">—</span>
              <span className="dash-today__unit">字</span>
            </div>
            <div className="dash-today__goal">
              {/* TODO: daily goal from user settings. */}
              目标 <b>1,500</b> 字
            </div>
            <div className="dash-today__bar">
              <div className="dash-today__bar-fill" style={{ width: '0%' }}></div>
            </div>
            <div className="dash-today__streak">
              <div className="dash-today__streak-cell">
                <span className="dash-today__streak-k">连续写作</span>
                {/* TODO: streak / weekly / monthly stats require a sessions table. */}
                <span className="dash-today__streak-v">
                  —<em>天</em>
                </span>
              </div>
              <div className="dash-today__streak-cell">
                <span className="dash-today__streak-k">本周</span>
                <span className="dash-today__streak-v">
                  —<em>字</em>
                </span>
              </div>
              <div className="dash-today__streak-cell">
                <span className="dash-today__streak-k">月内</span>
                <span className="dash-today__streak-v">
                  —<em>天</em>
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
              <button className="dash-section__btn">⌬ 时间轴</button>
              <button className="dash-section__btn">↕ 重新排序</button>
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
                      const status = deriveStatus(n.wordCount || 0);
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
                {/* TODO: wire ＋ 新类目 to createElementCategory once a UI form exists. */}
                <button className="dash-section__btn dash-section__btn--accent">
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
              <div className="dash-cat dash-cat--new">
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
                <button className="dash-section__btn">全部历史 →</button>
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
