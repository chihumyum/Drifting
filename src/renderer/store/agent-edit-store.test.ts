import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentBlockChange } from '../lib/agent/block-diff';
import { useAgentEditStore } from './agent-edit-store';

const changes: AgentBlockChange[] = [
  {
    blockId: 'block-a',
    op: 'changed',
    oldText: 'before a',
    newText: 'after a',
    afterPrevId: null,
  },
  {
    blockId: 'block-b',
    op: 'new',
    oldText: '',
    newText: 'after b',
    afterPrevId: 'block-a',
  },
];

describe('Agent edit review block decisions', () => {
  beforeEach(() => {
    useAgentEditStore.getState().clearAll();
  });

  it('keeps the effect batch but removes only the decided block from the editor projection', () => {
    const store = useAgentEditStore.getState();
    expect(
      store.recordReview('node', 'node-1', changes, 'approve', {
        effectId: 'effect-1',
        reviewId: 'review-1',
      }),
    ).toBe(true);

    useAgentEditStore.getState().syncReviewBlockDecisions('review-1', { 'block-a': 'accepted' });

    const state = useAgentEditStore.getState();
    expect(state.reviewBatches['review-1']).toMatchObject({
      changes,
      blockDecisions: { 'block-a': 'accepted' },
    });
    expect(state.pending['node:node-1']?.changes.map((change) => change.blockId)).toEqual([
      'block-b',
    ]);
  });

  it('rebuilds no visual block after every block has a decision, until canonical settlement clears the batch', () => {
    const store = useAgentEditStore.getState();
    store.recordReview('node', 'node-1', changes, 'approve', {
      effectId: 'effect-1',
      reviewId: 'review-1',
    });
    store.syncReviewBlockDecisions('review-1', {
      'block-a': 'accepted',
      'block-b': 'reverted',
    });

    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();
    expect(useAgentEditStore.getState().reviewBatches['review-1']).toBeDefined();

    useAgentEditStore.getState().resolveReviews(['review-1']);
    expect(useAgentEditStore.getState().reviewBatches['review-1']).toBeUndefined();
    expect(useAgentEditStore.getState().settledReviewIds['review-1']).toBe(true);
  });

  it('replaces stale local decisions with the exact SQLite-backed projection', () => {
    const store = useAgentEditStore.getState();
    store.recordReview('node', 'node-1', changes, 'approve', {
      effectId: 'effect-1',
      reviewId: 'review-1',
    });
    store.syncReviewBlockDecisions('review-1', { 'block-a': 'accepted' });

    useAgentEditStore.getState().syncReviewBlockDecisions('review-1', {
      'block-b': 'reverted',
      unknown: 'accepted',
    });

    const state = useAgentEditStore.getState();
    expect(state.reviewBatches['review-1']?.blockDecisions).toEqual({
      'block-b': 'reverted',
    });
    expect(state.pending['node:node-1']?.changes.map((change) => change.blockId)).toEqual([
      'block-a',
    ]);

    const pending = state.pending;
    useAgentEditStore.getState().syncReviewBlockDecisions('review-1', {
      'block-b': 'reverted',
    });
    expect(useAgentEditStore.getState().pending).toBe(pending);
  });

  it('persists an Added marker and seeds first-open prose as auto reveal blocks', () => {
    const store = useAgentEditStore.getState();
    store.recordAddition('node', 'node-added');

    expect(useAgentEditStore.getState().additions['node:node-added']).toMatchObject({
      revealBlockIds: null,
    });
    expect(store.beginAdditionReveal('node', 'node-added', changes)).toEqual([
      'block-a',
      'block-b',
    ]);
    expect(useAgentEditStore.getState().pending['node:node-added']?.changes).toEqual(
      changes.map((change) => ({ ...change, mode: 'auto' })),
    );

    useAgentEditStore.getState().resolveBlocks('node', 'node-added', ['block-a', 'block-b']);
    useAgentEditStore.getState().resolveAddition('node', 'node-added');
    expect(useAgentEditStore.getState().additions['node:node-added']).toBeUndefined();
  });

  it('does not overwrite a later durable review when first-open Added reveal is seeded', () => {
    const store = useAgentEditStore.getState();
    store.recordReview('node', 'node-added', [changes[0]], 'approve', {
      effectId: 'effect-later',
      reviewId: 'review-later',
    });
    store.recordAddition('node', 'node-added');

    expect(store.beginAdditionReveal('node', 'node-added', changes)).toEqual(['block-b']);
    expect(useAgentEditStore.getState().pending['node:node-added']?.changes).toEqual([
      {
        ...changes[0],
        mode: 'approve',
        effectId: 'effect-later',
        reviewId: 'review-later',
      },
      { ...changes[1], mode: 'auto' },
    ]);
  });
});
