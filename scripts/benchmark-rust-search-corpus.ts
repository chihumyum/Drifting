/** Whole search-corpus comparison, including metadata reads and revision cache. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import loglevel from 'loglevel';
import { root, sha, seedFixture, PROJECT, writeJson } from './benchmark-prose-metrics';
import { buildHost, provenance as dependencyProvenance } from './benchmark-rust-cold-prose';
import { Host, databaseDigest } from './benchmark-database-transport';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { useDataStore } from '../src/renderer/store/data-store';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { createBookContentRepository } from '../src/renderer/sqlite-repo/content-repo';
import { createYjsRepository } from '../src/renderer/sqlite-repo/yjs-repo';
import { getEntityContentJson } from '../src/renderer/lib/agent/chapter-prose';
import * as Candidate from '../src/renderer/lib/agent/prose-search-corpus';
import { rankAgentContextEvidence } from '../src/renderer/lib/agent/runtime/context-evidence-retrieval';

const quick = process.argv.includes('--quick');
const warmups = quick ? 1 : 2;
const repetitions = quick ? 1 : 7;
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? (quick ? '.local-data/rust-search-corpus/quick.json' : 'docs/acceptance/rust-search-corpus-benchmark.json'));
const baselineCommit = 'c9de28ba5b5581dd97435ab9b6e70f65ee234884';
const baselineFile = 'src/renderer/lib/agent/prose-search-corpus.ts';
const baselineText = execFileSync('git', ['show', `${baselineCommit}:${baselineFile}`], { encoding: 'utf8' });
const scenarios = [
  { name: 'novel-cold', nodes: quick ? 8 : 200, units: 5_000, tail: 8, warm: false },
  { name: 'library-cold', nodes: quick ? 16 : 1_000, units: 5_000, tail: 8, warm: false },
  { name: 'long-chapters', nodes: quick ? 2 : 20, units: 50_000, tail: 8, warm: false },
  { name: 'very-long-chapters', nodes: quick ? 2 : 5, units: 200_000, tail: 8, warm: false },
  { name: 'long-tails', nodes: quick ? 4 : 100, units: 5_000, tail: 128, warm: false },
  { name: 'novel-warm', nodes: quick ? 8 : 200, units: 5_000, tail: 8, warm: true },
];
const limitations = [
  'Production collectProseSearchDocuments, real metadata queries, Yjs fallback and bounded revision cache against Release Rust DatabaseGateway. Candidate adds bounded read_search_text calls; baseline corpus module is frozen at c9de28ba, with current compact BLOB transport in both lanes.',
  'Node/V8 and JSON-lines replace WKWebView/Tauri IPC. Hydration worker is unavailable in Node; no UI responsiveness, typing, provider inference or whole-turn latency claim.',
  'Two warmup pairs then seven alternating measured pairs on fresh synthetic SQLite copies. Warm case primes the cache outside timing; cold cases clear it. GC is outside timing and OS cache is not flushed.',
  'Exact complete corpus, ranked outputs for mixed-language queries and full unchanged database contents are checked every pair. Synthetic closed nodes alternate plain and overlapping-mark bodies. Live/seed/unsupported/racing reads are separate regression tests, not timed speedup claims.',
];
const gate = { minimumImprovement: 0.20, minimumBenefitingCases: 2, minimumWinningPairs: 6, maximumRegression: 0.05 };
const summarize = (samples: number[]) => ({ medianMs: [...samples].sort((a,b) => a-b)[Math.floor(samples.length / 2)], samples });
function provenance() {
  const files = ['scripts/benchmark-rust-search-corpus.ts', 'src-tauri/src/database.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  return { dependencies: dependencyProvenance(), harness: sha(files.map(file => `${file}\0${sha(readFileSync(file))}`).join('\n')),
    baselineCommit, baselineSourceSha256: sha(baselineText) };
}
function assess(baseline: number[], candidate: number[]) {
  const improvement = 1 - summarize(candidate).medianMs / summarize(baseline).medianMs;
  const winningPairs = candidate.filter((value, i) => value < baseline[i]).length;
  return { improvement, winningPairs, benefit: improvement >= gate.minimumImprovement && winningPairs >= gate.minimumWinningPairs,
    regression: improvement < -gate.maximumRegression };
}
async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.kind, 'rust-search-corpus-benchmark'); assert.deepEqual(report.source, source);
    assert.deepEqual(report.limitations, limitations); assert.deepEqual(report.gate, gate);
    assert.equal(report.repetitions, repetitions); assert.equal(report.warmups, warmups);
    assert.deepEqual(report.scenarios.map((r: { scenario: unknown }) => r.scenario), scenarios);
    for (const r of report.scenarios) {
      assert.equal(r.exactCorpusAndRankingParity, true); assert.equal(r.databaseUnchanged, true);
      for (const lane of ['baseline', 'candidate']) {
        assert.equal(r[lane].samples.length, repetitions); assert.deepEqual(r[lane], summarize(r[lane].samples));
      }
      assert.deepEqual(r.assessment, assess(r.baseline.samples, r.candidate.samples));
    }
    assert.equal(report.accepted, report.scenarios.filter((r: {assessment: {benefit: boolean}}) => r.assessment.benefit).length >= gate.minimumBenefitingCases &&
      !report.scenarios.some((r: {assessment: {regression: boolean}}) => r.assessment.regression));
    console.log('Source-matched Rust search corpus benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/rust-search-corpus'); mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-')); const directory = path.join(owned, 'databases'); mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-prose-metrics-benchmark'), 'synthetic only');
  const frozen = path.join(owned, 'baseline.ts');
  writeFileSync(frozen, baselineText.replace(/from (['"])(\.[^'"]+)\1/gu, (_m, _q, specifier: string) => {
    const resolved = path.resolve(root, path.dirname(baselineFile), specifier);
    const file = [`${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')].find(existsSync);
    assert(file); return `from ${JSON.stringify(file)}`;
  }));
  const Baseline: typeof Candidate = createRequire(import.meta.url)(frozen);
  const artifact = await buildHost(owned); const host = new Host(artifact.binary, directory);
  const platform = createDatabasePlatform((command, args) => host.invoke(command, { ...args, compact: true }));
  const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-search');
  const priorData = useDataStore.getState(); loglevel.getLogger('DbLib').setLevel('warn');
  const deps: Candidate.ProseSearchCorpusDeps = {
    loadNodeContents: async projectId => new Map((await createBookContentRepository().listByProject(projectId)).map(row => [row.nodeId, row])),
    loadRevisions: async () => new Map((await createYjsRepository().listRevisions()).map(row => [row.docId, row.revision])),
    materialize: getEntityContentJson, hasLiveDoc: () => false,
    readClosedText: ids => platform.readProseSearchText!(ids),
  };
  try {
    const results = [];
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`; const fixturePath = path.join(directory, fixture);
      await platform.open(fixture); await platform.close(); seedFixture(fixturePath, scenario);
      const before = databaseDigest(fixturePath);
      const samples = { baseline: [] as number[], candidate: [] as number[] };
      for (let sample = -warmups; sample < repetitions; sample++) {
        let expected: unknown;
        for (const lane of (sample % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) as ('baseline' | 'candidate')[]) {
          const name = `${scenario.name}-${lane}-${sample}.db`; const file = path.join(directory, name);
          copyFileSync(fixturePath, file); await platform.open(name);
          useDataStore.setState({ ...priorData, bookNodes: await createBookNodeSqliteRepository(PROJECT).findAll() }, true);
          const module = lane === 'baseline' ? Baseline : Candidate; module.clearProseSearchCorpusCache();
          if (scenario.warm) await module.collectProseSearchDocuments(PROJECT, deps);
          global.gc?.(); const started = performance.now();
          const value = await module.collectProseSearchDocuments(PROJECT, deps);
          const elapsed = performance.now() - started;
          const rankings = ['合成 海风', 'hello WORLD', '尾7'].map(query => rankAgentContextEvidence({ query, documents: value }));
          const actual = { value, rankings };
          if (expected) assert.deepEqual(actual, expected); expected = actual;
          assert.deepEqual(databaseDigest(file), before);
          if (sample >= 0) samples[lane].push(elapsed);
          await platform.close();
        }
      }
      const result = { scenario, baseline: summarize(samples.baseline), candidate: summarize(samples.candidate),
        assessment: assess(samples.baseline, samples.candidate), exactCorpusAndRankingParity: true, databaseUnchanged: true };
      results.push(result); console.log(JSON.stringify({ name: scenario.name, baseline: result.baseline.medianMs, candidate: result.candidate.medianMs }));
    }
    assert.deepEqual(provenance(), source);
    writeJson(output, { schemaVersion: 1, kind: 'rust-search-corpus-benchmark', measuredAt: new Date().toISOString(), source, warmups, repetitions, limitations, gate,
      accepted: results.filter(r => r.assessment.benefit).length >= gate.minimumBenefitingCases && !results.some(r => r.assessment.regression),
      artifact: { ...artifact, binary: undefined }, environment: { cpu: os.cpus()[0]?.model, os: os.release(), node: process.version }, scenarios: results });
  } finally { useDataStore.setState(priorData, true); Candidate.clearProseSearchCorpusCache(); Baseline.clearProseSearchCorpusCache(); release(); await host.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
