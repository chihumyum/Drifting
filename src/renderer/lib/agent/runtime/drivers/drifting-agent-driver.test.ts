import { describe, expect, it, vi } from 'vitest';
import { AIError } from '../../../ai/types';
import { publicModelDriverErrorMessage } from '../errors';
import type {
  AgentModelRequest,
  AgentModelStreamEvent,
} from '../types';
import { DriftingAgentModelDriver } from './drifting-agent-driver';

function request(): AgentModelRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    iteration: 1,
    context: {
      systemPrompt: 'system',
      messages: [
        {
          type: 'model_message',
          sourceIds: ['test/model-message/0'],
          message: { role: 'user', content: 'hello' },
        },
      ],
    },
    tools: [],
    maxOutputTokens: 256,
    reasoning: { enabled: false },
    signal: new AbortController().signal,
  };
}

async function collect(
  driver: DriftingAgentModelDriver,
): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of driver.stream(request())) events.push(event);
  return events;
}

describe('DriftingAgentModelDriver', () => {
  it('resolves credentials lazily and builds a fresh client for each turn', async () => {
    const createClient = vi.fn(async () => ({
      supportsTools: true,
      complete: async () => ({
        text: 'ready',
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1 },
      }),
    }));
    const driver = new DriftingAgentModelDriver({ createClient });

    expect(createClient).not.toHaveBeenCalled();
    await expect(collect(driver)).resolves.toEqual([
      { type: 'text_delta', text: 'ready' },
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
    await collect(driver);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('maps credential initialization failures without exposing provider details', async () => {
    const driver = new DriftingAgentModelDriver({
      createClient: async () => {
        throw new AIError(
          'auth',
          'Bearer sk-live-secret https://provider.invalid',
        );
      },
    });

    let caught: unknown;
    try {
      await collect(driver);
    } catch (error) {
      caught = error;
    }
    const message = publicModelDriverErrorMessage(caught);
    expect(message).toBe(
      'General Agent needs a configured DeepSeek API key.',
    );
    expect(message).not.toContain('sk-live-secret');
    expect(message).not.toContain('provider.invalid');
  });

  it.each([
    ['deepseek', 'deepseek-v4-pro'],
    ['anthropic', 'claude-haiku-4-5-20251001'],
    ['openai', 'gpt-5.6-terra'],
  ] as const)('routes %s with an immutable provider/model pair', async (provider, model) => {
    const createProviderDriver = vi.fn(async () => ({
      id: `fixture-${provider}`,
      async *stream(input: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
        yield { type: 'text_delta', text: `${String(input.provider)}:${String(input.model)}` };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
        };
        yield { type: 'finish', reason: 'end_turn' };
      },
    }));
    const driver = new DriftingAgentModelDriver({ createProviderDriver });
    const events: AgentModelStreamEvent[] = [];
    for await (const event of driver.stream({ ...request(), provider, model })) events.push(event);
    expect(createProviderDriver).toHaveBeenCalledWith(provider, model);
    expect(events[0]).toEqual({ type: 'text_delta', text: `${provider}:${model}` });
  });

  it('rejects a model from another provider before constructing a client', async () => {
    const createProviderDriver = vi.fn();
    const driver = new DriftingAgentModelDriver({ createProviderDriver });
    const run = async () => {
      const stream = driver.stream({
        ...request(),
        provider: 'anthropic',
        model: 'gpt-5.6-sol',
      });
      await stream[Symbol.asyncIterator]().next();
    };
    await expect(run()).rejects.toThrow('does not belong');
    expect(createProviderDriver).not.toHaveBeenCalled();
  });

  it('reuses one provider driver across tool iterations and releases it at turn end', async () => {
    const createProviderDriver = vi.fn(async () => ({
      id: 'fixture-deepseek',
      capabilities: { reasoning: true },
      async *stream(input: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
        };
        yield {
          type: 'finish',
          reason: input.iteration === 1 ? 'tool_use' : 'end_turn',
        };
      },
    }));
    const driver = new DriftingAgentModelDriver({ createProviderDriver });
    const run = async (iteration: number) => {
      const events: AgentModelStreamEvent[] = [];
      for await (const event of driver.stream({ ...request(), iteration })) {
        events.push(event);
      }
      return events;
    };

    await run(1);
    await run(2);
    await run(1);
    expect(createProviderDriver).toHaveBeenCalledTimes(2);
  });
});
