import { describe, expect, it } from 'vitest';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { buildAgentWriteReviewFeedback } from './write-review-feedback';

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
    updatedAt: `2026-07-30T00:00:0${tick}.000Z`,
  } as never;
}
