import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p4b-workspace-remote.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'chapter-create-and-prose', 'competing-fields-and-order',
  'late-fields-before-create', 'receipt-rollback-and-retry',
];
const specs = [
  { name: 'core-workspace-metadata', crate: 'drifting-core', args: ['remote_workspace_metadata'], required: [
    'remote_workspace_metadata::tests::remote_workspace_metadata_late_fields_reproject_verified_winners',
    'remote_workspace_metadata::tests::remote_workspace_metadata_rejects_unsupported_and_rolls_back_receipt_failure',
  ] },
  { name: 'bridge-workspace-remote', crate: 'drifting-apple-bridge', args: ['workspace_remote_changes'], required: [
    'workspace_tests::remote_changes::workspace_remote_changes_create_and_prose',
    'workspace_tests::remote_changes::workspace_remote_changes_competing_fields_and_order',
    'workspace_tests::remote_changes::workspace_remote_changes_late_fields_before_create',
    'workspace_tests::remote_changes::workspace_remote_changes_receipt_rollback_and_retry',
  ] },
];
const expectedTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt',
  'sync_yjs_materialization_receipt', 'sync_generation_writer_state',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision',
  'yjs_document_revision_provenance', 'node_content',
  'project', 'book_node', 'node_storyline_link',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict',
];
// Per group, baseline chapters whose book_node.updated_at holds a local prose
// save's stamp that Rust receive keeps and the TS reducer re-stamps.
const proseSaveStamps = [1, 0, 0, 0];
const boundaries = {
  source: 'Complete chapter create, title/bookOrder/project-name field and prose originals received atomically by the shared native workspace owner over synthetic file-backed replicas.',
  agreedGroups: [
    'Complete node create, Yjs seed and primary-null originals produce an editable chapter without replacing existing live owners or history.',
    'Independent field writers and reverse delivery converge metadata and order using the production total-order rules.',
    'Title and bookOrder received before create remain durable registers and reproject when the chapter seed arrives.',
    'Wrong scope and receipt failure preserve prior metadata, prose, history and drafts; retry and duplicate delivery apply once.',
  ],
  rendererParity: 'Production TypeScript decoder and stage/reducer/complete transaction, with exact immutable rows, receipts, lifecycle, field clocks, project/chapter metadata, revision/provenance/HLC and authoritative prose/cache compared to Rust receive results. A baseline chapter\'s local prose-save stamp (node, body cache and revision alike), which Rust receive keeps and the TS reducer re-stamps from its field registers, is carried per row with exact values.',
  excludedWallClockColumns: {
    yjs_updates: ['created_at'], yjs_document_revision: ['updated_at'],
    yjs_document_revision_provenance: ['created_at'],
  },
  limitations: [
    'Existing local project/generation replica baseline; project bootstrap, other metadata actions, trash/restore and generation lifecycle receive are not certified.',
    'Unsupported native envelopes are refused whole, without receipt or transport-frontier advancement. Renderer semantic suppression is not treated as equivalent to this refusal.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL or power-loss claim.',
    'No provider transport, network authentication, Swift/UI, physical IME/device, cloud account, signing or distribution acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema)\/)/u.test(name)
      || [
        'scripts/apple-workspace-remote-acceptance.mjs', 'scripts/apple-workspace-remote-check.ts',
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
  assert.equal(report.kind, 'native_workspace_remote');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Workspace remote evidence is stale; rerun its generator');
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
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.match(item.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.equal(item.proseSaveStamps.length, proseSaveStamps[index]);
    for (const stamp of item.proseSaveStamps) assert(stamp.receiver < stamp.native, 'The TS reducer holds the older register stamp');
    assert.deepEqual(item.tables.map(table => table.name), expectedTables);
    assert(item.documents.length > 0);
    assert(item.documents.every(document => document.semanticCache === 'passed'));
    for (const table of item.tables) assert.match(table.sha256, /^[a-f0-9]{64}$/u);
    for (const delivery of item.deliveries) {
      assert(['applied', 'duplicate', 'rejected'].includes(delivery.status));
      assert(delivery.mutationCount > 0);
      assert.match(delivery.envelopeSha256, /^[a-f0-9]{64}$/u);
    }
  }
  const statuses = report.renderer.cases.flatMap(item => item.deliveries.map(delivery => delivery.status));
  assert(statuses.includes('applied') && statuses.includes('duplicate') && statuses.includes('rejected'));
  assert(Array.isArray(report.rawEvidence));
  for (const evidence of report.rawEvidence) {
    assert.match(evidence.path, /^\.local-data\/apple-native\/workspace-remote-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(evidence.path), evidence.path);
    assert.match(evidence.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-remote-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}

if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native workspace remote evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/workspace-remote-acceptance-');
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
      { NATIVE_WORKSPACE_REMOTE_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert(cases.length > 0, `${spec.name} did not execute tests`);
    for (const required of spec.required) assert(cases.includes(required), `Missing ${required}`);
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-remote-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-remote-check.ts',
    `--input=${directory}/workspace-remote-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-remote-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Workspace remote source changed during acceptance');
  const evidenceNames = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-remote-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`), ...wire.cases.flatMap(item => [item.beforeDatabase, item.afterDatabase])])];
  const report = { schemaVersion: 1, kind: 'native_workspace_remote', status: 'passed',
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
