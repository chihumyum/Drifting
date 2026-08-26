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

    // Breakpoint 1: only the last tool schema carries the marker.
    const toolBlocks = second.tools as Array<Record<string, unknown>>;
    expect(toolBlocks.map((tool) => tool.cache_control)).toEqual([
      undefined,
      { type: 'ephemeral' },
    ]);
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
