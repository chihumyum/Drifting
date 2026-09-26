import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3b-chapter-trash.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'chapter-trash-preserves-prose-and-placement',
  'chapter-restore-reincarnates-and-remains-editable',
  'chapter-trash-restore-rollback-and-owner-retention',
];
const specs = [
  { name: 'core-chapter-trash', crate: 'drifting-core', filter: 'workspace::trash::tests::', required: [
    'workspace::trash::tests::workspace_trash_preserves_body_comments_and_restores_canonical_next_incarnation',
    'workspace::trash::tests::workspace_trash_and_restore_receipt_failures_rollback_and_retry_once',
    'workspace::trash::tests::workspace_trash_rejects_wrong_scope_lifecycle_and_associations_without_writes',
  ] },
  { name: 'bridge-chapter-trash', crate: 'drifting-apple-bridge', filter: 'workspace_tests::trash::', required: [
    'workspace_tests::trash::workspace_chapter_trash_preserves_prose_and_placement',
    'workspace_tests::trash::workspace_chapter_restore_reincarnates_and_remains_editable',
    'workspace_tests::trash::workspace_chapter_trash_restore_rollback_and_owner_retention',
  ] },
];
const expectedTables = [
  'project', 'book_node', 'node_content', 'node_storyline_link', 'entity_relation', 'comment', 'comment_action',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_conflict', 'yjs_updates', 'yjs_snapshots',
  'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = [
  'New original origin local/remote', 'Restored revision provenance System/Remote',
  'Local cache and timestamp preservation versus remote Yjs/winning-HLC projection',
  'Local sequence allocation versus remote HLC observation',
];
const boundaries = {
  source: 'Real native local chapter trash and restore commands over synthetic file-backed workspaces.',
  agreedGroups: [
    'Trash preserves prose, metadata placement and incarnation, closes only the committed target owner and survives cold reopen.',
    'Restore authors the complete four-mutation next-incarnation original, retains full Yjs state and supports fresh edit, undo and cold reopen.',
    'Composition/drafts block trash; receipt failure preserves domain/prose and owner recovery, while retry commits exactly once.',
  ],
  rendererParity: 'Production TypeScript canonical decoder and reducer transaction replay actual local originals on independent SQLite copies. Eighteen tables, authoritative Yjs state and semantic cache are compared; writer sequence and HLC are checked separately.',
  roleDifferences,
  excludedWallClockColumns: {
    yjs_updates: ['created_at'], yjs_document_revision: ['updated_at'],
    yjs_document_revision_provenance: ['created_at'], yjs_snapshots: ['updated_at'],
  },
  limitations: [
    'Bounded chapters without storyline or relation associations; unsupported associations are refused instead of silently removed.',
    'Local lifecycle support and legacy TypeScript compatibility oracle; native remote lifecycle receive and provider transport are not certified.',
    'Release preflight may refresh an unchanged prose snapshot timestamp before a metadata failure; core transaction rows and snapshot body remain intact.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, permanent deletion, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-trash-acceptance.mjs', 'scripts/apple-workspace-trash-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts',
        'src/renderer/usecase/useBookNode.ts', 'src/renderer/usecase/sync-lifecycle-restore.ts',
        'src/renderer/usecase/sync-helpers.ts', 'src/renderer/usecase/entity-relation-cleanup.ts',
        'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_chapter_trash');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Chapter trash evidence is stale; rerun its generator');
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
  assert.deepEqual(report.renderer.excludedWallClockColumns, boundaries.excludedWallClockColumns);
  assert.deepEqual(report.renderer.roleDifferences, roleDifferences);
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.steps.map(step => step.operation), index === 0 ? ['trash'] : ['trash', 'restore']);
    for (const step of item.steps) {
      assert.equal(step.mutationCount, step.operation === 'trash' ? 1 : 4);
      assert.equal(step.incarnation, step.operation === 'trash' ? 0 : 1);
      assert.equal(step.faultRollback, index === 2);
      assert.equal(step.duplicate, 'passed');
      assert.match(step.originalSha256, /^[a-f0-9]{64}$/u);
      assert.match(step.stateSha256, /^[a-f0-9]{64}$/u);
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
    assert.match(item.path, /^\.local-data\/apple-native\/chapter-trash-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-trash-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native chapter trash evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/chapter-trash-acceptance-');
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
      { NATIVE_WORKSPACE_TRASH_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-trash-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-trash-check.ts',
    `--input=${directory}/workspace-trash-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-trash-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Chapter trash source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-trash-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_chapter_trash', status: 'passed',
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
