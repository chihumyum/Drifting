import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const output = 'docs/sync-engine/acceptance/log-compaction.json';
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const suites = [
  'src/renderer/sync/compaction',
  'src/renderer/sync/providers/memory-provider.prune.test.ts',
  'src/renderer/sync/providers/hosted/provider.test.ts',
  'src/renderer/sync/engine/durable-runtime.integration.test.ts',
  'src/renderer/sync/checkpoint',
  'src/renderer/sync/restore',
  'src/renderer/schema/sync-journal-truncation-migration.integration.test.ts',
];
const sourceFiles = [
  'scripts/generate-sync-log-compaction.ts',
  'docs/sync-engine/phase7-log-compaction.md',
  'drizzle/0008_sync_journal_truncation.sql',
  'crates/drifting-core/src/remote_workspace.rs',
  'src/renderer/schema/sync-journal-truncation-migration.integration.test.ts',
  'src/renderer/sync/checkpoint/restore.ts',
  'src/renderer/sync/compaction/journal-truncation.ts',
  'src/renderer/sync/journal/repository.ts',
  'src/renderer/sync/compaction/catch-up.ts',
  'src/renderer/sync/compaction/compaction.integration.test.ts',
  'src/renderer/sync/compaction/frontier.ts',
  'src/renderer/sync/compaction/frontier.test.ts',
  'src/renderer/sync/compaction/local-truncation.ts',
  'src/renderer/sync/compaction/policy.ts',
  'src/renderer/sync/compaction/snapshot-catalog.ts',
  'src/renderer/sync/protocol/provider.ts',
  'src/renderer/sync/providers/memory-provider.ts',
  'src/renderer/sync/providers/memory-provider.prune.test.ts',
  'src/renderer/sync/providers/hosted/provider.ts',
  'src/renderer/sync/engine/durable-runtime.ts',
  'src/renderer/sync/engine/sqlite-repository.ts',
  'src/renderer/sync/checkpoint/provider-publisher.ts',
  'src/renderer/sync/checkpoint/reducer-state.ts',
  'src/renderer/sync/restore/cloud-restore.ts',
  'src/renderer/sync/reducer/reducer.ts',
  'src/renderer/sync/reducer/sqlite-materializer.ts',
  'src/renderer/sync/reducer/production-domain-kernel.ts',
  'src/renderer/sync/production-runtime.ts',
  'src-tauri/src/hosted_sync.rs',
].sort();
const contract = {
  milestone: 'sync-engine-phase7-log-compaction',
  retainedSnapshots: 2,
  hostedGraceDays: 30,
  capability: 'removals-v1',
  productionPruning: 'disabled-until-hosted-deploy',
  localTruncation: 'pruned-applied-segment-objects-and-snapshot-covered-journal-rows',
  journalTruncationMigration: '0008_sync_journal_truncation',
  sourceSha256: Object.fromEntries(sourceFiles.map((file) => [file, sha(file)])),
};

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  if (JSON.stringify(report.contract) !== JSON.stringify(contract) || report.automated.status !== 'passed') {
    throw new Error('Sync log compaction evidence is stale; run pnpm sync:compaction:evidence');
  }
  console.log('Sync log compaction contract/evidence is current. Hosted deployment remains a separate gate.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-compaction-evidence-'));
  try {
    const jsonPath = path.join(temporary, 'tests.json');
    const tests = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${jsonPath}`],
      { encoding: 'utf8' },
    );
    if (tests.status !== 0) throw new Error(`Compaction tests failed\n${tests.stdout}\n${tests.stderr}`);
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const compactionCases = result.testResults
      // Suite names are absolute; match the repository path so the checkout
      // directory's own name never selects a suite.
      .filter((suite: { name: string }) =>
        /compaction|prune|truncation|hosted\/provider\.test/u.test(path.relative(process.cwd(), suite.name)),
      )
      .flatMap((suite: { assertionResults: Array<{ fullName: string; status: string }> }) =>
        suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status })),
      )
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    const report = {
      contract,
      automated: {
        status: 'passed',
        command: `pnpm exec vitest run ${suites.join(' ')}`,
        passed: result.numPassedTests,
        failed: result.numFailedTests,
        skipped: result.numPendingTests,
        cases: compactionCases,
      },
      openGates: [
        'Hosted removal feed, prune endpoint and capability gate deployed',
        'production pruning enabled after deployment',
      ],
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Generated ${output}: ${result.numPassedTests} tests passed.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
