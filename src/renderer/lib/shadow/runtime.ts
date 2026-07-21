import { evaluateRules } from './review-evaluator';
import type {
  Finding,
  ReviewContext,
  RuleSpec,
  SemanticViolation,
  ShadowDecision,
  ShadowDeps,
  ShadowJobEvent,
  ShadowJobInput,
  ShadowJobResult,
} from './review-types';

/** Renderer-owned tool dispatcher used by the existing Shadow handlers. */
export type ShadowToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Adapt the existing renderer handlers to the narrow review dependency surface.
 * The names remain stable because they are also used by eval fixtures; dispatch
 * is an in-process function call.
 */
export function createRendererShadowDeps(call: ShadowToolCall): ShadowDeps {
  return {
    async readChapterSnapshot(chapterId: string): Promise<ReviewContext> {
      return (await call('shadow_read_chapter_snapshot', { chapterId })) as ReviewContext;
    },
    async readRules(projectId: string, chapterId: string): Promise<RuleSpec[]> {
      return (await call('shadow_read_rules', { projectId, chapterId })) as RuleSpec[];
    },
    async evaluateSemanticBatch(
      assertions: string[],
      ctx: ReviewContext,
      rule?: { kind?: string; judgingGuide?: string },
    ): Promise<SemanticViolation[][]> {
      return (await call('shadow_eval_semantic_batch', {
        assertions,
        chapterId: ctx.chapterId,
        projectId: ctx.projectId,
        facts: ctx.rulesKv,
        summary: ctx.summary,
        ruleKind: rule?.kind,
        judgingGuide: rule?.judgingGuide,
      })) as SemanticViolation[][];
    },
    async commitReview(
      chapterId: string,
      findings: Finding[],
      status: ShadowDecision,
    ): Promise<void> {
      await call('shadow_commit_review', { chapterId, findings, status });
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Shadow review cancelled', 'AbortError');
}

/**
 * Platform-neutral five-stage review pipeline:
 * gather -> resolve -> check -> emit -> decide.
 *
 * This is intentionally equivalent to the former LangGraph topology. Keeping
 * the stages explicit avoids shipping a Node-oriented main-process runtime into
 * mobile webviews while preserving the evaluator and mutation boundaries.
 */
export async function runShadowJob(
  job: ShadowJobInput,
  deps: ShadowDeps,
  signal?: AbortSignal,
  onCommitBoundary?: () => void,
): Promise<ShadowJobResult> {
  throwIfAborted(signal);
  const context = await deps.readChapterSnapshot(job.chapterId);

  throwIfAborted(signal);
  const rules = await deps.readRules(job.projectId, job.chapterId);

  throwIfAborted(signal);
  const findings = await evaluateRules(rules, context, deps.evaluateSemanticBatch);

  // A cancelled semantic fetch is deliberately checked before any mutation. The
  // evaluator's provider-outage fallback remains unchanged for real failures.
  throwIfAborted(signal);
  const decision: ShadowDecision = findings.length > 0 ? 'draft' : 'finished';
  // This is the commit boundary. Cancellation is honored immediately before
  // it; once the atomic local transaction starts, it is allowed to finish so a
  // late abort cannot expose an empty/partial comment set.
  onCommitBoundary?.();
  await deps.commitReview(job.chapterId, findings, decision);
  return { chapterId: job.chapterId, decision, findingCount: findings.length };
}

const listeners = new Set<(event: ShadowJobEvent) => void>();
const queue: ShadowJobInput[] = [];
const runControllers = new Map<string, AbortController>();
const committing = new Set<string>();
let deps: ShadowDeps | null = null;
let draining = false;

function emit(event: ShadowJobEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('[shadow] lifecycle listener failed', error);
    }
  }
}

/** Install/replace the renderer dependencies and resume any early queued work. */
export function configureShadowRuntime(nextDeps: ShadowDeps): void {
  deps = nextDeps;
  void drain();
}

export function subscribeShadowJobEvents(listener: (event: ShadowJobEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Serial queue that coalesces active jobs with the same persisted job key. */
export function enqueueShadowJob(job: ShadowJobInput): void {
  if (
    queue.some((queued) => queued.chapterId === job.chapterId) ||
    runControllers.has(job.chapterId)
  ) {
    return;
  }
  queue.push(job);
  void drain();
}

/**
 * Cancel queued or pre-commit work. Once the synchronous commit boundary has
 * been crossed, cancellation is rejected so callers do not persist a stopped
 * lifecycle state for a review whose atomic mutation will still finish.
 */
export function cancelShadowJob(chapterId: string): boolean {
  const queued = queue.findIndex((job) => job.chapterId === chapterId);
  if (queued !== -1) {
    queue.splice(queued, 1);
    return true;
  }
  if (committing.has(chapterId)) return false;
  const controller = runControllers.get(chapterId);
  if (controller) controller.abort();
  // No live runtime entry means there is nothing capable of crossing a later
  // commit boundary (for example, an orphaned durable row after restart), so it
  // is safe for the recorder to finalize that row as stopped.
  return true;
}

async function drain(): Promise<void> {
  if (draining || !deps) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;
      const currentDeps = deps;
      if (!currentDeps) {
        queue.unshift(job);
        break;
      }

      const controller = new AbortController();
      runControllers.set(job.chapterId, controller);
      emit({ chapterId: job.chapterId, projectId: job.projectId, state: 'started' });
      try {
        const result = await runShadowJob(job, currentDeps, controller.signal, () => {
          committing.add(job.chapterId);
        });
        emit({
          chapterId: job.chapterId,
          projectId: job.projectId,
          state: 'completed',
          decision: result.decision,
          findingCount: result.findingCount,
        });
      } catch (error) {
        const expectedCancellation =
          error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'ShadowCancelledError');
        if (!expectedCancellation) {
          console.error('[shadow] job failed —', job.chapterId, error);
        }
        emit({
          chapterId: job.chapterId,
          projectId: job.projectId,
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        committing.delete(job.chapterId);
        runControllers.delete(job.chapterId);
      }
    }
  } finally {
    draining = false;
    // An enqueue can land after the loop observes an empty queue but before the
    // flag clears. Re-check once so that race cannot strand a durable job.
    if (queue.length > 0 && deps) void drain();
  }
}
