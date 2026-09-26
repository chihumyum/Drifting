import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3e-element-library.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'element-library-create-update-and-cold-reopen',
  'element-trash-retires-owner-and-restore-reopens-body',
  'element-failures-roll-back-and-retry',
];
const operations = [
  ['createCategory', 'createElement', 'updateElement', 'updateCategory', 'updateElement'],
  ['trashElement', 'restoreElement'],
  ['createCategory', 'createElement', 'updateElement', 'trashElement', 'restoreElement'],
];
const create = ['entity.create', 'yjs.update'];
const restore = ['entity.restore', 'set.add', 'yjs.update'];
const actions = [
  [create, create, ['set.add', 'set.add', 'field.set', 'field.set', 'field.set'], ['field.set', 'field.set'], ['set.remove', 'set.add']],
  [['entity.trash'], restore],
  [create, create, ['set.add', 'field.set'], ['entity.trash'], restore],
];
const incarnations = [[0, 0, 0, 0, 0], [0, 1], [0, 0, 0, 0, 1]];
// The retired body owner re-stamps its checkpoint while trashing.
const carriedCheckpoints = [[[], [], [], [], []], [['element:<id>'], []], [[], [], [], [], []]];
// Only a restore of a body with prose re-projects the reducer's cache.
const cacheProjection = [[[], [], [], [], []], [[], ['element']], [[], [], [], [], []]];
const nativeSeed = [{ type: 'paragraph', id: 'native-paragraph-<id>', text: '', attributes: ['id'] }];
const specs = [
  { name: 'core-element-library', crate: 'drifting-core', filter: 'workspace::elements::tests::', required: [
    'workspace::elements::tests::workspace_elements_categories_create_rename_and_recolour',
    'workspace::elements::tests::workspace_elements_create_defaults_names_conflicts_and_seed',
    'workspace::elements::tests::workspace_elements_update_scalars_and_alias_set',
    'workspace::elements::tests::workspace_elements_trash_restore_and_failures',
  ] },
  { name: 'bridge-element-library', crate: 'drifting-apple-bridge', filter: 'workspace_tests::elements::', required: [
    'workspace_tests::elements::workspace_element_library_create_update_and_cold_reopen',
    'workspace_tests::elements::workspace_element_trash_retires_owner_and_restore_reopens_body',
    'workspace_tests::elements::workspace_element_failures_roll_back_and_retry',
  ] },
];
const expectedTables = [
  'project', 'book_node', 'node_content', 'entity_relation', 'entity_kv_entry', 'element_category', 'element',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
  'Materialized Yjs update, revision and provenance times: authored clock locally, receive wall clock remotely; provenance source system/remote',
];
const exemptions = [
  'Seed yjs.update payloads differ by design: native seeds one empty paragraph with a stable block id and caches it; the renderer seeds the category "{}" template as an empty fragment and caches "{}". Seeds are compared by decoded Yjs structure; every other byte of the original and every renderer authority row match.',
  'element/element_category content_json compares as parsed JSON (native key-sorted, reducer ProseMirror key order). A restore re-projects the reducer cache from authoritative Yjs while native, like the renderer restore, preserves the existing cache; each role is verified.',
  'The renderer repository softDelete/restore stamps its own row with the wall clock; native and the originals use the authored clock.',
  'An alias-only update carries no element field: the authoring side stamps element.updated_at (native and the renderer repository alike) while a receiving reducer keeps the previous value.',
];
const carriedOwnerState = [
  'A retired element body owner re-stamps its checkpoint (yjs_snapshots.updated_at, identical bytes) while trashing; for documents no mutation of the original targets, that row is carried from the native after-database, and every other owner row must be unchanged.',
];
const reducerDefects = [
  'TS remote alias projection (materializeSet) collects present members of every incarnation: after a restore the reducer writes element.aliases_json with the trashed incarnation\'s aliases repeated, where native and the renderer local path write the live incarnation only. Pinned to both restores; OR-set tags and every other column match.',
];
const boundaries = {
  source: 'Real native element category and element create, update, trash and restore commands over synthetic file-backed workspaces.',
  agreedGroups: [
    'Create a category and a default-named element, rename it with NFKC aliases, clear its group and recolour the category; the body owner edits, undoes and cold-reopens independently of chapters.',
    'Trash retires the open body owner and hides the element; restore reauthors the next incarnation with every alias and the complete body state, which reopens editable without prose undo history.',
    'A receipt failure before each command leaves state intact and each retry writes exactly one canonical original; invalid categories, colours, name conflicts, lifecycle and unknown fields are refused without writes.',
  ],
  rendererParity: 'The renderer use cases (useElementCategory, useBookElement, normalized-kv-alias-authority, sync-lifecycle-restore) run through the production authored runner on each prior native database and author byte-identical originals except seed Yjs, with identical journal, lifecycle, field-clock, OR-set, order and KV rows and the same element/category row. The production decoder, reducer transaction and repositories consume the actual native originals; twenty tables match under the listed roles, rows equal the native command result and aliases_json equals the live alias displays in member order.',
  roleDifferences,
  excludedColumns: [],
  exemptions,
  carriedOwnerState,
  reducerDefects,
  limitations: [
    'Native local element library commands; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Exported steps only add aliases; alias removal and display replacement (set.remove with observedAddTags) are core-test evidence and are checked here only if an exported step emits them.',
    'Category templates, element facts, portraits, relations, category trash/restore and permanent deletion are refused natively and not covered.',
    'Element body prose edits, undo/redo and reopen are native bridge-test evidence; body edits are not exported originals here.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-element-acceptance.mjs', 'scripts/apple-workspace-element-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/agent/runtime/yjs-prose-command.ts',
        'src/renderer/lib/extensions/block-id.ts', 'src/renderer/lib/extensions/entity-link.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts', 'src/renderer/services/atomic-sync-transaction-tracker.ts',
        'src/renderer/hooks/useEntityYjsDoc.ts', 'src/renderer/utils/color.ts',
        'src/renderer/usecase/useBookElement.ts', 'src/renderer/usecase/useElementCategory.ts',
        'src/renderer/usecase/normalized-kv-alias-authority.ts', 'src/renderer/usecase/sync-lifecycle-restore.ts',
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
  assert.equal(report.kind, 'native_element_library');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Element library evidence is stale; rerun its generator');
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
  assert.deepEqual(report.renderer.roleDifferences, roleDifferences);
  assert.deepEqual(report.renderer.excludedColumns, boundaries.excludedColumns);
  assert.deepEqual(report.renderer.exemptions, exemptions);
  assert.deepEqual(report.renderer.carriedOwnerState, carriedOwnerState);
  assert.deepEqual(report.renderer.reducerDefects, reducerDefects);
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.steps.map(step => step.operation), operations[index]);
    for (const [stepIndex, step] of item.steps.entries()) {
      assert.deepEqual(step.actions, actions[index][stepIndex]);
      assert.equal(step.mutationCount, step.actions.length);
      assert.equal(step.incarnation, incarnations[index][stepIndex]);
      // Only the display change removes an observed alias tag.
      assert.equal(step.aliasRemovals, index === 0 && stepIndex === 4 ? 1 : 0);
      for (const check of ['localDomainWire', 'rendererAuthority', 'rendererRow', 'duplicate', 'row', 'aliases', 'command']) {
        assert.equal(step[check], 'passed');
      }
      assert.equal(step.faultRollback, index === 2);
      assert.deepEqual(step.seed, step.operation.startsWith('create') ? { native: nativeSeed, renderer: [] } : null);
      assert.deepEqual(step.carriedCheckpoints, carriedCheckpoints[index][stepIndex]);
      assert.deepEqual(step.cacheProjection, cacheProjection[index][stepIndex]);
      assert.equal(step.staleIncarnationAliases, step.operation === 'restoreElement');
      assert.match(step.originalSha256, /^[a-f0-9]{64}$/u);
      assert.match(step.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
      assert(step.documents.length >= 3);
      for (const document of step.documents) {
        assert.match(document.documentId, /^(?:node-content|category|element):<id>$/u);
        assert.equal(typeof document.targeted, 'boolean');
        assert.match(document.stateSha256, /^[a-f0-9]{64}$/u);
      }
      assert.equal(step.documents.filter(document => document.targeted).length, step.actions.includes('yjs.update') ? 1 : 0);
      assert.deepEqual(step.tables.map(table => table.table), expectedTables);
      for (const table of step.tables) {
        assert(Number.isInteger(table.rows) && table.rows >= 0);
        assert.match(table.sha256, /^[a-f0-9]{64}$/u);
      }
    }
  }
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/element-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-element-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native element library evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/element-acceptance-');
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
      { NATIVE_WORKSPACE_ELEMENT_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-element-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-element-check.ts',
    `--input=${directory}/workspace-element-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-element-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Element library source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-element-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_element_library', status: 'passed',
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
