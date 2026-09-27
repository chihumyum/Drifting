import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3j-relations.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = ['relations-types-edges-and-trash'];
const operations = [['createType', 'createType', 'createType', 'addRelation', 'addRelation', 'addRelation', 'addRelation',
  'retypeRelation', 'updateType', 'trashElement', 'trashChapter', 'trashStoryline', 'deleteType']];
// `${action} ${target kind}` of every original of a step, in journal order.
const actions = [[
  [['entity.create entity-relation-type']], [['entity.create entity-relation-type']], [['entity.create entity-relation-type']],
  [['entity.create entity-relation']], [['entity.create entity-relation']], [['entity.create entity-relation']], [['entity.create entity-relation']],
  [Array(5).fill('field.set entity-relation')], [Array(10).fill('field.set entity-relation-type')],
  [['entity.purge entity-relation', 'entity.purge entity-relation', 'entity.trash element']],
  [['entity.purge entity-relation', 'entity.trash node']],
  [['entity.purge entity-relation', 'set.remove membership', 'field.set node-storyline-primary', 'entity.trash storyline']],
  [['entity.purge entity-relation-type']],
]];
// Relations purged by each step, stored relations and relation types after it.
const purgedRelations = [[0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0]];
const relationCounts = [[0, 0, 0, 1, 2, 3, 4, 4, 4, 2, 1, 0, 0]];
const typeCounts = [[2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3]];
// Receipt faults injected before each original of the step.
const faults = [[1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]];
// Trash steps also read the element and storyline libraries (or the chapter's
// trash state) back through the production repositories.
const entityLibraries = [[null, null, null, null, null, null, null, null, null, 'passed', 'passed', 'passed', null]];
// The trashed chapter's link to the trashed storyline, kept only by a receiver (localOnlyEffects).
const keptLink = { table: 'node_storyline_link', chapter: 1, storyline: 'entities.storyline', isPrimary: 1 };
const keptRows = [[[], [], [], [], [], [], [], [], [], [], [], [keptLink], [keptLink]]];
const documentKinds = ['category:<id>', 'element:<id>', 'element:<id>', 'element:<id>', 'node-content:<id>', 'node-content:<id>', 'storyline:<id>'];
const specs = [
  { name: 'core-relations', crate: 'drifting-core', filter: 'workspace::relations::tests::', required: [
    'workspace::relations::tests::workspace_relation_types_create_update_and_delete',
    'workspace::relations::tests::workspace_relations_add_canonicalize_retype_and_remove',
    'workspace::relations::tests::workspace_relations_are_purged_by_trash_and_not_restored',
  ] },
  { name: 'bridge-relations', crate: 'drifting-apple-bridge', filter: 'workspace_tests::relation_tests::', required: [
    'workspace_tests::relation_tests::workspace_relations_types_edges_trash_and_cold_reopen',
  ] },
];
const expectedTables = [
  'project', 'book_node', 'node_content', 'element_category', 'element', 'entity_kv_entry', 'storylines', 'node_storyline_link',
  'entity_relation', 'entity_relation_type', 'entity_relation_type_endpoint_kind',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
];
const exemptions = [
  'The renderer repository softDelete (element, node) and softDeleteStoryline stamp deleted_at/updated_at of the trashed row with the wall clock; native and the originals use the authored clock.',
  'Host-chosen relation-type and relation IDs (renderer uuidv7) and the use-case clock are injected from the native result; the renderer computes every normalization, canonical endpoint order, purge set and order, membership projection and wire byte itself.',
];
const localOnlyEffects = [
  'Storyline trash removes the link of a trashed chapter to the trashed storyline locally (native and the renderer alike, DELETE by storyline_id) without an original, since membership is projected for live chapters only; a receiving reducer keeps that node_storyline_link row. Tracked per row with exact values for every later step.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences = [];
const reducerDefects = [];
// Source-level native/renderer differences on paths these exports do not reach.
const unexportedDivergences = [
  'Unchanged edits are suppressed natively: updating a type to its current definition, or retyping a relation to its current type and ends, writes nothing, while useEntityRelationTypes.updateRelationType journals all ten field.set and useEntityRelations.updateRelationType all five (and stamp updated_at). A no-op suppression, not a divergent original.',
  'Native links only live chapters, drifts, elements, categories and storylines: an endpoint in the trash (or a patch, comment or library item) is refused, while the renderer use case and the production kernel accept any existing endpoint row, trashed included. A stricter native refusal, not a divergent original.',
];
const boundaries = {
  source: 'Real native relation-type, relation and relation-purging trash commands over a synthetic file-backed workspace.',
  agreedGroups: [
    'Create a directed type (name trimmed, kinds deduplicated in canonical order), a symmetric type (the shared default role 端点) and a storyline-to-element type; add a directed element relation, a symmetric chapter-element relation stored with the bytewise-smaller kind:id first and two storyline-element relations (each entity.create seeding the five endpoint fields); swap the directed relation (all five field.set in UTF-8 order) and change the symmetric type\'s description (all ten field.set in UTF-8 order).',
    'Trash an element, a chapter and a storyline: each trash original first purges every relation touching the entity, in the renderer\'s query order, then trashes it, and the storyline trash projects the membership of the live chapter it was primary for; delete the then unused storyline type (entity.purge, endpoint rows cascade). The relation library survives cold reopen.',
    'A receipt failure before the first type, the first relation and the element trash leaves state intact and each retry writes exactly its canonical original; reversed directions, unknown endpoints, duplicate names, deleting a used or built-in type, unknown relations and unknown fields are refused without writes, an identical edge is returned unchanged and removing an unknown relation writes nothing.',
  ],
  rendererParity: 'The renderer use cases (useEntityRelationTypes createRelationType/updateRelationType/deleteRelationType, useEntityRelations addRelation and updateRelationType with swapEndpoints, and the trash paths of useBookElement.removeElement, useBookNode.deleteNode and useStoryline.deleteStoryline through deleteEntityRelationsInTransaction) run through the production authored runner, including its production-kernel post-write validation, on each prior native database and author byte-identical originals, one per native original, with native relation-type and relation IDs and the use-case clock injected: identical journal, lifecycle, field-clock, set, order and writer rows and the same relation, relation-type, endpoint-kind, element, node, storyline and link rows, deleteEntityRelationsInTransaction purging the same relations in the same order. The production decoder, reducer transaction and repositories consume every native original in order without conflicts; twenty-four tables match under the listed roles and pins, stored relations satisfy their types (allowed kinds, canonical symmetric order, no self-edge or duplicate) and live chapter links project their membership authority on both roles, every mutation target, incarnation and payload equals an independent plan against the native after-state, each command changes exactly its rows and library entries, and the bridge relation, element and storyline libraries equal what the production repositories read back from both databases. Each comparison rejects a corruption.',
  roleDifferences,
  excludedColumns: [],
  exemptions,
  localOnlyEffects,
  rendererDivergences,
  reducerDefects,
  unexportedDivergences,
  limitations: [
    'Native local relation and relation-purging trash commands; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Category and drift trash with relations, removeRelation, retypes without a swap, directed/symmetric type changes and the fail-closed trash of an entity whose relation has no lifecycle are core-test evidence only; refusals, the identical-edge return and cold reopen are bridge-test evidence.',
    'Relations from patches, comments and library items, links to the built-in generic association and restoring an entity whose relations were purged (restore does not bring them back) are not exported here.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-relation-acceptance.mjs', 'scripts/apple-workspace-relation-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/db.ts', 'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/atomic-sync-transaction-tracker.ts',
        'src/renderer/usecase/useEntityRelationTypes.ts', 'src/renderer/usecase/useEntityRelations.ts',
        'src/renderer/usecase/entity-relation-cleanup.ts', 'src/renderer/usecase/useBookElement.ts',
        'src/renderer/usecase/useBookNode.ts', 'src/renderer/usecase/useStoryline.ts',
        'src/renderer/usecase/sync-lifecycle-restore.ts', 'src/renderer/usecase/sync-helpers.ts',
        'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_relations');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Relation evidence is stale; rerun its generator');
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
  assert.deepEqual(report.renderer.localOnlyEffects, localOnlyEffects);
  assert.deepEqual(report.renderer.rendererDivergences, rendererDivergences);
  assert.deepEqual(report.renderer.reducerDefects, reducerDefects);
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.steps.map(step => step.operation), operations[index]);
    for (const [stepIndex, step] of item.steps.entries()) {
      assert.deepEqual(step.originals.map(original => original.actions), actions[index][stepIndex]);
      for (const original of step.originals) {
        assert.match(original.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(original.mutationCount, original.actions.length);
      }
      assert.equal(step.purgedRelations, purgedRelations[index][stepIndex]);
      assert.equal(step.relations, relationCounts[index][stepIndex]);
      assert.equal(step.types, typeCounts[index][stepIndex]);
      for (const check of ['localDomainWire', 'rendererAuthority', 'rendererRow', 'mutations', 'command', 'library', 'invariants', 'duplicate']) {
        assert.equal(step[check], 'passed');
      }
      assert.equal(step.entityLibrary, entityLibraries[index][stepIndex]);
      assert.equal(step.proseOwners, 'unchanged');
      assert.equal(step.faultRollback, faults[index][stepIndex]);
      assert.deepEqual(step.keptRows, keptRows[index][stepIndex]);
      assert.deepEqual(step.nonVacuity, { original: 'rejected', mutations: 'rejected', rendererRow: 'rejected', table: 'rejected',
        library: 'rejected', invariants: 'rejected' });
      assert.match(step.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
      assert.deepEqual(step.documents.map(document => document.documentId).sort(), documentKinds,
        'Chapter, category, element and storyline bodies stay untouched');
      for (const document of step.documents) assert.match(document.stateSha256, /^[a-f0-9]{64}$/u);
      assert.deepEqual(step.tables.map(table => table.table), expectedTables);
      for (const table of step.tables) {
        assert(Number.isInteger(table.rows) && table.rows >= 0);
        assert.match(table.sha256, /^[a-f0-9]{64}$/u);
      }
    }
  }
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/relation-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-relation-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native relation evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/relation-acceptance-');
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
      { NATIVE_WORKSPACE_RELATION_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-relation-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-relation-check.ts',
    `--input=${directory}/workspace-relation-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-relation-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Relation source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-relation-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_relations', status: 'passed',
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
