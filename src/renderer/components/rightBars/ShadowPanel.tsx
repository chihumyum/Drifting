/**
 * Shadow task panel (right rail). Lists active (non-archived) shadow-review jobs
 * newest-first for the current project; each cell expands to its evidence-
 * gathering + decision trail. A running review can be stopped; a finished one can
 * be archived (archived jobs live in a collapsible footer, deletable there).
 *
 * For the LATEST review of a chapter that found issues (decision 'draft'), the
 * cell also tracks its shadow comments live (已解决 / 待办 counts) and offers:
 *   - 强制通过 — resolve all remaining comments + push the chapter to finished, or
 *   - once the user has cleared every comment (待办归零): 通过 (finish) / 重跑.
 */
import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCw,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useAuthStore } from '../../store/auth';
import { useComment } from '../../usecase/useComment';
import { useBookNode } from '../../usecase/useBookNode';
import { createShadowJobRepository } from '../../sqlite-repo/shadow-job-repo';
import { stopShadowJob } from '../../lib/shadow/job-recorder';
import { useStaleReviews, type StaleReview } from '../../usecase/useStaleReviews';
import type { ShadowJob, ShadowTracePhase } from '../../domain/shadow-job';

const PHASE_LABEL: Record<ShadowTracePhase, string> = {
  gather: '收集',
  resolve: '规则',
  check: '取证',
  emit: '批注',
  decide: '结论',
};

// Per-chapter live state of a review's shadow comments, plus what the latest
// job for that chapter can do about it.
interface ReviewInfo {
  isLatest: boolean;
  total: number;
  open: number; // status === 'open' (the still-actionable ones)
  handled: number; // resolved or converted-to-todo
  chapterFinished: boolean;
  actionable: boolean; // latest + done + decision draft + chapter not finished
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

interface StatusView {
  icon: React.ReactNode;
  color: string;
  text: string;
}

function statusView(job: ShadowJob, review: ReviewInfo): StatusView {
  // A draft review whose chapter is now finished was passed by the user.
  if (review.chapterFinished && job.decision === 'draft') {
    return { icon: <CheckCircle2 size={14} />, color: 'hsl(142 42% 40%)', text: '已通过' };
  }
  if (job.status === 'running') {
    return {
      icon: <Loader2 size={14} style={{ animation: 'drift-spin 0.9s linear infinite' }} />,
      color: 'hsl(var(--ink-2))',
      text: '审阅中…',
    };
  }
  if (job.status === 'stopped') {
    return { icon: <Square size={13} />, color: 'hsl(var(--ink-3))', text: '已终止' };
  }
  if (job.status === 'failed') {
    return { icon: <AlertTriangle size={14} />, color: 'hsl(0 64% 51%)', text: job.error || '失败' };
  }
  if (job.decision === 'finished') {
    return { icon: <CheckCircle2 size={14} />, color: 'hsl(142 42% 40%)', text: '通过' };
  }
  // decision === 'draft' (issues): prefer the live comment counts when this is the
  // chapter's current review.
  if (review.isLatest && review.total > 0) {
    return {
      icon: <AlertTriangle size={14} />,
      color: review.open > 0 ? 'hsl(32 80% 44%)' : 'hsl(142 42% 40%)',
      text: `待办 ${review.open} · 已解决 ${review.handled}/${review.total}`,
    };
  }
  if (review.actionable && review.total === 0) {
    return { icon: <CheckCircle2 size={14} />, color: 'hsl(142 42% 40%)', text: '待办归零' };
  }
  return {
    icon: <AlertTriangle size={14} />,
    color: 'hsl(32 80% 44%)',
    text: `${job.findingCount} 处待改`,
  };
}

const iconBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  background: 'transparent',
  color: 'hsl(var(--ink-4))',
  cursor: 'pointer',
  flexShrink: 0,
  padding: 3,
  borderRadius: 4,
};

const actionBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  border: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper-deep))',
  color: 'hsl(var(--ink-1))',
  cursor: 'pointer',
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 5,
};

export function ShadowPanel() {
  const { projectId, navigateToNode } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const shadowJobs = useDataStore((s) => s.shadowJobs);
  const comments = useDataStore((s) => s.comments);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const upsertShadowJob = useDataStore((s) => s.upsertShadowJob);
  const removeShadowJob = useDataStore((s) => s.removeShadowJob);
  const { resolveComment } = useComment({ projectId, userId });
  const { updateNode } = useBookNode({ projectId, userId });
  const staleReviews = useStaleReviews(projectId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [footerHeight, setFooterHeight] = useState(220);
  const [expandedArchived, setExpandedArchived] = useState<Set<string>>(new Set());
  const footerDragRef = useRef<{ startY: number; startH: number } | null>(null);

  const repo = useMemo(() => createShadowJobRepository(), []);

  const mine = useMemo(
    () =>
      shadowJobs
        .filter((j) => j.projectId === projectId)
        .slice()
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    [shadowJobs, projectId],
  );
  const jobs = useMemo(() => mine.filter((j) => !j.archived), [mine]);
  const archived = useMemo(() => mine.filter((j) => j.archived), [mine]);

  // First (newest) job per chapter is the "current" one whose comments are live.
  const latestIdByChapter = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of mine) if (!m.has(j.chapterId)) m.set(j.chapterId, j.id);
    return m;
  }, [mine]);

  // Live shadow-comment tally per chapter.
  const tallyByChapter = useMemo(() => {
    const m = new Map<string, { total: number; open: number }>();
    for (const c of comments) {
      if (c.source !== 'shadow' || c.targetKind !== 'node' || !c.targetId) continue;
      const cur = m.get(c.targetId) ?? { total: 0, open: 0 };
      cur.total += 1;
      if (c.status === 'open') cur.open += 1;
      m.set(c.targetId, cur);
    }
    return m;
  }, [comments]);

  // Archivable = a settled task the user is done attending to: completed with every
  // 待办 resolved (open === 0), or manually stopped. A running review — or a done
  // one with unresolved 待办 — stays put. (The footer separately deletes archived.)
  const isArchivable = (j: ShadowJob): boolean => {
    if (j.status === 'stopped') return true;
    if (j.status !== 'done') return false; // running / failed → leave for the user
    const tally = tallyByChapter.get(j.chapterId) ?? { total: 0, open: 0 };
    return tally.open === 0;
  };
  const archivableCount = useMemo(
    () => jobs.filter(isArchivable).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, tallyByChapter],
  );

  const reviewOf = (job: ShadowJob): ReviewInfo => {
    const isLatest = latestIdByChapter.get(job.chapterId) === job.id;
    const tally = tallyByChapter.get(job.chapterId) ?? { total: 0, open: 0 };
    const chapterFinished =
      bookNodes.find((n) => n.id === job.chapterId)?.writingStatus === 'finished';
    return {
      isLatest,
      total: tally.total,
      open: tally.open,
      handled: tally.total - tally.open,
      chapterFinished,
      actionable: isLatest && job.status === 'done' && job.decision === 'draft' && !chapterFinished,
    };
  };

  const stop = (job: ShadowJob) => void stopShadowJob(job.chapterId, job.projectId);
  const archiveOne = async (job: ShadowJob) => {
    upsertShadowJob({ ...job, archived: true });
    await repo.update(job.id, { archived: true });
  };
  // Bulk-archive every settled task (done & all 待办 resolved, or manually stopped)
  // — never one with an open 待办, and never a running review.
  const archiveCompleted = async () => {
    if (!projectId) return;
    const target = jobs.filter(isArchivable);
    if (target.length === 0) return;
    for (const j of target) upsertShadowJob({ ...j, archived: true });
    await Promise.all(target.map((j) => repo.update(j.id, { archived: true })));
  };
  const deleteOne = async (id: string) => {
    await repo.delete(id);
    removeShadowJob(id);
  };

  const passChapter = async (job: ShadowJob) => {
    await updateNode(job.chapterId, { writingStatus: 'finished' });
  };
  const forcePass = async (job: ShadowJob) => {
    const open = comments.filter(
      (c) =>
        c.source === 'shadow' &&
        c.targetKind === 'node' &&
        c.targetId === job.chapterId &&
        c.status === 'open',
    );
    for (const c of open) await resolveComment(c.id);
    await updateNode(job.chapterId, { writingStatus: 'finished' });
  };
  const rerunChapter = async (chapterId: string) => {
    await updateNode(chapterId, { writingStatus: 'waiting_review' });
    window.electronAPI?.shadow?.enqueue({ projectId, chapterId });
  };
  const rerun = (job: ShadowJob) => rerunChapter(job.chapterId);

  const deleteAllArchived = async () => {
    await Promise.all(archived.map((j) => repo.delete(j.id)));
    for (const j of archived) removeShadowJob(j.id);
  };

  const startFooterDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    footerDragRef.current = { startY: e.clientY, startH: footerHeight };
    const onMove = (ev: MouseEvent) => {
      if (!footerDragRef.current) return;
      const delta = footerDragRef.current.startY - ev.clientY;
      setFooterHeight(Math.max(60, Math.min(600, footerDragRef.current.startH + delta)));
    };
    const onUp = () => {
      footerDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const toggleArchived = (id: string) => {
    setExpandedArchived((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (mine.length === 0) {
    return (
      <div style={{ padding: 12 }}>
        <div
          style={{
            padding: '16px 12px',
            borderRadius: 4,
            border: '1px dashed hsl(var(--rule))',
            textAlign: 'center',
            fontFamily: 'var(--font-serif)',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'hsl(var(--ink-4))',
            lineHeight: 1.5,
          }}
        >
          暂无 shadow 任务
          <div
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-mono)',
              fontStyle: 'normal',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              color: 'hsl(var(--ink-4))',
            }}
          >
            标记章节「已完成」即触发审阅
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>
        {staleReviews.length > 0 && (
          <StaleSection
            reviews={staleReviews}
            onReview={(id) => void rerunChapter(id)}
            onOpen={(id) => navigateToNode(id)}
          />
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '2px 6px 8px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              color: 'hsl(var(--ink-4))',
            }}
          >
            SHADOW · {jobs.length}
          </span>
          {archivableCount > 0 && (
            <button
              type="button"
              onClick={archiveCompleted}
              title="归档已处理的任务（已通过/待办已清空/已终止；不含未解决与运行中）"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                border: 'none',
                background: 'transparent',
                color: 'hsl(var(--ink-4))',
                cursor: 'pointer',
                fontSize: 11,
                padding: '2px 4px',
                borderRadius: 4,
              }}
            >
              <Archive size={12} /> 归档已完成
            </button>
          )}
        </div>

        {jobs.length === 0 ? (
          <div
            style={{
              padding: '12px',
              textAlign: 'center',
              fontSize: 12,
              color: 'hsl(var(--ink-4))',
              fontStyle: 'italic',
            }}
          >
            全部已归档
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.map((job) => (
              <JobCell
                key={job.id}
                job={job}
                review={reviewOf(job)}
                open={expanded === job.id}
                onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
                onOpenChapter={() => navigateToNode(job.chapterId)}
                onStop={() => stop(job)}
                onArchive={() => archiveOne(job)}
                onForcePass={() => void forcePass(job)}
                onPass={() => void passChapter(job)}
                onRerun={() => void rerun(job)}
              />
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          ...(showArchived && archived.length > 0 ? { height: footerHeight } : {}),
        }}
      >
          <style>{`.shadow-archived-list::-webkit-scrollbar{display:none}`}</style>
          <div
            onMouseDown={showArchived && archived.length > 0 ? startFooterDrag : undefined}
            style={{
              borderTop: '2px solid hsl(var(--rule))',
              cursor: showArchived && archived.length > 0 ? 'ns-resize' : 'default',
              flexShrink: 0,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flex: 1,
                border: 'none',
                background: 'transparent',
                color: 'hsl(var(--ink-3))',
                cursor: 'pointer',
                padding: '8px 12px',
                fontSize: 11.5,
              }}
            >
              {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Archive size={12} />
              已归档
              <span style={{ color: 'hsl(var(--ink-4))' }}>{archived.length}</span>
            </button>
            {showArchived && archived.length > 0 && (
              <button
                type="button"
                onClick={() => void deleteAllArchived()}
                title="清空已归档"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  border: 'none',
                  background: 'transparent',
                  color: 'hsl(0 50% 55%)',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '2px 10px 2px 4px',
                  borderRadius: 4,
                  flexShrink: 0,
                }}
              >
                <Trash2 size={12} /> 清空
              </button>
            )}
          </div>
          {showArchived && (
            <div
              className="shadow-archived-list"
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0 8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                scrollbarWidth: 'none',
              }}
            >
              {archived.length === 0 && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'hsl(var(--ink-4))',
                    fontStyle: 'italic',
                    padding: '8px 4px',
                  }}
                >
                  无已归档任务
                </div>
              )}
              {archived.map((job) => {
                const sv = statusView(job, reviewOf(job));
                const isOpen = expandedArchived.has(job.id);
                return (
                  <div
                    key={job.id}
                    style={{
                      border: '1px solid hsl(var(--rule) / 0.6)',
                      borderRadius: 5,
                      background: 'hsl(var(--paper-deep) / 0.5)',
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
                      <div
                        onClick={() => toggleArchived(job.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, cursor: 'pointer' }}
                      >
                        <ChevronRight
                          size={12}
                          style={{
                            color: 'hsl(var(--ink-4))',
                            flexShrink: 0,
                            transform: isOpen ? 'rotate(90deg)' : 'none',
                            transition: 'transform 0.15s ease',
                          }}
                        />
                        <span style={{ color: sv.color, display: 'flex', flexShrink: 0 }}>{sv.icon}</span>
                        <span
                          onClick={(e) => { e.stopPropagation(); navigateToNode(job.chapterId); }}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            color: 'hsl(var(--ink-2))',
                            cursor: 'pointer',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {job.chapterTitle || '章节'}
                        </span>
                      </div>
                      <button type="button" onClick={() => deleteOne(job.id)} title="彻底删除" style={iconBtn}>
                        <X size={13} />
                      </button>
                    </div>
                    {isOpen && (
                      <div
                        style={{
                          borderTop: '1px solid hsl(var(--rule) / 0.5)',
                          padding: '8px 10px 10px',
                          background: 'hsl(var(--paper-deep) / 0.3)',
                          maxHeight: 240,
                          overflowY: 'auto',
                        }}
                      >
                        {job.trace.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>无轨迹记录</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                            {job.trace.map((step, i) => (
                              <div key={i} style={{ display: 'flex', gap: 7 }}>
                                <span
                                  style={{
                                    flexShrink: 0,
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 8.5,
                                    letterSpacing: '0.04em',
                                    color: 'hsl(var(--ink-4))',
                                    background: 'hsl(var(--paper-deep))',
                                    border: '1px solid hsl(var(--rule))',
                                    borderRadius: 3,
                                    padding: '1px 4px',
                                    height: 'fit-content',
                                    marginTop: 1,
                                  }}
                                >
                                  {PHASE_LABEL[step.phase]}
                                </span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 11.5, color: 'hsl(var(--ink-1))', fontWeight: 500 }}>
                                    {step.label}
                                  </div>
                                  {step.detail && (
                                    <div style={{ fontSize: 11, color: 'hsl(var(--ink-3))', marginTop: 1, lineHeight: 1.4 }}>
                                      {step.detail}
                                    </div>
                                  )}
                                  {step.items && step.items.length > 0 && (
                                    <ul style={{ margin: '3px 0 0', paddingLeft: 14 }}>
                                      {step.items.map((it, k) => (
                                        <li key={k} style={{ fontSize: 11, color: 'hsl(var(--ink-3))', lineHeight: 1.45 }}>
                                          {it}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
    </div>
  );
}

// The incremental-review surface: finished chapters whose canon dependencies
// changed since they were last validated. The moat — edit an element and the
// chapters that lean on it light up here.
function StaleSection({
  reviews,
  onReview,
  onOpen,
}: {
  reviews: StaleReview[];
  onReview: (chapterId: string) => void;
  onOpen: (chapterId: string) => void;
}) {
  const reason = (r: StaleReview): string => {
    const names = Array.from(new Set(r.changes.map((c) => c.name)));
    const head = names.slice(0, 3).join('、');
    return names.length > 3 ? `依据 ${head} 等 ${names.length} 项已改动` : `依据 ${head} 已改动`;
  };
  return (
    <div
      style={{
        border: '1px solid hsl(32 70% 55% / 0.5)',
        background: 'hsl(38 80% 60% / 0.08)',
        borderRadius: 6,
        padding: '8px 9px 9px',
        marginBottom: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 700,
          color: 'hsl(32 70% 38%)',
          marginBottom: 7,
        }}
      >
        <AlertTriangle size={13} />
        需复审 · {reviews.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reviews.map((r) => (
          <div key={r.chapterId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                onClick={() => onOpen(r.chapterId)}
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'hsl(var(--ink-1))',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.chapterTitle || '章节'}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'hsl(var(--ink-3))',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {reason(r)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onReview(r.chapterId)}
              style={{ ...actionBtn, flexShrink: 0 }}
              title="重新审阅本章"
            >
              <RotateCw size={12} /> 复审
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobCell({
  job,
  review,
  open,
  onToggle,
  onOpenChapter,
  onStop,
  onArchive,
  onForcePass,
  onPass,
  onRerun,
}: {
  job: ShadowJob;
  review: ReviewInfo;
  open: boolean;
  onToggle: () => void;
  onOpenChapter: () => void;
  onStop: () => void;
  onArchive: () => void;
  onForcePass: () => void;
  onPass: () => void;
  onRerun: () => void;
}) {
  const sv = statusView(job, review);
  const running = job.status === 'running';
  // The FC judge's per-rule verdicts (the result) — folded by default, separate
  // from the verbose evidence trace below.
  const verdicts = job.trace.filter((s) => s.phase === 'check' && s.label.startsWith('裁决'));
  const [showResult, setShowResult] = useState(false);
  return (
    <div
      style={{
        border: '1px solid hsl(var(--rule))',
        borderRadius: 6,
        overflow: 'hidden',
        background: 'hsl(var(--paper))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px' }}>
        <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: 'pointer' }}>
          <ChevronRight
            size={13}
            style={{
              color: 'hsl(var(--ink-4))',
              flexShrink: 0,
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}
          />
          <span style={{ color: sv.color, display: 'flex', flexShrink: 0 }}>{sv.icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'hsl(var(--ink-1))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {job.chapterTitle || '章节'}
            </div>
            <div
              style={{
                fontSize: 11,
                color: sv.color,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {sv.text}
            </div>
          </div>
        </div>
        <span style={{ fontSize: 10, color: 'hsl(var(--ink-4))', flexShrink: 0 }}>
          {relTime(job.startedAt)}
        </span>
        {running ? (
          <button type="button" onClick={onStop} title="终止审阅" style={{ ...iconBtn, color: 'hsl(0 60% 52%)' }}>
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button type="button" onClick={onArchive} title="归档" style={iconBtn}>
            <Archive size={13} />
          </button>
        )}
      </div>

      {open && (
        <div
          style={{
            borderTop: '1px solid hsl(var(--rule) / 0.7)',
            padding: '8px 10px 10px',
            background: 'hsl(var(--paper-deep) / 0.4)',
          }}
        >
          {review.actionable && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {review.open > 0 ? (
                <button type="button" onClick={onForcePass} style={actionBtn} title="解决全部待办并标记本章完成">
                  <CheckCircle2 size={12} /> 强制通过（解决 {review.open} 项）
                </button>
              ) : (
                <>
                  <button type="button" onClick={onPass} style={{ ...actionBtn, borderColor: 'hsl(142 36% 50%)' }}>
                    <CheckCircle2 size={12} /> 通过
                  </button>
                  <button type="button" onClick={onRerun} style={actionBtn}>
                    <RotateCw size={12} /> 重跑
                  </button>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={onOpenChapter}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--accent, var(--ink-2)))',
              cursor: 'pointer',
              fontSize: 11,
              padding: '0 0 6px',
            }}
          >
            打开章节 →
          </button>

          {verdicts.length > 0 && (
            <div style={{ margin: '2px 0 9px' }}>
              <button
                type="button"
                onClick={() => setShowResult((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: 'hsl(var(--ink-2))',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: 0,
                }}
              >
                {showResult ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                FC 结论（{verdicts.length}）
              </button>
              {showResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 5, paddingLeft: 4 }}>
                  {verdicts.map((v, i) => {
                    const violated = v.label.includes('违反');
                    return (
                      <div key={i}>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 500,
                            color: violated ? 'hsl(var(--danger, 0 70% 50%))' : 'hsl(142 40% 40%)',
                          }}
                        >
                          {v.label.replace(/^裁决：/, '')}
                        </div>
                        {v.items && v.items.length > 0 && (
                          <ul style={{ margin: '2px 0 0', paddingLeft: 14 }}>
                            {v.items.map((it, k) => (
                              <li key={k} style={{ fontSize: 11, color: 'hsl(var(--ink-3))', lineHeight: 1.45 }}>
                                {it}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {job.trace.length === 0 ? (
            <div style={{ fontSize: 11, color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>
              {running ? '审阅进行中…' : '无轨迹记录'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {job.trace.map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 7 }}>
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8.5,
                      letterSpacing: '0.04em',
                      color: 'hsl(var(--ink-4))',
                      background: 'hsl(var(--paper-deep))',
                      border: '1px solid hsl(var(--rule))',
                      borderRadius: 3,
                      padding: '1px 4px',
                      height: 'fit-content',
                      marginTop: 1,
                    }}
                  >
                    {PHASE_LABEL[step.phase]}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, color: 'hsl(var(--ink-1))', fontWeight: 500 }}>
                      {step.label}
                    </div>
                    {step.detail && (
                      <div style={{ fontSize: 11, color: 'hsl(var(--ink-3))', marginTop: 1, lineHeight: 1.4 }}>
                        {step.detail}
                      </div>
                    )}
                    {step.items && step.items.length > 0 && (
                      <ul style={{ margin: '3px 0 0', paddingLeft: 14 }}>
                        {step.items.map((it, k) => (
                          <li key={k} style={{ fontSize: 11, color: 'hsl(var(--ink-3))', lineHeight: 1.45 }}>
                            {it}
                          </li>
                        ))}
                      </ul>
                    )}
                    {step.calls && step.calls.length > 0 && (
                      <ul style={{ margin: '3px 0 0', padding: 0, listStyle: 'none' }}>
                        {step.calls.map((c, k) => {
                          const failed = c.status !== 'ok';
                          const color =
                            c.status === 'error'
                              ? 'hsl(var(--danger, 0 70% 50%))'
                              : c.status === 'denied'
                                ? 'hsl(35 85% 42%)'
                                : 'hsl(var(--ink-3))';
                          const line = (
                            <>
                              <span style={{ flexShrink: 0, opacity: failed ? 1 : 0.55 }}>
                                {failed ? '✕' : '·'}
                              </span>{' '}
                              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                                {c.tool}
                                {c.args ? <span style={{ opacity: 0.75 }}> {c.args}</span> : null}
                                {c.note ? <span style={{ opacity: 0.85 }}> — {c.note}</span> : null}
                              </span>
                            </>
                          );
                          return (
                            <li
                              key={k}
                              style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color, lineHeight: 1.5 }}
                            >
                              {c.result ? (
                                <details>
                                  <summary style={{ cursor: 'pointer', listStyle: 'none' }}>{line}</summary>
                                  <pre
                                    style={{
                                      margin: '3px 0 5px 12px',
                                      padding: '5px 7px',
                                      fontSize: 10,
                                      lineHeight: 1.5,
                                      color: 'hsl(var(--ink-2))',
                                      background: 'hsl(var(--paper-deep))',
                                      border: '1px solid hsl(var(--rule))',
                                      borderRadius: 4,
                                      maxHeight: 200,
                                      overflow: 'auto',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      fontFamily: 'var(--font-mono)',
                                    }}
                                  >
                                    {c.result}
                                  </pre>
                                </details>
                              ) : (
                                <div>{line}</div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
