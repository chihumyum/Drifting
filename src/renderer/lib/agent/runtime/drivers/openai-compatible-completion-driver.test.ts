import { describe, expect, it } from 'vitest';
import {
  MALFORMED_STREAMED_TOOL_ARGUMENTS_CODE,
  MISSING_REASONING_TOOL_CALL_CODE,
} from '../../../ai/client/llm-client';
import {
  AIError,
  type AICompletionChunk,
  type AICompletionRequest,
  type AICompletionResponse,
} from '../../../ai/types';
import { AgentModelDriverError, publicModelDriverErrorMessage } from '../errors';
import type { AgentModelMessage, AgentModelRequest, AgentModelStreamEvent } from '../types';
import {
  type AgentCompletionClient,
  OpenAICompatibleCompletionDriver,
} from './openai-compatible-completion-driver';

class FakeCompletionClient implements AgentCompletionClient {
  readonly requests: AICompletionRequest[] = [];

  constructor(
    private readonly run: (
      request: AICompletionRequest,
    ) => AICompletionResponse | Promise<AICompletionResponse>,
    readonly supportsTools = true,
  ) {}

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    this.requests.push(request);
    return this.run(request);
  }
}

class FakeStreamingClient implements AgentCompletionClient {
  readonly supportsTools = true;
  readonly requests: AICompletionRequest[] = [];
  completeCalls = 0;

  constructor(
    private readonly chunks:
      | readonly AICompletionChunk[]
      | ((request: AICompletionRequest) => AsyncIterable<AICompletionChunk>),
    readonly supportsToolStreaming = true,
  ) {}

  async complete(): Promise<AICompletionResponse> {
    this.completeCalls += 1;
    throw new Error('completion fallback must not run');
  }

  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionChunk> {
    this.requests.push(request);
    if (typeof this.chunks === 'function') {
      yield* this.chunks(request);
      return;
    }
    for (const chunk of this.chunks) yield chunk;
  }
}

function modelContext(
  messages: readonly AgentModelMessage[],
  systemPrompt = 'system',
): AgentModelRequest['context'] {
  return {
    systemPrompt,
    messages: messages.map((message, index) => ({
      type: 'model_message',
      sourceIds: [`test/model-message/${index}`],
      message,
    })),
  };
}

function request(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    iteration: 1,
    context: modelContext([{ role: 'user', content: 'hello' }]),
    tools: [
      {
        name: 'read_node',
        description: 'Read one node',
        inputSchema: {
          type: 'object',
          properties: { node: { type: 'string' } },
          required: ['node'],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  driver: OpenAICompatibleCompletionDriver,
  input: AgentModelRequest,
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of driver.stream(input)) events.push(event);
  return events;
}

describe('OpenAICompatibleCompletionDriver', () => {
  it('forwards a forced completion-tool choice to the provider contract', async () => {
    const client = new FakeCompletionClient(() => ({
      text: 'fallback',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await collect(driver, request({ toolChoice: { force: 'read_node' } }));

    expect(client.requests[0]?.toolChoice).toEqual({ force: 'read_node' });
  });

  it('serializes one required action without mutating the frozen reasoning tuple', async () => {
    const client = new FakeCompletionClient(() => ({
      text: 'fallback',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
      reasoningMode: 'deepseek',
    });

    await collect(
      driver,
      request({
        reasoning: { enabled: true, effort: 'high' },
        executionMode: 'required_tool_non_reasoning',
        toolChoice: 'required',
      }),
    );

    expect(client.requests[0]).toMatchObject({
      thinking: false,
      toolChoice: 'required',
      terminalRequirements: { finishReason: true, usage: true },
    });
    expect(client.requests[0]).not.toHaveProperty('reasoningEffort');
  });

  it('restores configured reasoning behind a provider boundary after one non-reasoning action', async () => {
    let providerCall = 0;
    const client = new FakeStreamingClient((_request) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        providerCall += 1;
        if (providerCall === 1) {
          yield {
            delta: '',
            toolCallDeltas: [
              {
                index: 0,
                id: 'forced-without-reasoning',
                nameDelta: 'read_node',
                argumentsDelta: '{"node":"A"}',
              },
            ],
          };
          yield { delta: '', finishReason: 'tool_calls' };
          yield { delta: '', usage: { inputTokens: 5, outputTokens: 2 } };
          return;
        }
        yield { delta: providerCall === 2 ? 'same turn done' : 'new turn done' };
        yield { delta: '', finishReason: 'stop' };
        yield { delta: '', usage: { inputTokens: 7, outputTokens: 2 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-flash',
      reasoningMode: 'deepseek',
    });

    await collect(
      driver,
      request({
        reasoning: { enabled: true, effort: 'max' },
        executionMode: 'required_tool_non_reasoning',
        toolChoice: { force: 'read_node' },
      }),
    );
    await collect(
      driver,
      request({
        iteration: 2,
        reasoning: { enabled: true, effort: 'max' },
        context: modelContext([
          { role: 'user', content: 'inspect' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'forced-without-reasoning',
                name: 'read_node',
                arguments: { node: 'A' },
                rawArguments: '{"node":"A"}',
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                callId: 'forced-without-reasoning',
                name: 'read_node',
                ok: true,
                content: 'A',
              },
            ],
          },
        ]),
      }),
    );
    await collect(
      driver,
      request({
        turnId: 'turn-2',
        reasoning: { enabled: true, effort: 'max' },
        tools: [],
        context: modelContext([{ role: 'user', content: 'new request' }]),
      }),
    );

    expect(client.requests[0]).toMatchObject({
      thinking: false,
      toolChoice: { force: 'read_node' },
    });
    expect(client.requests[1]).toMatchObject({
      thinking: true,
      reasoningEffort: 'max',
      terminalRequirements: {
        finishReason: true,
        usage: true,
        reasoningContentForToolCalls: true,
      },
    });
    expect(client.requests[1]?.messages).toContainEqual({
      role: 'model',
      content: '',
      toolCalls: [
        {
          id: 'forced-without-reasoning',
          name: 'read_node',
          arguments: { node: 'A' },
        },
      ],
    });
    const recoveryBoundary = client.requests[1]?.messages.find((message) => {
      if (message.role !== 'user') return false;
      try {
        return JSON.parse(message.content).type === 'drifting_runtime_reasoning_resume';
      } catch {
        return false;
      }
    });
    expect(JSON.parse(recoveryBoundary?.content ?? '{}')).toMatchObject({
      type: 'drifting_runtime_reasoning_resume',
      recoveredCallIds: ['forced-without-reasoning'],
    });
    expect(client.requests[1]?.messages.indexOf(recoveryBoundary!)).toBeGreaterThan(
      client.requests[1]?.messages.findIndex(
        (message) =>
          message.role === 'tool' && message.toolCallId === 'forced-without-reasoning',
      ) ?? -1,
    );
    expect(client.requests[2]).toMatchObject({
      thinking: true,
      reasoningEffort: 'max',
    });
  });

  it('projects the required verified context into the completion request', async () => {
    const client = new FakeCompletionClient(() => ({
      text: 'answer',
      usage: { inputTokens: 12, outputTokens: 3, cachedTokens: 5 },
      raw: { choices: [{ finish_reason: 'stop' }] },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });
    const input = request({ model: 'deepseek-v4-flash' });

    await expect(collect(driver, input)).resolves.toEqual([
      { type: 'text_delta', text: 'answer' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'end_turn' },
    ]);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toEqual({
      model: 'deepseek-v4-flash',
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'read_node',
          description: 'Read one node',
          parametersSchema: input.tools[0]!.inputSchema,
        },
      ],
      maxOutputTokens: 512,
      thinking: false,
      terminalRequirements: {
        finishReason: true,
        usage: true,
      },
      toolChoice: 'auto',
      signal: input.signal,
      metadata: {
        feature: 'general-agent',
        agentSessionId: 'session-1',
        agentTurnId: 'turn-1',
        agentIteration: 1,
      },
    });
  });

  it('uses only planned context and labels summaries/notes with runtime provenance', async () => {
    const client = new FakeCompletionClient(() => ({
      text: 'planned answer',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await collect(
      driver,
      request({
        context: {
          systemPrompt: 'verified planned system',
          messages: [
            {
              type: 'model_message',
              sourceIds: ['model/message/0/user/0/user'],
              message: { role: 'user', content: 'planned user' },
            },
            {
              type: 'context_summary',
              summaryId: 'summary-1',
              sourceIds: ['model/message/1/assistant/0/text'],
              sourceHash: 'sha256:summary-source',
              content: 'verified older context',
            },
            {
              type: 'context_note',
              noteKind: 'freshness',
              sourceId: 'freshness/node-1',
              turnOrdinal: null,
              content: '{"nodeId":"node-1","revision":"r1"}',
            },
          ],
        },
      }),
    );

    expect(client.requests).toHaveLength(1);
    const sent = client.requests[0]!;
    expect(sent.system).toBe('verified planned system');
    expect(sent.messages[0]).toEqual({
      role: 'user',
      content: 'planned user',
    });
    expect(sent.messages).toHaveLength(3);
    const summary = JSON.parse(sent.messages[1]!.content);
    expect(summary).toEqual({
      type: 'drifting_verified_context_summary',
      provenance: {
        origin: 'drifting_runtime',
        summaryId: 'summary-1',
        sourceCount: 1,
        sourceHash: 'sha256:summary-source',
      },
      content: 'verified older context',
    });
    const note = JSON.parse(sent.messages[2]!.content);
    expect(note).toEqual({
      type: 'drifting_verified_context_note',
      provenance: {
        origin: 'drifting_runtime',
        noteKind: 'freshness',
        sourceId: 'freshness/node-1',
        turnOrdinal: null,
      },
      content: '{"nodeId":"node-1","revision":"r1"}',
    });
  });

  it('fails closed for invalid planned context', async () => {
    const client = new FakeCompletionClient(() => ({
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(
      collect(
        driver,
        request({
          context: {
            systemPrompt: 'verified system',
            messages: [
              {
                type: 'context_summary',
                summaryId: '',
                sourceIds: [],
                sourceHash: '',
                content: '',
              },
            ],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AgentModelDriverError);
    expect(client.requests).toHaveLength(0);
  });

  it('preserves denied call/result topology from a planned projection', async () => {
    const client = new FakeCompletionClient(() => ({
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await collect(
      driver,
      request({
        context: {
          systemPrompt: 'verified system',
          messages: [
            {
              type: 'model_message',
              sourceIds: ['model/message/0/user/0/user'],
              message: { role: 'user', content: 'try missing tool' },
            },
            {
              type: 'model_message',
              sourceIds: ['model/message/1/assistant/0/tool_call'],
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_call',
                    callId: 'denied-call',
                    name: 'missing_tool',
                    arguments: {},
                    rawArguments: '{}',
                  },
                ],
              },
            },
            {
              type: 'model_message',
              sourceIds: ['model/message/2/tool/0/tool_result'],
              message: {
                role: 'tool',
                content: [
                  {
                    callId: 'denied-call',
                    name: 'missing_tool',
                    ok: false,
                    content: 'Unknown tool "missing_tool"',
                    source: 'runtime',
                    errorCode: 'UNKNOWN_TOOL',
                  },
                ],
              },
            },
            {
              type: 'model_message',
              sourceIds: ['model/message/3/assistant/0/text'],
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'recovered' }],
              },
            },
          ],
        },
      }),
    );

    expect(client.requests[0]?.messages).toEqual([
      { role: 'user', content: 'try missing tool' },
      {
        role: 'model',
        content: '',
        toolCalls: [
          {
            id: 'denied-call',
            name: 'missing_tool',
            arguments: {},
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'denied-call',
        content: 'Tool failed: Unknown tool "missing_tool"',
      },
      { role: 'model', content: 'recovered' },
    ]);
  });

  it('projects assistant blocks and expands tool-result batches into AI messages', async () => {
    const client = new FakeCompletionClient(() => ({
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await collect(
      driver,
      request({
        context: modelContext([
          { role: 'user', content: 'inspect' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will ' },
              {
                type: 'tool_call',
                callId: 'call-old',
                name: 'read_node',
                arguments: { node: 'Chapter 1' },
                rawArguments: '{"node":"Chapter 1"}',
              },
              { type: 'text', text: 'inspect it.' },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                callId: 'call-old',
                name: 'read_node',
                ok: true,
                content: '{"title":"Chapter 1"}',
              },
              {
                callId: 'call-error',
                name: 'read_element',
                ok: false,
                content: 'not found',
              },
            ],
          },
        ]),
      }),
    );

    expect(client.requests[0]?.messages).toEqual([
      { role: 'user', content: 'inspect' },
      {
        role: 'model',
        content: 'I will inspect it.',
        toolCalls: [
          {
            id: 'call-old',
            name: 'read_node',
            arguments: { node: 'Chapter 1' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-old',
        content: '{"title":"Chapter 1"}',
      },
      {
        role: 'tool',
        toolCallId: 'call-error',
        content: 'Tool failed: not found',
      },
    ]);
  });

  it('normalizes multiple completion tool calls into canonical events', async () => {
    const client = new FakeCompletionClient(() => ({
      text: 'checking',
      toolCalls: [
        { id: 'call-a', name: 'read_node', arguments: { node: 'A' } },
        { id: 'call-b', name: 'read_element', arguments: { element: 'B' } },
      ],
      usage: { inputTokens: 10, outputTokens: 6 },
      raw: { choices: [{ finish_reason: 'tool_calls' }] },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).resolves.toEqual([
      { type: 'text_delta', text: 'checking' },
      { type: 'tool_call_start', callId: 'call-a', name: 'read_node' },
      {
        type: 'tool_args_delta',
        callId: 'call-a',
        delta: '{"node":"A"}',
      },
      { type: 'tool_call_end', callId: 'call-a' },
      {
        type: 'tool_call_start',
        callId: 'call-b',
        name: 'read_element',
      },
      {
        type: 'tool_args_delta',
        callId: 'call-b',
        delta: '{"element":"B"}',
      },
      { type: 'tool_call_end', callId: 'call-b' },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 6,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'tool_use' },
    ]);
  });

  it('streams visible text and parallel fragmented tool calls before terminal usage', async () => {
    const client = new FakeStreamingClient([
      { delta: '先看' },
      {
        delta: '一下。',
        toolCallDeltas: [
          {
            index: 0,
            id: 'call-a',
            nameDelta: 'read_',
          },
          {
            index: 1,
            id: 'call-b',
            nameDelta: 'search_',
          },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 0,
            nameDelta: 'node',
            argumentsDelta: '{"node":',
          },
          {
            index: 1,
            nameDelta: 'project',
            argumentsDelta: '{"query":',
          },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          { index: 1, argumentsDelta: '"遗物"}' },
          { index: 0, argumentsDelta: '"第一章"}' },
        ],
      },
      { delta: '', finishReason: 'tool_calls' },
      {
        delta: '',
        usage: { inputTokens: 21, outputTokens: 9, cachedTokens: 4 },
      },
    ]);
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(
      collect(
        driver,
        request({
          tools: [
            request().tools[0]!,
            {
              name: 'search_project',
              description: 'Search the project',
              inputSchema: { type: 'object' },
            },
          ],
        }),
      ),
    ).resolves.toEqual([
      { type: 'text_delta', text: '先看一下。' },
      {
        type: 'tool_call_start',
        callId: 'call-a',
        name: 'read_node',
      },
      {
        type: 'tool_args_delta',
        callId: 'call-a',
        delta: '{"node":',
      },
      {
        type: 'tool_call_start',
        callId: 'call-b',
        name: 'search_project',
      },
      {
        type: 'tool_args_delta',
        callId: 'call-b',
        delta: '{"query":"遗物"}',
      },
      {
        type: 'tool_args_delta',
        callId: 'call-a',
        delta: '"第一章"}',
      },
      { type: 'tool_call_end', callId: 'call-a' },
      { type: 'tool_call_end', callId: 'call-b' },
      {
        type: 'usage',
        usage: {
          inputTokens: 21,
          outputTokens: 9,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'tool_use' },
    ]);
    expect(client.completeCalls).toBe(0);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.tools?.[0]?.name).toBe('read_node');
  });

  it('preserves canonical index order when a later parallel call arrives first', async () => {
    const client = new FakeStreamingClient([
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 1,
            id: 'call-b',
            nameDelta: 'search_project',
            argumentsDelta: '{"query":"B"}',
          },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 0,
            id: 'call-a',
            nameDelta: 'read_node',
            argumentsDelta: '{"node":"A"}',
          },
        ],
      },
      {
        delta: '',
        finishReason: 'tool_calls',
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    const events = await collect(
      driver,
      request({
        tools: [
          request().tools[0]!,
          {
            name: 'search_project',
            description: 'Search the project',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );
    expect(
      events.filter((event) => event.type === 'tool_call_start').map((event) => event.callId),
    ).toEqual(['call-a', 'call-b']);
    expect(
      events.filter((event) => event.type === 'tool_call_end').map((event) => event.callId),
    ).toEqual(['call-a', 'call-b']);
  });

  it('delivers the first streamed delta before the provider terminal gate opens', async () => {
    let releaseTerminal: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const firstDeltaSeen = new Promise<void>((resolve) => {
      const client = new FakeStreamingClient(async function* () {
        yield { delta: 'first' };
        await terminal;
        yield {
          delta: '',
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 1 },
        };
      });
      const driver = new OpenAICompatibleCompletionDriver({
        client,
        defaultModel: 'deepseek-chat',
      });
      const iterator = driver.stream(request({ tools: [] }))[Symbol.asyncIterator]();
      void iterator.next().then((result) => {
        expect(result.value).toEqual({
          type: 'text_delta',
          text: 'first',
        });
        resolve();
        releaseTerminal?.();
        void iterator.return?.();
      });
    });

    await firstDeltaSeen;
  });

  it('does not strand a second text delta behind a quiet provider terminal', async () => {
    let releaseTerminal: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const client = new FakeStreamingClient(async function* () {
      yield { delta: 'first' };
      yield { delta: 'second' };
      await terminal;
      yield {
        delta: '',
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    });
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });
    const iterator = driver.stream(request({ tools: [] }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'text_delta', text: 'first' },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'text_delta', text: 'second' },
    });
    releaseTerminal?.();
    await iterator.return?.();
  });

  it('streams synthesis text even when the provider cannot stream tools', async () => {
    const client = new FakeStreamingClient(
      [
        { delta: 'streamed' },
        {
          delta: '',
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ],
      false,
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'text-stream-provider',
    });

    await expect(collect(driver, request({ tools: [] }))).resolves.toEqual([
      { type: 'text_delta', text: 'streamed' },
      {
        type: 'usage',
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'end_turn' },
    ]);
    expect(client.completeCalls).toBe(0);
  });

  it('fails closed on incomplete streamed tool identity without using completion fallback', async () => {
    const client = new FakeStreamingClient([
      {
        delta: '',
        toolCallDeltas: [{ index: 0, argumentsDelta: '{"node":"A"}' }],
      },
      {
        delta: '',
        finishReason: 'tool_calls',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).rejects.toMatchObject({
      publicMessage: 'Model provider returned an invalid tool stream.',
    });
    expect(client.completeCalls).toBe(0);
  });

  it.each(['length', 'content_filter'] as const)(
    'never closes or executes a streamed tool call terminated by %s',
    async (finishReason) => {
      const client = new FakeStreamingClient([
        {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'call-a',
              nameDelta: 'read_node',
              argumentsDelta: '{"node":"A"}',
            },
          ],
        },
        {
          delta: '',
          finishReason,
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ]);
      const driver = new OpenAICompatibleCompletionDriver({
        client,
        defaultModel: 'deepseek-chat',
      });
      const emitted: AgentModelStreamEvent[] = [];

      await expect(
        (async () => {
          for await (const event of driver.stream(request())) emitted.push(event);
        })(),
      ).rejects.toBeInstanceOf(AgentModelDriverError);
      expect(emitted.some((event) => event.type === 'tool_call_end')).toBe(false);
      expect(emitted.some((event) => event.type === 'finish')).toBe(false);
    },
  );

  it('fails a streamed completion that omits finish reason', async () => {
    const client = new FakeStreamingClient([
      { delta: 'partial' },
      {
        delta: '',
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    ]);
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request({ tools: [] }))).rejects.toMatchObject({
      publicMessage: 'Model provider stream ended without a finish reason.',
    });
  });

  it('resamples a malformed tool stream transactionally before any Agent event escapes', async () => {
    let attempt = 0;
    const client = new FakeStreamingClient((_request) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        attempt += 1;
        if (attempt === 1) {
          yield { delta: '', thinkingDelta: 'discarded reasoning' };
          yield {
            delta: '',
            toolCallDeltas: [
              {
                index: 0,
                id: 'discarded-call',
                nameDelta: 'read_node',
                argumentsDelta: '{"node":"unterminated',
              },
            ],
          };
          throw new AIError('parse', 'raw malformed payload must stay private');
        }
        yield { delta: '', thinkingDelta: 'valid reasoning' };
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'valid-call',
              nameDelta: 'read_node',
              argumentsDelta: '{"node":"第一章"}',
            },
          ],
        };
        yield { delta: '', finishReason: 'tool_calls' };
        yield { delta: '', usage: { inputTokens: 5, outputTokens: 3 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
      reasoningMode: 'deepseek',
      providerAttemptRetry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    const events = await collect(
      driver,
      request({ reasoning: { enabled: true, effort: 'medium' } }),
    );

    expect(client.requests).toHaveLength(2);
    expect(client.requests.map((sent) => sent.metadata?.agentProviderAttempt)).toEqual([1, 2]);
    expect(events).toContainEqual({
      type: 'tool_call_start',
      callId: 'valid-call',
      name: 'read_node',
    });
    expect(events.some((event) => 'callId' in event && event.callId === 'discarded-call')).toBe(
      false,
    );
    expect(
      events.some(
        (event) => event.type === 'thinking_delta' && event.text === 'discarded reasoning',
      ),
    ).toBe(false);
  });

  it('coalesces a successful transactional reasoning replay before publishing journal events', async () => {
    const client = new FakeStreamingClient((_request) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        for (let index = 0; index < 2_000; index += 1) {
          yield { delta: '', thinkingDelta: `reasoning-${index};` };
        }
        yield { delta: 'I will inspect it. ' };
        yield { delta: 'Now.' };
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'valid-call',
              nameDelta: 'read_node',
              argumentsDelta: '{"node":',
            },
          ],
        };
        yield {
          delta: '',
          toolCallDeltas: [{ index: 0, argumentsDelta: '"第一章"}' }],
        };
        yield { delta: '', finishReason: 'tool_calls' };
        yield { delta: '', usage: { inputTokens: 5, outputTokens: 3 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
      reasoningMode: 'deepseek',
    });

    const events = await collect(driver, request({ reasoning: { enabled: true } }));

    const thinking = events.filter((event) => event.type === 'thinking_delta');
    const text = events.filter((event) => event.type === 'text_delta');
    const argumentDeltas = events.filter((event) => event.type === 'tool_args_delta');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      text: expect.stringContaining('reasoning-1999;'),
    });
    expect(text).toEqual([{ type: 'text_delta', text: 'I will inspect it. Now.' }]);
    expect(argumentDeltas).toEqual([
      {
        type: 'tool_args_delta',
        callId: 'valid-call',
        delta: '{"node":"第一章"}',
      },
    ]);
  });

  it('resamples a reasoning-only max-token sample and immediately asks for one concrete action', async () => {
    let attempt = 0;
    const client = new FakeStreamingClient((sent) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        attempt += 1;
        if (attempt === 1) {
          yield {
            delta: '',
            thinkingDelta: 'discarded overlong planning attempt 1',
          };
          yield { delta: '', finishReason: 'length' };
          yield { delta: '', usage: { inputTokens: 100, outputTokens: 512 } };
          return;
        }
        if (attempt === 2) {
          expect(sent.thinking).toBe(false);
          expect(sent.toolChoice).toBe('required');
          yield { delta: 'incomplete action serialization' };
          yield { delta: '', finishReason: 'length' };
          yield { delta: '', usage: { inputTokens: 105, outputTokens: 512 } };
          return;
        }
        const recovery = JSON.parse(sent.messages[sent.messages.length - 1]?.content ?? '{}');
        expect(recovery).toMatchObject({
          type: 'drifting_runtime_provider_retry',
          cause: 'previous_sample_exhausted_output_before_action',
          retryAttempt: 3,
          discardedPlanningExcerpt: 'discarded overlong planning attempt 1',
        });
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'recovered-call',
              nameDelta: 'read_node',
              argumentsDelta: '{"node":"第一章"}',
            },
          ],
        };
        yield { delta: '', finishReason: 'tool_calls' };
        yield { delta: '', usage: { inputTokens: 110, outputTokens: 8 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
      reasoningMode: 'deepseek',
      providerAttemptRetry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    const events = await collect(driver, request({ reasoning: { enabled: true } }));

    expect(client.requests).toHaveLength(3);
    expect(client.requests[0]?.thinking).toBe(true);
    expect(client.requests.slice(1).every((sent) => sent.thinking === false)).toBe(true);
    expect(client.requests.slice(1).every((sent) => sent.toolChoice === 'required')).toBe(true);
    expect(
      client.requests
        .slice(1)
        .every(
          (sent) =>
            sent.terminalRequirements?.finishReason === true &&
            sent.terminalRequirements?.usage === true &&
            sent.terminalRequirements?.reasoningContentForToolCalls === undefined,
        ),
    ).toBe(true);
    expect(client.requests.every((sent) => sent.reasoningEffort === undefined)).toBe(true);
    const firstRetry = JSON.parse(
      client.requests[1]!.messages[client.requests[1]!.messages.length - 1]?.content ?? '{}',
    );
    const secondRetry = JSON.parse(
      client.requests[2]!.messages[client.requests[2]!.messages.length - 1]?.content ?? '{}',
    );
    expect(firstRetry).toMatchObject({
      retryAttempt: 2,
      discardedPlanningExcerpt: 'discarded overlong planning attempt 1',
    });
    expect(secondRetry.instruction).toBe(firstRetry.instruction);
    expect(
      events.some(
        (event) =>
          event.type === 'thinking_delta' &&
          event.text.includes('discarded overlong planning attempt'),
      ),
    ).toBe(false);
    expect(events).toContainEqual({
      type: 'tool_call_start',
      callId: 'recovered-call',
      name: 'read_node',
    });
  });

  it('returns discarded private planning to the next reasoning-enabled iteration', async () => {
    let attempt = 0;
    const client = new FakeStreamingClient((sent) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        attempt += 1;
        if (attempt === 1) {
          yield { delta: '', thinkingDelta: 'inspect A, then edit B and verify C' };
          yield { delta: '', finishReason: 'length' };
          yield { delta: '', usage: { inputTokens: 10, outputTokens: 512 } };
          return;
        }
        if (attempt === 2) {
          expect(sent.thinking).toBe(false);
          yield {
            delta: '',
            toolCallDeltas: [
              {
                index: 0,
                id: 'recovered-inspect',
                nameDelta: 'read_node',
                argumentsDelta: '{"node":"A"}',
              },
            ],
          };
          yield { delta: '', finishReason: 'tool_calls' };
          yield { delta: '', usage: { inputTokens: 12, outputTokens: 3 } };
          return;
        }
        expect(sent.thinking).toBe(true);
        const boundary = sent.messages.find((message) => {
          if (message.role !== 'user') return false;
          try {
            return JSON.parse(message.content).type === 'drifting_runtime_reasoning_resume';
          } catch {
            return false;
          }
        });
        expect(JSON.parse(boundary?.content ?? '{}')).toMatchObject({
          recoveredCallIds: ['recovered-inspect'],
          recoveredPlanningExcerpt: 'inspect A, then edit B and verify C',
        });
        yield { delta: '', thinkingDelta: 'use the recovered plan' };
        yield { delta: 'done' };
        yield { delta: '', finishReason: 'stop' };
        yield { delta: '', usage: { inputTokens: 16, outputTokens: 4 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-flash',
      reasoningMode: 'deepseek',
      providerAttemptRetry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    await collect(driver, request({ reasoning: { enabled: true } }));
    const resumed = await collect(
      driver,
      request({
        iteration: 2,
        reasoning: { enabled: true },
        context: modelContext([
          { role: 'user', content: 'do the work' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'recovered-inspect',
                name: 'read_node',
                arguments: { node: 'A' },
                rawArguments: '{"node":"A"}',
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                callId: 'recovered-inspect',
                name: 'read_node',
                ok: true,
                content: 'A contents',
              },
            ],
          },
        ]),
      }),
    );

    expect(client.requests).toHaveLength(3);
    expect(resumed).toContainEqual({ type: 'thinking_delta', text: 'use the recovered plan' });
  });

  it('resamples a remembered but unavailable tool against the exact recovery catalog', async () => {
    let attempt = 0;
    const client = new FakeStreamingClient((sent) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        attempt += 1;
        if (attempt === 1) {
          yield {
            delta: '',
            toolCallDeltas: [
              {
                index: 0,
                id: 'discarded-read',
                nameDelta: 'read_node',
                argumentsDelta: '{"node":"A"}',
              },
            ],
          };
          yield { delta: '', finishReason: 'tool_calls' };
          yield { delta: '', usage: { inputTokens: 7, outputTokens: 2 } };
          return;
        }
        const recovery = JSON.parse(sent.messages[sent.messages.length - 1]?.content ?? '{}');
        expect(recovery).toMatchObject({
          type: 'drifting_runtime_provider_retry',
          cause: 'previous_sample_called_unavailable_tool',
          retryAttempt: 2,
          availableTools: ['edit_node'],
        });
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'accepted-edit',
              nameDelta: 'edit_node',
              argumentsDelta: '{"node":"A"}',
            },
          ],
        };
        yield { delta: '', finishReason: 'tool_calls' };
        yield { delta: '', usage: { inputTokens: 8, outputTokens: 2 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-flash',
      reasoningMode: 'deepseek',
      providerAttemptRetry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    const events = await collect(
      driver,
      request({
        reasoning: { enabled: true },
        executionMode: 'required_tool_non_reasoning',
        toolChoice: 'required',
        tools: [
          {
            name: 'edit_node',
            description: 'Edit one node',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );

    expect(client.requests).toHaveLength(2);
    expect(client.requests.every((sent) => sent.thinking === false)).toBe(true);
    expect(
      events.some((event) => event.type === 'tool_call_start' && event.callId === 'discarded-read'),
    ).toBe(false);
    expect(events).toContainEqual({
      type: 'tool_call_start',
      callId: 'accepted-edit',
      name: 'edit_node',
    });
  });

  it('recovers a malformed-malformed-length sequence with a smaller action call', async () => {
    let attempt = 0;
    const client = new FakeStreamingClient((sent) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        attempt += 1;
        if (attempt <= 2) {
          throw new AIError('parse', 'Model provider returned malformed streamed tool arguments.', {
            code: MALFORMED_STREAMED_TOOL_ARGUMENTS_CODE,
            cause: new SyntaxError('private malformed payload'),
          });
        }
        if (attempt === 3) {
          const recovery = JSON.parse(sent.messages[sent.messages.length - 1]?.content ?? '{}');
          expect(recovery).toMatchObject({
            cause: 'previous_sample_malformed_tool_arguments',
            availableTools: ['edit_node'],
          });
          expect(sent.thinking).toBe(false);
          expect(sent.toolChoice).toBe('required');
          yield { delta: '', thinkingDelta: 'discarded oversized plan' };
          yield { delta: '', finishReason: 'length' };
          yield { delta: '', usage: { inputTokens: 20, outputTokens: 512 } };
          return;
        }
        const recovery = JSON.parse(sent.messages[sent.messages.length - 1]?.content ?? '{}');
        expect(recovery).toMatchObject({
          cause: 'previous_sample_exhausted_output_before_action',
          retryAttempt: 4,
          discardedPlanningExcerpt: 'discarded oversized plan',
        });
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'small-valid-edit',
              nameDelta: 'edit_node',
              argumentsDelta: '{"node":"A"}',
            },
          ],
        };
        yield { delta: '', finishReason: 'tool_calls' };
        yield { delta: '', usage: { inputTokens: 21, outputTokens: 3 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-flash',
      reasoningMode: 'deepseek',
      providerAttemptRetry: {
        maxAttempts: 4,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    const events = await collect(
      driver,
      request({
        reasoning: { enabled: true, effort: 'max' },
        tools: [
          {
            name: 'edit_node',
            description: 'Edit one node',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );

    expect(client.requests).toHaveLength(4);
    expect(client.requests[0]?.thinking).toBe(true);
    expect(client.requests.slice(1).every((sent) => sent.thinking === false)).toBe(true);
    expect(events).toContainEqual({
      type: 'tool_call_start',
      callId: 'small-valid-edit',
      name: 'edit_node',
    });
  });

  it('resamples a tool call that omits required DeepSeek reasoning content', async () => {
    let attempt = 0;
    const client = new FakeStreamingClient((sent) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        attempt += 1;
        if (attempt === 1) {
          throw new AIError(
            'parse',
            'Model provider returned a tool call without reasoning content.',
            { code: MISSING_REASONING_TOOL_CALL_CODE },
          );
        }
        expect(sent.thinking).toBe(false);
        expect(sent.toolChoice).toBe('required');
        expect(JSON.parse(sent.messages[sent.messages.length - 1]?.content ?? '{}')).toMatchObject({
          type: 'drifting_runtime_provider_retry',
          cause: 'previous_sample_omitted_required_reasoning_content',
          availableTools: expect.arrayContaining(['read_node']),
        });
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: `call-${attempt}`,
              nameDelta: 'read_node',
              argumentsDelta: '{"node":"第一章"}',
            },
          ],
        };
        yield { delta: '', finishReason: 'tool_calls' };
        yield { delta: '', usage: { inputTokens: 5, outputTokens: 3 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
      reasoningMode: 'deepseek',
      providerAttemptRetry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });

    const events = await collect(
      driver,
      request({ reasoning: { enabled: true, effort: 'medium' } }),
    );

    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.thinking).toBe(true);
    expect(events.some((event) => 'callId' in event && event.callId === 'call-1')).toBe(false);
    expect(events).toContainEqual({
      type: 'tool_call_start',
      callId: 'call-2',
      name: 'read_node',
    });
  });

  it.each(['network', 'rate-limit'] as const)(
    'resamples a transient %s failure before a tool-capable attempt escapes',
    async (kind) => {
      let attempt = 0;
      const client = new FakeStreamingClient((_request) =>
        (async function* (): AsyncIterable<AICompletionChunk> {
          attempt += 1;
          if (attempt === 1) throw new AIError(kind, 'private transient detail');
          yield { delta: 'recovered' };
          yield { delta: '', finishReason: 'stop' };
          yield { delta: '', usage: { inputTokens: 4, outputTokens: 1 } };
        })(),
      );
      const driver = new OpenAICompatibleCompletionDriver({
        client,
        defaultModel: 'deepseek-chat',
        providerAttemptRetry: {
          maxAttempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: false,
        },
      });

      await expect(collect(driver, request())).resolves.toContainEqual({
        type: 'text_delta',
        text: 'recovered',
      });
      expect(client.requests).toHaveLength(2);
    },
  );

  it('fails once the bounded invalid-response lease is exhausted without publishing partial events', async () => {
    const client = new FakeStreamingClient((_request) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        yield { delta: '', thinkingDelta: 'discard me' };
        throw new AIError('parse', 'private malformed response');
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
      providerAttemptRetry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    });
    const emitted: AgentModelStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of driver.stream(request())) emitted.push(event);
      })(),
    ).rejects.toMatchObject({
      publicMessage: 'Model provider returned an invalid response.',
    });
    expect(client.requests).toHaveLength(3);
    expect(emitted).toEqual([]);
  });

  it('does not retry authentication or an author cancellation', async () => {
    for (const failure of ['auth', 'aborted'] as const) {
      const controller = new AbortController();
      const client = new FakeStreamingClient((_request) =>
        (async function* (): AsyncIterable<AICompletionChunk> {
          if (failure === 'aborted') controller.abort('author stopped');
          yield* [];
          throw new AIError(failure, 'private provider detail');
        })(),
      );
      const driver = new OpenAICompatibleCompletionDriver({
        client,
        defaultModel: 'deepseek-chat',
        providerAttemptRetry: {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitter: false,
        },
      });

      await expect(collect(driver, request({ signal: controller.signal }))).rejects.toBeInstanceOf(
        AgentModelDriverError,
      );
      expect(client.requests).toHaveLength(1);
    }
  });

  it('rejects a completion tool call whose provider finish reason is not tool_calls', async () => {
    const client = new FakeCompletionClient(() => ({
      toolCall: {
        id: 'call-a',
        name: 'read_node',
        arguments: { node: 'A' },
      },
      usage: { inputTokens: 2, outputTokens: 1 },
      raw: { choices: [{ finish_reason: 'length' }] },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).rejects.toMatchObject({
      publicMessage: 'Model provider returned an invalid tool completion.',
    });
  });

  it.each([
    ['length', 'max_tokens'],
    ['content_filter', 'content_filter'],
    ['unexpected', 'unknown'],
  ] as const)('maps finish_reason %s to %s', async (finishReason, expected) => {
    const client = new FakeCompletionClient(() => ({
      usage: { inputTokens: 1, outputTokens: 2 },
      raw: { choices: [{ finish_reason: finishReason }] },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    const events = await collect(driver, request({ tools: [] }));
    expect(events[events.length - 1]).toEqual({
      type: 'finish',
      reason: expected,
    });
  });

  it('rejects reasoning explicitly instead of silently dropping it', async () => {
    const client = new FakeCompletionClient(() => ({
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(
      collect(driver, request({ reasoning: { enabled: true, effort: 'high' } })),
    ).rejects.toMatchObject({
      name: 'AgentModelDriverError',
      publicMessage: 'Reasoning is not supported by the General Agent driver.',
    });
    expect(client.requests).toHaveLength(0);
  });

  it('preserves DeepSeek reasoning_content across active-turn tool iterations', async () => {
    let call = 0;
    const client = new FakeStreamingClient((_request) =>
      (async function* (): AsyncIterable<AICompletionChunk> {
        call += 1;
        if (call === 1) {
          yield { delta: '', thinkingDelta: 'inspect first' };
          yield {
            delta: '',
            toolCallDeltas: [
              {
                index: 0,
                id: 'call-thinking',
                nameDelta: 'read_node',
                argumentsDelta: '{"node":"A"}',
              },
            ],
          };
          yield { delta: '', finishReason: 'tool_calls' };
          yield { delta: '', usage: { inputTokens: 5, outputTokens: 3 } };
          return;
        }
        yield { delta: 'done' };
        yield { delta: '', finishReason: 'stop' };
        yield { delta: '', usage: { inputTokens: 8, outputTokens: 2 } };
      })(),
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-pro',
      reasoningMode: 'deepseek',
    });

    const first = await collect(driver, request({ reasoning: { enabled: true, effort: 'max' } }));
    expect(first).toContainEqual({ type: 'thinking_delta', text: 'inspect first' });
    expect(client.requests[0]).toMatchObject({
      thinking: true,
      reasoningEffort: 'max',
    });

    await collect(
      driver,
      request({
        iteration: 2,
        reasoning: { enabled: true, effort: 'max' },
        context: modelContext([
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'inspect first' },
              {
                type: 'tool_call',
                callId: 'call-thinking',
                name: 'read_node',
                arguments: { node: 'A' },
                rawArguments: '{"node":"A"}',
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                callId: 'call-thinking',
                name: 'read_node',
                ok: true,
                content: '{"title":"A"}',
              },
            ],
          },
        ]),
      }),
    );
    expect(client.requests[1]?.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'model',
        content: '',
        reasoningContent: 'inspect first',
        toolCalls: [
          {
            id: 'call-thinking',
            name: 'read_node',
            arguments: { node: 'A' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-thinking',
        content: '{"title":"A"}',
      },
    ]);
  });

  it('does not require stale reasoning replay after a compacted user boundary', async () => {
    const client = new FakeStreamingClient([
      { delta: 'continue' },
      { delta: '', finishReason: 'stop' },
      { delta: '', usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-pro',
      reasoningMode: 'deepseek',
    });

    await expect(
      collect(
        driver,
        request({
          iteration: 5,
          reasoning: { enabled: true, effort: 'high' },
          tools: [],
          context: {
            systemPrompt: 'system',
            messages: [
              {
                type: 'model_message',
                sourceIds: ['old-user'],
                message: { role: 'user', content: 'old request' },
              },
              {
                type: 'model_message',
                sourceIds: ['old-call'],
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_call',
                      callId: 'call-before-compaction',
                      name: 'read_node',
                      arguments: { node: 'A' },
                      rawArguments: '{"node":"A"}',
                    },
                  ],
                },
              },
              {
                type: 'context_summary',
                summaryId: 'summary-after-call',
                sourceIds: ['old-result'],
                sourceHash: 'sha256:old-result',
                content: 'The old read was compacted.',
              },
            ],
          },
        }),
      ),
    ).resolves.toContainEqual({ type: 'finish', reason: 'end_turn' });
  });

  it('still rejects a missing replay inside the active exact tool loop', async () => {
    const client = new FakeStreamingClient([]);
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-v4-pro',
      reasoningMode: 'deepseek',
    });

    await expect(
      collect(
        driver,
        request({
          iteration: 2,
          reasoning: { enabled: true, effort: 'high' },
          context: modelContext([
            { role: 'user', content: 'inspect' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'missing-replay',
                  name: 'read_node',
                  arguments: { node: 'A' },
                  rawArguments: '{"node":"A"}',
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  callId: 'missing-replay',
                  name: 'read_node',
                  ok: true,
                  content: 'A',
                },
              ],
            },
          ]),
        }),
      ),
    ).rejects.toMatchObject({
      publicMessage: 'DeepSeek reasoning replay state is unavailable for the active tool loop.',
    });
    expect(client.requests).toHaveLength(0);
  });

  it('rejects non-empty reasoning history on the P1 path', async () => {
    const client = new FakeCompletionClient(() => ({
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(
      collect(
        driver,
        request({
          context: modelContext([
            {
              role: 'assistant',
              content: [{ type: 'thinking', text: 'opaque reasoning' }],
            },
          ]),
        }),
      ),
    ).rejects.toBeInstanceOf(AgentModelDriverError);
    expect(client.requests).toHaveLength(0);
  });

  it('fails closed when the configured LLM client cannot thread tools', async () => {
    const client = new FakeCompletionClient(
      () => ({ usage: { inputTokens: 0, outputTokens: 0 } }),
      false,
    );
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).rejects.toMatchObject({
      publicMessage: 'The configured model provider does not support agent tools.',
    });
    expect(client.requests).toHaveLength(0);
  });

  it('never exposes raw provider errors or credentials', async () => {
    const rawMessage =
      'Authorization: Bearer sk-live-secret api_key=also-secret https://provider.invalid/private';
    const client = new FakeCompletionClient(() => {
      throw new AIError('auth', rawMessage, {
        headers: { authorization: 'Bearer sk-live-secret' },
      });
    });
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    let caught: unknown;
    try {
      await collect(driver, request());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentModelDriverError);
    const publicMessage = publicModelDriverErrorMessage(caught);
    expect(publicMessage).toBe('Model provider authentication failed.');
    expect(publicMessage).not.toContain('sk-live-secret');
    expect(publicMessage).not.toContain('provider.invalid');
    expect(JSON.stringify(caught)).not.toContain(rawMessage);
  });

  it('also hides raw messages from non-AIError failures', async () => {
    const client = new FakeCompletionClient(() => {
      throw new Error('fetch https://provider.invalid?api_key=sk-generic-secret failed');
    });
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).rejects.toMatchObject({
      name: 'AgentModelDriverError',
      publicMessage: 'Model provider request failed.',
    });
  });

  it('fails closed when a provider tool call has no stable id', async () => {
    const client = new FakeCompletionClient(() => ({
      toolCalls: [{ name: 'read_node', arguments: { node: 'A' } }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).rejects.toMatchObject({
      publicMessage: 'Model provider returned a tool call without a tool call id.',
    });
  });

  it('rejects malformed provider tool calls without leaking their payload', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const client = new FakeCompletionClient(() => ({
      toolCalls: [{ id: 'call-a', name: 'read_node', arguments: circular }],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const driver = new OpenAICompatibleCompletionDriver({
      client,
      defaultModel: 'deepseek-chat',
    });

    await expect(collect(driver, request())).rejects.toMatchObject({
      publicMessage: 'Model provider returned invalid tool arguments.',
    });
  });

  it('rejects every non-JSON completion argument before emitting any tool event', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalidArguments: unknown[] = [
      undefined,
      null,
      [],
      'not-an-object',
      42,
      true,
      { value: 1n },
      circular,
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
    ];

    for (const argumentsValue of invalidArguments) {
      const client = new FakeCompletionClient(() => ({
        toolCalls: [
          {
            id: 'call-valid',
            name: 'read_node',
            arguments: { node: 'A' },
          },
          {
            id: 'call-invalid',
            name: 'read_node',
            arguments: argumentsValue,
          },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
      const driver = new OpenAICompatibleCompletionDriver({
        client,
        defaultModel: 'deepseek-chat',
      });
      const emitted: AgentModelStreamEvent[] = [];

      await expect(
        (async () => {
          for await (const event of driver.stream(request())) {
            emitted.push(event);
          }
        })(),
      ).rejects.toMatchObject({
        publicMessage: 'Model provider returned invalid tool arguments.',
      });
      expect(emitted).toEqual([]);
    }
  });
});
