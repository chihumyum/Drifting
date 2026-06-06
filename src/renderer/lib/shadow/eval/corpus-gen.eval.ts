/**
 * AI corpus growth — generate fault cases (as DATA), then certify them with an
 * INDEPENDENT model before they're trusted. Real generation needs a key; the
 * plumbing test runs with canned clients (no key).
 *
 *   VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:gen                       # generate + certify, print
 *   EVAL_WRITE_GENERATED=1 VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:gen   # also append certified
 */
import { vi, describe, test, expect } from 'vitest';

vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { join } from 'node:path';
import { GOLDENS_DIR, DATASETS_DIR } from './runner/run-corpus';
import { loadGoldenFile } from './runner/load-golden';
import { generateCases } from './runner/generate';
import { certifyAll } from './runner/certify';
import { appendCases } from './runner/load-corpus';
import { realJudgeClient } from './review';
import type { LLMClient } from '../../ai/client/llm-client';
import type { AICompletionResponse } from '../../ai/types';

// A canned client that returns one forced tool call with the given arguments.
function cannedClient(toolName: string, args: unknown): LLMClient {
  const complete = async (): Promise<AICompletionResponse> => ({
    text: '',
    toolCalls: [{ id: 'c1', name: toolName, arguments: args as Record<string, unknown> }],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return { supportsTools: true, complete } as unknown as LLMClient;
}

describe('corpus generation + certification', () => {
  // No key: prove generate → validate(drop invalid) → certify → enable, end to end.
  test('plumbing (canned) — invalid candidate dropped, valid one certified', async () => {
    const golden = loadGoldenFile(join(GOLDENS_DIR, 'sample.golden.json'));
    const gen = cannedClient('propose_faults', {
      cases: [
        {
          id: 'gen-1',
          op: 'injectBlock',
          params: { chapterId: 'ch1', text: '门外的黑衣人心中冷笑：奥伦必死。', ruleId: 'rule-pov' },
          expect: [{ chapterId: 'ch1', ruleId: 'rule-pov', shouldFlag: true }],
          rationale: 'head-hop',
        },
        {
          id: 'gen-bad',
          op: 'injectBlock',
          params: { chapterId: 'NOPE', text: 'x', ruleId: 'rule-pov' },
          expect: [{ chapterId: 'NOPE', ruleId: 'rule-pov', shouldFlag: true }],
          rationale: '引用了不存在的章节 → apply 抛错 → 应被丢弃',
        },
      ],
    });
    const cases = await generateCases(golden, gen);
    expect(cases.length).toBe(1); // the bad candidate (no chapter NOPE) is dropped
    expect(cases[0].enabled).toBe(false); // pending certification

    const certifier = cannedClient('certify', { verdict: 'clear-violation', confidence: 0.9, reason: 'mock' });
    const grown = await certifyAll(golden, cases, certifier);
    expect(grown[0].cert.certified).toBe(true);
    expect(grown[0].case.enabled).toBe(true); // flips on certification
  });

  // Key-gated: real generation + certification over the sample golden.
  test(
    'real generate + certify (deepseek)',
    async () => {
      const client = realJudgeClient();
      if (!client) {
        console.warn('\n[eval] 跳过：未提供 DeepSeek key。\n');
        return;
      }
      const golden = loadGoldenFile(join(GOLDENS_DIR, 'sample.golden.json'));
      const cases = await generateCases(golden, client, { n: 5 });
      console.log(`[gen] ${cases.length} 个候选通过结构校验`);
      const grown = await certifyAll(golden, cases, client);
      for (const g of grown) {
        console.log(
          `  ${g.cert.certified ? '✓' : '✗'} ${g.case.id} [${g.cert.verdict} ${g.cert.confidence}] ${g.case.op} — ${g.cert.reason}`,
        );
      }
      const certified = grown.filter((g) => g.cert.certified).map((g) => g.case);
      console.log(`[gen] 认证通过 ${certified.length}/${grown.length}`);
      if (process.env.EVAL_WRITE_GENERATED === '1' && certified.length) {
        appendCases(join(DATASETS_DIR, 'sample.generated.jsonl'), certified);
        console.log('[gen] 已写入 sample.generated.jsonl（enabled:true）');
      }
    },
    600_000,
  );
});
