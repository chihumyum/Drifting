/** Complete local relational export: SQLite capture, Yjs hydration, render, ZIP. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import loglevel from 'loglevel';
import JSZip from 'jszip';
import { root, sha, seedFixture, NOW, writeJson } from './benchmark-prose-metrics';
import { buildHost, provenance as dependencyProvenance } from './benchmark-rust-cold-prose';
import { Host, databaseDigest } from './benchmark-database-transport';
import { createDatabasePlatform, decodeDatabaseValue } from '../src/renderer/platform/database';
import { createDatabaseClient, installHeadlessDatabaseClient } from '../src/renderer/lib/db';
import { readLocalRelationalMarkdownSource } from '../src/renderer/services/export/relational-markdown.local-source';
import { buildRelationalMarkdownArchive } from '../src/renderer/services/export/relational-markdown.service';
import { createPortableMarkdownZip, type MarkdownZipEntry } from '../src/renderer/services/export/markdown-zip';
const quick = process.argv.includes('--quick');
const warmups = quick ? 1 : 2, repetitions = quick ? 1 : 7;
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? (quick ? '.local-data/rust-export/quick.json' : 'docs/acceptance/rust-export-benchmark.json'));
const scenarios = [
  { name: 'small-book', nodes: quick ? 4 : 20, units: 5000, tail: 8 },
  { name: 'novel', nodes: quick ? 8 : 200, units: 5000, tail: 8 },
  { name: 'library', nodes: quick ? 16 : 1000, units: 5000, tail: 8 },
  { name: 'long-chapters', nodes: quick ? 2 : 20, units: 50_000, tail: 8 },
];
const summarize = (samples: number[]) => ({ medianMs: [...samples].sort((a,b) => a-b)[Math.floor(samples.length/2)], samples });
const limitations = [
  'Production local SQLite export capture, Yjs snapshot/tail hydration, Markdown relationships/rendering and ZIP creation. Excludes open-editor flush waits and the OS save dialog/write. Both lanes use compact database transport.',
  'Baseline is production portable JSZip after the whole-string UTF-8 fix. Candidate is production Rust create_text_zip. Exact extracted file paths, all file bytes, CRC, filename, document count and unchanged database contents are checked on every pair.',
  'Node/V8 and Release Rust with JSON-lines instead of WKWebView/Tauri IPC. Hydration uses the inline fallback. Benchmark returns base64 plus portable JS decode; product returns a binary Tauri response without base64.',
  'Two warmup pairs then seven alternating measured pairs on fresh synthetic SQLite copies; GC outside timing, no OS cache flush. Node-heavy books with empty secondary collections; rich relationship correctness remains covered by export acceptance tests.',
];
function provenance() {
  const files = ['scripts/benchmark-rust-export.ts', 'src-tauri/src/native_capabilities.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  return { dependencies: dependencyProvenance(), harness: sha(files.map(file => `${file}\0${sha(readFileSync(file))}`).join('\n')) };
}
async function extracted(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  return Promise.all(Object.values(zip.files).filter(f => !f.dir).sort((a,b) => a.name.localeCompare(b.name)).map(async file => [file.name, sha(await file.async('uint8array'))]));
}
const gate = { minimumImprovement: 0.15, minimumBenefitingCases: 2, minimumWinningPairs: 6, maximumRegression: 0.05 };
function assess(baseline: number[], candidate: number[]) {
  const median = (values: number[]) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
  const improvement = 1 - median(candidate) / median(baseline);
  const winningPairs = candidate.filter((value, i) => value < baseline[i]).length;
  return { improvement, winningPairs, benefit: improvement >= gate.minimumImprovement && winningPairs >= gate.minimumWinningPairs,
    regression: improvement < -gate.maximumRegression };
}
async function main() {
  const source = provenance();
  if (process.argv.includes('--check')) {
    const report = JSON.parse(readFileSync(output, 'utf8')); assert.equal(report.kind, 'rust-export-benchmark'); assert.deepEqual(report.source, source);
    assert.deepEqual(report.limitations, limitations); assert.equal(report.repetitions, repetitions); assert.equal(report.warmups, warmups);
    assert.deepEqual(report.scenarios.map((r: {scenario: unknown}) => r.scenario), scenarios);
    for (const result of report.scenarios) {
      assert.equal(result.exactExtractedParity, true); assert.equal(result.databaseUnchanged, true);
      for (const lane of ['baseline', 'candidate']) { assert.deepEqual(result[lane], summarize(result[lane].samples)); assert.equal(result[lane].samples.length, repetitions); }
    }
    assert.deepEqual(report.gate, gate);
    for (const result of report.scenarios) assert.deepEqual(result.assessment, assess(result.baseline.samples, result.candidate.samples));
    assert.equal(report.accepted, report.scenarios.filter((r: {assessment: {benefit: boolean}}) => r.assessment.benefit).length >= gate.minimumBenefitingCases && !report.scenarios.some((r: {assessment: {regression: boolean}}) => r.assessment.regression));
    console.log('Source-matched Rust export benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/rust-export'); mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-')); const directory = path.join(owned, 'databases'); mkdirSync(directory);
  writeFileSync(path.join(directory, '.synthetic-prose-metrics-benchmark'), 'synthetic only');
  const artifact = await buildHost(owned); const host = new Host(artifact.binary, directory);
  const platform = createDatabasePlatform((command, args) => host.invoke(command, { ...args, compact: true }));
  const release = installHeadlessDatabaseClient(createDatabaseClient(platform), 'synthetic-export');
  loglevel.getLogger('DbLib').setLevel('warn');
  const nativeZip = async (entries: MarkdownZipEntry[]) => decodeDatabaseValue({ type: 'blobBase64', value: await host.invoke('archive_create_text_zip', { entries }) }) as Uint8Array;
  try {
    const results = [];
    for (const scenario of scenarios) {
      const fixture = `${scenario.name}-fixture.db`; const fixturePath = path.join(directory, fixture);
      await platform.open(fixture); await platform.close(); seedFixture(fixturePath, scenario); const before = databaseDigest(fixturePath);
      const samples = { baseline: [] as number[], candidate: [] as number[] }; const sizes = { baseline: 0, candidate: 0 };
      for (let sample = -warmups; sample < repetitions; sample++) {
        let expected: unknown;
        for (const lane of (sample % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) as ('baseline'|'candidate')[]) {
          const name = `${scenario.name}-${lane}-${sample}.db`; const file = path.join(directory, name); copyFileSync(fixturePath, file); await platform.open(name);
          global.gc?.(); const started = performance.now();
          const archive = await buildRelationalMarkdownArchive(await readLocalRelationalMarkdownSource(), new Date(NOW), lane === 'baseline' ? createPortableMarkdownZip : nativeZip);
          const elapsed = performance.now() - started; sizes[lane] = archive.bytes.length;
          const actual = { filename: archive.filename, documentCount: archive.documentCount, entries: await extracted(archive.bytes) };
          if (expected) assert.deepEqual(actual, expected); expected = actual;
          assert.deepEqual(databaseDigest(file), before);
          if (sample >= 0) samples[lane].push(elapsed); await platform.close();
        }
      }
      const result = { scenario, baseline: summarize(samples.baseline), candidate: summarize(samples.candidate), sizes, assessment: assess(samples.baseline, samples.candidate), exactExtractedParity: true, databaseUnchanged: true };
      results.push(result); console.log(JSON.stringify({ name: scenario.name, baseline: result.baseline.medianMs, candidate: result.candidate.medianMs, sizes }));
    }
    assert.deepEqual(provenance(), source);
    writeJson(output, { schemaVersion: 1, kind: 'rust-export-benchmark', measuredAt: new Date().toISOString(), source, warmups, repetitions, limitations,
      environment: { cpu: os.cpus()[0]?.model, os: os.release(), node: process.version }, artifact: { ...artifact, binary: undefined }, gate, accepted: results.filter(r => r.assessment.benefit).length >= gate.minimumBenefitingCases && !results.some(r => r.assessment.regression), scenarios: results });
  } finally { release(); await host.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
