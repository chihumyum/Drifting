import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CORE_DIRECTORY = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);

const TEST_GROUPS = {
  realSqliteDomainLifecycle: [
    'src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.integration.test.ts',
    'src/renderer/lib/agent/runtime/drifting-entity-write-strategy.integration.test.ts',
  ],
  naturalWorkspaceAndReads: [
    'src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.test.ts',
    'src/renderer/lib/agent/runtime/drifting-read-tool-runtime.integration.test.ts',
  ],
  productYjsAndMigration: [
    'src/renderer/lib/agent/runtime/drifting-product-composition.integration.test.ts',
    'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
  ],
  trustPolicyAndCapabilityTruth: [
    'src/renderer/usecase/useAgentMemory.test.ts',
    'src/renderer/lib/agent/runtime/drifting-permission-policy.test.ts',
    'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.test.ts',
  ],
};

const TEST_FILES = [...new Set(Object.values(TEST_GROUPS).flat())];
const LINT_FILES = [
  'scripts/generate-agent-capabilities.ts',
  'src/renderer/domain/agent-memory.ts',
  'src/renderer/domain/agent-runtime-entity-write-receipt.ts',
  'src/renderer/lib/agent/runtime/domain-crud-revision.ts',
  'src/renderer/lib/agent/runtime/drifting-agent-capability-manifest.ts',
  'src/renderer/lib/agent/runtime/drifting-domain-crud-write-strategy.ts',
  'src/renderer/lib/agent/runtime/drifting-permission-policy.ts',
  'src/renderer/lib/agent/runtime/drifting-product-composition.ts',
  'src/renderer/lib/agent/runtime/drifting-read-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/drifting-structural-write-strategy.ts',
  'src/renderer/lib/agent/runtime/drifting-workspace-tool-contract.ts',
  'src/renderer/lib/agent/runtime/drifting-workspace-tool-runtime.ts',
  'src/renderer/lib/agent/runtime/drifting-write-strategies.ts',
  'src/renderer/lib/agent/runtime/drifting-write-tool-runtime.ts',
  'src/renderer/lib/agent/tool-handlers.ts',
  'src/renderer/sqlite-repo/agent-memory-repo.ts',
  ...TEST_FILES,
];
const HASHED_SOURCE_FILES = [
  'docs/agent-runtime/domain-crud-transaction-protocol.md',
  'drizzle/0072_agent_runtime_domain_crud.sql',
  'drizzle/meta/_journal.json',
  'src/renderer/schema/drizzle.ts',
  'src/renderer/lib/agent/runtime/acceptance/milestone-d-domain-crud.acceptance.mjs',
  ...LINT_FILES,
];

const REQUIRED_ASSERTIONS = {
  completeStorylineGraph:
    'atomically replaces the complete storyline graph and restores the exact preimage',
  transactionRollback:
    'rolls back every graph row and outbox mutation when a transaction write fails',
  memoryLifecycle:
    'creates, addresses, updates, soft-deletes, and exactly reverts pending Agent memory',
  lostAcknowledgement:
    'reconciles a lost outer acknowledgement once and survives a file reopen',
  approvedMemoryTrust:
    'keeps approved guidance read-only and evolves it through a pending superseding proposal',
  structuralCreateInverse:
    'creates and exactly removes every structural resource class',
  structuralUpdateDeleteInverse:
    'updates, guards field deletion, and restores structural resource deletes',
  commentRelationLifecycle:
    'provides natural JSON CRUD and guarded inverses for TODOs and relations',
  atomicExistingDomainWrites:
    'commits all four domain writes with one outbox and typed receipt each without post-write reviews',
  staleStateFailClosed:
    'fails closed when the SQLite entity revision changed after the cited read',
  naturalWorkspace:
    'projects canonical entities as natural virtual files and renders prose without handles',
  completeReadCatalog:
    'executes every registered read tool without mutating domain state or leaking projects',
  authoritativeYjsWorkspace:
    'edits a virtual prose file with semantic model output and an automatic reveal',
  migrationReopen:
    'follows the checked-in journal and reopens idempotently',
  memoryApprovalAtomicity:
    'activates the proposal and retires its superseded memory atomically',
  graphPermission:
    'asks before a workspace facade changes relations or storyline membership',
  executableLifecycleMatrix:
    'proves every declared domain lifecycle and hidden mutation has an executable strategy',
};

function parseOptions(argv) {
  const options = { output: null };
  for (const argument of argv) {
    if (argument.startsWith('--output=')) {
      options.output = path.resolve(
        CORE_DIRECTORY,
        argument.slice('--output='.length),
      );
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function runCommand(command, args) {
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function normalizeTestPath(value) {
  return path
    .relative(CORE_DIRECTORY, path.resolve(value))
    .split(path.sep)
    .join('/');
}

function assertions(report) {
  return report.testResults.flatMap((result) =>
    (result.assertionResults ?? []).map((assertion) => ({
      file: normalizeTestPath(result.name),
      name:
        assertion.fullName ??
        [...(assertion.ancestorTitles ?? []), assertion.title]
          .filter(Boolean)
          .join(' '),
      status: assertion.status,
    })),
  );
}

function summarizeGroup(report, files) {
  const wanted = new Set(files);
  const results = report.testResults.filter((result) =>
    wanted.has(normalizeTestPath(result.name)),
  );
  const checks = results.flatMap((result) => result.assertionResults ?? []);
  const passed = checks.filter((check) => check.status === 'passed').length;
  const failed = checks.filter((check) => check.status === 'failed').length;
  const pending = checks.length - passed - failed;
  return {
    requiredFiles: files.length,
    discoveredFiles: results.length,
    tests: { total: checks.length, passed, failed, pending },
    passed:
      results.length === files.length &&
      checks.length > 0 &&
      failed === 0 &&
      pending === 0,
  };
}

async function hashSourceSet(files) {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(path.join(CORE_DIRECTORY, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function gitHead() {
  const result = await runCommand('git', ['rev-parse', 'HEAD']);
  return result.code === 0 && result.signal === null
    ? result.stdout.trim() || null
    : null;
}

function processGate(execution) {
  return {
    exitCode: execution.code,
    signal: execution.signal,
    passed: execution.code === 0 && execution.signal === null,
  };
}

export async function runMilestoneDAcceptance(options = parseOptions([])) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'drifting-agent-milestone-d-'),
  );
  try {
    const reportPath = path.join(directory, 'vitest.json');
    const vitestExecution = await runCommand('pnpm', [
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
        [
          'Milestone D Vitest did not produce a readable JSON report.',
          vitestExecution.stderr || vitestExecution.stdout,
          error instanceof Error ? error.message : String(error),
        ].join('\n'),
      );
    }

    const [typecheckExecution, lintExecution, capabilityExecution] =
      await Promise.all([
        runCommand('pnpm', ['exec', 'tsc', '--noEmit', '--pretty', 'false']),
        runCommand('pnpm', ['exec', 'eslint', ...LINT_FILES]),
        runCommand('pnpm', ['agent:capabilities:check']),
      ]);

    const allAssertions = assertions(report);
    const assertionGates = Object.fromEntries(
      Object.entries(REQUIRED_ASSERTIONS).map(([gate, requiredName]) => {
        const matches = allAssertions.filter((assertion) =>
          assertion.name.includes(requiredName),
        );
        return [
          gate,
          {
            requiredName,
            matches: matches.length,
            passed: matches.length === 1 && matches[0]?.status === 'passed',
          },
        ];
      }),
    );
    const groups = Object.fromEntries(
      Object.entries(TEST_GROUPS).map(([name, files]) => [
        name,
        summarizeGroup(report, files),
      ]),
    );
    const vitestPassed =
      vitestExecution.code === 0 &&
      vitestExecution.signal === null &&
      report.success === true &&
      Object.values(groups).every((group) => group.passed) &&
      Object.values(assertionGates).every((gate) => gate.passed);
    const typecheck = processGate(typecheckExecution);
    const lint = processGate(lintExecution);
    const capabilities = processGate(capabilityExecution);
    const summary = {
      suite: 'milestone-d-domain-crud-and-structural-transactions',
      schemaVersion: 1,
      nodeVersion: process.version,
      platform: process.platform,
      gitHead: await gitHead(),
      sourceSetSha256: await hashSourceSet(HASHED_SOURCE_FILES),
      storageReplay: {
        sqlite:
          'real file-backed SQLite with every product migration, CAS guards, receipts, outbox rows, and injected transaction faults',
        prose:
          'real product Yjs coordination for prose-owning workspace resources',
        rendererProjection:
          'product Zustand projections refreshed only after committed domain state',
        restart:
          'database close/reopen plus lost outer acknowledgement reconciliation',
        networkRequired: false,
      },
      lifecycle: {
        domains: 9,
        providerWorkspaceVerbs: 6,
        hiddenMutationCommands: 25,
        contract:
          'generated from DRIFTING_DOMAIN_CRUD_CONTRACTS and checked against final product composition',
      },
      vitest: {
        files: {
          required: TEST_FILES.length,
          discovered: new Set(
            report.testResults.map((result) => normalizeTestPath(result.name)),
          ).size,
        },
        tests: {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          pending: report.numPendingTests,
          todo: report.numTodoTests,
        },
        groups,
        requiredAssertions: assertionGates,
        process: {
          exitCode: vitestExecution.code,
          signal: vitestExecution.signal,
        },
        passed: vitestPassed,
      },
      typecheck,
      lint,
      capabilities,
      boundaries: {
        checkpointRewind:
          'exact per-command inverse is closed; user checkpoints and fork UX remain milestone G',
        nativeDevices:
          'headless product storage is covered; desktop/iOS/Android lifecycle remains milestone J',
        providerNetwork:
          'not required for domain semantics; multi-provider conformance remains milestone I',
        visualReview:
          'inline review state is covered by milestone C; native visual smoothness remains user/device acceptance',
      },
      passed:
        vitestPassed &&
        typecheck.passed &&
        lint.passed &&
        capabilities.passed,
    };

    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(
        options.output,
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    }
    if (!summary.passed) {
      const diagnostics = [
        vitestExecution.stderr || vitestExecution.stdout,
        typecheckExecution.stderr || typecheckExecution.stdout,
        lintExecution.stderr || lintExecution.stdout,
        capabilityExecution.stderr || capabilityExecution.stdout,
      ]
        .filter(Boolean)
        .join('\n');
      if (diagnostics) process.stderr.write(diagnostics);
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMilestoneDAcceptance(parseOptions(process.argv.slice(2)))
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (!summary.passed) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
