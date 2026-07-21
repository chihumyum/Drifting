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
import type { Finding } from '../review-types';
import type { LLMClient } from '../../ai/client/llm-client';
import type { AgenticTraceStep } from '../../ai/shadow-rules';
import type { AIUsage } from '../../ai/types';
import { cloneProject, type EvalChapter, type EvalProject } from './model';
import { reviewChapter, windowCount, type ChunkConfig, type DepHint } from './review';
import { scopeOf, type Mutation } from './mutations';

export type Outcome = 'TP' | 'FP' | 'FN' | 'TN';

// How much of the dep-graph's knowledge to forward to the judge on a canon-edit
// review: nothing (cold rediscovery) → which field moved (pointer) → the old→new
// value (diff). Each rung is strictly more of the info the real engine already holds.
export type DepHintLevel = 'off' | 'pointer' | 'diff';

export interface EvalRow {
  mutation: string;
  chapterId: string;
  ruleId: string;
  expected: boolean;
  predicted: boolean;
  outcome: Outcome;
  flipped: boolean; // verdict was not unanimous across repeats
}

// One finding the judge produced — kept so a fired clean-baseline assertion (an FP
// candidate) can be triaged by its reason/location instead of just "violated".
export interface EvalFinding {
  mutation: string;
  chapterId: string;
  ruleId: string;
  blockIds: string[];
  confidence: number;
  reason?: string;
  message: string;
}

export interface EvalResult {
  tally: Record<Outcome, number>;
  rows: EvalRow[];
  repeat: number;
  // Per-case (mutation id) token totals — summed across its chapter reviews/repeats.
  tokensByCase: Record<string, { inputTokens: number; outputTokens: number }>;
  // Every finding the judge raised (with reason/blockIds) — FP/FN triage material.
  findings: EvalFinding[];
}

export interface RunOpts {
  concurrency?: number; // simultaneous chapter reviews (default EVAL_CONCURRENCY ?? 6)
  timeoutMs?: number; // per-chapter abort budget (default EVAL_CALL_TIMEOUT_MS ?? 480000; 0 = off)
  // Window the semantic judge (default: off, or EVAL_CHUNK_SIZE/EVAL_CHUNK_OVERLAP).
  chunk?: ChunkConfig;
  // Forward the dep-graph hint to the judge: 'off' | 'pointer' (which field moved) |
  // 'diff' (old→new value). Default from EVAL_DEP_HINT (0/1/2 or off/pointer/diff).
  // Only affects mutations that edited canon (depChanges present).
  depHintLevel?: DepHintLevel;
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
  chunk?: ChunkConfig,
  depHints?: DepHint[],
  onTrace?: (step: AgenticTraceStep) => void,
  onUsage?: (usage: AIUsage) => void,
): Promise<Finding[]> {
  if (!timeoutMs)
    return reviewChapter(project, chapter, client, { ruleIds, chunk, depHints, onTrace, onUsage });
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
      reviewChapter(project, chapter, client, {
        ruleIds,
        chunk,
        depHints,
        signal: ac.signal,
        onTrace,
        onUsage,
      }),
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
  depHints?: DepHint[]; // dep-graph hint (pointer/diff), if hinting is on
}

// Resolve the hint level (explicit opt wins; else EVAL_DEP_HINT: 0/off, 1/pointer,
// 2/diff). Backward-compatible: EVAL_DEP_HINT=1 still means pointer.
function resolveDepHintLevel(opt?: DepHintLevel): DepHintLevel {
  if (opt) return opt;
  const e = process.env.EVAL_DEP_HINT;
  if (e === '2' || e === 'diff') return 'diff';
  if (e === '1' || e === 'pointer') return 'pointer';
  return 'off';
}

// Build the per-mutation hint from its canon edits. pointer = name+field only; diff
// reads the OLD value from the pristine golden and the NEW value from the mutated
// clone — exactly the diff the real staleness layer would surface.
export function depHintsFor(
  level: DepHintLevel,
  m: Mutation,
  golden: EvalProject,
  copy: EvalProject,
): DepHint[] | undefined {
  if (level === 'off' || !m.depChanges?.length) return undefined;
  return m.depChanges.map((d) => {
    if (level === 'pointer' || !d.fact) return { name: d.name, fact: d.fact };
    const from = golden.elements.find((e) => e.name === d.name)?.facts[d.fact];
    const to = copy.elements.find((e) => e.name === d.name)?.facts[d.fact];
    return { name: d.name, fact: d.fact, from, to };
  });
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
  const envChunkSize = Number(process.env.EVAL_CHUNK_SIZE) || 0;
  const chunk =
    opts.chunk ??
    (envChunkSize > 0
      ? { size: envChunkSize, overlap: Math.max(0, Number(process.env.EVAL_CHUNK_OVERLAP) || 0) }
      : undefined);
  const depHintLevel = resolveDepHintLevel(opts.depHintLevel);

  // Flatten to independent per-chapter review tasks. Each (mutation,iteration) gets
  // ONE clone (read-only across its chapter tasks); we only review the rules the
  // mutation actually scores on that chapter, skipping the other rules' FC loops.
  const tasks: Task[] = [];
  for (const m of mutations) {
    for (let iter = 0; iter < repeat; iter++) {
      const copy = cloneProject(golden);
      m.apply(copy);
      const depHints = depHintsFor(depHintLevel, m, golden, copy);
      for (const chId of scopeOf(m)) {
        const ch = copy.chapters.find((c) => c.id === chId);
        if (!ch) continue;
        const ruleIds = [
          ...new Set(m.expect.filter((e) => e.chapterId === chId).map((e) => e.ruleId)),
        ];
        tasks.push({
          mutationId: m.id,
          iter,
          chapterId: chId,
          project: copy,
          chapter: ch,
          ruleIds,
          depHints,
        });
      }
    }
  }

  console.log(
    `[eval] ${mutations.length} 变异 × repeat${repeat} → ${tasks.length} 次章节审阅 · 并发=${concurrency}` +
      (timeoutMs ? ` · 单章上限=${Math.round(timeoutMs / 1000)}s` : '') +
      (chunk ? ` · 切窗=${chunk.size}/重叠${chunk.overlap}` : ' · 整章') +
      (depHintLevel !== 'off' ? ` · dep提示(${depHintLevel})` : ''),
  );

  // `${mutationId}|${iter}` → set of `${chapterId}|${ruleId}` that fired. Pre-seed
  // every key so a (mutation,iter) whose chapters fire nothing still votes "clean".
  const fired = new Map<string, Set<string>>();
  for (const t of tasks) {
    const k = `${t.mutationId}|${t.iter}`;
    if (!fired.has(k)) fired.set(k, new Set());
  }

  const tokensByCase: Record<string, { inputTokens: number; outputTokens: number }> = {};
  const allFindings: EvalFinding[] = [];

  let done = 0;
  await mapPool(tasks, concurrency, async (t) => {
    const started = Date.now();
    const nWin = windowCount(t.chapter.blocks.length, chunk);
    console.log(
      `[eval] ▶ ${t.mutationId} · ${t.chapterId}(${t.chapter.blocks.length}段${nWin > 1 ? `→${nWin}窗` : ''}) [${t.ruleIds.join(',')}] …`,
    );
    const consulted: string[] = [];
    const onTrace = (step: AgenticTraceStep): void => {
      for (const c of step.calls ?? []) consulted.push(c.args ? `${c.tool} ${c.args}` : c.tool);
    };
    let inTok = 0;
    let outTok = 0;
    const onUsage = (u: AIUsage): void => {
      inTok += u.inputTokens;
      outTok += u.outputTokens;
    };
    let findings: Finding[] = [];
    try {
      findings = await reviewWithTimeout(
        t.project,
        t.chapter,
        client,
        t.ruleIds,
        timeoutMs,
        chunk,
        t.depHints,
        onTrace,
        onUsage,
      );
    } catch (e) {
      console.warn(`[eval] ⚠ ${t.mutationId} · ${t.chapterId} 失败/超时：${(e as Error).message}`);
    }
    const set = fired.get(`${t.mutationId}|${t.iter}`)!;
    for (const f of findings) {
      set.add(`${t.chapterId}|${f.ruleId}`);
      // Record only once (first repeat) to avoid N copies; enough to triage.
      if (t.iter === 0) {
        allFindings.push({
          mutation: t.mutationId,
          chapterId: t.chapterId,
          ruleId: f.ruleId,
          blockIds: f.blockIds ?? (f.blockId ? [f.blockId] : []),
          confidence: f.confidence,
          reason: f.reason,
          message: f.message,
        });
      }
    }
    // Synchronous read-modify-write (no await between) → safe under concurrency.
    const acc = tokensByCase[t.mutationId] ?? { inputTokens: 0, outputTokens: 0 };
    acc.inputTokens += inTok;
    acc.outputTokens += outTok;
    tokensByCase[t.mutationId] = acc;
    done += 1;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `[eval] ✓ ${t.mutationId} · ${t.chapterId} — ${findings.length} 处发现 · ${secs}s · ` +
        (inTok || outTok ? `tok ${inTok}/${outTok} · ` : '') +
        `查证[${consulted.length ? consulted.join(' / ') : '未查证'}] （${done}/${tasks.length}）`,
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
  return { tally, rows, repeat, tokensByCase, findings: allFindings };
}

const glyph = (o: Outcome) => (o === 'TP' || o === 'TN' ? '✓' : o === 'FP' ? '✗误报' : '✗漏报');

export function formatReport(r: EvalResult): string {
  const { TP, FP, FN, TN } = r.tally;
  const prec = TP + FP ? TP / (TP + FP) : 1;
  const rec = TP + FN ? TP / (TP + FN) : 1;
  const acc = (TP + TN) / (TP + FP + FN + TN || 1);
  const positives = TP + FP + FN; // 0 ⇒ a pure clean-baseline run → precision/recall meaningless
  const rowLines = r.rows.map(
    (row) =>
      `  ${glyph(row.outcome).padEnd(6)} ${row.mutation.padEnd(14)} ${row.chapterId}/${row.ruleId}` +
      ` 期望=${row.expected ? '违反' : '通过'} 实判=${row.predicted ? '违反' : '通过'}` +
      (row.flipped ? '  ⚡不稳定' : ''),
  );

  // FP/FN triage: show what the judge actually said for the rows that went wrong.
  const reasonsFor = (mutation: string, chapterId: string, ruleId: string): string[] =>
    r.findings
      .filter((f) => f.mutation === mutation && f.chapterId === chapterId && f.ruleId === ruleId)
      .map(
        (f) => `${f.reason || f.message}${f.blockIds.length ? ` @${f.blockIds.join(',')}` : ''}`,
      );
  const wrong = r.rows.filter((row) => row.outcome === 'FP' || row.outcome === 'FN');
  const triage = wrong.length
    ? '\n  ─── 待分诊（FP/FN）───\n' +
      wrong
        .map((row) => {
          const tag = row.outcome === 'FP' ? '✗误报' : '✗漏报';
          const why =
            row.outcome === 'FP'
              ? reasonsFor(row.mutation, row.chapterId, row.ruleId)
                  .map((s) => `\n        → ${s}`)
                  .join('') || '\n        →（无 reason 记录）'
              : '\n        →（判官未触发该约束）';
          return `  ${tag} ${row.mutation} ${row.chapterId}/${row.ruleId}${why}`;
        })
        .join('\n')
    : '';

  const qualityLine = positives
    ? `  precision=${(prec * 100).toFixed(0)}%  recall=${(rec * 100).toFixed(0)}%  accuracy=${(acc * 100).toFixed(0)}%\n`
    : `  （纯清白基线：无注入故障 → precision/recall 无意义；只看误报）\n`;

  return (
    '\n──────── Shadow Eval ────────\n' +
    `assertions=${r.rows.length} repeat=${r.repeat}\n` +
    rowLines.join('\n') +
    '\n  ─────\n' +
    `  TP=${TP} FP=${FP} FN=${FN} TN=${TN}\n` +
    qualityLine +
    `  误报(FP)=${FP}  漏报(FN)=${FN}\n` +
    triage +
    '\n─────────────────────────────\n'
  );
}
