import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3h-drifts.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'drift-groups-bodies-links-and-cold-reopen',
  'drift-act-binding-trash-restore-and-failures',
];
const operations = [
  ['createGroup', 'createGroup', 'createDrift', 'createDrift', 'renameDrift', 'updateDrift', 'moveDrift', 'deleteGroup'],
  ['bindAct', 'trashDrift', 'restoreDrift'],
];
// Actions of every original of a step, in journal order.
const actions = [
  [[['entity.create', 'order.move']], [['entity.create', 'order.move']], [['entity.create', 'yjs.update']],
    [['entity.create', 'yjs.update']], [['field.set']], [['field.set', 'field.set']], [['field.set']],
    [['field.set', 'order.rebalance', 'field.set', 'field.set', 'entity.purge']]],
  [[['field.set']], [['field.set'], ['entity.trash']], [['entity.restore', 'tuple.set', 'yjs.update']]],
];
// Group incarnation for group commands, act incarnation for a bind, drift incarnation otherwise.
const incarnations = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 1]];
const orderPlans = [['moves', 'moves', null, null, null, null, null, 'rebalance'], [null, null, null]];
const groupCounts = [[1, 2, 2, 2, 2, 2, 2, 1], [0, 0, 0]];
// Receipt faults injected before each original of the step.
const faults = [[0, 0, 0, 0, 0, 0, 0, 0], [1, 2, 1]];
const actUnbinds = [[null, null, null, null, null, null, null, null], [null, 1, null]];
// Receiver node stamps held back by the field-register order (reducerDefects):
// the moved drift after moveDrift and after the group delete lifts it again.
const heldStamps = [[0, 0, 0, 0, 0, 0, 1, 1], [0, 0, 0]];
// Only title edits may floor updated_at at the previous stamp + 1 ms (timing-dependent).
const floorable = ['renameDrift', 'updateDrift'];
// Local-only cells carried after each step (exact values are checked by the oracle).
const basis = ['book_node.word_count_basis_hash', 'book_node.word_count_basis_kind', 'book_node.word_count_basis_revision'];
const restoredCache = ['node_content.content_json', 'node_content.updated_at'];
const localOnly = [[[], [], basis, basis, basis, basis, basis, basis], [[], [], restoredCache]];
// Only a drift restore re-projects the reducer's cache of a body with prose.
const cacheProjection = [[[], [], [], [], [], [], [], []], [[], [], ['node_content']]];
// Trashing retires the open drift body, whose checkpoint re-stamp is carried.
const carriedCheckpoints = [[[], [], [], [], [], [], [], []], [[], ['node-content:<id>'], []]];
const nativeSeed = [{ type: 'paragraph', id: 'native-paragraph-<id>', text: '', attributes: ['id'] }];
const position = { native: { x: 0, y: 0 }, renderer: { x: -150, y: 150 }, receiver: { x: 0, y: 0 } };
const specs = [
  { name: 'core-drifts', crate: 'drifting-core', filter: 'workspace::drifts::tests::', required: [
    'workspace::drifts::tests::workspace_drifts_create_rename_and_group_moves',
    'workspace::drifts::tests::workspace_drifts_groups_nest_once_and_delete_lifts_children',
    'workspace::drifts::tests::workspace_drifts_act_binding_trash_and_restore',
  ] },
  { name: 'core-fractional-indexing', crate: 'drifting-core', filter: 'fractional::tests::', required: [
    'fractional::tests::matches_the_javascript_package',
  ] },
  { name: 'bridge-drifts', crate: 'drifting-apple-bridge', filter: 'workspace_tests::drifts::', required: [
    'workspace_tests::drifts::workspace_drifts_groups_bodies_links_and_cold_reopen',
    'workspace_tests::drifts::workspace_drifts_act_binding_trash_restore_and_failures',
  ] },
];
const expectedTables = [
  'project', 'book_node', 'node_content', 'book_act', 'drift_group', 'timeline_marker', 'storylines', 'node_storyline_link',
  'entity_relation', 'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
  'Materialized Yjs update, revision and provenance times: authored clock locally, receive wall clock remotely; provenance source system/remote',
];
const exemptions = [
  'Seed yjs.update payloads differ by design: native seeds one empty paragraph with a stable block id and caches it; the renderer seeds DEFAULT_TIPTAP_DOC_JSON as an empty fragment and caches it. Seeds are compared by decoded Yjs structure; every other byte of the original and every renderer authority row match.',
  'A new drift\'s word_count_basis_hash is the prose metric of its own seed cache on each side (verified as deriveProseMetricFromJson of that cache); word count, basis kind and revision match.',
  'node_content.content_json compares as parsed JSON (native key-sorted, reducer ProseMirror key order). A restore re-projects the reducer cache (and node_content.updated_at from the winning HLC) from authoritative Yjs while native, like the renderer restore, preserves the existing cache; each role is verified.',
  'The renderer content repository create and node softDelete/restore stamp created_at/updated_at/deleted_at with the wall clock; native and the originals use the authored clock.',
  'Host-chosen drift and drift-group IDs (renderer uuidv7) and the use-case clock are injected from the native result; the renderer computes every title, name, sibling order, order key, act unbind and wire byte itself.',
];
const localOnlyEffects = [
  'A new drift\'s graph position is local-only: no create mutation carries it, native and a receiver hold 0,0, and the renderer keeps its random scatter (pinned: Math.random 0.25, 0.75 gives -150,150); a later restore authors the stored position.',
  'Prose metrics are local projections the remote materializer never writes: a created drift keeps its seed word-count basis (kind, hash, revision 1) on the authoring side while a receiver holds none. Tracked per row with exact values.',
  'A drift title edit (renameNode/updateNode) within the millisecond of the drift\'s previous stamp floors updated_at at that stamp + 1 ms on the authoring side (native and the renderer alike) while a receiver stamps the winning HLC; when it occurs it is tracked per row with exact values.',
];
const carriedOwnerState = [
  'A retired body owner re-stamps its checkpoint (yjs_snapshots.updated_at, identical bytes) while trashing; for documents no mutation of the step targets, that row is carried from the native after-database, and every other owner row must be unchanged.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences = [];
const reducerDefects = [
  'TS remote node stamps follow field-register order, not time: every remote apply re-materializes each field register of the reduced state in effect-id (UTF-8) order and each write stamps updated_at with that register\'s winning HLC, so a node ends at the time of its UTF-8-last field register. After a drift\'s group moves later than its title edit (moveDriftToGroup, a group delete lifting it), a receiver keeps the older title time while native and the renderer keep the move time. Pinned per row with exact values.',
];
// Source-level native/renderer differences on paths these exports do not reach.
const unexportedDivergences = [
  'Unchanged renames are suppressed natively: renaming a drift group to its current name, or a drift to its current (unique) title, writes nothing, while useDriftGroup.renameGroup and useBookNode.renameNode journal field.set (and stamp updated_at) even when the value is unchanged. A no-op suppression, not a divergent original.',
];
const boundaries = {
  source: 'Real native drift, drift-group and act-binding commands over synthetic file-backed workspaces.',
  agreedGroups: [
    'Create a root drift group and a subgroup (each ordered last within its parent scope) and two drifts in the root group (free-floating book nodes without book order or storylines, durable body owners of their own, titled uniquely among chapters and drifts); rename one to the other\'s title (renameNode suffixes it " 2"), rename it and move it into the subgroup in one command (updateNode keeps the title as given), move it back by group alone (moveDriftToGroup), then delete the root group: the subgroup rises to the root after existing siblings (a full rebalance of that scope), both member drifts rise with it in UTF-8 id order and the group is purged; groups, titles and the body survive cold reopen and chapters link drift titles.',
    'Bind a drift with a body to an act boundary, trash it (the act is unbound in an original of its own before the trash original and the open body owner is retired), and restore it, unbound, into the next incarnation with its stored graph position and complete body.',
    'A receipt failure before each bind, trash and restore command leaves state intact and each retry writes exactly its canonical originals; unknown acts, non-drift targets, unknown groups, restoring a live drift, renaming an unknown group, unknown fields and nesting below a subgroup are refused without writes.',
  ],
  rendererParity: 'The renderer use cases (useDriftGroup createGroup/moveDriftToGroup/deleteGroup, useBookNode createNode/renameNode/updateNode/restoreNode and deleteNode with its unbindMarkersForDrift/unbindActsForDrift pre-transactions, useBookAct bindDrift, sync-lifecycle-restore) run through the production authored runner on each prior native database and author byte-identical originals, one per native original in the same order, except seed Yjs, with native drift and group IDs and the use-case clock injected, identical journal, lifecycle, field-clock, order and writer rows and the same node, body-cache, act, group and marker rows. The production decoder, reducer transaction and repositories consume every actual native original in order; twenty-two tables match under the listed roles, drift_group.sort_order equals the rank of the order authority on both roles, groups nest one level and acts bind live drifts at most once, every mutation target and payload equals the native after-state, the library delta follows each command, and the bridge library equals what the node, act and drift-group repositories read back from both databases. Each comparison rejects a one-cell corruption. The committed fractional-indexing vectors equal the JavaScript package.',
  roleDifferences,
  excludedColumns: [],
  exemptions,
  localOnlyEffects,
  carriedOwnerState,
  rendererDivergences,
  reducerDefects,
  unexportedDivergences,
  limitations: [
    'Native local drift, drift-group and act-binding commands; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Timeline-marker unbinding on drift trash (per marker field.set driftNodeId then label, a blank label captioned by the drift title) and group renames are core-test evidence only: native cannot create markers yet and exports no group rename. Nesting refusals are bridge- and core-test evidence.',
    'Group moves and colours, drift summary/status/position edits, drift-to-chapter conversion, act unbinding by command, drift purge and body prose edits are not exported originals here; body edits, entity links to drift titles and cold reopen are native bridge-test evidence.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-drift-acceptance.mjs', 'scripts/apple-workspace-drift-check.ts',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/agent/runtime/yjs-prose-command.ts',
        'src/renderer/lib/extensions/block-id.ts', 'src/renderer/lib/extensions/entity-link.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts', 'src/renderer/services/atomic-sync-transaction-tracker.ts',
        'src/renderer/hooks/useEntityYjsDoc.ts', 'src/renderer/hooks/useTimelineMarkers.ts',
        'src/renderer/usecase/useBookNode.ts', 'src/renderer/usecase/useDriftGroup.ts', 'src/renderer/usecase/useBookAct.ts',
        'src/renderer/usecase/book-node-write.ts', 'src/renderer/usecase/sync-lifecycle-restore.ts',
        'src/renderer/usecase/sync-helpers.ts', 'src/renderer/usecase/entity-relation-cleanup.ts',
        'packages/prose-metrics/src/index.ts',
        'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
        'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts',
        'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
      ].includes(name)
    )).sort();
  return files.map(name => ({ path: name, sha256: sha(readFileSync(name)) }));
}
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'native_drifts');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Drift evidence is stale; rerun its generator');
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
  assert.deepEqual(report.renderer.carriedOwnerState, carriedOwnerState);
  assert.deepEqual(report.renderer.rendererDivergences, rendererDivergences);
  assert.deepEqual(report.renderer.reducerDefects, reducerDefects);
  const vectors = 'crates/drifting-core/tests/fixtures/fractional-indexing.json';
  assert.deepEqual(report.renderer.fractionalIndexing, { status: 'passed', cases: json(vectors).length,
    errors: json(vectors).filter(item => item[3] === 'ERR').length, fixtureSha256: sha(readFileSync(vectors)) });
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
      assert.equal(step.incarnation, incarnations[index][stepIndex]);
      assert.equal(step.orderPlan, orderPlans[index][stepIndex]);
      assert.equal(step.groups, groupCounts[index][stepIndex]);
      for (const check of ['localDomainWire', 'rendererAuthority', 'rendererRow', 'duplicate', 'rankProjection', 'hierarchy', 'library', 'command']) {
        assert.equal(step[check], 'passed');
      }
      assert.equal(step.faultRollback, faults[index][stepIndex]);
      assert.equal(step.actUnbinds, actUnbinds[index][stepIndex]);
      assert.equal(typeof step.flooredStamp, 'boolean');
      assert(!step.flooredStamp || floorable.includes(step.operation), 'Only a title edit floors its stamp');
      assert.equal(step.receiverNodeStamps, heldStamps[index][stepIndex] + (step.flooredStamp ? 1 : 0));
      const heldLocally = step.receiverNodeStamps > 0 ? ['book_node.updated_at'] : [];
      assert.deepEqual(step.localOnly, [...heldLocally, ...localOnly[index][stepIndex]].sort());
      assert.deepEqual(step.cacheProjection, cacheProjection[index][stepIndex]);
      assert.deepEqual(step.carriedCheckpoints, carriedCheckpoints[index][stepIndex]);
      const created = step.operation === 'createDrift';
      assert.deepEqual(step.seed, created ? { native: nativeSeed, renderer: [] } : null);
      assert.deepEqual(step.position, created ? position : null);
      assert.deepEqual(step.nonVacuity, { original: 'rejected', rendererRow: 'rejected', table: 'rejected', library: 'rejected',
        rankProjection: step.groups > 0 ? 'rejected' : null });
      assert.match(step.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
      assert(step.documents.length >= 2);
      for (const document of step.documents) {
        assert.match(document.documentId, /^node-content:<id>$/u);
        assert.equal(typeof document.targeted, 'boolean');
        assert.match(document.stateSha256, /^[a-f0-9]{64}$/u);
      }
      assert.equal(step.documents.filter(document => document.targeted).length,
        step.originals.some(original => original.actions.includes('yjs.update')) ? 1 : 0);
      assert.deepEqual(step.tables.map(table => table.table), expectedTables);
      for (const table of step.tables) {
        assert(Number.isInteger(table.rows) && table.rows >= 0);
        assert.match(table.sha256, /^[a-f0-9]{64}$/u);
      }
    }
  }
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/drift-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-drift-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native drift evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/drift-acceptance-');
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
      { NATIVE_WORKSPACE_DRIFT_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-drift-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-workspace-drift-check.ts',
    `--input=${directory}/workspace-drift-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-drift-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Drift source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-drift-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_drifts', status: 'passed',
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
