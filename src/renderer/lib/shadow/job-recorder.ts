/**
 * Shadow job recorder (renderer-side). A shadow review runs in the main-process
 * LangGraph engine, but every data op bridges back to renderer handlers — so the
 * renderer is where the trail is actually observable. This module owns the
 * persisted `shadow_job` row for each in-flight review and accumulates its trace:
 *
 *   beginShadowJob(chapterId, projectId)   — created on the worker's `started` IPC
 *   traceShadow(chapterId, projectId, …)   — appended from the shadow bridge
 *                                            handlers (gather/resolve/check/emit/
 *                                            decide) as the review proceeds
 *   finishShadowJob(chapterId, …)          — finalized on `completed`/`failed`
 *
 * The in-memory job is the source of truth (updated synchronously, mirrored into
 * the data-store so the panel live-updates); DB writes are fire-and-forget and
 * converge (finish writes the full trace). Lazy-create makes ordering between the
 * `started` IPC and the first bridge call irrelevant.
 */
import { createShadowJobRepository } from '../../sqlite-repo/shadow-job-repo';
import { events } from '../events';
import { useDataStore } from '../../store/data-store';
import type {
  ShadowJob,
  ShadowJobStatus,
  ShadowTracePhase,
  ShadowTraceStep,
} from '../../domain/shadow-job';

const repo = createShadowJobRepository();
const activeByChapter = new Map<string, ShadowJob>();
const creating = new Map<string, Promise<ShadowJob>>();

// Chapters the user asked to stop. The shadow bridge handlers check this at entry
// and throw, so the in-flight run (whose slow work — the LLM judge — happens in
// THIS renderer) unwinds; the trailing worker IPC is then suppressed (see
// useShadowJobs). Auto-clears so a cancelled chapter can be reviewed again later.
const cancelled = new Map<string, number>(); // chapterId → clear-timer id

export function isShadowCancelled(chapterId: string): boolean {
  return cancelled.has(chapterId);
}

export function clearShadowCancelled(chapterId: string): void {
  const t = cancelled.get(chapterId);
  if (t !== undefined) window.clearTimeout(t);
  cancelled.delete(chapterId);
}

function markShadowCancelled(chapterId: string): void {
  clearShadowCancelled(chapterId);
  // Safety auto-clear: the run will have unwound long before this fires.
  cancelled.set(chapterId, window.setTimeout(() => cancelled.delete(chapterId), 30_000));
}

/** Thrown by shadow bridge handlers when the user has stopped this review. */
export class ShadowCancelledError extends Error {
  constructor(chapterId: string) {
    super(`shadow review cancelled: ${chapterId}`);
    this.name = 'ShadowCancelledError';
  }
}

export function throwIfShadowCancelled(chapterId: string): void {
  if (cancelled.has(chapterId)) throw new ShadowCancelledError(chapterId);
}

function titleOf(chapterId: string): string {
  return useDataStore.getState().bookNodes.find((n) => n.id === chapterId)?.title || '章节';
}

function pushStore(job: ShadowJob): void {
  useDataStore.getState().upsertShadowJob({ ...job });
}

async function ensureActive(chapterId: string, projectId: string): Promise<ShadowJob> {
  const ex = activeByChapter.get(chapterId);
  if (ex) return ex;
  const inflight = creating.get(chapterId);
  if (inflight) return inflight;
  const p = (async () => {
    const job = await repo.create({ projectId, chapterId, chapterTitle: titleOf(chapterId) });
    activeByChapter.set(chapterId, job);
    creating.delete(chapterId);
    pushStore(job);
    return job;
  })();
  creating.set(chapterId, p);
  return p;
}

/** A review started — create (or reuse) its job row. */
export async function beginShadowJob(chapterId: string, projectId: string): Promise<void> {
  await ensureActive(chapterId, projectId);
}

export interface TraceOpts {
  detail?: string;
  items?: string[];
}

/** Append one readable step to the chapter's active review trail. */
export async function traceShadow(
  chapterId: string,
  projectId: string,
  phase: ShadowTracePhase,
  label: string,
  opts?: TraceOpts,
): Promise<void> {
  // If the user stopped this review, a still-in-flight handler must not resurrect
  // a new job row via ensureActive — drop the trailing trace.
  if (cancelled.has(chapterId)) return;
  try {
    const job = await ensureActive(chapterId, projectId);
    const step: ShadowTraceStep = {
      at: new Date().toISOString(),
      phase,
      label,
      detail: opts?.detail,
      items: opts?.items && opts.items.length ? opts.items : undefined,
    };
    job.trace = [...job.trace, step];
    job.updatedAt = step.at;
    pushStore(job);
    void repo.update(job.id, { trace: job.trace });
  } catch {
    /* telemetry must never break a review */
  }
}

export interface FinishOpts {
  status: ShadowJobStatus;
  decision?: 'finished' | 'draft' | null;
  findingCount?: number;
  error?: string | null;
}

/** A review finished (or failed) — finalize and persist the job row. Ensures a
 *  row exists first (a review that fails before any bridge call still records). */
export async function finishShadowJob(
  chapterId: string,
  projectId: string,
  opts: FinishOpts,
): Promise<void> {
  const job = activeByChapter.get(chapterId) ?? (await ensureActive(chapterId, projectId));
  if (!job) return;
  const finishedAt = new Date().toISOString();
  job.status = opts.status;
  job.decision = opts.decision ?? null;
  if (opts.findingCount !== undefined) job.findingCount = opts.findingCount;
  job.error = opts.error ?? null;
  job.finishedAt = finishedAt;
  job.updatedAt = finishedAt;
  activeByChapter.delete(chapterId);
  pushStore(job);
  try {
    await repo.update(job.id, {
      status: job.status,
      decision: job.decision,
      findingCount: job.findingCount,
      error: job.error,
      finishedAt: job.finishedAt,
      trace: job.trace,
    });
  } catch {
    /* swallow — the in-memory/store copy is already correct */
  }
}

/** User pressed Stop: mark the chapter cancelled (so the in-flight judge unwinds)
 *  and finalize the job row as 'stopped'. Also asks main to drop a still-queued
 *  job. The trailing worker IPC is suppressed by the cancelled flag. */
export async function stopShadowJob(chapterId: string, projectId: string): Promise<void> {
  markShadowCancelled(chapterId);
  try {
    window.electronAPI?.shadow?.cancel?.({ chapterId });
  } catch {
    /* main may not expose cancel — the renderer flag still unwinds the run */
  }
  // Terminal notification: the trailing worker IPC is suppressed for a stopped
  // review, so the running `ai-task` row would otherwise hang. Emit `stopped`
  // here so the pill/center settle to "已终止".
  events.emit('ai-task', {
    id: `shadow:${chapterId}`,
    source: 'shadow',
    state: 'stopped',
    title: 'Shadow 审阅',
    detail: `已终止 · ${titleOf(chapterId)}`,
    chapterId,
    at: Date.now(),
  });
  const job = activeByChapter.get(chapterId) ?? (await ensureActive(chapterId, projectId));
  if (job) {
    const at = new Date().toISOString();
    job.status = 'stopped';
    job.error = null;
    job.finishedAt = at;
    job.updatedAt = at;
    job.trace = [...job.trace, { at, phase: 'decide', label: '已终止（用户）' }];
    activeByChapter.delete(chapterId);
    pushStore(job);
    try {
      await repo.update(job.id, {
        status: 'stopped',
        finishedAt: at,
        trace: job.trace,
      });
    } catch {
      /* swallow */
    }
  }
}
