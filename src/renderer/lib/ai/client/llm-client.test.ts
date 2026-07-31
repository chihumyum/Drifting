import { describe, expect, it, vi } from 'vitest';
import type { RequestInterceptor } from '../interceptors/interceptor';
import {
  AIError,
  type AICompletionChunk,
  type AICompletionRequest,
  type AICompletionResponse,
} from '../types';
import { LLMClient } from './llm-client';
import type { LLMProvider } from './providers/provider';

const REQUEST: AICompletionRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  metadata: { feature: 'llm-client-stream-test' },
};

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
};

function observerSpies() {
  const after = vi.fn<NonNullable<RequestInterceptor['after']>>();
  const onError = vi.fn<NonNullable<RequestInterceptor['onError']>>();
  return {
    after,
    onError,
    interceptor: { after, onError } satisfies RequestInterceptor,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function collect(
  stream: AsyncIterable<AICompletionChunk>,
): Promise<AICompletionChunk[]> {
  const chunks: AICompletionChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function unusedComplete(): LLMProvider['complete'] {
  return vi.fn(async () => ({ usage: ZERO_USAGE }));
}

describe('LLMClient.stream', () => {
  it('delivers the provider first delta before the provider terminal gate opens', async () => {
    const terminalGate = deferred();
    const providerStream = vi.fn(async function* () {
      yield { delta: 'first' };
      await terminalGate.promise;
      yield {
        delta: '',
        usage: { inputTokens: 4, outputTokens: 1 },
        finishReason: 'stop',
      };
    });
    const provider: LLMProvider = {
      id: 'incremental-provider',
      complete: unusedComplete(),
      stream: providerStream,
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);
    const iterator = client.stream(REQUEST)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { delta: 'first' },
    });
    expect(observer.after).not.toHaveBeenCalled();
    expect(observer.onError).not.toHaveBeenCalled();

    terminalGate.resolve();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        delta: '',
        usage: { inputTokens: 4, outputTokens: 1 },
        finishReason: 'stop',
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(observer.after).toHaveBeenCalledOnce();
    expect(observer.onError).not.toHaveBeenCalled();
  });

  it('aggregates interleaved parallel tool deltas into one after response', async () => {
    const usage = { inputTokens: 21, outputTokens: 7 };
    const provider: LLMProvider = {
      id: 'parallel-tool-provider',
      supportsTools: true,
      supportsToolStreaming: true,
      complete: unusedComplete(),
      async *stream() {
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'call-read',
              nameDelta: 'read_',
              argumentsDelta: '{"node":',
            },
            {
              index: 1,
              id: 'call-search',
              nameDelta: 'search_',
              argumentsDelta: '{"query":',
            },
          ],
        };
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 1,
              nameDelta: 'project',
              argumentsDelta: '"线索"}',
            },
            {
              index: 0,
              nameDelta: 'node',
              argumentsDelta: '"第一章"}',
            },
          ],
        };
        yield { delta: '', usage, finishReason: 'tool_calls' };
      },
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);

    await collect(client.stream(REQUEST));

    expect(observer.after).toHaveBeenCalledOnce();
    expect(observer.after).toHaveBeenCalledWith(REQUEST, {
      toolCall: {
        id: 'call-read',
        name: 'read_node',
        arguments: { node: '第一章' },
      },
      toolCalls: [
        {
          id: 'call-read',
          name: 'read_node',
          arguments: { node: '第一章' },
        },
        {
          id: 'call-search',
          name: 'search_project',
          arguments: { query: '线索' },
        },
      ],
      finishReason: 'tool_calls',
      usage,
    });
    expect(observer.onError).not.toHaveBeenCalled();
  });

  it('settles a normally completed stream with after once and no onError', async () => {
    const provider: LLMProvider = {
      id: 'text-provider',
      complete: unusedComplete(),
      async *stream() {
        yield { delta: 'hello ' };
        yield { delta: 'world' };
        yield {
          delta: '',
          usage: { inputTokens: 3, outputTokens: 2 },
          finishReason: 'stop',
        };
      },
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);

    await expect(collect(client.stream(REQUEST))).resolves.toEqual([
      { delta: 'hello ' },
      { delta: 'world' },
      {
        delta: '',
        usage: { inputTokens: 3, outputTokens: 2 },
        finishReason: 'stop',
      },
    ]);
    expect(observer.after).toHaveBeenCalledOnce();
    expect(observer.after).toHaveBeenCalledWith(REQUEST, {
      text: 'hello world',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(observer.onError).not.toHaveBeenCalled();
  });

  it('settles a provider stream error with onError once and no after', async () => {
    const providerError = new AIError('network', 'provider stream failed');
    const provider: LLMProvider = {
      id: 'failing-provider',
      complete: unusedComplete(),
      async *stream() {
        yield { delta: 'partial' };
        throw providerError;
      },
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);

    await expect(collect(client.stream(REQUEST))).rejects.toBe(providerError);
    expect(observer.after).not.toHaveBeenCalled();
    expect(observer.onError).toHaveBeenCalledOnce();
    expect(observer.onError).toHaveBeenCalledWith(REQUEST, providerError);
  });

  it.each([
    {
      label: 'usage',
      terminal: { delta: '', finishReason: 'stop' },
      expectedMessage:
        'Model provider stream ended without terminal usage.',
    },
    {
      label: 'finish reason',
      terminal: {
        delta: '',
        usage: { inputTokens: 2, outputTokens: 1 },
      },
      expectedMessage:
        'Model provider stream ended without a finish reason.',
    },
  ] as const)(
    'fails the metered terminal contract when $label is missing',
    async ({ terminal, expectedMessage }) => {
      const provider: LLMProvider = {
        id: 'incomplete-terminal-provider',
        complete: unusedComplete(),
        async *stream() {
          yield { delta: 'partial' };
          yield terminal;
        },
      };
      const observer = observerSpies();
      const client = new LLMClient(provider).use(observer.interceptor);

      await expect(
        collect(
          client.stream({
            ...REQUEST,
            terminalRequirements: {
              finishReason: true,
              usage: true,
            },
          }),
        ),
      ).rejects.toMatchObject({
        name: 'AIError',
        kind: 'parse',
        message: expectedMessage,
      });
      expect(observer.after).not.toHaveBeenCalled();
      expect(observer.onError).toHaveBeenCalledOnce();
    },
  );

  it('settles consumer iterator.return() as one cancellation error and never after', async () => {
    let providerClosed = false;
    const provider: LLMProvider = {
      id: 'cancelled-consumer-provider',
      complete: unusedComplete(),
      async *stream() {
        try {
          yield { delta: 'first' };
          yield { delta: 'second' };
        } finally {
          providerClosed = true;
        }
      },
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);
    const iterator = client.stream(REQUEST)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { delta: 'first' },
    });
    await expect(iterator.return?.(undefined)).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(providerClosed).toBe(true);
    expect(observer.after).not.toHaveBeenCalled();
    expect(observer.onError).toHaveBeenCalledOnce();
    expect(observer.onError.mock.calls[0]?.[0]).toBe(REQUEST);
    expect(observer.onError.mock.calls[0]?.[1]).toMatchObject({
      name: 'AIError',
      kind: 'aborted',
      message: 'Streaming response consumption was cancelled.',
    });
  });

  it('falls back to complete for tool requests when provider tool streaming is unsupported', async () => {
    const response: AICompletionResponse = {
      toolCall: {
        id: 'call-one',
        name: 'read_node',
        arguments: { node: '第一章' },
      },
      toolCalls: [
        {
          id: 'call-one',
          name: 'read_node',
          arguments: { node: '第一章' },
        },
        {
          id: 'call-two',
          name: 'search_project',
          arguments: { query: '线索' },
        },
      ],
      usage: { inputTokens: 8, outputTokens: 4 },
      raw: { choices: [{ finish_reason: 'tool_calls' }] },
    };
    const complete = vi.fn(async () => response);
    const providerStream = vi.fn(async function* () {
      yield { delta: 'must not stream' };
    });
    const provider: LLMProvider = {
      id: 'completion-only-tools-provider',
      supportsTools: true,
      supportsToolStreaming: false,
      complete,
      stream: providerStream,
    };
    const request: AICompletionRequest = {
      ...REQUEST,
      tools: [
        {
          name: 'read_node',
          description: 'Read one node',
          parametersSchema: { type: 'object' },
        },
      ],
      toolChoice: 'auto',
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);

    await expect(collect(client.stream(request))).resolves.toEqual([
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 0,
            id: 'call-one',
            nameDelta: 'read_node',
            argumentsDelta: '{"node":"第一章"}',
          },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          {
            index: 1,
            id: 'call-two',
            nameDelta: 'search_project',
            argumentsDelta: '{"query":"线索"}',
          },
        ],
      },
      {
        delta: '',
        usage: { inputTokens: 8, outputTokens: 4 },
        finishReason: 'tool_calls',
      },
    ]);
    expect(client.supportsTools).toBe(true);
    expect(client.supportsToolStreaming).toBe(false);
    expect(providerStream).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(request);
    expect(observer.after).toHaveBeenCalledOnce();
    expect(observer.after).toHaveBeenCalledWith(request, response);
    expect(observer.onError).not.toHaveBeenCalled();
  });

  it('preserves a completion length finish instead of upgrading a partial tool call', async () => {
    const response: AICompletionResponse = {
      toolCall: {
        id: 'partial-call',
        name: 'read_node',
        arguments: {},
      },
      finishReason: 'length',
      usage: { inputTokens: 8, outputTokens: 4 },
    };
    const provider: LLMProvider = {
      id: 'partial-completion-provider',
      supportsTools: true,
      supportsToolStreaming: false,
      complete: vi.fn(async () => response),
    };
    const client = new LLMClient(provider);

    const chunks = await collect(
      client.stream({
        ...REQUEST,
        tools: [
          {
            name: 'read_node',
            description: 'Read one node',
            parametersSchema: { type: 'object' },
          },
        ],
      }),
    );

    expect(chunks[chunks.length - 1]).toEqual({
      delta: '',
      usage: response.usage,
      finishReason: 'length',
    });
  });
});

describe('LLMClient strict terminal validation', () => {
  const STRICT_REQUEST: AICompletionRequest = {
    ...REQUEST,
    terminalRequirements: {
      finishReason: true,
      usage: true,
    },
  };

  it('rejects an incomplete completion before observers record success', async () => {
    const provider: LLMProvider = {
      id: 'incomplete-completion-provider',
      complete: vi.fn(async () => ({
        text: 'partial',
        usage: { inputTokens: 2, outputTokens: 1 },
      })),
    };
    const observer = observerSpies();
    const client = new LLMClient(provider, {
      retry: {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      },
    }).use(observer.interceptor);

    await expect(client.complete(STRICT_REQUEST)).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'Model provider stream ended without a finish reason.',
    });
    expect(observer.after).not.toHaveBeenCalled();
    expect(observer.onError).toHaveBeenCalledOnce();
  });

  it('does not synthesize a finish reason for a streamless provider', async () => {
    const provider: LLMProvider = {
      id: 'streamless-provider',
      complete: vi.fn(async () => ({
        text: 'partial',
        usage: { inputTokens: 2, outputTokens: 1 },
      })),
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);

    await expect(collect(client.stream(STRICT_REQUEST))).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'Model provider stream ended without a finish reason.',
    });
    expect(observer.after).not.toHaveBeenCalled();
    expect(observer.onError).toHaveBeenCalledOnce();
  });

  it('rejects tool calls paired with a text finish before observers record success', async () => {
    const provider: LLMProvider = {
      id: 'mismatched-tool-provider',
      supportsTools: true,
      supportsToolStreaming: true,
      complete: unusedComplete(),
      async *stream() {
        yield {
          delta: '',
          toolCallDeltas: [
            {
              index: 0,
              id: 'call-one',
              nameDelta: 'read_node',
              argumentsDelta: '{"node":"第一章"}',
            },
          ],
        };
        yield {
          delta: '',
          usage: { inputTokens: 4, outputTokens: 2 },
          finishReason: 'stop',
        };
      },
    };
    const observer = observerSpies();
    const client = new LLMClient(provider).use(observer.interceptor);

    await expect(
      collect(
        client.stream({
          ...STRICT_REQUEST,
          tools: [
            {
              name: 'read_node',
              description: 'Read one node',
              parametersSchema: { type: 'object' },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message:
        'Model provider returned tool calls without a tool_calls finish reason.',
    });
    expect(observer.after).not.toHaveBeenCalled();
    expect(observer.onError).toHaveBeenCalledOnce();
  });

  it('never rewrites non-JSON completion tool arguments to an empty object', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const invalidArguments of [{ node: 1n }, cyclic]) {
      const provider: LLMProvider = {
        id: 'invalid-completion-arguments-provider',
        supportsTools: true,
        supportsToolStreaming: false,
        complete: vi.fn(async () => ({
          toolCall: {
            id: 'call-one',
            name: 'read_node',
            arguments: invalidArguments,
          },
          finishReason: 'tool_calls',
          usage: { inputTokens: 4, outputTokens: 2 },
        })),
      };
      const observer = observerSpies();
      const client = new LLMClient(provider).use(observer.interceptor);
      const yielded: AICompletionChunk[] = [];

      await expect(
        (async () => {
          for await (const chunk of client.stream({
            ...STRICT_REQUEST,
            tools: [
              {
                name: 'read_node',
                description: 'Read one node',
                parametersSchema: { type: 'object' },
              },
            ],
          })) {
            yielded.push(chunk);
          }
        })(),
      ).rejects.toMatchObject({
        name: 'AIError',
        kind: 'parse',
        message: 'Model provider returned non-JSON tool arguments.',
      });
      expect(yielded).toEqual([]);
      expect(observer.after).not.toHaveBeenCalled();
      expect(observer.onError).toHaveBeenCalledOnce();
    }
  });
});
