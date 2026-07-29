import { describe, expect, it, vi } from 'vitest';
import { AgentModelDriverError } from './errors';
import { replayAgentRuntimeJournal } from './reducer';
import { AgentRuntime } from './runtime';
import {
  ManualAgentClock,
  ScriptedFakeDriver,
  type ScriptedDriverStep,
} from './testing';
import type {
  AgentRuntimeJournalEntry,
  AgentRuntimeRunInput,
  AgentRuntimeUsage,
  AgentToolDefinition,
  AgentToolRuntime,
} from './types';

const ROUTE = { kind: 'test', projectId: 'project-1' } as const;

function usage(
  inputTokens: number,
  outputTokens: number,
  costUsd = 0,
): AgentRuntimeUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  };
}

function input(
  overrides: Partial<AgentRuntimeRunInput> = {},
): AgentRuntimeRunInput {
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

async function waitUntil(
  predicate: () => boolean,
  message: string,
  turns = 1_000,
): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

describe('AgentRuntime', () => {
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
            ...toolCallSteps('call-1', 'lookup', [
              '{"query":',
              '"Alice",',
              '"limit":"2"}',
            ]),
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
          (entry): entry is AgentRuntimeJournalEntry & {
            event: Extract<
              AgentRuntimeJournalEntry['event'],
              { type: 'tool_result' }
            >;
          } => entry.event.type === 'tool_result',
        )
        .map((entry) => entry.event.errorCode),
    ).toEqual([
      'MALFORMED_TOOL_ARGUMENTS',
      'UNKNOWN_TOOL',
      'INVALID_TOOL_ARGUMENTS',
    ]);
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
    expect(result.messages.slice(-2).map((message) => message.role)).toEqual([
      'assistant',
      'tool',
    ]);
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
      new AgentModelDriverError(
        `Rate limited; Authorization: Bearer public-token; key=${canary}`,
      ),
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

      const result = await runtime.runTurn(
        input({ turnId: `turn-${seed}` }),
      );
      expect(received).toEqual(JSON.parse(raw));
      expect(result.state.status).toBe('completed');
      expect(replayAgentRuntimeJournal(result.entries)).toEqual(result.state);
      driver.assertExhausted();
      clock.assertIdle();
    }
  });
});
