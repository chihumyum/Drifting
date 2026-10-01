#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const reportPath = 'docs/agent-runtime/acceptance/local-mcp.json';
function fingerprint() {
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      }).split('\n'),
    ),
  ]
    .filter(
      (file) =>
        existsSync(file) &&
        (file.startsWith('src/renderer/lib/agent/') ||
          file.startsWith('src/renderer/platform/') ||
          file.startsWith('src/renderer/components/agent/AgentMcp') ||
          file.startsWith('src-tauri/src/mcp_server') ||
          [
            'src-tauri/src/lib.rs',
            'src-tauri/src/main.rs',
            'src-tauri/Cargo.toml',
            'src-tauri/Cargo.lock',
            'src/renderer/app/providers/ProjectRuntimeProvider.tsx',
            'src/renderer/features/settings/panels/AgentSettingsPanel.tsx',
            'src/renderer/locales/en.json',
            'src/renderer/locales/zh-CN.json',
            'scripts/run-mcp-acceptance.mjs',
            'scripts/mcp-live-smoke.mjs',
            'scripts/mcp-client-setup-smoke.mjs',
            'package.json',
            'pnpm-lock.yaml',
          ].includes(file)),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(file));
  return hash.digest('hex');
}
if (process.argv.includes('--record-live')) {
  const modes = ['write', 'read', 'editor', 'reconnect', 'unmounted', 'revoked', 'active-revocation'];
  const runs = modes.map((mode) => {
    const report = JSON.parse(readFileSync(`.local-data/mcp-acceptance/live-${mode}.json`, 'utf8'));
    assert.equal(report.status, 'passed');
    assert.equal(report.synthetic, true);
    assert.ok(report.checks.length > 0 && report.checks.every((check) => check.status === 'passed'));
    return { mode, generatedAt: report.generatedAt, checks: report.checks };
  });
  writeFileSync('docs/agent-runtime/acceptance/local-mcp-mac.json', JSON.stringify({
    kind: 'packaged-mac-mcp-sdk', generatedAt: new Date().toISOString(), status: 'passed', synthetic: true,
    artifact: 'local Mac debug bundle, ad-hoc signed', runs,
    boundaries: { ui: 'separate observed native UI acceptance', remote: 'not tested', mobile: 'deferred' },
  }, null, 2) + '\n');
  console.log(`Recorded ${runs.reduce((sum, run) => sum + run.checks.length, 0)} packaged MCP checks.`);
} else if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceSha256, fingerprint(), 'Local MCP acceptance is stale');
  console.log('Local MCP acceptance matches current source.');
} else {
  assert.equal(process.platform, 'darwin', 'Mac acceptance must run on macOS');
  const before = fingerprint();
  mkdirSync('.local-data/mcp-acceptance', { recursive: true });
  const testPath = '.local-data/mcp-acceptance/tests.json';
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts',
      'src/renderer/components/agent/AgentMcpAccessState.test.ts',
      '--reporter=json',
      `--outputFile=${testPath}`,
    ],
    { stdio: 'inherit' },
  );
  assert.equal(result.status, 0, 'MCP domain acceptance failed');
  const native = spawnSync(
    'cargo',
    ['test', '--manifest-path', 'src-tauri/Cargo.toml', 'mcp_server', '--lib'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync('.local-data/mcp-acceptance/native.log', native.stdout + native.stderr);
  assert.equal(native.status, 0, 'MCP native acceptance failed; see local native.log');
  const nativeChecks = [...native.stdout.matchAll(/^test (mcp_server::.+) \.\.\. ok$/gm)].map(
    (match) => ({ name: match[1], status: 'passed' }),
  );
  assert.ok(nativeChecks.length >= 4);
  const tests = JSON.parse(readFileSync(testPath, 'utf8'));
  assert.equal(before, fingerprint(), 'Source changed during MCP acceptance');
  const checks = tests.testResults.flatMap((suite) =>
    suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status })),
  );
  assert.ok(checks.every((test) => test.status === 'passed'));
  mkdirSync('docs/agent-runtime/acceptance', { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        kind: 'local-mcp-runtime-and-native-ipc',
        generatedAt: new Date().toISOString(),
        sourceSha256: before,
        status: 'passed',
        synthetic: true,
        checks: [...checks, ...nativeChecks],
        boundaries: {
          runtime: 'production tool composition, file-backed SQLite, Yjs and authored sync journal',
          authentication: 'real private Unix socket, native credential checks and cancellation',
          packagedApp: 'separate mcp-live-smoke and native UI acceptance',
          mobile: 'deferred',
          remoteOAuth: 'not implemented',
          productionSigning: 'not claimed',
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Local MCP acceptance: ${checks.length + nativeChecks.length} checks passed.`);
}
