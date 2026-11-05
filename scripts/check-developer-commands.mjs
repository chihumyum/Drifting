#!/usr/bin/env node

// pnpm dev:commands:check — the developer commands start on this platform
// (docs/windows.md, "Developing on Windows"). It starts the tools the
// launchers run without a shell, prints the isolated profile manifests, asks
// the developer CLI for help and seeds a lite library into a temporary folder
// whose path contains a space. It launches no app and builds nothing; the
// `windows / developer commands` job runs it on Windows.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageBinInvocation, pnpmInvocation } from './package-bin.mjs';
import { tauriCliInvocation } from './run-desktop-tauri.mjs';
import { runSeedProcess } from './run-seeded-dev.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = { executable: process.execPath, arguments: [] };

function run(label, invocation, args) {
  const result = spawnSync(invocation.executable, [...invocation.arguments, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  assert.equal(result.status, 0, `${label} exited with ${result.status ?? result.signal}\n${result.stderr}`);
  return result.stdout;
}

const lastJsonLine = (output) => JSON.parse(output.trim().split(/\r?\n/u).filter((line) => line.startsWith('{')).pop());

let passed = 0;
function check(name, verify) {
  verify();
  passed += 1;
  console.log(`ok - ${name}`);
}

check('the Tauri CLI starts', () => {
  assert.match(run('tauri --version', tauriCliInvocation(), ['--version']), /tauri-cli \d/u);
});
for (const tool of ['vite', 'tsx', 'vitest']) {
  check(`${tool} starts`, () => assert.match(run(`${tool} --version`, packageBinInvocation(tool), ['--version']), /\d+\.\d+\.\d+/u));
}
check('pnpm starts', () => assert.match(run('pnpm --version', pnpmInvocation(), ['--version']), /^\d+\.\d+\.\d+/u));

check('pnpm dev:worktree --print-config', () => {
  const manifest = JSON.parse(run('dev:worktree', node, ['scripts/run-worktree-dev.mjs', '--instance', 'commands-check', '--print-config']));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.worktreeRoot, realpathSync(root));
  assert.equal(manifest.instance, 'commands-check');
  assert.equal(manifest.mode, 'local-only');
  assert.equal(path.relative(manifest.worktreeRoot, manifest.databaseDirectory).split(path.sep)[0], '.local-data');
  assert.ok(Number.isInteger(manifest.port) && manifest.devUrl === `http://127.0.0.1:${manifest.port}`);
});
check('pnpm dev:seed:lite --print-config', () => {
  const manifest = JSON.parse(run('dev:seed:lite', node, ['scripts/run-seeded-dev.mjs', '--lite', '--print-config']));
  assert.equal(manifest.seedPreset, 'lite');
  assert.equal(manifest.instance, 'seed-lite-v2');
});
check('pnpm drifting help', () => {
  const envelope = lastJsonLine(run('drifting help', pnpmInvocation(), ['-s', 'drifting', 'help']));
  assert.equal(envelope.ok, true);
  assert.match(envelope.data, /frontend serve --platform android\|ios\|desktop/u);
});
check('pnpm dev:seed seeds a lite library', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting commands-check-'));
  try {
    const result = runSeedProcess({
      root, preset: 'lite',
      databasePath: path.join(directory, 'databases', 'drifting-library.db'),
      appLocalDataDirectory: path.join(directory, 'app data'),
    });
    assert.equal(result.seeded, true);
    assert.equal(result.statistics.foreignKeyViolations, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

console.log(`Developer commands start on ${process.platform}/${process.arch}: ${passed} checks passed.`);
