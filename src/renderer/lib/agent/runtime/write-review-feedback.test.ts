import { describe, expect, it } from 'vitest';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import {
  buildAgentWriteReviewFeedback,
  loadAgentWriteReviewContextRows,
} from './write-review-feedback';
import { planAgentModelContext } from './context-message-adapter';
import type { AgentModelMessage } from './types';

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

    const feedback = await buildAgentWriteReviewFeedback('session-1', repository);

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
    await expect(buildAgentWriteReviewFeedback('session-1', repository)).resolves.toBe('');
  });

  it('keeps workspace coordination details out of model-facing review rows', async () => {
    const repository = {
      loadSnapshot: async () => ({
        effects: [
          effect(
            'effect-file',
            'edit_file',
            {
              path: '/chapters/12/prose.md',
              replacements: [{ oldText: 'old', newText: 'new' }],
              expectedRevision: {
                receiptId: 'private-receipt',
                observationId: 'private-observation',
                revision: 'yjs:42',
              },
              __workspaceCommand: {
                name: 'edit_prose_file',
                arguments: { nodeId: 'private-node' },
              },
            },
            'turn-file',
          ),
        ],
        reviews: [review('review-file', 'effect-file', 'pending', 1)],
        turnOrdinalsById: { 'turn-file': 1 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository);

    expect(rows[0]?.content).toContain('/chapters/12/prose.md');
    expect(rows[0]?.content).not.toMatch(
      /private-receipt|private-observation|private-node|expectedRevision|workspaceCommand|yjs/i,
    );
  });

  it('keeps every unsettled decision as a stable first-class pinned row', async () => {
    const repository = {
      loadSnapshot: async () => ({
        effects: [
          effect(
            'effect-pending',
            'edit_block',
            {
              entity: '第一章',
              block: 3,
              text: '新文本',
            },
            'turn-3',
          ),
          effect(
            'effect-reverting',
            'append_paragraph',
            {
              entity: '第一章',
              text: '尾声',
            },
            'turn-7',
          ),
        ],
        reviews: [
          review('review-pending', 'effect-pending', 'pending', 1),
          review('review-reverting', 'effect-reverting', 'revert_started', 2),
        ],
        turnOrdinalsById: {
          'turn-3': 3,
          'turn-7': 7,
        },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceId)).toEqual([
      'write-review:review-pending',
      'write-review:review-reverting',
    ]);
    expect(rows.every((row) => row.kind === 'write_review')).toBe(true);
    expect(rows.map((row) => row.turnOrdinal)).toEqual([3, 7]);
    expect(rows[0].content).toContain('"reviewStatus":"pending"');
    expect(rows[1].content).toContain('"reviewStatus":"revert_started"');
    expect(rows.every((row) => row.durableWriteCoverage === undefined)).toBe(true);
  });

  it('bounds exact settled rows, archives their durable coverage, and never covers pending reviews', async () => {
    const settledEffects = Array.from({ length: 25 }, (_, index) =>
      effect(`effect-settled-${index}`, 'rename_node', { node: `N${index}` }),
    );
    const settledReviews = Array.from({ length: 25 }, (_, index) =>
      review(`review-settled-${index}`, `effect-settled-${index}`, 'accepted_effect', index),
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [...settledEffects, effect('effect-pending', 'edit_block', { entity: '第一章' })],
        reviews: [...settledReviews, review('review-pending', 'effect-pending', 'pending', 99)],
        turnOrdinalsById: {
          'turn-effect': 0,
        },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository);

    expect(rows).toHaveLength(22);
    expect(rows.some((row) => row.sourceId === 'write-review:review-pending')).toBe(true);
    expect(rows.some((row) => row.sourceId === 'write-review:review-settled-0')).toBe(false);
    const archive = rows.find((row) => row.sourceId === 'write-review:session-1:settled-archive');
    expect(archive).toMatchObject({
      kind: 'write_review',
      durableWriteCoverage: expect.arrayContaining([
        {
          turnOrdinal: 0,
          callId: 'call-effect-settled-0',
          toolName: 'rename_node',
        },
      ]),
    });
    expect(archive?.durableWriteCoverage).toHaveLength(5);
    expect(archive?.content).toContain('"kind":"settled_write_review_archive"');
    expect(archive?.content).toMatch(/"evidenceHash":"sha256:[0-9a-f]{64}"/);
    expect(
      rows.find((row) => row.sourceId === 'write-review:review-pending')?.durableWriteCoverage,
    ).toBeUndefined();
  });

  it('projects failed/current physical turns into canonical context without inventing old tool pairs', async () => {
    const priorFailedEffect = effect(
      'effect-prior-failed',
      'rename_node',
      { node: '第一章', title: '旧失败轮写入' },
      'turn-prior-failed',
    );
    const currentEffect = effect(
      'effect-current',
      'update_project_facts',
      { facts: [{ key: 'phase', value: 'two' }] },
      'turn-current',
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [priorFailedEffect, currentEffect],
        reviews: [
          review('review-prior-failed', priorFailedEffect.id, 'accepted_effect', 1),
          review('review-current', currentEffect.id, 'accepted_effect', 2),
        ],
        turnOrdinalsById: {
          'turn-prior-failed': 8,
          'turn-current': 9,
        },
        turnContextOrdinalsById: {
          'turn-prior-failed': 4,
          'turn-current': 4,
        },
        turnHasCanonicalHistoryById: {
          'turn-prior-failed': false,
          'turn-current': false,
        },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository, {
      currentTurnId: 'turn-current',
    });

    expect(rows.map((row) => row.turnOrdinal)).toEqual([4, 4]);
    expect(rows[0]?.durableWriteCoverage).toEqual([]);
    expect(rows[1]?.durableWriteCoverage).toEqual([
      {
        turnOrdinal: 4,
        callId: currentEffect.callId,
        toolName: currentEffect.toolName,
      },
    ]);
  });

  it('makes only the exactly matched settled write pair compressible while keeping both review rows pinned', async () => {
    const settledEffect = effect(
      'effect-settled',
      'rename_node',
      { node: '第一章', title: '新标题' },
      'turn-0',
    );
    const pendingEffect = effect(
      'effect-pending',
      'edit_block',
      { node: '第一章', block: 0 },
      'turn-0',
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [settledEffect, pendingEffect],
        reviews: [
          review('review-settled', 'effect-settled', 'accepted_effect', 1),
          review('review-pending', 'effect-pending', 'pending', 2),
        ],
        turnOrdinalsById: { 'turn-0': 0 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;
    const rows = await loadAgentWriteReviewContextRows('session-1', repository);
    const messages: AgentModelMessage[] = [
      { role: 'user', content: '修改第一章' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: settledEffect.callId,
            name: settledEffect.toolName,
            arguments: {},
            rawArguments: '{}',
          },
          {
            type: 'tool_call',
            callId: pendingEffect.callId,
            name: pendingEffect.toolName,
            arguments: {},
            rawArguments: '{}',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: settledEffect.callId,
            name: settledEffect.toolName,
            ok: true,
            content: '{"ok":true}',
          },
          {
            callId: pendingEffect.callId,
            name: pendingEffect.toolName,
            ok: true,
            content: '{"ok":true}',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '完成修改' }],
      },
      { role: 'user', content: '检查人物语气' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '正在检查' }],
      },
      { role: 'user', content: '继续' },
    ];
    const planned = await planAgentModelContext({
      systemPrompt: 'Follow durable review decisions.',
      messages,
      resolveToolAccess: (name) =>
        name === 'rename_node' || name === 'edit_block' ? 'write' : null,
      supplementalRows: rows,
      planner: {
        contextWindowTokens: 32_768,
        requestedOutputTokens: 4_096,
        fixedInputTokens: 0,
      },
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const toolSegments = planned.plan.segments.filter(
      (segment) =>
        segment.type === 'source' &&
        (segment.row.kind === 'tool_call' || segment.row.kind === 'tool_result'),
    );
    expect(
      toolSegments.filter(
        (segment) => segment.type === 'source' && segment.row.callId === settledEffect.callId,
      ),
    ).toEqual([
      expect.objectContaining({
        classification: 'compressible',
        pinReason: null,
      }),
      expect.objectContaining({
        classification: 'compressible',
        pinReason: null,
      }),
    ]);
    expect(
      toolSegments.filter(
        (segment) => segment.type === 'source' && segment.row.callId === pendingEffect.callId,
      ),
    ).toEqual([
      expect.objectContaining({
        classification: 'pinned',
        pinReason: 'semantic',
      }),
      expect.objectContaining({
        classification: 'pinned',
        pinReason: 'semantic',
      }),
    ]);
    expect(planned.plan.checkpoint.pinned.sourceIds).toEqual(
      expect.arrayContaining(rows.map((row) => row.sourceId)),
    );
  });
});

function effect(
  id: string,
  toolName: string,
  arguments_: Record<string, unknown>,
  turnId = 'turn-effect',
) {
  return {
    id,
    sessionId: 'session-1',
    turnId,
    callId: `call-${id}`,
    toolName,
    arguments: arguments_,
  };
}

function review(id: string, effectId: string, status: string, tick: number) {
  return {
    id,
    effectId,
    status,
    createdAt: `2026-07-30T00:00:${String(tick).padStart(2, '0')}.000Z`,
    updatedAt: `2026-07-30T00:00:0${tick}.000Z`,
  } as never;
}
