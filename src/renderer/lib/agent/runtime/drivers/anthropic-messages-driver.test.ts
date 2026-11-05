import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentModelRequest, AgentModelStreamEvent } from '../types';
import { AnthropicMessagesAgentDriver } from './anthropic-messages-driver';

function request(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    iteration: 1,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    context: {
      systemPrompt: 'Use only certified tools.',
      messages: [
        {
          type: 'model_message',
          sourceIds: ['message/user/1'],
          message: { role: 'user', content: 'Search rain.' },
        },
      ],
    },
    tools: [
      {
        name: 'search',
        description: 'Search the manuscript.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens: 512,
    reasoning: { enabled: false },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  driver: AnthropicMessagesAgentDriver,
  input = request(),
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of driver.stream(input)) events.push(event);
  return events;
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** Deterministic-failure tests opt out of the shared retry lease for speed. */
const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false };
/** Retry tests keep multiple attempts but skip real backoff delays. */
const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: false };

describe('Anthropic Messages Agent driver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('distinguishes a real provider context boundary from an unknown provider failure', async () => {
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'test', fetch: async () => new Response(sse([
      { type: 'message_start', message: { usage: { input_tokens: 180_000 } } },
      { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' }, usage: { output_tokens: 20_000 } },
      { type: 'message_stop' },
    ])) });
    expect(await collect(driver, request({ maxOutputTokens: null })))
      .toContainEqual({ type: 'finish', reason: 'context_window_exceeded' });
  });

  it.each([
    { model: 'claude-sonnet-5', maximum: 128_000 },
    { model: 'claude-haiku-4-5-20251001', maximum: 64_000 },
  ])('uses the required model maximum instead of an arbitrary default for $model', async ({ model, maximum }) => {
    let body: Record<string, unknown> | undefined;
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test', defaultModel: model,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(sse([
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 16_384 } },
          { type: 'message_stop' },
        ]));
      },
    });
    const events = await collect(driver, request({ model, maxOutputTokens: null }));
    expect(body?.max_tokens).toBe(maximum);
    expect(driver.capabilities.context.maxOutputTokens).toBe(maximum);
    expect(events).toContainEqual({ type: 'finish', reason: 'end_turn' });
  });

  it('maps a forced completion tool to Anthropic tool_choice', async () => {
    let body: Record<string, unknown> | undefined;
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ]),
          { status: 200 },
        );
      },
    });

    await collect(driver, request({ toolChoice: { force: 'search' } }));

    expect(body?.tool_choice).toEqual({ type: 'tool', name: 'search' });
  });

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])(
    'asks %s with auto tool choice and keeps its always-on thinking',
    async (model) => {
      const bodies: Record<string, unknown>[] = [];
      const driver = new AnthropicMessagesAgentDriver({
        apiKey: 'test',
        defaultModel: model,
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(
            sse([
              { type: 'message_start', message: { usage: { input_tokens: 1 } } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
              { type: 'message_stop' },
            ]),
            { status: 200 },
          );
        },
      });

      // These models answer forced `any` / `tool` choices with a 400.
      await collect(driver, request({ model, toolChoice: { force: 'search' } }));
      await collect(
        driver,
        request({
          model,
          reasoning: { enabled: false },
          executionMode: 'required_tool_non_reasoning',
          toolChoice: 'required',
        }),
      );
      await collect(driver, request({ model, toolChoice: 'none' }));

      expect(bodies.map((body) => body.tool_choice)).toEqual([
        { type: 'auto' },
        { type: 'auto' },
        { type: 'none' },
      ]);
      for (const body of bodies.slice(0, 2)) {
        expect(body).toMatchObject({
          model,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
        });
        expect(body).not.toHaveProperty('temperature');
      }
    },
  );

  it('uses a required non-reasoning action sample without changing the turn setting', async () => {
    let body: Record<string, unknown> | undefined;
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ]),
          { status: 200 },
        );
      },
    });

    await collect(
      driver,
      request({
        reasoning: { enabled: true, effort: 'high' },
        executionMode: 'required_tool_non_reasoning',
        toolChoice: 'required',
      }),
    );

    expect(body?.tool_choice).toEqual({ type: 'any' });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
  });

  it('projects the model request and normalizes fragmented tool use, usage and finish', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        sse([
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 80,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 4,
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will ' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"query":"' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: 'rain"}' },
          },
          { type: 'content_block_stop', index: 1 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 16 },
          },
          { type: 'message_stop' },
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'anthropic-test-key',
      endpoint: 'https://anthropic.test/v1/messages',
      fetch: fetchMock,
    });

    await expect(collect(driver)).resolves.toEqual([
      { type: 'text_delta', text: 'I will ' },
      { type: 'tool_call_start', callId: 'tool-1', name: 'search' },
      { type: 'tool_args_delta', callId: 'tool-1', delta: '{"query":"' },
      { type: 'tool_args_delta', callId: 'tool-1', delta: 'rain"}' },
      { type: 'tool_call_end', callId: 'tool-1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 80,
          outputTokens: 16,
          cacheReadTokens: 20,
          cacheWriteTokens: 4,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'tool_use' },
    ]);
    expect(captured).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      stream: true,
      system: [
        {
          type: 'text',
          text: 'Use only certified tools.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Search rain.',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'search',
          description: 'Search the manuscript.',
          input_schema: request().tools[0]?.inputSchema,
          cache_control: { type: 'ephemeral' },
        },
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      ],
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-api-key': 'anthropic-test-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('keeps the cached prefix byte-identical across iterations and anchors breakpoints at stability boundaries', async () => {
    const bodies: Record<string, unknown>[] = [];
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ]),
          { status: 200 },
        );
      },
    });
    const tools = [
      {
        name: 'search',
        description: 'Search the manuscript.',
        inputSchema: { type: 'object' },
      },
      {
        name: 'read_chapter',
        description: 'Read one chapter.',
        inputSchema: { type: 'object' },
      },
    ];
    const iterationOneMessages = [
      {
        type: 'model_message' as const,
        sourceIds: ['message/user/1'],
        message: { role: 'user' as const, content: 'Search rain.' },
      },
    ];
    const iterationTwoMessages = [
      ...iterationOneMessages,
      {
        type: 'model_message' as const,
        sourceIds: ['message/assistant/1'],
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_call' as const,
              callId: 'call-1',
              name: 'search',
              arguments: { query: 'rain' },
              rawArguments: '{"query":"rain"}',
            },
          ],
        },
      },
      {
        type: 'model_message' as const,
        sourceIds: ['message/tool/1'],
        message: {
          role: 'tool' as const,
          content: [{ callId: 'call-1', name: 'search', ok: true, content: '{"matches":[]}' }],
        },
      },
      {
        type: 'context_note' as const,
        noteKind: 'freshness' as const,
        sourceId: 'note/freshness/1',
        turnOrdinal: null,
        content: 'Iteration-volatile runtime note.',
      },
    ];

    await collect(
      driver,
      request({
        iteration: 1,
        tools,
        context: { systemPrompt: 'Use only certified tools.', messages: iterationOneMessages },
      }),
    );
    await collect(
      driver,
      request({
        iteration: 2,
        tools,
        context: { systemPrompt: 'Use only certified tools.', messages: iterationTwoMessages },
      }),
    );

    const [first, second] = bodies as [Record<string, unknown>, Record<string, unknown>];
    // The cacheable tools + system prefix must not change between iterations.
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));

    // Breakpoint 1: only the last function tool schema carries the marker;
    // the hosted web search after it is covered by the system breakpoint.
    const toolBlocks = second.tools as Array<Record<string, unknown>>;
    expect(toolBlocks.map((tool) => tool.cache_control)).toEqual([
      undefined,
      { type: 'ephemeral' },
      undefined,
    ]);
    expect(toolBlocks[2]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    // Breakpoint 2: the system tail carries the marker.
    expect(second.system).toEqual([
      {
        type: 'text',
        text: 'Use only certified tools.',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    // Breakpoint 3: exactly one history marker, on the newest canonical
    // message (the tool result), never on the volatile trailing note row.
    const messageBlocks = (second.messages as Array<{ content: unknown }>).map((message) =>
      Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
    );
    const markedBlocks = messageBlocks.flat().filter((block) => 'cache_control' in block);
    expect(markedBlocks).toHaveLength(1);
    expect(markedBlocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call-1',
      cache_control: { type: 'ephemeral' },
    });
    const projectedMessages = second.messages as Array<Record<string, unknown>>;
    const noteMessage = projectedMessages[projectedMessages.length - 1];
    expect(JSON.stringify(noteMessage)).not.toContain('cache_control');

    // The shared history prefix is byte-identical once the moving breakpoint
    // marker is removed, so iteration 1's cache entry prefixes iteration 2.
    const stripMarkers = (messages: unknown): unknown =>
      JSON.parse(
        JSON.stringify(messages, (key, value: unknown) =>
          key === 'cache_control' ? undefined : value,
        ),
      );
    const firstStripped = stripMarkers(first.messages) as unknown[];
    const secondStripped = stripMarkers(second.messages) as unknown[];
    expect(JSON.stringify(secondStripped.slice(0, firstStripped.length))).toBe(
      JSON.stringify(firstStripped),
    );
  });

  it('fails closed when the stream omits terminal accounting', async () => {
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      providerAttemptRetry: NO_RETRY,
      fetch: async () =>
        new Response(
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 1 } } },
            { type: 'message_stop' },
          ]),
          { status: 200 },
        ),
    });
    await expect(collect(driver)).rejects.toThrow('invalid model stream');
  });

  it('rejects malformed JSON and never leaks an authentication response body', async () => {
    const malformed = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      providerAttemptRetry: NO_RETRY,
      fetch: async () => new Response('data: {bad}\n\n', { status: 200 }),
    });
    await expect(collect(malformed)).rejects.toThrow('invalid model stream');

    const unauthorized = new AnthropicMessagesAgentDriver({
      apiKey: 'secret-key',
      fetch: async () =>
        new Response('Bearer secret-key at https://internal.invalid', { status: 401 }),
    });
    let caught: unknown;
    try {
      await collect(unauthorized);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Anthropic authentication failed.');
    expect((caught as Error).message).not.toContain('secret-key');
    expect((caught as Error).message).not.toContain('internal.invalid');
  });

  it('resamples a tool-capable attempt after a rate limit and buffers the stream', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"query":"rain"}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ]),
        { status: 200 },
      );
    });
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      providerAttemptRetry: FAST_RETRY,
      fetch: fetchMock,
    });

    const events = await collect(driver);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: 'tool_call_start', callId: 'tool-1', name: 'search' });
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_use' });
  });

  it('retries an overloaded service response for tool-capable attempts', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('overloaded', { status: 529 });
      return new Response(
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ]),
        { status: 200 },
      );
    });
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      providerAttemptRetry: FAST_RETRY,
      fetch: fetchMock,
    });

    await collect(driver);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never resamples a tool-free synthesis attempt', async () => {
    const fetchMock = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      providerAttemptRetry: FAST_RETRY,
      fetch: fetchMock,
    });

    await expect(collect(driver, request({ tools: [] }))).rejects.toThrow(
      'rate limit',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before network access', async () => {
    const fetchMock = vi.fn();
    const controller = new AbortController();
    controller.abort('stop');
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'test', fetch: fetchMock });
    await expect(collect(driver, request({ signal: controller.signal }))).rejects.toThrow(
      'cancelled',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replays signed thinking across a tool result followed by author steering', async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      return new Response(
        call === 1
          ? sse([
              { type: 'message_start', message: { usage: { input_tokens: 10 } } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Check the index.' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'signed-thinking' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'content_block_start',
                index: 1,
                content_block: {
                  type: 'tool_use',
                  id: 'tool-thinking-1',
                  name: 'search',
                  input: {},
                },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: '{"query":"rain"}' },
              },
              { type: 'content_block_stop', index: 1 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 8 },
              },
              { type: 'message_stop' },
            ])
          : sse([
              { type: 'message_start', message: { usage: { input_tokens: 15 } } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Found it.' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 4 },
              },
              { type: 'message_stop' },
            ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: fetchMock,
    });

    const first = await collect(
      driver,
      request({ reasoning: { enabled: true, effort: 'xhigh' } }),
    );
    expect(first).toContainEqual({ type: 'thinking_delta', text: 'Check the index.' });

    await collect(
      driver,
      request({
        iteration: 2,
        reasoning: { enabled: true, effort: 'xhigh' },
        context: {
          systemPrompt: 'Use only certified tools.',
          messages: [
            {
              type: 'model_message',
              sourceIds: ['message/user/1'],
              message: { role: 'user', content: 'Search rain.' },
            },
            {
              type: 'model_message',
              sourceIds: ['message/assistant/1'],
              message: {
                role: 'assistant',
                content: [
                  { type: 'thinking', text: 'Check the index.' },
                  {
                    type: 'tool_call',
                    callId: 'tool-thinking-1',
                    name: 'search',
                    arguments: { query: 'rain' },
                    rawArguments: '{"query":"rain"}',
                  },
                ],
              },
            },
            {
              type: 'model_message',
              sourceIds: ['message/tool/1'],
              message: {
                role: 'tool',
                content: [
                  {
                    callId: 'tool-thinking-1',
                    name: 'search',
                    ok: true,
                    content: '{"matches":[]}',
                  },
                  ],
                },
              },
              {
                type: 'model_message',
                sourceIds: ['message/user/steering/1'],
                message: {
                  role: 'user',
                  content: 'Keep the continuation inside the established world.',
                },
              },
            ],
          },
      }),
    );

    expect(bodies[0]).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    });
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Search rain.' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Check the index.',
            signature: 'signed-thinking',
          },
          {
            type: 'tool_use',
            id: 'tool-thinking-1',
            name: 'search',
            input: { query: 'rain' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-thinking-1',
            content: '{"matches":[]}',
            is_error: false,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Keep the continuation inside the established world.',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });
});

describe('Anthropic image input', () => {
  it('sends one-shot images as base64 image blocks before the question', async () => {
    let body: { messages?: Array<{ role: string; content: unknown }> } | undefined;
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(sse([
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '灯塔。' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' },
        ]));
      },
    });
    await collect(driver, request({
      lifecycle: 'single_request',
      tools: [],
      context: {
        systemPrompt: 'Look.',
        messages: [{
          type: 'model_message',
          sourceIds: ['vision/1'],
          message: { role: 'user', content: '这是什么？', images: [{ mediaType: 'image/png', data: 'BBBB' }] },
        }],
      },
    }));
    const content = body?.messages?.[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } });
    expect(content[1]).toMatchObject({ type: 'text', text: '这是什么？' });
  });
});

describe('Anthropic default fetch', () => {
  it('calls the global fetch on the window, as WebKit requires', async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Can only call Window.fetch on instances of Window');
      }
      called = true;
      return Promise.resolve(new Response(sse([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ])));
    } as typeof fetch;
    try {
      await collect(new AnthropicMessagesAgentDriver({ apiKey: 'test' }), request({ tools: [] }));
      expect(called).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('Anthropic hosted web search', () => {
  const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
  const WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
  const QUERY = '水浒传 拳打镇关西';
  const RESULTS = [
    {
      type: 'web_search_result',
      url: 'https://zh.wikisource.org/wiki/x',
      title: '水浒传/第三回',
      encrypted_content: 'opaque-result',
      page_age: null,
    },
  ];
  const CITATION = {
    type: 'web_search_result_location',
    url: 'https://zh.wikisource.org/wiki/x',
    title: '水浒传/第三回',
    encrypted_index: 'opaque-index',
    cited_text: '鲁提辖拳打镇关西',
  };

  function stopped(stopReason: string, usage: Record<string, number> = { output_tokens: 9 }) {
    return [
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage },
      { type: 'message_stop' },
    ];
  }

  function searchBlocks(first: number, id = 'srvtoolu_1', content: unknown = RESULTS) {
    return [
      { type: 'content_block_start', index: first, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: first, delta: { type: 'input_json_delta', partial_json: `{"query":"${QUERY}"}` } },
      { type: 'content_block_stop', index: first },
      { type: 'content_block_start', index: first + 1, content_block: { type: 'web_search_tool_result', tool_use_id: id, content } },
      { type: 'content_block_stop', index: first + 1 },
    ];
  }

  function bodiesFetch(responses: readonly string[], bodies: Record<string, unknown>[]) {
    return async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(responses[bodies.length - 1], { status: 200 });
    };
  }

  const endTurn = sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    ...stopped('end_turn'),
  ]);

  it.each([
    { label: 'auto', choice: undefined, offered: true },
    { label: 'a forced call', choice: { force: 'search' } as const, offered: true },
    { label: 'the none synthesis boundary', choice: 'none' as const, offered: true },
    { label: 'a required choice', choice: 'required' as const, offered: false },
  ])('is listed after the function tools for $label', async ({ choice, offered }) => {
    const bodies: Record<string, unknown>[] = [];
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'test', fetch: bodiesFetch([endTurn], bodies) });
    await collect(driver, request(choice ? { toolChoice: choice } : {}));
    const tools = bodies[0]?.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(offered ? ['search', 'web_search'] : ['search']);
    if (offered) expect(tools[1]).toEqual(WEB_SEARCH);
  });

  it('is not offered on a tool-free request', async () => {
    const bodies: Record<string, unknown>[] = [];
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'test', fetch: bodiesFetch([endTurn], bodies) });
    await collect(driver, request({ tools: [] }));
    expect(bodies[0]?.tools).toBeUndefined();
  });

  it('reports each search once and replays the response verbatim, thinking and citations included', async () => {
    const bodies: Record<string, unknown>[] = [];
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: bodiesFetch([
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look it up.' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-1' } },
          { type: 'content_block_stop', index: 0 },
          ...searchBlocks(1),
          { type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: 'Quote it.' } },
          { type: 'content_block_delta', index: 3, delta: { type: 'signature_delta', signature: 'signed-2' } },
          { type: 'content_block_stop', index: 3 },
          { type: 'content_block_start', index: 4, content_block: { type: 'text', text: '', citations: null } },
          { type: 'content_block_delta', index: 4, delta: { type: 'citations_delta', citation: CITATION } },
          { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: '原文在第三回。' } },
          { type: 'content_block_stop', index: 4 },
          { type: 'content_block_start', index: 5, content_block: { type: 'tool_use', id: 'tool-1', name: 'search', input: {} } },
          { type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: '{"query":"镇关西"}' } },
          { type: 'content_block_stop', index: 5 },
          ...stopped('tool_use', { output_tokens: 30, input_tokens: 2400, cache_read_input_tokens: 40 }),
        ]),
        endTurn,
      ], bodies),
    });

    const first = await collect(driver, request({ reasoning: { enabled: true } }));
    expect(first.filter((event) => event.type === 'provider_tool')).toEqual([
      { type: 'provider_tool', callId: 'srvtoolu_1', name: 'web_search', input: { query: QUERY }, ok: true },
    ]);
    expect(first).toContainEqual({ type: 'text_delta', text: '原文在第三回。' });
    expect(first).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 2400, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 0, costUsd: 0 },
    });
    expect(last(first)).toEqual({ type: 'finish', reason: 'tool_use' });

    await collect(driver, request({
      iteration: 2,
      reasoning: { enabled: true },
      context: {
        systemPrompt: 'Use only certified tools.',
        messages: [
          { type: 'model_message', sourceIds: ['u1'], message: { role: 'user', content: 'Search rain.' } },
          {
            type: 'model_message',
            sourceIds: ['a1'],
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', text: 'Look it up.Quote it.' },
                { type: 'tool_call', callId: 'tool-1', name: 'search', arguments: { query: '镇关西' }, rawArguments: '{"query":"镇关西"}' },
              ],
            },
          },
          {
            type: 'model_message',
            sourceIds: ['t1'],
            message: { role: 'tool', content: [{ callId: 'tool-1', name: 'search', ok: true, content: '{"matches":[]}' }] },
          },
        ],
      },
    }));

    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Search rain.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Look it up.', signature: 'signed-1' },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: QUERY } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: RESULTS },
          { type: 'thinking', thinking: 'Quote it.', signature: 'signed-2' },
          { type: 'text', text: '原文在第三回。', citations: [CITATION] },
          { type: 'tool_use', id: 'tool-1', name: 'search', input: { query: '镇关西' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: '{"matches":[]}',
          is_error: false,
          cache_control: { type: 'ephemeral' },
        }],
      },
    ]);
    expect(JSON.stringify(bodies[1]?.tools)).toBe(JSON.stringify(bodies[0]?.tools));
  });

  it('reports a failed search as not ok and labels a deferred result with its earlier query', async () => {
    const bodies: Record<string, unknown>[] = [];
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: bodiesFetch([
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          ...searchBlocks(0, 'srvtoolu_err', { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }),
          // A search requested beside a client call runs in the next request.
          { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', id: 'srvtoolu_later', name: 'web_search', input: {} } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":"rain"}' } },
          { type: 'content_block_stop', index: 2 },
          { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tool-2', name: 'search', input: { query: 'rain' } } },
          { type: 'content_block_stop', index: 3 },
          ...stopped('tool_use'),
        ]),
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_later', content: [] } },
          { type: 'content_block_stop', index: 0 },
          ...stopped('end_turn'),
        ]),
      ], bodies),
    });
    const first = await collect(driver);
    expect(first.filter((event) => event.type === 'provider_tool')).toEqual([
      { type: 'provider_tool', callId: 'srvtoolu_err', name: 'web_search', input: { query: QUERY }, ok: false },
    ]);
    const second = await collect(driver, request({
      iteration: 2,
      context: {
        systemPrompt: 'Use only certified tools.',
        messages: [
          { type: 'model_message', sourceIds: ['u1'], message: { role: 'user', content: 'Search rain.' } },
          {
            type: 'model_message',
            sourceIds: ['a1'],
            message: {
              role: 'assistant',
              content: [{ type: 'tool_call', callId: 'tool-2', name: 'search', arguments: { query: 'rain' }, rawArguments: '{"query":"rain"}' }],
            },
          },
          {
            type: 'model_message',
            sourceIds: ['t1'],
            message: { role: 'tool', content: [{ callId: 'tool-2', name: 'search', ok: true, content: '[]' }] },
          },
        ],
      },
    }));
    expect(second.filter((event) => event.type === 'provider_tool')).toEqual([
      { type: 'provider_tool', callId: 'srvtoolu_later', name: 'web_search', input: { query: 'rain' }, ok: true },
    ]);
    const assistant = (bodies[1]?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>)[1]!;
    expect(assistant.content.map((block) => block.type)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
      'server_tool_use',
      'tool_use',
    ]);
  });

  it('resumes a paused search turn by sending the paused content back unchanged', async () => {
    const bodies: Record<string, unknown>[] = [];
    const driver = new AnthropicMessagesAgentDriver({
      apiKey: 'test',
      fetch: bodiesFetch([
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 50 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_p', name: 'web_search', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"query":"${QUERY}"}` } },
          { type: 'content_block_stop', index: 0 },
          ...stopped('pause_turn', { output_tokens: 5 }),
        ]),
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 70 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_p', content: RESULTS } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '找到了。' } },
          { type: 'content_block_stop', index: 1 },
          ...stopped('end_turn', { output_tokens: 6 }),
        ]),
      ], bodies),
    });

    const events = await collect(driver);
    expect(bodies).toHaveLength(2);
    expect(last(bodies[1]?.messages as unknown[])).toEqual({
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 'srvtoolu_p', name: 'web_search', input: { query: QUERY } }],
    });
    expect(JSON.stringify(bodies[1]?.tools)).toBe(JSON.stringify(bodies[0]?.tools));
    expect(events.filter((event) => event.type === 'provider_tool')).toEqual([
      { type: 'provider_tool', callId: 'srvtoolu_p', name: 'web_search', input: { query: QUERY }, ok: true },
    ]);
    expect(events.slice(-2)).toEqual([
      { type: 'usage', usage: { inputTokens: 120, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } },
      { type: 'finish', reason: 'end_turn' },
    ]);
  });

  it('gives up after a bounded number of pauses', async () => {
    const pausedResponse = () => sse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: `srvtoolu_${Math.random()}`, name: 'web_search', input: {} } },
      { type: 'content_block_stop', index: 0 },
      ...stopped('pause_turn'),
    ]);
    const fetchMock = vi.fn(async () => new Response(pausedResponse(), { status: 200 }));
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'test', fetch: fetchMock, providerAttemptRetry: NO_RETRY });
    const events = await collect(driver);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(last(events)).toEqual({ type: 'finish', reason: 'unknown' });
  });

  it('drops the tool for the key and model when the organization has disabled web search', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools: Array<Record<string, unknown>> };
      bodies.push(body);
      if (body.tools.some((tool) => tool.name === 'web_search')) {
        return new Response(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Web search is not enabled for this organization.' },
        }), { status: 400 });
      }
      return new Response(endTurn, { status: 200 });
    });
    const options = { apiKey: 'org-without-web-search', fetch: fetchMock, providerAttemptRetry: NO_RETRY };
    expect(last(await collect(new AnthropicMessagesAgentDriver(options))))
      .toEqual({ type: 'finish', reason: 'end_turn' });
    expect(bodies.map((body) => (body.tools as Array<{ name: string }>).map((tool) => tool.name)))
      .toEqual([['search', 'web_search'], ['search']]);

    // The next turn builds a fresh driver; the refusal is remembered.
    await collect(new AnthropicMessagesAgentDriver(options));
    expect(bodies).toHaveLength(3);
    expect((bodies[2]?.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(['search']);
  });

  it('does not retry an unrelated 400 without the tool', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' },
    }), { status: 400 }));
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'test', fetch: fetchMock, providerAttemptRetry: NO_RETRY });
    await expect(collect(driver)).rejects.toThrow('Anthropic request failed.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
