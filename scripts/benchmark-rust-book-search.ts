/** Whole-book find experiment; synthetic inputs only, no product database or UI. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { collectBookMatches, type BookMatch, type ChapterDoc } from '../src/renderer/lib/all-chapters-find';
import { root, sha, writeJson } from './benchmark-prose-metrics';

const quick = process.argv.includes('--quick');
const repetitions = quick ? 1 : 7;
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? (quick ? '.local-data/rust-book-search/quick.json' : 'docs/acceptance/rust-book-search-benchmark.json'));
const scenarios = quick ? [{ name: 'smoke', nodes: 4, units: 5_000 }] : [
  { name: 'small-book', nodes: 20, units: 5_000 },
  { name: 'novel', nodes: 200, units: 5_000 },
  { name: 'large-library', nodes: 1_000, units: 5_000 },
  { name: 'very-long-chapters', nodes: 5, units: 200_000 },
];
const queries = [{ name: 'dense-case-insensitive', text: 'HELLO' }, { name: 'rare', text: '稀有灯塔' }, { name: 'absent', text: '找不到的合成查询' }];
const limitations = [
  'Calls production collectBookMatches and production native_search_ranges, with a benchmark-only Rust adapter for identical chapter/block traversal and excerpts.',
  'Node/V8 and Release Rust, not WKWebView/JSC or real Tauri IPC. JSON-lines replace IPC; database loading, DOM highlights, scrolling, input latency and cancellation are excluded.',
  'The resident Rust lane loads all JSON documents once outside query timing. Product synchronization/invalidation of such a resident cache is not implemented. This deliberately favorable case is reported separately from sending documents per query.',
  'Both engines parse body JSON and build complete match/excerpt arrays on every query. Internal Rust time excludes request decoding, result serialization and transport; end-to-end time includes them and the UTF-16 excerpt adapter.',
  'Three alternating warmup triples precede seven measured triples per workload. Explicit Node GC precedes each lane. No OS-cache flush or browser responsiveness acceptance.',
];

function provenance() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
  const files = [...new Set([...tracked.filter(file => /^(crates\/drifting-document\/|vendor\/yrs\/)/u.test(file)),
    'scripts/benchmark-rust-book-search.ts', 'scripts/rust-book-search-benchmark.rs', 'scripts/benchmark-prose-metrics.ts',
    'scripts/apple-performance-rustc-wrapper.sh', 'src/renderer/lib/all-chapters-find.ts', 'package.json', 'pnpm-lock.yaml'])].sort();
  return { fingerprint: sha(files.map(file => `${file}\0${sha(readFileSync(path.join(root, file)))}`).join('\n')), files: files.length };
}
function documents(nodes: number, units: number): ChapterDoc[] {
  const phrase = '合成海风 hello World 🚀 e\u0301 123。';
  const content = [];
  let left = units;
  while (left > 0) {
    const length = Math.min(left, 500);
    const text = phrase.repeat(Math.floor(length / phrase.length)) + '文'.repeat(length % phrase.length);
    content.push({ type: 'paragraph', attrs: { id: `synthetic-block-${content.length}` }, content: [
      { type: 'text', text: text.slice(0, 3), marks: [{ type: 'bold' }] }, { type: 'text', text: text.slice(3) },
    ] });
    left -= length;
  }
  content[content.length - 1].content.push({ type: 'text', text: '稀有灯塔' });
  const contentJson = JSON.stringify({ type: 'doc', content });
  return Array.from({ length: nodes }, (_, index) => ({ nodeId: `synthetic-node-${index}`, index,
    title: `Synthetic chapter ${index}`, summary: '合成摘要', contentJson }));
}

type WireMatch = Omit<BookMatch, 'excerpt'> & { excerpt: Omit<BookMatch['excerpt'], 'text'> & { text: string | { utf16: number[] } } };
function fromWire(matches: WireMatch[]): BookMatch[] {
  for (const match of matches) {
    if (typeof match.excerpt.text !== 'string') match.excerpt.text = String.fromCharCode(...match.excerpt.text.utf16);
  }
  return matches as BookMatch[];
}
type Sample = { elapsedMs: number; internalMs: number; sentBytes: number; receivedBytes: number; matches: number };
function summary(samples: Sample[]) {
  const median = (key: 'elapsedMs' | 'internalMs') => samples.map(s => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  return { medianMs: median('elapsedMs'), internalMedianMs: median('internalMs'), samples };
}

class SearchHost {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private child;
  private completed: Promise<void>;
  traffic = { sentBytes: 0, receivedBytes: 0 };
  constructor(binary: string) {
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.completed = new Promise(resolve => this.child.once('exit', () => resolve()));
    let parts: string[] = [];
    this.child.stdout.setEncoding('utf8');
    // Dense result sets are large. Scan each chunk once and join once per line;
    // rescanning an accumulated string would benchmark quadratic framing work.
    this.child.stdout.on('data', (chunk: string) => {
      this.traffic.receivedBytes += Buffer.byteLength(chunk);
      let from = 0;
      for (;;) {
        const end = chunk.indexOf('\n', from);
        if (end < 0) { if (from < chunk.length) parts.push(chunk.slice(from)); break; }
        parts.push(chunk.slice(from, end));
        const reply = JSON.parse(parts.join(''));
        parts = [];
        const item = this.pending.get(reply.id);
        assert(item, 'Unexpected search host response');
        this.pending.delete(reply.id);
        item.resolve(reply.value);
        from = end + 1;
      }
    });
    const fail = (error: Error) => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error(`Search host exited ${code}`)));
  }
  invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    const id = ++this.sequence;
    const line = `${JSON.stringify({ id, command, args })}\n`;
    this.traffic.sentBytes += Buffer.byteLength(line);
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.stdin.write(line); });
  }
  async stop() { this.child.stdin.end(); await this.completed; }
}

async function build(owned: string) {
  const harness = path.join(owned, 'harness');
  mkdirSync(path.join(harness, 'src'), { recursive: true });
  copyFileSync(path.join(root, 'scripts/rust-book-search-benchmark.rs'), path.join(harness, 'src/main.rs'));
  copyFileSync(path.join(root, 'crates/drifting-document/Cargo.lock'), path.join(harness, 'Cargo.lock'));
  writeFileSync(path.join(harness, 'Cargo.toml'), `[package]\nname = "rust-book-search-benchmark"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n[dependencies]\ndrifting-document = { path = ${JSON.stringify(path.join(root, 'crates/drifting-document'))} }\nserde_json = "1"\nserde = { version = "1", features = ["derive"] }\n[workspace]\n`);
  const target = path.join(root, '.local-data/prose-metrics-benchmark/target');
  execFileSync('cargo', ['build', '--release', '--offline', '--manifest-path', path.join(harness, 'Cargo.toml')], {
    stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, RUSTC_WRAPPER: path.join(root, 'scripts/apple-performance-rustc-wrapper.sh') },
  });
  const binary = path.join(owned, 'rust-book-search-benchmark');
  copyFileSync(path.join(target, 'release/rust-book-search-benchmark'), binary);
  return { binary, binarySha256: sha(readFileSync(binary)), lockSha256: sha(readFileSync(path.join(harness, 'Cargo.lock'))) };
}

async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'rust-book-search-benchmark');
    assert.deepEqual(report.source, source);
    assert.deepEqual(report.limitations, limitations);
    assert.equal(report.repetitions, repetitions);
    assert.equal(report.results.length, scenarios.length * queries.length);
    for (const row of report.results) for (const lane of ['javascript', 'residentRust', 'transferredRust']) {
      assert.equal(row.exactTimedParity, true);
      assert.equal(row[lane].samples.length, repetitions);
      assert.deepEqual(row[lane], summary(row[lane].samples));
      assert(row[lane].samples.every((sample: Sample) => sample.elapsedMs > 0 && sample.internalMs > 0));
    }
    assert.equal(report.compatibility.length, 10);
    console.log('Source-matched Rust book search benchmark verified.');
    return;
  }
  mkdirSync(path.join(root, '.local-data/rust-book-search'), { recursive: true });
  const owned = mkdtempSync(path.join(root, '.local-data/rust-book-search/run-'));
  const artifact = await build(owned);
  const host = new SearchHost(artifact.binary);
  try {
    const results = [];
    for (const scenario of scenarios) {
      const docs = documents(scenario.nodes, scenario.units);
      const loadStarted = performance.now();
      await host.invoke('load', { docs });
      const residentLoadMs = performance.now() - loadStarted;
      for (const query of queries) {
        const samples = { javascript: [] as Sample[], residentRust: [] as Sample[], transferredRust: [] as Sample[] };
        const expected = collectBookMatches(query.text, docs);
        for (let i = -3; i < repetitions; i++) {
          const order = i % 2 === 0 ? ['javascript', 'residentRust', 'transferredRust'] as const : ['transferredRust', 'residentRust', 'javascript'] as const;
          for (const lane of order) {
            global.gc?.();
            const traffic = { ...host.traffic };
            const start = performance.now();
            let found: BookMatch[], internalMs: number;
            if (lane === 'javascript') {
              found = collectBookMatches(query.text, docs);
              internalMs = performance.now() - start;
            } else {
              const reply = await host.invoke(lane === 'residentRust' ? 'search' : 'search_once', {
                query: query.text, ...(lane === 'transferredRust' ? { docs } : {}),
              }) as { matches: WireMatch[]; rustElapsedMs: number };
              found = fromWire(reply.matches);
              internalMs = reply.rustElapsedMs;
            }
            const elapsedMs = performance.now() - start;
            assert.deepEqual(found, expected, `${scenario.name}/${query.name}/${lane}: output differs`);
            if (i >= 0) samples[lane].push({ elapsedMs, internalMs, matches: found.length,
              sentBytes: host.traffic.sentBytes - traffic.sentBytes, receivedBytes: host.traffic.receivedBytes - traffic.receivedBytes });
          }
        }
        const row = { scenario, query, residentLoadMs, inputSha256: sha(JSON.stringify(docs)),
          exactTimedParity: true, javascript: summary(samples.javascript), residentRust: summary(samples.residentRust), transferredRust: summary(samples.transferredRust) };
        results.push(row);
        console.log(JSON.stringify({ scenario: scenario.name, query: query.name, jsMs: row.javascript.medianMs,
          rustComputeMs: row.residentRust.internalMedianMs, residentMs: row.residentRust.medianMs, transferredMs: row.transferredRust.medianMs }));
      }
    }
    const cases = [
      { name: 'ascii-case', text: 'Hello hello', query: 'HELLO' },
      { name: 'cjk', text: '海风灯塔 海风', query: '海风' },
      { name: 'emoji', text: '甲👩🏽‍🚀乙👩🏽‍🚀', query: '👩🏽‍🚀' },
      { name: 'combining', text: 'E\u0301 É e\u0301', query: 'e\u0301' },
      { name: 'turkish-expansion-offset', text: 'İ target', query: 'target' },
      { name: 'greek-final-sigma', text: 'ΟΣ', query: 'ος' },
      { name: 'padded-query', text: 'x needle y needle z', query: ' needle ' },
      { name: 'whitespace-query', text: 'x  y', query: ' ' },
      { name: 'literal-regex-characters', text: '甲[x].*乙[x].*', query: '[x].*' },
      { name: 'excerpt-surrogate-boundary', text: 'a'.repeat(9) + '🚀' + 'x'.repeat(9) + 'needle' + 'y'.repeat(59) + '🚀', query: 'needle' },
    ];
    const compatibility = [];
    for (const item of cases) {
      const docs: ChapterDoc[] = [{ nodeId: 'synthetic-probe', index: 0, title: '', summary: '',
        contentJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'synthetic-block' }, content: [{ type: 'text', text: item.text }] }] }) }];
      const javascript = collectBookMatches(item.query, docs);
      const reply = await host.invoke('search_once', { docs, query: item.query }) as { matches: WireMatch[] };
      const rust = fromWire(reply.matches);
      compatibility.push({ ...item, equal: isDeepStrictEqual(javascript, rust), javascript, rust });
    }
    assert.deepEqual(provenance(), source, 'Source changed during benchmark');
    writeJson(output, { schemaVersion: 1, kind: 'rust-book-search-benchmark', measuredAt: new Date().toISOString(), source,
      artifact: { ...artifact, binary: undefined }, repetitions, limitations,
      environment: { cpu: os.cpus()[0]?.model, os: os.platform(), release: os.release(), arch: os.arch(), node: process.version,
        garbageCollectionBeforeSample: typeof global.gc === 'function', rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() },
      results, compatibility });
    console.log(`Search benchmark: ${path.relative(root, output)}`);
  } finally { await host.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
