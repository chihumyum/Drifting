import { describe, expect, it } from 'vitest';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import {
  buildAgentWriteReviewFeedback,
  loadAgentWriteReviewContextRows,
} from './write-review-feedback';

describe('Agent write review feedback', () => {
  it('reports accepted, reverted, and failed inverse decisions from canonical rows', async () => {
    const repository = {
      loadSnapshot: async () => ({
        effects: [
          effect('effect-accepted', 'rename_node', { node: 'A', title: 'B' }),
          effect('effect-reverted', 'set_node_summary', {
            node: 'A',
            summary: 'x',
          }),
          effect('effect-failed', 'rename_node', {
            node: 'A',
            title: 'C',
          }),
        ],
        reviews: [
          review('review-accepted', 'effect-accepted', 'accepted_effect', 1),
          review('review-reverted', 'effect-reverted', 'reverted', 2),
          review('review-failed', 'effect-failed', 'revert_failed', 3),
          review('review-pending', 'effect-accepted', 'pending', 4),
        ],
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const feedback = await buildAgentWriteReviewFeedback(
      'session-1',
      repository,
    );

    expect(feedback).toContain('rename_node');
    expect(feedback).toContain('已被用户接受');
    expect(feedback).toContain('已被用户拒绝并精确撤销');
    expect(feedback).toContain('自动撤销失败');
    expect(feedback).not.toContain('review-pending');
  });

  it('returns no prompt material when the session has no settled reviews', async () => {
    const repository = {
      loadSnapshot: async () => ({ effects: [], reviews: [] }),
    } as unknown as AgentRuntimeWriteEffectRepository;
    await expect(
      buildAgentWriteReviewFeedback('session-1', repository),
    ).resolves.toBe('');
  });

  it('keeps every unsettled decision as a stable first-class pinned row', async () => {
    const repository = {
      loadSnapshot: async () => ({
        effects: [
          effect('effect-pending', 'edit_block', {
            entity: '第一章',
            block: 3,
            text: '新文本',
          }),
          effect('effect-reverting', 'append_paragraph', {
            entity: '第一章',
            text: '尾声',
          }),
        ],
        reviews: [
          review('review-pending', 'effect-pending', 'pending', 1),
          review(
            'review-reverting',
            'effect-reverting',
            'revert_started',
            2,
          ),
        ],
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows(
      'session-1',
      repository,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceId)).toEqual([
      'write-review:review-pending',
      'write-review:review-reverting',
    ]);
    expect(rows.every((row) => row.kind === 'write_review')).toBe(true);
    expect(rows.every((row) => row.turnOrdinal === null)).toBe(true);
    expect(rows[0].content).toContain('"reviewStatus":"pending"');
    expect(rows[1].content).toContain('"reviewStatus":"revert_started"');
  });

  it('bounds settled history without trimming pending reviews', async () => {
    const settledEffects = Array.from({ length: 25 }, (_, index) =>
      effect(`effect-settled-${index}`, 'rename_node', { node: `N${index}` }),
    );
    const settledReviews = Array.from({ length: 25 }, (_, index) =>
      review(
        `review-settled-${index}`,
        `effect-settled-${index}`,
        'accepted_effect',
        index,
      ),
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [
          ...settledEffects,
          effect('effect-pending', 'edit_block', { entity: '第一章' }),
        ],
        reviews: [
          ...settledReviews,
          review('review-pending', 'effect-pending', 'pending', 99),
        ],
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows(
      'session-1',
      repository,
    );

    expect(rows).toHaveLength(21);
    expect(rows.some((row) => row.sourceId === 'write-review:review-pending')).toBe(
      true,
    );
    expect(
      rows.some((row) => row.sourceId === 'write-review:review-settled-0'),
    ).toBe(false);
  });
});

function effect(
  id: string,
  toolName: string,
  arguments_: Record<string, unknown>,
) {
  return {
    id,
    sessionId: 'session-1',
    toolName,
    arguments: arguments_,
  } as never;
}

function review(
  id: string,
  effectId: string,
  status: string,
  tick: number,
) {
  return {
    id,
    effectId,
    status,
    createdAt: `2026-07-30T00:00:${String(tick).padStart(2, '0')}.000Z`,
    updatedAt: `2026-07-30T00:00:0${tick}.000Z`,
  } as never;
}
