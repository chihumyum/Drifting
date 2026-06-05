/**
 * Headless shadow eval — project-level. Clones a golden project in memory, applies
 * fault/dependency mutations, runs the REAL evaluator chain (evaluateRules + FC
 * judge), and scores findings against labels that are true by construction.
 *
 *   pnpm eval:shadow                                   # mechanical path only (no key)
 *   VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:shadow   # + semantic/dependency cases
 *   EVAL_REPEAT=3 VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:shadow   # + stability
 *
 * Each chapter review prints a ▶/✓ progress line (so a long run is visibly moving,
 * not a frozen spinner). Knobs: EVAL_CONCURRENCY (default 6 simultaneous reviews),
 * EVAL_CALL_TIMEOUT_MS (default 480000, abort a hung chapter; 0 = off), and for
 * 《雾港纪事》 EVAL_FP_SWEEP=1 to add the heavy 4-chapter false-positive sweep
 * (default runs only the fast targeted injections).
 */
import { vi, describe, test, expect } from 'vitest';

// Cut the only Electron-coupled subtree (BYOK keychain + capture interceptor);
// the judge takes its client as an argument, so the factory is never needed.
vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { goldenSample, deterministicMutations, sampleMutations } from './golden.sample';
import { loadFogHarborGolden, fog-harborMutations } from './golden.fog-harbor';
import { runEval, formatReport } from './score';
import { mockCleanClient, realJudgeClient } from './review';

const REPEAT = Math.max(1, Number(process.env.EVAL_REPEAT ?? '1') || 1);

function tryLoadFogHarbor() {
  try {
    return loadFogHarborGolden();
  } catch {
    return null; // vault not present on this machine — skip the real-novel cases
  }
}

describe('shadow eval — project clone + mutate + real evaluator chain', () => {
  // Always-on: the mechanical (banned-words) path is exact and LLM-free, so it's a
  // real headless regression gate with no key. mockCleanClient rules semantics
  // clean, leaving only the deterministic findings.
  test('mechanical path (no key) — banned-word caught, baseline clean', async () => {
    const result = await runEval(goldenSample(), deterministicMutations(), mockCleanClient());
    console.log(formatReport(result));
    expect(result.tally.FN).toBe(0); // the injected banned word was caught
    expect(result.tally.FP).toBe(0); // baseline stayed clean
  });

  // Key-gated: the full corpus through the real judge (semantic + dependency
  // changes). Prints precision/recall; does NOT hard-gate on probabilistic verdicts.
  test(
    'full corpus (real judge) — precision / recall',
    async () => {
      const client = realJudgeClient();
      if (!client) {
        console.warn(
          '\n[eval] 跳过语义/依赖用例：未提供 DeepSeek key。\n' +
            '  VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:shadow\n',
        );
        return;
      }
      const result = await runEval(goldenSample(), sampleMutations(), client, REPEAT);
      console.log(formatReport(result));
      // To gate once a baseline is trusted, e.g.: expect(result.tally.FP).toBeLessThanOrEqual(1);
    },
    600_000,
  );

  // Structural (no key): verify the real manuscript parses into the model.
  test('《雾港纪事》golden loads from the vault', () => {
    const golden = tryLoadFogHarbor();
    if (!golden) {
      console.warn('\n[eval] 跳过：未找到《雾港纪事》vault（设 FOG_HARBOR_DIR 指向 book-1）。\n');
      return;
    }
    expect(golden.chapters).toHaveLength(4);
    for (const c of golden.chapters) expect(c.blocks.length).toBeGreaterThan(0);
    expect(golden.elements.length).toBeGreaterThanOrEqual(8);
    console.log(
      `\n[eval] 《雾港纪事》golden: ${golden.chapters
        .map((c) => `${c.id}(${c.blocks.length}段)`)
        .join(' ')} · ${golden.elements.length} 个角色元素\n`,
    );
  });

  // The real thing (key-gated): POV head-hop + character consistency + dependency
  // change over the actual manuscript. Default = 5 targeted injections (fast, run
  // concurrently); add EVAL_FP_SWEEP=1 for the heavy clean-prose false-positive
  // sweep over all 4 chapters.
  test(
    '《雾港纪事》— POV / 角色一致性 / 依赖改动 (real judge)',
    async () => {
      const client = realJudgeClient();
      const golden = tryLoadFogHarbor();
      if (!client || !golden) {
        console.warn('\n[eval] 跳过《雾港纪事》语义评测：需要 DeepSeek key + vault。\n');
        return;
      }
      const result = await runEval(golden, fog-harborMutations(), client, REPEAT);
      console.log(formatReport(result));
    },
    1_800_000,
  );
});
