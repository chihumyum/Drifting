import { describe, expect, it, vi } from 'vitest';

import type { AgentModelRequest, AgentModelStreamEvent } from '../types';
import { OpenAIResponsesAgentDriver } from './openai-responses-driver';

function request(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    iteration: 1,
    provider: 'openai',
    model: 'gpt-5.6-sol',
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
    reasoning: { enabled: true, effort: 'max' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  driver: OpenAIResponsesAgentDriver,
  input: AgentModelRequest,
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of driver.stream(input)) events.push(event);
  return events;
}

function sse(events: readonly Record<string, unknown>[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

describe('OpenAI Responses Agent driver', () => {
  it('maps a forced completion tool to Responses tool_choice', async () => {
    let body: Record<string, unknown> | undefined;
    const driver = new OpenAIResponsesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          sse([
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ]),
          { status: 200 },
        );
      },
    });

    await collect(
      driver,
      request({ reasoning: { enabled: false }, toolChoice: { force: 'search' } }),
    );

    expect(body?.tool_choice).toEqual({ type: 'function', name: 'search' });
  });

  it('serializes a required action with reasoning effort none for one sample', async () => {
    let body: Record<string, unknown> | undefined;
    const driver = new OpenAIResponsesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          sse([
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ]),
          { status: 200 },
        );
      },
    });

    await collect(
      driver,
      request({
        executionMode: 'required_tool_non_reasoning',
        toolChoice: 'required',
      }),
    );

    expect(body?.tool_choice).toBe('required');
    expect(body?.reasoning).toEqual({ effort: 'none' });
    expect(body).not.toHaveProperty('include');
  });

  it('uses GPT-5.6 Responses reasoning and replays encrypted reasoning items across tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    const reasoningItem = {
      id: 'rs_1',
      type: 'reasoning',
      encrypted_content: 'encrypted-active-turn-state',
      summary: [{ type: 'summary_text', text: 'Need to search.' }],
    };
    const functionItem = {
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call-1',
      name: 'search',
      arguments: '{"query":"rain"}',
      status: 'completed',
    };
    let call = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return new Response(
          sse([
            {
              type: 'response.reasoning_summary_text.delta',
              delta: 'Need to search.',
            },
            {
              type: 'response.output_item.added',
              item: {
                id: 'fc_1',
                type: 'function_call',
                call_id: 'call-1',
                name: 'search',
                arguments: '',
              },
            },
            {
              type: 'response.function_call_arguments.delta',
              item_id: 'fc_1',
              delta: '{"query":"rain"}',
            },
            { type: 'response.output_item.done', item: functionItem },
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [reasoningItem, functionItem],
                usage: {
                  input_tokens: 40,
                  output_tokens: 12,
                  input_tokens_details: { cached_tokens: 7 },
                },
              },
            },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        sse([
          { type: 'response.output_text.delta', delta: 'Found it.' },
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  id: 'msg_2',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Found it.', annotations: [] }],
                },
              ],
              usage: { input_tokens: 55, output_tokens: 8 },
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const driver = new OpenAIResponsesAgentDriver({
      apiKey: 'openai-test-key',
      endpoint: 'https://openai.test/v1/responses',
      fetch: fetchMock,
    });

    await expect(collect(driver, request())).resolves.toEqual([
      { type: 'thinking_delta', text: 'Need to search.' },
      { type: 'tool_call_start', callId: 'call-1', name: 'search' },
      { type: 'tool_args_delta', callId: 'call-1', delta: '{"query":"rain"}' },
      { type: 'tool_call_end', callId: 'call-1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 40,
          outputTokens: 12,
          cacheReadTokens: 7,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'tool_use' },
    ]);

    await expect(
      collect(
        driver,
        request({
          iteration: 2,
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
                sourceIds: ['message/assistant/1/thinking', 'message/assistant/1/tool'],
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'thinking', text: 'Need to search.' },
                    {
                      type: 'tool_call',
                      callId: 'call-1',
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
                      callId: 'call-1',
                      name: 'search',
                      ok: true,
                      content: '{"matches":["rain"]}',
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    ).resolves.toEqual([
      { type: 'text_delta', text: 'Found it.' },
      {
        type: 'usage',
        usage: {
          inputTokens: 55,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      },
      { type: 'finish', reason: 'end_turn' },
    ]);

    expect(bodies[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'max', summary: 'auto', context: 'current_turn' },
      tool_choice: 'auto',
    });
    expect(bodies[1]?.input).toEqual([
      { role: 'user', content: 'Search rain.' },
      reasoningItem,
      functionItem,
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"matches":["rain"]}',
      },
    ]);
  });

  it('maps thinking off to reasoning effort none without requesting encrypted state', async () => {
    let body: Record<string, unknown> | undefined;
    const driver = new OpenAIResponsesAgentDriver({
      apiKey: 'test',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          sse([
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ]),
          { status: 200 },
        );
      },
    });
    await collect(
      driver,
      request({ tools: [], reasoning: { enabled: false, effort: 'high' } }),
    );
    expect(body?.reasoning).toEqual({ effort: 'none' });
    expect(body).not.toHaveProperty('include');
  });

  it('does not leak an authentication response body', async () => {
    const driver = new OpenAIResponsesAgentDriver({
      apiKey: 'secret-key',
      fetch: async () =>
        new Response('Bearer secret-key at https://internal.invalid', { status: 401 }),
    });
    await expect(collect(driver, request())).rejects.toThrow(
      'OpenAI authentication failed.',
    );
  });
});
