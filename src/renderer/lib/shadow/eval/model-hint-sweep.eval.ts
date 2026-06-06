/**
 * Hint-level sweep — the dep-only suite across the three hint levels, with the
 * positives and controls split into the buckets that matter:
 *
 *   positives  直陈(verbatim)    — prose states the fact; diff ≈ string match
 *              间接(consequence) — prose only implies the fact; diff needs reasoning
 *   controls   无关(irrelevant)  — an unrelated canon change → must stay clean
 *              假flag(false-flag) — a RELEVANT but consistent rewrite → must stay clean
 *                                   (the production FP bomb: does a diff induce a flag?)
 *
 * Levels: 冷启动(off) → 指针(pointer) → diff(old→new value). One model by default
 * (flash). Add models with EVAL_MODELS=flash-id,pro-id if you want the grid back.
 *
 *   EVAL_REPEAT=3 VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:model-hint-sweep
 *
 * Cost is DeepSeek placeholder rates (token-driven), not real per-model pricing.
 */
import { vi, describe, test } from 'vitest';

vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { runSuite } from './runner/run-corpus';
import type { RunReport } from './runner/artifact';
import { realJudgeClient } from './review';
import type { DepHintLevel } from './score';
import type { EvalRow } from './score';

const SUITE = process.env.EVAL_SWEEP_SUITE ?? 'sample-novel-dep';
const REPEAT = Math.max(1, Number(process.env.EVAL_REPEAT) || 3);
const MODELS = (process.env.EVAL_MODELS || process.env.EVAL_MODEL_A || 'deepseek-v4-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LEVELS: DepHintLevel[] = ['off', 'pointer', 'diff'];
const LEVEL_LABEL: Record<DepHintLevel, string> = { off: '冷启动', pointer: '指针', diff: 'diff' };

type Bucket = 'verbatim' | 'consequence' | 'irrelevant' | 'falseflag';
function bucketOf(id: string): Bucket {
  if (id.includes('-conseq-')) return 'consequence';
  if (id.includes('-falseflag-')) return 'falseflag';
  if (id.includes('-irrel-')) return 'irrelevant';
  return 'verbatim';
}

// positives score on recall (caught/total); controls score on clean (TN/total).
function buckets(rows: EvalRow[]) {
  const b = {
    verbatim: { hit: 0, n: 0 },
    consequence: { hit: 0, n: 0 },
    irrelevant: { hit: 0, n: 0 },
    falseflag: { hit: 0, n: 0 },
  };
  for (const r of rows) {
    const k = bucketOf(r.mutation);
    b[k].n += 1;
    if (k === 'verbatim' || k === 'consequence') {
      if (r.outcome === 'TP') b[k].hit += 1; // recall
    } else if (r.outcome === 'TN') b[k].hit += 1; // clean
  }
  return b;
}

function rowLine(level: DepHintLevel, report: RunReport): string {
  const b = buckets(report.result.rows);
  const m = report.metrics;
  const f = (x: { hit: number; n: number }) => (x.n ? `${x.hit}/${x.n}` : '  - ');
  const { FP } = report.result.tally;
  return (
    `  ${LEVEL_LABEL[level].padEnd(7)} ` +
    `直陈 ${f(b.verbatim).padEnd(5)} 间接 ${f(b.consequence).padEnd(4)} ┃ ` +
    `无关 ${f(b.irrelevant).padEnd(4)} 假flag ${f(b.falseflag).padEnd(4)} ` +
    `(FP=${FP}) · $${m.costUsd.toFixed(4)}`
  );
}

describe('hint-level sweep — verbatim / consequence positives × irrelevant / false-flag controls', () => {
  test(
    `${SUITE}: ${MODELS.join(',')} × ${LEVELS.length} 提示级 × repeat${REPEAT}`,
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[sweep] 跳过：未提供 DeepSeek key。\n');
        return;
      }
      console.log(`[sweep] 模型 ${MODELS.join(' / ')} · 级别 ${LEVELS.join('/')} · repeat${REPEAT}`);
      console.log('[sweep] 正样本看召回(越高越好)；对照看清白(越高越好，FP 应为 0)');

      const sections: string[] = [];
      for (const model of MODELS) {
        const lines: string[] = [`  〔${model}〕`];
        for (const level of LEVELS) {
          console.log(`\n[sweep] === ${model} · ${LEVEL_LABEL[level]} ===`);
          const report = await runSuite(SUITE, {
            artifact: false,
            model,
            depHintLevel: level,
            repeat: REPEAT,
          });
          lines.push(rowLine(level, report));
        }
        sections.push(lines.join('\n'));
      }

      console.log(
        '\n──────── Hint-level Sweep ────────\n' +
          sections.join('\n  ─────\n') +
          '\n──────────────────────────────────\n',
      );
    },
    3_600_000,
  );
});
