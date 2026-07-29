import { describe, expect, it, vi } from 'vitest';
import { LocalGeneralAgentTransport } from './local-transport';
import { AgentRuntime, buildAgentToolSearchQuery } from './runtime';
import type {
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStreamEvent,
  AgentRuntimeRunInput,
  AgentToolDefinition,
  AgentToolRuntime,
  AgentToolSelectionRequest,
  AgentToolSelectionStrategy,
} from './types';

const ROUTE = { kind: 'test', projectId: 'project-1' } as const;
const USAGE: AgentModelStreamEvent = {
  type: 'usage',
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  },
};

function definition(name: string): AgentToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', additionalProperties: false },
    access: 'read',
    validateInput: (value) => ({ ok: true, value }),
  };
}

function toolRuntime(
  definitions: readonly AgentToolDefinition[],
  execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
    ok: true,
    data: 'ok',
  })),
): AgentToolRuntime {
  return {
    listDefinitions: () => definitions,
    execute,
  };
}

class RecordingDriver implements AgentModelDriver {
  readonly id = 'recording';
  readonly requests: AgentModelRequest[] = [];

  constructor(
    private readonly script: (request: AgentModelRequest) => readonly AgentModelStreamEvent[],
  ) {}

  async *stream(request: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
    this.requests.push(request);
    for (const event of this.script(request)) yield event;
  }
}

function endTurn(text = 'done'): readonly AgentModelStreamEvent[] {
  return [{ type: 'text_delta', text }, USAGE, { type: 'finish', reason: 'end_turn' }];
}

function toolCall(callId: string, name: string): readonly AgentModelStreamEvent[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_args_delta', callId, delta: '{}' },
    { type: 'tool_call_end', callId },
    USAGE,
    { type: 'finish', reason: 'tool_use' },
  ];
}

function runInput(overrides: Partial<AgentRuntimeRunInput>): AgentRuntimeRunInput {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    route: ROUTE,
    prompt: 'read the chapter',
    ...overrides,
  };
}

describe('AgentRuntime tool search integration', () => {
  it('keeps the full explicit tool surface when search is off', async () => {
    const definitions = Array.from({ length: 12 }, (_, index) => definition(`tool_${index}`));
    const select = vi.fn<AgentToolSelectionStrategy['select']>(() => ['tool_0']);
    const driver = new RecordingDriver(() => endTurn());
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: { select },
    });

    await runtime.runTurn(runInput({ toolSearch: 'off' }));

    expect(select).not.toHaveBeenCalled();
    expect(driver.requests[0]?.tools.map((tool) => tool.name)).toEqual(
      definitions.map((tool) => tool.name),
    );
  });

  it('searches in auto only above eight definitions, and always searches in on mode', async () => {
    for (const testCase of [
      { mode: 'auto' as const, count: 8, expectedCalls: 0, expectedTools: 8 },
      { mode: 'auto' as const, count: 9, expectedCalls: 1, expectedTools: 1 },
      { mode: 'on' as const, count: 2, expectedCalls: 1, expectedTools: 1 },
    ]) {
      const definitions = Array.from({ length: testCase.count }, (_, index) =>
        definition(`tool_${index}`),
      );
      const select = vi.fn<AgentToolSelectionStrategy['select']>(() => ['tool_0']);
      const driver = new RecordingDriver(() => endTurn());
      const runtime = new AgentRuntime({
        driver,
        tools: toolRuntime(definitions),
        toolSelector: { select },
      });

      await runtime.runTurn(
        runInput({
          turnId: `turn-${testCase.mode}-${testCase.count}`,
          toolSearch: testCase.mode,
        }),
      );

      expect(select).toHaveBeenCalledTimes(testCase.expectedCalls);
      expect(driver.requests[0]?.tools).toHaveLength(testCase.expectedTools);
    }
  });

  it('reselects each iteration and rejects a call omitted from that iteration schema', async () => {
    const definitions = [
      definition('read_node'),
      definition('search_prose'),
      ...Array.from({ length: 7 }, (_, index) => definition(`other_${index}`)),
    ];
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => ({
      ok: true,
      data:
        request.name === 'read_node'
          ? 'The result suggests using search_prose next.'
          : 'unexpected',
    }));
    const selections: AgentToolSelectionRequest[] = [];
    const selector: AgentToolSelectionStrategy = {
      select(request) {
        selections.push(request);
        return request.iteration === 1 ? ['read_node'] : ['search_prose'];
      },
    };
    const driver = new RecordingDriver((request) => {
      if (request.iteration === 1) return toolCall('call-1', 'read_node');
      if (request.iteration === 2) return toolCall('call-2', 'read_node');
      return endTurn();
    });
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions, execute),
      toolSelector: selector,
    });

    const result = await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(selections).toHaveLength(3);
    expect(selections[1]?.query).toContain('search_prose next');
    expect(driver.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ['read_node'],
      ['search_prose'],
      ['search_prose'],
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].name).toBe('read_node');
    expect(
      result.entries.some(
        (entry) =>
          entry.event.type === 'tool_result' &&
          entry.event.callId === 'call-2' &&
          entry.event.errorCode === 'UNKNOWN_TOOL',
      ),
    ).toBe(true);
  });

  it('fails closed when a selector exceeds the hard limit or returns a non-executable name', async () => {
    for (const selected of [
      Array.from({ length: 9 }, (_, index) => `tool_${index}`),
      ['not_executable'],
    ]) {
      const driver = new RecordingDriver(() => endTurn());
      const runtime = new AgentRuntime({
        driver,
        tools: toolRuntime(Array.from({ length: 9 }, (_, index) => definition(`tool_${index}`))),
        toolSelector: { select: () => selected },
      });

      const result = await runtime.runTurn(
        runInput({
          turnId: `turn-invalid-${selected[0]}`,
          toolSearch: 'on',
        }),
      );

      expect(result.state.status).toBe('failed');
      expect(result.state.terminal?.failureCode).toBe('INTERNAL_ERROR');
      expect(driver.requests).toHaveLength(0);
    }
  });

  it('builds the same bounded query from the original request and four recent non-thinking messages', () => {
    const messages: AgentModelMessage[] = [
      { role: 'assistant', content: [{ type: 'thinking', text: 'secret' }] },
      ...Array.from(
        { length: 6 },
        (_, index): AgentModelMessage => ({
          role: 'tool',
          content: [
            {
              callId: `call-${index}`,
              name: `tool_${index}`,
              ok: true,
              content: `${index}:${'x'.repeat(2_000)}`,
            },
          ],
        }),
      ),
    ];
    const prompt = `中文原始请求${'p'.repeat(4_000)}`;

    const first = buildAgentToolSearchQuery(prompt, messages);
    const second = buildAgentToolSearchQuery(prompt, messages);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(4_096);
    expect(first).toContain('中文原始请求');
    expect(first).not.toContain('secret');
    expect(first).not.toContain('tool_0');
    expect(first).not.toContain('tool_1');
    expect(first).toContain('tool_5');
  });

  it('forwards AgentStartInput.toolSearch through the local transport', async () => {
    const select = vi.fn<AgentToolSelectionStrategy['select']>(() => ['read_node']);
    const driver = new RecordingDriver(() => endTurn());
    const transport = new LocalGeneralAgentTransport({
      driver,
      tools: toolRuntime([definition('read_node')]),
      toolSelector: { select },
      createId: (kind) => `${kind}-id`,
    });
    const done = new Promise<void>((resolve) => {
      transport.subscribeEvents(({ event }) => {
        if (event.type === 'done') resolve();
      });
    });

    const started = await transport.start({
      prompt: '读取章节',
      route: { kind: 'chat', projectId: 'project-1' },
      toolSearch: 'on',
    });
    await done;

    expect(started.ok).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
    expect(driver.requests[0]?.tools.map((tool) => tool.name)).toEqual(['read_node']);
  });
});
