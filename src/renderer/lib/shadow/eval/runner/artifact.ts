/**
 * Run artifact — every run freezes to run.json (run-level scalars: tally, quality,
 * metrics, golden hashes) + rows.jsonl (per-case detail). This is the immutable
 * record; persistent trend/baseline tracking (a tiny eval_run DB table) is a later
 * phase that reads these scalars.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalResult } from '../score';
import type { RunMetrics } from './metering';
import type { Suite } from './schema';

export interface RunReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  result: EvalResult;
  metrics: RunMetrics;
  goldens: { id: string; contentHash?: string }[];
  gateViolations: string[];
}

export function quality(result: EvalResult): {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  flippedRate: number;
} {
  const { TP, FP, FN, TN } = result.tally;
  const precision = TP + FP ? TP / (TP + FP) : 1;
  const recall = TP + FN ? TP / (TP + FN) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = (TP + TN) / (TP + FP + FN + TN || 1);
  const flippedRate = result.rows.length
    ? result.rows.filter((r) => r.flipped).length / result.rows.length
    : 0;
  return { precision, recall, f1, accuracy, flippedRate };
}

export function writeArtifact(dir: string, report: RunReport): string {
  mkdirSync(dir, { recursive: true });
  const runJson = {
    suite: report.suite,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    judgeModel: report.judgeModel,
    repeat: report.result.repeat,
    tally: report.result.tally,
    ...quality(report.result),
    metrics: report.metrics,
    tokensByCase: report.result.tokensByCase,
    gateViolations: report.gateViolations,
    goldens: report.goldens,
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(runJson, null, 2));
  writeFileSync(
    join(dir, 'rows.jsonl'),
    report.result.rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  // Finding detail (reason + blockIds) for FP/FN triage — kept out of rows.jsonl
  // so the matrix stays compact.
  if (report.result.findings.length) {
    writeFileSync(
      join(dir, 'findings.jsonl'),
      report.result.findings.map((f) => JSON.stringify(f)).join('\n') + '\n',
    );
  }
  return dir;
}

export function formatMetrics(m: RunMetrics): string {
  return (
    `[metrics] calls=${m.calls} fail=${m.failures}(${(m.failRate * 100).toFixed(0)}%) · ` +
    `tok in/out=${m.inputTokens}/${m.outputTokens} · cost=$${m.costUsd.toFixed(4)} · ` +
    `lat mean/p50/p95=${Math.round(m.latencyMeanMs)}/${Math.round(m.latencyP50)}/${Math.round(m.latencyP95)}ms`
  );
}

// Suite gate — mechanical caps (maxFP/maxFN) hard-gate; semantic floors
// (minPrecision/minRecall) are advisory unless a trusted baseline sets them. Returns
// human-readable violation strings ([] = passed).
export function checkGate(result: EvalResult, gate: Suite['gate']): string[] {
  if (!gate) return [];
  const { FP, FN } = result.tally;
  const q = quality(result);
  const v: string[] = [];
  if (gate.maxFP != null && FP > gate.maxFP) v.push(`FP ${FP} > maxFP ${gate.maxFP}`);
  if (gate.maxFN != null && FN > gate.maxFN) v.push(`FN ${FN} > maxFN ${gate.maxFN}`);
  if (gate.minPrecision != null && q.precision < gate.minPrecision)
    v.push(`precision ${q.precision.toFixed(2)} < minPrecision ${gate.minPrecision}`);
  if (gate.minRecall != null && q.recall < gate.minRecall)
    v.push(`recall ${q.recall.toFixed(2)} < minRecall ${gate.minRecall}`);
  return v;
}

// Run-over-run trend: one scalar line per run in a COMMITTED history.jsonl (the
// persistent baseline the headless runner can write without a DB).
export function appendHistory(historyPath: string, report: RunReport): void {
  const q = quality(report.result);
  const line = JSON.stringify({
    at: report.finishedAt,
    suite: report.suite,
    judgeModel: report.judgeModel,
    tally: report.result.tally,
    precision: q.precision,
    recall: q.recall,
    f1: q.f1,
    flippedRate: q.flippedRate,
    costUsd: report.metrics.costUsd,
    calls: report.metrics.calls,
    goldens: report.goldens,
  });
  appendFileSync(historyPath, line + '\n');
}

interface HistoryRow {
  at: string;
  suite: string;
  precision: number;
  recall: number;
  f1: number;
  costUsd: number;
}

// Latest run for `suite` vs the previous one — the regression signal.
export function formatTrend(historyPath: string, suite: string): string {
  let rows: HistoryRow[];
  try {
    rows = readFileSync(historyPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryRow)
      .filter((r) => r.suite === suite);
  } catch {
    return `[trend] (无历史)`;
  }
  if (rows.length === 0) return `[trend] (无历史)`;
  const cur = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : undefined;
  const d = (a: number, b?: number) => (b == null ? '' : ` (${a - b >= 0 ? '+' : ''}${(a - b).toFixed(2)})`);
  return (
    `[trend] ${suite} 第${rows.length}次 · ` +
    `P=${cur.precision.toFixed(2)}${d(cur.precision, prev?.precision)} ` +
    `R=${cur.recall.toFixed(2)}${d(cur.recall, prev?.recall)} ` +
    `F1=${cur.f1.toFixed(2)}${d(cur.f1, prev?.f1)} ` +
    `$${cur.costUsd.toFixed(4)}`
  );
}
