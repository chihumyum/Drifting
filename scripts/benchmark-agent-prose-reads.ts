/** Paired certified Agent prose reads with real SQLite receipts and paging. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import loglevel from 'loglevel';
import { root, sha, writeJson, provenance as rendererProvenance, seedFixture, PROJECT, NOW, buildHost } from './benchmark-prose-metrics';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { useDataStore } from '../src/renderer/store/data-store';
import { DriftingReadToolRuntime } from '../src/renderer/lib/agent/runtime/drifting-read-tool-runtime';
import type { AgentToolExecutionRequest } from '../src/renderer/lib/agent/runtime/types';
import type { AgentWriteApi } from '../src/renderer/lib/agent/tool-handlers';

const quick = process.argv.includes('--quick');
const repetitions = quick ? 1 : 7;
const warmups = quick ? 1 : 2;
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = path.resolve(option('output') ?? (quick ? '.local-data/agent-prose-reads/quick.json' : 'docs/acceptance/agent-prose-read-benchmark.json'));
const runtimeFile = 'src/renderer/lib/agent/runtime/drifting-read-tool-runtime.ts';
const coordinatorFile = 'src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.ts';
const ref = option('baseline') ?? '167454dd8c0ccb84132eb3139ead526c3821fa1f';
const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const sourceText = execFileSync('git', ['show', `${commit}:${runtimeFile}`], { encoding: 'utf8' });
const coordinatorText = execFileSync('git', ['show', `${commit}:${coordinatorFile}`], { encoding: 'utf8' });
const baseline = { commit, files: [
  { file: runtimeFile, sha256: sha(sourceText) },
  { file: coordinatorFile, sha256: sha(coordinatorText) },
] };
const scenarios = [
  { name: 'durable-short', units: 5_000, calls: quick ? 1 : 20, seedOnly: false },
  { name: 'durable-long', units: 50_000, calls: quick ? 1 : 10, seedOnly: false },
  { name: 'durable-very-long', units: 200_000, calls: quick ? 1 : 5, seedOnly: false },
  { name: 'seed-short', units: 5_000, calls: quick ? 1 : 20, seedOnly: true },
];
type Scenario = typeof scenarios[number];
const sessionId = 'synthetic-read-session';
const conversationId = 'synthetic-read-conversation';
const limitations = [
  'Measures the certified read_node path underneath read_chapter, including both freshness captures, real tool dispatch, result budgeting/paging artifacts and durable read receipts. The public domain wrapper, provider inference and full turn journal are not timed.',
  'Node/V8 and Release Rust DatabaseGateway, with JSON-lines instead of Tauri IPC. No WKWebView/worker timing: the production hydration client falls back to its inline implementation in Node. No live typing or end-to-end Agent turn speedup claim.',
  'The read-runtime and prose-persistence-coordinator modules are frozen at the baseline commit. Both lanes share all other current renderer dependencies and the same unchanged gateway, SQL and WAL/NORMAL configuration.',
  'Two warmup pairs followed by seven alternating measured pairs. Fresh identical SQLite copies prevent receipt replay and paging-quota accumulation across samples. Each sample performs distinct tool calls alternating two closed documents; GC is outside timing and OS caches are not flushed.',
  'Synthetic plain and overlapping-mark bodies, with eight updates after the snapshot for durable cases. Seed-only bodies have neither snapshots nor updates. Exact provider results, complete durable rows and unchanged non-read-receipt/artifact tables are checked on every pair.',
];
class Host {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private child;
  private completed: Promise<void>;
  constructor(binary: string, directory: string) {
    this.child = spawn(binary, [directory], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.completed = new Promise(resolve => this.child.once('exit', () => resolve()));
    // Large snapshots must not pay for rescanning an accumulated JSON line.
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      const reply = JSON.parse(line); const item = this.pending.get(reply.id);
      assert(item, 'Unexpected host response'); this.pending.delete(reply.id);
      if (reply.error !== undefined) item.reject(new Error(reply.error)); else item.resolve(reply.value);
    });
    const fail = (error: Error) => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.child.on('error', fail); this.child.on('exit', code => fail(new Error(`Benchmark host exited ${code}`)));
  }
  invoke = (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, command, args })}\n`); });
  };
  async stop() { this.child.stdin.end(); await this.completed; }
}
function provenance() {
  return { renderer: rendererProvenance(), harness: sha(readFileSync('scripts/benchmark-agent-prose-reads.ts')) };
}
function loadBaseline(owned: string): typeof DriftingReadToolRuntime {
  const frozenCoordinator = path.join(owned, 'baseline-coordinator.ts');
  const rewrite = (text: string, originalFile: string) => text.replace(/from (['"])(\.[^'"]+)\1/gu, (_match, _quote, specifier: string) => {
    const resolved = path.resolve(root, path.dirname(originalFile), specifier);
    if (`${resolved}.ts` === path.join(root, coordinatorFile)) return `from ${JSON.stringify(frozenCoordinator)}`;
    const file = [`${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, 'index.ts')].find(existsSync);
    assert(file, `Unresolved baseline import ${specifier}`);
    return `from ${JSON.stringify(file)}`;
  });
  writeFileSync(frozenCoordinator, rewrite(coordinatorText, coordinatorFile));
  const file = path.join(owned, 'baseline-runtime.ts'); writeFileSync(file, rewrite(sourceText, runtimeFile));
  return createRequire(import.meta.url)(file).DriftingReadToolRuntime;
}
function request(index: number): AgentToolExecutionRequest {
  const callId = `synthetic-call-${index}`;
  return { sessionId, turnId: 'synthetic-read-turn', callId, idempotencyKey: `${sessionId}:${callId}`,
    name: 'read_node', arguments: { node: `synthetic-node-${String(index % 2).padStart(5, '0')}`, prose: true }, access: 'read',
    context: { route: { kind: 'chat', projectId: PROJECT, conversationId } }, signal: new AbortController().signal };
}
function seedCalls(file: string, scenario: Scenario) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    db.prepare('INSERT INTO agent_conversation(id,project_id,title,messages_json,created_at,updated_at) VALUES (?,?,?,\'[]\',?,?)')
      .run(conversationId, PROJECT, 'Synthetic Agent reads', NOW, NOW);
    db.prepare("INSERT INTO agent_runtime_session(id,project_id,route_kind,conversation_id,provider,model,provider_epoch,status,created_at,updated_at) VALUES (?,?,'chat',?,'synthetic','none',0,'running',?,?)")
      .run(sessionId, PROJECT, conversationId, NOW, NOW);
    db.prepare("INSERT INTO agent_runtime_turn(id,session_id,ordinal,status,accepted_at,started_at,updated_at) VALUES ('synthetic-read-turn',?,0,'running',?,?,?)")
      .run(sessionId, NOW, NOW, NOW);
    const insert = db.prepare("INSERT INTO agent_runtime_tool_call(id,session_id,turn_id,call_id,name,access,status,idempotency_key,arguments_json,created_at,started_at) VALUES (?,?,?,?,?,'read','running',?,?,?,?)");
    for (let i = 0; i < scenario.calls; i++) {
      const r = request(i);
      insert.run(`agent-tool:${r.sessionId}:${r.turnId}:${r.callId}`, r.sessionId, r.turnId, r.callId, r.name,
        r.idempotencyKey, JSON.stringify(r.arguments), NOW, NOW);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}
function inspect(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      assert.equal(typeof name, 'string');
      const rows = db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all();
      return [name, sha(rows.map(row => JSON.stringify(row)).sort().join('\n'))];
    }));
  } finally { db.close(); }
}
const authority = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([name]) =>
  !/^agent_runtime_(read_|result_)/u.test(name)));
type Sample = { elapsedMs: number; gatewayRequests: number };
function summary(samples: Sample[]) {
  const sorted = samples.map(s => s.elapsedMs).sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted[sorted.length - 1], samples };
}
async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.kind, 'agent-prose-read-benchmark'); assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.source, source); assert.deepEqual(report.baseline, baseline);
    assert.equal(report.repetitions, repetitions); assert.equal(report.warmups, warmups);
    assert.deepEqual(report.limitations, limitations);
    assert.deepEqual(report.scenarios.map((s: { scenario: Scenario }) => s.scenario), scenarios);
    for (const result of report.scenarios) {
      assert.equal(result.exactResultAndDatabaseParity, true); assert.equal(result.authorityUnchanged, true);
      for (const lane of ['baseline', 'candidate']) {
        assert.deepEqual(result[lane], summary(result[lane].samples));
        assert.equal(result[lane].samples.length, repetitions);
        for (const sample of result[lane].samples) assert(sample.elapsedMs > 0 && sample.gatewayRequests > 0);
      }
    }
    console.log('Source-matched Agent prose read benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/agent-prose-reads'); mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-')); const directory = path.join(owned, 'databases'); mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-prose-metrics-benchmark'), 'synthetic only\n');
  const BaselineRuntime = loadBaseline(owned);
  const artifact = await buildHost(owned); const host = new Host(artifact.binary, directory);
  const platform = createDatabasePlatform(host.invoke, 'synthetic-agent-reads');
  const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-agent-reads');
  const priorData = useDataStore.getState(); loglevel.getLogger('DbLib').setLevel('warn');
  try {
    const results = [];
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`; const fixturePath = path.join(directory, fixture);
      await platform.open(fixture); await platform.close();
      seedFixture(fixturePath, { name: scenario.name, nodes: 2, units: scenario.units, tail: 8 }, scenario.seedOnly);
      seedCalls(fixturePath, scenario); const before = inspect(fixturePath);
      const samples = { baseline: [] as Sample[], candidate: [] as Sample[] };
      for (let sample = -warmups; sample < repetitions; sample++) {
        let expected: { results: unknown; database: unknown } | undefined;
        for (const lane of (sample % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) as ('baseline' | 'candidate')[]) {
          const name = `${scenario.name}-${lane}-${sample}.db`; const file = path.join(directory, name);
          copyFileSync(fixturePath, file); await platform.open(name);
          assert.equal((await platform.query('PRAGMA synchronous')).rows[0][0], 1);
          assert.equal((await platform.query('PRAGMA journal_mode')).rows[0][0], 'wal');
          useDataStore.setState({ ...priorData, bookNodes: await createBookNodeSqliteRepository(PROJECT).findAll() }, true);
          const Runtime = lane === 'baseline' ? BaselineRuntime : DriftingReadToolRuntime;
          const runtime = new Runtime({ getContext: () => ({ projectId: PROJECT, write: {} as AgentWriteApi }), now: () => NOW });
          const requests = Array.from({ length: scenario.calls }, (_, i) => request(i));
          global.gc?.(); await host.invoke('benchmark_reset'); const started = performance.now();
          const values = [];
          for (const r of requests) values.push(await runtime.execute(r));
          const elapsedMs = performance.now() - started;
          const gatewayRequests = await host.invoke('benchmark_counts') as number;
          for (const value of values) assert.equal(value.ok, true, JSON.stringify(value));
          const after = inspect(file); assert.deepEqual(authority(after), authority(before));
          const current = { results: values, database: after };
          if (expected) assert.deepEqual(current, expected, `Parity failed: ${scenario.name}`);
          expected = current;
          if (sample >= 0) samples[lane].push({ elapsedMs, gatewayRequests });
          await platform.close();
        }
      }
      const result = { scenario, baseline: summary(samples.baseline), candidate: summary(samples.candidate),
        exactResultAndDatabaseParity: true, authorityUnchanged: true };
      results.push(result);
      console.log(JSON.stringify({ name: scenario.name, baseline: result.baseline.medianMs, candidate: result.candidate.medianMs,
        baselineRequests: samples.baseline[0].gatewayRequests, candidateRequests: samples.candidate[0].gatewayRequests }));
    }
    assert.deepEqual(provenance(), source, 'Source changed during benchmark');
    writeJson(output, { schemaVersion: 1, kind: 'agent-prose-read-benchmark', measuredAt: new Date().toISOString(), source, baseline, repetitions, warmups,
      artifact: { ...artifact, binary: undefined }, limitations,
      environment: { os: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, node: process.version,
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() }, scenarios: results });
    console.log(`Agent prose read report: ${path.relative(root, output)}`);
  } finally { useDataStore.setState(priorData, true); release(); await host.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
