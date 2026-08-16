import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const runnerPath = path.join(root, 'scripts', 'run-signed-macos-dev.sh');
const runnerSource = await readFile(runnerPath, 'utf8');
const runnerStat = await stat(runnerPath);
const devScript = packageJson.scripts?.['tauri:dev'] ?? '';

const failures = [];
for (const target of ['AARCH64', 'X86_64']) {
  const setting =
    `CARGO_TARGET_${target}_APPLE_DARWIN_RUNNER=../scripts/run-signed-macos-dev.sh`;
  if (!devScript.includes(setting)) failures.push(`tauri:dev is missing ${setting}`);
}
if ((runnerStat.mode & 0o111) === 0) failures.push('macOS dev runner is not executable');
if (!runnerSource.includes('--identifier "$DEV_CODE_IDENTIFIER"')) {
  failures.push('macOS dev runner does not apply the stable code identifier');
}
if (!runnerSource.includes('"Apple Development:')) {
  failures.push('macOS dev runner does not discover Apple Development identities');
}
if (/[A-F0-9]{40}/u.test(runnerSource)) {
  failures.push('macOS dev runner must not contain a developer-specific certificate hash');
}

if (process.platform === 'darwin') {
  const check = spawnSync(runnerPath, ['--check'], { encoding: 'utf8' });
  if (check.status !== 0) {
    failures.push(check.stderr.trim() || check.stdout.trim() || 'identity check failed');
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`macOS dev signing check: ${failure}`);
  process.exit(1);
}

console.log('macOS dev signing check passed');
