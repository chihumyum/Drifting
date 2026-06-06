/**
 * Focus ablation — is the consequence-drift miss an ATTENTION problem (relevant prose
 * buried in the full chapter) or a REASONING problem? For each consequence case, run
 * the diff-hinted judge twice:
 *   · full     — the whole chapter as context (current behaviour, misses 0/2)
 *   · focused  — ONLY the blocks where the changed entity (name/aliases) appears, ±N
 *                neighbours, so the deps-relevant text is no longer diluted
 *
 * If focused >> full → it's attention/dilution (and the app can fix it: localize the
 * changed entity's spans for the judge). If focused also misses → it's reasoning.
 * Prediction: helps ryoji-overt (澈 appears in ~3 scattered blocks) but NOT imaeda
 * (顾衡 is the whole chapter, so focusing buys nothing).
 *
 *   VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:diag-focus
 *   EVAL_FOCUS_WINDOW=1  EVAL_DIAG_REPEAT=3  EVAL_DIAG_CASES=baiye-dep-conseq-ryoji-overt
 */
import { vi, describe, test } from 'vitest';

vi.mock('../../ai/client/build-default-client', () => ({
  buildDefaultLLMClient: async () => {
    throw new Error('buildDefaultLLMClient must not be called in eval (pass a client)');
  },
}));

import { join } from 'node:path';
import { GOLDENS_DIR, DATASETS_DIR } from './runner/run-corpus';
import { loadDataset } from './runner/load-corpus';
import { goldenToProject, loadGoldenFile } from './runner/load-golden';
import { caseToMutation } from './runner/operators';
import { cloneProject, type EvalChapter, type EvalProject } from './model';
import { reviewChapter, realJudgeClient } from './review';
import { depHintsFor } from './score';
import { scopeOf } from './mutations';

const CASE_IDS = (
  process.env.EVAL_DIAG_CASES || 'baiye-dep-conseq-ryoji-overt,baiye-dep-conseq-imaeda-safe'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WINDOW = Math.max(0, Number(process.env.EVAL_FOCUS_WINDOW) || 1);
const REPEAT = Math.max(1, Number(process.env.EVAL_DIAG_REPEAT) || 3);
const MODEL = process.env.EVAL_MODEL_A || 'deepseek-v4-flash';

// Keep only blocks whose text mentions the changed entity (name/aliases), ±WINDOW
// neighbours for local context. This is the "localize the deps-relevant spans" move.
function focusChapter(
  ch: EvalChapter,
  needles: string[],
): { chapter: EvalChapter; kept: number[] } {
  const ns = needles.filter((n) => n && n.trim());
  const keep = new Set<number>();
  ch.blocks.forEach((b, i) => {
    if (ns.some((n) => b.text.includes(n))) {
      for (let d = -WINDOW; d <= WINDOW; d++) {
        const j = i + d;
        if (j >= 0 && j < ch.blocks.length) keep.add(j);
      }
    }
  });
  const kept = [...keep].sort((a, b) => a - b);
  return { chapter: { ...ch, blocks: kept.map((i) => ch.blocks[i]!) }, kept };
}

async function runOnce(
  project: EvalProject,
  chapter: EvalChapter,
  ruleIds: string[],
  depHints: ReturnType<typeof depHintsFor>,
): Promise<number> {
  const client = realJudgeClient(MODEL)!;
  const findings = await reviewChapter(project, chapter, client, { ruleIds, depHints });
  return findings.length;
}

describe('focus ablation — full chapter vs entity-focused context (diff hint)', () => {
  test(
    `cases [${CASE_IDS.join(', ')}] · 窗口±${WINDOW} · repeat${REPEAT} · ${MODEL}`,
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[focus] 跳过：未提供 DeepSeek key。\n');
        return;
      }
      const all = loadDataset(join(DATASETS_DIR, 'sample-novel.dep.jsonl'));
      const golden = goldenToProject(loadGoldenFile(join(GOLDENS_DIR, 'sample-novel.golden.json')));
      const summary: string[] = [];

      for (const id of CASE_IDS) {
        const c = all.find((x) => x.id === id);
        if (!c) {
          console.warn(`[focus] 未找到 case ${id}`);
          continue;
        }
        const m = caseToMutation(c);
        const entityName = m.depChanges?.[0]?.name ?? '';
        const el = golden.elements.find((e) => e.name === entityName);
        const needles = [entityName, ...(el?.aliases ?? [])];
        const chId = scopeOf(m)[0]!;
        const ruleIds = [
          ...new Set(m.expect.filter((e) => e.chapterId === chId).map((e) => e.ruleId)),
        ];

        for (const mode of ['full', 'focused'] as const) {
          let caught = 0;
          let totalBlocks = 0;
          for (let r = 0; r < REPEAT; r++) {
            const copy = cloneProject(golden);
            m.apply(copy);
            const depHints = depHintsFor('diff', m, golden, copy);
            const baseCh = copy.chapters.find((x) => x.id === chId)!;
            const ch =
              mode === 'full' ? baseCh : focusChapter(baseCh, needles).chapter;
            totalBlocks = ch.blocks.length;
            const n = await runOnce(copy, ch, ruleIds, depHints);
            if (n > 0) caught += 1;
            console.log(
              `[focus] ${id} · ${mode}(${totalBlocks}段) · 第${r + 1}/${REPEAT}次 — ${n} 处发现`,
            );
          }
          summary.push(
            `  ${id.padEnd(30)} ${mode.padEnd(8)} ${totalBlocks}段 → 命中 ${caught}/${REPEAT}`,
          );
        }
      }

      console.log(
        '\n──────── Focus Ablation (diff) ────────\n' +
          `  实体出现段 ±${WINDOW} 邻段作为聚焦 context\n` +
          summary.join('\n') +
          '\n───────────────────────────────────────\n',
      );
    },
    1_800_000,
  );
});
