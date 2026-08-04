import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(new URL('../../../../../../', import.meta.url));
const TEST_FILES = [
  'src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.test.ts',
  'src/renderer/lib/agent/runtime/drivers/openai-responses-driver.test.ts',
  'src/renderer/lib/byok-keychain.test.ts',
  'src/renderer/platform/tauri.test.ts',
];
const LINT_FILES = [
  'src/renderer/components/modals/SettingsModal.tsx',
  'src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.ts',
  'src/renderer/lib/agent/runtime/drivers/drifting-agent-driver.test.ts',
  'src/renderer/lib/agent/runtime/drivers/openai-responses-driver.ts',
  'src/renderer/lib/agent/runtime/drivers/openai-responses-driver.test.ts',
  'src/renderer/lib/byok-keychain.ts',
  'src/renderer/lib/byok-keychain.test.ts',
  'src/renderer/platform/contracts.ts',
  'src/renderer/platform/types.ts',
  'src/renderer/platform/tauri.ts',
  'src/renderer/platform/tauri.test.ts',
];
const SOURCE_FILES = [
  'src-tauri/Cargo.lock',
  'src-tauri/Cargo.toml',
  'docs/agent-runtime/provider-extension-protocol.md',
  'package.json',
  'src-tauri/src/lib.rs',
  'src-tauri/src/openai_responses.rs',
  'src-tauri/src/secure_storage.rs',
  'src/renderer/lib/agent/runtime/acceptance/openai-native-transport.acceptance.mjs',
  ...LINT_FILES,
  ...TEST_FILES,
];

function options(argv) {
  const result = { output: null };
  for (const argument of argv) {
    if (argument.startsWith('--output=')) {
      result.output = path.resolve(CORE_DIRECTORY, argument.slice('--output='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CORE_DIRECTORY,
      env: process.env,
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

async function sourceHash() {
  const hash = createHash('sha256');
  for (const file of [...new Set(SOURCE_FILES)].sort()) {
    hash.update(file).update('\0');
    hash.update(await readFile(path.join(CORE_DIRECTORY, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function runOpenAINativeTransportAcceptance(config = options([])) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-openai-native-'));
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
      throw new Error(
        `OpenAI native acceptance produced no readable Vitest report.\n${vitest.stderr || vitest.stdout}\n${String(error)}`,
      );
    }

    const [typecheck, lint, rustOpenAI, rustSecureStorage, rustCheck, rustFormat] =
      await Promise.all([
        run('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']),
        run('pnpm', ['exec', 'eslint', ...LINT_FILES]),
        run('cargo', [
          'test',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          'openai_responses',
          '--',
          '--nocapture',
        ]),
        run('cargo', [
          'test',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          'secure_storage',
          '--',
          '--nocapture',
        ]),
        run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml']),
        run('cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check']),
      ]);

    const summary = {
      suite: 'openai-native-responses-and-keychain-status',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      sourceSetSha256: await sourceHash(),
      vitest: {
        files: TEST_FILES.length,
        tests: report.numTotalTests,
        passedTests: report.numPassedTests,
        passed: vitest.code === 0 && report.success === true,
      },
      typecheck: gate(typecheck),
      lint: gate(lint),
      rustOpenAITransport: gate(rustOpenAI),
      rustSecureStorage: gate(rustSecureStorage),
      rustCheck: gate(rustCheck),
      rustFormat: gate(rustFormat),
      evidence: {
        responseHost: 'fixed-native-https-api.openai.com-v1-responses',
        authorization: 'native-keychain-injection-never-renderer',
        rendererTransport: 'ordered-tauri-channel-with-abort-forwarding',
        settingsStatus: 'existence-only; macos-attributes-with-authentication-ui-skipped',
        workspaceTypecheck: 'full-tsc-noEmit',
        paidLiveCanary: 'explicit-separate-command-only',
      },
      boundaries: {
        macosPromptUI: 'OS password-dialog behavior requires interactive acceptance',
      },
    };
    summary.passed =
      summary.vitest.passed &&
      [typecheck, lint, rustOpenAI, rustSecureStorage, rustCheck, rustFormat].every(
        (execution) => execution.code === 0 && execution.signal === null,
      );

    if (config.output) {
      await mkdir(path.dirname(config.output), { recursive: true });
      await writeFile(config.output, `${JSON.stringify(summary, null, 2)}\n`);
    }
    if (!summary.passed) {
      for (const execution of [
        vitest,
        typecheck,
        lint,
        rustOpenAI,
        rustSecureStorage,
        rustCheck,
        rustFormat,
      ]) {
        if (execution.code !== 0) process.stderr.write(execution.stderr || execution.stdout);
      }
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOpenAINativeTransportAcceptance(options(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
