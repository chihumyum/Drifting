import type {
  AgentRuntimeTaskChapterManifestState,
  AgentRuntimeTaskPlan,
  AgentRuntimeTaskScopeKind,
  AgentRuntimeTaskStatus,
} from '../../../domain/agent-runtime-long-task';
import type { AgentRuntimeOutcome } from './types';

export const AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES = 2;

export type AgentAutomaticContinuationStatus =
  | 'off'
  | 'armed'
  | 'evaluating'
  | 'scheduled'
  | 'paused';

export type AgentAutomaticContinuationStopReason =
  | 'not_applicable'
  | 'task_completed'
  | 'task_not_active'
  | 'waiting_review'
  | 'no_progress'
  | 'no_actionable_work'
  | 'turn_failed'
  | 'plan_unavailable'
  | 'author_stopped'
  | 'author_navigated'
  | 'author_input_pending'
  | 'waiting_permission'
  | 'waiting_user'
  | 'start_failed';

/**
 * Renderer-lifetime authorization for continuation. It is deliberately not
 * persisted: reopening the App never resumes paid or mutating work without a
 * fresh author action. The author can stop at any time; a progress watchdog
 * pauses repeated stagnant slices without imposing an arbitrary work quota.
 */
export interface AgentAutomaticContinuationState {
  sequenceId: number;
  status: AgentAutomaticContinuationStatus;
  automaticSlicesStarted: number;
  startedAtMs: number | null;
  accumulatedCostUsd: number;
  /** Last durable-plan shape observed at a terminal slice boundary. */
  lastPlanFingerprint: string | null;
  /** Consecutive automatic slices that made no durable-plan progress. */
  stagnantSliceCount: number;
  terminalTurnId: string | null;
  stopReason: AgentAutomaticContinuationStopReason | null;
}

export interface AgentLongTaskPlanContinuationState {
  sessionId: string;
  taskId: string | null;
  revision: number | null;
  /** `none` is an authoritative checked result, unlike null/unknown. */
  status: AgentRuntimeTaskStatus | 'none';
  scopeKind: AgentRuntimeTaskScopeKind | null;
  runnableStepCount: number;
  waitingReviewStepCount: number;
  manifestStatus: AgentRuntimeTaskChapterManifestState['status'] | 'unknown';
  needsManifestReconciliation: boolean;
  needsFinalization: boolean;
  /** Stable, renderer-local progress identity; never sent to a provider. */
  progressFingerprint: string;
}

export type AgentAutomaticContinuationDecision =
  | { kind: 'schedule' }
  | {
      kind: 'stop';
      status: 'off' | 'paused';
      reason: AgentAutomaticContinuationStopReason;
    };

export function createInactiveAgentAutomaticContinuation(
  sequenceId = 0,
): AgentAutomaticContinuationState {
  return {
    sequenceId,
    status: 'off',
    automaticSlicesStarted: 0,
    startedAtMs: null,
    accumulatedCostUsd: 0,
    lastPlanFingerprint: null,
    stagnantSliceCount: 0,
    terminalTurnId: null,
    stopReason: null,
  };
}

export function armAgentAutomaticContinuation(
  previous: AgentAutomaticContinuationState | null | undefined,
  nowMs: number,
): AgentAutomaticContinuationState {
  return {
    sequenceId: (previous?.sequenceId ?? 0) + 1,
    status: 'armed',
    automaticSlicesStarted: 0,
    startedAtMs: nowMs,
    accumulatedCostUsd: 0,
    lastPlanFingerprint: null,
    stagnantSliceCount: 0,
    terminalTurnId: null,
    stopReason: null,
  };
}

export function beginAutomaticContinuationSlice(
  state: AgentAutomaticContinuationState,
): AgentAutomaticContinuationState {
  return {
    ...state,
    status: 'armed',
    automaticSlicesStarted: state.automaticSlicesStarted + 1,
    terminalTurnId: null,
    stopReason: null,
  };
}

export function markAutomaticContinuationTerminal(
  state: AgentAutomaticContinuationState,
  input: { turnId: string; costUsd: number },
): AgentAutomaticContinuationState {
  if (state.status === 'off' || state.status === 'paused') return state;
  return {
    ...state,
    status: 'evaluating',
    accumulatedCostUsd: state.accumulatedCostUsd + Math.max(0, input.costUsd),
    terminalTurnId: input.turnId,
    stopReason: null,
  };
}

/**
 * Observe only durable-plan progress. Assistant prose and repeated successful
 * reads do not reset the watchdog, so a confused model cannot keep retrying the
 * same invalid operation indefinitely.
 */
export function observeAgentAutomaticContinuationProgress(
  state: AgentAutomaticContinuationState,
  plan: AgentLongTaskPlanContinuationState | null,
): AgentAutomaticContinuationState {
  if (state.status !== 'evaluating' || !plan) return state;
  if (state.lastPlanFingerprint === null) {
    return {
      ...state,
      lastPlanFingerprint: plan.progressFingerprint,
      stagnantSliceCount: 0,
    };
  }
  if (state.lastPlanFingerprint !== plan.progressFingerprint) {
    return {
      ...state,
      lastPlanFingerprint: plan.progressFingerprint,
      stagnantSliceCount: 0,
    };
  }
  // The author-triggered first slice establishes the baseline. Only subsequent
  // automatically-started slices can count as stagnation.
  if (state.automaticSlicesStarted === 0) return state;
  return {
    ...state,
    stagnantSliceCount: state.stagnantSliceCount + 1,
  };
}

export function summarizeLongTaskPlanForContinuation(
  sessionId: string,
  plan: AgentRuntimeTaskPlan | null,
  manifestState: AgentRuntimeTaskChapterManifestState | null = null,
): AgentLongTaskPlanContinuationState {
  if (!plan) {
    return {
      sessionId,
      taskId: null,
      revision: null,
      status: 'none',
      scopeKind: null,
      runnableStepCount: 0,
      waitingReviewStepCount: 0,
      manifestStatus: 'not_applicable',
      needsManifestReconciliation: false,
      needsFinalization: false,
      progressFingerprint: JSON.stringify({ sessionId, task: null }),
    };
  }

  const manifestStatus =
    manifestState?.status ??
    (plan.task.scopeKind === 'explicit_targets' ? 'not_applicable' : 'unknown');
  const needsManifestReconciliation = manifestStatus === 'drifted';

  let runnableStepCount = 0;
  let waitingReviewStepCount = 0;
  for (const step of plan.steps) {
    if (step.status === 'pending' || step.status === 'in_progress') {
      runnableStepCount += 1;
      continue;
    }
    if (step.status !== 'blocked' || !step.reviewEvidence) continue;
    const review = step.reviewEvidence;
    if (review.outcome === 'pending' || review.reviewStatus === 'revert_started') {
      waitingReviewStepCount += 1;
    } else if (review.reviewStatus !== 'missing') {
      // A settled acceptance/rejection/revert is new durable evidence the Agent
      // must fold back into this blocked step before continuing.
      runnableStepCount += 1;
    }
  }

  return {
    sessionId,
    taskId: plan.task.id,
    revision: plan.task.revision,
    status: plan.task.status,
    scopeKind: plan.task.scopeKind,
    runnableStepCount,
    waitingReviewStepCount,
    manifestStatus,
    needsManifestReconciliation,
    needsFinalization:
      plan.task.status === 'active' &&
      manifestStatus !== 'unknown' &&
      !needsManifestReconciliation &&
      plan.steps.every(
        (step) => step.status === 'completed' || step.status === 'retired',
      ),
    progressFingerprint: JSON.stringify({
      taskId: plan.task.id,
      status: plan.task.status,
      manifest: manifestState
        ? {
            status: manifestState.status,
            current: manifestState.current.map((chapter) => ({
              ordinal: chapter.ordinal,
              id: chapter.resolvedChapterId,
              name: chapter.name,
            })),
          }
        : null,
      steps: plan.steps.map((step) => ({
        id: step.id,
        status: step.status,
        resultRef: step.resultRef,
        reviewStatus: step.reviewEvidence?.reviewStatus ?? null,
        reviewOutcome: step.reviewEvidence?.outcome ?? null,
        acceptedTargetEvidence: step.reviewEvidence?.acceptedTargetEvidence ?? false,
      })),
    }),
  };
}

export function decideAgentAutomaticContinuation(input: {
  automatic: AgentAutomaticContinuationState;
  plan: AgentLongTaskPlanContinuationState | null;
  terminalOutcome: AgentRuntimeOutcome;
  nowMs: number;
}): AgentAutomaticContinuationDecision {
  const { automatic, plan, terminalOutcome } = input;
  if (automatic.status !== 'evaluating') {
    return { kind: 'stop', status: 'off', reason: 'not_applicable' };
  }
  if (terminalOutcome !== 'completed' && terminalOutcome !== 'budget_exceeded') {
    return { kind: 'stop', status: 'paused', reason: 'turn_failed' };
  }
  if (!plan) {
    return { kind: 'stop', status: 'paused', reason: 'plan_unavailable' };
  }
  if (plan.status === 'none') {
    // A physical context boundary is resumable even when the model ignored the
    // durable-plan instruction. Continuous execution is explicit author
    // authority, and a missing plan must not turn compaction into a task stop.
    // A normally completed planless turn is still terminal.
    return terminalOutcome === 'budget_exceeded'
      ? { kind: 'schedule' }
      : { kind: 'stop', status: 'off', reason: 'not_applicable' };
  }
  if (plan.status === 'completed' || plan.status === 'failed') {
    return { kind: 'stop', status: 'off', reason: 'task_completed' };
  }
  if (plan.status !== 'active') {
    return { kind: 'stop', status: 'paused', reason: 'task_not_active' };
  }
  if (automatic.stagnantSliceCount >= AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES) {
    return { kind: 'stop', status: 'paused', reason: 'no_progress' };
  }
  if (
    plan.runnableStepCount > 0 ||
    plan.needsManifestReconciliation ||
    plan.needsFinalization
  ) {
    return { kind: 'schedule' };
  }
  if (plan.waitingReviewStepCount > 0) {
    return { kind: 'stop', status: 'paused', reason: 'waiting_review' };
  }
  return { kind: 'stop', status: 'paused', reason: 'no_actionable_work' };
}
