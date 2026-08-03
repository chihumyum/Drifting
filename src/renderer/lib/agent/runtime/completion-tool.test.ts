import { describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from './runtime';
import { ScriptedFakeDriver, type ScriptedDriverStep } from './testing';
import type {
  AgentRuntimeUsage,
  AgentToolDefinition,
  AgentToolRuntime,
} from './types';

function usage(inputTokens: number, outputTokens: number): AgentRuntimeUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function definition(name: string): AgentToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    access: 'read',
    validateInput: (value) => ({ ok: true, value }),
  };
}

function toolCall(callId: string, name: string, args: string): ScriptedDriverStep[] {
  return [
    { op: 'emit', event: { type: 'tool_call_start', callId, name } },
    { op: 'emit', event: { type: 'tool_args_delta', callId, delta: args } },
    { op: 'emit', event: { type: 'tool_call_end', callId } },
  ];
}

describe('AgentRuntime structured completion tool', () => {
  it('rejects a prose-only ending and forces the terminal tool on the final iteration', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            iteration: 1,
            reasoning: { enabled: true, effort: 'high' },
            toolChoice: 'auto',
            toolNames: ['read_fact', 'submit_result'],
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'looks fine' } },
            { op: 'emit', event: { type: 'usage', usage: usage(5, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
        {
          expectRequest: {
            iteration: 2,
            reasoning: { enabled: true, effort: 'high' },
            executionMode: 'required_tool_non_reasoning',
            toolChoice: { force: 'submit_result' },
            toolNames: ['submit_result'],
          },
          steps: [
            ...toolCall('submit-1', 'submit_result', '{"verdict":"pass"}'),
            { op: 'emit', event: { type: 'usage', usage: usage(7, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
      ],
    });
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: 'submitted',
    }));
    const runtime = new AgentRuntime({
      driver,
      tools: {
        listDefinitions: () => [definition('read_fact'), definition('submit_result')],
        execute,
      },
    });

    const result = await runtime.runTurn({
      sessionId: 'shadow-session',
      turnId: 'shadow-turn',
      route: {
        kind: 'shadow',
        projectId: 'project-1',
        chapterId: 'chapter-1',
        operation: 'review',
      },
      prompt: 'judge this chapter',
      reasoning: { enabled: true, effort: 'high' },
      completionTool: {
        name: 'submit_result',
        forceOnFinalIteration: true,
        disableReasoningWhenForced: true,
        reminder: 'submit the structured verdict',
      },
      limits: { maxModelIterations: 2, maxToolCalls: 1 },
    });

    expect(result.state.status).toBe('completed');
    expect(result.completionTool).toMatchObject({
      callId: 'submit-1',
      name: 'submit_result',
      arguments: { verdict: 'pass' },
      result: { ok: true, content: 'submitted' },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(driver.calls).toHaveLength(2);
    expect(driver.calls[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'submit the structured verdict' }),
      ]),
    );
  });
});
