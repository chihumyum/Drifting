/**
 * Run artifact — every run freezes to run.json (run-level scalars: tally, quality,
 * metrics, golden hashes) + rows.jsonl (per-case detail). This is the immutable
 * record; persistent trend/baseline tracking (a tiny eval_run DB table) is a later
 * phase that reads these scalars.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalResult } from '../score';
import type { RunMetrics } from './metering';

export interface RunReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  judgeModel: string;
  result: EvalResult;
  metrics: RunMetrics;
  goldens: { id: string; contentHash?: string }[];
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
    goldens: report.goldens,
  };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(runJson, null, 2));
  writeFileSync(
    join(dir, 'rows.jsonl'),
    report.result.rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  return dir;
}

export function formatMetrics(m: RunMetrics): string {
  return (
    `[metrics] calls=${m.calls} fail=${m.failures}(${(m.failRate * 100).toFixed(0)}%) · ` +
    `tok in/out=${m.inputTokens}/${m.outputTokens} · cost=$${m.costUsd.toFixed(4)} · ` +
    `lat mean/p50/p95=${Math.round(m.latencyMeanMs)}/${Math.round(m.latencyP50)}/${Math.round(m.latencyP95)}ms`
  );
}
