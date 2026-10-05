import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeControlChannel } from './control-plane';
import { AgentRuntime } from './runtime';
import {
  agentModelMessagesToContextSources,
  planAgentModelContext,
  type AgentContextSupplementalPinnedRow,
} from './context-message-adapter';
import {
  createAgentContextSummaryCandidate,
  estimateAgentContextSourceTokens,
  estimateAgentContextTextTokens,
  type AgentContextFullCompactionRequest,
} from './context-planner';
import type { AgentModelMessage, AgentModelRequest, AgentToolDefinition } from './types';

const usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const resolveToolAccess = (name: string) => name === 'read_chapter' ? 'read' as const : 'write' as const;

function writePair(): AgentModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_call', callId: 'reused', name: 'rename_node',
      arguments: { node: 'synthetic', title: 'Changed' }, rawArguments: '{"node":"synthetic","title":"Changed"}' }] },
    { role: 'tool', content: [{ callId: 'reused', name: 'rename_node', ok: true, content: '{"saved":true}' }] },
  ];
}

describe('steering context execution ownership', () => {
  it('compacts settled writes after steering and preserves a complete 15-chapter mixed read batch above 64k', async () => {
    const sessionId = 'synthetic-book';
    const turnId = 'physical-turn';
    const control = new AgentRuntimeControlChannel(sessionId, turnId);
    const chapters = Array.from({ length: 15 }, (_, index) =>
      `Synthetic chapter ${index}. ${'A quiet fictional morning. '.repeat(1_000)}`);
    const definitions: AgentToolDefinition[] = ['replace_chapter_body', 'update_task_step', 'read_chapter'].map((name) => ({
      name, description: 'Synthetic regression operation.', access: resolveToolAccess(name),
      inputSchema: { type: 'object' }, validateInput: (value) => ({ ok: true, value }),
    }));
    const committed: Array<{ turnId: string; turnOrdinal: number; callId: string; toolName: string }> = [];
    const requests: AgentModelRequest[] = [];
    const executions: string[] = [];
    const fullCompactor = vi.fn(async (request: AgentContextFullCompactionRequest) =>
      Promise.all(request.eligibleRuns.map((sourceRows, index) => createAgentContextSummaryCandidate({
        summaryId: `synthetic-${index}`, sourceRows,
        content: 'The synthetic chapter edits are saved. Continue from current complete reads.',
      }))));
    const runtime = new AgentRuntime({
      contextPlanning: {
        contextWindowTokens: 200_000,
        fullCompactor,
        supplementalRows: () => committed.length ? [{
          sourceId: 'synthetic-receipts', turnOrdinal: 0, kind: 'write_receipt',
          content: 'All listed synthetic chapter edits were durably committed.',
          durableWriteCoverage: committed.filter((call) => call.toolName === 'replace_chapter_body'),
        }, {
          sourceId: 'synthetic-task', turnOrdinal: null, kind: 'task_plan',
          content: 'Reviewing the synthetic book.',
          durableWriteCoverage: committed.filter((call) => call.toolName === 'update_task_step'),
        }] : [],
      },
      tools: { listDefinitions: () => definitions, execute: async (request) => {
        executions.push(request.name);
        if (request.access === 'write') {
          committed.push({ turnId: request.turnId, turnOrdinal: 0, callId: request.callId, toolName: request.name });
          return { ok: true, data: { saved: true } };
        }
        return { ok: true, data: chapters[(request.arguments as { chapter: number }).chapter] };
      } },
      driver: { id: 'synthetic-provider', async *stream(request) {
        requests.push(request);
        if (request.iteration === 1) {
          await control.steer({ turnId, text: 'Write the novel in English, not Chinese.' });
          yield { type: 'usage', usage };
          yield { type: 'finish', reason: 'end_turn' };
          return;
        }
        const calls = request.iteration === 2
          ? chapters.map((body, chapter) => ({ name: 'replace_chapter_body', arguments: { chapter, body } }))
          : request.iteration === 3
            ? [{ name: 'update_task_step', arguments: { status: 'in_progress' } },
              ...chapters.map((_body, chapter) => ({ name: 'read_chapter', arguments: { chapter } }))]
            : [];
        for (const [index, call] of calls.entries()) {
          const callId = `iteration-${request.iteration}-${index}`;
          yield { type: 'tool_call_start', callId, name: call.name };
          yield { type: 'tool_args_delta', callId, delta: JSON.stringify(call.arguments) };
          yield { type: 'tool_call_end', callId };
        }
        if (!calls.length) yield { type: 'text_delta', text: 'Synthetic novel reviewed.' };
        yield { type: 'usage', usage };
        yield { type: 'finish', reason: calls.length ? 'tool_use' : 'end_turn' };
      } },
    });
    const result = await runtime.runTurn({ sessionId, turnId, route: { kind: 'test' },
      prompt: 'Write and review 15 synthetic chapters.', control });

    expect(result.state.terminal?.message).toBeUndefined();
    expect(result.state.status).toBe('completed');
    expect(requests).toHaveLength(4);
    expect(result.messageTurnIds).toEqual(result.messages.map(() => turnId));
    expect(fullCompactor).toHaveBeenCalled();
    expect(executions.filter((name) => name === 'replace_chapter_body')).toHaveLength(15);
    expect(executions.filter((name) => name === 'read_chapter')).toHaveLength(15);
    const fullReads = requests[3]!.context.messages.flatMap((item) => item.type === 'model_message' && item.message.role === 'tool'
      ? item.message.content.filter((block) => block.name === 'read_chapter') : []);
    expect(fullReads).toHaveLength(15);
    for (const [index, chapter] of chapters.entries()) expect(fullReads[index]!.content).toContain(chapter);
    expect(fullReads.reduce((total, row) => total + estimateAgentContextTextTokens(row.content), 0)).toBeGreaterThan(64_000);
    expect(JSON.stringify(requests[3]!.context)).toContain('Write the novel in English, not Chinese.');
  });

  it.each(['verified', 'foreign-owner', 'missing-ownership', 'wrong-tool'] as const)(
    'scopes reused call IDs to a verified execution turn after steering (%s)', async (scenario) => {
      const messages: AgentModelMessage[] = [
        { role: 'user', content: 'Edit synthetic title.' },
        { role: 'user', content: 'Keep the title in English.' }, ...writePair(),
        { role: 'user', content: 'Another physical turn.' }, ...writePair(),
        { role: 'user', content: 'Continue.' },
      ];
      const supplementalRows: AgentContextSupplementalPinnedRow[] = [{
        sourceId: 'saved-receipt', kind: 'write_receipt', turnOrdinal: 0, content: 'Title saved.',
        durableWriteCoverage: [{ turnId: scenario === 'foreign-owner' ? 'unrelated' : 'old',
          turnOrdinal: 2, callId: 'reused', toolName: scenario === 'wrong-tool' ? 'other_write' : 'rename_node' }],
      }];
      const plan = await planAgentModelContext({ systemPrompt: 'Policy.', messages, supplementalRows, resolveToolAccess,
        messageTurnIds: scenario === 'missing-ownership' ? undefined : ['old', 'old', 'old', 'old', 'new', 'new', 'new', 'latest'],
        planner: { contextWindowTokens: 32_768, requestedOutputTokens: 4_096, fixedInputTokens: 0 },
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      // Source numbering stays compatible with previously stored V2/V4 checkpoints.
      expect(plan.bridge).toEqual(agentModelMessagesToContextSources({
        systemPrompt: 'Policy.', messages, supplementalRows, resolveToolAccess,
      }));
      const writes = plan.plan.segments.flatMap((segment) => segment.type === 'source' && segment.row.callId === 'reused'
        ? [segment] : []);
      expect(writes.map((segment) => segment.row.turnOrdinal)).toEqual(scenario === 'verified' ? [2, 2] : [1, 1, 2, 2]);
      expect(writes.every((segment) => segment.pinReason === 'semantic')).toBe(true);
    },
  );

  it('charges large tool arguments once while preserving canonical bytes and hashes', () => {
    const arguments_ = { chapter: 'synthetic', body: '原始合成正文'.repeat(2_000) };
    const rawArguments = JSON.stringify(arguments_);
    const messages: AgentModelMessage[] = [{ role: 'user', content: 'Save.' },
      { role: 'assistant', content: [{ type: 'tool_call', callId: 'write', name: 'replace_chapter_body', arguments: arguments_, rawArguments }] },
      { role: 'tool', content: [{ callId: 'write', name: 'replace_chapter_body', ok: true, content: 'Saved.' }] }];
    const bridge = agentModelMessagesToContextSources({ systemPrompt: 'Policy.', messages, resolveToolAccess });
    const source = bridge.sourceRows.find((row) => row.kind === 'tool_call')!;
    const original = source.content;
    const estimated = estimateAgentContextSourceTokens(source);
    expect(estimated).toBeGreaterThan(estimateAgentContextTextTokens(rawArguments));
    expect(estimated).toBeLessThan(estimateAgentContextTextTokens(rawArguments) + 200);
    expect(source.content).toBe(original);
    expect(JSON.parse(source.content)).toMatchObject({ arguments: arguments_, rawArguments });
  });

  it('compacts an older mixed read and settled task-write batch atomically after steering', async () => {
    const messages: AgentModelMessage[] = [
      { role: 'user', content: 'Inspect the synthetic book.' },
      { role: 'user', content: 'Keep the review in English.' },
      { role: 'assistant', content: [
        { type: 'tool_call', callId: 'task', name: 'update_task_step', arguments: {}, rawArguments: '{}' },
        { type: 'tool_call', callId: 'read', name: 'read_chapter', arguments: { node: 'synthetic' }, rawArguments: '{"node":"synthetic"}' },
      ] },
      { role: 'tool', content: [
        { callId: 'task', name: 'update_task_step', ok: true, content: 'Task updated.' },
        { callId: 'read', name: 'read_chapter', ok: true, content: 'Synthetic prose. '.repeat(15_000) },
      ] },
      { role: 'user', content: 'Continue reviewing.' },
    ];
    const fullCompactor = vi.fn(async (request: AgentContextFullCompactionRequest) => {
      expect(request.eligibleRuns).toHaveLength(1);
      expect(request.eligibleRuns[0]!.map((row) => row.callId)).toEqual(['task', 'read', 'task', 'read']);
      return [await createAgentContextSummaryCandidate({ summaryId: 'mixed-batch',
        sourceRows: request.eligibleRuns[0]!, content: 'The synthetic task is updated and the chapter was read.' })];
    });
    const result = await planAgentModelContext({ systemPrompt: 'Policy.', messages, resolveToolAccess,
      messageTurnIds: ['old', 'old', 'old', 'old', 'new'],
      supplementalRows: [{ sourceId: 'task-state', kind: 'task_plan', turnOrdinal: null, content: 'Synthetic review in progress.',
        durableWriteCoverage: [{ turnId: 'old', turnOrdinal: 0, callId: 'task', toolName: 'update_task_step' }] }],
      planner: { contextWindowTokens: 32_768, requestedOutputTokens: 4_096, fixedInputTokens: 0, fullCompactor },
    });
    expect(result.ok).toBe(true);
    expect(fullCompactor).toHaveBeenCalledOnce();
    if (!result.ok) return;
    expect(result.plan.checkpoint.coverage.discardedSourceIds).toEqual([]);
    expect(result.plan.checkpoint.pinned.sourceIds).toContain('task-state');
    expect(result.plan.segments.filter((segment) => segment.type === 'summary')).toHaveLength(1);
  });
});
