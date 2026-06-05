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
import { mockCleanClient, realJudgeClient } from '../review';
import { goldenToProject, loadGoldenFile } from './load-golden';
import { loadDataset, loadSuite } from './load-corpus';
import { caseToMutation } from './operators';
import { Metering, ZERO_METRICS } from './metering';
import { writeArtifact, type RunReport } from './artifact';
import type { EvalCase } from './schema';

const CORPUS = fileURLToPath(new URL('../corpus', import.meta.url));
export const GOLDENS_DIR = join(CORPUS, 'goldens');
export const DATASETS_DIR = join(CORPUS, 'datasets');
export const SUITES_DIR = join(CORPUS, 'suites');
export const RUNS_DIR = join(CORPUS, 'runs');

export interface RunOptions {
  // Write run.json + rows.jsonl under corpus/runs/. Defaults to EVAL_ARTIFACT=1.
  artifact?: boolean;
}

function emptyResult(repeat: number): EvalResult {
  return { tally: { TP: 0, FP: 0, FN: 0, TN: 0 }, rows: [], repeat };
}

/** Run a suite file → merged confusion matrix + run-level metrics + the artifact. */
export async function runSuiteFile(suitePath: string, opts: RunOptions = {}): Promise<RunReport> {
  const suite = loadSuite(suitePath);
  const startedAt = new Date().toISOString();

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

  const merged = emptyResult(suite.repeat);
  const goldens: { id: string; contentHash?: string }[] = [];
  for (const [goldenId, gCases] of byGolden) {
    const gf = loadGoldenFile(join(GOLDENS_DIR, `${goldenId}.golden.json`));
    goldens.push({ id: goldenId, contentHash: gf.contentHash });
    const golden = goldenToProject(gf);
    const mutations = gCases.map(caseToMutation);
    const res = await runEval(golden, mutations, client, suite.repeat, {
      concurrency: suite.concurrency,
      timeoutMs: suite.timeoutMs,
    });
    merged.tally.TP += res.tally.TP;
    merged.tally.FP += res.tally.FP;
    merged.tally.FN += res.tally.FN;
    merged.tally.TN += res.tally.TN;
    merged.rows.push(...res.rows);
  }

  const report: RunReport = {
    suite: suite.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    judgeModel: deepseek ? 'deepseek-v4-flash' : 'mock',
    result: merged,
    metrics: metering ? metering.snapshot() : ZERO_METRICS,
    goldens,
  };

  if (opts.artifact ?? process.env.EVAL_ARTIFACT === '1') {
    const dir = join(RUNS_DIR, suite.id, startedAt.replace(/[:.]/g, '-'));
    writeArtifact(dir, report);
    console.log(`[eval] artifact → ${dir}`);
  }
  return report;
}

/** Resolve a suite by id (corpus/suites/<id>.suite.json) and run it. */
export function runSuite(id: string, opts: RunOptions = {}): Promise<RunReport> {
  return runSuiteFile(join(SUITES_DIR, `${id}.suite.json`), opts);
}
