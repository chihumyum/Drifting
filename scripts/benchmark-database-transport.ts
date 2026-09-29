/** Measure statement reuse below the real renderer repositories and services. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { root, sha, writeJson, provenance as rendererProvenance, seedFixture, PROJECT } from './benchmark-prose-metrics';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { getEntityContentJson } from '../src/renderer/lib/agent/chapter-prose';
import { createYjsRepository } from '../src/renderer/sqlite-repo/yjs-repo';
import { captureWorkspaceProjection } from '../src/renderer/services/workspace-projection.service';
import { reconcileProjectProseMetrics } from '../src/renderer/services/node-prose-metrics.service';

const quick = process.argv.includes('--quick');
// Exercise the portable WebView path even when Node provides toBase64.
if (process.argv.includes('--portable')) Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: undefined, configurable: true });
const repetitions = quick ? 1 : 9;
const warmups = quick ? 1 : 3;
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? (quick ? '.local-data/database-transport-benchmark/quick.json' : 'docs/acceptance/database-transport-benchmark.json'));
const gatewayFile = 'crates/drifting-core/src/database.rs';
const original = readFileSync(path.join(root, gatewayFile), 'utf8');
const baselineCommit = 'c9de28ba5b5581dd97435ab9b6e70f65ee234884';
const baselinePlatform = execFileSync('git', ['show', `${baselineCommit}:src/renderer/platform/database.ts`], { encoding: 'utf8' });
function replaceOnce(source: string, from: string, to: string) {
  assert.equal(source.split(from).length, 2, `Changed benchmark anchor: ${from}`);
  return source.replace(from, to);
}
const scenarios = [
  { name: 'node-point-reads', nodes: 200, units: 5000, count: quick ? 10 : 200 },
  { name: 'workspace-200', nodes: 200, units: 5000, count: quick ? 1 : 10 },
  { name: 'yjs-append', nodes: 200, units: 5000, count: quick ? 4 : 200 },
  { name: 'snapshot-read-50k', nodes: 2, units: 50_000, count: quick ? 2 : 30 },
  { name: 'snapshot-read-200k', nodes: 2, units: 200_000, count: quick ? 2 : 15 },
  { name: 'snapshot-write-200k', nodes: 2, units: 200_000, count: quick ? 2 : 15 },
  { name: 'hydrate-50k', nodes: 2, units: 50_000, count: quick ? 2 : 15 },
  { name: 'metrics-first', nodes: quick ? 10 : 200, units: 5000, count: 1 },
];
type Scenario = typeof scenarios[number];
const limitations = [
  'Node/V8 production renderer services, Drizzle driver and codec against Release Rust DatabaseGateway; linear-framed JSON-lines replace Tauri IPC. Ratios are not WKWebView, UI or typing speedups.',
  'Baseline platform codec is frozen at c9de28ba. The candidate uses the production compact transport. Both use the same gateway, SQL, WAL/NORMAL settings, transaction ownership and stored BLOB bytes. Apple bridge serialization is unchanged.',
  'Three warmup pairs then nine alternating measured pairs on fresh identical synthetic SQLite copies. GC is outside timing; operating-system caches are not flushed.',
  'Every paired output and complete database contents are compared, normalizing only timestamps and parallel metric projection revision assignment order. Integrity and foreign-key checks run outside timing.',
  'Snapshot-write includes a real repository snapshot upsert but not a live editor session or authored journal. Short append, text-only reads and workspace capture are regression controls.',
];
const performanceGate = { minimumMedianImprovement: 0.10, minimumWinningPairFraction: 0.75,
  minimumBenefitingWorkloads: 2, maximumMedianRegression: 0.05 };
function provenance() {
  const files = ['scripts/benchmark-database-transport.ts', 'scripts/database-transport-benchmark.rs', 'src-tauri/src/database.rs', 'src-tauri/Cargo.lock'];
  return { renderer: rendererProvenance(), harness: sha(files.map(file => `${file}\0${sha(readFileSync(file))}`).join('\n')),
    portableEncoder: process.argv.includes('--portable'), baselineCommit, baselinePlatformSha256: sha(baselinePlatform) };
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
async function build(owned: string) {
  const source = path.join(owned, 'source');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'crates/drifting-core', 'drizzle'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  const gateway = instrument(original);
  writeFileSync(path.join(source, gatewayFile), gateway);
  const harness = path.join(source, 'harness');
  mkdirSync(path.join(harness, 'src'), { recursive: true });
  copyFileSync('scripts/database-transport-benchmark.rs', path.join(harness, 'src/main.rs'));
  copyFileSync('src-tauri/Cargo.lock', path.join(harness, 'Cargo.lock'));
  writeFileSync(path.join(harness, 'Cargo.toml'), `[package]\nname = "database-transport-benchmark"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\ndrifting-core = { path = "../crates/drifting-core" }\nserde_json = "1"\n\n[workspace]\n`);
  const target = path.join(root, '.local-data/database-transport-benchmark/target');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('cargo', ['build', '--release', '--offline', '--manifest-path', path.join(harness, 'Cargo.toml')], {
      stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target,
        RUSTC_WRAPPER: path.join(root, 'scripts/apple-performance-rustc-wrapper.sh') },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)));
  });
  const binary = path.join(source, 'database-transport-benchmark');
  copyFileSync(path.join(target, 'release/database-transport-benchmark'), binary);
  return { binary, binarySha256: sha(readFileSync(binary)), instrumentedGatewaySha256: sha(gateway),
    lockSha256: sha(readFileSync(path.join(harness, 'Cargo.lock'))) };
}
class Host {
  private sequence = 0;
  bytesSent = 0;
  bytesReceived = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private child;
  private completed: Promise<void>;
  constructor(binary: string, directory: string) {
    this.child = spawn(binary, [directory], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.completed = new Promise(resolve => this.child.once('exit', () => resolve()));
    const onLine = (line: string) => {
      this.bytesReceived += Buffer.byteLength(line) + 1;
      const reply = JSON.parse(line);
      const item = this.pending.get(reply.id);
      assert(item, 'Unexpected host response');
      this.pending.delete(reply.id);
      if (reply.error !== undefined) item.reject(new Error(reply.error)); else item.resolve(reply.value);
    };
    // Split only physical LF bytes. readline also treats literal U+2028/U+2029
    // in valid JSON strings as line endings; retained fragments avoid rescans.
    let fragments: string[] = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      let start = 0; let end: number;
      while ((end = chunk.indexOf('\n', start)) >= 0) {
        fragments.push(chunk.slice(start, end)); onLine(fragments.join('')); fragments = []; start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    });
    const fail = (error: Error) => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error(`Benchmark host exited ${code}`)));
  }
  invoke = (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = `${JSON.stringify({ id, command, args })}\n`;
      this.bytesSent += Buffer.byteLength(line); this.child.stdin.write(line);
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
let snapshotBytes: Uint8Array;
async function workload(scenario: Scenario) {
  const results: unknown[] = [];
  const nodes = createBookNodeSqliteRepository(PROJECT);
  const yjs = createYjsRepository();
  for (let i = 0; i < scenario.count; i++) {
    switch (scenario.name) {
      case 'snapshot-read-50k': case 'snapshot-read-200k': results.push(await yjs.getSnapshot(`node-content:${nodeId(i % 2)}`)); break;
      case 'snapshot-write-200k': await yjs.upsertSnapshot(`node-content:${nodeId(i % 2)}`, snapshotBytes); break;
      case 'hydrate-50k': results.push(await getEntityContentJson('node', nodeId(i % 2), '{}')); break;
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
type Sample = { elapsedMs: number; sqliteServiceMs: number; gatewayRequests: number; wireBytes: number };
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
    assert.equal(report.kind, 'database-transport-benchmark');
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
    console.log('Source-matched database transport benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/database-transport-benchmark');
  mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-'));
  const directory = path.join(owned, 'databases'); mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-database-transport-benchmark'), 'synthetic only\n');
  const artifact = await build(owned);
  const hosts = { baseline: new Host(artifact.binary, directory), candidate: new Host(artifact.binary, directory) };
  const frozen = path.join(owned, 'baseline-platform.ts'); writeFileSync(frozen, baselinePlatform);
  const baselineFactory: typeof createDatabasePlatform = createRequire(import.meta.url)(frozen).createDatabasePlatform;
  const platforms = { baseline: baselineFactory(hosts.baseline.invoke, 'transport-baseline'),
    candidate: createDatabasePlatform((command, args) => hosts.candidate.invoke(command, { ...args, compact: true }), 'transport-candidate') };
  loglevel.getLogger('DbLib').setLevel('warn');
  try {
    const results = [];
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`;
      await platforms.baseline.open(fixture); await platforms.baseline.close();
      seedFixture(path.join(directory, fixture), { name: scenario.name, nodes: scenario.nodes, units: scenario.units, tail: 8 });
      const fixtureDb = new DatabaseSync(path.join(directory, fixture));
      snapshotBytes = new Uint8Array(fixtureDb.prepare('SELECT state_blob FROM yjs_snapshots LIMIT 1').get()!.state_blob as Uint8Array); fixtureDb.close();
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
            const bytesBefore = host.bytesSent + host.bytesReceived;
            const started = performance.now();
            const result = await workload(scenario);
            const elapsedMs = performance.now() - started;
            const wireBytes = host.bytesSent + host.bytesReceived - bytesBefore;
            const [gatewayRequests, sqlNs] = await host.invoke('benchmark_stats') as [number, number];
            const current = { result: sha(JSON.stringify(result)), database: databaseDigest(file) };
            if (expected) assert.deepEqual(current, expected, `Parity failed: ${scenario.name}`);
            expected = current;
            if (sample >= 0) samples[lane].push({ elapsedMs, sqliteServiceMs: sqlNs / 1e6, gatewayRequests, wireBytes });
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
    writeJson(output, { schemaVersion: 1, kind: 'database-transport-benchmark', measuredAt: new Date().toISOString(), source, repetitions, warmups,
      artifact: { ...artifact, binary: undefined },
      environment: { os: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, node: process.version,
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), garbageCollectionBeforeSample: typeof global.gc === 'function' },
      limitations, performanceGate,
      performanceGatePassed: results.filter(result => result.assessment.clearBenefit).length >= performanceGate.minimumBenefitingWorkloads &&
        !results.some(result => result.assessment.regression),
      scenarios: results });
    console.log(`Database transport report: ${path.relative(root, output)}`);
  } finally { await Promise.all([hosts.baseline.stop(), hosts.candidate.stop()]); }
}
export { build, Host, databaseDigest };
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
