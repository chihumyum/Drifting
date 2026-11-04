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

describe('Agent edit receipt presentation', () => {
  beforeEach(() => {
    useAgentEditStore.getState().clearAll();
  });

  it('records a receipt batch once and clears it only when settlement resolves it', () => {
    const store = useAgentEditStore.getState();
    expect(
      store.recordReview('node', 'node-1', changes, {
        effectId: 'effect-1',
        reviewId: 'review-1',
      }),
    ).toBe(true);
    expect(
      store.recordReview('node', 'node-1', changes, {
        effectId: 'effect-1',
        reviewId: 'review-1',
      }),
    ).toBe(false);

    const state = useAgentEditStore.getState();
    expect(state.reviewBatches['review-1']).toEqual({
      effectId: 'effect-1',
      reviewId: 'review-1',
      entityType: 'node',
      id: 'node-1',
      changes: changes.map((change) => ({
        ...change,
        effectId: 'effect-1',
        reviewId: 'review-1',
      })),
    });
    expect(state.pending['node:node-1']?.changes.map((change) => change.blockId)).toEqual([
      'block-a',
      'block-b',
    ]);

    useAgentEditStore.getState().resolveReviews(['review-1']);
    expect(useAgentEditStore.getState().reviewBatches['review-1']).toBeUndefined();
    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();
    expect(useAgentEditStore.getState().settledReviewIds['review-1']).toBe(true);
  });

  it('reads a v1 cache without its retired reject queue and drops a v0 cache', async () => {
    const migrate = useAgentEditStore.persist.getOptions().migrate!;
    const staleChange = { ...changes[0], mode: 'approve' };
    const migrated = (await migrate(
      {
        pending: {
          'node:node-1': { entityType: 'node', id: 'node-1', changes: [staleChange] },
        },
        additions: {},
        pendingReverts: [{ projectId: 'project-1', blockId: 'block-a' }],
        reviewBatches: {},
        reviewOrder: [],
        settledReviewIds: { 'review-old': true },
      },
      1,
    )) as Record<string, unknown>;
    expect(migrated).not.toHaveProperty('pendingReverts');
    expect(migrated).toMatchObject({
      pending: { 'node:node-1': { changes: [staleChange] } },
      settledReviewIds: { 'review-old': true },
    });
    expect(await migrate({ pending: { 'node:node-1': {} } }, 0)).toEqual({});
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
    expect(useAgentEditStore.getState().pending['node:node-added']?.changes).toEqual(changes);

    useAgentEditStore.getState().resolveBlocks('node', 'node-added', ['block-a', 'block-b']);
    useAgentEditStore.getState().resolveAddition('node', 'node-added');
    expect(useAgentEditStore.getState().additions['node:node-added']).toBeUndefined();
  });

  it('does not overwrite a later durable review when first-open Added reveal is seeded', () => {
    const store = useAgentEditStore.getState();
    store.recordReview('node', 'node-added', [changes[0]], {
      effectId: 'effect-later',
      reviewId: 'review-later',
    });
    store.recordAddition('node', 'node-added');

    expect(store.beginAdditionReveal('node', 'node-added', changes)).toEqual(['block-b']);
    expect(useAgentEditStore.getState().pending['node:node-added']?.changes).toEqual([
      {
        ...changes[0],
        effectId: 'effect-later',
        reviewId: 'review-later',
      },
      changes[1],
    ]);
  });

  it('purges only the deleted project\'s persisted edit presentation', () => {
    const store = useAgentEditStore.getState();
    store.recordReview('node', 'node-delete', changes, {
      effectId: 'effect-delete',
      reviewId: 'review-delete',
    });
    store.recordReview('element', 'element-keep', changes, {
      effectId: 'effect-keep',
      reviewId: 'review-keep',
    });
    store.recordAddition('storyline', 'storyline-delete');
    useAgentEditStore.setState({
      settledReviewIds: { 'settled-delete': true, 'settled-keep': true },
    });

    useAgentEditStore.getState().clearProject(
      'project-delete',
      ['node-content:node-delete', 'storyline:storyline-delete'],
      ['review-delete', 'settled-delete'],
    );

    const state = useAgentEditStore.getState();
    expect(state.pending['node:node-delete']).toBeUndefined();
    expect(state.additions['storyline:storyline-delete']).toBeUndefined();
    expect(state.reviewBatches['review-delete']).toBeUndefined();
    expect(state.settledReviewIds['settled-delete']).toBeUndefined();
    expect(state.reviewBatches['review-keep']).toBeDefined();
    expect(state.settledReviewIds['settled-keep']).toBe(true);
  });

  it('does not seed an Added reveal over blocks a durable receipt already shows', () => {
    const store = useAgentEditStore.getState();
    store.recordReview('node', 'node-added', changes, {
      effectId: 'effect-created',
      reviewId: 'review-created',
    });
    store.recordAddition('node', 'node-added');

    expect(store.beginAdditionReveal('node', 'node-added', changes)).toEqual([]);
    expect(useAgentEditStore.getState().pending['node:node-added']?.changes).toEqual(
      changes.map((change) => ({
        ...change,
        effectId: 'effect-created',
        reviewId: 'review-created',
      })),
    );
  });

  it('atomically replaces a pre-live auto guard with its canonical review projection', () => {
    const store = useAgentEditStore.getState();
    store.stageAutoRevealGuard('node', 'node-1', 'review-guarded', [
      'block-a',
      'block-a',
      'block-b',
    ]);

    expect(useAgentEditStore.getState().autoRevealGuards['review-guarded']).toEqual({
      entityType: 'node',
      id: 'node-1',
      reviewId: 'review-guarded',
      blockIds: ['block-a', 'block-b'],
    });
    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();

    const projections: Array<{ guarded: boolean; blockIds: string[] }> = [];
    const unsubscribe = useAgentEditStore.subscribe((state) => {
      projections.push({
        guarded: Boolean(state.autoRevealGuards['review-guarded']),
        blockIds:
          state.pending['node:node-1']?.changes.map((change) => change.blockId) ?? [],
      });
    });

    expect(
      store.recordReview('node', 'node-1', changes, {
        effectId: 'effect-guarded',
        reviewId: 'review-guarded',
      }),
    ).toBe(true);
    unsubscribe();

    expect(projections).toEqual([
      { guarded: false, blockIds: ['block-a', 'block-b'] },
    ]);
    expect(useAgentEditStore.getState().autoRevealGuards['review-guarded']).toBeUndefined();
    expect(useAgentEditStore.getState().pending['node:node-1']?.changes).toEqual(
      changes.map((change) => ({
        ...change,
        effectId: 'effect-guarded',
        reviewId: 'review-guarded',
      })),
    );
  });

  it('clears a pre-live guard when canonical projection proves there is no review', () => {
    const store = useAgentEditStore.getState();
    store.stageAutoRevealGuard('node', 'node-1', 'review-empty', ['block-a']);

    expect(
      store.recordReview('node', 'node-1', [], {
        effectId: 'effect-empty',
        reviewId: 'review-empty',
      }),
    ).toBe(false);
    expect(useAgentEditStore.getState().autoRevealGuards['review-empty']).toBeUndefined();
  });
});
