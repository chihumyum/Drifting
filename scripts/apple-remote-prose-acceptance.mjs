import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = 'docs/apple-native/acceptance/p4a-remote-prose.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const specs = [
  { name: 'core-remote', crate: 'drifting-core', args: ['remote_prose'], required: [
    'remote_prose::tests::remote_prose_receives_authored_original_and_deduplicates_after_prune_and_reopen',
    'remote_prose::tests::remote_prose_multi_mutation_validates_complete_identity_and_current_scope_atomically',
    'remote_prose::tests::remote_prose_receipt_failure_rolls_back_complete_packet_and_preserves_outer_transaction',
    'remote_prose::tests::remote_prose_observes_hlc_without_consuming_local_sequence',
  ] },
  { name: 'prose-remote', crate: 'drifting-prose', args: ['--test', 'remote_sync'], required: [
    'remote_sync_accumulates_real_snapshot_tail_and_same_document_mutations',
    'remote_sync_rejects_invalid_second_mutation_without_writes',
  ] },
  { name: 'bridge-remote', crate: 'drifting-apple-bridge', args: ['workspace_remote_prose'], required: [
    'workspace_tests::remote_prose::workspace_remote_prose_offline_replicas_converge_all_open_chapters_with_local_history',
    'workspace_tests::remote_prose::workspace_remote_prose_duplicate_survives_prune_and_cold_reopen',
    'workspace_tests::remote_prose::workspace_remote_prose_lost_notification_replays_all_owners_after_local_interleave',
    'workspace_tests::remote_prose::workspace_remote_prose_rejected_original_and_receipt_failure_preserve_owner_and_draft',
  ] },
];
const boundaries = {
  source: 'Pure-prose canonical original receive transaction, shared Yrs projection and bridge delivery/replay over synthetic file-backed replicas.',
  agreedGroups: [
    'Independent offline replicas converge and local undo preserves received edits.',
    'Applied originals deduplicate after covered-tail pruning and independent cold reopen.',
    'A committed update with no live notification is replayed before later local/remote work across open owners.',
    'Receipt failure and wrong scope reject atomically while live history and drafts remain available.',
  ],
  rendererParity: 'Production TypeScript protocol decoder, stage/reducer/complete transaction, exact immutable rows and receipts, prose revision/provenance, local HLC and authoritative semantic cache.',
  excludedWallClockColumns: {
    yjs_updates: ['created_at'], yjs_document_revision: ['updated_at'],
    yjs_document_revision_provenance: ['created_at'],
  },
  limitations: [
    'In-process transaction-failure and cold-reopen evidence; this runner does not perform process SIGKILL or certify power-loss behavior.',
    'Only current-scope pure yjs.update originals for existing prose owners; full domain reducer, project import, provider transport and network retry are not certified.',
    'No automatic authority is granted to unsupported alias deletions or unresolved source retention.',
    'No Swift/UI, physical IME, physical device, cloud account, signing or distribution acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema)\/)/u.test(name)
      || [
        'scripts/apple-remote-prose-acceptance.mjs', 'scripts/apple-remote-prose-wire-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
      || /^src\/renderer\/domain\/.*\.ts$/u.test(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_remote_prose');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Remote prose evidence is stale; rerun its generator');
  assert.equal(report.source.fingerprint, sha(JSON.stringify(report.source.files)));
  assert.deepEqual(report.boundaries, boundaries);
  assert.equal(report.strictTypeScript, 'passed');
  const version = /^rustc (\d+)\.(\d+)\./u.exec(report.toolchain.rustc);
  assert(version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 96),
    'Rust 1.96 or newer is required for shared document replay');
  assert.match(report.toolchain.cargo, /^cargo \d+\.\d+\./u);
  assert.deepEqual(report.suites.map(suite => suite.name), specs.map(spec => spec.name));
  for (const spec of specs) {
    const suite = report.suites.find(item => item.name === spec.name);
    assert(suite);
    assert.equal(suite.failed, 0);
    assert.equal(suite.passed, suite.cases.length);
    assert(suite.passed > 0);
    assert.equal(new Set(suite.cases).size, suite.passed);
    for (const required of spec.required) assert(suite.cases.includes(required), `Missing ${required}`);
    assert.match(suite.logSha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(report.renderer.schemaVersion, 1);
  assert.equal(report.renderer.status, 'passed');
  assert.match(report.renderer.inputSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.renderer.excludedWallClockColumns, boundaries.excludedWallClockColumns);
  assert(report.renderer.cases.length > 0);
  for (const item of report.renderer.cases) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.match(item.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.equal(item.tables.length, 10);
    assert(item.documents.length > 0);
    assert(item.documents.every(document => document.semanticCache === 'passed'));
    for (const table of item.tables) assert.match(table.sha256, /^[a-f0-9]{64}$/u);
    for (const delivery of item.deliveries) {
      assert(['applied', 'duplicate'].includes(delivery.status));
      assert(delivery.mutationCount > 0);
      assert.match(delivery.envelopeSha256, /^[a-f0-9]{64}$/u);
    }
  }
  const statuses = report.renderer.cases.flatMap(item => item.deliveries.map(delivery => delivery.status));
  assert(statuses.includes('applied') && statuses.includes('duplicate'));
  assert(Array.isArray(report.rawEvidence));
  for (const evidence of report.rawEvidence) {
    assert.match(evidence.path, /^\.local-data\/apple-native\/remote-prose-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(evidence.path), evidence.path);
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'remote-prose-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}

if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native remote prose evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/remote-prose-acceptance-');
  const before = sources();
  writeFileSync(`${directory}/source-before.json`, `${JSON.stringify(before, null, 2)}\n`);
  function run(name, command, args, extraEnv = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...extraEnv } });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(`${directory}/${name}.log`, log);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${name}: ${log.slice(-9000)}`);
    return log;
  }
  const toolchain = { rustc: run('rustc', 'rustc', ['--version']).trim(), cargo: run('cargo', 'cargo', ['--version']).trim() };
  const suites = specs.map(spec => {
    const log = run(spec.name, 'cargo', ['test', '--locked', '--manifest-path', `crates/${spec.crate}/Cargo.toml`, ...spec.args],
      spec.name === 'bridge-remote' ? { NATIVE_REMOTE_PROSE_EXPORT_DIR: path.resolve(directory) } : {});
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert(cases.length > 0, `${spec.name} did not execute tests`);
    for (const required of spec.required) assert(cases.includes(required), `Missing ${required}`);
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-remote-prose-wire-check.ts',
    `--input=${directory}/remote-prose-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-remote-prose-wire-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Remote prose source changed during acceptance');
  const wire = json(`${directory}/remote-prose-wire.json`);
  const evidenceNames = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'remote-prose-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...wire.cases.flatMap(item => [item.beforeDatabase, item.afterDatabase])])];
  const report = { schemaVersion: 1, kind: 'native_remote_prose', status: 'passed',
    source: { files: before, fingerprint: sha(JSON.stringify(before)) }, toolchain, suites,
    renderer: json(`${directory}/renderer.json`), strictTypeScript: 'passed', boundaries,
    rawEvidence: evidenceNames.map(name => ({ path: `${directory}/${name}`, sha256: sha(readFileSync(`${directory}/${name}`)) })),
  };
  validate(report);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', suites: suites.map(({ name, passed }) => ({ name, passed })),
    rendererCases: report.renderer.cases.length, sourceFingerprint: report.source.fingerprint, rawEvidence: directory }));
}
