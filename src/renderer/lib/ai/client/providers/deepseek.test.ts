import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AICompletionChunk,
  AICompletionRequest,
} from '../../types';
import { DeepSeekProvider } from './deepseek';

interface CapturedFetchRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

const streamRequest: AICompletionRequest = {
  model: 'deepseek-v4-flash',
  system: 'Only use the supplied Drifting tools.',
  messages: [
    { role: 'user', content: '读取第一章并搜索旧港。' },
    {
      role: 'model',
      content: '',
      toolCalls: [
        {
          id: 'history-call-1',
          name: 'read_node',
          arguments: { node: '第一章' },
        },
        {
          id: 'history-call-2',
          name: 'search_prose',
          arguments: { query: '旧港' },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'history-call-1',
      content: '{"title":"第一章"}',
    },
    {
      role: 'tool',
      toolCallId: 'history-call-2',
      content: '{"matches":[]}',
    },
    { role: 'user', content: '继续。' },
  ],
  tools: [
    {
      name: 'read_node',
      description: 'Read one node.',
      parametersSchema: {
        type: 'object',
        properties: { node: { type: 'string' } },
        required: ['node'],
        additionalProperties: false,
      },
    },
    {
      name: 'search_prose',
      description: 'Search project prose.',
      parametersSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: 'auto',
  maxOutputTokens: 321,
  temperature: 0.25,
  thinking: false,
};

describe('DeepSeekProvider.stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves the complete tool loop request and streams text, interleaved parallel calls, finish, and usage', async () => {
    const { requests } = installSseFetch([
      completionChunk({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '先' },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [
          {
            index: 0,
            delta: { content: '查' },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-a',
                  type: 'function',
                  function: {
                    name: 'read_node',
                    arguments: '{"node":"',
                  },
                },
                {
                  index: 1,
                  id: 'call-b',
                  type: 'function',
                  function: {
                    name: 'search_prose',
                    arguments: '{"query":"',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  function: { arguments: '旧港"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '第一章"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      }),
      completionChunk({
        choices: [],
        usage: {
          prompt_tokens: 128,
          completion_tokens: 18,
          total_tokens: 146,
        },
      }),
      '[DONE]',
    ]);
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });

    const chunks = await collect(provider.stream(streamRequest));

    expect(requests).toEqual([
      {
        url: 'https://deepseek.test/v1/chat/completions',
        method: 'POST',
        body: {
          model: 'deepseek-v4-flash',
          messages: [
            {
              role: 'system',
              content: 'Only use the supplied Drifting tools.',
            },
            {
              role: 'user',
              content: '读取第一章并搜索旧港。',
            },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'history-call-1',
                  type: 'function',
                  function: {
                    name: 'read_node',
                    arguments: '{"node":"第一章"}',
                  },
                },
                {
                  id: 'history-call-2',
                  type: 'function',
                  function: {
                    name: 'search_prose',
                    arguments: '{"query":"旧港"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'history-call-1',
              content: '{"title":"第一章"}',
            },
            {
              role: 'tool',
              tool_call_id: 'history-call-2',
              content: '{"matches":[]}',
            },
            {
              role: 'user',
              content: '继续。',
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_node',
                description: 'Read one node.',
                parameters: {
                  type: 'object',
                  properties: { node: { type: 'string' } },
                  required: ['node'],
                  additionalProperties: false,
                },
              },
            },
            {
              type: 'function',
              function: {
                name: 'search_prose',
                description: 'Search project prose.',
                parameters: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query'],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: 'auto',
          max_tokens: 321,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.25,
          thinking: { type: 'disabled' },
        },
      },
    ]);
    expect(chunks).toEqual([
      { delta: '先' },
      { delta: '查' },
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 0,
            id: 'call-a',
            nameDelta: 'read_node',
            argumentsDelta: '{"node":"',
          },
          {
            index: 1,
            id: 'call-b',
            nameDelta: 'search_prose',
            argumentsDelta: '{"query":"',
          },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 1,
            argumentsDelta: '旧港"}',
          },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 0,
            argumentsDelta: '第一章"}',
          },
        ],
      },
      {
        delta: '',
        finishReason: 'tool_calls',
      },
      {
        delta: '',
        usage: {
          inputTokens: 128,
          outputTokens: 18,
        },
      },
    ]);
  });

  it('uses the current thinking wire shape and preserves reasoning_content for tool replay', async () => {
    const { requests } = installSseFetch([
      completionChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_content: 'continue checking' },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
      }),
      completionChunk({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
      '[DONE]',
    ]);
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });
    const messages = streamRequest.messages.map((message, index) =>
      index === 1
        ? { ...message, reasoningContent: 'inspect the manuscript' }
        : message,
    );

    const chunks = await collect(
      provider.stream({
        ...streamRequest,
        messages,
        thinking: true,
        reasoningEffort: 'max',
      }),
    );

    expect(requests[0]?.body).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(requests[0]?.body).not.toHaveProperty('tool_choice');
    expect((requests[0]?.body.messages as Record<string, unknown>[])[2]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'inspect the manuscript',
    });
    expect(chunks[0]).toEqual({
      delta: '',
      thinkingDelta: 'continue checking',
    });
  });

  it('rejects an already-aborted stream without sending or yielding a successful terminal chunk', async () => {
    const { fetchMock } = installSseFetch(['[DONE]']);
    const controller = new AbortController();
    controller.abort('cancel before send');
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });
    const emitted: AICompletionChunk[] = [];

    await expect(
      consume(provider.stream({ ...streamRequest, signal: controller.signal }), emitted),
    ).rejects.toMatchObject({
      name: 'AIError',
      kind: 'aborted',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('stops after a mid-stream abort and never emits buffered finish or usage terminals', async () => {
    const { fetchMock } = installSseFetch([
      completionChunk({
        choices: [
          {
            index: 0,
            delta: { content: 'partial' },
            finish_reason: null,
          },
        ],
      }),
      completionChunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }),
      completionChunk({
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 1,
          total_tokens: 21,
        },
      }),
      '[DONE]',
    ]);
    const controller = new AbortController();
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });
    const emitted: AICompletionChunk[] = [];

    const run = (async () => {
      for await (const chunk of provider.stream({
        ...streamRequest,
        signal: controller.signal,
      })) {
        emitted.push(chunk);
        controller.abort('cancel after first chunk');
      }
    })();

    await expect(run).rejects.toMatchObject({
      name: 'AIError',
      kind: 'aborted',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(emitted).toEqual([{ delta: 'partial' }]);
    expect(
      emitted.some(
        (chunk) =>
          chunk.finishReason !== undefined || chunk.usage !== undefined,
      ),
    ).toBe(false);
  });

  it('fails a tool stream that omits terminal usage instead of bypassing budgets with zero', async () => {
    installSseFetch([
      completionChunk({
        choices: [
          {
            index: 0,
            delta: { content: 'partial' },
            finish_reason: 'stop',
          },
        ],
      }),
      '[DONE]',
    ]);
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });
    const emitted: AICompletionChunk[] = [];

    await expect(
      consume(provider.stream(streamRequest), emitted),
    ).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'DeepSeek stream ended without terminal usage.',
    });
    expect(emitted).toEqual([
      { delta: 'partial', finishReason: 'stop' },
    ]);
    expect(emitted.some((chunk) => chunk.usage)).toBe(false);
  });

  it('requires usage for a tool-free metered Agent synthesis stream', async () => {
    installSseFetch([
      completionChunk({
        choices: [
          {
            index: 0,
            delta: { content: 'final answer' },
            finish_reason: 'stop',
          },
        ],
      }),
      '[DONE]',
    ]);
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });

    await expect(
      collect(
        provider.stream({
          ...streamRequest,
          tools: [],
          toolChoice: undefined,
          terminalRequirements: {
            finishReason: true,
            usage: true,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'DeepSeek stream ended without terminal usage.',
    });
  });

  it('requires an explicit finish reason for a metered Agent stream', async () => {
    installSseFetch([
      completionChunk({
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
        },
      }),
      '[DONE]',
    ]);
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });

    await expect(
      collect(
        provider.stream({
          ...streamRequest,
          tools: [],
          toolChoice: undefined,
          terminalRequirements: {
            finishReason: true,
            usage: true,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'DeepSeek stream ended without a finish reason.',
    });
  });

  it('rejects a present but incomplete usage object', async () => {
    installSseFetch([
      completionChunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      }),
      completionChunk({
        choices: [],
        usage: {},
      }),
      '[DONE]',
    ]);
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseURL: 'https://deepseek.test/v1',
    });

    await expect(
      collect(
        provider.stream({
          ...streamRequest,
          tools: [],
          toolChoice: undefined,
          terminalRequirements: {
            finishReason: true,
            usage: true,
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'DeepSeek returned invalid usage.',
    });
  });
});

function completionChunk(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-v4-flash',
    ...overrides,
  };
}

function installSseFetch(
  events: readonly (Record<string, unknown> | '[DONE]')[],
): {
  fetchMock: ReturnType<typeof vi.fn>;
  requests: CapturedFetchRequest[];
} {
  const requests: CapturedFetchRequest[] = [];
  const body = events
    .map((event) =>
      event === '[DONE]'
        ? 'data: [DONE]\n\n'
        : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  const fetchMock = vi.fn(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        body: JSON.parse(await request.clone().text()) as Record<
          string,
          unknown
        >,
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requests };
}

async function collect(
  stream: AsyncIterable<AICompletionChunk>,
): Promise<AICompletionChunk[]> {
  const chunks: AICompletionChunk[] = [];
  await consume(stream, chunks);
  return chunks;
}

async function consume(
  stream: AsyncIterable<AICompletionChunk>,
  target: AICompletionChunk[],
): Promise<void> {
  for await (const chunk of stream) target.push(chunk);
}
