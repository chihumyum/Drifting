import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createDesktopTauriEnvironment } from './run-desktop-tauri.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(root, 'scripts', 'run-signed-macos-dev.sh');
const selectorPath = path.join(root, 'scripts', 'select-macos-dev-signing-identity.mjs');
const runnerSource = await readFile(runnerPath, 'utf8');
const selectorSource = await readFile(selectorPath, 'utf8');
const runnerStat = await stat(runnerPath);
const environment = createDesktopTauriEnvironment();

const failures = [];
for (const target of ['AARCH64', 'X86_64']) {
  const setting = `CARGO_TARGET_${target}_APPLE_DARWIN_RUNNER`;
  if (environment[setting] !== runnerPath) {
    failures.push(`desktop launcher does not set ${setting} to the signed runner`);
  }
}
if ((runnerStat.mode & 0o111) === 0) failures.push('macOS dev runner is not executable');
if (!runnerSource.includes('--identifier "$DEV_CODE_IDENTIFIER"')) {
  failures.push('macOS dev runner does not apply the stable code identifier');
}
if (!runnerSource.includes('select-macos-dev-signing-identity.mjs')) {
  failures.push('macOS dev runner does not use the revocation-aware identity selector');
}
if (!selectorSource.includes("'-R',\n          'ocsp',\n          '-R',\n          'require'")) {
  failures.push('macOS dev identity selector does not require OCSP revocation checking');
}
if (runnerSource.includes("Cargo's default signature")) {
  failures.push(
    'macOS dev runner must fail closed instead of launching with an ad-hoc signature',
  );
}
if (/[A-F0-9]{40}/u.test(`${runnerSource}\n${selectorSource}`)) {
  failures.push(
    'macOS dev signing scripts must not contain a developer-specific certificate hash',
  );
}

if (process.platform === 'darwin') {
  const check = spawnSync(runnerPath, ['--check'], { encoding: 'utf8', env: environment });
  if (check.status !== 0) {
    failures.push(check.stderr.trim() || check.stdout.trim() || 'identity check failed');
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`macOS dev signing check: ${failure}`);
  process.exit(1);
}

console.log('macOS dev signing check passed');
