import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));
const GROUPS = {
  providers: [
    'src/renderer/lib/agent/runtime/agent-provider-contract.test.ts',
    'src/renderer/lib/agent/runtime/drivers/anthropic-messages-driver.test.ts',
    'src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.test.ts',
    'src/renderer/lib/agent/runtime/drivers/openai-compatible-completion-driver.test.ts',
    'src/renderer/lib/ai/client/providers/openai.test.ts',
  ],
  mcpProtocolAndLifecycle: [
    'src/renderer/lib/agent/runtime/mcp-transport.test.ts',
    'src/renderer/lib/agent/runtime/mcp-client.test.ts',
    'src/renderer/lib/agent/runtime/mcp-http.integration.test.ts',
    'src/renderer/lib/agent/runtime/agent-extension-manager.test.ts',
    'src/renderer/lib/agent/runtime/dynamic-tool-runtime.test.ts',
  ],
  durableAuthorityAndProduct: [
    'src/renderer/sqlite-repo/agent-extension-repo.integration.test.ts',
    'src/renderer/lib/agent/runtime/durable-permission-authority.test.ts',
    'src/renderer/lib/agent/runtime/runtime.test.ts',
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/platform/tauri.test.ts',
    'src/renderer/store/settings-store-agent.test.ts',
    'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts',
  ],
};
const TEST_FILES = [...new Set(Object.values(GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'scripts/run-agent-provider-live-canary.mjs',
  'src/renderer/components/agent/AgentExtensionsSettings.tsx',
  'src/renderer/components/modals/SettingsModal.tsx',
  'src/renderer/domain/agent-extension.ts',
  'src/renderer/lib/agent/runtime/agent-extension-manager.ts',
  'src/renderer/lib/agent/runtime/agent-provider-contract.ts',
  'src/renderer/lib/agent/runtime/drivers/anthropic-messages-driver.ts',
  'src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.ts',
  'src/renderer/lib/agent/runtime/durable-permission-authority.ts',
  'src/renderer/lib/agent/runtime/mcp-client.ts',
  'src/renderer/lib/agent/runtime/mcp-tool-source.ts',
  'src/renderer/lib/agent/runtime/mcp-transport.ts',
  'src/renderer/lib/agent/runtime/eval/provider-extension.live.eval.ts',
  'src/renderer/sqlite-repo/agent-extension-repo.ts',
  ...TEST_FILES,
];
const HASHED_FILES = [
  'docs/agent-runtime/provider-extension-protocol.md',
  'drizzle/0076_agent_extension_platform.sql',
  'src-tauri/src/mcp_http.rs',
  'src-tauri/src/mcp_stdio.rs',
  'src/renderer/lib/agent/runtime/acceptance/milestone-i-provider-extension.acceptance.mjs',
  ...LINT_FILES,
];

function options(argv) {
  const result = { output: null };
  for (const arg of argv) {
    if (arg.startsWith('--output=')) result.output = path.resolve(CORE_DIRECTORY, arg.slice(9));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CORE_DIRECTORY,
      env: { ...process.env, DRIFTING_AGENT_ACCEPTANCE_VERBOSE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const gate = (execution) => ({
  exitCode: execution.code,
  signal: execution.signal,
  passed: execution.code === 0 && execution.signal === null,
});
const normalized = (value) =>
  path.relative(CORE_DIRECTORY, path.resolve(value)).split(path.sep).join('/');

function groupSummary(report, files) {
  const wanted = new Set(files);
  const results = report.testResults.filter((result) => wanted.has(normalized(result.name)));
  const assertions = results.flatMap((result) => result.assertionResults ?? []);
  return {
    requiredFiles: files.length,
    discoveredFiles: results.length,
    tests: assertions.length,
    passed:
      results.length === files.length &&
      assertions.length > 0 &&
      assertions.every((assertion) => assertion.status === 'passed'),
  };
}

async function sourceHash() {
  const hash = createHash('sha256');
  for (const file of [...new Set(HASHED_FILES)].sort()) {
    hash.update(file).update('\0').update(await readFile(path.join(CORE_DIRECTORY, file))).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function runMilestoneIAcceptance(config = options([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-milestone-i-'));
  try {
    const reportPath = path.join(directory, 'vitest.json');
    const vitest = await run('pnpm', [
      'exec',
      'vitest',
      'run',
      ...TEST_FILES,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ]);
    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch (error) {
      throw new Error(`Milestone I produced no readable test report.\n${vitest.stderr || vitest.stdout}\n${String(error)}`);
    }
    const [typecheckRun, lintRun, capabilityRun, rustTestsRun, rustCheckRun] = await Promise.all([
      run('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']),
      run('pnpm', ['exec', 'eslint', ...LINT_FILES]),
      run('pnpm', ['agent:capabilities:check']),
      run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', 'mcp_', '--', '--nocapture']),
      run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml']),
    ]);
    const groups = Object.fromEntries(
      Object.entries(GROUPS).map(([name, files]) => [name, groupSummary(report, files)]),
    );
    const processGates = {
      typecheck: gate(typecheckRun),
      lint: gate(lintRun),
      capabilities: gate(capabilityRun),
      rustMcpProcessAndSecurity: gate(rustTestsRun),
      rustCheck: gate(rustCheckRun),
    };
    const vitestPassed =
      vitest.code === 0 && report.success === true && Object.values(groups).every((item) => item.passed);
    const summary = {
      suite: 'milestone-i-provider-extension-platform',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      sourceSetSha256: await sourceHash(),
      vitest: {
        files: TEST_FILES.length,
        tests: report.numTotalTests,
        passedTests: report.numPassedTests,
        groups,
        passed: vitestPassed,
      },
      ...processGates,
      evidence: {
        providerNetworkRequired: false,
        stdio: 'real-temporary-node-child-process',
        streamableHttp: 'real-loopback-http-socket-plus-native-host-contract',
        persistence: 'real-file-sqlite-reopen-and-concurrency',
        paidLiveCanary: 'explicit-opt-in-only',
      },
      boundaries: {
        stdioMobile: 'unsupported-by-contract; Streamable HTTP is the mobile extension transport',
        serverInitiatedMcp: 'sampling, elicitation, roots, subscriptions, and resource prompts are not exposed',
        nativeInteraction: 'desktop/iOS/Android UI and endurance evidence remains milestone J',
      },
      passed: vitestPassed && Object.values(processGates).every((item) => item.passed),
    };
    if (config.output) {
      await mkdir(path.dirname(config.output), { recursive: true });
      await writeFile(config.output, `${JSON.stringify(summary, null, 2)}\n`);
    }
    if (!summary.passed) {
      for (const execution of [vitest, typecheckRun, lintRun, capabilityRun, rustTestsRun, rustCheckRun]) {
        if (execution.code !== 0) process.stderr.write(execution.stderr || execution.stdout);
      }
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMilestoneIAcceptance(options(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
