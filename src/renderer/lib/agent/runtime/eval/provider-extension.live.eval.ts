import { describe, expect, it } from 'vitest';

import { LLMClient } from '../../../ai/client/llm-client';
import { DeepSeekProvider } from '../../../ai/client/providers/deepseek';
import type { AgentProviderId } from '../agent-provider-contract';
import { agentProviderOption } from '../agent-provider-contract';
import { planAgentModelContext } from '../context-message-adapter';
import { AnthropicMessagesAgentDriver } from '../drivers/anthropic-messages-driver';
import { OpenAICompatibleCompletionDriver } from '../drivers/openai-compatible-completion-driver';
import { OpenAIResponsesAgentDriver } from '../drivers/openai-responses-driver';
import type {
  AgentAssistantToolCallBlock,
  AgentModelDriver,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelStreamEvent,
} from '../types';

const enabled = process.env.DRIFTING_AGENT_PROVIDER_CANARY === '1';
const provider = (process.env.DRIFTING_AGENT_LIVE_PROVIDER ?? 'deepseek') as AgentProviderId;

describe.skipIf(!enabled)('General Agent live provider canary', () => {
  it('streams one schema-valid tool call with terminal usage', { timeout: 120_000 }, async () => {
    expect(['deepseek', 'anthropic', 'openai']).toContain(provider);
    const model = process.env.DRIFTING_AGENT_LIVE_MODEL ?? agentProviderOption(provider).models[0]!.value;
    const driver = makeDriver(provider, model, requiredKey(provider));
    const request: AgentModelRequest = {
      sessionId: 'provider-canary-session',
      turnId: 'provider-canary-turn',
      iteration: 1,
      provider,
      model,
      context: {
        systemPrompt: 'Call echo exactly once with text="provider-canary". Do not answer in prose.',
        messages: [
          {
            type: 'model_message',
            sourceIds: ['provider-canary/user'],
            message: { role: 'user', content: 'Run the required canary tool now.' },
          },
        ],
      },
      tools: [
        {
          name: 'echo',
          description: 'Return a canary string.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', const: 'provider-canary' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
      maxOutputTokens: 256,
      reasoning: { enabled: false },
      signal: new AbortController().signal,
    };
    const events: AgentModelStreamEvent[] = [];
    for await (const event of driver.stream(request)) events.push(event);
    const starts = events.filter((event) => event.type === 'tool_call_start');
    expect(starts).toEqual([expect.objectContaining({ name: 'echo' })]);
    const callId = starts[0]!.callId;
    let argumentsJson = '';
    for (const event of events) {
      if (event.type === 'tool_args_delta' && event.callId === callId) {
        argumentsJson += event.delta;
      }
    }
    expect(JSON.parse(argumentsJson)).toEqual({ text: 'provider-canary' });
    expect(events.filter((event) => event.type === 'tool_call_end' && event.callId === callId)).toHaveLength(1);
    expect(events.some((event) => event.type === 'usage' && event.usage.outputTokens > 0)).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: 'finish' });
  });

  it.skipIf(provider !== 'openai')(
    'completes a reasoning-on parallel read, durable write and final replay with Luna',
    { timeout: 180_000 },
    async () => {
      const model = process.env.DRIFTING_AGENT_LIVE_MODEL ?? 'gpt-5.6-luna';
      const driver = makeDriver('openai', model, requiredKey('openai'));
      const systemPrompt = [
        'This is a deterministic parallel replay canary.',
        'First emit exactly three read_object calls in one response, one for each target:',
        'canary-a, canary-b, canary-c. Do not wait between them.',
        'After their results, call write_object exactly once for canary-b.',
        'After the write result, answer exactly: parallel-replay-complete',
      ].join(' ');
      const userMessage: AgentModelMessage = {
        role: 'user',
        content: 'Run every canary stage now.',
      };
      const readTool = {
        name: 'read_object',
        description: 'Read one synthetic canary object.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['canary-a', 'canary-b', 'canary-c'] },
          },
          required: ['target'],
          additionalProperties: false,
        },
      };
      const writeTool = {
        name: 'write_object',
        description: 'Write the synthetic middle canary object.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', const: 'canary-b' },
            body: { type: 'string', const: 'updated-canary-b' },
          },
          required: ['target', 'body'],
          additionalProperties: false,
        },
      };
      const baseRequest = {
        sessionId: 'provider-parallel-replay-session',
        turnId: 'provider-parallel-replay-turn',
        provider: 'openai',
        model,
        maxOutputTokens: 512,
        reasoning: { enabled: true, effort: 'low' as const },
        signal: new AbortController().signal,
      };

      const readEvents = await collectEvents(driver, {
        ...baseRequest,
        iteration: 1,
        context: providerContext(systemPrompt, [userMessage]),
        tools: [readTool],
        toolChoice: 'required',
      });
      const readCalls = streamedToolCalls(readEvents);
      expect(readCalls).toHaveLength(3);
      expect(readCalls.every((call) => call.name === 'read_object')).toBe(true);
      expect(readCalls.map((call) => call.arguments.target).sort()).toEqual([
        'canary-a',
        'canary-b',
        'canary-c',
      ]);
      const readAssistant: AgentModelMessage = { role: 'assistant', content: readCalls };
      const readResults: AgentModelMessage = {
        role: 'tool',
        content: readCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          ok: true,
          content: `current-${String(call.arguments.target)}`,
        })),
      };

      const writeEvents = await collectEvents(driver, {
        ...baseRequest,
        iteration: 2,
        context: providerContext(systemPrompt, [userMessage, readAssistant, readResults]),
        tools: [writeTool],
        toolChoice: { force: 'write_object' },
      });
      const writeCalls = streamedToolCalls(writeEvents);
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]).toMatchObject({
        name: 'write_object',
        arguments: { target: 'canary-b', body: 'updated-canary-b' },
      });
      const writeCall = writeCalls[0]!;
      const canonicalMessages: AgentModelMessage[] = [
        userMessage,
        readAssistant,
        readResults,
        { role: 'assistant', content: [writeCall] },
        {
          role: 'tool',
          content: [
            {
              callId: writeCall.callId,
              name: writeCall.name,
              ok: true,
              content: 'canary-b updated durably',
            },
          ],
        },
      ];
      const planned = await planAgentModelContext({
        systemPrompt,
        messages: canonicalMessages,
        resolveToolAccess: (name) =>
          name === 'read_object' ? 'read' : name === 'write_object' ? 'write' : null,
        supplementalRows: [
          {
            sourceId: 'parallel-replay/write-receipt',
            turnOrdinal: 0,
            kind: 'write_receipt',
            content: 'canary-b was durably updated.',
            durableWriteCoverage: [
              {
                turnOrdinal: 0,
                callId: writeCall.callId,
                toolName: 'write_object',
              },
            ],
          },
        ],
        planner: {
          contextWindowTokens: 1_050_000,
          requestedOutputTokens: 512,
          fixedInputTokens: 0,
        },
      });
      if (!planned.ok) throw new Error(planned.error.message);
      const projectedReadCalls = planned.envelope.providerContext.messages.flatMap((entry) =>
        entry.type === 'model_message' && entry.message.role === 'assistant'
          ? entry.message.content.flatMap((block) =>
              block.type === 'tool_call' && block.name === 'read_object' ? [block.callId] : [],
            )
          : [],
      );
      expect(projectedReadCalls).toEqual(readCalls.map((call) => call.callId));

      const finalEvents = await collectEvents(driver, {
        ...baseRequest,
        iteration: 3,
        context: planned.envelope.providerContext,
        tools: [],
      });
      expect(
        finalEvents
          .flatMap((event) => (event.type === 'text_delta' ? [event.text] : []))
          .join('')
          .trim(),
      ).toBe('parallel-replay-complete');
      expect(finalEvents[finalEvents.length - 1]).toMatchObject({
        type: 'finish',
        reason: 'end_turn',
      });
    },
  );
});

async function collectEvents(
  driver: AgentModelDriver,
  request: AgentModelRequest,
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of driver.stream(request)) events.push(event);
  return events;
}

function providerContext(
  systemPrompt: string,
  messages: readonly AgentModelMessage[],
): AgentModelRequest['context'] {
  return {
    systemPrompt,
    messages: messages.map((message, index) => ({
      type: 'model_message',
      sourceIds: [`parallel-replay/message/${index}`],
      message,
    })),
  };
}

function streamedToolCalls(
  events: readonly AgentModelStreamEvent[],
): AgentAssistantToolCallBlock[] {
  const order: string[] = [];
  const calls = new Map<string, { name: string; rawArguments: string }>();
  for (const event of events) {
    if (event.type === 'tool_call_start') {
      order.push(event.callId);
      calls.set(event.callId, { name: event.name, rawArguments: '' });
    } else if (event.type === 'tool_args_delta') {
      const call = calls.get(event.callId);
      if (!call) throw new Error(`Tool arguments preceded call start: ${event.callId}`);
      call.rawArguments += event.delta;
    }
  }
  return order.map((callId) => {
    const call = calls.get(callId)!;
    return {
      type: 'tool_call',
      callId,
      name: call.name,
      arguments: JSON.parse(call.rawArguments) as Record<string, unknown>,
      rawArguments: call.rawArguments,
    };
  });
}

function requiredKey(id: AgentProviderId): string {
  const names: Record<AgentProviderId, string[]> = {
    deepseek: ['DEEPSEEK_AI_API_KEY', 'DEEPSEEK_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
  };
  const key = names[id].map((name) => process.env[name]).find(Boolean);
  if (!key) throw new Error(`Live ${id} canary requires ${names[id].join(' or ')}`);
  return key;
}

function makeDriver(id: AgentProviderId, model: string, apiKey: string): AgentModelDriver {
  if (id === 'anthropic') return new AnthropicMessagesAgentDriver({ apiKey, defaultModel: model });
  if (id === 'openai') return new OpenAIResponsesAgentDriver({ apiKey, defaultModel: model });
  const client = new LLMClient(
    new DeepSeekProvider({ apiKey, defaultModel: model, thinking: false }),
  );
  return new OpenAICompatibleCompletionDriver({
    client,
    defaultModel: model,
    id: `${id}-live-canary`,
    feature: 'general-agent',
    reasoningMode: 'deepseek',
  });
}
