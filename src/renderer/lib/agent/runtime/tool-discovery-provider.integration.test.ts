import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from './runtime';
import { OpenAIResponsesAgentDriver } from './drivers/openai-responses-driver';
import { AnthropicMessagesAgentDriver } from './drivers/anthropic-messages-driver';
import { OpenAICompatibleCompletionDriver } from './drivers/openai-compatible-completion-driver';
import type { AICompletionRequest } from '../../ai/types';
import type { AgentModelDriver, AgentToolDefinition } from './types';

const definitions: AgentToolDefinition[] = ['read_element', 'revise_element'].map((name) => ({
  name, access: name.startsWith('read') ? 'read' : 'write', description: 'Synthetic element operation',
  inputSchema: { type: 'object', properties: { element: { type: 'string' }, syntheticReplacement: { type: 'string' } }, required: ['element'] },
  validateInput: (args) => ({ ok: true, value: args }),
}));
function invocation(index: number) {
  return index === 0
    ? { name: 'tool_search', arguments: { names: ['read_element', 'revise_element'] } }
    : { name: 'call_tool', arguments: { name: index === 1 ? 'read_element' : 'revise_element', arguments: { element: 'Fixture' } } };
}
async function run(driver: AgentModelDriver, reasoning = false) {
  const execute = vi.fn(async () => ({ ok: true as const, data: 'Synthetic result' }));
  const runtime = new AgentRuntime({ driver, toolDiscovery: () => true, tools: { listDefinitions: () => definitions, execute } });
  const result = await runtime.runTurn({ sessionId: 'session-provider-discovery', turnId: 'turn-discovery', route: { kind: 'test' }, prompt: '继续改', systemPrompt: 'Use the tools.', reasoning: { enabled: reasoning }, limits: { maxModelIterations: 4 } });
  expect(result.state.status, JSON.stringify(result.state.terminal)).toBe('completed');
  expect(execute.mock.calls).toHaveLength(2);
  expect(result.messages.flatMap((message) => message.role === 'tool' ? message.content.map((entry) => entry.name) : [])).toEqual(['tool_search', 'read_element', 'revise_element']);
}
function sse(events: object[]) { return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''); }

describe('Fixed discovery prefix on provider wires', () => {
  it.each(['openai', 'openai-codex'] as const)('preserves %s schemas, call IDs and encrypted reasoning through search/read/write/synthesis', async (provider) => {
    const bodies: Array<Record<string, unknown>> = [];
    const driver = new OpenAIResponsesAgentDriver({ provider, providerAttemptRetry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false }, transport: {
      request: async (body) => {
        const index = bodies.length;
        bodies.push(JSON.parse(body));
        if (index === 3) return new Response(sse([
          { type: 'response.output_text.delta', delta: 'Done.' },
          { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 1 } } },
        ]));
        const call = invocation(index);
        const reasoning = { id: `reasoning-${index}`, type: 'reasoning', encrypted_content: `opaque-${index}`, summary: [] };
        const item = { id: `item-${index}`, type: 'function_call', call_id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.arguments) };
        return new Response(sse([
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: item.id, delta: item.arguments },
          { type: 'response.output_item.done', output_index: 1, item },
          { type: 'response.completed', response: { status: 'completed', output: provider === 'openai-codex' ? [] : [reasoning, item], usage: { input_tokens: 10, output_tokens: 1 } } },
        ]));
      },
    } });
    await run(driver, true);
    expect(bodies).toHaveLength(4);
    expect(bodies.every((body) => JSON.stringify(body.tools) === JSON.stringify(bodies[0]!.tools))).toBe(true);
    expect(bodies.every((body) => body.instructions === bodies[0]!.instructions)).toBe(true);
    expect(JSON.stringify(bodies[0]!.tools)).not.toContain('syntheticReplacement');
    expect(JSON.stringify(bodies[1]!.input)).toContain('syntheticReplacement');
    expect(JSON.stringify(bodies[2]!.input)).toContain('opaque-1');
    expect(bodies[2]!.input).toContainEqual(expect.objectContaining({ type: 'function_call', name: 'call_tool', call_id: 'call-1' }));
    expect(bodies[3]!.tool_choice).toBe('none');
  });

  it('keeps the Anthropic tool cache prefix while tool results carry schemas', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const driver = new AnthropicMessagesAgentDriver({ apiKey: 'synthetic', providerAttemptRetry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false }, fetch: async (_input, init) => {
      const index = bodies.length;
      bodies.push(JSON.parse(String(init?.body)));
      const events: object[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }];
      if (index < 3) {
        const call = invocation(index);
        events.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${index}`, name: call.name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } },
          { type: 'content_block_stop', index: 0 },
        );
      } else {
        events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }, { type: 'content_block_stop', index: 0 });
      }
      events.push({ type: 'message_delta', delta: { stop_reason: index < 3 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
      return new Response(sse(events));
    } });
    await run(driver);
    expect(bodies.every((body) => JSON.stringify(body.tools) === JSON.stringify(bodies[0]!.tools))).toBe(true);
    expect(bodies.every((body) => JSON.stringify(body.system) === JSON.stringify(bodies[0]!.system))).toBe(true);
    expect(JSON.stringify(bodies[0]!.tools)).not.toContain('syntheticReplacement');
    expect(JSON.stringify(bodies[1]!.messages)).toContain('syntheticReplacement');
    expect(JSON.stringify(bodies[2]!.messages)).toContain('call_tool');
    expect(bodies[3]!.tool_choice).toEqual({ type: 'none' });
  });

  it('keeps compatible completion definitions fixed and forwards synthesis none', async () => {
    const requests: AICompletionRequest[] = [];
    const driver = new OpenAICompatibleCompletionDriver({ defaultModel: 'fixture', client: {
      supportsTools: true,
      async complete(request) {
        const index = requests.length;
        requests.push(request);
        const tool = invocation(index);
        return index < 3 ? { text: '', toolCalls: [{ id: `call-${index}`, name: tool.name, arguments: tool.arguments }], finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 1 } }
          : { text: 'Done.', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } };
      },
    } });
    await run(driver);
    expect(requests.every((request) => JSON.stringify(request.tools) === JSON.stringify(requests[0]!.tools))).toBe(true);
    expect(requests[3]!.toolChoice).toBe('none');
    expect(JSON.stringify(requests[1]!.messages)).toContain('syntheticReplacement');
  });
});
