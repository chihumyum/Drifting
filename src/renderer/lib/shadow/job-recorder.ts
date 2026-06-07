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
  ConsultedSnapshotRef,
  ShadowConsultedRef,
  ShadowJob,
  ShadowJobStatus,
  ShadowToolCall,
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

// In-flight AbortControllers keyed by chapterId. The heavy LLM judge runs in THIS
// renderer (shadow_eval_semantic_batch), so the cancelled flag alone only takes
// effect at the NEXT bridge-handler entry — a long in-flight LLM round-trip keeps
// the main worker's serial queue blocked ("排队"). Aborting the controller cancels
// the fetch immediately → the bridge handler rejects → main's graph.invoke rejects
// → its drain() frees `running` and the next job starts. This is what makes Stop
// both immediate AND non-blocking.
const aborters = new Map<string, AbortController>();

/** Signal for this chapter's in-flight judge. The eval handler threads it into
 *  client.complete so Stop can abort the fetch. Reuses one controller per review;
 *  a fresh controller is minted if the previous one was already aborted. */
export function registerShadowAborter(chapterId: string): AbortSignal {
  const ex = aborters.get(chapterId);
  if (ex && !ex.signal.aborted) return ex.signal;
  const ac = new AbortController();
  aborters.set(chapterId, ac);
  return ac.signal;
}

/** Abort this chapter's in-flight judge (if any) and drop the controller. */
export function abortShadowJob(chapterId: string): void {
  const ac = aborters.get(chapterId);
  if (ac) {
    ac.abort();
    aborters.delete(chapterId);
  }
}

/** Is a review for this chapter genuinely in-flight in THIS session? Lets the
 *  loader tell a live 'running' row from one orphaned by a prior session/reload. */
export function isShadowActive(chapterId: string): boolean {
  return activeByChapter.has(chapterId) || creating.has(chapterId);
}

function titleOf(chapterId: string): string {
  return useDataStore.getState().bookNodes.find((n) => n.id === chapterId)?.title || '章节';
}

function pushStore(job: ShadowJob): void {
  useDataStore.getState().upsertShadowJob({ ...job });
}

// Trace writes are DEBOUNCED. A fast review fires many steps; rewriting the whole
// traceJson blob on every one is O(n²) write volume. We coalesce into a periodic
// flush — the in-memory + store copy stays live for the UI, and finish/stop write
// the final full trace — so a crash loses at most ~1s of trail, not the whole row.
const TRACE_FLUSH_DELAY = 1000;
const flushTimers = new Map<string, number>(); // jobId → pending flush timer

function scheduleTraceFlush(job: ShadowJob): void {
  if (flushTimers.has(job.id)) return; // a flush is already queued; it reads job.trace fresh
  const t = window.setTimeout(() => {
    flushTimers.delete(job.id);
    void repo.update(job.id, { trace: job.trace }).catch(() => {});
  }, TRACE_FLUSH_DELAY);
  flushTimers.set(job.id, t);
}

function cancelTraceFlush(jobId: string): void {
  const t = flushTimers.get(jobId);
  if (t !== undefined) {
    window.clearTimeout(t);
    flushTimers.delete(jobId);
  }
}

/** The chapter's non-terminal persisted row (durable queue: 'queued' from
 *  enqueue, or a 'running' orphan from a prior session), if any. */
function findResumableRow(chapterId: string, projectId: string): ShadowJob | undefined {
  return useDataStore
    .getState()
    .shadowJobs.find(
      (j) =>
        j.chapterId === chapterId &&
        j.projectId === projectId &&
        (j.status === 'queued' || j.status === 'running'),
    );
}

async function ensureActive(chapterId: string, projectId: string): Promise<ShadowJob> {
  const ex = activeByChapter.get(chapterId);
  if (ex) return ex;
  const inflight = creating.get(chapterId);
  if (inflight) return inflight;
  // ADOPT the persisted queue row (created at enqueue) instead of minting a new
  // one — the durable queue's source of truth. Synchronous set wins any race
  // between the worker's `started` IPC and the first bridge call's traceShadow.
  const existing = findResumableRow(chapterId, projectId);
  if (existing) {
    const at = new Date().toISOString();
    // startedAt = run-start (now), so "耗时" measures the run, not the queue wait.
    const adopted: ShadowJob = { ...existing, status: 'running', startedAt: at, updatedAt: at };
    activeByChapter.set(chapterId, adopted);
    pushStore(adopted);
    void repo.update(adopted.id, { status: 'running', startedAt: at }).catch(() => {});
    return adopted;
  }
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

/**
 * Durable enqueue: persist a 'queued' row BEFORE asking the main worker to run,
 * so the request survives a restart (loadInitial resumes it). Reuses the
 * chapter's existing non-terminal row to coalesce duplicate requests. This is the
 * single entry point every trigger (完成 / 复审 / 批量) should go through.
 */
export async function enqueueShadowReview(chapterId: string, projectId: string): Promise<void> {
  if (!chapterId || !projectId) return;
  // Guard: chapterId must be a real chapter in this project. Catches swapped args
  // / stale ids before they mint a phantom job row that the engine can't resolve
  // ("no chapter <id>"). Nodes are always loaded by the time any trigger fires.
  const node = useDataStore.getState().bookNodes.find((n) => n.id === chapterId);
  if (!node || node.projectId !== projectId) {
    console.warn(`[shadow] enqueue skipped — "${chapterId}" is not a chapter in project "${projectId}"`);
    return;
  }
  // Already running in THIS session → the in-flight review will produce a result;
  // a second enqueue would double-queue it in the main worker. No-op.
  if (activeByChapter.has(chapterId)) return;
  clearShadowCancelled(chapterId); // a fresh request overrides a prior stop
  aborters.delete(chapterId); // drop any aborted controller from a prior stop
  const at = new Date().toISOString();
  const existing = findResumableRow(chapterId, projectId);
  let job: ShadowJob;
  if (existing) {
    // Reuse the chapter's existing non-terminal row (coalesce) — flip it to queued.
    // The worker re-emits started → ensureActive adopts it back to running.
    job = { ...existing, status: 'queued', error: null, finishedAt: null, updatedAt: at };
  } else {
    job = await repo.create({ projectId, chapterId, chapterTitle: titleOf(chapterId), startedAt: at });
    job = { ...job, status: 'queued' };
  }
  pushStore(job);
  void repo
    .update(job.id, { status: 'queued', error: null, finishedAt: null })
    .catch(() => {});
  try {
    window.electronAPI?.shadow?.enqueue({ projectId, chapterId });
  } catch {
    /* main may not be ready — the queued row persists and loadInitial resumes it */
  }
}

export interface TraceOpts {
  detail?: string;
  items?: string[];
  calls?: ShadowToolCall[];
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
      calls: opts?.calls && opts.calls.length ? opts.calls : undefined,
    };
    job.trace = [...job.trace, step];
    job.updatedAt = step.at;
    pushStore(job);
    scheduleTraceFlush(job);
  } catch {
    /* telemetry must never break a review */
  }
}

/** Record the canon entities this review actually consulted (the precise
 *  dependency edges). Called once near the end of a review (shadow_set_status).
 *  Best-effort telemetry — never throws into the review. */
export async function setShadowConsulted(
  chapterId: string,
  projectId: string,
  consulted: ShadowConsultedRef[],
  snapshot: ConsultedSnapshotRef[] = [],
): Promise<void> {
  if (cancelled.has(chapterId)) return;
  try {
    const job = activeByChapter.get(chapterId) ?? (await ensureActive(chapterId, projectId));
    job.consulted = consulted;
    job.consultedCaptured = true; // measured — even an empty set now means "no entity deps"
    job.consultedSnapshot = snapshot; // value baseline for the next re-review's diff
    job.updatedAt = new Date().toISOString();
    pushStore(job);
    await repo
      .update(job.id, { consulted, consultedCaptured: true, consultedSnapshot: snapshot })
      .catch(() => {});
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
  cancelTraceFlush(job.id); // this write carries the final full trace
  const finishedAt = new Date().toISOString();
  job.status = opts.status;
  job.decision = opts.decision ?? null;
  if (opts.findingCount !== undefined) job.findingCount = opts.findingCount;
  job.error = opts.error ?? null;
  job.finishedAt = finishedAt;
  job.updatedAt = finishedAt;
  activeByChapter.delete(chapterId);
  aborters.delete(chapterId); // review done — drop its (un-aborted) controller
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
  abortShadowJob(chapterId); // cancel the in-flight LLM fetch NOW, not at next handler entry
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
  // Finalize the EXISTING job row — NEVER mint a new one. Prefer the in-memory
  // active job; otherwise the persisted 'running' row for this chapter (e.g. one
  // left running by a prior session/reload). The old `?? ensureActive` fallback
  // minted a fresh row → a phantom "已终止" cell appeared (upsert prepends a new
  // id) while the real running row hung forever, so stop never took.
  const job =
    activeByChapter.get(chapterId) ??
    useDataStore
      .getState()
      .shadowJobs.find(
        (j) =>
          j.chapterId === chapterId &&
          j.projectId === projectId &&
          (j.status === 'running' || j.status === 'queued'),
      );
  if (!job) return;
  cancelTraceFlush(job.id); // a stale pending flush would overwrite the 已终止 trace
  const at = new Date().toISOString();
  const stopped: ShadowJob = {
    ...job,
    status: 'stopped',
    error: null,
    finishedAt: at,
    updatedAt: at,
    trace: [...job.trace, { at, phase: 'decide', label: '已终止（用户）' }],
  };
  activeByChapter.delete(chapterId);
  pushStore(stopped);
  try {
    await repo.update(stopped.id, { status: 'stopped', finishedAt: at, trace: stopped.trace });
  } catch {
    /* swallow — the in-memory/store copy is already correct */
  }
}
