import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AICompletionChunk, AICompletionRequest } from '../../types';
import { OpenAIProvider } from './openai';

const streamRequest: AICompletionRequest = {
  model: 'gpt-4.1',
  system: 'Use certified tools.',
  messages: [
    { role: 'user', content: 'Inspect.' },
    {
      role: 'model',
      content: '',
      toolCalls: [{ id: 'old-1', name: 'read', arguments: { node: 'One' } }],
    },
    { role: 'tool', toolCallId: 'old-1', content: '{"title":"One"}' },
  ],
  tools: [
    {
      name: 'read',
      description: 'Read one item.',
      parametersSchema: { type: 'object', properties: {} },
    },
  ],
  toolChoice: 'auto',
  maxOutputTokens: 256,
  terminalRequirements: { finishReason: true, usage: true },
};

describe('OpenAI provider conformance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves tool history and streams parallel fragmented calls with terminal usage', async () => {
    const requests: Array<Record<string, unknown>> = [];
    installSseFetch(
      [
        chunk({
          choices: [
            { index: 0, delta: { content: 'Checking ' }, finish_reason: null },
          ],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-a',
                    type: 'function',
                    function: { name: 'read', arguments: '{"node":"' },
                  },
                  {
                    index: 1,
                    id: 'call-b',
                    type: 'function',
                    function: { name: 'read', arguments: '{"node":"' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'One"}' } },
                  { index: 1, function: { arguments: 'Two"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        }),
        chunk({
          choices: [],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 10,
            total_tokens: 60,
            prompt_tokens_details: { cached_tokens: 12 },
          },
        }),
        '[DONE]',
      ],
      requests,
    );
    const provider = new OpenAIProvider({
      apiKey: 'openai-test',
      baseURL: 'https://openai.test/v1',
    });

    await expect(collect(provider.stream(streamRequest))).resolves.toEqual([
      { delta: 'Checking ' },
      {
        delta: '',
        toolCallDeltas: [
          { index: 0, id: 'call-a', nameDelta: 'read', argumentsDelta: '{"node":"' },
          { index: 1, id: 'call-b', nameDelta: 'read', argumentsDelta: '{"node":"' },
        ],
      },
      {
        delta: '',
        toolCallDeltas: [
          { index: 0, argumentsDelta: 'One"}' },
          { index: 1, argumentsDelta: 'Two"}' },
        ],
      },
      { delta: '', finishReason: 'tool_calls' },
      {
        delta: '',
        usage: { inputTokens: 50, outputTokens: 10, cachedTokens: 12 },
      },
    ]);
    expect(requests[0]).toMatchObject({
      model: 'gpt-4.1',
      max_completion_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Use certified tools.' },
        { role: 'user', content: 'Inspect.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'old-1',
              type: 'function',
              function: { name: 'read', arguments: '{"node":"One"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'old-1', content: '{"title":"One"}' },
      ],
    });
  });

  it('requires finish and usage and maps abort before send', async () => {
    installSseFetch(
      [
        chunk({
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }],
        }),
        '[DONE]',
      ],
      [],
    );
    const provider = new OpenAIProvider({ apiKey: 'test', baseURL: 'https://openai.test/v1' });
    await expect(collect(provider.stream(streamRequest))).rejects.toMatchObject({
      name: 'AIError',
      kind: 'parse',
      message: 'OpenAI stream ended without terminal usage.',
    });

    const controller = new AbortController();
    controller.abort('stop');
    await expect(
      collect(provider.stream({ ...streamRequest, signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AIError', kind: 'aborted' });
  });
});

function chunk(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4.1',
    ...overrides,
  };
}

function installSseFetch(
  events: readonly (Record<string, unknown> | '[DONE]')[],
  requests: Array<Record<string, unknown>>,
): void {
  const body = events
    .map((event) =>
      event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
}

async function collect(stream: AsyncIterable<AICompletionChunk>): Promise<AICompletionChunk[]> {
  const chunks: AICompletionChunk[] = [];
  for await (const chunkValue of stream) chunks.push(chunkValue);
  return chunks;
}
