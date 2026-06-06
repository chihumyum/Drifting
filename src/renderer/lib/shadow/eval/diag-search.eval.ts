/**
 * RAG-vs-full ablation for the CONSEQUENCE (间接) cases, ACROSS MODELS. The earlier
 * "间接 0/2" was measured with the full chapter in context and NO working prose search.
 * Question now: does giving the judge a *semantic* retriever (RAG stand-in) recover the
 * implied-evidence catches keyword can't — and does a stronger model change the answer?
 *
 * For each consequence case, at the diff hint, run two judge models × two backends:
 *   models   · deepseek-v4-pro · deepseek-v4-flash   (EVAL_MODELS to override)
 *   backends · full  — search_prose denied; judge has the whole chapter in context
 *           · rag   — search_prose = LLM-retriever (semantic), surfaces IMPLIED evidence
 * (keyword backend dropped — it mirrors prod but can't reach implied evidence anyway.)
 *
 * The RAG retriever is PINNED to deepseek-v4-flash regardless of judge model, so RAG
 * quality is constant and the judge model is the only moving part. Every retrieval is
 * LOGGED (query → picked block ids + snippets) so a bad RAG result is visible — if RAG
 * never surfaces the right paragraphs, a miss is a retrieval failure, not a reasoning one.
 *
 * Read-off (per model):
 *   · rag >> full          → it's a RETRIEVAL problem; the product needs semantic search.
 *   · rag ≈ full (both 0)  → genuine reasoning gap; check the LOG — did RAG even find the
 *                            evidence? If it did and the judge still missed → reasoning.
 *   · pro recovers, flash doesn't → reasoning frontier is model-bound, not just retrieval.
 *
 *   VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:diag-search
 *   EVAL_DIAG_REPEAT=3  EVAL_MODELS=deepseek-v4-pro,deepseek-v4-flash
 *   EVAL_DIAG_CASES=baiye-dep-conseq-ryoji-overt,baiye-dep-conseq-imaeda-safe
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
import { cloneProject } from './model';
import { reviewChapter, realJudgeClient } from './review';
import { depHintsFor } from './score';
import { scopeOf } from './mutations';

const CASE_IDS = (
  process.env.EVAL_DIAG_CASES || 'baiye-dep-conseq-ryoji-overt,baiye-dep-conseq-imaeda-safe'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const REPEAT = Math.max(1, Number(process.env.EVAL_DIAG_REPEAT) || 3);
const MODELS = (process.env.EVAL_MODELS || 'deepseek-v4-pro,deepseek-v4-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// The RAG retriever runs on a FIXED model so judge-model is the only variable.
const RETRIEVER_MODEL = process.env.EVAL_RETRIEVER_MODEL || 'deepseek-v4-flash';

const MODES = [
  { id: 'none' as const, label: 'full（无检索）' },
  { id: 'semantic' as const, label: '语义RAG' },
];

const short = (m: string) => m.replace(/^deepseek-v4-/, '');

describe('RAG-vs-full ablation on consequence cases, across models (diff hint)', () => {
  test(
    `cases [${CASE_IDS.join(', ')}] × [${MODELS.map(short).join('/')}] × [full/rag] × repeat${REPEAT}`,
    async () => {
      if (!realJudgeClient()) {
        console.warn('\n[search] 跳过：未提供 DeepSeek key。\n');
        return;
      }
      // One pinned retriever client, shared by every semantic run.
      const retriever = realJudgeClient(RETRIEVER_MODEL)!;
      const all = loadDataset(join(DATASETS_DIR, 'sample-novel.dep.jsonl'));
      const golden = goldenToProject(loadGoldenFile(join(GOLDENS_DIR, 'sample-novel.golden.json')));
      const summary: string[] = [];

      for (const model of MODELS) {
        const client = realJudgeClient(model)!;
        for (const id of CASE_IDS) {
          const c = all.find((x) => x.id === id);
          if (!c) {
            console.warn(`[search] 未找到 case ${id}`);
            continue;
          }
          const m = caseToMutation(c);
          const chId = scopeOf(m)[0]!;
          const ruleIds = [
            ...new Set(m.expect.filter((e) => e.chapterId === chId).map((e) => e.ruleId)),
          ];
          for (const mode of MODES) {
            let caught = 0;
            for (let r = 0; r < REPEAT; r++) {
              const copy = cloneProject(golden);
              m.apply(copy);
              const depHints = depHintsFor('diff', m, golden, copy);
              const ch = copy.chapters.find((x) => x.id === chId)!;
              const tag = `${id} · ${short(model)} · ${mode.label} · 第${r + 1}/${REPEAT}次`;
              let n = 0;
              try {
                const findings = await reviewChapter(copy, ch, client, {
                  ruleIds,
                  depHints,
                  proseSearch: mode.id,
                  proseSearchClient: retriever,
                  onProseSearch: ({ query, picks }) => {
                    console.log(
                      `[rag] ${tag} · 查询「${query}」→ 段 [${picks.map((p) => p.block).join(', ')}]`,
                    );
                    for (const p of picks) console.log(`        [${p.block}] ${p.snippet}`);
                  },
                });
                n = findings.length;
              } catch (e) {
                console.log(`[search] ✗ ${tag} 错误 ${(e as Error).message}`);
              }
              if (n > 0) caught += 1;
              console.log(`[search] ${tag} — ${n} 处发现`);
            }
            summary.push(
              `  ${id.padEnd(30)} ${short(model).padEnd(6)} ${mode.label.padEnd(12)} 命中 ${caught}/${REPEAT}`,
            );
          }
          summary.push('  ─────');
        }
      }

      console.log(
        '\n──────── RAG-vs-full Ablation across models (间接 / diff) ────────\n' +
          `  检索器固定为 ${short(RETRIEVER_MODEL)}\n` +
          summary.join('\n') +
          '\n─────────────────────────────────────────────────────────────────\n',
      );
    },
    1_800_000,
  );
});
