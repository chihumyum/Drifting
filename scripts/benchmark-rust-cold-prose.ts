/** Closed-document search projection: production Yjs path vs resident Rust Yrs. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { isDeepStrictEqual } from 'node:util';
import loglevel from 'loglevel';
import { root, sha, seedFixture } from './benchmark-prose-metrics';
import { Host, databaseDigest } from './benchmark-database-transport';
import { createDatabasePlatform } from '../src/renderer/platform/database';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { getEntityContentJson } from '../src/renderer/lib/agent/chapter-prose';
import { docToBlocks } from '../src/renderer/lib/agent/serialize';
import { normalizeAgentContextEvidenceText } from '../src/renderer/lib/agent/runtime/context-evidence-retrieval';
const quick = process.argv.includes('--quick');
const warmups = quick ? 1 : 2;
const repetitions = quick ? 1 : 7;
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? (quick ? '.local-data/rust-cold-prose/quick.json' : 'docs/acceptance/rust-cold-prose-benchmark.json'));
const scenarios = [
  { name: 'short', nodes: 2, units: 5_000, tail: 8, calls: quick ? 2 : 20 },
  { name: 'long', nodes: 2, units: 50_000, tail: 8, calls: quick ? 2 : 10 },
  { name: 'very-long', nodes: 2, units: 200_000, tail: 8, calls: quick ? 2 : 5 },
  { name: 'long-tail', nodes: 2, units: 5_000, tail: 128, calls: quick ? 2 : 10 },
];
const limitations = [
  'Node/V8 and linear JSON-lines to Release Rust, not WKWebView or Tauri IPC. Renderer lane already uses the improved compact BLOB transport.',
  'Renderer executes actual getEntityContentJson and docToBlocks. Candidate keeps closed document snapshots/tails inside Rust via ProseRepository and drifting_prose::load_document, then uses DocumentSession::semantic and emits only block text. Both normalize text in JS.',
  'This times cold document materialization, not warm revision-cached search, ranking, live editor reads or whole Agent turns. Candidate has no product integration. Native semantic projection is probed separately for text parity; write/undo/IME are outside scope.',
  'Readonly lane uses a throwaway UTF-16 Yrs Doc and the existing checked v1 normalizer, extracting text directly without native edit-session metadata. It does not modify stored data.',
  'Two warmup triples and seven rotating triples, separate synthetic SQLite copies, GC outside timing, no OS cache flush. Exact block text and normalization, plus complete unchanged database contents, required for every pair.',
];
const summarize = (samples: number[]) => ({ medianMs: [...samples].sort((a,b) => a-b)[Math.floor(samples.length/2)], samples });
function sourceFiles() {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(file => file && existsSync(file) && (
      /^(crates\/(drifting-core|drifting-document|drifting-prose)\/|vendor\/yrs\/|drizzle\/|src\/renderer\/|packages\/prose-metrics\/)/u.test(file)
      || ['src-tauri/Cargo.lock', 'scripts/benchmark-rust-reuse.mjs', 'scripts/benchmark-database-transport.ts', 'scripts/benchmark-rust-cold-prose.ts', 'scripts/benchmark-prose-metrics.ts', 'scripts/benchmark-prose-metrics-batches.ts', 'scripts/rust-cold-prose-benchmark.rs', 'scripts/apple-workspace-metrics-check.ts',
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
  copyFileSync('scripts/rust-cold-prose-benchmark.rs', path.join(harness, 'src/main.rs'));
  copyFileSync('src-tauri/Cargo.lock', path.join(harness, 'Cargo.lock'));
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

async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.kind, 'rust-cold-prose-benchmark'); assert.deepEqual(report.source, source);
    assert.deepEqual(report.limitations, limitations); assert.equal(report.repetitions, repetitions);
    assert.equal(report.warmups, warmups); assert.deepEqual(report.scenarios.map((r: {scenario: unknown}) => r.scenario), scenarios);
    for (const result of report.scenarios) {
      assert.equal(result.exactParity, true); assert.equal(result.databaseUnchanged, true);
      for (const lane of ['renderer', 'rust', 'readonly']) {
        assert.equal(result[lane].samples.length, repetitions); assert.deepEqual(result[lane], summarize(result[lane].samples));
      }
    }
    assert.equal(report.probes.length, 24);
    for (const probe of report.probes) assert(probe.readonlyParity || probe.readonlyUnsupported);
    console.log('Source-matched Rust cold prose benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/rust-cold-prose'); mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-')); const directory = path.join(owned, 'databases'); mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-prose-metrics-benchmark'), 'synthetic only');
  const artifact = await buildHost(owned); const host = new Host(artifact.binary, directory);
  const platform = createDatabasePlatform((command, args) => host.invoke(command, { ...args, compact: true }));
  const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-cold-prose');
  loglevel.getLogger('DbLib').setLevel('warn');
  try {
    const corpusFile = path.join(owned, 'corpus.json');
    await run(process.execPath, ['--conditions=import', '--import=tsx', 'scripts/apple-workspace-metrics-check.ts', `--emit-corpus=${corpusFile}`]);
    const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
    const probes = [];
    for (const entry of corpus.cases) {
      const bytes = Buffer.from(entry.updateHex, 'hex'); const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, bytes);
        const expected = docToBlocks(JSON.stringify(yDocToProsemirrorJSON(doc, 'default'))).map(b => b.text);
        const actual = await host.invoke('probe_blocks', { update: bytes.toString('base64') });
        const readonly = await host.invoke('probe_readonly', { update: bytes.toString('base64') }).catch((error: Error) => ({ unsupported: error.message }));
        assert(!Array.isArray(readonly) || isDeepStrictEqual(expected, readonly), `Read-only projection mismatch: ${entry.name}`);
        probes.push({ name: entry.name, textParity: isDeepStrictEqual(expected, actual), readonlyParity: isDeepStrictEqual(expected, readonly), readonlyUnsupported: !Array.isArray(readonly), expectedSha256: sha(JSON.stringify(expected)), actualSha256: sha(JSON.stringify(actual)) });
      } finally { doc.destroy(); }
    }
    const results = [];
    const normalize = (blocks: string[]) => blocks.map(text => ({ text, normalized: normalizeAgentContextEvidenceText(text) }));
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`; const fixturePath = path.join(directory, fixture);
      await platform.open(fixture); await platform.close(); seedFixture(fixturePath, scenario);
      const before = databaseDigest(fixturePath);
      const samples = { renderer: [] as number[], rust: [] as number[], readonly: [] as number[] };
      for (let sample = -warmups; sample < repetitions; sample++) {
        let expected: unknown;
        for (const lane of (['renderer', 'rust', 'readonly'].slice((sample + warmups) % 3).concat(['renderer', 'rust', 'readonly'].slice(0, (sample + warmups) % 3))) as ('renderer' | 'rust' | 'readonly')[]) {
          const name = `${scenario.name}-${lane}-${sample}.db`; const file = path.join(directory, name);
          copyFileSync(fixturePath, file); await platform.open(name); global.gc?.();
          const started = performance.now(); const values = [];
          for (let i = 0; i < scenario.calls; i++) {
            const id = `synthetic-node-${String(i % 2).padStart(5, '0')}`;
            if (lane === 'renderer') values.push(normalize(docToBlocks(await getEntityContentJson('node', id, '{}')).map(b => b.text)));
            else {
              const result = await host.invoke(lane === 'rust' ? 'cold_blocks' : 'readonly_blocks', { docId: `node-content:${id}` }) as { blocks: string[] };
              values.push(normalize(result.blocks));
            }
          }
          const elapsed = performance.now() - started;
          if (expected) assert.deepEqual(values, expected); expected = values;
          assert.deepEqual(databaseDigest(file), before);
          if (sample >= 0) samples[lane].push(elapsed);
          await platform.close();
        }
      }
      const result = { scenario, renderer: summarize(samples.renderer), rust: summarize(samples.rust), readonly: summarize(samples.readonly), exactParity: true, databaseUnchanged: true };
      results.push(result); console.log(JSON.stringify({ name: scenario.name, renderer: result.renderer.medianMs, rust: result.rust.medianMs, readonly: result.readonly.medianMs }));
    }
    assert.deepEqual(provenance(), source);
    writeJson(output, { schemaVersion: 1, kind: 'rust-cold-prose-benchmark', measuredAt: new Date().toISOString(), source, warmups, repetitions, limitations,
      artifact: { ...artifact, binary: undefined }, environment: { cpu: os.cpus()[0]?.model, node: process.version, os: os.release() }, probes, scenarios: results });
  } finally { release(); await host.stop(); }
}
export { buildHost, provenance, run };
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
