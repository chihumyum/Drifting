import { describe, expect, it } from 'vitest';
import type { AgentRuntimeTaskPlan } from '../../../domain/agent-runtime-long-task';
import {
  AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES,
  armAgentAutomaticContinuation,
  beginAutomaticContinuationSlice,
  createInactiveAgentAutomaticContinuation,
  decideAgentAutomaticContinuation,
  markAutomaticContinuationTerminal,
  observeAgentAutomaticContinuationProgress,
  summarizeLongTaskPlanForContinuation,
} from './long-task-auto-continuation';

function plan(
  steps: AgentRuntimeTaskPlan['steps'],
  status: AgentRuntimeTaskPlan['task']['status'] = 'active',
): AgentRuntimeTaskPlan {
  return {
    task: {
      id: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      objective: 'Polish the whole book.',
      scopeKind: 'whole_book_chapters',
      status,
      revision: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      endedAt: null,
    },
    chapterManifest: [],
    steps,
    constraints: [],
  };
}

function step(
  input: Partial<AgentRuntimeTaskPlan['steps'][number]> &
    Pick<AgentRuntimeTaskPlan['steps'][number], 'id' | 'status'>,
): AgentRuntimeTaskPlan['steps'][number] {
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    ordinal: 0,
    title: input.id,
    target: null,
    resultNote: null,
    resultRef: null,
    reviewEvidence: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...input,
  };
}

describe('long-task auto continuation', () => {
  it('distinguishes runnable work, pending reviews, and finalization', () => {
    const summary = summarizeLongTaskPlanForContinuation(
      'session-1',
      plan([
        step({ id: 'pending', status: 'pending' }),
        step({
          id: 'review-pending',
          status: 'blocked',
          reviewEvidence: {
            reviewStatus: 'pending',
            outcome: 'pending',
            acceptedTargetEvidence: false,
            toolName: 'edit_block',
            settledAt: null,
          },
        }),
        step({
          id: 'review-accepted',
          status: 'blocked',
          reviewEvidence: {
            reviewStatus: 'accepted_effect',
            outcome: 'accepted_target_write',
            acceptedTargetEvidence: true,
            toolName: 'edit_block',
            settledAt: '2026-08-01T00:01:00.000Z',
          },
        }),
      ]),
    );

    expect(summary).toMatchObject({
      taskId: 'task-1',
      revision: 1,
      runnableStepCount: 2,
      waitingReviewStepCount: 1,
      needsFinalization: false,
    });

    expect(
      summarizeLongTaskPlanForContinuation(
        'session-1',
        plan([step({ id: 'done', status: 'completed' })]),
      ).needsFinalization,
    ).toBe(true);
  });

  it('arms a fresh author sequence and counts only automatic slices', () => {
    const armed = armAgentAutomaticContinuation(createInactiveAgentAutomaticContinuation(), 100);
    expect(armed).toMatchObject({
      sequenceId: 1,
      status: 'armed',
      automaticSlicesStarted: 0,
      startedAtMs: 100,
    });
    const automatic = beginAutomaticContinuationSlice(armed);
    expect(automatic.automaticSlicesStarted).toBe(1);
    expect(
      markAutomaticContinuationTerminal(automatic, {
        turnId: 'turn-2',
        costUsd: 0.25,
      }),
    ).toMatchObject({
      status: 'evaluating',
      terminalTurnId: 'turn-2',
      accumulatedCostUsd: 0.25,
    });
  });

  it('schedules unfinished durable work and pauses for review-only work', () => {
    const automatic = markAutomaticContinuationTerminal(armAgentAutomaticContinuation(null, 100), {
      turnId: 'turn-1',
      costUsd: 0.01,
    });
    const basePlan = summarizeLongTaskPlanForContinuation(
      'session-1',
      plan([step({ id: 'pending', status: 'pending' })]),
    );
    expect(
      decideAgentAutomaticContinuation({
        automatic,
        plan: basePlan,
        terminalOutcome: 'completed',
        nowMs: 200,
      }),
    ).toEqual({ kind: 'schedule' });

    expect(
      decideAgentAutomaticContinuation({
        automatic,
        plan: {
          ...basePlan,
          runnableStepCount: 0,
          waitingReviewStepCount: 1,
        },
        terminalOutcome: 'completed',
        nowMs: 200,
      }),
    ).toEqual({ kind: 'stop', status: 'paused', reason: 'waiting_review' });
  });

  it('pauses after two automatic slices make no durable-plan progress', () => {
    const planState = summarizeLongTaskPlanForContinuation(
      'session-1',
      plan([step({ id: 'pending', status: 'pending' })]),
    );
    let automatic = markAutomaticContinuationTerminal(
      armAgentAutomaticContinuation(null, 100),
      { turnId: 'turn-author', costUsd: 0 },
    );
    automatic = observeAgentAutomaticContinuationProgress(automatic, planState);
    expect(automatic.stagnantSliceCount).toBe(0);

    automatic = markAutomaticContinuationTerminal(beginAutomaticContinuationSlice(automatic), {
      turnId: 'turn-auto-1',
      costUsd: 0,
    });
    automatic = observeAgentAutomaticContinuationProgress(automatic, planState);
    expect(automatic.stagnantSliceCount).toBe(1);

    automatic = markAutomaticContinuationTerminal(beginAutomaticContinuationSlice(automatic), {
      turnId: 'turn-auto-2',
      costUsd: 0,
    });
    automatic = observeAgentAutomaticContinuationProgress(automatic, planState);
    expect(automatic.stagnantSliceCount).toBe(
      AGENT_AUTO_CONTINUATION_MAX_STAGNANT_SLICES,
    );
    expect(
      decideAgentAutomaticContinuation({
        automatic,
        plan: planState,
        terminalOutcome: 'completed',
        nowMs: 200,
      }),
    ).toEqual({ kind: 'stop', status: 'paused', reason: 'no_progress' });

    const progressed = observeAgentAutomaticContinuationProgress(
      markAutomaticContinuationTerminal(beginAutomaticContinuationSlice(automatic), {
        turnId: 'turn-auto-3',
        costUsd: 0,
      }),
      { ...planState, progressFingerprint: `${planState.progressFingerprint}:changed` },
    );
    expect(progressed).toMatchObject({
      stagnantSliceCount: 0,
      lastPlanFingerprint: `${planState.progressFingerprint}:changed`,
    });
  });

  it('fails closed on terminal failure and unavailable plans without imposing work quotas', () => {
    const base = markAutomaticContinuationTerminal(armAgentAutomaticContinuation(null, 100), {
      turnId: 'turn-1',
      costUsd: 0,
    });
    const activePlan = summarizeLongTaskPlanForContinuation(
      'session-1',
      plan([step({ id: 'pending', status: 'pending' })]),
    );
    const decide = (
      automatic: typeof base,
      nowMs = 200,
      terminalOutcome: 'completed' | 'failed' = 'completed',
    ) =>
      decideAgentAutomaticContinuation({
        automatic,
        plan: activePlan,
        terminalOutcome,
        nowMs,
      });

    expect(decide(base, 200, 'failed')).toEqual({
      kind: 'stop',
      status: 'paused',
      reason: 'turn_failed',
    });
    expect(
      decideAgentAutomaticContinuation({
        automatic: base,
        plan: null,
        terminalOutcome: 'completed',
        nowMs: 200,
      }),
    ).toEqual({ kind: 'stop', status: 'paused', reason: 'plan_unavailable' });
    expect(
      decide(
        {
          ...base,
          automaticSlicesStarted: 1_000_000,
          accumulatedCostUsd: 1_000_000,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual({ kind: 'schedule' });
  });
});
