import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const output = 'docs/acceptance/sentry-observability.json';
const suites = [
  'src/renderer/services/diagnostics',
  'src/renderer/services/update/update-service.test.ts',
  'src/renderer/platform/sentry-environment.acceptance.test.ts',
  'src/renderer/platform/desktop-tauri-launcher.acceptance.test.ts',
  'src/renderer/platform/worktree-dev-launcher.acceptance.test.ts',
];
const sourceFiles = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.env.example', 'PRIVACY.md',
  'scripts/generate-sentry-observability.ts', 'scripts/sentry-environment.mjs',
  'scripts/run-sentry-browser.mjs', 'scripts/renderer-sentry-acceptance.ts',
  'scripts/renderer-sentry-acceptance.html', 'scripts/renderer-headless-browser.mjs',
  'scripts/run-desktop-tauri.mjs', 'scripts/run-worktree-dev.mjs', 'scripts/run-hosted-client.mjs',
  'vite.renderer.config.ts', 'docs/crash-reports.md', 'docs/sentry-observability.md',
  'src/renderer/services/diagnostics/crash-reporter.ts',
  'src/renderer/services/diagnostics/crash-reporter.test.ts',
  'src/renderer/services/diagnostics/crash-sanitize.ts',
  'src/renderer/services/diagnostics/crash-sanitize.test.ts',
  'src/renderer/services/diagnostics/sentry-policy.ts',
  'src/renderer/services/diagnostics/sentry-policy.test.ts',
  'src/renderer/services/diagnostics/sentry-reporter.ts',
  'src/renderer/services/diagnostics/sentry-reporter.test.ts',
  'src/renderer/services/update/update-service.ts',
  'src/renderer/services/update/update-service.test.ts',
  'src/renderer/platform/sentry-environment.acceptance.test.ts',
  'src/renderer/platform/desktop-tauri-launcher.acceptance.test.ts',
  'src/renderer/platform/worktree-dev-launcher.acceptance.test.ts',
  'src/renderer/sync/production-runtime.ts', 'src/renderer/vite-env.d.ts',
  'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json',
].sort();
const contract = {
  milestone: 'sentry-client-operational-diagnostics',
  delivery: 'optional-direct-sentry-with-existing-hosted-fallback-when-unconfigured',
  automatedTransport: 'real-sdk-unit-and-minified-browser-loopback-https',
  sourceSha256: Object.fromEntries(sourceFiles.map(file => [file,
    `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`])),
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  if (JSON.stringify(report.contract) !== JSON.stringify(contract) || report.automated.status !== 'passed') {
    throw new Error('Sentry evidence is stale; run pnpm diagnostics:sentry:evidence');
  }
  const browser = spawnSync(process.execPath, ['scripts/run-sentry-browser.mjs', '--check'], { encoding: 'utf8' });
  if (browser.status !== 0) throw new Error(`Sentry browser evidence is stale\n${browser.stdout}\n${browser.stderr}`);
  console.log('Sentry unit/browser evidence is current; real-account, cloud source-map upload and packaged Mac gates remain open.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-sentry-evidence-'));
  try {
    const jsonPath = path.join(temporary, 'tests.json');
    const tests = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${jsonPath}`], { encoding: 'utf8' });
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (tests.status !== 0) throw new Error(`Sentry acceptance failed\n${JSON.stringify(result.testResults
      .filter((suite: { status: string }) => suite.status !== 'passed'), null, 2)}\n${tests.stderr}`);
    const cases = result.testResults.flatMap((suite: {
      assertionResults: Array<{ fullName: string; status: string }>;
    }) => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status })))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    const browser = spawnSync(process.execPath, ['scripts/run-sentry-browser.mjs'], { encoding: 'utf8' });
    if (browser.status !== 0) throw new Error(`Sentry browser acceptance failed\n${browser.stdout}\n${browser.stderr}`);
    const browserReport = JSON.parse(readFileSync('docs/acceptance/sentry-browser.json', 'utf8'));
    const report = { contract, automated: { status: 'passed', command: `pnpm exec vitest run ${suites.join(' ')}`,
      passed: result.numPassedTests, failed: result.numFailedTests, skipped: result.numPendingTests, cases,
      browser: { status: browserReport.status, report: 'docs/acceptance/sentry-browser.json', checks: browserReport.checks.length } },
    openGates: [
      'Sentry account/project and public DSN provisioned',
      'exact packaged Mac build resolves synthetic JS error to original TypeScript line',
      'real source maps upload and absence from distributed artifacts verified',
      'real Web dashboard, production email, opt-out and retry acceptance',
      'Mac writing/restart preservation acceptance',
      'separate private-service instrumentation and external availability monitoring',
    ] };
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Generated ${output}: ${result.numPassedTests} unit tests and ${browserReport.checks.length} browser checks passed; live deployment gates remain open.`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
