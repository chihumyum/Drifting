/**
 * Data-driven corpus eval — the new entry. Cases live as DATA under corpus/
 * (goldens/*.json, datasets/*.jsonl, suites/*.json); this just runs a suite through
 * the generic runner. Adding/▸editing cases = editing data, never this file.
 *
 *   pnpm eval:corpus                                   # ci suite (mechanical, no key)
 *   VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:corpus   # + acceptance (real judge)
 */
import { vi, describe, test, expect } from 'vitest';

// Cut the only Electron-coupled subtree (BYOK keychain + capture interceptor); the
// judge takes its client as an argument, so the factory is never needed.
vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { join } from 'node:path';
import { runSuite, GOLDENS_DIR, HISTORY_PATH } from './runner/run-corpus';
import { goldenToProject, loadGoldenFile } from './runner/load-golden';
import { formatReport } from './score';
import { formatMetrics, formatTrend } from './runner/artifact';
import { realJudgeClient } from './review';

describe('corpus eval — cases as data', () => {
  // EVAL_SUITE=<id> runs ONLY that suite (below); unset runs the default battery
  // (ci + fog-harbor-load + acceptance). So `EVAL_SUITE=sample-screenplay` won't drag in others.
  const ONLY = process.env.EVAL_SUITE;

  // No key: the ci suite is the mechanical (banned-words) path, an exact regression
  // gate. Same numbers the old hand-coded mechanical test produced (TP=1/FP/FN=0/TN=2).
  // The suite's gate (maxFP/maxFN=0) is enforced by the runner.
  test.skipIf(!!ONLY)('ci suite (mock) — suite gate passes', async () => {
    const { result, gateViolations } = await runSuite('ci');
    console.log(formatReport(result));
    expect(gateViolations).toEqual([]);
  });

  // Structural (no key): the fog-harbor golden loads through the DATA path — bodySource
  // prose is read at runtime from FOG_HARBOR_DIR. Self-skips if the vault isn't present.
  test.skipIf(!!ONLY)('fog-harbor golden loads via the data path (bodySource)', () => {
    let project;
    try {
      project = goldenToProject(loadGoldenFile(join(GOLDENS_DIR, 'fog-harbor.golden.json')));
    } catch {
      console.warn('\n[eval] 跳过：未找到《雾港纪事》vault（设 FOG_HARBOR_DIR 指向 book-1）。\n');
      return;
    }
    expect(project.chapters).toHaveLength(4);
    for (const c of project.chapters) expect(c.blocks.length).toBeGreaterThan(0);
    expect(project.elements.length).toBeGreaterThanOrEqual(8);
    console.log(
      `\n[eval] fog-harbor via data: ${project.chapters
        .map((c) => `${c.id}(${c.blocks.length}段)`)
        .join(' ')} · ${project.elements.length} 元素\n`,
    );
  });

  // Key-gated: the acceptance suite through the real judge. Prints precision/recall +
  // run-level metrics (tokens / cost / latency); self-skips green without a key.
  test.skipIf(!!ONLY)(
    'acceptance suite (deepseek) — precision / recall + metrics',
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[eval] 跳过 acceptance：未提供 DeepSeek key。\n');
        return;
      }
      const { result, metrics, gateViolations } = await runSuite('acceptance', { artifact: true });
      console.log(formatReport(result));
      console.log(formatMetrics(metrics));
      console.log(formatTrend(HISTORY_PATH, 'acceptance'));
      if (gateViolations.length) console.warn(`[eval] gate 未过：${gateViolations.join(' · ')}`);
    },
    1_800_000,
  );

  // Run ANY suite by name: EVAL_SUITE=fog-harbor VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:corpus
  // Writes a run artifact + history. Skips (not fails) a deepseek suite when no key is set.
  test.runIf(!!ONLY)(
    `suite: ${ONLY ?? '(set EVAL_SUITE)'}`,
    async () => {
      try {
        const { result, metrics, gateViolations } = await runSuite(ONLY!, { artifact: true });
        console.log(formatReport(result));
        console.log(formatMetrics(metrics));
        console.log(formatTrend(HISTORY_PATH, ONLY!));
        if (gateViolations.length) console.warn(`[eval] gate 未过：${gateViolations.join(' · ')}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('DeepSeek key')) {
          console.warn(`\n[eval] 跳过 suite "${ONLY}"：需要 DeepSeek key。\n`);
          return;
        }
        throw e;
      }
    },
    1_800_000,
  );
});
