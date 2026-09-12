import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYNC_DOMAIN_MANIFEST_V1 } from '../src/renderer/sync/protocol/domain-manifest';

const output = 'docs/sync-engine/acceptance/agent-conversation-sync.json';
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const baseline = 'drizzle/0000_local_first_baseline.sql';
if (sha(baseline) !== '2ee852a7490b3dfb8fb9095a29d90d8c54c0b2bbfc0d00e0c7567be15f38c1e2')
  throw new Error('Published SQLite baseline changed');
const extensionTables = SYNC_DOMAIN_MANIFEST_V1.tables.filter((table) =>
  table.table.startsWith('agent_chat_'),
);
if (
  extensionTables.length !== 6 ||
  extensionTables.some(
    (table) =>
      table.disposition !== 'exclude' ||
      Object.values(table.fields).some((field) => field.disposition !== 'exclude'),
  )
)
  throw new Error('Agent chat leaked into project v1');
const sourceFiles = [
  ...readdirSync('src/renderer/sync/agent-chat')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/renderer/sync/agent-chat/${name}`),
  'scripts/generate-agent-conversation-sync.ts',
  baseline,
  'drizzle/0001_agent_chat_sync.sql',
  'src-tauri/src/google_drive_sync.rs',
  'src-tauri/src/google_drive_sync_legacy_fixture.rs',
  'src-tauri/src/database.rs',
  'src-tauri/src/mcp_stdio.rs',
  'src/renderer/platform/types.ts',
  'src/renderer/platform/contracts.ts',
  'src/renderer/lib/events.ts',
  'src/renderer/sync/production-runtime.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
  'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.integration.test.ts',
  'src/renderer/schema/drizzle.ts',
  'src/renderer/sync/production-runtime.ts',
  'src/renderer/sync/protocol/domain-manifest.ts',
  'src/renderer/sync/providers/google-drive/tauri-transport.ts',
  'src/renderer/sync/providers/google-drive/tauri-transport.test.ts',
  'src/renderer/sqlite-repo/agent-runtime-persistence-repo.ts',
  'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.ts',
  'src/renderer/sqlite-repo/agent-conversation-repo.ts',
  'src/renderer/store/agent-chat-store.ts',
  'src/renderer/store/agent-chat-events.integration.test.ts',
  'src/renderer/lib/agent/runtime/chat-journal-dedup.ts',
  'src/renderer/lib/agent/runtime/chat-journal-dedup.test.ts',
  'src/renderer/lib/agent/runtime/repository-transport-persistence.ts',
  'src/renderer/lib/agent/runtime/recovered-transcript.ts',
  'src/renderer/features/agent/desktop/DesktopAgentPanel.tsx',
  'src/renderer/shells/mobile/workspace/MobileAgentPanel.tsx',
].sort();
const contract = {
  protocol: 'drifting.agent-chat.v1',
  nativeNamespace: 'agent-chat',
  driveProtocol: 'agent-chat-v1',
  projectProtocol: 'object-v2',
  projectDomainVersion: 1,
  sqliteMigration: '0001_agent_chat_sync',
  extensionTables: extensionTables.map((table) => table.table).sort(),
  sourceSha256: Object.fromEntries(sourceFiles.map((file) => [file, sha(file)])),
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  if (
    JSON.stringify(report.contract) !== JSON.stringify(contract) ||
    report.automated.status !== 'passed'
  )
    throw new Error(
      'Agent conversation evidence is stale; run pnpm agent:conversation-sync:evidence',
    );
  console.log(
    'Agent conversation contract/evidence is current. Physical acceptance remains a separate gate.',
  );
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-chat-evidence-'));
  try {
    const jsonPath = path.join(temporary, 'tests.json');
    const suites = [
      'src/renderer/sync/agent-chat',
      'src/renderer/sync/providers/google-drive/tauri-transport.test.ts',
      'src/renderer/sync/production-runtime.test.ts',
      'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
      'src/renderer/sqlite-repo/agent-runtime-result-artifact-repo.integration.test.ts',
    ];
    const tests = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${jsonPath}`],
      { encoding: 'utf8' },
    );
    if (tests.status !== 0)
      throw new Error(`Agent conversation tests failed\n${tests.stdout}\n${tests.stderr}`);
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const native = spawnSync(
      'cargo',
      ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--no-default-features'],
      { encoding: 'utf8' },
    );
    if (native.status !== 0)
      throw new Error(`Native acceptance failed\n${native.stdout}\n${native.stderr}`);
    const totals = /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(
      native.stdout,
    );
    if (!totals) throw new Error('Native test result is missing');
    const report = {
      contract,
      automated: {
        status: 'passed',
        renderer: {
          passed: result.numPassedTests,
          failed: result.numFailedTests,
          skipped: result.numPendingTests,
          cases: result.testResults
            .flatMap((suite: { assertionResults: Array<{ fullName: string; status: string }> }) =>
              suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status })),
            )
            .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
        },
        native: {
          passed: Number(totals[1]),
          failed: Number(totals[2]),
          ignored: Number(totals[3]),
          command: 'cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features',
        },
      },
      physical: {
        status: 'not-run',
        platforms: ['macOS', 'iOS', 'Android'],
        gates: [
          'same-account restore and continuation',
          'offline concurrent branches',
          'deletion and restart',
          'fresh device recovery',
          'account reauthorization',
          'previous-client bidirectional prose sync',
        ],
      },
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `Generated ${output}: ${result.numPassedTests} renderer tests; ${totals[1]} native tests. Physical gate not run.`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
