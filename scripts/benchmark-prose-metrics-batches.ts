/** Paired service A/B using an unmodified service blob from an explicit Git baseline. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import loglevel from 'loglevel';
import {
  root, sha, scenarios, provenance, writeJson, buildHost, Host,
  seedFixture, inspect, rowDifferences, measure, summary, type Sample,
} from './benchmark-prose-metrics';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { reconcileProjectProseMetrics } from '../src/renderer/services/node-prose-metrics.service';

const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const ref = option('baseline');
assert(ref, 'Pass --baseline=<commit> for the preceding service implementation');
const quick = process.argv.includes('--quick');
const repetitions = quick ? 1 : 5;
const output = path.resolve(option('output') ?? '.local-data/prose-metrics-benchmark/batch.json');
const limitations = [
  'Paired Node/V8 service measurements, not WKWebView/JSC, real Tauri IPC, paint or input latency.',
  'Both lanes use the same Release Rust DatabaseGateway, WAL/NORMAL SQLite and JSON-lines transport. One warmup then five alternating paired first/repeat samples; OS caches are not flushed.',
  'Only the service implementation is frozen at the baseline commit; its imported dependencies use the current checkout. Dependency changes must be reviewed separately before interpreting an A/B result.',
  'Timed synthetic closed documents only. Live/concurrent paths are covered separately by integration tests, not these timings.',
];
const service = 'src/renderer/services/node-prose-metrics.service.ts';
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const sourceText = execFileSync('git', ['show', `${baselineCommit}:${service}`], { encoding: 'utf8' });
const baseline = { commit: baselineCommit, file: service, sha256: sha(sourceText),
  scope: 'Frozen service only; both lanes share the current unchanged behavior of imported dependencies and the same Rust gateway.' };

async function loadBaseline(owned: string) {
  // Only change import locations, never the baseline algorithm. Shared module
  // identities keep the database, live-document registry and stores identical.
  const rewritten = sourceText.replace(/from (['"])(\.[^'"]+)\1/gu, (_match, _quote, specifier: string) => {
    const resolved = path.resolve(root, path.dirname(service), specifier);
    const file = [`${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')].find(existsSync);
    assert(file, `Unresolved baseline import ${specifier}`);
    return `from ${JSON.stringify(file)}`;
  }).replace(/from (['"])(@drifting\/prose-metrics)\1/gu,
    `from ${JSON.stringify(path.join(root, 'packages/prose-metrics/src/index.ts'))}`);
  const file = path.join(owned, 'baseline-service.ts');
  writeFileSync(file, rewritten);
  return createRequire(import.meta.url)(file).reconcileProjectProseMetrics as typeof reconcileProjectProseMetrics;
}

async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.kind, 'tauri-prose-metrics-batch-benchmark');
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.source, source);
    assert.deepEqual(report.baseline, baseline);
    assert.equal(report.repetitions, repetitions);
    assert.deepEqual(report.scenarios.map((s: { scenario: unknown }) => s.scenario), scenarios);
    for (const scenario of report.scenarios) {
      assert.equal(scenario.exactProjectionParity, true);
      assert.equal(scenario.nonProjectionStateUnchanged, true);
      for (const lane of ['baseline', 'candidate']) for (const phase of ['first', 'repeat']) {
        assert.deepEqual(scenario[lane][phase], summary(scenario[lane][phase].samples));
        assert.equal(scenario[lane][phase].samples.length, repetitions);
        for (const sample of scenario[lane][phase].samples) {
          assert(sample.elapsedMs > 0 && sample.gatewayRequests > 0);
          if (phase === 'repeat') assert.equal(sample.sqliteChangedRowsIncludingTriggers, 0);
        }
      }
    }
    assert.equal(report.seedOnlyExactParity, true);
    console.log('Source-matched paired batch benchmark verified.');
    return;
  }
  const base = path.join(root, '.local-data/prose-metrics-benchmark');
  mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'batch-'));
  const directory = path.join(owned, 'databases');
  mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-prose-metrics-benchmark'), 'synthetic only\n');
  const baselineReconcile = await loadBaseline(owned);
  const artifact = await buildHost(owned);
  const host = new Host(artifact.binary, directory);
  const platform = createDatabasePlatform(host.invoke, 'paired-benchmark');
  const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-batch');
  loglevel.getLogger('DbLib').setLevel('warn');
  try {
    const results = [];
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`;
      await platform.open(fixture);
      assert.equal((await platform.query('PRAGMA synchronous')).rows[0][0], 1);
      assert.equal((await platform.query('PRAGMA journal_mode')).rows[0][0], 'wal');
      await platform.close();
      seedFixture(path.join(directory, fixture), scenario);
      const before = inspect(path.join(directory, fixture));
      const samples = { baseline: { first: [] as Sample[], repeat: [] as Sample[] }, candidate: { first: [] as Sample[], repeat: [] as Sample[] } };
      for (let sample = -1; sample < repetitions; sample++) {
        const lanes = sample % 2 === 0 ? ['baseline', 'candidate'] as const : ['candidate', 'baseline'] as const;
        let expected: ReturnType<typeof inspect>['rows'] | undefined;
        for (const lane of lanes) {
          const name = `${scenario.name}-${lane}-${sample}.db`;
          const file = path.join(directory, name);
          copyFileSync(path.join(directory, fixture), file);
          await platform.open(name);
          const reconcile = lane === 'baseline' ? baselineReconcile : reconcileProjectProseMetrics;
          const first = await measure(host, 'renderer', reconcile);
          const afterFirst = inspect(file);
          assert.deepEqual(afterFirst.unchanged, before.unchanged);
          if (expected) assert.deepEqual(afterFirst.rows, expected, `${scenario.name}: projection parity failed`);
          expected = afterFirst.rows;
          const repeat = await measure(host, 'renderer', reconcile);
          const afterRepeat = inspect(file);
          assert.deepEqual(afterRepeat, afterFirst);
          assert.equal(repeat.sqliteChangedRowsIncludingTriggers, 0);
          if (sample >= 0) {
            samples[lane].first.push({ ...first, changedRows: rowDifferences(before.rows, afterFirst.rows).rows });
            samples[lane].repeat.push({ ...repeat, changedRows: 0 });
          }
          await platform.close();
        }
      }
      const result = { scenario, fixtureSha256: sha(readFileSync(path.join(directory, fixture))),
        baseline: { first: summary(samples.baseline.first), repeat: summary(samples.baseline.repeat) },
        candidate: { first: summary(samples.candidate.first), repeat: summary(samples.candidate.repeat) },
        exactProjectionParity: true, nonProjectionStateUnchanged: true };
      results.push(result);
      console.log(JSON.stringify({ scenario: scenario.name, baseline: result.baseline.first.medianMs, candidate: result.candidate.first.medianMs,
        baselineRepeat: result.baseline.repeat.medianMs, candidateRepeat: result.candidate.repeat.medianMs }));
    }
    const seedFixtureName = 'seed-fixture.db';
    await platform.open(seedFixtureName); await platform.close();
    seedFixture(path.join(directory, seedFixtureName), { name: 'seed', nodes: 2, units: 5_000, tail: 0 }, true);
    const seedBefore = inspect(path.join(directory, seedFixtureName));
    let seedExpected;
    for (const [name, reconcile] of [['seed-baseline.db', baselineReconcile], ['seed-candidate.db', reconcileProjectProseMetrics]] as const) {
      const file = path.join(directory, name);
      copyFileSync(path.join(directory, seedFixtureName), file);
      await platform.open(name);
      await measure(host, 'renderer', reconcile);
      const after = inspect(file);
      assert.deepEqual(after.unchanged, seedBefore.unchanged);
      if (seedExpected) assert.deepEqual(after, seedExpected);
      seedExpected = after;
      await platform.close();
    }
    assert.deepEqual(provenance(), source, 'Source changed during benchmark');
    writeJson(output, { schemaVersion: 1, kind: 'tauri-prose-metrics-batch-benchmark', measuredAt: new Date().toISOString(),
      source, baseline, repetitions, artifact: { ...artifact, binary: undefined },
      environment: { os: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, node: process.version,
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() },
      limitations, scenarios: results, seedOnlyExactParity: true });
    console.log(`Paired benchmark: ${path.relative(root, output)}`);
  } finally { release(); await host.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
