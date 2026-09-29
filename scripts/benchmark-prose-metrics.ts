/** Synthetic, file-backed comparison of the production TS and Rust reconcilers.
 * This is a Node/stdio service benchmark, not a WKWebView or input-latency test. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { JSONContent } from '@tiptap/core';
import loglevel from 'loglevel';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror';
import { getStaticChapterSchema } from '../src/renderer/components/editor/chapter-static-html';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { deriveCanonicalNodeProseProjection, reconcileProjectProseMetrics } from '../src/renderer/services/node-prose-metrics.service';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const quick = process.argv.includes('--quick');
const reportPath = path.resolve(option('output') ?? (quick
  ? '.local-data/prose-metrics-benchmark/quick.json' : 'docs/acceptance/prose-metrics-benchmark.json'));
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const NOW = '2026-09-30T00:00:00.000Z';
const PROJECT = 'synthetic-metrics-project';
const repetitions = quick ? 1 : 5;
const scenarios = quick ? [{ name: 'smoke', nodes: 4, units: 5_000, tail: 4 }] : [
  { name: 'small-book', nodes: 20, units: 5_000, tail: 8 },
  { name: 'novel', nodes: 200, units: 5_000, tail: 8 },
  { name: 'large-library', nodes: 1_000, units: 5_000, tail: 8 },
  { name: 'long-chapters', nodes: 20, units: 50_000, tail: 16 },
  { name: 'very-long-chapters', nodes: 5, units: 200_000, tail: 16 },
];
const limitations = [
  'Node/V8 runs the real renderer service, repositories, Drizzle proxy and wire codec; JSON-lines pipes replace Tauri IPC. This does not measure WKWebView/JSC, paint, physical input, or product startup.',
  'Both paths use the same release-built DatabaseGateway, rusqlite SQLite and production WAL/NORMAL configuration. Rust batches remain in process. Pipe latency is not Tauri IPC latency; observed speed ratios are not product speedup claims.',
  'Database gateway request counts include query, execute and transaction requests; they exclude SQLite trigger-internal statements. A benchmark-only relaxed atomic counter is added to a scratch copy of the gateway.',
  'Fresh database copies and owners are used for first rebuilds, but operating-system file cache is not flushed. Repeat rebuilds reuse the same owner. Alternating engine order, one unreported warmup per scenario and explicit Node GC before each sample reduce ordering and JIT effects.',
  'Timed workloads contain only closed durable chapters and drifts. Seed-only prose is a separate compatibility probe; unsaved live prose, concurrent editing, crash recovery and production integration are not accepted.',
  'Synthetic fixtures directly seed current-schema rows for read/projection work, not authored sync transactions. All durable prose, revisions, journal rows and non-projection domain fields are checked unchanged.',
];

function sourceFiles() {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(file => file && existsSync(file) && (
      /^(crates\/(drifting-core|drifting-document|drifting-prose)\/|vendor\/yrs\/|drizzle\/|src\/renderer\/|packages\/prose-metrics\/)/u.test(file)
      || ['scripts/benchmark-prose-metrics.ts', 'scripts/benchmark-prose-metrics-batches.ts', 'scripts/prose-metrics-benchmark.rs', 'scripts/apple-workspace-metrics-check.ts',
        'scripts/apple-performance-rustc-wrapper.sh', 'package.json', 'pnpm-lock.yaml'].includes(file)
    )).sort();
}
function provenance() {
  const files = sourceFiles();
  return { fingerprint: sha(files.map(file => `${file}\0${sha(readFileSync(file))}`).join('\n')), files: files.length };
}
function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function run(command: string, args: string[], cwd = root, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function buildHost(owned: string) {
  const source = path.join(owned, 'source');
  for (const file of sourceFiles().filter(file => /^(crates\/|vendor\/yrs\/|drizzle\/)/u.test(file))) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  const gatewayFile = path.join(source, 'crates/drifting-core/src/database.rs');
  const original = readFileSync(gatewayFile, 'utf8');
  const anchor = '    fn request<T>(&self, create_request: impl FnOnce(Response<T>) -> Request) -> DatabaseResult<T> {';
  assert.equal(original.split(anchor).length, 2, 'Gateway counter anchor changed');
  const counter = '\nstatic BENCHMARK_REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);\n' +
    'pub fn benchmark_request_count(reset: bool) -> u64 { if reset { BENCHMARK_REQUESTS.swap(0, std::sync::atomic::Ordering::Relaxed) } else { BENCHMARK_REQUESTS.load(std::sync::atomic::Ordering::Relaxed) } }\n';
  const instrumented = original.replace(anchor, `${anchor}\n        BENCHMARK_REQUESTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);`) + counter;
  writeFileSync(gatewayFile, instrumented);
  const harness = path.join(source, 'harness');
  mkdirSync(path.join(harness, 'src'), { recursive: true });
  copyFileSync('scripts/prose-metrics-benchmark.rs', path.join(harness, 'src/main.rs'));
  copyFileSync('crates/drifting-prose/Cargo.lock', path.join(harness, 'Cargo.lock'));
  writeFileSync(path.join(harness, 'Cargo.toml'), `[package]\nname = "prose-metrics-benchmark"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\ndrifting-core = { path = "../crates/drifting-core" }\ndrifting-document = { path = "../crates/drifting-document" }\ndrifting-prose = { path = "../crates/drifting-prose" }\nserde_json = "1"\nbase64 = "0.22"\n\n[workspace]\n`);
  const target = path.join(root, '.local-data/prose-metrics-benchmark/target');
  await run('cargo', ['build', '--release', '--offline', '--manifest-path', path.join(harness, 'Cargo.toml')], root, {
    CARGO_TARGET_DIR: target, RUSTC_WRAPPER: path.join(root, 'scripts/apple-performance-rustc-wrapper.sh'),
  });
  const binary = path.join(owned, 'prose-metrics-benchmark');
  copyFileSync(path.join(target, 'release/prose-metrics-benchmark'), binary);
  return { binary, binarySha256: sha(readFileSync(binary)), lockSha256: sha(readFileSync(path.join(harness, 'Cargo.lock'))),
    originalGatewaySha256: sha(original), instrumentedGatewaySha256: sha(instrumented) };
}

class Host {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly child;
  private readonly completed: Promise<void>;
  traffic = { calls: 0, sentBytes: 0, receivedBytes: 0 };
  constructor(binary: string, directory: string) {
    this.child = spawn(binary, [directory], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.completed = new Promise(resolve => this.child.once('exit', () => resolve()));
    const accept = (line: string) => {
      this.traffic.receivedBytes += Buffer.byteLength(line) + 1;
      const reply = JSON.parse(line);
      const item = this.pending.get(reply.id);
      assert(item, 'Unexpected host response');
      this.pending.delete(reply.id);
      if (reply.error !== undefined) item.reject(new Error(reply.error)); else item.resolve(reply.value);
    };
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        accept(line);
      }
    });
    const fail = (error: Error) => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error(`Benchmark host exited ${code}`)));
  }
  invoke = (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++this.sequence;
    const line = `${JSON.stringify({ id, command, args })}\n`;
    this.traffic.calls++;
    this.traffic.sentBytes += Buffer.byteLength(line);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line);
    });
  };
  async stop() {
    this.child.stdin.end();
    await this.completed;
  }
}

type Scenario = typeof scenarios[number];
function prose(units: number, styled: boolean) {
  const schema = getStaticChapterSchema();
  assert(schema);
  const phrase = '合成数据 海风与灯塔。hello world 👩🏽‍🚀 e\u0301 123 ';
  const content: JSONContent[] = [];
  let left = units;
  while (left > 0) {
    const length = Math.min(left, 400);
    // ASCII padding preserves complete emoji/combining sequences.
    const text = phrase.repeat(Math.floor(length / phrase.length)) + '文'.repeat(length % phrase.length);
    const index = content.length;
    content.push({ type: index === 0 ? 'heading' : 'paragraph', attrs: { id: `synthetic-block-${index}`, ...(index === 0 ? { level: 2 } : {}) },
      content: styled && index % 4 === 1 ? [
        { type: 'text', text: text.slice(0, 1), marks: [{ type: 'italic' }] },
        { type: 'text', text: text.slice(1, 2), marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: text.slice(2) },
      ] : [{ type: 'text', text }] });
    left -= length;
  }
  const doc = new Y.Doc({ gc: false });
  doc.clientID = styled ? 730002 : 730001;
  prosemirrorToYXmlFragment(schema.nodeFromJSON({ type: 'doc', content }), doc.getXmlFragment('default'));
  return doc;
}
function seedFixture(file: string, scenario: Scenario, seedOnly = false) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO project(id,name,user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(PROJECT, 'Synthetic benchmark', 'synthetic-user', NOW, NOW);
    db.prepare('INSERT INTO sync_generation(sync_generation_id,project_id,project_sync_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('synthetic-generation', PROJECT, 'synthetic-project-sync', NOW, NOW);
    const node = db.prepare('INSERT INTO book_node(id,title,project_id,kind,book_order,position_x,position_y,created_at,updated_at) VALUES (?,?,?,?,?,0,0,?,?)');
    const body = db.prepare("INSERT INTO node_content(node_id,content_json,outline_json,plot_grid_json,created_at,updated_at) VALUES (?,?,'[]','{}',?,?)");
    const snapshot = db.prepare('INSERT INTO yjs_snapshots(document_id,state_blob,updated_at) VALUES (?,?,?)');
    const update = db.prepare('INSERT INTO yjs_updates(document_id,update_blob,created_at) VALUES (?,?,?)');
    const revision = db.prepare('INSERT INTO yjs_document_revision(document_id,revision,updated_at) VALUES (?,?,?)');
    const variants = [false, true].map(styled => {
      const doc = prose(scenario.units, styled);
      try {
        const state = Y.encodeStateAsUpdate(doc);
        const cache = JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
        const tail: Uint8Array[] = [];
        const text = (doc.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText;
        const collect = (bytes: Uint8Array) => tail.push(bytes);
        doc.on('update', collect);
        for (let i = 0; i < scenario.tail; i++) text.insert(text.length, `尾${i} `);
        doc.off('update', collect);
        return { state, cache, tail };
      } finally { doc.destroy(); }
    });
    for (let i = 0; i < scenario.nodes; i++) {
      const id = `synthetic-node-${i.toString().padStart(5, '0')}`;
      const variant = variants[i % 2];
      node.run(id, `Synthetic ${i}`, PROJECT, i % 10 === 9 ? 'drift' : 'chapter', i, NOW, NOW);
      body.run(id, variant.cache, NOW, NOW);
      if (!seedOnly) {
        snapshot.run(`node-content:${id}`, variant.state, NOW);
        for (const bytes of variant.tail) update.run(`node-content:${id}`, bytes, NOW);
        revision.run(`node-content:${id}`, 1 + variant.tail.length, NOW);
      }
    }
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
  } finally { db.close(); }
}

type Row = Record<string, SQLInputValue>;
const metricFields = new Set(['word_count', 'word_count_basis_kind', 'word_count_basis_hash', 'word_count_basis_revision', 'word_count_basis_server_seq']);
function inspect(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const unchanged: Record<string, string> = {};
    for (const { name } of tables) {
      assert.equal(typeof name, 'string');
      if (String(name).startsWith('workspace_projection_')) continue; // Derived trigger output, counted below.
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Row[];
      const stable = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) =>
        !(name === 'book_node' && metricFields.has(key)) && !(name === 'node_content' && ['content_json', 'outline_json'].includes(key)))));
      unchanged[String(name)] = sha(stable.map(row => JSON.stringify(row)).sort().join('\n'));
    }
    const rows = db.prepare(`SELECT n.id,n.kind,n.word_count,n.word_count_basis_kind,n.word_count_basis_hash,n.word_count_basis_revision,n.word_count_basis_server_seq,c.content_json,c.outline_json
      FROM book_node n JOIN node_content c ON c.node_id=n.id ORDER BY n.id`).all() as Row[];
    return { unchanged, rows };
  } finally { db.close(); }
}
function rowDifferences(a: Row[], b: Row[]) {
  assert.equal(a.length, b.length);
  const fields: Record<string, number> = {};
  let rows = 0;
  for (let i = 0; i < a.length; i++) {
    let changed = false;
    assert.equal(a[i].id, b[i].id);
    for (const key of Object.keys(a[i])) {
      if (!isDeepStrictEqual(a[i][key], b[i][key])) { fields[key] = (fields[key] ?? 0) + 1; changed = true; }
    }
    if (changed) rows++;
  }
  return { rows, fields };
}

type Engine = 'renderer' | 'rust';
async function measure(host: Host, engine: Engine, reconcile = reconcileProjectProseMetrics) {
  const totalChanges = async () => {
    const value = await host.invoke('database_query', { sql: 'SELECT total_changes()', parameters: [] }) as { rows: { value: string }[][] };
    return Number(value.rows[0][0].value);
  };
  const beforeChanges = await totalChanges();
  global.gc?.();
  await host.invoke('benchmark_reset');
  const traffic = { ...host.traffic };
  const start = performance.now();
  let rustElapsedMs: number | null = null;
  if (engine === 'renderer') await reconcile(PROJECT, { publishToDataStore: false });
  else {
    const value = await host.invoke('reconcile', { projectId: PROJECT }) as { failures: unknown[]; rustElapsedMs: number };
    assert.deepEqual(value.failures, []);
    rustElapsedMs = value.rustElapsedMs;
  }
  const elapsedMs = performance.now() - start;
  const transport = { calls: host.traffic.calls - traffic.calls, sentBytes: host.traffic.sentBytes - traffic.sentBytes,
    receivedBytes: host.traffic.receivedBytes - traffic.receivedBytes };
  const gatewayRequests = await host.invoke('benchmark_counts') as number;
  const sqliteChangedRowsIncludingTriggers = await totalChanges() - beforeChanges;
  return { elapsedMs, rustElapsedMs, gatewayRequests, transport, sqliteChangedRowsIncludingTriggers };
}
type Sample = Awaited<ReturnType<typeof measure>> & { changedRows: number };
function summary(samples: Sample[]) {
  const sorted = samples.map(s => s.elapsedMs).sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted[sorted.length - 1],
    gatewayRequests: samples.map(s => s.gatewayRequests), changedRows: samples.map(s => s.changedRows), samples };
}

async function compatibility(host: Host, owned: string) {
  const file = path.join(owned, 'compatibility-corpus.json');
  await run(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/apple-workspace-metrics-check.ts', `--emit-corpus=${file}`]);
  const corpus = JSON.parse(readFileSync(file, 'utf8')) as { cases: { name: string; updateHex: string }[] };
  const results = [];
  for (const item of corpus.cases) {
    const bytes = new Uint8Array(Buffer.from(item.updateHex, 'hex'));
    const renderer = await deriveCanonicalNodeProseProjection('compatibility', { docId: 'node-content:compatibility', sourceKind: 'closed',
      revision: 1, stateUpdate: bytes, stateVector: new Uint8Array(), stateHash: 'unused' });
    const native = await host.invoke('project', { update: Buffer.from(bytes).toString('base64') }) as {
      contentJson: string; outlineJson: string; wordCount: number; basisHash: string;
    };
    assert.equal(native.wordCount, renderer.wordCount, `${item.name}: word count differs`);
    results.push({ name: item.name, wordCountEqual: true, contentBytesEqual: native.contentJson === renderer.contentJson,
      contentObjectsEqual: isDeepStrictEqual(JSON.parse(native.contentJson), JSON.parse(renderer.contentJson)),
      basisHashEqual: native.basisHash === renderer.wordCountBasisHash, outlineBytesEqual: native.outlineJson === renderer.outlineJson });
  }
  return results;
}

async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'tauri-rust-prose-metrics-benchmark');
    assert.equal(report.status, 'measured');
    assert.deepEqual(report.source, source, 'Benchmark source changed; rerun before using its results');
    assert.deepEqual(report.limitations, limitations);
    assert.equal(report.repetitions, repetitions);
    assert.deepEqual(report.scenarios.map((s: { scenario: Scenario }) => s.scenario), scenarios);
    for (const scenario of report.scenarios) for (const engine of ['renderer', 'rust']) for (const phase of ['first', 'repeat']) {
      const aggregate = scenario[engine][phase];
      assert.equal(aggregate.samples.length, repetitions);
      assert.deepEqual(aggregate, summary(aggregate.samples));
      for (const sample of aggregate.samples) { assert(sample.elapsedMs > 0); assert(sample.gatewayRequests > 0); }
    }
    assert.equal(report.compatibility.length, 24);
    assert(report.compatibility.every((r: { wordCountEqual: boolean }) => r.wordCountEqual));
    console.log('Source-matched prose metrics benchmark verified. Product integration remains unaccepted.');
    return;
  }
  const base = path.join(root, '.local-data/prose-metrics-benchmark');
  mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-'));
  const directory = path.join(owned, 'databases');
  mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-prose-metrics-benchmark'), 'synthetic only\n');
  console.log(`Benchmark artifacts: ${path.relative(root, owned)}`);
  const artifact = await buildHost(owned);
  const host = new Host(artifact.binary, directory);
  const platform = createDatabasePlatform(host.invoke, 'prose-metrics-benchmark');
  const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-benchmark');
  loglevel.getLogger('DbLib').setLevel('warn');
  try {
    const results = [];
    let databaseConfiguration: Record<string, unknown> = {};
    for (const scenario of scenarios) {
      console.log(`Measuring ${scenario.name}: ${scenario.nodes} nodes × ${scenario.units} UTF-16 text units, ${scenario.tail} tail updates each`);
      const fixture = `${scenario.name}-fixture.db`;
      await platform.open(fixture);
      databaseConfiguration = {
        journalMode: (await platform.query('PRAGMA journal_mode')).rows[0][0],
        synchronous: (await platform.query('PRAGMA synchronous')).rows[0][0],
        foreignKeys: (await platform.query('PRAGMA foreign_keys')).rows[0][0],
        sqliteVersion: (await platform.query('SELECT sqlite_version()')).rows[0][0],
      };
      assert.equal(databaseConfiguration.journalMode, 'wal');
      assert.equal(databaseConfiguration.synchronous, 1);
      assert.equal(databaseConfiguration.foreignKeys, 1);
      await platform.close();
      seedFixture(path.join(directory, fixture), scenario);
      const before = inspect(path.join(directory, fixture));
      const samples: Record<Engine, { first: Sample[]; repeat: Sample[] }> = {
        renderer: { first: [], repeat: [] }, rust: { first: [], repeat: [] },
      };
      let rendererRows: Row[] = [], rustRows: Row[] = [];
      let roundTrip: ReturnType<typeof rowDifferences> | undefined;
      for (let sample = -1; sample < repetitions; sample++) {
        const order: Engine[] = sample % 2 === 0 ? ['renderer', 'rust'] : ['rust', 'renderer'];
        for (const engine of order) {
          const name = `${scenario.name}-${engine}-${sample}.db`;
          const file = path.join(directory, name);
          copyFileSync(path.join(directory, fixture), file);
          await platform.open(name);
          const first = await measure(host, engine);
          const afterFirst = inspect(file);
          assert.deepEqual(afterFirst.unchanged, before.unchanged, `${engine}: non-projection state changed`);
          const second = await measure(host, engine);
          assert.equal(second.sqliteChangedRowsIncludingTriggers, 0, `${engine}: repeat rebuild wrote unchanged projections`);
          const afterSecond = inspect(file);
          assert.deepEqual(afterSecond.unchanged, before.unchanged);
          assert.deepEqual(afterSecond.rows, afterFirst.rows, `${engine}: repeat result changed`);
          if (sample >= 0) {
            samples[engine].first.push({ ...first, changedRows: rowDifferences(before.rows, afterFirst.rows).rows });
            samples[engine].repeat.push({ ...second, changedRows: rowDifferences(afterFirst.rows, afterSecond.rows).rows });
          }
          if (engine === 'renderer') rendererRows = afterFirst.rows; else rustRows = afterFirst.rows;
          if (engine === 'rust' && sample === repetitions - 1) {
            await measure(host, 'renderer');
            const back = inspect(file);
            assert.deepEqual(back.unchanged, before.unchanged);
            assert.deepEqual(back.rows, rendererRows, 'Renderer did not recover its original projection after Rust');
            roundTrip = rowDifferences(afterFirst.rows, back.rows);
          }
          await platform.close();
        }
      }
      for (let i = 0; i < rendererRows.length; i++) {
        assert.equal(rendererRows[i].word_count, rustRows[i].word_count);
        assert.equal(rendererRows[i].word_count_basis_revision, rustRows[i].word_count_basis_revision);
        assert.equal(rendererRows[i].outline_json, rustRows[i].outline_json);
      }
      const result = { scenario, fixtureSha256: sha(readFileSync(path.join(directory, fixture))),
        renderer: { first: summary(samples.renderer.first), repeat: summary(samples.renderer.repeat) },
        rust: { first: summary(samples.rust.first), repeat: summary(samples.rust.repeat) },
        equivalence: { wordCounts: true, revisions: true, outlines: true, nonProjectionStateUnchanged: true,
          differences: rowDifferences(rendererRows, rustRows), rendererAfterRust: roundTrip } };
      results.push(result);
      console.log(JSON.stringify({ scenario: scenario.name, rendererMs: result.renderer.first.medianMs, rustMs: result.rust.first.medianMs, differences: result.equivalence.differences }));
      writeJson(path.join(owned, 'partial.json'), results);
    }
    const corpus = await compatibility(host, owned);
    // A seed-only document is deliberately outside the native reconcile loop.
    const seedName = 'seed-only.db';
    await platform.open(seedName); await platform.close();
    seedFixture(path.join(directory, seedName), { name: 'seed', nodes: 2, units: 5_000, tail: 0 }, true);
    const seedBefore = inspect(path.join(directory, seedName));
    await platform.open(seedName);
    await measure(host, 'rust'); const seedRust = inspect(path.join(directory, seedName));
    await measure(host, 'renderer'); const seedRenderer = inspect(path.join(directory, seedName));
    await platform.close();
    assert.deepEqual(seedBefore.unchanged, seedRust.unchanged);
    assert.deepEqual(seedBefore.unchanged, seedRenderer.unchanged);
    assert.deepEqual(seedBefore.rows, seedRust.rows);
    assert(seedRenderer.rows.every(row => row.word_count_basis_kind === 'seed' && Number(row.word_count) > 0));
    assert.deepEqual(provenance(), source, 'Sources changed during benchmark');
    const artifactHashes = { ...artifact, binary: undefined };
    writeJson(reportPath, { schemaVersion: 1, kind: 'tauri-rust-prose-metrics-benchmark', status: 'measured',
      measuredAt: new Date().toISOString(), source, artifact: artifactHashes, repetitions,
      environment: { os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30, node: process.version,
        garbageCollectionBeforeSample: typeof global.gc === 'function',
        rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() },
      databaseConfiguration, limitations, scenarios: results, compatibility: corpus,
      seedOnly: { rustLeavesUncountedSeedUnchanged: true, rendererMaterializesSeed: true },
      decision: 'not-a-drop-in-replacement: serialization and seed-only behavior differ; live-document handling and actual Tauri IPC/UI remain untested' });
    console.log(`Benchmark report: ${path.relative(root, reportPath)}`);
  } finally { release(); await host.stop(); }
}

export { root, sha, NOW, PROJECT, scenarios, limitations, provenance, writeJson, buildHost, Host, seedFixture, inspect, rowDifferences, measure, summary };
export type { Row, Sample };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
