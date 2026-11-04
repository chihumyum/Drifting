#!/usr/bin/env node
// Account-isolated libraries (docs/hosted-sync/account-libraries.md): runs the
// native registry and renderer session tests and records them with the hashes
// of the sources they cover. `--check` verifies the evidence is current.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const output = 'docs/hosted-sync/acceptance/account-libraries.json';
const rendererSuites = [
  'src/renderer/services/account-library.test.ts',
  'src/renderer/store/auth.account-libraries.test.ts',
  'src/renderer/store/auth.test.ts',
  'src/renderer/features/auth/auth-entry.acceptance.test.ts',
  'src/renderer/features/settings/hosted-settings-boundary.acceptance.test.ts',
];
// `macos_relaunch` is compiled on macOS only.
const nativeFilters = ['library_registry', 'macos_relaunch'];
const sourceFiles = [
  'docs/hosted-sync/account-libraries.md',
  'scripts/generate-account-library-evidence.mjs',
  'scripts/run-signed-macos-dev.sh',
  'src-tauri/src/data_paths.rs',
  'src-tauri/src/library_registry.rs',
  'src-tauri/src/macos_relaunch.rs',
  'src/renderer/features/auth/SignOutDialog.tsx',
  'src/renderer/platform/contracts.ts',
  'src/renderer/platform/tauri.ts',
  'src/renderer/platform/types.ts',
  'src/renderer/services/account-library.ts',
  'src/renderer/services/built-in-sample/first-run.ts',
  'src/renderer/store/auth.ts',
  ...rendererSuites,
].sort();

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const contract = {
  registry: 'libraries.json in the App-local base root; legacy library keeps the base root',
  switching:
    'relaunch through the quit flush barrier; a packaged macOS App reopens through LaunchServices; mobile keeps one library',
  sourceSha256: Object.fromEntries(sourceFiles.map((file) => [file, sha(file)])),
};

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  if (JSON.stringify(report.contract) !== JSON.stringify(contract) || report.automated.status !== 'passed') {
    throw new Error('Account library evidence is stale; run pnpm account-libraries:evidence');
  }
  console.log('Account library evidence is current. The Hosted sign-in round trip remains a separate gate.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-account-libraries-'));
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
      ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--', ...nativeFilters],
      { encoding: 'utf8' },
    );
    if (native.status !== 0) throw new Error(`Native tests failed\n${native.stdout}\n${native.stderr}`);
    const totals = /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(native.stdout);
    if (!totals || Number(totals[1]) === 0) throw new Error('Native library registry tests are missing');
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
          command: `cargo test --manifest-path src-tauri/Cargo.toml --lib -- ${nativeFilters.join(' ')}`,
        },
      },
      hostedRoundTrip: {
        status: 'not-run',
        gates: [
          'sign in from the local library opens and restores the account library',
          'sign out returns to the local library and back again resumes pending uploads',
          'expired session keeps the account library',
        ],
      },
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Generated ${output}: ${result.numPassedTests} renderer tests; ${totals[1]} native tests.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
