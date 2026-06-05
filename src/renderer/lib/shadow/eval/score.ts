/**
 * Eval driver + scorer. Flattens every (mutation × repeat × scoped-chapter) into
 * independent review TASKS, runs them through the REAL evaluator chain with bounded
 * concurrency, and compares the fired-rule set to each mutation's expected labels →
 * a confusion matrix.
 *
 * Each task logs a ▶ (start) / ✓ (done, with elapsed seconds) line, so a long run
 * is visibly PROGRESSING instead of a frozen spinner — and a stalled chapter shows
 * up as a ▶ with no matching ✓. A per-chapter timeout aborts a hung judge call so
 * it fails fast instead of waiting out the SDK's 10-minute default.
 *
 * `repeat` runs each case N times and takes the majority verdict per (chapter,
 * rule), reporting cases that flip between runs (judge nondeterminism).
 *
 * Knobs (env): EVAL_CONCURRENCY (default 6) · EVAL_CALL_TIMEOUT_MS (default 480000,
 * 0 = off).
 */
import type { Finding } from '@/main/shadow/types';
import type { LLMClient } from '../../ai/client/llm-client';
import type { AgenticTraceStep } from '../../ai/shadow-rules';
import { cloneProject, type EvalChapter, type EvalProject } from './model';
import { reviewChapter } from './review';
import { scopeOf, type Mutation } from './mutations';

export type Outcome = 'TP' | 'FP' | 'FN' | 'TN';

export interface EvalRow {
  mutation: string;
  chapterId: string;
  ruleId: string;
  expected: boolean;
  predicted: boolean;
  outcome: Outcome;
  flipped: boolean; // verdict was not unanimous across repeats
}

export interface EvalResult {
  tally: Record<Outcome, number>;
  rows: EvalRow[];
  repeat: number;
}

export interface RunOpts {
  concurrency?: number; // simultaneous chapter reviews (default EVAL_CONCURRENCY ?? 6)
  timeoutMs?: number; // per-chapter abort budget (default EVAL_CALL_TIMEOUT_MS ?? 480000; 0 = off)
}

function outcome(expected: boolean, predicted: boolean): Outcome {
  if (expected && predicted) return 'TP';
  if (!expected && predicted) return 'FP';
  if (expected && !predicted) return 'FN';
  return 'TN';
}

// Run `fn` over `items` with at most `n` in flight. Order doesn't matter (each task
// writes into a shared map keyed by its own ids), so a simple shared cursor + N
// workers is enough.
async function mapPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

// Review one chapter, aborting (and rejecting) if it outruns `timeoutMs`. The
// abort propagates through the FC judge's signal → the SDK cancels the request, so
// a hung call doesn't sit silently for the SDK's 10-min default.
async function reviewWithTimeout(
  project: EvalProject,
  chapter: EvalChapter,
  client: LLMClient,
  ruleIds: string[],
  timeoutMs: number,
  onTrace?: (step: AgenticTraceStep) => void,
): Promise<Finding[]> {
  if (!timeoutMs) return reviewChapter(project, chapter, client, { ruleIds, onTrace });
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`超时 ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      reviewChapter(project, chapter, client, { ruleIds, signal: ac.signal, onTrace }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Task {
  mutationId: string;
  iter: number;
  chapterId: string;
  project: EvalProject; // the (mutation,iter) clone — shared read-only across its chapter tasks
  chapter: EvalChapter;
  ruleIds: string[]; // only the rules this mutation scores on this chapter
}

export async function runEval(
  golden: EvalProject,
  mutations: Mutation[],
  client: LLMClient,
  repeat = 1,
  opts: RunOpts = {},
): Promise<EvalResult> {
  const concurrency = Math.max(
    1,
    opts.concurrency ?? (Number(process.env.EVAL_CONCURRENCY ?? '6') || 6),
  );
  const timeoutMs = Math.max(
    0,
    opts.timeoutMs ?? (Number(process.env.EVAL_CALL_TIMEOUT_MS ?? '480000') || 0),
  );

  // Flatten to independent per-chapter review tasks. Each (mutation,iteration) gets
  // ONE clone (read-only across its chapter tasks); we only review the rules the
  // mutation actually scores on that chapter, skipping the other rules' FC loops.
  const tasks: Task[] = [];
  for (const m of mutations) {
    for (let iter = 0; iter < repeat; iter++) {
      const copy = cloneProject(golden);
      m.apply(copy);
      for (const chId of scopeOf(m)) {
        const ch = copy.chapters.find((c) => c.id === chId);
        if (!ch) continue;
        const ruleIds = [
          ...new Set(m.expect.filter((e) => e.chapterId === chId).map((e) => e.ruleId)),
        ];
        tasks.push({ mutationId: m.id, iter, chapterId: chId, project: copy, chapter: ch, ruleIds });
      }
    }
  }

  console.log(
    `[eval] ${mutations.length} 变异 × repeat${repeat} → ${tasks.length} 次章节审阅 · 并发=${concurrency}` +
      (timeoutMs ? ` · 单章上限=${Math.round(timeoutMs / 1000)}s` : ''),
  );

  // `${mutationId}|${iter}` → set of `${chapterId}|${ruleId}` that fired. Pre-seed
  // every key so a (mutation,iter) whose chapters fire nothing still votes "clean".
  const fired = new Map<string, Set<string>>();
  for (const t of tasks) {
    const k = `${t.mutationId}|${t.iter}`;
    if (!fired.has(k)) fired.set(k, new Set());
  }

  let done = 0;
  await mapPool(tasks, concurrency, async (t) => {
    const started = Date.now();
    console.log(
      `[eval] ▶ ${t.mutationId} · ${t.chapterId}(${t.chapter.blocks.length}段) [${t.ruleIds.join(',')}] …`,
    );
    const consulted: string[] = [];
    const onTrace = (step: AgenticTraceStep): void => {
      for (const c of step.calls ?? []) consulted.push(c.args ? `${c.tool} ${c.args}` : c.tool);
    };
    let findings: Finding[] = [];
    try {
      findings = await reviewWithTimeout(t.project, t.chapter, client, t.ruleIds, timeoutMs, onTrace);
    } catch (e) {
      console.warn(`[eval] ⚠ ${t.mutationId} · ${t.chapterId} 失败/超时：${(e as Error).message}`);
    }
    const set = fired.get(`${t.mutationId}|${t.iter}`)!;
    for (const f of findings) set.add(`${t.chapterId}|${f.ruleId}`);
    done += 1;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `[eval] ✓ ${t.mutationId} · ${t.chapterId} — ${findings.length} 处发现 · ${secs}s · 查证[${
        consulted.length ? consulted.join(' / ') : '未查证'
      }] （${done}/${tasks.length}）`,
    );
  });

  // Vote across repeats and score each expected pair (majority-fired = predicted).
  const tally: Record<Outcome, number> = { TP: 0, FP: 0, FN: 0, TN: 0 };
  const rows: EvalRow[] = [];
  for (const m of mutations) {
    for (const e of m.expect) {
      const key = `${e.chapterId}|${e.ruleId}`;
      let yes = 0;
      for (let iter = 0; iter < repeat; iter++) {
        if (fired.get(`${m.id}|${iter}`)?.has(key)) yes += 1;
      }
      const predicted = yes * 2 >= repeat; // majority-fired
      const o = outcome(e.shouldFlag, predicted);
      tally[o] += 1;
      rows.push({
        mutation: m.id,
        chapterId: e.chapterId,
        ruleId: e.ruleId,
        expected: e.shouldFlag,
        predicted,
        outcome: o,
        flipped: yes !== 0 && yes !== repeat,
      });
    }
  }
  return { tally, rows, repeat };
}

const glyph = (o: Outcome) =>
  o === 'TP' || o === 'TN' ? '✓' : o === 'FP' ? '✗误报' : '✗漏报';

export function formatReport(r: EvalResult): string {
  const { TP, FP, FN, TN } = r.tally;
  const prec = TP + FP ? TP / (TP + FP) : 1;
  const rec = TP + FN ? TP / (TP + FN) : 1;
  const acc = (TP + TN) / (TP + FP + FN + TN || 1);
  const rowLines = r.rows.map(
    (row) =>
      `  ${glyph(row.outcome).padEnd(6)} ${row.mutation.padEnd(14)} ${row.chapterId}/${row.ruleId}` +
      ` 期望=${row.expected ? '违反' : '通过'} 实判=${row.predicted ? '违反' : '通过'}` +
      (row.flipped ? '  ⚡不稳定' : ''),
  );
  return (
    '\n──────── Shadow Eval ────────\n' +
    `assertions=${r.rows.length} repeat=${r.repeat}\n` +
    rowLines.join('\n') +
    '\n  ─────\n' +
    `  TP=${TP} FP=${FP} FN=${FN} TN=${TN}\n` +
    `  precision=${(prec * 100).toFixed(0)}%  recall=${(rec * 100).toFixed(0)}%  accuracy=${(
      acc * 100
    ).toFixed(0)}%\n` +
    `  误报(FP)=${FP}  漏报(FN)=${FN}\n` +
    '─────────────────────────────\n'
  );
}
