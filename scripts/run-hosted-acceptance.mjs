#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const reportPath = 'docs/hosted-sync/acceptance/client.json';
function fingerprint() {
  const paths = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      }).split('\n'),
    ),
  ]
    .filter(
      (file) =>
        /^(src\/|src-tauri\/src\/|src-tauri\/build.rs$|src-tauri\/Cargo.(toml|lock)$|src-tauri\/tauri.*json$|scripts\/run-(hosted-|mobile-dev|desktop-tauri)|package.json$|pnpm-lock.yaml$)/.test(
          file,
        ) && existsSync(file),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of paths) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.sourceSha256, fingerprint(), 'Hosted evidence is stale');
  assert.equal(report.status, 'passed');
  assert.ok(report.checks.length >= 10 && report.checks.every((item) => item.status === 'passed'));
  console.log('Hosted acceptance evidence matches current source.');
} else {
  const origin = process.env.HOSTED_TEST_ORIGIN ?? 'http://localhost:3000';
  assert.ok(
    ['localhost', '127.0.0.1'].includes(new URL(origin).hostname),
    'Local disposable service required',
  );
  const before = fingerprint();
  mkdirSync('.local-data/hosted-acceptance', { recursive: true });
  const raw = '.local-data/hosted-acceptance/vitest.json';
  const execution = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'src/renderer/sync/hosted/hosted.integration.test.ts',
      'src/renderer/sync/hosted/adopt-drive.integration.test.ts',
      'src/renderer/sync/hosted/connect.test.ts',
      'src/renderer/sync/production-runtime.test.ts',
      'src/renderer/features/settings/personal-cloud-settings.acceptance.test.ts',
      'src/renderer/lib/config.network.test.ts',
      'src/renderer/sync/hosted/runtime.test.ts',
      'src/renderer/sync/engine/scheduler.test.ts',
      'src/renderer/sync/providers/hosted/provider.test.ts',
      'src/renderer/store/auth.test.ts',
      'src/renderer/store/auth.local-only.test.ts',
      'src/renderer/lib/hosted-account.test.ts',
      'src/renderer/lib/hosted-profile.test.ts',
      'src/renderer/sync/providers/hosted/tauri-transport.test.ts',
      'src/renderer/lib/session-token.test.ts',
      'src/renderer/lib/auth-client-race.test.ts',
      'src/renderer/lib/feature-access.test.ts',
      'src/renderer/sync/journal/installation-identity.test.ts',
      'src/renderer/sync/journal/repository.integration.test.ts',
      'src/renderer/sync/hosted/sign-in.test.ts',
      '--reporter=json',
      `--outputFile=${raw}`,
    ],
    { env: { ...process.env, HOSTED_TEST_ORIGIN: origin }, stdio: 'inherit' },
  );
  if (execution.status !== 0)
    throw new Error('Hosted acceptance failed; the prior passing report was not replaced');
  const tests = JSON.parse(readFileSync(raw, 'utf8'));
  assert.equal(before, fingerprint(), 'Source changed during acceptance');
  const health = await (await fetch(`${origin}/health`)).json();
  const report = {
    kind: 'hosted-client-http-sqlite',
    generatedAt: new Date().toISOString(),
    sourceSha256: before,
    status: 'passed',
    synthetic: true,
    serviceProtocol: health.protocol,
    checks: tests.testResults.flatMap((suite) =>
      suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status })),
    ),
    boundaries: {
      objectTransport: 'real HTTP',
      localDatabases: 'independent file-backed SQLite',
      prose: 'production Yjs journal and reducer',
      objectStaging: 'in-memory test adapter',
      assetActivation: 'synthetic byte-verified port',
      nativeInteraction: 'separate manual acceptance',
      physicalDevices: 'not claimed',
      productionDeployment: 'not performed',
    },
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Hosted acceptance passed: ${report.checks.length} cases; source fingerprint recorded.`,
  );
}
