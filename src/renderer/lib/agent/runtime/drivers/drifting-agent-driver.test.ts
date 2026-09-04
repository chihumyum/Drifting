import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => false),
  request: vi.fn(),
  codexRequest: vi.fn(),
}));

vi.mock('../../../../platform', () => ({
  isTauriRuntime: nativeMocks.isTauriRuntime,
  platform: {
    openAIResponses: { request: nativeMocks.request },
    codexSubscription: { request: nativeMocks.codexRequest },
  },
}));
import { AIError } from '../../../ai/types';
import { publicModelDriverErrorMessage } from '../errors';
import type { AgentModelRequest, AgentModelStreamEvent } from '../types';
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

async function collect(driver: DriftingAgentModelDriver): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of driver.stream(request())) events.push(event);
  return events;
}

describe('DriftingAgentModelDriver', () => {
  beforeEach(() => {
    nativeMocks.isTauriRuntime.mockReturnValue(false);
    nativeMocks.request.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
        throw new AIError('auth', 'Bearer sk-live-secret https://provider.invalid');
      },
    });

    let caught: unknown;
    try {
      await collect(driver);
    } catch (error) {
      caught = error;
    }
    const message = publicModelDriverErrorMessage(caught);
    expect(message).toBe('General Agent needs a configured DeepSeek API key.');
    expect(message).not.toContain('sk-live-secret');
    expect(message).not.toContain('provider.invalid');
  });

  it('rejects every selected provider before construction while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const createProviderDriver = vi.fn();
    const driver = new DriftingAgentModelDriver({ createProviderDriver });

    await expect(collect(driver)).rejects.toThrow('while offline');
    expect(createProviderDriver).not.toHaveBeenCalled();
    expect(nativeMocks.request).not.toHaveBeenCalled();
  });

  it('keeps workload attribution for a General Agent review task', async () => {
    const complete = vi.fn(async () => ({
      text: 'ready',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 1 },
    }));
    const driver = new DriftingAgentModelDriver({
      featureLabel: 'General Agent',
      feature: 'general-review',
      createClient: async () => ({ supportsTools: true, complete }),
    });

    await collect(driver);

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ feature: 'general-review' }) }),
    );
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

  it('routes OpenAI through native Responses transport inside Tauri', async () => {
    nativeMocks.isTauriRuntime.mockReturnValue(true);
    nativeMocks.request.mockResolvedValue(
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
    );
    const driver = new DriftingAgentModelDriver();
    const events: AgentModelStreamEvent[] = [];

    for await (const event of driver.stream({
      ...request(),
      provider: 'openai',
      model: 'gpt-5.6-luna',
    })) {
      events.push(event);
    }

    expect(nativeMocks.request).toHaveBeenCalledOnce();
    expect(JSON.parse(nativeMocks.request.mock.calls[0]![0])).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: true,
      store: false,
    });
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'end_turn' });
  });

  it('routes the ChatGPT subscription through the native Codex transport inside Tauri', async () => {
    nativeMocks.isTauriRuntime.mockReturnValue(true);
    nativeMocks.codexRequest.mockReset();
    nativeMocks.codexRequest.mockResolvedValue(
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n',
        { status: 200 },
      ),
    );
    const driver = new DriftingAgentModelDriver();
    const events: AgentModelStreamEvent[] = [];

    for await (const event of driver.stream({
      ...request(),
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
    })) {
      events.push(event);
    }

    expect(nativeMocks.request).not.toHaveBeenCalled();
    expect(nativeMocks.codexRequest).toHaveBeenCalledOnce();
    expect(JSON.parse(nativeMocks.codexRequest.mock.calls[0]![0])).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: true,
      store: false,
    });
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'end_turn' });
  });

  it('refuses the ChatGPT subscription route outside the native runtime', async () => {
    nativeMocks.isTauriRuntime.mockReturnValue(false);
    nativeMocks.codexRequest.mockReset();
    const driver = new DriftingAgentModelDriver();

    const stream = driver.stream({
      ...request(),
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      'only inside the native Drifting app',
    );
    expect(nativeMocks.codexRequest).not.toHaveBeenCalled();
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

  it('isolates one-shot internal calls from the active turn reasoning cache', async () => {
    let created = 0;
    const createProviderDriver = vi.fn(async () => {
      created += 1;
      const instance = created;
      return {
        id: `fixture-${instance}`,
        capabilities: { reasoning: true },
        async *stream(input: AgentModelRequest): AsyncIterable<AgentModelStreamEvent> {
          yield { type: 'text_delta', text: `driver-${instance}` };
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
            reason:
              input.lifecycle === 'single_request' || input.iteration === 1
                ? 'tool_use'
                : 'end_turn',
          };
        },
      };
    });
    const driver = new DriftingAgentModelDriver({ createProviderDriver });
    const run = async (input: AgentModelRequest) => {
      const events: AgentModelStreamEvent[] = [];
      for await (const event of driver.stream(input)) events.push(event);
      return events;
    };

    const first = await run(request());
    const compactor = await run({
      ...request(),
      lifecycle: 'single_request',
      iteration: 0,
      reasoning: { enabled: true, effort: 'high' },
    });
    const second = await run({ ...request(), iteration: 2 });

    expect(first[0]).toEqual({ type: 'text_delta', text: 'driver-1' });
    expect(compactor[0]).toEqual({ type: 'text_delta', text: 'driver-2' });
    expect(second[0]).toEqual({ type: 'text_delta', text: 'driver-1' });
    expect(createProviderDriver).toHaveBeenCalledTimes(2);
  });
});
