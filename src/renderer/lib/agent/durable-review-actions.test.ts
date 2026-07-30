import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
} from '../../domain/agent-runtime-write-effect';
import { useAgentEditStore } from '../../store/agent-edit-store';
import type { AgentBlockChange } from './block-diff';
import {
  approveDurableAgentReview,
  approveDurableAgentReviewsForEntity,
  DurableReviewSettlementError,
  rejectDurableAgentReviewsForEntity,
} from './durable-review-actions';

beforeEach(() => {
  useAgentEditStore.getState().clearAll();
});

describe('durable Agent review UI actions', () => {
  it('approves one durable batch, marks it settled, and recomputes A→C to A→B', async () => {
    const fixture = seedTwoEffects();
    const acceptReview = vi.fn(async (reviewId: string) =>
      decision(reviewId, 'accepted_effect'),
    );

    await approveDurableAgentReview(
      fixture.secondReviewId,
      acceptReview,
      () =>
        useAgentEditStore
          .getState()
          .resolveReviews([fixture.secondReviewId]),
    );

    expect(acceptReview).toHaveBeenCalledWith(fixture.secondReviewId);
    expect(useAgentEditStore.getState()).toMatchObject({
      reviewOrder: [fixture.firstReviewId],
      settledReviewIds: { [fixture.secondReviewId]: true },
      pending: {
        'node:node-1': {
          changes: [
            expect.objectContaining({
              oldText: 'A',
              newText: 'B',
              reviewId: fixture.firstReviewId,
            }),
          ],
        },
      },
    });
    expect(
      useAgentEditStore.getState().recordReview(
        'node',
        'node-1',
        [change('B', 'C')],
        'approve',
        {
          effectId: fixture.secondEffectId,
          reviewId: fixture.secondReviewId,
        },
      ),
    ).toBe(false);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([
      fixture.firstReviewId,
    ]);
  });

  it('rejects A→B→C in reverse effect order and records feedback only after both guarded inverses succeed', async () => {
    const fixture = seedTwoEffects();
    const calls: string[] = [];
    const rejectReview = vi.fn(async (reviewId: string) => {
      calls.push(reviewId);
      return decision(reviewId, 'reverted');
    });

    await rejectDurableAgentReviewsForEntity({
      entityType: 'node',
      id: 'node-1',
      batches: useAgentEditStore.getState(),
      rejectReview,
      onAllReverted(reviewIds, batches) {
        const store = useAgentEditStore.getState();
        for (const batch of batches) {
          for (const change of batch.changes) {
            store.recordRevert(
              'project-1',
              batch.entityType,
              batch.id,
              change,
            );
          }
        }
        store.resolveReviews([...reviewIds]);
      },
    });

    expect(calls).toEqual([
      fixture.secondReviewId,
      fixture.firstReviewId,
    ]);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([]);
    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();
    expect(useAgentEditStore.getState().pendingReverts).toHaveLength(2);
  });

  it('keeps every local batch pending and emits no feedback when the second guarded inverse fails', async () => {
    const fixture = seedTwoEffects();
    const calls: string[] = [];
    const rejectReview = vi.fn(async (reviewId: string) => {
      calls.push(reviewId);
      return decision(
        reviewId,
        reviewId === fixture.secondReviewId
          ? 'reverted'
          : 'revert_failed',
      );
    });
    const onAllReverted = vi.fn();

    await expect(
      rejectDurableAgentReviewsForEntity({
        entityType: 'node',
        id: 'node-1',
        batches: useAgentEditStore.getState(),
        rejectReview,
        onAllReverted,
      }),
    ).rejects.toEqual(
      new DurableReviewSettlementError(
        fixture.firstReviewId,
        'revert_failed',
      ),
    );

    expect(calls).toEqual([
      fixture.secondReviewId,
      fixture.firstReviewId,
    ]);
    expect(onAllReverted).not.toHaveBeenCalled();
    expect(useAgentEditStore.getState().reviewOrder).toEqual([
      fixture.firstReviewId,
      fixture.secondReviewId,
    ]);
    expect(
      useAgentEditStore.getState().pending['node:node-1']?.changes,
    ).toEqual([
      expect.objectContaining({ oldText: 'A', newText: 'C' }),
    ]);
    expect(useAgentEditStore.getState().pendingReverts).toEqual([]);
  });

  it('settles every merged review for one patch without touching another patch on the element', async () => {
    const store = useAgentEditStore.getState();
    const reviewA = 'agent-review:patch-a-1';
    const reviewB = 'agent-review:patch-a-2';
    const reviewOther = 'agent-review:patch-other';
    store.recordReview(
      'element',
      'element-1',
      [patchChange('patch-a', 'A', 'B')],
      'approve',
      { effectId: 'patch-a-1', reviewId: reviewA },
    );
    store.recordReview(
      'element',
      'element-1',
      [patchChange('patch-a', 'B', 'C')],
      'approve',
      { effectId: 'patch-a-2', reviewId: reviewB },
    );
    store.recordReview(
      'element',
      'element-1',
      [patchChange('patch-other', 'X', 'Y')],
      'approve',
      { effectId: 'patch-other', reviewId: reviewOther },
    );
    const acceptReview = vi.fn(async (reviewId: string) =>
      decision(reviewId, 'accepted_effect'),
    );

    await approveDurableAgentReviewsForEntity({
      entityType: 'element',
      id: 'element-1',
      batches: useAgentEditStore.getState(),
      matchesBatch: (batch) =>
        batch.changes.some(
          (candidate) => candidate.field?.key === 'patch-a',
        ),
      acceptReview,
      onAllAccepted: (reviewIds) =>
        useAgentEditStore.getState().resolveReviews([...reviewIds]),
    });

    expect(acceptReview.mock.calls.map(([reviewId]) => reviewId)).toEqual([
      reviewA,
      reviewB,
    ]);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([
      reviewOther,
    ]);
    expect(
      useAgentEditStore.getState().pending['element:element-1']?.changes,
    ).toEqual([
      expect.objectContaining({
        field: expect.objectContaining({ key: 'patch-other' }),
      }),
    ]);
  });
});

function seedTwoEffects() {
  const firstEffectId = 'agent-write:effect-1';
  const firstReviewId = `agent-review:${firstEffectId}`;
  const secondEffectId = 'agent-write:effect-2';
  const secondReviewId = `agent-review:${secondEffectId}`;
  const store = useAgentEditStore.getState();
  store.recordReview(
    'node',
    'node-1',
    [change('A', 'B')],
    'approve',
    { effectId: firstEffectId, reviewId: firstReviewId },
  );
  store.recordReview(
    'node',
    'node-1',
    [change('B', 'C')],
    'approve',
    { effectId: secondEffectId, reviewId: secondReviewId },
  );
  return {
    firstEffectId,
    firstReviewId,
    secondEffectId,
    secondReviewId,
  };
}

function change(oldText: string, newText: string): AgentBlockChange {
  return {
    blockId: 'block-a',
    op: 'changed',
    oldText,
    newText,
    afterPrevId: null,
  };
}

function patchChange(
  patchId: string,
  oldText: string,
  newText: string,
): AgentBlockChange {
  return {
    blockId: `field:patch:${patchId}`,
    op: 'changed',
    oldText,
    newText,
    afterPrevId: null,
    field: { kind: 'patch', key: patchId, label: patchId },
  };
}

function decision(
  reviewId: string,
  status: PersistedAgentRuntimeWriteReview['status'],
) {
  return {
    review: {
      id: reviewId,
      status,
    } as PersistedAgentRuntimeWriteReview,
    effect: {} as PersistedAgentRuntimeWriteEffect,
  };
}
