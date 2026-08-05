import { describe, expect, it } from 'vitest';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import {
  buildAgentWriteReviewFeedback,
  loadAgentAuthoredReadProgressContextRows,
  loadAgentDurableWriteReceiptContextRows,
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

    expect(feedback).toContain('作品内容「A」');
    expect(feedback).not.toContain('rename_node');
    expect(feedback).not.toContain('已经完成且由作者保留');
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

  it('tells the next turn to re-read after a mixed block-by-block decision', async () => {
    const repository = {
      loadSnapshot: async () => ({
        effects: [effect('effect-mixed', 'edit_file', { path: '/chapters/01/prose.md' })],
        reviews: [
          review('review-mixed', 'effect-mixed', 'accepted_effect', 1, {
            schemaVersion: 1,
            kind: 'block_review',
            decisions: [
              { blockId: 'a', decision: 'accepted' },
              { blockId: 'b', decision: 'reverted' },
            ],
          }),
        ],
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const feedback = await buildAgentWriteReviewFeedback('session-1', repository);

    expect(feedback).toContain('接受 1 处、还原 1 处');
    expect(feedback).toContain('继续编辑前先重新读取');
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
              changeSummary: '清理测试痕迹并收紧正文',
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

    expect(rows[0]?.content).toContain('章节「12」正文');
    expect(rows[0]?.content).toContain('已有可靠完成证据并属于当前稿件');
    expect(rows[0]?.content).toContain('读取或计划不算完成');
    expect(rows[0]?.content).toContain('若只改摘要、关系、批注、待办或其他独立字段');
    expect(rows[0]?.content).not.toMatch(/本轮|保存的修改/u);
    expect(rows[0]?.content).not.toContain('清理测试痕迹并收紧正文');
    expect(rows[0]?.content).not.toContain('/chapters/12/prose.md');
    expect(rows[0]?.content).not.toMatch(
      /private-receipt|private-observation|private-node|expectedRevision|workspaceCommand|yjs/i,
    );
  });

  it('lets a later accepted edit supersede stale remaining work for the same authored field', async () => {
    const repository = {
      loadSnapshot: async () => ({
        effects: [
          effect(
            'effect-partial',
            'edit_file',
            {
              path: '/chapters/08/prose.md',
              changeSummary: '完成第一轮修改',
              remainingWork: '3 个原文片段仍待重新定位',
            },
            'turn-partial',
          ),
          effect(
            'effect-followup',
            'edit_file',
            {
              path: '/chapters/08/prose.md',
              changeSummary: '按当前正文完成后续修正',
            },
            'turn-followup',
          ),
        ],
        reviews: [
          review('review-partial', 'effect-partial', 'accepted_effect', 1),
          review('review-followup', 'effect-followup', 'accepted_effect', 2),
        ],
        turnOrdinalsById: {
          'turn-partial': 1,
          'turn-followup': 2,
        },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository);
    const content = rows.map((row) => row.content).join('\n');

    expect(content).toContain('章节「08」正文已有可靠完成证据并属于当前稿件');
    expect(content).not.toContain('按当前正文完成后续修正');
    expect(content).not.toContain('3 个原文片段仍待重新定位');
    expect(rows.flatMap((row) => row.durableWriteCoverage ?? [])).toHaveLength(2);
  });

  it('retires deferred summary work once the named authored summary is durably saved', async () => {
    const requestedSummary = '奥伦：南园芳汶的退休佣兵。';
    const body = effect(
      'effect-profile-body',
      'write_object',
      {
        target: '要素「Grey Banker」设定',
        content: '奥伦的人物档案。',
        remainingWork: `要素「Grey Banker」摘要仍需单独更新为：${requestedSummary}`,
      },
      'turn-profile',
    );
    const summary = effect(
      'effect-profile-summary',
      'write_object',
      {
        target: '要素「Grey Banker」摘要',
        content: requestedSummary,
      },
      'turn-profile',
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [body, summary],
        reviews: [review('review-profile-body', body.id, 'accepted_effect', 1)],
        turnOrdinalsById: { 'turn-profile': 3 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository);
    const content = rows.map((row) => row.content).join('\n');

    expect(content).toContain('要素「Grey Banker」设定已有可靠完成证据');
    expect(content).not.toContain('仍待完成');
    expect(content).not.toContain('仍需单独更新');
  });

  it('describes a genuinely partial save without also calling the whole step complete', async () => {
    const body = effect(
      'effect-profile-partial',
      'write_object',
      {
        target: '要素「Grey Banker」设定',
        content: '奥伦的人物档案。',
        remainingWork: '要素「Grey Banker」摘要仍需单独更新为：奥伦：退休佣兵。',
      },
      'turn-profile',
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [body],
        reviews: [review('review-profile-partial', body.id, 'pending', 1)],
        turnOrdinalsById: { 'turn-profile': 3 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentWriteReviewContextRows('session-1', repository);
    const content = rows.map((row) => row.content).join('\n');

    expect(content).toContain('当前已保存的部分属于稿件');
    expect(content).toContain('仍待完成');
    expect(content).not.toContain('已有可靠完成证据并属于当前稿件');
  });

  it('collapses same-target unsettled decisions into one current domain state', async () => {
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

    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.sourceId)).toEqual(['write-review:review-reverting']);
    expect(rows.every((row) => row.kind === 'write_review')).toBe(true);
    expect(rows.map((row) => row.turnOrdinal)).toEqual([7]);
    expect(rows[0].content).toContain('正在还原');
    expect(rows[0].content).not.toMatch(/审阅|标记|等待作者/u);
    expect(rows[0].durableWriteCoverage).toHaveLength(2);
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

    expect(rows).toHaveLength(21);
    expect(rows.some((row) => row.sourceId === 'write-review:review-pending')).toBe(true);
    expect(rows.some((row) => row.sourceId === 'write-review:review-settled-0')).toBe(false);
    const archive = rows.find(
      (row) => row.sourceId === 'write-review:session-1:current-state-archive',
    );
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
    expect(archive?.durableWriteCoverage).toHaveLength(6);
    expect(archive?.content).toContain('执行进度中已有可靠完成证据的对象');
    expect(archive?.content).toContain('读取或计划不算完成');
    expect(archive?.content).not.toContain('审阅');
    expect(archive?.content).not.toMatch(/reviewId|effectId|callId|evidenceHash/);
    expect(
      rows.find((row) => row.sourceId === 'write-review:review-pending')?.durableWriteCoverage,
    ).toEqual([
      {
        turnOrdinal: 0,
        callId: 'call-effect-pending',
        toolName: 'edit_block',
      },
    ]);
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

  it('replaces settled and pending raw write pairs with pinned domain review state', async () => {
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
    expect(toolSegments).toEqual([]);
    expect(planned.plan.checkpoint.pinned.sourceIds).toEqual(
      expect.arrayContaining(rows.map((row) => row.sourceId)),
    );
  });

  it('archives committed non-review writes as bounded receipt evidence and leaves unsettled writes exact', async () => {
    const committed = effect(
      'effect-committed-delete',
      'delete_file',
      { path: '/comments/old.json' },
      'turn-current',
    );
    const pending = effect(
      'effect-pending-edit',
      'edit_file',
      { path: '/chapters/01/prose.md' },
      'turn-current',
    );
    const accepted = effect(
      'effect-accepted-edit',
      'edit_file',
      { path: '/chapters/02/prose.md' },
      'turn-current',
    );
    const failed = {
      ...effect('effect-failed-delete', 'delete_file', { path: '/missing' }, 'turn-current'),
      phase: 'failed',
      resultCommittedAt: null,
    };
    const repository = {
      loadSnapshot: async () => ({
        effects: [committed, pending, accepted, failed],
        reviews: [
          review('review-pending', pending.id, 'pending', 1),
          review('review-accepted', accepted.id, 'accepted_effect', 2),
        ],
        turnOrdinalsById: { 'turn-current': 7 },
        turnContextOrdinalsById: { 'turn-current': 3 },
        turnHasCanonicalHistoryById: { 'turn-current': false },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentDurableWriteReceiptContextRows('session-1', repository, {
      currentTurnId: 'turn-current',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        sourceId: 'write-receipt:session-1:committed-archive',
        turnOrdinal: 3,
        kind: 'write_receipt',
        durableWriteCoverage: [
          {
            turnOrdinal: 3,
            callId: committed.callId,
            toolName: 'delete_file',
          },
        ],
      }),
    ]);
    expect(rows[0]?.content).toContain('执行进度中已有可靠完成证据的对象');
    expect(rows[0]?.content).toContain('读取或计划不算完成');
    expect(rows[0]?.content).toContain('独立字段，直接处理该字段');
    expect(rows[0]?.content).not.toMatch(/本轮|已修改/u);
    expect(rows[0]?.content).toContain('批注或待办「old」已删除');
    expect(rows[0]?.content).not.toContain('delete_file');
    expect(rows[0]?.content).not.toContain(pending.id);
    expect(rows[0]?.content).not.toContain('章节「02」正文');
    expect(rows[0]?.content).not.toContain(failed.id);
  });

  it('repairs legacy receipts that mislabeled an empty chapter summary as complete', async () => {
    const cleared = effect(
      'effect-cleared-summary',
      'edit_file',
      {
        path: '/chapters/08/summary.md',
        changeSummary: '已同步整理摘要',
        __workspaceCommand: {
          name: 'set_node_summary',
          arguments: { node: 'chapter-08', summary: '' },
        },
      },
      'turn-cleared',
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [cleared],
        reviews: [],
        turnOrdinalsById: { 'turn-cleared': 4 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentDurableWriteReceiptContextRows('session-1', repository);
    const content = rows.map((row) => row.content).join('\n');

    expect(content).toContain('当前尚需处理：当前摘要为空，需要补写');
    expect(content).toContain('只处理作者目标本身');
    expect(content).not.toMatch(/完成内容|写入|快照/u);
  });

  it('uses a durable receipt row to remove the exact committed write pair', async () => {
    const committed = effect(
      'effect-committed-delete',
      'delete_file',
      { path: '/comments/old.json' },
      'turn-0',
    );
    const repository = {
      loadSnapshot: async () => ({
        effects: [committed],
        reviews: [],
        turnOrdinalsById: { 'turn-0': 0 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;
    const rows = await loadAgentDurableWriteReceiptContextRows('session-1', repository);
    const messages: AgentModelMessage[] = [
      { role: 'user', content: '清理旧批注' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: committed.callId,
            name: committed.toolName,
            arguments: committed.arguments,
            rawArguments: JSON.stringify(committed.arguments),
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: committed.callId,
            name: committed.toolName,
            ok: true,
            content: '{"updated":true}',
          },
        ],
      },
      { role: 'user', content: '检查人物资料' },
      { role: 'assistant', content: [{ type: 'text', text: '正在检查' }] },
      { role: 'user', content: '继续' },
    ];

    const planned = await planAgentModelContext({
      systemPrompt: 'Continue from durable domain state.',
      messages,
      resolveToolAccess: (name) => (name === 'delete_file' ? 'write' : null),
      supplementalRows: rows,
      planner: {
        contextWindowTokens: 32_768,
        requestedOutputTokens: 4_096,
        fixedInputTokens: 0,
      },
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      planned.plan.segments.filter(
        (segment) => segment.type === 'source' && segment.row.callId === committed.callId,
      ),
    ).toEqual([]);
    expect(
      planned.plan.segments.find(
        (segment) => segment.type === 'source' && segment.row.kind === 'write_receipt',
      ),
    ).toMatchObject({ classification: 'pinned', pinReason: 'semantic' });
  });

  it('keeps complete authored reading as current domain state after body and summary writes', async () => {
    const body = {
      ...effect(
        'effect-body-read',
        'edit_file',
        {
          path: '/chapters/11/prose.md',
          __workspaceAuthoredReadState: {
            targetKey: 'node:chapter-11',
            target: '章节「11」正文',
            summary: '旧摘要',
            completeBodyRead: true,
            focusedBodyEdit: true,
            currentPassages: ['她终于突破了那面[墙](人物.md#奥伦)。'],
          },
        },
        'turn-current',
      ),
      updatedAt: '2026-07-30T00:00:01.000Z',
    };
    const summary = {
      ...effect(
        'effect-summary-after-read',
        'edit_file',
        {
          path: '/chapters/11/summary.md',
          __workspaceAuthoredReadState: {
            targetKey: 'node:chapter-11',
            target: '章节「11」正文',
            summary: '已对齐的当前摘要',
            completeBodyRead: false,
            focusedBodyEdit: false,
            currentPassages: [],
          },
        },
        'turn-current',
      ),
      updatedAt: '2026-07-30T00:00:02.000Z',
    };
    const repository = {
      loadSnapshot: async () => ({
        effects: [body, summary],
        reviews: [],
        turnOrdinalsById: { 'turn-current': 4 },
        turnContextOrdinalsById: { 'turn-current': 2 },
      }),
    } as unknown as AgentRuntimeWriteEffectRepository;

    const rows = await loadAgentAuthoredReadProgressContextRows('session-1', repository, {
      currentTurnId: 'turn-current',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        sourceId: `read-progress:${summary.id}`,
        turnOrdinal: 2,
        kind: 'read_progress',
      }),
    ]);
    expect(rows[0]?.content).toContain('章节「11」正文已在本轮完整通读');
    expect(rows[0]?.content).toContain('当前摘要：已对齐的当前摘要');
    expect(rows[0]?.content).toContain('当前修改后的正文片段：「她终于突破了那面墙。」');
    expect(rows[0]?.content).toContain('更新摘要、关系、批注、待办或其他独立字段不需要重读正文');
    expect(rows[0]?.content).not.toContain('人物.md');
    expect(rows[0]?.content).not.toMatch(/edit_file|\/chapters|effect-|revision|Yjs|SQLite/iu);
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
    phase: 'result_committed',
    idempotencyKey: `idempotency-${id}`,
    resultCommittedAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

function review(
  id: string,
  effectId: string,
  status: string,
  tick: number,
  decisionNote: unknown = null,
) {
  return {
    id,
    effectId,
    status,
    decisionNote,
    createdAt: `2026-07-30T00:00:${String(tick).padStart(2, '0')}.000Z`,
    updatedAt: `2026-07-30T00:00:0${tick}.000Z`,
  } as never;
}
