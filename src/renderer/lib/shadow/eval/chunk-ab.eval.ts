/**
 * Chunking A/B — the hypothesis test. Runs the SAME suite twice through the REAL
 * judge — once whole-chapter, once windowed — and prints recall / precision / cost
 * side by side, split into the two failure buckets (dep-only canon changes vs
 * prose-injected faults). The thing we want to see:
 *   · prose bucket recall ↑   (windowing fixes long-context dilution)
 *   · dep bucket recall flat   (those are a reasoning gap, not a dilution one)
 *   · precision NOT down       (narrow windows can lose disambiguating context → FP)
 *
 *   EVAL_AB_SUITE=sample-novel EVAL_AB_CHUNK_SIZE=25 EVAL_AB_CHUNK_OVERLAP=5 \
 *     EVAL_REPEAT=3 VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:chunk-ab
 *
 * Note: the chunked half runs N judge calls per long chapter, so it costs more —
 * the printed cost delta is part of the result, not an accident.
 */
import { vi, describe, test } from 'vitest';

// Same Electron-cut as corpus.eval: the judge takes its client as an argument.
vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { runSuite } from './runner/run-corpus';
import { quality, type RunReport } from './runner/artifact';
import { realJudgeClient } from './review';
import type { EvalRow } from './score';

const SUITE = process.env.EVAL_AB_SUITE ?? 'sample-novel';
const SIZE = Number(process.env.EVAL_AB_CHUNK_SIZE) || 25;
const OVERLAP = Math.max(0, Number(process.env.EVAL_AB_CHUNK_OVERLAP) || 5);

const key = (r: EvalRow): string => `${r.mutation}|${r.chapterId}|${r.ruleId}`;
// dep-* cases mutate canon only (prose untouched) — the bucket windowing should NOT
// move. Everything else is a prose-level fault — the bucket windowing should help.
const bucketOf = (r: EvalRow): 'dep' | 'prose' => (/-dep-/.test(r.mutation) ? 'dep' : 'prose');

interface Side {
  caught: Set<string>; // expected-violation rows the judge fired on (TP)
  missed: Set<string>; // expected-violation rows it didn't (FN)
  fp: Set<string>; // clean rows it wrongly fired on (FP)
}

function sideOf(report: RunReport): Side {
  const s: Side = { caught: new Set(), missed: new Set(), fp: new Set() };
  for (const r of report.result.rows) {
    if (r.outcome === 'TP') s.caught.add(key(r));
    else if (r.outcome === 'FN') s.missed.add(key(r));
    else if (r.outcome === 'FP') s.fp.add(key(r));
  }
  return s;
}

function bucketRecall(report: RunReport, bucket: 'dep' | 'prose'): string {
  const pos = report.result.rows.filter((r) => r.expected && bucketOf(r) === bucket);
  const tp = pos.filter((r) => r.outcome === 'TP').length;
  return pos.length ? `${tp}/${pos.length} (${((tp / pos.length) * 100).toFixed(0)}%)` : 'n/a';
}

function line(label: string, report: RunReport): string {
  const q = quality(report.result);
  const { TP, FP, FN } = report.result.tally;
  const m = report.metrics;
  return (
    `  ${label.padEnd(10)} P=${(q.precision * 100).toFixed(0)}% R=${(q.recall * 100).toFixed(0)}% ` +
    `F1=${q.f1.toFixed(2)} · TP=${TP} FP=${FP} FN=${FN} · ` +
    `prose ${bucketRecall(report, 'prose')} · dep ${bucketRecall(report, 'dep')} · ` +
    `calls=${m.calls} $${m.costUsd.toFixed(4)} p50=${Math.round(m.latencyP50)}ms`
  );
}

describe('chunking A/B — whole chapter vs windowed', () => {
  test(
    `${SUITE}: 整章 vs 切窗 ${SIZE}/重叠${OVERLAP}`,
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[chunk-ab] 跳过：未提供 DeepSeek key。\n');
        return;
      }

      console.log(`\n[chunk-ab] === 整章基线 ===`);
      const whole = await runSuite(SUITE, { artifact: false });
      console.log(`\n[chunk-ab] === 切窗 ${SIZE}/重叠${OVERLAP} ===`);
      const chunked = await runSuite(SUITE, { artifact: false, chunk: { size: SIZE, overlap: OVERLAP } });

      const A = sideOf(whole);
      const B = sideOf(chunked);
      const recovered = [...A.missed].filter((k) => B.caught.has(k)); // 整章漏 → 切窗抓回
      const regressed = [...A.caught].filter((k) => B.missed.has(k)); // 整章抓 → 切窗漏掉
      const newFP = [...B.fp].filter((k) => !A.fp.has(k)); // 切窗新增误报（精度代价）
      const fixedFP = [...A.fp].filter((k) => !B.fp.has(k));

      const list = (xs: string[]): string => (xs.length ? xs.map((k) => `      · ${k}`).join('\n') : '      （无）');

      console.log(
        '\n──────── Chunking A/B ────────\n' +
          line('整章', whole) +
          '\n' +
          line('切窗', chunked) +
          '\n  ─────\n' +
          `  抓回(整章漏→切窗抓) ${recovered.length}:\n${list(recovered)}\n` +
          `  退步(整章抓→切窗漏) ${regressed.length}:\n${list(regressed)}\n` +
          `  新增误报(精度代价) ${newFP.length}:\n${list(newFP)}\n` +
          `  修掉误报 ${fixedFP.length}:\n${list(fixedFP)}\n` +
          '─────────────────────────────\n',
      );
    },
    1_800_000,
  );
});
