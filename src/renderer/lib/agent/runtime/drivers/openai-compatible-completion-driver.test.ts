import { describe, expect, it } from 'vitest';
import {
  AIError,
  type AICompletionRequest,
  type AICompletionResponse,
} from '../../../ai/types';
import {
  AgentModelDriverError,
  publicModelDriverErrorMessage,
} from '../errors';
import type {
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStreamEvent,
} from '../types';
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

function request(
  overrides: Partial<AgentModelRequest> = {},
): AgentModelRequest {
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
              sourceIds: [
                'model/message/1/assistant/0/tool_call',
              ],
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
      // Tool presence wins over a conflicting provider stop reason.
      raw: { choices: [{ finish_reason: 'stop' }] },
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
      collect(
        driver,
        request({ reasoning: { enabled: true, effort: 'high' } }),
      ),
    ).rejects.toMatchObject({
      name: 'AgentModelDriverError',
      publicMessage:
        'Reasoning is not supported by the P1 completion driver.',
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
      publicMessage:
        'The configured model provider does not support agent tools.',
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
      throw new Error(
        'fetch https://provider.invalid?api_key=sk-generic-secret failed',
      );
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
      publicMessage:
        'Model provider returned a tool call without a tool call id.',
    });
  });

  it('rejects malformed provider tool calls without leaking their payload', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const client = new FakeCompletionClient(() => ({
      toolCalls: [
        { id: 'call-a', name: 'read_node', arguments: circular },
      ],
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
});
