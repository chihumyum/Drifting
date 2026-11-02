#!/usr/bin/env node
// Moving a book between libraries (docs/book-transfer.md): runs the renderer
// round-trip, rewriting and file suites and the native book_transfer tests,
// and records them with the hashes of the sources they cover. `--check`
// verifies the evidence is current.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const output = 'docs/acceptance/book-transfer.json';
const rendererSuites = [
  'src/renderer/services/book-transfer/book-transfer.integration.test.ts',
  'src/renderer/services/book-transfer/id-rewriter.test.ts',
  'src/renderer/services/book-transfer/book-file.test.ts',
  'src/renderer/platform/tauri.test.ts',
];
const sourceFiles = [
  'docs/book-transfer.md',
  'scripts/generate-book-transfer-evidence.mjs',
  'src-tauri/src/book_transfer.rs',
  'src/renderer/components/topBars/UserMenu.tsx',
  'src/renderer/services/book-transfer/book-file.ts',
  'src/renderer/services/book-transfer/book-transfer.service.ts',
  'src/renderer/services/book-transfer/export-book.ts',
  'src/renderer/services/book-transfer/id-rewriter.ts',
  'src/renderer/services/book-transfer/import-book.ts',
  'src/renderer/services/book-transfer/reducer-replay.ts',
  'src/renderer/sync/assets/local-authored-blob.ts',
  'src/renderer/sync/checkpoint/capture.ts',
  'src/renderer/sync/checkpoint/domain-catalog.ts',
  'src/renderer/sync/checkpoint/validate.ts',
  'src/renderer/sync/journal/yjs-update.ts',
  'src/renderer/views/ProjectPickerView.tsx',
  ...rendererSuites,
].sort();

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const contract = {
  file: '.driftingbook: CBOR envelope around a payload v2 snapshot package, its commit marker and asset variants',
  import: 'validated as a restore; every row id replaced; reducer state replayed as local authored change-sets; one transaction',
  sourceSha256: Object.fromEntries(sourceFiles.map((file) => [file, sha(file)])),
};

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  if (JSON.stringify(report.contract) !== JSON.stringify(contract) || report.automated.status !== 'passed') {
    throw new Error('Book transfer evidence is stale; run pnpm book-transfer:evidence');
  }
  console.log('Book transfer evidence is current. Packaged pickers and a Hosted publish remain separate gates.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-book-transfer-'));
  try {
    const jsonPath = path.join(temporary, 'tests.json');
    const renderer = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', ...rendererSuites, '--reporter=json', `--outputFile=${jsonPath}`],
      { encoding: 'utf8' },
    );
    if (renderer.status !== 0) throw new Error(`Renderer tests failed\n${renderer.stdout}\n${renderer.stderr}`);
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const native = spawnSync(
      'cargo',
      ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'book_transfer'],
      { encoding: 'utf8' },
    );
    if (native.status !== 0) throw new Error(`Native tests failed\n${native.stdout}\n${native.stderr}`);
    const totals = /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(native.stdout);
    if (!totals || Number(totals[1]) === 0) throw new Error('Native book transfer tests are missing');
    const report = {
      contract,
      automated: {
        status: 'passed',
        renderer: {
          passed: result.numPassedTests,
          failed: result.numFailedTests,
          skipped: result.numPendingTests,
          cases: result.testResults
            .flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status })))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
        native: {
          passed: Number(totals[1]),
          failed: Number(totals[2]),
          ignored: Number(totals[3]),
          command: 'cargo test --manifest-path src-tauri/Cargo.toml --lib book_transfer',
        },
      },
      manual: {
        status: 'not-run',
        gates: [
          'export and import through the native pickers in a packaged desktop build',
          'an imported book publishes to a Hosted account and restores on another device',
        ],
      },
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Generated ${output}: ${result.numPassedTests} renderer tests; ${totals[1]} native tests.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
