/**
 * Timeout autopsy — run ONLY the cases that timed out, ONE AT A TIME (no concurrency,
 * so rate-limit-from-our-own-fanout is off the table), with a generous per-review cap,
 * LIVE-logging every judge tool call (+elapsed seconds) and any raw error. Reads off
 * directly which of the three it is:
 *   · thrashing      → tool calls pile up over time, then completes or hits the cap
 *   · rate-limit     → calls error/stall with a 429 / 'rate-limit' kind
 *   · moderation     → a FAST error (kind/name) or an empty/no-tool round, not a 900s hang
 *
 *   VITE_DEEPSEEK_AI_API_KEY=sk-... pnpm eval:diag-timeout
 *   EVAL_DIAG_LEVELS=off,pointer,diff  EVAL_CALL_TIMEOUT_MS=900000  EVAL_DIAG_CASES=...,...
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
import { depHintsFor, type DepHintLevel } from './score';
import { scopeOf } from './mutations';

const CASE_IDS = (
  process.env.EVAL_DIAG_CASES || 'baiye-dep-ryoji-ending-survives,baiye-dep-conseq-imaeda-safe'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LEVELS = (process.env.EVAL_DIAG_LEVELS || 'off,diff')
  .split(',')
  .map((s) => s.trim()) as DepHintLevel[];
const MODEL = process.env.EVAL_MODEL_A || 'deepseek-v4-flash';
const CAP = Number(process.env.EVAL_CALL_TIMEOUT_MS) || 900_000; // 15 min per review

describe('timeout autopsy — isolate the timed-out cases, trace live', () => {
  test(
    `cases [${CASE_IDS.join(', ')}] × levels [${LEVELS.join(', ')}] · model=${MODEL}`,
    async () => {
      const client = realJudgeClient(MODEL);
      if (!client) {
        console.warn('\n[diag] 跳过：未提供 DeepSeek key。\n');
        return;
      }

      const all = loadDataset(join(DATASETS_DIR, 'sample-novel.dep.jsonl'));
      const cases = CASE_IDS.map((id) => all.find((c) => c.id === id)).filter(Boolean) as typeof all;
      if (cases.length !== CASE_IDS.length) {
        console.warn(`[diag] 警告：只找到 ${cases.length}/${CASE_IDS.length} 个 case`);
      }
      const golden = goldenToProject(loadGoldenFile(join(GOLDENS_DIR, 'sample-novel.golden.json')));

      for (const c of cases) {
        const m = caseToMutation(c);
        for (const level of LEVELS) {
          const copy = cloneProject(golden);
          m.apply(copy);
          const depHints = depHintsFor(level, m, golden, copy);
          const chId = scopeOf(m)[0]!;
          const ch = copy.chapters.find((x) => x.id === chId)!;
          const ruleIds = [
            ...new Set(m.expect.filter((e) => e.chapterId === chId).map((e) => e.ruleId)),
          ];

          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), CAP);
          const start = Date.now();
          const t = (): string => ((Date.now() - start) / 1000).toFixed(0);
          let calls = 0;
          let rounds = 0;
          let inTok = 0;
          let outTok = 0;

          console.log(
            `\n[diag] ▶ ${c.id} · ${chId}(${ch.blocks.length}段) · 级别=${level} · 规则=${ruleIds.join(',')} · cap=${CAP / 1000}s` +
              (depHints?.length
                ? ` · 提示=${depHints.map((d) => `${d.name}.${d.fact ?? ''}${d.to ? '(diff)' : ''}`).join('|')}`
                : ''),
          );
          try {
            const findings = await reviewChapter(copy, ch, client, {
              ruleIds,
              depHints,
              signal: ac.signal,
              onTrace: (step) => {
                rounds += 1;
                for (const call of step.calls ?? []) {
                  calls += 1;
                  console.log(
                    `[diag]   t+${t()}s 第${rounds}轮 call#${calls} ${call.tool}${call.args ? ` ${call.args}` : ''}`,
                  );
                }
                if (!step.calls?.length) {
                  console.log(`[diag]   t+${t()}s 第${rounds}轮（无工具调用——可能在直接裁决/拒答）`);
                }
              },
              onUsage: (u) => {
                inTok += u.inputTokens;
                outTok += u.outputTokens;
              },
            });
            console.log(
              `[diag] ✓ ${c.id} · ${level} — ${findings.length} 处发现 · ${t()}s · ${rounds}轮/${calls}调用 · tok ${inTok}/${outTok}`,
            );
          } catch (e) {
            const err = e as { name?: string; kind?: string; message?: string };
            console.log(
              `[diag] ✗ ${c.id} · ${level} — ${t()}s · ${rounds}轮/${calls}调用 · ` +
                `错误 name=${err?.name ?? '?'} kind=${err?.kind ?? '?'} msg=${err?.message ?? String(e)}`,
            );
          } finally {
            clearTimeout(timer);
          }
        }
      }
    },
    5_400_000,
  );
});
