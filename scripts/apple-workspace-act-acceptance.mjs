import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3c-act-boundaries.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'act-create-rename-and-cold-outline',
  'act-remove-retains-empty-boundary-chapter-state',
  'act-failure-preserves-owner-and-retries',
];
const specs = [
  { name: 'core-act-boundaries', crate: 'drifting-core', filter: 'workspace::acts::tests::', required: [
    'workspace::acts::tests::workspace_acts_create_and_rename_on_current_chapter_axis',
    'workspace::acts::tests::workspace_acts_remove_empty_or_bound_boundary_preserves_all_prose',
    'workspace::acts::tests::workspace_acts_receipt_failures_and_invalid_scope_rollback',
  ] },
  { name: 'bridge-act-boundaries', crate: 'drifting-apple-bridge', filter: 'workspace_tests::acts::', required: [
    'workspace_tests::acts::workspace_act_create_rename_and_cold_outline',
    'workspace_tests::acts::workspace_act_remove_retains_empty_boundary_chapter_state',
    'workspace_tests::acts::workspace_act_failure_preserves_owner_and_retries',
    'workspace_tests::acts::workspace_act_color_set_clear_and_cold_outline',
    'workspace_tests::acts::workspace_act_move_boundary_between_neighbours',
  ] },
];
const expectedTables = [
  'project', 'book_act', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = ['New original origin local/remote', 'Local sequence allocation versus remote HLC observation',
  'Prose-save node stamp: authoring side versus receiver field-register stamp'];
// Chapters whose book_node.updated_at holds a saved local prose edit's stamp on
// the authoring side (native, like the renderer editor save, stamps the node
// and its body cache at the saved Yjs revision) while a receiver re-stamps it
// from its field registers; carried per row with exact values.
const proseSaveStamps = [[[0], [0]], [[0]], [[0], [0], [0]]];
const boundaries = {
  source: 'Real native local act create, rename and remove commands over synthetic file-backed workspaces.',
  agreedGroups: [
    'Create one finite boundary before the selected chapter without an implicit head act; rename and cold reopen preserve the same outline.',
    'Remove an empty act boundary while retaining chapter order, comments, prose and both live document owners and history.',
    'Wrong scope, duplicate coordinate and receipt failure leave state intact; retry creates exactly one canonical original per command.',
  ],
  rendererParity: 'Production domain-to-wire conversion, canonical decoder and reducer transaction consume actual native originals. Nineteen tables and authoritative Yjs state match (a saved prose edit\'s node stamp is carried per row with exact values), and production act derivation reproduces each native outline.',
  roleDifferences,
  excludedColumns: [],
  limitations: [
    'Native local act editing; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Act purge removes a boundary only, never a chapter or its prose; no permanent chapter deletion.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-act-acceptance.mjs', 'scripts/apple-workspace-act-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts',
        'src/renderer/usecase/useBookAct.ts',
        'src/renderer/usecase/sync-helpers.ts',
        'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_act_boundaries');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Act boundaries evidence is stale; rerun its generator');
  assert.equal(report.source.fingerprint, sha(JSON.stringify(report.source.files)));
  assert.deepEqual(report.boundaries, boundaries);
  assert.equal(report.strictTypeScript, 'passed');
  const version = /^rustc (\d+)\.(\d+)\./u.exec(report.toolchain.rustc);
  assert(version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 96));
  assert.match(report.toolchain.cargo, /^cargo \d+\.\d+\./u);
  assert.deepEqual(report.suites.map(suite => suite.name), specs.map(spec => spec.name));
  for (const spec of specs) {
    const suite = report.suites.find(item => item.name === spec.name);
    assert(suite);
    assert.equal(suite.failed, 0);
    assert.equal(suite.passed, spec.required.length);
    assert.deepEqual([...suite.cases].sort(), [...spec.required].sort());
    assert.match(suite.logSha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(report.renderer.schemaVersion, 1);
  assert.equal(report.renderer.status, 'passed');
  assert.match(report.renderer.inputSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.renderer.excludedColumns, boundaries.excludedColumns);
  assert.deepEqual(report.renderer.roleDifferences, roleDifferences);
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.steps.map(step => step.operation), [['create', 'rename'], ['remove'], ['create', 'rename', 'remove']][index]);
    for (const [stepIndex, step] of item.steps.entries()) {
      assert.equal(step.mutationCount, 1);
      assert.deepEqual(step.proseSaveStamps.map(stamp => stamp.chapter), proseSaveStamps[index][stepIndex]);
      for (const stamp of step.proseSaveStamps) assert(stamp.receiver < stamp.native, 'A receiver holds the older register stamp');
      assert.equal(step.action, { create: 'entity.create', rename: 'field.set', remove: 'entity.purge' }[step.operation]);
      assert.equal(step.localDomainWire, 'passed');
      assert.equal(step.outline, 'passed');
      assert.equal(step.incarnation, 0);
      assert.equal(step.faultRollback, index === 2);
      assert.equal(step.duplicate, 'passed');
      assert.match(step.originalSha256, /^[a-f0-9]{64}$/u);
      assert.equal(step.documents.length, 2);
      for (const document of step.documents) {
        assert.equal(document.unchanged, true);
        assert.match(document.stateSha256, /^[a-f0-9]{64}$/u);
      }
      assert.match(step.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
      assert.deepEqual(step.tables.map(table => table.table), expectedTables);
      for (const table of step.tables) {
        assert(Number.isInteger(table.rows) && table.rows >= 0);
        assert.match(table.sha256, /^[a-f0-9]{64}$/u);
      }
    }
  }
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/act-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-act-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native act boundaries evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/act-acceptance-');
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
    const log = run(spec.name, 'cargo', ['test', '--locked', '--manifest-path', `crates/${spec.crate}/Cargo.toml`, spec.filter],
      { NATIVE_WORKSPACE_ACT_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-act-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-act-check.ts',
    `--input=${directory}/workspace-act-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-act-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Act boundaries source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-act-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_act_boundaries', status: 'passed',
    source: { files: before, fingerprint: sha(JSON.stringify(before)) }, toolchain, suites,
    renderer: json(`${directory}/renderer.json`), strictTypeScript: 'passed', boundaries,
    rawEvidence: names.map(name => ({ path: `${directory}/${name}`, sha256: sha(readFileSync(`${directory}/${name}`)) })),
  };
  validate(report);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', suites: suites.map(({ name, passed }) => ({ name, passed })),
    rendererCases: report.renderer.cases.length, sourceFingerprint: report.source.fingerprint, rawEvidence: directory }));
}
