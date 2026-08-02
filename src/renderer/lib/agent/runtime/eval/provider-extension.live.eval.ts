import { describe, expect, it } from 'vitest';

import { LLMClient } from '../../../ai/client/llm-client';
import { DeepSeekProvider } from '../../../ai/client/providers/deepseek';
import type { AgentProviderId } from '../agent-provider-contract';
import { agentProviderOption } from '../agent-provider-contract';
import { AnthropicMessagesAgentDriver } from '../drivers/anthropic-messages-driver';
import { OpenAICompatibleCompletionDriver } from '../drivers/openai-compatible-completion-driver';
import { OpenAIResponsesAgentDriver } from '../drivers/openai-responses-driver';
import type { AgentModelDriver, AgentModelRequest, AgentModelStreamEvent } from '../types';

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
});

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
