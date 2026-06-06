/**
 * Suite runner — the generic driver. Loads a suite's datasets (data), compiles each
 * case into a Mutation via the operator registry (code), groups by golden, and runs
 * the REAL execution core (runEval → evaluateRules + FC judge) per golden, merging
 * into one confusion matrix + run-level metrics. The SAME runner is callable from the
 * CLI (corpus.eval) and, later, an in-app dev action — one reproducible core.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LLMClient } from '../../../ai/client/llm-client';
import { runEval, type EvalResult } from '../score';
import { mockCleanClient, realJudgeClient, type ChunkConfig } from '../review';
import { goldenToProject, loadGoldenFile } from './load-golden';
import { loadDataset, loadSuite } from './load-corpus';
import { caseToMutation } from './operators';
import { Metering, ZERO_METRICS } from './metering';
import { appendHistory, checkGate, writeArtifact, type RunReport } from './artifact';
import { contentHash } from './hash';
import type { EvalCase } from './schema';

const CORPUS = fileURLToPath(new URL('../corpus', import.meta.url));
export const GOLDENS_DIR = join(CORPUS, 'goldens');
export const DATASETS_DIR = join(CORPUS, 'datasets');
export const SUITES_DIR = join(CORPUS, 'suites');
export const RUNS_DIR = join(CORPUS, 'runs');
export const HISTORY_PATH = join(CORPUS, 'history.jsonl');

export interface RunOptions {
  // Write run.json + rows.jsonl under corpus/runs/. Defaults to EVAL_ARTIFACT=1.
  artifact?: boolean;
  // Window the semantic judge for this run (overrides EVAL_CHUNK_SIZE). Lets a
  // caller A/B whole-chapter vs windowed in one process without touching env.
  chunk?: ChunkConfig;
}

function emptyResult(repeat: number): EvalResult {
  return { tally: { TP: 0, FP: 0, FN: 0, TN: 0 }, rows: [], repeat, tokensByCase: {}, findings: [] };
}

/** Run a suite file → merged confusion matrix + run-level metrics + the artifact. */
export async function runSuiteFile(suitePath: string, opts: RunOptions = {}): Promise<RunReport> {
  const suite = loadSuite(suitePath);
  const startedAt = new Date().toISOString();

  // EVAL_REPEAT overrides the suite's declared repeat (the launcher prompts for it);
  // suite.repeat is the default when unset.
  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT) || suite.repeat);

  const cases: EvalCase[] = suite.datasets
    .flatMap((d) => loadDataset(join(DATASETS_DIR, d)))
    .filter((c) => c.enabled);

  const deepseek = suite.client === 'deepseek';
  const client = deepseek ? realJudgeClient() : mockCleanClient();
  if (!client) throw new Error(`suite "${suite.id}" client=deepseek 但未提供 DeepSeek key`);

  // Run-level metering only makes sense for a real client (mock fires no real calls).
  const metering = deepseek && client instanceof LLMClient ? new Metering() : null;
  if (metering && client instanceof LLMClient) client.use(metering);

  // Group by golden — runEval takes one golden + its mutations.
  const byGolden = new Map<string, EvalCase[]>();
  for (const c of cases) {
    const arr = byGolden.get(c.golden);
    if (arr) arr.push(c);
    else byGolden.set(c.golden, [c]);
  }

  const merged = emptyResult(repeat);
  const goldens: { id: string; contentHash?: string }[] = [];
  for (const [goldenId, gCases] of byGolden) {
    const gf = loadGoldenFile(join(GOLDENS_DIR, `${goldenId}.golden.json`));
    const golden = goldenToProject(gf);
    // Hash the RESOLVED project (incl. vault-read prose) so a bodySource edit shows.
    goldens.push({ id: goldenId, contentHash: contentHash(golden) });
    const mutations = gCases.map(caseToMutation);
    const res = await runEval(golden, mutations, client, repeat, {
      concurrency: suite.concurrency,
      timeoutMs: suite.timeoutMs,
      chunk: opts.chunk,
    });
    merged.tally.TP += res.tally.TP;
    merged.tally.FP += res.tally.FP;
    merged.tally.FN += res.tally.FN;
    merged.tally.TN += res.tally.TN;
    merged.rows.push(...res.rows);
    Object.assign(merged.tokensByCase, res.tokensByCase);
    merged.findings.push(...res.findings);
  }

  const report: RunReport = {
    suite: suite.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    judgeModel: deepseek ? 'deepseek-v4-flash' : 'mock',
    result: merged,
    metrics: metering ? metering.snapshot() : ZERO_METRICS,
    goldens,
    gateViolations: checkGate(merged, suite.gate),
  };

  if (opts.artifact ?? process.env.EVAL_ARTIFACT === '1') {
    const dir = join(RUNS_DIR, suite.id, startedAt.replace(/[:.]/g, '-'));
    writeArtifact(dir, report);
    // Only real-judge runs enter the committed trend — keep mock/ci noise out.
    if (metering) appendHistory(HISTORY_PATH, report);
    console.log(`[eval] artifact → ${dir}`);
  }
  return report;
}

/** Resolve a suite by id (corpus/suites/<id>.suite.json) and run it. */
export function runSuite(id: string, opts: RunOptions = {}): Promise<RunReport> {
  return runSuiteFile(join(SUITES_DIR, `${id}.suite.json`), opts);
}
