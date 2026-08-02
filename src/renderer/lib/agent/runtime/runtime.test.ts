import { describe, expect, it, vi } from 'vitest';
import { AgentModelDriverError } from './errors';
import { AgentRuntimeControlChannel } from './control-plane';
import { replayAgentRuntimeJournal } from './reducer';
import {
  AGENT_SYNTHESIS_DISCARDED_TOOL_TEXT,
  AGENT_SYNTHESIS_ONLY_SYSTEM_NOTE,
  AgentRuntime,
} from './runtime';
import {
  ManualAgentClock,
  ScriptedFakeDriver,
  type ScriptedDriverRound,
  type ScriptedDriverStep,
} from './testing';
import type {
  AgentModelDriver,
  AgentModelStreamEvent,
  AgentRuntimeJournalEntry,
  AgentRuntimeRunInput,
  AgentRuntimeUsage,
  AgentToolDefinition,
  AgentToolRuntime,
} from './types';

const ROUTE = { kind: 'test', projectId: 'project-1' } as const;

function usage(inputTokens: number, outputTokens: number, costUsd = 0): AgentRuntimeUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  };
}

function input(overrides: Partial<AgentRuntimeRunInput> = {}): AgentRuntimeRunInput {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    route: ROUTE,
    prompt: 'Help me',
    ...overrides,
  };
}

function definition(
  name: string,
  access: AgentToolDefinition['access'] = 'read',
  validateInput: AgentToolDefinition['validateInput'] = (value) => ({
    ok: true,
    value,
  }),
): AgentToolDefinition {
  return {
    name,
    description: `${access} ${name}`,
    inputSchema: { type: 'object' },
    access,
    validateInput,
  };
}

function toolRuntime(
  definitions: readonly AgentToolDefinition[],
  execute: AgentToolRuntime['execute'],
): AgentToolRuntime {
  return {
    listDefinitions: () => definitions,
    execute,
  };
}

function toolCallSteps(
  callId: string,
  name: string,
  chunks: readonly string[],
): ScriptedDriverStep[] {
  return [
    { op: 'emit', event: { type: 'tool_call_start', callId, name } },
    ...chunks.map(
      (delta): ScriptedDriverStep => ({
        op: 'emit',
        event: { type: 'tool_args_delta', callId, delta },
      }),
    ),
    { op: 'emit', event: { type: 'tool_call_end', callId } },
  ];
}

async function waitUntil(predicate: () => boolean, message: string, turns = 1_000): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(message);
}

describe('AgentRuntime', () => {
  it('gates a write before the scheduler and executes only after a provenance-bound approval', async () => {
    const clock = new ManualAgentClock();
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: 'written',
    }));
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('write-1', 'write', ['{"expectedRevision":"rev-1","title":"New"}']),
            { op: 'emit', event: { type: 'usage', usage: usage(4, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'done' } },
            { op: 'emit', event: { type: 'usage', usage: usage(5, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const control = new AgentRuntimeControlChannel('session-1', 'turn-1');
    const entries: AgentRuntimeJournalEntry[] = [];
    const turn = new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([definition('write', 'write')], execute),
      permissionPolicy: {
        decide: () => ({
          decision: 'ask',
          reason: 'write requires approval',
          allowedScopes: ['once'],
        }),
      },
    }).runTurn(input({ control, onEntry: (entry) => entries.push(entry) }));

    await waitUntil(
      () => entries.some((entry) => entry.event.type === 'permission_requested'),
      'permission request was not journaled',
    );
    expect(execute).not.toHaveBeenCalled();
    const requested = entries.find((entry) => entry.event.type === 'permission_requested')?.event;
    if (!requested || requested.type !== 'permission_requested') {
      throw new Error('missing permission request');
    }
    expect(requested.request).toMatchObject({
      toolName: 'write',
      arguments: { expectedRevision: 'rev-1', title: 'New' },
      revision: 'rev-1',
    });
    await expect(
      control.resolvePermission({
        requestId: requested.request.requestId,
        sessionId: requested.request.sessionId,
        turnId: requested.request.turnId,
        callId: requested.request.callId,
        argumentsHash: `sha256:${'0'.repeat(64)}`,
        revision: requested.request.revision,
        decision: 'allow',
        scope: 'once',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_CONTROL_STALE' });

    const approved = control.resolvePermission({
      requestId: requested.request.requestId,
      sessionId: requested.request.sessionId,
      turnId: requested.request.turnId,
      callId: requested.request.callId,
      argumentsHash: requested.request.argumentsHash,
      revision: requested.request.revision,
      decision: 'allow',
      scope: 'once',
    });
    const result = await turn;
    await approved;

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      authorization: {
        kind: 'author_approved',
        requestId: requested.request.requestId,
        argumentsHash: requested.request.argumentsHash,
      },
    });
    expect(result.state.status).toBe('completed');
    expect(result.entries.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining([
        'permission_requested',
        'permission_resolved',
        'tool_execution_started',
        'commit_started',
      ]),
    );
    expect(
      result.entries.findIndex((entry) => entry.event.type === 'permission_resolved'),
    ).toBeLessThan(
      result.entries.findIndex((entry) => entry.event.type === 'tool_execution_started'),
    );
    expect(replayAgentRuntimeJournal(result.entries)).toEqual(result.state);
    clock.assertIdle();
  });

  it('persists a durable permission choice before dispatch and binds execution to its authority id', async () => {
    const order: string[] = [];
    const entries: AgentRuntimeJournalEntry[] = [];
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => {
      order.push('execute');
      expect(request.authorization).toMatchObject({
        kind: 'author_approved',
        requestId: 'grant-session-1',
      });
      return { ok: true, data: 'read' };
    });
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('external-1', 'external_read', ['{"query":"rain"}']),
            { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'done' } },
            { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const control = new AgentRuntimeControlChannel('session-1', 'turn-1');
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime([definition('external_read', 'read')], execute),
      permissionPolicy: {
        decide: () => ({
          decision: 'ask',
          reason: 'external authority',
          allowedScopes: ['once', 'session', 'project'],
        }),
        recordResolution: async (_request, resolution) => {
          order.push('persist');
          expect(resolution.scope).toBe('session');
          return { authorityId: 'grant-session-1' };
        },
      },
    });
    const turn = runtime.runTurn(input({ control, onEntry: (entry) => entries.push(entry) }));
    await waitUntil(
      () => entries.some((entry) => entry.event.type === 'permission_requested'),
      'durable permission was not requested',
    );
    const event = entries.find((entry) => entry.event.type === 'permission_requested')?.event;
    if (!event || event.type !== 'permission_requested') throw new Error('missing permission');
    expect(event.request.allowedScopes).toEqual(['once', 'session', 'project']);
    const resolution = control.resolvePermission({
      requestId: event.request.requestId,
      sessionId: event.request.sessionId,
      turnId: event.request.turnId,
      callId: event.request.callId,
      argumentsHash: event.request.argumentsHash,
      revision: event.request.revision,
      decision: 'allow',
      scope: 'session',
    });
    const result = await turn;
    await resolution;

    expect(result.state.status).toBe('completed');
    expect(order).toEqual(['persist', 'execute']);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not dispatch when durable permission persistence fails', async () => {
    const entries: AgentRuntimeJournalEntry[] = [];
    const execute = vi.fn<AgentToolRuntime['execute']>();
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('external-fail', 'external_write', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
      ],
    });
    const control = new AgentRuntimeControlChannel('session-1', 'turn-1');
    const turn = new AgentRuntime({
      driver,
      tools: toolRuntime([definition('external_write', 'write')], execute),
      permissionPolicy: {
        decide: () => ({ decision: 'ask', allowedScopes: ['project'] }),
        recordResolution: async () => {
          throw new Error('injected authority failure');
        },
      },
    }).runTurn(input({ control, onEntry: (entry) => entries.push(entry) }));
    await waitUntil(
      () => entries.some((entry) => entry.event.type === 'permission_requested'),
      'permission was not requested',
    );
    const event = entries.find((entry) => entry.event.type === 'permission_requested')?.event;
    if (!event || event.type !== 'permission_requested') throw new Error('missing permission');
    const resolution = control.resolvePermission({
      requestId: event.request.requestId,
      sessionId: event.request.sessionId,
      turnId: event.request.turnId,
      callId: event.request.callId,
      argumentsHash: event.request.argumentsHash,
      revision: event.request.revision,
      decision: 'allow',
      scope: 'project',
    });
    const result = await turn;
    await expect(resolution).resolves.toBeUndefined();

    expect(result.state.status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    expect(entries.some((entry) => entry.event.type === 'tool_execution_started')).toBe(false);
  });

  it('feeds a policy denial back to the model without dispatching the tool', async () => {
    const execute = vi.fn<AgentToolRuntime['execute']>();
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('write-denied', 'write', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: (request) => {
            const result = request.messages[request.messages.length - 1];
            expect(result).toMatchObject({
              role: 'tool',
              content: [
                {
                  callId: 'write-denied',
                  ok: false,
                  content: 'Permission denied: project policy',
                },
              ],
            });
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'I did not write.' } },
            { op: 'emit', event: { type: 'usage', usage: usage(3, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('write', 'write')], execute),
      permissionPolicy: {
        decide: () => ({ decision: 'deny', reason: 'project policy' }),
      },
    }).runTurn(input());

    expect(execute).not.toHaveBeenCalled();
    expect(result.state.status).toBe('completed');
    expect(
      result.entries.find(
        (entry) => entry.event.type === 'tool_result' && entry.event.callId === 'write-denied',
      )?.event,
    ).toMatchObject({
      source: 'runtime',
      errorCode: 'PERMISSION_DENIED',
    });
  });

  it('lets a tool wait for canonical user input and resumes exactly once', async () => {
    const control = new AgentRuntimeControlChannel('session-1', 'turn-1');
    const entries: AgentRuntimeJournalEntry[] = [];
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => {
      const answer = await request.control!.requestUserInput({
        prompt: 'Choose an ending',
      });
      return { ok: true, data: { answer } };
    });
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('ask-1', 'ask_user', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'accepted' } },
            { op: 'emit', event: { type: 'usage', usage: usage(3, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const turn = new AgentRuntime({
      driver,
      tools: toolRuntime([definition('ask_user')], execute),
    }).runTurn(input({ control, onEntry: (entry) => entries.push(entry) }));
    await waitUntil(
      () => entries.some((entry) => entry.event.type === 'user_input_requested'),
      'user input request was not journaled',
    );
    const event = entries.find((entry) => entry.event.type === 'user_input_requested')?.event;
    if (!event || event.type !== 'user_input_requested') {
      throw new Error('missing user input request');
    }
    const submitted = control.submitUserInput({
      requestId: event.request.requestId,
      sessionId: event.request.sessionId,
      turnId: event.request.turnId,
      callId: event.request.callId,
      text: 'Keep the ambiguous ending',
    });
    const result = await turn;
    await submitted;

    expect(execute).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('completed');
    expect(result.entries.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining(['user_input_requested', 'user_input_received']),
    );
  });

  it('completes a text-only turn and replays the exact canonical state', async () => {
    const clock = new ManualAgentClock({ wallTimeMs: 1_000 });
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            iteration: 1,
            messages: [{ role: 'user', content: 'Help me' }],
            toolNames: [],
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'Hello' } },
            { op: 'emit', event: { type: 'text_delta', text: ' world' } },
            { op: 'emit', event: { type: 'usage', usage: usage(8, 2, 0.001) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({ driver, clock }).runTurn(input());

    expect(result.state).toMatchObject({
      status: 'completed',
      assistantText: 'Hello world',
      modelIterations: 1,
      usage: usage(8, 2, 0.001),
    });
    expect(result.entries[0].event.type).toBe('turn_started');
    expect(result.entries[result.entries.length - 1].event).toMatchObject({
      type: 'turn_finished',
      outcome: 'completed',
    });
    expect(replayAgentRuntimeJournal(JSON.parse(JSON.stringify(result.entries)))).toEqual(
      result.state,
    );
    expect(Object.isFrozen(result.entries[0])).toBe(true);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('streams only the marked final response and hides draft prose across split chunks', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            {
              op: 'emit',
              event: {
                type: 'text_delta',
                text: 'Private drafting that must stay hidden. FINAL_',
              },
            },
            {
              op: 'emit',
              event: { type: 'text_delta', text: 'RESPONSE:\n最终' },
            },
            { op: 'emit', event: { type: 'text_delta', text: '答案' } },
            { op: 'emit', event: { type: 'usage', usage: usage(12, 5) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({ driver }).runTurn(input());
    const visibleDeltas = result.entries.flatMap((entry) =>
      entry.event.type === 'text_delta' ? [entry.event.text] : [],
    );

    expect(visibleDeltas).toEqual(['最终', '答案']);
    expect(result.state.assistantText).toBe('最终答案');
    expect(JSON.stringify(result.entries)).not.toContain('Private drafting');
    expect(JSON.stringify(result.entries)).not.toContain('FINAL_RESPONSE:');
    driver.assertExhausted();
  });

  it('keeps local review authority out of model-visible file tool results', async () => {
    const reviewId = 'agent-review:private-runtime-evidence';
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('edit-1', 'edit_file', ['{"path":"/chapters/01"}']),
            { op: 'emit', event: { type: 'usage', usage: usage(10, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'FINAL_RESPONSE:完成。' } },
            { op: 'emit', event: { type: 'usage', usage: usage(12, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('edit_file', 'write')], async () => ({
        ok: true,
        data: {
          result: { path: '/chapters/01/prose.md', updated: true },
          review: { id: reviewId, status: 'pending' },
        },
        modelData: 'Updated /chapters/01/prose.md.',
        presentation: { review: { id: reviewId, status: 'pending' } },
      })),
    }).runTurn(input());

    expect(JSON.stringify(driver.calls[1])).toContain('Updated /chapters/01/prose.md.');
    expect(JSON.stringify(driver.calls[1])).not.toContain(reviewId);
    const toolResult = result.entries.find((entry) => entry.event.type === 'tool_result');
    expect(toolResult?.event).toMatchObject({
      type: 'tool_result',
      content: 'Updated /chapters/01/prose.md.',
      review: { id: reviewId, status: 'pending' },
    });
    driver.assertExhausted();
  });

  it('assembles fragmented arguments, journals normalized input, and continues after a tool', async () => {
    const clock = new ManualAgentClock();
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => ({
      ok: true,
      data: { hits: [request.arguments.query] },
    }));
    const lookup = definition('lookup', 'read', (value) => {
      if (typeof value.query !== 'string') return { ok: false, error: 'query is required' };
      return {
        ok: true,
        value: {
          query: value.query,
          limit: Number(value.limit),
        },
      };
    });
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'Let me look that up.' } },
            ...toolCallSteps('call-1', 'lookup', ['{"query":', '"Alice",', '"limit":"2"}']),
            { op: 'emit', event: { type: 'usage', usage: usage(10, 4) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: (request) => {
            expect(request.messages).toEqual([
              { role: 'user', content: 'Help me' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_call',
                    callId: 'call-1',
                    name: 'lookup',
                    arguments: { query: 'Alice', limit: 2 },
                    rawArguments: '{"query":"Alice","limit":"2"}',
                  },
                ],
              },
              {
                role: 'tool',
                content: [
                  {
                    callId: 'call-1',
                    name: 'lookup',
                    ok: true,
                    content: '{"hits":["Alice"]}',
                  },
                ],
              },
            ]);
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'Found Alice' } },
            { op: 'emit', event: { type: 'usage', usage: usage(20, 3) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([lookup], execute),
    }).runTurn(input());

    expect(result.state.status).toBe('completed');
    expect(result.state.assistantText).toBe('Found Alice');
    expect(result.state.assistantText).not.toContain('Let me look');
    expect(result.state.usage).toEqual(usage(30, 7));
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toMatchObject({
      idempotencyKey: 'session-1:turn-1:call-1',
      arguments: { query: 'Alice', limit: 2 },
    });
    const ready = result.entries.find((entry) => entry.event.type === 'tool_call_ready');
    expect(ready?.event).toMatchObject({
      type: 'tool_call_ready',
      arguments: { query: 'Alice', limit: 2 },
    });
    const argumentEvents = result.entries.filter(
      (entry) => entry.event.type === 'tool_args_delta',
    );
    expect(argumentEvents).toHaveLength(1);
    expect(argumentEvents[0]?.event).toMatchObject({
      type: 'tool_args_delta',
      delta: '{"query":"Alice","limit":"2"}',
    });
    const types = result.entries.map((entry) => entry.event.type);
    expect(types.indexOf('tool_call_ready')).toBeLessThan(
      types.indexOf('model_iteration_completed'),
    );
    expect(types.indexOf('model_iteration_completed')).toBeLessThan(
      types.indexOf('tool_execution_started'),
    );
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('assembles character-streamed arguments for interleaved parallel tool calls', async () => {
    const aJson = JSON.stringify({ path: '/chapters/一/prose.md' });
    const bJson = JSON.stringify({ path: '/chapters/二/prose.md' });
    const interleaved: ScriptedDriverStep[] = [
      { op: 'emit', event: { type: 'tool_call_start', callId: 'a', name: 'read_a' } },
      { op: 'emit', event: { type: 'tool_call_start', callId: 'b', name: 'read_b' } },
    ];
    for (let index = 0; index < Math.max(aJson.length, bJson.length); index += 1) {
      if (aJson[index]) {
        interleaved.push({
          op: 'emit',
          event: { type: 'tool_args_delta', callId: 'a', delta: aJson[index]! },
        });
      }
      if (bJson[index]) {
        interleaved.push({
          op: 'emit',
          event: { type: 'tool_args_delta', callId: 'b', delta: bJson[index]! },
        });
      }
    }
    interleaved.push(
      { op: 'emit', event: { type: 'tool_call_end', callId: 'b' } },
      { op: 'emit', event: { type: 'tool_call_end', callId: 'a' } },
    );
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => ({
      ok: true,
      data: request.arguments.path,
    }));
    const validate: AgentToolDefinition['validateInput'] = (value) =>
      typeof value.path === 'string'
        ? { ok: true, value }
        : { ok: false, error: 'path is required' };
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...interleaved,
            { op: 'emit', event: { type: 'usage', usage: usage(20, 4) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'done' } },
            { op: 'emit', event: { type: 'usage', usage: usage(10, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime(
        [definition('read_a', 'read', validate), definition('read_b', 'read', validate)],
        execute,
      ),
    }).runTurn(input());

    expect(result.state.status).toBe('completed');
    expect(execute.mock.calls.map(([request]) => [request.name, request.arguments])).toEqual([
      ['read_a', { path: '/chapters/一/prose.md' }],
      ['read_b', { path: '/chapters/二/prose.md' }],
    ]);
    expect(
      result.entries
        .filter((entry) => entry.event.type === 'tool_args_delta')
        .map((entry) =>
          entry.event.type === 'tool_args_delta'
            ? [entry.event.callId, entry.event.delta]
            : null,
        ),
    ).toEqual([
      ['b', bJson],
      ['a', aJson],
    ]);
    driver.assertExhausted();
  });

  it('gives a tool-free direct answer the full output budget', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: (request) => {
            expect(request.tools).toEqual([]);
            expect(request.maxOutputTokens).toBe(100);
            expect(request.context.systemPrompt).not.toContain(AGENT_SYNTHESIS_ONLY_SYSTEM_NOTE);
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: '直接回答。' } },
            { op: 'emit', event: { type: 'usage', usage: usage(1, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({ driver }).runTurn(
      input({
        limits: {
          maxModelIterations: 3,
          maxOutputTokens: 100,
          maxTotalTokens: 100,
          maxOutputTokensPerIteration: 100,
        },
      }),
    );

    expect(result.state.status).toBe('completed');
    expect(result.state.assistantText).toBe('直接回答。');
    driver.assertExhausted();
  });

  it('has no aggregate iteration, tool-call, token, cost, or duration quota by default', async () => {
    const workRounds: ScriptedDriverRound[] = Array.from({ length: 34 }, (_, index) => ({
      steps: [
        ...toolCallSteps(`read-${index}`, 'read', ['{}']),
        { op: 'emit', event: { type: 'usage', usage: usage(30_000, 1_000, 0.1) } },
        { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
      ],
    }));
    const driver = new ScriptedFakeDriver({
      rounds: [
        ...workRounds,
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: '全部完成。' } },
            { op: 'emit', event: { type: 'usage', usage: usage(1, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: { inspected: true },
    }));

    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('read')], execute),
    }).runTurn(input());

    expect(result.state.status).toBe('completed');
    expect(result.state.modelIterations).toBe(35);
    expect(execute).toHaveBeenCalledTimes(34);
    expect(result.state.usage.inputTokens).toBe(1_020_001);
    expect(result.state.usage.outputTokens).toBe(34_001);
    expect(result.state.usage.costUsd).toBeCloseTo(3.4);
    driver.assertExhausted();
  });

  it('gives a direct answer the full budget when tool search selects no tools', async () => {
    const select = vi.fn(() => [] as const);
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: (request) => {
            expect(request.tools).toEqual([]);
            expect(request.maxOutputTokens).toBe(100);
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: '无需工具。' } },
            { op: 'emit', event: { type: 'usage', usage: usage(1, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('list_nodes')], vi.fn<AgentToolRuntime['execute']>()),
      toolSelector: { select },
    }).runTurn(
      input({
        toolSearch: 'on',
        limits: {
          maxModelIterations: 3,
          maxOutputTokens: 100,
          maxTotalTokens: 100,
          maxOutputTokensPerIteration: 100,
        },
      }),
    );

    expect(select).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('completed');
    expect(result.state.assistantText).toBe('无需工具。');
    driver.assertExhausted();
  });

  it('reserves the final model iteration for a best-effort answer after tool results', async () => {
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: { chapters: ['第一章'] },
    }));
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          expectRequest: {
            iteration: 1,
            toolNames: ['list_nodes'],
          },
          steps: [
            ...toolCallSteps('list-1', 'list_nodes', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(4, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: (request) => {
            expect(request.iteration).toBe(2);
            expect(request.tools).toEqual([]);
            expect(request.messages[request.messages.length - 1]).toMatchObject({
              role: 'tool',
              content: [
                {
                  callId: 'list-1',
                  ok: true,
                },
              ],
            });
          },
          steps: [
            {
              op: 'emit',
              event: {
                type: 'text_delta',
                text: '目前有第一章。',
              },
            },
            { op: 'emit', event: { type: 'usage', usage: usage(5, 3) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('list_nodes')], execute),
    }).runTurn(
      input({
        limits: { maxModelIterations: 2 },
      }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result.state.status).toBe('completed');
    expect(result.state.assistantText).toContain('目前有第一章');
    expect(result.state.terminal?.outcome).toBe('completed');
    driver.assertExhausted();
  });

  it.each([
    {
      name: 'output budget',
      limits: {
        maxModelIterations: 3,
        maxOutputTokens: 6,
        maxTotalTokens: 100,
        maxOutputTokensPerIteration: 6,
      },
      firstUsage: usage(2, 3),
      secondUsage: usage(3, 2),
      expectedFirstMax: 3,
      expectedSynthesisMax: 3,
    },
    {
      name: 'total token budget',
      limits: {
        maxModelIterations: 3,
        maxOutputTokens: 20,
        maxTotalTokens: 10,
        maxOutputTokensPerIteration: 20,
      },
      firstUsage: usage(4, 1),
      secondUsage: usage(3, 2),
      expectedFirstMax: 5,
      expectedSynthesisMax: 5,
    },
  ])(
    'protects a synthesis headroom inside the $name',
    async ({ limits, firstUsage, secondUsage, expectedFirstMax, expectedSynthesisMax }) => {
      const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
        ok: true,
        data: { chapters: ['第一章'] },
      }));
      const driver = new ScriptedFakeDriver({
        rounds: [
          {
            expectRequest: (request) => {
              expect(request.maxOutputTokens).toBe(expectedFirstMax);
              expect(request.tools.map((tool) => tool.name)).toEqual(['list_nodes']);
            },
            steps: [
              ...toolCallSteps('list-budget', 'list_nodes', ['{}']),
              { op: 'emit', event: { type: 'usage', usage: firstUsage } },
              { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
            ],
          },
          {
            expectRequest: (request) => {
              // Headroom exhaustion triggers synthesis before the nominal
              // final iteration and exposes no tool surface.
              expect(request.iteration).toBe(2);
              expect(request.maxOutputTokens).toBe(expectedSynthesisMax);
              expect(request.tools).toEqual([]);
              expect(request.context.systemPrompt).toContain(AGENT_SYNTHESIS_ONLY_SYSTEM_NOTE);
            },
            steps: [
              {
                op: 'emit',
                event: {
                  type: 'text_delta',
                  text: '已根据读取结果完成回答。',
                },
              },
              { op: 'emit', event: { type: 'usage', usage: secondUsage } },
              { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
            ],
          },
        ],
      });

      const result = await new AgentRuntime({
        driver,
        tools: toolRuntime([definition('list_nodes')], execute),
      }).runTurn(input({ limits }));

      expect(result.state.status).toBe('completed');
      expect(result.state.modelIterations).toBe(2);
      expect(result.state.assistantText).toContain('完成回答');
      driver.assertExhausted();
    },
  );

  it('opens a synthesis-only circuit after the same all-failed tool result repeats', async () => {
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: false,
      error: 'The project read boundary is temporarily unavailable.',
    }));
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('read-a', 'read_a', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(4, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            ...toolCallSteps('read-b', 'read_b', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(4, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: (request) => {
            expect(request.tools).toEqual([]);
            expect(request.messages.slice(-2)).toEqual([
              expect.objectContaining({
                role: 'assistant',
              }),
              {
                role: 'tool',
                content: [
                  expect.objectContaining({
                    callId: 'read-b',
                    ok: false,
                    content: 'The project read boundary is temporarily unavailable.',
                  }),
                ],
              },
            ]);
          },
          steps: [
            {
              op: 'emit',
              event: {
                type: 'text_delta',
                text: '读取暂时不可用，请稍后重试。',
              },
            },
            { op: 'emit', event: { type: 'usage', usage: usage(5, 4) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('read_a'), definition('read_b')], execute),
    }).runTurn(input());

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.state.status).toBe('completed');
    expect(result.state.modelIterations).toBe(3);
    expect(result.state.assistantText).toContain('读取暂时不可用');
    driver.assertExhausted();
  });

  it('discards provider pseudo-tool markup at a synthesis-only boundary', async () => {
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('read-1', 'read_node', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(4, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: (request) => {
            expect(request.tools).toEqual([]);
            expect(request.context.systemPrompt).toContain(AGENT_SYNTHESIS_ONLY_SYSTEM_NOTE);
          },
          steps: [
            {
              op: 'emit',
              event: {
                type: 'text_delta',
                text: 'I will continue. <｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read_node">',
              },
            },
            { op: 'emit', event: { type: 'usage', usage: usage(5, 4) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime([definition('read_node')], async () => ({ ok: true, data: {} })),
    }).runTurn(input({ limits: { maxModelIterations: 2 } }));

    expect(result.state.assistantText).toContain(AGENT_SYNTHESIS_DISCARDED_TOOL_TEXT);
    expect(result.state.assistantText).not.toContain('DSML');
    driver.assertExhausted();
  });

  it('feeds malformed, unknown, and schema-invalid calls back without executing them', async () => {
    const clock = new ManualAgentClock();
    const execute = vi.fn<AgentToolRuntime['execute']>();
    const lookup = definition('lookup', 'read', (value) =>
      typeof value.query === 'string'
        ? { ok: true, value }
        : { ok: false, error: 'query is required' },
    );
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('malformed', 'lookup', ['{"query":']),
            ...toolCallSteps('unknown', 'missing_tool', ['{}']),
            ...toolCallSteps('invalid', 'lookup', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(12, 5) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'I repaired the calls.' } },
            { op: 'emit', event: { type: 'usage', usage: usage(18, 4) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });

    const result = await new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([lookup], execute),
    }).runTurn(input());

    expect(result.state.status).toBe('completed');
    expect(execute).not.toHaveBeenCalled();
    expect(
      result.entries
        .filter(
          (
            entry,
          ): entry is AgentRuntimeJournalEntry & {
            event: Extract<AgentRuntimeJournalEntry['event'], { type: 'tool_result' }>;
          } => entry.event.type === 'tool_result',
        )
        .map((entry) => entry.event.errorCode),
    ).toEqual(['MALFORMED_TOOL_ARGUMENTS', 'UNKNOWN_TOOL', 'INVALID_TOOL_ARGUMENTS']);
    expect(driver.calls).toHaveLength(2);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('runs adjacent reads concurrently while preserving write barriers and result order', async () => {
    const clock = new ManualAgentClock();
    let releaseReadA: () => void = () => undefined;
    let releaseReadB: () => void = () => undefined;
    const readA = new Promise<void>((resolve) => {
      releaseReadA = resolve;
    });
    const readB = new Promise<void>((resolve) => {
      releaseReadB = resolve;
    });
    const starts: string[] = [];
    const execute: AgentToolRuntime['execute'] = async (request) => {
      starts.push(request.name);
      if (request.name === 'read_a') await readA;
      if (request.name === 'read_b') await readB;
      return { ok: true, data: request.name };
    };
    const definitions = [
      definition('read_a'),
      definition('read_b'),
      definition('write_c', 'write'),
      definition('read_d'),
    ];
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('a', 'read_a', ['{}']),
            ...toolCallSteps('b', 'read_b', ['{}']),
            ...toolCallSteps('c', 'write_c', ['{}']),
            ...toolCallSteps('d', 'read_d', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(20, 8) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'done' } },
            { op: 'emit', event: { type: 'usage', usage: usage(20, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const turn = new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime(definitions, execute),
    }).runTurn(input());

    await waitUntil(
      () => starts.length === 2,
      `expected first read batch, got ${starts.join(', ')}`,
    );
    expect(starts).toEqual(['read_a', 'read_b']);
    releaseReadB();
    await Promise.resolve();
    expect(starts).toEqual(['read_a', 'read_b']);
    releaseReadA();
    await waitUntil(
      () => starts.length === 4,
      `expected write barrier and trailing read, got ${starts.join(', ')}`,
    );

    const result = await turn;
    expect(starts).toEqual(['read_a', 'read_b', 'write_c', 'read_d']);
    expect(
      result.entries
        .filter((entry) => entry.event.type === 'tool_result')
        .map((entry) => (entry.event.type === 'tool_result' ? entry.event.callId : '')),
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(result.state.status).toBe('completed');
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('stops scheduling later writes immediately after the current tool settles', async () => {
    let releaseFirstWrite: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const started: string[] = [];
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => {
      started.push(request.name);
      if (request.name === 'write_a') await firstWrite;
      return { ok: true, data: request.name };
    });
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('a', 'write_a', ['{}']),
            ...toolCallSteps('b', 'write_b', ['{}']),
            ...toolCallSteps('c', 'write_c', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(4, 3) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
      ],
    });
    const control = new AgentRuntimeControlChannel('session-1', 'turn-1');
    const turn = new AgentRuntime({
      driver,
      tools: toolRuntime(
        [
          definition('write_a', 'write'),
          definition('write_b', 'write'),
          definition('write_c', 'write'),
        ],
        execute,
      ),
    }).runTurn(input({ control }));

    await waitUntil(() => started.length === 1, 'the first write did not start');
    const stop = control.stopAfterTool({ turnId: 'turn-1' });
    releaseFirstWrite();
    const result = await turn;
    await stop;

    expect(started).toEqual(['write_a']);
    expect(result.state.status).toBe('aborted');
    expect(
      result.entries
        .filter(
          (entry) =>
            entry.event.type === 'tool_result' &&
            (entry.event.callId === 'b' || entry.event.callId === 'c'),
        )
        .map((entry) => (entry.event.type === 'tool_result' ? entry.event.errorCode : null)),
    ).toEqual(['STOP_AFTER_TOOL', 'STOP_AFTER_TOOL']);
  });

  it('applies author steering exactly once at the next model boundary', async () => {
    const steeringText = '保留已经完成的修改，但把后续章节的语气改得更克制。';
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            { op: 'wait', gate: 'steer-now' },
            { op: 'emit', event: { type: 'usage', usage: usage(3, 1) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
        {
          expectRequest: (request) => {
            expect(
              request.messages.filter(
                (message) =>
                  message.role === 'user' && message.content === steeringText,
              ),
            ).toHaveLength(1);
            expect(request.messages[request.messages.length - 1]).toEqual({
              role: 'user',
              content: steeringText,
            });
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: '已按新要求继续。' } },
            { op: 'emit', event: { type: 'usage', usage: usage(4, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const control = new AgentRuntimeControlChannel('session-1', 'turn-1');
    const turn = new AgentRuntime({
      driver,
      tools: toolRuntime([], async () => ({ ok: true, data: null })),
    }).runTurn(input({ control }));

    await driver.waitUntilGate('steer-now');
    await control.steer({ turnId: 'turn-1', text: steeringText });
    driver.release('steer-now');
    const result = await turn;

    expect(result.state.status).toBe('completed');
    expect(result.state.pendingSteering).toEqual([]);
    expect(
      result.entries.filter(
        (entry) => entry.event.type === 'steering_received',
      ),
    ).toHaveLength(1);
    expect(
      result.entries.filter(
        (entry) => entry.event.type === 'steering_applied',
      ),
    ).toHaveLength(1);
    driver.assertExhausted();
  });

  it('serializes writes across concurrent runtime instances', async () => {
    const clock = new ManualAgentClock();
    let releaseFirstWrite: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const starts: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const tools = toolRuntime([definition('write', 'write')], async (request) => {
      starts.push(request.turnId);
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      if (starts.length === 1) await firstWrite;
      activeWrites -= 1;
      return { ok: true, data: 'written' };
    });
    const createDriver = (callId: string) =>
      new ScriptedFakeDriver({
        rounds: [
          {
            steps: [
              ...toolCallSteps(callId, 'write', ['{}']),
              { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
              { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
            ],
          },
          {
            steps: [
              { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
              { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
            ],
          },
        ],
      });
    const driverA = createDriver('write-a');
    const driverB = createDriver('write-b');
    const turnA = new AgentRuntime({ driver: driverA, tools, clock }).runTurn(
      input({ turnId: 'turn-a' }),
    );
    const turnB = new AgentRuntime({ driver: driverB, tools, clock }).runTurn(
      input({ turnId: 'turn-b' }),
    );

    await waitUntil(() => starts.length === 1, 'first write did not start');
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(starts).toHaveLength(1);
    expect(maxActiveWrites).toBe(1);
    releaseFirstWrite();

    const [resultA, resultB] = await Promise.all([turnA, turnB]);
    expect(resultA.state.status).toBe('completed');
    expect(resultB.state.status).toBe('completed');
    expect(starts).toHaveLength(2);
    expect(maxActiveWrites).toBe(1);
    driverA.assertExhausted();
    driverB.assertExhausted();
    clock.assertIdle();
  });

  it('does not let a concurrent write overtake an earlier cross-runtime read', async () => {
    const clock = new ManualAgentClock();
    let releaseRead: () => void = () => undefined;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const starts: string[] = [];
    const tools = toolRuntime(
      [definition('read'), definition('write', 'write')],
      async (request) => {
        starts.push(request.name);
        if (request.name === 'read') await heldRead;
        return { ok: true, data: request.name };
      },
    );
    const driverFor = (callId: string, name: 'read' | 'write') =>
      new ScriptedFakeDriver({
        rounds: [
          {
            steps: [
              ...toolCallSteps(callId, name, ['{}']),
              { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
              { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
            ],
          },
          {
            steps: [
              { op: 'emit', event: { type: 'usage', usage: usage(2, 1) } },
              { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
            ],
          },
        ],
      });
    const readDriver = driverFor('read-1', 'read');
    const writeDriver = driverFor('write-1', 'write');
    const readTurn = new AgentRuntime({ driver: readDriver, tools, clock }).runTurn(
      input({ turnId: 'turn-read' }),
    );
    await waitUntil(() => starts[0] === 'read', 'read did not start');
    const writeTurn = new AgentRuntime({ driver: writeDriver, tools, clock }).runTurn(
      input({ turnId: 'turn-write' }),
    );

    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(starts).toEqual(['read']);
    releaseRead();
    const [readResult, writeResult] = await Promise.all([readTurn, writeTurn]);

    expect(starts).toEqual(['read', 'write']);
    expect(readResult.state.status).toBe('completed');
    expect(writeResult.state.status).toBe('completed');
    readDriver.assertExhausted();
    writeDriver.assertExhausted();
    clock.assertIdle();
  });

  it('closes partial tool arguments and emits one terminal on abort', async () => {
    const clock = new ManualAgentClock();
    const controller = new AbortController();
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            { op: 'emit', event: { type: 'tool_call_start', callId: 'partial', name: 'read' } },
            { op: 'emit', event: { type: 'tool_args_delta', callId: 'partial', delta: '{' } },
            { op: 'wait', gate: 'partial-args' },
          ],
        },
      ],
    });
    const turn = new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([definition('read')], async () => ({ ok: true, data: null })),
    }).runTurn(input({ signal: controller.signal }));

    await driver.waitUntilGate('partial-args');
    controller.abort('user stopped');
    const result = await turn;

    expect(result.state.status).toBe('aborted');
    expect(result.state.tools.partial?.result).toMatchObject({
      ok: false,
      source: 'runtime',
      errorCode: 'ABORTED',
    });
    const terminals = result.entries.filter((entry) => entry.event.type === 'turn_finished');
    expect(terminals).toHaveLength(1);
    expect(result.entries[result.entries.length - 1]).toBe(terminals[0]);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('turns a hanging provider into a deterministic duration-budget terminal', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({
      rounds: [{ steps: [{ op: 'wait', gate: 'provider-hung' }] }],
    });
    const turn = new AgentRuntime({ driver, clock }).runTurn(
      input({ limits: { maxDurationMs: 100 } }),
    );

    await driver.waitUntilGate('provider-hung');
    clock.advanceBy(100);
    const result = await turn;

    expect(result.state.terminal).toMatchObject({
      type: 'turn_finished',
      outcome: 'budget_exceeded',
      failureCode: 'BUDGET_EXCEEDED',
    });
    expect(result.entries.filter((entry) => entry.event.type === 'turn_finished')).toHaveLength(1);
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('publishes the duration terminal without awaiting non-cooperative iterator cleanup', async () => {
    const clock = new ManualAgentClock();
    let nextCalled = false;
    let returnCalled = false;
    const neverNext = new Promise<IteratorResult<AgentModelStreamEvent>>(() => undefined);
    const neverReturn = new Promise<IteratorResult<AgentModelStreamEvent>>(() => undefined);
    const driver: AgentModelDriver = {
      id: 'non-cooperative-provider',
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              nextCalled = true;
              return neverNext;
            },
            return: () => {
              returnCalled = true;
              return neverReturn;
            },
          };
        },
      }),
    };
    const turn = new AgentRuntime({ driver, clock }).runTurn(
      input({ limits: { maxDurationMs: 100 } }),
    );

    await waitUntil(() => nextCalled, 'provider iterator was not entered');
    clock.advanceBy(100);
    const result = await turn;

    expect(returnCalled).toBe(true);
    expect(result.state.terminal).toMatchObject({
      type: 'turn_finished',
      outcome: 'budget_exceeded',
      failureCode: 'BUDGET_EXCEEDED',
    });
    expect(result.entries.filter((entry) => entry.event.type === 'turn_finished')).toHaveLength(1);
    clock.assertIdle();
  });

  it('turns a journal failure into a canonical failed terminal', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({ rounds: [] });
    let appendCalls = 0;
    const result = await new AgentRuntime({
      driver,
      clock,
      journal: {
        append: () => {
          appendCalls += 1;
          if (appendCalls === 2) throw new Error('disk secret must not escape');
        },
      },
    }).runTurn(input());

    expect(appendCalls).toBe(2);
    expect(result.state.terminal).toMatchObject({
      outcome: 'failed',
      failureCode: 'JOURNAL_ERROR',
      message: 'Agent journal persistence failed',
    });
    expect(result.entries[result.entries.length - 1].event.type).toBe('turn_finished');
    expect(result.entries.filter((entry) => entry.event.type === 'turn_finished')).toHaveLength(1);
    expect(JSON.stringify(result.entries)).not.toContain('disk secret');
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('bounds a hanging journal append with the turn deadline', async () => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({ rounds: [] });
    const never = new Promise<void>(() => undefined);
    const turn = new AgentRuntime({
      driver,
      clock,
      journal: { append: () => never },
    }).runTurn(input({ limits: { maxDurationMs: 100 } }));

    await waitUntil(() => clock.pendingSleepCount === 1, 'deadline was not armed');
    clock.advanceBy(100);
    const result = await turn;

    expect(result.state.terminal).toMatchObject({
      outcome: 'budget_exceeded',
      failureCode: 'BUDGET_EXCEEDED',
    });
    expect(result.entries[result.entries.length - 1].event.type).toBe('turn_finished');
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('turns a non-cooperative read into a terminal and keeps its tool result in recovery messages', async () => {
    const clock = new ManualAgentClock();
    const entries: AgentRuntimeJournalEntry[] = [];
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('hung-read', 'read', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(10, 3) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
      ],
    });
    const never = new Promise<never>(() => undefined);
    const turn = new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([definition('read')], async () => never),
    }).runTurn(
      input({
        limits: { maxDurationMs: 100 },
        onEntry: (entry) => entries.push(entry),
      }),
    );

    await waitUntil(
      () => entries.some((entry) => entry.event.type === 'tool_execution_started'),
      'read tool did not start',
    );
    clock.advanceBy(100);
    const result = await turn;

    expect(result.state.status).toBe('budget_exceeded');
    expect(result.messages.slice(-2).map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(result.messages[result.messages.length - 1]).toMatchObject({
      role: 'tool',
      content: [
        {
          callId: 'hung-read',
          ok: false,
          content: 'maxDurationMs reached: 100',
        },
      ],
    });
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('waits for an entered write to settle before publishing a deadline terminal', async () => {
    const clock = new ManualAgentClock();
    let releaseWrite: () => void = () => undefined;
    const heldWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const order: string[] = [];
    const entries: AgentRuntimeJournalEntry[] = [];
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('held-write', 'write', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(5, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
      ],
    });
    const turn = new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([definition('write', 'write')], async () => {
        await heldWrite;
        order.push('write-effect');
        return { ok: true, data: 'committed' };
      }),
    }).runTurn(
      input({
        limits: { maxDurationMs: 100 },
        onEntry: (entry) => {
          entries.push(entry);
          if (entry.event.type === 'turn_finished') order.push('terminal');
        },
      }),
    );
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    await waitUntil(
      () => entries.some((entry) => entry.event.type === 'tool_execution_started'),
      'write did not enter its mutation phase',
    );
    clock.advanceBy(100);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(settled).toBe(false);
    expect(order).toEqual([]);
    releaseWrite();
    const result = await turn;

    expect(result.state.status).toBe('budget_exceeded');
    expect(order).toEqual(['write-effect', 'terminal']);
    expect(result.state.tools['held-write']?.result).toMatchObject({ ok: true });
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('does not label an already-committed write as failed when its receipt is too large', async () => {
    const clock = new ManualAgentClock();
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: 'receipt-is-too-large',
    }));
    const driver = new ScriptedFakeDriver({
      rounds: [
        {
          steps: [
            ...toolCallSteps('write-1', 'write', ['{}']),
            { op: 'emit', event: { type: 'usage', usage: usage(10, 3) } },
            { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
          ],
        },
        {
          expectRequest: (request) => {
            expect(request.messages[2]).toMatchObject({
              role: 'tool',
              content: [{ callId: 'write-1', ok: true }],
            });
          },
          steps: [
            { op: 'emit', event: { type: 'text_delta', text: 'write committed' } },
            { op: 'emit', event: { type: 'usage', usage: usage(10, 2) } },
            { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
          ],
        },
      ],
    });
    const result = await new AgentRuntime({
      driver,
      clock,
      tools: toolRuntime([definition('write', 'write')], execute),
    }).runTurn(input({ limits: { maxToolResultBytes: 8 } }));

    const toolResult = result.entries.find((entry) => entry.event.type === 'tool_result');
    expect(toolResult?.event).toMatchObject({
      type: 'tool_result',
      ok: true,
      source: 'runtime',
      errorCode: 'TOOL_RESULT_TOO_LARGE',
    });
    expect(result.state.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
    driver.assertExhausted();
    clock.assertIdle();
  });

  it.each([
    {
      label: 'missing usage',
      steps: [
        { op: 'emit', event: { type: 'text_delta', text: 'unmetered' } },
        { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
      ] satisfies ScriptedDriverStep[],
      failureCode: 'PROTOCOL_VIOLATION',
    },
    {
      label: 'unknown stop reason',
      steps: [
        { op: 'emit', event: { type: 'usage', usage: usage(1, 1) } },
        { op: 'emit', event: { type: 'finish', reason: 'unknown' } },
      ] satisfies ScriptedDriverStep[],
      failureCode: 'MODEL_ERROR',
    },
  ])('fails closed for $label', async ({ steps, failureCode }) => {
    const clock = new ManualAgentClock();
    const driver = new ScriptedFakeDriver({ rounds: [{ steps }] });
    const result = await new AgentRuntime({ driver, clock }).runTurn(input());

    expect(result.state.terminal).toMatchObject({
      outcome: 'failed',
      failureCode,
    });
    driver.assertExhausted();
    clock.assertIdle();
  });

  it('never journals a raw provider exception and redacts declared public errors', async () => {
    const canary = 'sk-ant-secret-canary';
    for (const providerError of [
      new Error(`Authorization: Bearer raw-token ${canary}`),
      new AgentModelDriverError(`Rate limited; Authorization: Bearer public-token; key=${canary}`),
    ]) {
      const clock = new ManualAgentClock();
      const driver = new ScriptedFakeDriver({
        rounds: [{ steps: [{ op: 'throw', error: providerError }] }],
      });
      const result = await new AgentRuntime({ driver, clock }).runTurn(
        input({ turnId: `turn-error-${providerError.name}` }),
      );
      const serialized = JSON.stringify(result.entries);

      expect(result.state.status).toBe('failed');
      expect(serialized).not.toContain('raw-token');
      expect(serialized).not.toContain('public-token');
      expect(serialized).not.toContain(canary);
      if (providerError instanceof AgentModelDriverError) {
        expect(result.state.terminal?.message).toContain('Rate limited');
        expect(result.state.terminal?.message).toContain('[REDACTED]');
      } else {
        expect(result.state.terminal?.message).toBe('Model driver failed');
      }
      driver.assertExhausted();
      clock.assertIdle();
    }
  });

  it('accepts 1000 deterministic fragmentations of the same tool JSON', async () => {
    const raw = JSON.stringify({
      query: 'Alice',
      limit: 12,
      nested: { exact: true, tags: ['canon', 'chapter'] },
    });

    for (let seed = 1; seed <= 1_000; seed += 1) {
      let state = seed >>> 0;
      const chunks: string[] = [];
      for (let offset = 0; offset < raw.length; ) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        const length = Math.min(1 + (state % 7), raw.length - offset);
        chunks.push(raw.slice(offset, offset + length));
        offset += length;
      }

      let received: Record<string, unknown> | null = null;
      const clock = new ManualAgentClock();
      const callId = `call-${seed}`;
      const driver = new ScriptedFakeDriver({
        rounds: [
          {
            steps: [
              ...toolCallSteps(callId, 'lookup', chunks),
              { op: 'emit', event: { type: 'usage', usage: usage(1, 1) } },
              { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
            ],
          },
          {
            steps: [
              { op: 'emit', event: { type: 'usage', usage: usage(1, 1) } },
              { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
            ],
          },
        ],
      });
      const runtime = new AgentRuntime({
        driver,
        clock,
        tools: toolRuntime([definition('lookup')], async (request) => {
          received = request.arguments;
          return { ok: true, data: 'ok' };
        }),
      });

      const result = await runtime.runTurn(input({ turnId: `turn-${seed}` }));
      expect(received).toEqual(JSON.parse(raw));
      expect(result.state.status).toBe('completed');
      expect(
        result.entries.filter((entry) => entry.event.type === 'tool_args_delta'),
      ).toHaveLength(1);
      expect(replayAgentRuntimeJournal(result.entries)).toEqual(result.state);
      driver.assertExhausted();
      clock.assertIdle();
    }
  }, 20_000);
});
