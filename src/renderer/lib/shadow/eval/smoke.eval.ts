/**
 * Import-graph smoke for the headless shadow-judge eval. Proves the FC judge
 * loads + runs under Vitest (node env) with no application shell or real LLM:
 *  - vi.mock cuts `build-default-client` (credentials + capture) because the FC
 *    path takes its client as an arg, so the factory is never needed here.
 *  - a MOCK LLMClient returns a canned `submit_verdicts` tool call, so the whole
 *    judge loop + verdict coercion runs deterministically, no key, no tokens.
 * If this passes, the real-corpus eval just swaps in a real DeepSeek client.
 */
import { vi, describe, test, expect } from 'vitest';

// Must be hoisted above the shadow-rules import. The factory is unused on the FC
// path; throwing makes any accidental use loud.
vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { evaluateSemanticAssertionsFC } from '../../ai/shadow-rules';
import { AGENT_READ_TOOLS, toAITools } from '../../agent/tool-registry';
import type { LLMClient } from '../../ai/client/llm-client';
import type { AICompletionResponse } from '../../ai/types';

// A canned client: ignores the prompt, returns one forced submit_verdicts call
// marking the given assertion indices (1-based) as violated.
function mockClient(violatedConstraints: number[]): LLMClient {
  const verdicts = violatedConstraints.map((constraint) => ({
    constraint,
    violations: [
      { violated: true, blockStart: 1, blockEnd: 1, reason: 'mock 违反', confidence: 0.9 },
    ],
  }));
  const complete = async (): Promise<AICompletionResponse> => ({
    text: '',
    toolCalls: [{ id: 'c1', name: 'submit_verdicts', arguments: { verdicts } }],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return { supportsTools: true, complete } as unknown as LLMClient;
}

describe('shadow judge eval — smoke', () => {
  const blocks = [
    { id: 'b1', text: '奥伦用左手握住了寒铁打造的青鳞剑。' },
    { id: 'b2', text: '他退后一步，警惕地望向门口。' },
  ];
  const readTools = toAITools(AGENT_READ_TOOLS);
  const noopRunTool = async () => ({ content: '（eval：无此工具）', status: 'denied' as const });

  test('clean case → no violations', async () => {
    const out = await evaluateSemanticAssertionsFC(
      ['全文保持第三人称限知视角，禁止头跳'],
      blocks,
      'eval-project',
      undefined,
      mockClient([]),
      readTools,
      noopRunTool,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(0);
  });

  test('injected violation → assertion 1 flagged', async () => {
    const out = await evaluateSemanticAssertionsFC(
      ['角色动作需符合设定（奥伦惯用左手）'],
      blocks,
      'eval-project',
      undefined,
      mockClient([1]),
      readTools,
      noopRunTool,
    );
    expect(out[0].length).toBeGreaterThan(0);
    expect(out[0][0].blockIds).toContain('b1');
  });
});
