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
import { runSuite, GOLDENS_DIR } from './runner/run-corpus';
import { goldenToProject, loadGoldenFile } from './runner/load-golden';
import { formatReport } from './score';
import { formatMetrics } from './runner/artifact';
import { realJudgeClient } from './review';

describe('corpus eval — cases as data', () => {
  // No key: the ci suite is the mechanical (banned-words) path, an exact regression
  // gate. Same numbers the old hand-coded mechanical test produced (TP=1/FP/FN=0/TN=2).
  test('ci suite (mock) — gate FP==0 && FN==0', async () => {
    const { result } = await runSuite('ci');
    console.log(formatReport(result));
    expect(result.tally.FP).toBe(0);
    expect(result.tally.FN).toBe(0);
  });

  // Structural (no key): the fog-harbor golden loads through the DATA path — bodySource
  // prose is read at runtime from FOG_HARBOR_DIR. Self-skips if the vault isn't present.
  test('fog-harbor golden loads via the data path (bodySource)', () => {
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
  test(
    'acceptance suite (deepseek) — precision / recall + metrics',
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[eval] 跳过 acceptance：未提供 DeepSeek key。\n');
        return;
      }
      const { result, metrics } = await runSuite('acceptance');
      console.log(formatReport(result));
      console.log(formatMetrics(metrics));
    },
    1_800_000,
  );
});
