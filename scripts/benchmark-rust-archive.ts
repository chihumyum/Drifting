/** Whole JSON-pipe round trip for native ZIP compression vs current JSZip. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { createPortableMarkdownZip } from '../src/renderer/services/export/markdown-zip';
import { decodeDatabaseValue } from '../src/renderer/platform/database';
import { root, sha, writeJson } from './benchmark-prose-metrics';
const quick = process.argv.includes('--quick');
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? (quick ? '.local-data/rust-archive/quick.json' : 'docs/acceptance/rust-archive-benchmark.json'));
const warmups = quick ? 1 : 2, repetitions = quick ? 1 : 7;
const scenarios = [ { files: 20, units: 5_000 }, { files: 200, units: 5_000 }, { files: 1_000, units: 5_000 }, { files: 20, units: 50_000 } ];
const sources = ['src-tauri/Cargo.lock', 'crates/drifting-core/Cargo.toml', 'crates/drifting-core/src/archive.rs', 'src/renderer/services/export/markdown-zip.ts', 'src/renderer/platform/database.ts', 'scripts/benchmark-rust-archive.ts', 'scripts/rust-archive-benchmark.rs', 'src/renderer/services/export/relational-markdown.service.ts', 'pnpm-lock.yaml'];
const provenance = () => sha(sources.map(file => `${file}\0${sha(readFileSync(file))}`).join('\n'));
const summary = (samples: number[]) => ({ medianMs: [...samples].sort((a,b) => a-b)[Math.floor(samples.length / 2)], samples });
function fixture(count: number, units: number) {
  let seed = 91331;
  const words = ['灯塔', '远方', '城市', '飞鸟', '雨夜', '沉默', '合成测试', 'hello', 'world', 'ＡＢＣ', '👩🏽‍🚀', 'é'];
  return Array.from({ length: count }, (_, i) => {
    let text = `---\ntitle: Synthetic ${i}\n---\n\n# 合成章 ${i}\n\n`;
    while (text.length < units) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += `${words[seed % words.length]}${seed % 13 === 0 ? ` ${seed}。\n\n` : ' '}`;
    }
    return { path: `books/合成-${i % 5}/chapters/${String(i).padStart(6, '0')}-章.md`, text };
  });
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
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.kind, 'rust-archive-benchmark'); assert.equal(report.source, source);
    assert.equal(report.repetitions, repetitions); assert.equal(report.warmups, warmups);
    for (const r of report.scenarios) { assert.equal(r.filesAndContentParity, true); for (const lane of ['js', 'rust']) assert.deepEqual(r[lane], summary(r[lane].samples)); }
    assert.deepEqual(report.gate, gate);
    for (const result of report.scenarios) assert.deepEqual(result.assessment, assess(result.js.samples, result.rust.samples));
    assert.equal(report.accepted, report.scenarios.filter((r: {assessment: {benefit: boolean}}) => r.assessment.benefit).length >= gate.minimumBenefitingCases && !report.scenarios.some((r: {assessment: {regression: boolean}}) => r.assessment.regression));
    console.log('Source-matched archive benchmark verified.'); return;
  }
  const base = path.join(root, '.local-data/rust-archive'); mkdirSync(base, { recursive: true });
  const owned = mkdtempSync(path.join(base, 'run-')); mkdirSync(path.join(owned, 'src'));
  copyFileSync('scripts/rust-archive-benchmark.rs', path.join(owned, 'src/main.rs'));
  for (const file of execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'crates/drifting-core', 'drizzle'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const target = path.join(owned, file); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(file, target);
  }
  copyFileSync('src-tauri/Cargo.lock', path.join(owned, 'Cargo.lock'));
  writeFileSync(path.join(owned, 'Cargo.toml'), `[package]\nname="rust-archive-benchmark"\nversion="0.0.0"\nedition="2021"\npublish=false\n[dependencies]\ndrifting-core={path="./crates/drifting-core"}\nbase64="0.22"\nserde_json="1"\n[workspace]\n`);
  execFileSync('cargo', ['build', '--release', '--offline', '--manifest-path', path.join(owned, 'Cargo.toml')], { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: path.join(base, 'target'), RUSTC_WRAPPER: path.join(root, 'scripts/apple-performance-rustc-wrapper.sh') } });
  const binary = path.join(base, 'target/release/rust-archive-benchmark');
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let pending: ((value: Uint8Array) => void) | undefined;
  createInterface({ input: child.stdout }).on('line', line => { const resolve = pending!; pending = undefined; resolve(decodeDatabaseValue({ type: 'blobBase64', value: JSON.parse(line).bytes }) as Uint8Array); });
  try {
    const results = [];
    for (const scenario of scenarios) {
      const files = fixture(scenario.files, scenario.units);
      const samples = { js: [] as number[], rust: [] as number[] }; const sizes = { js: 0, rust: 0 };
      for (let sample = -warmups; sample < repetitions; sample++) {
        for (const lane of (sample % 2 === 0 ? ['js', 'rust'] : ['rust', 'js']) as ('js' | 'rust')[]) {
          global.gc?.(); const started = performance.now(); let bytes: Uint8Array;
          if (lane === 'js') {
            bytes = await createPortableMarkdownZip(files);
          } else {
            bytes = await new Promise<Uint8Array>(resolve => { pending = resolve; child.stdin.write(`${JSON.stringify({ files })}\n`); });
          }
          const elapsed = performance.now() - started; sizes[lane] = bytes.length;
          const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
          assert.deepEqual(Object.values(zip.files).filter(f => !f.dir).map(f => f.name).sort(), files.map(f => f.path).sort());
          for (const file of files) {
            const actual = await zip.file(file.path)!.async('uint8array');
            const expected = new TextEncoder().encode(file.text);
            assert.equal(sha(actual), sha(expected), `ZIP UTF-8 byte mismatch: ${lane} ${file.path}`);
          }
          if (sample >= 0) samples[lane].push(elapsed);
        }
      }
      const result = { scenario, js: summary(samples.js), rust: summary(samples.rust), sizes, assessment: assess(samples.js, samples.rust), filesAndContentParity: true }; results.push(result);
      console.log(JSON.stringify({ scenario, js: result.js.medianMs, rust: result.rust.medianMs, sizes }));
    }
    assert.equal(provenance(), source);
    writeJson(output, { schemaVersion: 1, kind: 'rust-archive-benchmark', source, measuredAt: new Date().toISOString(), repetitions, warmups,
      limitations: ['Packing only: synthetic Markdown entries, no prose hydration, metadata rendering or save dialog. Baseline uses current JSZip with whole-string TextEncoder to fix its surrogate-pair chunk bug; candidate uses production create_text_zip.', 'Node/V8 JSZip vs Release Rust ZIP/flate2; includes JSON transport and portable base64 decoding. Product uses a binary Tauri response, so this includes an extra encoding step; neither is actual IPC timing.', 'Two warmup pairs then seven alternating pairs; exact extracted paths/text and CRC checks each sample. ZIP byte identity and directory-only entries are not required.'],
      environment: { cpu: os.cpus()[0]?.model, node: process.version, os: os.release() }, binarySha256: sha(readFileSync(binary)), lockSha256: sha(readFileSync(path.join(owned, 'Cargo.lock'))), gate, accepted: results.filter(r => r.assessment.benefit).length >= gate.minimumBenefitingCases && !results.some(r => r.assessment.regression), scenarios: results });
  } finally { child.stdin.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
