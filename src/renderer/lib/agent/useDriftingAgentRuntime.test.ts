import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
} from '../../domain/agent-runtime-write-effect';
import type { AgentRuntimeWriteEffectRepository } from '../../sqlite-repo/agent-runtime-write-effect-repo';
import {
  retireLegacyAgentReviewPersistence,
  useAgentEditStore,
} from '../../store/agent-edit-store';
import { reconcileAgentEditReviewCache } from './useDriftingAgentRuntime';

const REVIEW_ID = 'agent-review:agent-write:legacy';
const EFFECT_ID = 'agent-write:legacy';

afterEach(() => {
  useAgentEditStore.getState().clearAll();
});

describe('Agent edit review cache reconciliation', () => {
  it('retires post-write review UI during persisted-state migration without removing legacy staging', () => {
    const migrated = retireLegacyAgentReviewPersistence({
      pending: {
        'node:node-1': {
          entityType: 'node',
          id: 'node-1',
          changes: [
            {
              blockId: 'reviewed-block',
              op: 'changed',
              oldText: 'Before',
              newText: 'After',
              afterPrevId: null,
              reviewId: REVIEW_ID,
              effectId: EFFECT_ID,
            },
            {
              blockId: 'legacy-block',
              op: 'changed',
              oldText: 'Legacy before',
              newText: 'Legacy after',
              afterPrevId: null,
            },
          ],
        },
      },
      pendingReverts: [],
      reviewBatches: {
        [REVIEW_ID]: {
          effectId: EFFECT_ID,
          reviewId: REVIEW_ID,
          entityType: 'node',
          id: 'node-1',
          changes: [],
        },
      },
      reviewOrder: [REVIEW_ID],
      settledReviewIds: { 'already-settled': true },
    });

    expect(migrated).toMatchObject({
      pending: {
        'node:node-1': {
          entityType: 'node',
          id: 'node-1',
          changes: [{ blockId: 'legacy-block' }],
        },
      },
      reviewBatches: {},
      reviewOrder: [],
      settledReviewIds: {
        'already-settled': true,
        [REVIEW_ID]: true,
      },
    });
  });

  it('removes a localStorage ghost when SQLite has no matching review', async () => {
    seedLegacyReviewBatch();
    const repository = repositoryStub({ review: null, effect: null });

    await expect(
      reconcileAgentEditReviewCache('project-1', repository),
    ).resolves.toEqual([REVIEW_ID]);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([]);
    expect(useAgentEditStore.getState().reviewBatches).toEqual({});
    expect(useAgentEditStore.getState().pending).toEqual({});
  });

  it('removes an orphaned review-tagged edit even when its batch indexes are missing', async () => {
    seedLegacyReviewBatch();
    useAgentEditStore.setState({ reviewBatches: {}, reviewOrder: [] });
    const repository = repositoryStub({ review: null, effect: null });

    await expect(
      reconcileAgentEditReviewCache('project-1', repository),
    ).resolves.toEqual([REVIEW_ID]);
    expect(useAgentEditStore.getState().pending).toEqual({});
  });

  it('keeps a canonical pending review and removes it after settlement', async () => {
    seedLegacyReviewBatch();
    const pending = legacyReview('pending');
    const repository = repositoryStub({
      review: pending,
      effect: legacyEffect(),
    });

    await expect(
      reconcileAgentEditReviewCache('project-1', repository),
    ).resolves.toEqual([]);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([REVIEW_ID]);

    repository.getReview = vi.fn(async () => legacyReview('accepted_effect'));
    await expect(
      reconcileAgentEditReviewCache('project-1', repository),
    ).resolves.toEqual([REVIEW_ID]);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([]);
  });

  it('fails closed and preserves the local batch when SQLite cannot be read', async () => {
    seedLegacyReviewBatch();
    const repository = repositoryStub({ review: null, effect: null });
    repository.getReview = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    await expect(
      reconcileAgentEditReviewCache('project-1', repository),
    ).resolves.toEqual([]);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([REVIEW_ID]);
  });
});

function seedLegacyReviewBatch(): void {
  useAgentEditStore.getState().recordReview(
    'node',
    'node-1',
    [
      {
        blockId: 'block-1',
        op: 'changed',
        oldText: 'Before',
        newText: 'After',
        afterPrevId: null,
      },
    ],
    'approve',
    { effectId: EFFECT_ID, reviewId: REVIEW_ID },
  );
}

function repositoryStub(input: {
  review: PersistedAgentRuntimeWriteReview | null;
  effect: PersistedAgentRuntimeWriteEffect | null;
}): AgentRuntimeWriteEffectRepository {
  return {
    getReview: vi.fn(async () => input.review),
    getEffect: vi.fn(async () => input.effect),
  } as unknown as AgentRuntimeWriteEffectRepository;
}

function legacyReview(
  status: PersistedAgentRuntimeWriteReview['status'],
): PersistedAgentRuntimeWriteReview {
  return {
    id: REVIEW_ID,
    effectId: EFFECT_ID,
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'agent-tool:session-1:turn-1:call-1',
    status,
  } as unknown as PersistedAgentRuntimeWriteReview;
}

function legacyEffect(): PersistedAgentRuntimeWriteEffect {
  return {
    id: EFFECT_ID,
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'agent-tool:session-1:turn-1:call-1',
    authorization: null,
  } as PersistedAgentRuntimeWriteEffect;
}
