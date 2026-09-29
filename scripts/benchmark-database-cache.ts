/** Measure statement reuse below the real renderer repositories and services. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { root, sha, writeJson, provenance as rendererProvenance, seedFixture, PROJECT } from './benchmark-prose-metrics';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { createYjsRepository } from '../src/renderer/sqlite-repo/yjs-repo';
import { captureWorkspaceProjection } from '../src/renderer/services/workspace-projection.service';
import { reconcileProjectProseMetrics } from '../src/renderer/services/node-prose-metrics.service';

const quick = process.argv.includes('--quick');
const repetitions = quick ? 1 : 9;
const warmups = quick ? 1 : 3;
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? (quick ? '.local-data/database-cache-benchmark/quick.json' : 'docs/acceptance/database-cache-benchmark.json'));
const gatewayFile = 'crates/drifting-core/src/database.rs';
const original = readFileSync(path.join(root, gatewayFile), 'utf8');
function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length, 2, `Changed benchmark anchor: ${from}`);
  return source.replace(from, to);
}
// Only scratch copies receive this candidate. The bounded cache stores compiled
// statements, never rows. No SQL, transport, schema or durability setting changes.
let candidate = replaceOnce(original,
  'fn configure_active_connection(connection: &Connection) -> DatabaseResult<String> {',
  'fn configure_active_connection(connection: &Connection) -> DatabaseResult<String> {\n    connection.set_prepared_statement_cache_capacity(128);');
candidate = replaceOnce(candidate, '.execute(sql, params_from_iter(parameters.iter()))',
  '.prepare_cached(sql)\n        .and_then(|mut statement| statement.execute(params_from_iter(parameters.iter())))');
candidate = replaceOnce(candidate, 'let mut statement = connection\n        .prepare(sql)',
  'let mut statement = connection\n        .prepare_cached(sql)');

const scenarios = [
  { name: 'node-point-reads', nodes: 1_000, count: quick ? 10 : 1_000 },
  { name: 'workspace-200', nodes: 200, count: quick ? 1 : 20 },
  { name: 'workspace-1000', nodes: 1_000, count: quick ? 1 : 20 },
  { name: 'yjs-append', nodes: 200, count: quick ? 4 : 200 },
  { name: 'yjs-cas', nodes: 200, count: quick ? 4 : 200 },
  { name: 'metrics-first', nodes: 200, count: 1 },
  { name: 'metrics-repeat', nodes: 200, count: 1 },
];
type Scenario = typeof scenarios[number];
const limitations = [
  'Real renderer services/repositories, Drizzle proxy and wire codec on Node/V8, against a Release drifting-core DatabaseGateway. JSON-lines pipes replace Tauri IPC; no WKWebView, UI, typing or product startup claims.',
  'Candidate changes only query/execute prepare to prepare_cached and connection cache capacity to 128 in an owned scratch source tree. Both lanes retain identical SQL, worker ownership, transaction boundaries and WAL/NORMAL settings.',
  'SQLite service time includes bind/prepare/step/row conversion inside query_sql and execute_sql; excludes gateway waiting, transaction begin/commit, JSON and renderer work. Identical scratch-only timers instrument both lanes.',
  'Three unreported warmup pairs, then nine alternating paired samples on fresh database copies. Every sample begins with a fresh connection/cache; repeated operations warm it naturally. Metrics-repeat is primed outside timing. Node GC is outside timing; OS caches are not flushed.',
  'Node-heavy synthetic projects: secondary workspace collections are empty. Yjs tests exercise repository append/CAS transactions, not live sessions, the authored journal, sync, compaction or crash/power-loss durability.',
  'Every paired result and complete database contents must agree after normalizing created_at/updated_at timestamps. Parallel metric workers can assign projection-change revisions to nodes in different orders: compare their revision multiset and entity coverage separately. Yjs revisions, BLOB bytes, provenance, replacement revisions and final projection clocks remain exact. No claim about schema-change/cache-invalidation correctness; this is a performance candidate, not an accepted implementation.',
];
const performanceGate = { minimumMedianImprovement: 0.10, minimumWinningPairFraction: 0.75,
  minimumBenefitingWorkloads: 2, maximumMedianRegression: 0.05 };
function provenance() {
  const files = ['scripts/benchmark-database-cache.ts', 'scripts/database-cache-benchmark.rs'];
  return { renderer: rendererProvenance(), harness: sha(files.map(file => `${file}\0${sha(readFileSync(file))}`).join('\n')),
    baselineGateway: sha(original), candidateGateway: sha(candidate) };
}

function instrument(source: string) {
  const anchor = '    fn request<T>(&self, create_request: impl FnOnce(Response<T>) -> Request) -> DatabaseResult<T> {';
  let result = replaceOnce(source, anchor, `${anchor}\n        BENCH_REQUESTS.fetch_add(1, Ordering::Relaxed);`);
  for (const kind of ['query', 'execute']) {
    result = replaceOnce(result, `${kind}_sql(connection, &sql, parameters)`, `{
        let started = std::time::Instant::now();
        let result = ${kind}_sql(connection, &sql, parameters);
        BENCH_SQL_NS.fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
        result
    }`);
  }
  return result + `
static BENCH_REQUESTS: AtomicU64 = AtomicU64::new(0);
static BENCH_SQL_NS: AtomicU64 = AtomicU64::new(0);
pub fn benchmark_stats(reset: bool) -> (u64, u64) {
    let read = |value: &AtomicU64| if reset { value.swap(0, Ordering::Relaxed) } else { value.load(Ordering::Relaxed) };
    (read(&BENCH_REQUESTS), read(&BENCH_SQL_NS))
}
`;
}
async function build(owned: string, lane: 'baseline' | 'candidate') {
  const source = path.join(owned, lane);
  const files = execFileSync('git', ['ls-files', '-z', 'crates/drifting-core', 'drizzle'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  const gateway = instrument(lane === 'baseline' ? original : candidate);
  writeFileSync(path.join(source, gatewayFile), gateway);
  const harness = path.join(source, 'harness');
  mkdirSync(path.join(harness, 'src'), { recursive: true });
  copyFileSync('scripts/database-cache-benchmark.rs', path.join(harness, 'src/main.rs'));
  copyFileSync('crates/drifting-core/Cargo.lock', path.join(harness, 'Cargo.lock'));
  writeFileSync(path.join(harness, 'Cargo.toml'), `[package]\nname = "database-cache-benchmark"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\ndrifting-core = { path = "../crates/drifting-core" }\nserde_json = "1"\n\n[workspace]\n`);
  const target = path.join(root, '.local-data/database-cache-benchmark/target');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cargo', ['build', '--release', '--offline', '--manifest-path', path.join(harness, 'Cargo.toml')], {
      stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target,
        RUSTC_WRAPPER: path.join(root, 'scripts/apple-performance-rustc-wrapper.sh') },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)));
  });
  const binary = path.join(source, 'database-cache-benchmark');
  copyFileSync(path.join(target, 'release/database-cache-benchmark'), binary);
  return { binary, binarySha256: sha(readFileSync(binary)), instrumentedGatewaySha256: sha(gateway),
    lockSha256: sha(readFileSync(path.join(harness, 'Cargo.lock'))) };
}
class Host {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private child;
  private completed: Promise<void>;
  constructor(binary: string, directory: string) {
    this.child = spawn(binary, [directory], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.completed = new Promise(resolve => this.child.once('exit', () => resolve()));
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      const reply = JSON.parse(line);
      const item = this.pending.get(reply.id);
      assert(item, 'Unexpected host response');
      this.pending.delete(reply.id);
      if (reply.error !== undefined) item.reject(new Error(reply.error)); else item.resolve(reply.value);
    });
    const fail = (error: Error) => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error(`Benchmark host exited ${code}`)));
  }
  invoke = (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
    });
  };
  async stop() { this.child.stdin.end(); await this.completed; }
}
function databaseDigest(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return tables.map(({ name }) => {
      assert.equal(typeof name, 'string');
      const rows = db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all();
      const stable = rows.map(row => JSON.stringify(row, (key, value) => {
        if (['created_at', 'updated_at'].includes(key) && value !== null) return '<clock>';
        if (name === 'workspace_projection_change' && key === 'revision') return '<parallel-order>';
        return value;
      })).sort();
      const revisions = name === 'workspace_projection_change'
        ? rows.map(row => Number(row.revision)).sort((a, b) => a - b) : [];
      return [name, sha(stable.join('\n')), revisions];
    });
  } finally { db.close(); }
}
const updateDoc = new Y.Doc();
updateDoc.getText('benchmark').insert(0, 'synthetic append 合成');
const updateBytes = Y.encodeStateAsUpdate(updateDoc);
updateDoc.destroy();
const nodeId = (index: number) => `synthetic-node-${index.toString().padStart(5, '0')}`;
async function workload(scenario: Scenario) {
  const results: unknown[] = [];
  const nodes = createBookNodeSqliteRepository(PROJECT);
  const yjs = createYjsRepository();
  for (let i = 0; i < scenario.count; i++) {
    switch (scenario.name) {
      case 'node-point-reads': results.push(await nodes.findById(nodeId(i % scenario.nodes))); break;
      case 'workspace-200': case 'workspace-1000':
        results.push(await captureWorkspaceProjection({ projectId: PROJECT, userId: 'synthetic-user' })); break;
      case 'yjs-append': results.push(await yjs.appendUpdate(`node-content:${nodeId(i % scenario.nodes)}`, updateBytes)); break;
      case 'yjs-cas': results.push(await yjs.appendUpdateCas(`node-content:${nodeId(i % scenario.nodes)}`, updateBytes, 9)); break;
      case 'metrics-first': case 'metrics-repeat': results.push(await reconcileProjectProseMetrics(PROJECT, { publishToDataStore: false })); break;
      default: throw new Error(`Unknown workload ${scenario.name}`);
    }
  }
  return results;
}
type Sample = { elapsedMs: number; sqliteServiceMs: number; gatewayRequests: number };
function summary(samples: Sample[]) {
  const median = (key: 'elapsedMs' | 'sqliteServiceMs') => samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  return { medianMs: median('elapsedMs'), sqliteServiceMedianMs: median('sqliteServiceMs'), samples };
}
function assess(baseline: Sample[], next: Sample[]) {
  const medianImprovement = 1 - summary(next).medianMs / summary(baseline).medianMs;
  const winningPairs = next.filter((sample, i) => sample.elapsedMs < baseline[i].elapsedMs).length;
  return { medianImprovement, winningPairs,
    clearBenefit: medianImprovement >= performanceGate.minimumMedianImprovement &&
      winningPairs / next.length >= performanceGate.minimumWinningPairFraction,
    regression: medianImprovement < -performanceGate.maximumMedianRegression };
}
async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.kind, 'database-statement-cache-benchmark');
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.source, source);
    assert.deepEqual(report.limitations, limitations);
    assert.equal(report.repetitions, repetitions);
    assert.equal(report.warmups, warmups);
    assert.deepEqual(report.performanceGate, performanceGate);
    assert.deepEqual(report.scenarios.map((value: { scenario: Scenario }) => value.scenario), scenarios);
    for (const result of report.scenarios) {
      assert.equal(result.resultParity, true); assert.equal(result.databaseParity, true);
      for (const lane of ['baseline', 'candidate']) {
        const samples = result[lane].samples as Sample[];
        assert.equal(samples.length, repetitions);
        assert.deepEqual(result[lane], summary(samples));
        for (const sample of samples) assert(sample.elapsedMs > 0 && sample.sqliteServiceMs > 0 && sample.gatewayRequests > 0);
      }
      assert.deepEqual(result.baseline.samples.map((s: Sample) => s.gatewayRequests), result.candidate.samples.map((s: Sample) => s.gatewayRequests));
      assert.deepEqual(result.assessment, assess(result.baseline.samples, result.candidate.samples));
    }
    assert.equal(report.performanceGatePassed,
      report.scenarios.filter((value: { assessment: { clearBenefit: boolean } }) => value.assessment.clearBenefit).length >= performanceGate.minimumBenefitingWorkloads &&
      !report.scenarios.some((value: { assessment: { regression: boolean } }) => value.assessment.regression));
    console.log('Source-matched database cache benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/database-cache-benchmark');
  mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-'));
  const directory = path.join(owned, 'databases'); mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-database-cache-benchmark'), 'synthetic only\n');
  const artifacts = { baseline: await build(owned, 'baseline'), candidate: await build(owned, 'candidate') };
  const hosts = { baseline: new Host(artifacts.baseline.binary, directory), candidate: new Host(artifacts.candidate.binary, directory) };
  const platforms = { baseline: createDatabasePlatform(hosts.baseline.invoke, 'cache-baseline'), candidate: createDatabasePlatform(hosts.candidate.invoke, 'cache-candidate') };
  loglevel.getLogger('DbLib').setLevel('warn');
  try {
    const results = [];
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`;
      await platforms.baseline.open(fixture); await platforms.baseline.close();
      seedFixture(path.join(directory, fixture), { name: scenario.name, nodes: scenario.nodes, units: 5_000, tail: 8 });
      const samples = { baseline: [] as Sample[], candidate: [] as Sample[] };
      for (let sample = -warmups; sample < repetitions; sample++) {
        let expected: { result: string; database: unknown } | undefined;
        for (const lane of (sample % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) as ('baseline' | 'candidate')[]) {
          const name = `${scenario.name}-${lane}-${sample}.db`;
          const file = path.join(directory, name); copyFileSync(path.join(directory, fixture), file);
          const platform = platforms[lane]; const host = hosts[lane];
          await platform.open(name);
          assert.equal((await platform.query('PRAGMA synchronous')).rows[0][0], 1);
          assert.equal((await platform.query('PRAGMA journal_mode')).rows[0][0], 'wal');
          const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-cache');
          try {
            if (scenario.name === 'metrics-repeat') await workload(scenario);
            global.gc?.();
            await host.invoke('benchmark_stats', { reset: true });
            const started = performance.now();
            const result = await workload(scenario);
            const elapsedMs = performance.now() - started;
            const [gatewayRequests, sqlNs] = await host.invoke('benchmark_stats') as [number, number];
            const current = { result: sha(JSON.stringify(result)), database: databaseDigest(file) };
            if (expected) assert.deepEqual(current, expected, `Parity failed: ${scenario.name}`);
            expected = current;
            if (sample >= 0) samples[lane].push({ elapsedMs, sqliteServiceMs: sqlNs / 1e6, gatewayRequests });
          } finally { release(); await platform.close(); }
        }
      }
      const result = { scenario, baseline: summary(samples.baseline), candidate: summary(samples.candidate),
        assessment: assess(samples.baseline, samples.candidate), resultParity: true, databaseParity: true };
      results.push(result);
      console.log(JSON.stringify({ scenario: scenario.name, baseline: result.baseline.medianMs, candidate: result.candidate.medianMs,
        baselineSql: result.baseline.sqliteServiceMedianMs, candidateSql: result.candidate.sqliteServiceMedianMs }));
    }
    assert.deepEqual(provenance(), source, 'Source changed during benchmark');
    writeJson(output, { schemaVersion: 1, kind: 'database-statement-cache-benchmark', measuredAt: new Date().toISOString(), source, repetitions, warmups,
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([lane, value]) => [lane, { ...value, binary: undefined }])),
      environment: { os: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, node: process.version,
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), garbageCollectionBeforeSample: typeof global.gc === 'function' },
      limitations, performanceGate,
      performanceGatePassed: results.filter(result => result.assessment.clearBenefit).length >= performanceGate.minimumBenefitingWorkloads &&
        !results.some(result => result.assessment.regression),
      scenarios: results });
    console.log(`Database cache report: ${path.relative(root, output)}`);
  } finally { await Promise.all([hosts.baseline.stop(), hosts.candidate.stop()]); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
