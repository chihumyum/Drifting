import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic';

describe('AnthropicProvider', () => {
  it('uses a forced tool as the typed one-shot output channel', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'claude-sonnet-5',
        tool_choice: { type: 'tool', name: 'return_result' },
      });
      expect(body.tools[0]).toMatchObject({
        name: 'return_result',
        input_schema: { type: 'object' },
      });
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'return_result',
              input: { ok: true },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const provider = new AnthropicProvider({ apiKey: 'test-key', fetch });

    await expect(
      provider.complete({
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'check' }],
        tools: [
          {
            name: 'return_result',
            description: 'return result',
            parametersSchema: { type: 'object' },
          },
        ],
      }),
    ).resolves.toMatchObject({
      toolCall: { id: 'tool-1', name: 'return_result', arguments: { ok: true } },
      finishReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 4, cachedTokens: 3 },
    });
  });
});
