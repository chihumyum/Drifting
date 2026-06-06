/**
 * Dep-hint A/B — does telling the judge WHICH canon moved recover the dep bucket?
 * Runs the dep-only suite twice through the REAL judge — cold (the judge rediscovers
 * the contradiction from scratch) vs hinted (it's told which element+field changed,
 * NO values) — and prints recall on the 5 dep positives + FP on the 2 irrelevant
 * controls. The question:
 *   · dep recall ↑       (the engine's pointer is enough → it's an info problem, not a
 *                         reasoning ceiling; the real app already holds this pointer)
 *   · controls stay clean (the hint must not induce a false positive on an unrelated
 *                         canon change — the FP guard, under hint)
 *
 *   EVAL_REPEAT=3 VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:dep-hint-ab
 */
import { vi, describe, test } from 'vitest';

vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { runSuite } from './runner/run-corpus';
import { quality, type RunReport } from './runner/artifact';
import { realJudgeClient } from './review';
import type { EvalRow } from './score';

const SUITE = process.env.EVAL_DEP_AB_SUITE ?? 'sample-novel-dep';
const key = (r: EvalRow): string => `${r.mutation}|${r.chapterId}|${r.ruleId}`;

interface Side {
  caught: Set<string>;
  missed: Set<string>;
  fp: Set<string>;
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

function line(label: string, report: RunReport): string {
  const q = quality(report.result);
  const { TP, FP, FN, TN } = report.result.tally;
  const m = report.metrics;
  // positives = the dep contradictions; controls = the irrelevant changes (TN/FP).
  const depRecall = TP + FN ? `${TP}/${TP + FN} (${((TP / (TP + FN)) * 100).toFixed(0)}%)` : 'n/a';
  return (
    `  ${label.padEnd(8)} dep召回 ${depRecall} · 对照(应清白) ${TN}/${TN + FP} 干净 · ` +
    `P=${(q.precision * 100).toFixed(0)}% · TP=${TP} FP=${FP} FN=${FN} TN=${TN} · ` +
    `calls=${m.calls} $${m.costUsd.toFixed(4)}`
  );
}

describe('dep-hint A/B — cold vs hinted', () => {
  test(
    `${SUITE}: 冷启动 vs dep提示`,
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[dep-hint-ab] 跳过：未提供 DeepSeek key。\n');
        return;
      }

      console.log(`\n[dep-hint-ab] === 冷启动（无提示） ===`);
      const cold = await runSuite(SUITE, { artifact: false, depHintLevel: 'off' });
      console.log(`\n[dep-hint-ab] === dep 提示（告知改了哪些设定，不给值） ===`);
      const hinted = await runSuite(SUITE, { artifact: false, depHintLevel: 'pointer' });

      const A = sideOf(cold);
      const B = sideOf(hinted);
      const recovered = [...A.missed].filter((k) => B.caught.has(k)); // 提示后抓回
      const regressed = [...A.caught].filter((k) => B.missed.has(k)); // 提示后反而漏
      const newFP = [...B.fp].filter((k) => !A.fp.has(k)); // 提示诱发的误报（精度代价）

      const list = (xs: string[]): string =>
        xs.length ? xs.map((k) => `      · ${k}`).join('\n') : '      （无）';

      console.log(
        '\n──────── Dep-hint A/B ────────\n' +
          line('冷启动', cold) +
          '\n' +
          line('dep提示', hinted) +
          '\n  ─────\n' +
          `  抓回(冷漏→提示抓) ${recovered.length}:\n${list(recovered)}\n` +
          `  退步(冷抓→提示漏) ${regressed.length}:\n${list(regressed)}\n` +
          `  提示诱发误报(精度代价) ${newFP.length}:\n${list(newFP)}\n` +
          '──────────────────────────────\n',
      );
    },
    1_800_000,
  );
});
