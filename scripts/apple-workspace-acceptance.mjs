import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = 'docs/apple-native/acceptance/p3a-workspace.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(name, 'utf8');
const json = name => JSON.parse(read(name));
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|native\/apple\/|src\/renderer\/sync\/|src\/renderer\/sqlite-repo\/|src\/renderer\/schema\/)/u.test(name)
      || ['scripts/apple-workspace-acceptance.mjs', 'scripts/apple-workspace-wire-check.ts',
        'src/renderer/domain/kv.ts', 'src/renderer/lib/db.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'package.json', 'pnpm-lock.yaml'].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
const requiredCases = {
  'core-workspace': [
    'workspace::tests::workspace_creates_defaults_and_atomic_canonical_chapter_seed',
    'workspace::tests::workspace_cold_lists_preserve_fractional_order_and_project_unique_titles',
    'workspace::tests::workspace_project_receipt_failure_rolls_back_defaults_generation_and_writer',
    'workspace::tests::workspace_chapter_materialization_failure_retains_prior_journal_and_retries_once',
    'workspace::tests::rename_tests::workspace_rename_updates_current_field_clocks_without_prose_and_cold_reopens',
    'workspace::tests::rename_tests::workspace_rename_excludes_self_deduplicates_nodes_and_uses_live_incarnation',
    'workspace::tests::rename_tests::workspace_rename_receipt_failure_rolls_back_names_clocks_and_writer_then_retries',
  ],
  'bridge-workspace': [
    'workspace_tests::workspace_two_chapters_edit_history_switch_and_cold_reopen',
    'workspace_tests::workspace_switch_and_close_preserve_active_draft_and_composition',
    'workspace_tests::workspace_failed_save_and_target_load_keep_current_owner',
    'workspace_tests::workspace_fixture_database_and_workspace_owners_remain_separate',
    'workspace_tests::workspace_comment_anchors_use_selected_project_and_chapter_scope',
    'workspace_tests::workspace_rename_preserves_selected_document_history_and_cold_metadata',
    'workspace_tests::workspace_rename_failure_rolls_back_metadata_and_preserves_live_owner',
  ],
};
const boundaries = {
  source: 'shared Rust workspace and bridge commands; actual renderer decoder and domain materializer',
  integration: 'temporary file-backed SQLite creation and rename, no-op and receipt rollback, unchanged prose/history, current field clocks, chapter isolation and cold reopen',
  nativeUI: 'separate native acceptance report', physicalDevice: 'not-run', physicalIME: 'not-run',
  realAccount: 'not-run', signedDistribution: 'not-run', fullRemoteSync: 'not-certified', performance: 'deferred',
};
function verify(report) {
  assert.equal(report.kind, 'native_local_writing_workspace');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Workspace evidence is stale: run pnpm apple:workspace:acceptance');
  assert.equal(report.source.fingerprint, sha(JSON.stringify(report.source.files)));
  assert.deepEqual(report.boundaries, boundaries);
  assert.deepEqual(report.suites.map(suite => suite.name), ['core-workspace', 'bridge-workspace']);
  for (const suite of report.suites) {
    assert(suite.passed > 0);
    assert.equal(suite.cases.length, suite.passed);
    assert(suite.cases.every(name => name.includes('workspace')));
    assert.equal(new Set(suite.cases).size, suite.passed);
    assert.equal(suite.failed, 0);
    for (const name of requiredCases[suite.name]) assert(suite.cases.includes(name), `Missing ${name}`);
    assert.match(suite.logSha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(report.renderer.status, 'passed');
  assert.equal(report.renderer.cases.length, 3);
  assert.equal(report.renderer.projectDefaults, 6);
  assert.equal(report.renderer.chapters, 2);
  assert.equal(report.renderer.rename.status, 'passed');
  assert.equal(report.renderer.rename.cases.length, 7);
  assert.equal(report.renderer.rename.projectDefaults, 6);
  assert.equal(report.renderer.rename.chapters, 2);
  assert.equal(report.renderer.rename.fieldClocks, 4);
  assert.equal(report.strictTypeScript, 'passed');
}
if (process.argv.includes('--check')) {
  verify(json(output));
  console.log('Native local writing workspace evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/workspace-acceptance-');
  const before = sources();
  writeFileSync(`${directory}/source-before.json`, JSON.stringify(before, null, 2) + '\n');
  function run(name, command, args, extraEnv = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...extraEnv } });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(`${directory}/${name}.log`, log);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${name}: ${log.slice(-9000)}`);
    return log;
  }
  const suites = ['core', 'apple-bridge'].map(crate => {
    const name = crate === 'core' ? 'core-workspace' : 'bridge-workspace';
    const log = run(name, 'cargo', ['test', '--locked', '--manifest-path', `crates/drifting-${crate}/Cargo.toml`, 'workspace'], {
      NATIVE_WORKSPACE_EXPORT_DIR: path.resolve(directory),
    });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert(cases.length > 0, 'No workspace cases executed');
    return { name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-wire-check.ts',
    `--input=${directory}/workspace-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-wire-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2) + '\n');
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Workspace source changed during acceptance');
  const report = { schemaVersion: 1, kind: 'native_local_writing_workspace', status: 'passed',
    source: { files: before, fingerprint: sha(JSON.stringify(before)) }, suites,
    renderer: json(`${directory}/renderer.json`), strictTypeScript: 'passed', boundaries,
    rawEvidence: ['source-before.json', 'core-workspace.log', 'bridge-workspace.log', 'workspace-wire.json', 'workspace-rename-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']
      .map(name => ({ path: `${directory}/${name}`, sha256: sha(readFileSync(`${directory}/${name}`)) })),
  };
  verify(report);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', suites: suites.map(({ name, passed }) => ({ name, passed })), rendererChanges: report.renderer.cases.length, renameChanges: report.renderer.rename.cases.length, rawEvidence: directory }));
}
