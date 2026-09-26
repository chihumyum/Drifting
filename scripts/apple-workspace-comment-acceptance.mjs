import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3d-chapter-comments.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'comment-create-highlights-and-cold-reopen',
  'comment-body-and-status-keep-anchor-and-history',
  'comment-failures-leave-owner-unchanged-and-retry',
];
const operations = [['create'], ['body', 'resolve', 'reopen'], ['create', 'body', 'resolve']];
// The failure group's retried create follows one native prose edit.
const carriedProseOriginals = [[0], [0, 0, 0], [1, 0, 0]];
const specs = [
  { name: 'core-chapter-comments', crate: 'drifting-core', filter: 'workspace::comments::tests::', required: [
    'workspace::comments::tests::workspace_comments_plain_body_matches_renderer_document',
    'workspace::comments::tests::workspace_comments_create_list_and_cold_reopen',
    'workspace::comments::tests::workspace_comments_body_and_status_keep_anchor_metadata_and_prose',
    'workspace::comments::tests::workspace_comments_receipt_failures_and_invalid_targets_rollback',
  ] },
  { name: 'bridge-chapter-comments', crate: 'drifting-apple-bridge', filter: 'workspace_tests::comments::', required: [
    'workspace_tests::comments::workspace_comment_create_highlights_and_cold_reopen',
    'workspace_tests::comments::workspace_comment_anchor_follows_edits_history_and_removal',
    'workspace_tests::comments::workspace_comment_body_and_status_keep_anchor_and_history',
    'workspace_tests::comments::workspace_comment_failures_leave_owner_unchanged_and_retry',
  ] },
];
const expectedTables = [
  'project', 'book_act', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = ['New original origin local/remote', 'Local sequence allocation versus remote HLC observation'];
const carriedOwnerState = [
  'Live prose owner rows (yjs_updates, yjs_snapshots, yjs_document_revision, yjs_document_revision_provenance, sync_yjs_materialization_receipt) are carried from each native after-database before replay; the comment reducer must leave them untouched.',
  'Intermediate native prose originals between exported steps are carried with their journal rows only after decoding as yjs.update on a fixture chapter and reproducing its authoritative Yjs state; a receipt whose update row the owner already compacted is admitted against a transient row holding the carried update, then compacted again.',
];
const boundaries = {
  source: 'Real native chapter comment create, body edit, resolve and reopen commands over synthetic file-backed workspaces.',
  agreedGroups: [
    'Create a manual note on a cross-paragraph selection; its owner highlights it, another chapter stays empty and cold reopen restores anchor and body.',
    'Edit the body, resolve and reopen without moving the anchor, changing prose or entering prose undo history.',
    'Stale revision, empty selection or body, open draft, receipt failure, missing comment and wrong chapter leave state intact; each retry writes exactly one canonical original.',
  ],
  rendererParity: 'Production domain-to-wire conversion, canonical decoder and reducer transaction consume actual native originals. Nineteen tables match; the materialized comment row equals the native command result in every column, raw and through the production repository; production comment helpers reproduce each body and resolve each anchor against authoritative Yjs text.',
  roleDifferences,
  excludedColumns: [],
  carriedOwnerState,
  limitations: [
    'Native local chapter comments; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Direct manual notes on a chapter only; no comment deletion, TODO conversion, Copilot suggestion, comment action or entity relation.',
    'Anchor movement across prose edits, undo, redo and removal is native bridge-test evidence; the owner never journals anchor movement as an original.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-comment-acceptance.mjs', 'scripts/apple-workspace-comment-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts',
        'src/renderer/usecase/useComment.ts',
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
  assert.equal(report.kind, 'native_chapter_comments');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Chapter comments evidence is stale; rerun its generator');
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
  assert.deepEqual(report.renderer.carriedOwnerState, carriedOwnerState);
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.steps.map(step => step.operation), operations[index]);
    for (const [stepIndex, step] of item.steps.entries()) {
      const status = step.operation === 'resolve' || step.operation === 'reopen';
      assert.equal(step.mutationCount, status ? 2 : 1);
      assert.deepEqual(step.actions, step.operation === 'create' ? ['entity.create'] : status ? ['field.set', 'field.set'] : ['field.set']);
      for (const check of ['localDomainWire', 'duplicate', 'row', 'body', 'anchor', 'ownerUntouched']) assert.equal(step[check], 'passed');
      assert.equal(step.incarnation, 0);
      assert.equal(step.faultRollback, index === 2);
      assert.equal(step.carriedProseOriginals, carriedProseOriginals[index][stepIndex]);
      assert.match(step.originalSha256, /^[a-f0-9]{64}$/u);
      assert.equal(step.documents.length, 2);
      for (const [documentIndex, document] of step.documents.entries()) {
        assert.equal(document.unchanged, !(step.carriedProseOriginals > 0 && documentIndex === 0));
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
    assert.match(item.path, /^\.local-data\/apple-native\/comment-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-comment-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native chapter comments evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/comment-acceptance-');
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
      { NATIVE_WORKSPACE_COMMENT_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-comment-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-comment-check.ts',
    `--input=${directory}/workspace-comment-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-comment-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Chapter comments source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-comment-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_chapter_comments', status: 'passed',
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
