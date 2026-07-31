import type {
  AgentRuntimeTaskPlan,
  AgentRuntimeTaskScopeKind,
  AgentRuntimeTaskStatus,
} from '../../../domain/agent-runtime-long-task';
import type { AgentRuntimeOutcome } from './types';

export const AGENT_AUTO_CONTINUATION_MAX_SLICES = 32;
export const AGENT_AUTO_CONTINUATION_MAX_DURATION_MS = 2 * 60 * 60 * 1_000;
export const AGENT_AUTO_CONTINUATION_MAX_COST_USD = 2;
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
  | 'slice_limit'
  | 'time_limit'
  | 'cost_limit'
  | 'author_stopped'
  | 'author_navigated'
  | 'author_input_pending'
  | 'waiting_permission'
  | 'waiting_user'
  | 'start_failed';

/**
 * Renderer-lifetime authorization for bounded continuation. It is deliberately
 * not persisted: reopening the App never resumes paid or mutating work without
 * a fresh author action.
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
 * reads do not reset the watchdog, so a confused model cannot burn all 32
 * slices while retrying the same invalid operation.
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
      needsFinalization: false,
      progressFingerprint: JSON.stringify({ sessionId, task: null }),
    };
  }

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
    needsFinalization:
      plan.task.status === 'active' && plan.steps.every((step) => step.status === 'completed'),
    progressFingerprint: JSON.stringify({
      taskId: plan.task.id,
      revision: plan.task.revision,
      status: plan.task.status,
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
  const { automatic, plan, terminalOutcome, nowMs } = input;
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
    return { kind: 'stop', status: 'off', reason: 'not_applicable' };
  }
  if (plan.status === 'completed' || plan.status === 'failed') {
    return { kind: 'stop', status: 'off', reason: 'task_completed' };
  }
  if (plan.status !== 'active') {
    return { kind: 'stop', status: 'paused', reason: 'task_not_active' };
  }
  if (automatic.automaticSlicesStarted >= AGENT_AUTO_CONTINUATION_MAX_SLICES) {
    return { kind: 'stop', status: 'paused', reason: 'slice_limit' };
  }
  if (
    automatic.startedAtMs === null ||
    nowMs - automatic.startedAtMs >= AGENT_AUTO_CONTINUATION_MAX_DURATION_MS
  ) {
    return { kind: 'stop', status: 'paused', reason: 'time_limit' };
  }
  if (automatic.accumulatedCostUsd >= AGENT_AUTO_CONTINUATION_MAX_COST_USD) {
    return { kind: 'stop', status: 'paused', reason: 'cost_limit' };
  }
  if (plan.waitingReviewStepCount > 0) {
    return { kind: 'stop', status: 'paused', reason: 'waiting_review' };
  }
  if (automatic.stagnantSliceCount >= AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES) {
    return { kind: 'stop', status: 'paused', reason: 'no_progress' };
  }
  if (plan.runnableStepCount > 0 || plan.needsFinalization) {
    return { kind: 'schedule' };
  }
  return { kind: 'stop', status: 'paused', reason: 'no_actionable_work' };
}
