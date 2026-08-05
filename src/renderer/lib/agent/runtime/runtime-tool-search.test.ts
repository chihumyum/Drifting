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

function definition(
  name: string,
  access: AgentToolDefinition['access'] = 'read',
): AgentToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', additionalProperties: false },
    access,
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
  return toolCallWithArguments(callId, name, '{}');
}

function toolCallWithArguments(
  callId: string,
  name: string,
  argumentsJson: string,
): readonly AgentModelStreamEvent[] {
  return [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_args_delta', callId, delta: argumentsJson },
    { type: 'tool_call_end', callId },
    USAGE,
    { type: 'finish', reason: 'tool_use' },
  ];
}

function toolCalls(
  calls: readonly { callId: string; name: string }[],
): readonly AgentModelStreamEvent[] {
  return [
    ...calls.flatMap(({ callId, name }) => [
      { type: 'tool_call_start' as const, callId, name },
      { type: 'tool_args_delta' as const, callId, delta: '{}' },
      { type: 'tool_call_end' as const, callId },
    ]),
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

  it('reloads durable selection hints before every searched iteration', async () => {
    const definitions = [definition('read_node')];
    const selections: AgentToolSelectionRequest[] = [];
    let hintLoad = 0;
    const tools: AgentToolRuntime = {
      ...toolRuntime(definitions),
      loadSelectionHints: vi.fn(async () => {
        hintLoad += 1;
        return {
          longTask: {
            status: hintLoad === 1 ? ('active' as const) : ('blocked' as const),
            scopeKind: 'whole_book_chapters' as const,
            objective: '逐章润色整本小说',
          },
        };
      }),
    };
    const driver = new RecordingDriver((request) =>
      request.iteration === 1 ? toolCall('read-1', 'read_node') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools,
      toolSelector: {
        select(request) {
          selections.push(request);
          return ['read_node'];
        },
      },
    });

    const result = await runtime.runTurn(runInput({ prompt: '继续。', toolSearch: 'on' }));
    expect(result.state.status).toBe('completed');
    expect(tools.loadSelectionHints).toHaveBeenCalledTimes(2);
    expect(selections.map((selection) => selection.hints.longTask?.status)).toEqual([
      'active',
      'blocked',
    ]);
    expect(selections[0]?.hints.longTask).toEqual({
      status: 'active',
      scopeKind: 'whole_book_chapters',
      objective: '逐章润色整本小说',
    });
  });

  it('leases an omitted installed tool into the next iteration for one repair attempt', async () => {
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
      if (request.iteration === 3) return toolCall('call-3', 'read_node');
      return endTurn();
    });
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions, execute),
      toolSelector: selector,
    });

    const result = await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(selections).toHaveLength(4);
    expect(selections[1]?.query).toContain('search_prose next');
    expect(selections[1]?.successfulReadNamesSinceLastWrite).toEqual(['read_node']);
    expect(selections[2]?.successfulReadNamesSinceLastWrite).toEqual(['read_node']);
    expect(selections[3]?.successfulReadNamesSinceLastWrite).toEqual(['read_node']);
    expect(selections.map((selection) => selection.successfulReadNamesInPreviousBatch)).toEqual([
      [],
      ['read_node'],
      [],
      ['read_node'],
    ]);
    expect(selections.map((selection) => selection.pendingResultPage)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(selections.map((selection) => selection.repairToolNames)).toEqual([
      [],
      [],
      ['read_node'],
      [],
    ]);
    expect(driver.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ['read_node'],
      ['search_prose'],
      ['read_node', 'search_prose'],
      ['search_prose'],
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0].name).toBe('read_node');
    expect(execute.mock.calls[1]?.[0].name).toBe('read_node');
    expect(
      result.entries.some(
        (entry) =>
          entry.event.type === 'tool_result' &&
          entry.event.callId === 'call-2' &&
          entry.event.errorCode === 'UNKNOWN_TOOL',
      ),
    ).toBe(true);
    expect(result.state.status).toBe('completed');
  });

  it('leases a schema-invalid tool until corrected arguments execute successfully', async () => {
    const requiredRead: AgentToolDefinition = {
      ...definition('read_node'),
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      validateInput: (value) =>
        typeof value.path === 'string' && value.path.length > 0
          ? { ok: true, value }
          : { ok: false, error: 'path is required' },
    };
    const definitions = [
      requiredRead,
      definition('search_prose'),
      ...Array.from({ length: 7 }, (_, index) => definition(`other_${index}`)),
    ];
    const selections: AgentToolSelectionRequest[] = [];
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: 'chapter',
    }));
    const driver = new RecordingDriver((request) => {
      if (request.iteration === 1) return toolCall('invalid', 'read_node');
      if (request.iteration === 2) {
        return toolCallWithArguments('repaired', 'read_node', '{"path":"/chapters/00/prose.md"}');
      }
      return endTurn();
    });
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions, execute),
      toolSelector: {
        select(request) {
          selections.push(request);
          return request.iteration === 1 ? ['read_node'] : ['search_prose'];
        },
      },
    });

    const result = await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(result.state.status).toBe('completed');
    expect(selections.map((selection) => selection.repairToolNames)).toEqual([
      [],
      ['read_node'],
      [],
    ]);
    expect(driver.requests[1]?.tools.map((tool) => tool.name)).toEqual([
      'read_node',
      'search_prose',
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      name: 'read_node',
      arguments: { path: '/chapters/00/prose.md' },
    });
  });

  it('does not lease a truly unknown hallucinated tool', async () => {
    const definitions = [
      definition('search_prose'),
      ...Array.from({ length: 8 }, (_, index) => definition(`other_${index}`)),
    ];
    const selections: AgentToolSelectionRequest[] = [];
    const driver = new RecordingDriver((request) =>
      request.iteration === 1 ? toolCall('unknown', 'delete_the_universe') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: {
        select(request) {
          selections.push(request);
          return ['search_prose'];
        },
      },
    });

    const result = await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(result.state.status).toBe('completed');
    expect(selections.map((selection) => selection.repairToolNames)).toEqual([[], []]);
    expect(driver.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ['search_prose'],
      ['search_prose'],
    ]);
  });

  it('normalizes an executable legacy dispatcher alias before validation and execution', async () => {
    const definitions = [
      definition('read_node'),
      ...Array.from({ length: 8 }, (_, index) => definition(`other_${index}`)),
    ];
    const execute = vi.fn<AgentToolRuntime['execute']>(async () => ({
      ok: true,
      data: 'ok',
    }));
    const tools: AgentToolRuntime = {
      listDefinitions: () => definitions,
      resolveCanonicalName: (name) => (name === 'legacy_read_node' ? 'read_node' : undefined),
      execute,
    };
    const driver = new RecordingDriver((request) =>
      request.iteration === 1 ? toolCall('legacy', 'legacy_read_node') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools,
      toolSelector: { select: () => ['read_node'] },
    });

    const result = await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(result.state.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'read_node' }));
    expect(
      result.entries.some(
        (entry) => entry.event.type === 'tool_call_started' && entry.event.name === 'read_node',
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

  it('invalidates accumulated successful read coverage after a successful write', async () => {
    const definitions = [
      definition('read_node'),
      definition('rename_node', 'write'),
      ...Array.from({ length: 7 }, (_, index) => definition(`other_${index}`)),
    ];
    const selections: AgentToolSelectionRequest[] = [];
    const selector: AgentToolSelectionStrategy = {
      select(request) {
        selections.push(request);
        if (request.iteration === 1) return ['read_node'];
        if (request.iteration === 2) return ['rename_node'];
        return ['read_node'];
      },
    };
    const driver = new RecordingDriver((request) => {
      if (request.iteration === 1) return toolCall('read-1', 'read_node');
      if (request.iteration === 2) return toolCall('write-1', 'rename_node');
      return endTurn();
    });
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: selector,
    });

    await runtime.runTurn(runInput({ toolSearch: 'auto' }));

    expect(selections.map((selection) => selection.successfulReadNamesSinceLastWrite)).toEqual([
      [],
      ['read_node'],
      [],
    ]);
    expect(selections.map((selection) => selection.successfulReadNamesInPreviousBatch)).toEqual([
      [],
      ['read_node'],
      [],
    ]);
  });

  it('keeps the full tool surface through a long research chain before mutation', async () => {
    const definitions = [definition('read_node'), definition('edit_node', 'write')];
    const driver = new RecordingDriver((request) => {
      if (request.iteration <= 12) {
        return toolCall(`read-${request.iteration}`, 'read_node');
      }
      if (request.iteration === 13) return toolCall('write-1', 'edit_node');
      return endTurn();
    });
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: { select: () => ['read_node', 'edit_node'] },
    });

    await runtime.runTurn(
      runInput({
        prompt: '把开头几章收拾顺并修正问题',
        systemPrompt: 'base policy',
        toolSearch: 'on',
      }),
    );

    expect(driver.requests).toHaveLength(14);
    expect(
      driver.requests.every(
        (request) =>
          !request.context.systemPrompt.includes('Runtime action checkpoint') &&
          request.executionMode === undefined &&
          request.toolChoice === 'auto' &&
          request.tools.map((tool) => tool.name).join(',') === 'read_node,edit_node',
      ),
    ).toBe(true);
    expect(
      JSON.stringify(driver.requests.map((request) => request.context.messages)),
    ).not.toContain('drifting_runtime_action_checkpoint');
  });

  it('does not reprompt or constrain a mutation request after the model ends naturally', async () => {
    const definitions = [definition('read_node'), definition('edit_node', 'write')];
    const driver = new RecordingDriver(() => endTurn('I am done.'));
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: { select: () => ['read_node', 'edit_node'] },
    });

    const result = await runtime.runTurn(
      runInput({
        prompt: '继续把剩下的收尾。',
        systemPrompt: 'base policy',
        toolSearch: 'on',
        reasoning: { enabled: true },
      }),
    );

    expect(result.state.status).toBe('completed');
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.reasoning).toEqual({ enabled: true });
    expect(driver.requests[0]?.executionMode).toBeUndefined();
    expect(driver.requests[0]?.toolChoice).toBe('auto');
    expect(driver.requests[0]?.tools.map((tool) => tool.name)).toEqual(['read_node', 'edit_node']);
  });

  it('honors a selector-required orchestration tool without disabling model reasoning', async () => {
    const definitions = [definition('update_task_plan', 'write'), definition('read_node')];
    const driver = new RecordingDriver((request) =>
      request.iteration === 1 ? toolCall('plan-1', 'update_task_plan') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: {
        select: () => ['update_task_plan', 'read_node'],
        forceTool: (request) => (request.iteration === 1 ? 'update_task_plan' : null),
      },
    });

    await runtime.runTurn(
      runInput({
        prompt: '整理开头六章，做完别停。',
        systemPrompt: 'base policy',
        toolSearch: 'on',
        reasoning: { enabled: true },
      }),
    );

    expect(driver.requests[0]?.toolChoice).toEqual({ force: 'update_task_plan' });
    expect(driver.requests[0]?.reasoning).toEqual({ enabled: true });
    expect(driver.requests[0]?.executionMode).toBeUndefined();
    expect(driver.requests[1]?.toolChoice).toBe('auto');
  });

  it('never nudges a read-only request toward mutation', async () => {
    const definitions = [definition('read_node'), definition('edit_node', 'write')];
    const driver = new RecordingDriver((request) =>
      request.iteration <= 9 ? toolCall(`read-${request.iteration}`, 'read_node') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: { select: () => ['read_node', 'edit_node'] },
    });

    await runtime.runTurn(
      runInput({
        prompt: '只阅读并分析这些章节，不要修改任何内容',
        systemPrompt: 'base policy',
        toolSearch: 'on',
        reasoning: { enabled: true },
      }),
    );

    expect(
      driver.requests.every(
        (request) => !request.context.systemPrompt.includes('Runtime action checkpoint'),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(driver.requests.map((request) => request.context.messages)),
    ).not.toContain('drifting_runtime_action_checkpoint');
    expect(driver.requests.every((request) => request.reasoning?.enabled === true)).toBe(true);
    expect(driver.requests.every((request) => request.toolChoice === 'auto')).toBe(true);
  });

  it('inherits read-only intent for a terse continuation', async () => {
    const definitions = [definition('read_node'), definition('edit_node', 'write')];
    const driver = new RecordingDriver((request) =>
      request.iteration <= 9 ? toolCall(`read-${request.iteration}`, 'read_node') : endTurn(),
    );
    const runtime = new AgentRuntime({
      driver,
      tools: toolRuntime(definitions),
      toolSelector: { select: () => ['read_node', 'edit_node'] },
    });

    await runtime.runTurn(
      runInput({
        prompt: '继续。',
        history: [
          { role: 'user', content: '只阅读并分析这些章节，不要修改任何内容' },
          { role: 'assistant', content: [{ type: 'text', text: '分析结果' }] },
        ],
        systemPrompt: 'base policy',
        toolSearch: 'on',
        reasoning: { enabled: true },
      }),
    );

    expect(
      driver.requests.every(
        (request) => !request.context.systemPrompt.includes('Runtime action checkpoint'),
      ),
    ).toBe(true);
    expect(driver.requests.every((request) => request.reasoning?.enabled === true)).toBe(true);
    expect(driver.requests.every((request) => request.toolChoice === 'auto')).toBe(true);
  });

  it('opens and closes structured result paging for one resultRef', async () => {
    const definitions = [definition('list_nodes'), definition('read_tool_result')];
    const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => ({
      ok: true,
      data: {
        result:
          request.name === 'list_nodes'
            ? {
                truncated: true,
                resultRef: 'agent-result:1',
                reread: {
                  tool: 'read_tool_result',
                  arguments: {
                    resultRef: 'agent-result:1',
                    offset: 10,
                    limit: 10,
                  },
                },
              }
            : {
                truncated: false,
                resultRef: 'agent-result:1',
                content: 'final page',
              },
        freshness: {
          receiptId: `receipt:${request.callId}`,
          observations: [],
        },
      },
    }));
    const selections: AgentToolSelectionRequest[] = [];
    const selector: AgentToolSelectionStrategy = {
      select(request) {
        selections.push(request);
        if (request.iteration === 1) return ['list_nodes'];
        if (request.iteration === 2) return ['read_tool_result'];
        return [];
      },
    };
    const driver = new RecordingDriver((request) => {
      if (request.iteration === 1) {
        return toolCall('list-1', 'list_nodes');
      }
      if (request.iteration === 2) {
        return toolCall('page-1', 'read_tool_result');
      }
      return endTurn('all pages read');
    });

    const result = await new AgentRuntime({
      driver,
      tools: toolRuntime(definitions, execute),
      toolSelector: selector,
    }).runTurn(runInput({ toolSearch: 'on' }));

    expect(result.state.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(selections.map((selection) => selection.pendingResultPage)).toEqual([
      false,
      true,
      false,
    ]);
    expect(selections.map((selection) => selection.successfulReadNamesInPreviousBatch)).toEqual([
      [],
      ['list_nodes'],
      ['read_tool_result'],
    ]);
  });

  it.each([
    {
      secondIterationCalls: [
        { callId: 'page-b-open', name: 'read_tool_result' },
        { callId: 'page-a-done', name: 'read_tool_result' },
      ],
    },
    {
      secondIterationCalls: [
        { callId: 'page-a-done', name: 'read_tool_result' },
        { callId: 'page-b-open', name: 'read_tool_result' },
      ],
    },
  ])(
    'keeps paging open for every pending resultRef regardless of page call order',
    async ({ secondIterationCalls }) => {
      const definitions = [
        definition('list_nodes'),
        definition('list_elements'),
        definition('read_tool_result'),
      ];
      const pageByCallId: Record<string, { resultRef: string; truncated: boolean }> = {
        'initial-a': { resultRef: 'agent-result:a', truncated: true },
        'initial-b': { resultRef: 'agent-result:b', truncated: true },
        'page-a-done': { resultRef: 'agent-result:a', truncated: false },
        'page-b-open': { resultRef: 'agent-result:b', truncated: true },
        'page-b-done': { resultRef: 'agent-result:b', truncated: false },
      };
      const execute = vi.fn<AgentToolRuntime['execute']>(async (request) => {
        const page = pageByCallId[request.callId];
        if (!page) throw new Error(`Unexpected call ${request.callId}`);
        return {
          ok: true,
          data: {
            result: {
              ...page,
              ...(page.truncated
                ? {
                    reread: {
                      tool: 'read_tool_result',
                      arguments: { resultRef: page.resultRef },
                    },
                  }
                : {}),
            },
          },
        };
      });
      const selections: AgentToolSelectionRequest[] = [];
      const selector: AgentToolSelectionStrategy = {
        select(request) {
          selections.push(request);
          return request.iteration === 1 ? ['list_nodes', 'list_elements'] : ['read_tool_result'];
        },
      };
      const driver = new RecordingDriver((request) => {
        if (request.iteration === 1) {
          return toolCalls([
            { callId: 'initial-a', name: 'list_nodes' },
            { callId: 'initial-b', name: 'list_elements' },
          ]);
        }
        if (request.iteration === 2) {
          return toolCalls(secondIterationCalls);
        }
        if (request.iteration === 3) {
          return toolCall('page-b-done', 'read_tool_result');
        }
        return endTurn('all result refs complete');
      });

      const result = await new AgentRuntime({
        driver,
        tools: toolRuntime(definitions, execute),
        toolSelector: selector,
      }).runTurn(runInput({ toolSearch: 'on' }));

      expect(result.state.status, JSON.stringify(result.state.terminal)).toBe('completed');
      expect(selections.map((selection) => selection.pendingResultPage)).toEqual([
        false,
        true,
        true,
        false,
      ]);
    },
  );

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
    expect(first).toContain('tool success tool_5');
    expect(first).toContain('tool_5');
  });

  it('uses the restored substantive author request as the tool-search anchor on a bare continuation', () => {
    const messages: AgentModelMessage[] = [
      {
        role: 'user',
        content: '第十章和第十一章接起来有点生硬。整体收拾顺一点，摘要也跟上。',
      },
      { role: 'user', content: '继续把刚才的任务做完。' },
    ];

    const query = buildAgentToolSearchQuery('继续把刚才的任务做完。', messages);

    expect(query).toContain(
      'original request:\n第十章和第十一章接起来有点生硬。整体收拾顺一点，摘要也跟上。',
    );
    expect(query).not.toContain('original request:\n继续把刚才的任务做完。');
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
