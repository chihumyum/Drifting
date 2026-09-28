import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3g-storylines.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = [
  'storyline-create-assign-order-and-cold-reopen',
  'storyline-trash-restore-and-chapter-membership-restore',
  'storyline-failures-roll-back-and-retry',
];
const operations = [
  ['createStoryline', 'createStoryline', 'updateStoryline', 'setChapterStorylines', 'moveStoryline', 'setChapterStorylines', 'setStorylineFacts'],
  ['trashStoryline', 'restoreStoryline', 'trashChapter', 'restoreChapter'],
  ['createStoryline', 'setChapterStorylines', 'updateStoryline', 'trashStoryline'],
];
const first = ['entity.create', 'yjs.update', 'order.move', 'set.add', 'field.set', 'set.add', 'field.set'];
const actions = [
  [first, ['entity.create', 'yjs.update', 'order.move'], ['field.set', 'field.set'], ['set.add', 'field.set'],
    ['order.rebalance', 'order.rebalance'], ['set.remove', 'field.set'], ['entity.create', 'order.move']],
  [['set.remove', 'field.set', 'set.remove', 'field.set', 'entity.trash'], ['entity.restore', 'order.move', 'yjs.update'],
    ['entity.trash'], ['entity.restore', 'tuple.set', 'set.remove', 'set.add', 'field.set', 'yjs.update']],
  [first, ['set.remove', 'field.set'], ['field.set'], ['set.remove', 'field.set', 'entity.trash']],
];
// Storyline incarnation for storyline commands, node incarnation for chapter lifecycle, none for membership edits.
const incarnations = [[0, 0, 0, null, 0, null, 0], [0, 1, 0, 1], [0, null, 0, 0]];
const membership = (chapters, adds, removes) => ({ chapters, adds, removes });
const none = membership(0, 0, 0);
const memberships = [
  [membership(2, 2, 0), none, none, membership(1, 1, 0), none, membership(1, 0, 1), none],
  [membership(2, 0, 2), none, none, membership(1, 1, 1)],
  [membership(2, 2, 0), membership(1, 0, 1), none, membership(1, 0, 1)],
];
const faults = [[false, false, false, false, false, false, false], [false, false, false, false], [true, true, true, true]];
// Native kv-entry IDs replayed into the renderer KV authority per step.
const kvEntryIds = [[0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]];
const orderPlans = [['moves', 'moves', null, null, 'rebalance', null, null], [null, 'moves', null, null], ['moves', null, null, null]];
// The numeric placement the renderer passes to updateStoryline for the drag.
const rendererOrderKeys = [[null, null, null, null, -1, null, null], [null, null, null, null], [null, null, null, null]];
// Rows a remote order apply stamps while native keeps them (the moved row matches).
const receiverOrderStamps = [[0, 0, 0, 0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
// Local-only cells carried after each step (exact values are checked by the oracle).
const stamped = ['storylines.updated_at'];
const restoredCache = ['node_content.content_json', 'node_content.updated_at'];
const localOnly = [[[], [], [], [], stamped, stamped, stamped], [[], [], [], restoredCache], [[], [], [], []]];
// Only a chapter restore re-projects the reducer's cache of a body with prose.
const cacheProjection = [[[], [], [], [], [], [], []], [[], [], [], ['node_content']], [[], [], [], []]];
const libraries = [Array(7).fill('passed'), ['passed', 'passed', null, null], Array(4).fill('passed')];
const nativeSeed = [{ type: 'paragraph', id: 'native-paragraph-<id>', text: '', attributes: ['id'] }];
const specs = [
  { name: 'core-storylines', crate: 'drifting-core', filter: 'workspace::storylines::tests::', required: [
    'workspace::storylines::tests::workspace_storylines_first_storyline_becomes_every_chapter_primary',
    'workspace::storylines::tests::workspace_storylines_chapter_membership_projection_and_primary',
    'workspace::storylines::tests::workspace_storylines_trash_restore_and_chapter_restore_reauthor_membership',
  ] },
  { name: 'core-chapter-trash', crate: 'drifting-core', filter: 'workspace::trash::tests::', required: [
    'workspace::trash::tests::workspace_trash_preserves_body_comments_and_restores_canonical_next_incarnation',
    'workspace::trash::tests::workspace_trash_and_restore_receipt_failures_rollback_and_retry_once',
    'workspace::trash::tests::workspace_trash_rejects_wrong_scope_lifecycle_and_associations_without_writes',
  ] },
  { name: 'core-fractional-indexing', crate: 'drifting-core', filter: 'fractional::tests::', required: [
    'fractional::tests::matches_the_javascript_package',
  ] },
  { name: 'bridge-storylines', crate: 'drifting-apple-bridge', filter: 'workspace_tests::storylines::', required: [
    'workspace_tests::storylines::storyline_chapter_template_seeds_new_chapters_of_that_storyline',
    'workspace_tests::storylines::workspace_storylines_create_assign_order_and_cold_reopen',
    'workspace_tests::storylines::workspace_storylines_trash_restore_and_chapter_membership_restore',
    'workspace_tests::storylines::workspace_storylines_failures_roll_back_and_retry',
  ] },
];
const expectedTables = [
  'project', 'book_node', 'node_content', 'entity_relation', 'entity_kv_entry', 'storylines', 'node_storyline_link',
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
  'Seed yjs.update payloads differ by design: native seeds one empty paragraph with a stable block id and caches it; the renderer seeds DEFAULT_TIPTAP_DOC_JSON as an empty fragment and caches it. Seeds are compared by decoded Yjs structure; every other byte of the original and every renderer authority row match.',
  'storylines.content_json and node_content.content_json compare as parsed JSON (native creation caches key-sorted; a chapter body native has opened or saved, and reducer caches, in ProseMirror key order). A restore re-projects the reducer cache (and node_content.updated_at from the winning HLC) from authoritative Yjs while native, like the renderer restore, preserves the existing cache; each role is verified.',
  'The renderer repository softDeleteStoryline/restoreStoryline and node softDelete/restore stamp deleted_at/updated_at with the wall clock; native and the originals use the authored clock.',
  'New kv-entry IDs: the renderer KV authority mints uuidv7 while native mints host IDs, so its uuid import is replaced (scripts/apple-workspace-element-kv-ids.mjs) by the created kv-entry IDs of the native original in mutation order; each renderer step must drain exactly that queue.',
  'Host-chosen storyline IDs and colours (renderer uuidv7/randomColor) and the use-case clock are injected from the native result; the renderer computes every name, order key, membership, projection and wire byte itself.',
];
const localOnlyEffects = [
  'Facts-only updates and moves carry no storyline owner field: the authoring side stamps storylines.updated_at (native and the renderer use case alike) while a receiving reducer keeps its lifecycle/field time (after a move, from the next apply on). Tracked per row with exact values until an owner field re-stamps it.',
  'A remote order apply (materializeOrder) stamps storylines.updated_at with the winning HLC on every storyline an order mutation of the original targets, while native moves stamp nothing (create and restore stamp the same authored time on both roles). Pinned per step with exact values.',
];
const carriedOwnerState = [
  'A retired body owner re-stamps its checkpoint (yjs_snapshots.updated_at, identical bytes) while trashing; for documents no mutation of the original targets, that row is carried from the native after-database, and every other owner row must be unchanged.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences = [];
const reducerDefects = [
  'TS remote order stamps are transient: every remote apply re-materializes the reducer state and materializeOrder stamps updated_at only for the original being applied, so the next apply of any original rewrites a moved storyline back to its lifecycle/field time (updated_at moves backwards). Pinned: the stamp exists only at the ordering step; afterwards the receiver returns to that time (equal to native for unmoved siblings, the tracked local-only stamp for the moved row).',
];
const boundaries = {
  source: 'Real native storyline, chapter membership and chapter trash/restore commands over synthetic file-backed workspaces.',
  agreedGroups: [
    'Create the first storyline (every live chapter becomes its primary member) and a second whose name gains a case-insensitive " 2", rename it and edit its summary, add it to a chapter as primary, drag it first (a full order rebalance), reduce that chapter to the first storyline and set storyline facts; memberships, order and facts survive cold reopen and the storyline body is a durable owner of its own.',
    'Trash a storyline that is one chapter\'s primary and another\'s secondary (the first chapter loses every link, the second only that one), restore it into the next incarnation at its (order_key, id) placement with its complete body, then trash and restore a chapter whose links survive the trash and are re-authored as fresh membership tags in its new incarnation.',
    'A receipt failure before each create, membership, update and trash command leaves state intact and each retry writes exactly one canonical original; trashed or unknown storylines, unknown chapters, invalid colours and unknown fields are refused without writes.',
  ],
  rendererParity: 'The renderer use cases (useStoryline createStoryline/updateStoryline/setNodeStorylines/deleteStoryline/restoreStoryline, useBookNode deleteNode/restoreNode, sync-lifecycle-restore) run through the production authored runner on each prior native database and author byte-identical originals except seed Yjs, with native storyline IDs, colours and kv-entry IDs injected, identical journal, lifecycle, field-clock, membership OR-set, order and KV rows and the same storyline, link and chapter rows. The production decoder, reducer transaction and repositories consume the actual native originals; twenty tables match under the listed roles, node_storyline_link equals the live membership tags and primary registers on both roles, order_key equals the rank of the order authority, membership mutations equal an independent per-chapter OR-set diff, and the bridge library equals what the storyline, link and node repositories read back. The committed fractional-indexing vectors equal the JavaScript package.',
  roleDifferences,
  excludedColumns: [],
  exemptions,
  localOnlyEffects,
  carriedOwnerState,
  rendererDivergences,
  reducerDefects,
  limitations: [
    'Native local storyline and membership commands; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Exported setChapterStorylines steps pass an explicit primary (a storyline or null); an absent primary (keep the current one, prepended if unlisted) follows the same setNodeStorylines rule natively and is core-test evidence.',
    'Exported updateStoryline steps change every named field: native journals only changed values while useStoryline.updateStoryline journals each passed field; unchanged-value updates are not compared.',
    'Storyline trash projects membership for live chapters only on both sides (as the renderer store holds them); a trashed chapter still linked to the trashed storyline loses that link without an original while a receiver keeps it, which the relation report exports and pins. Storyline trash also purges the storyline\'s relations inside its original (see relations.md); the storylines exported here carry none.',
    'Every exported create clones an empty project storyline template; template contents, fact renames/reorders/removals and storyline purge are not exported here.',
    'Storyline body prose edits and cold reopen are native bridge-test evidence; body edits are not exported originals here. Drifts, drift groups, act/marker drift bindings and permanent deletion are not implemented natively.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-storyline-acceptance.mjs', 'scripts/apple-workspace-storyline-check.ts',
        'scripts/apple-workspace-element-kv-ids.mjs',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/agent/runtime/yjs-prose-command.ts',
        'src/renderer/lib/extensions/block-id.ts', 'src/renderer/lib/extensions/entity-link.ts',
        'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/yjs-transaction-evidence.ts', 'src/renderer/services/atomic-sync-transaction-tracker.ts',
        'src/renderer/hooks/useEntityYjsDoc.ts', 'src/renderer/utils/color.ts',
        'src/renderer/usecase/useStoryline.ts', 'src/renderer/usecase/useBookNode.ts',
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
  assert.equal(report.kind, 'native_storylines');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Storyline evidence is stale; rerun its generator');
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
      assert.deepEqual(step.actions, actions[index][stepIndex]);
      assert.equal(step.mutationCount, step.actions.length);
      assert.equal(step.incarnation, incarnations[index][stepIndex]);
      assert.deepEqual(step.membership, memberships[index][stepIndex]);
      for (const check of ['localDomainWire', 'rendererAuthority', 'rendererRow', 'duplicate', 'membershipAuthority', 'rankProjection', 'command']) {
        assert.equal(step[check], 'passed');
      }
      assert.equal(step.library, libraries[index][stepIndex]);
      assert.equal(step.faultRollback, faults[index][stepIndex]);
      assert.equal(step.kvEntryIds, kvEntryIds[index][stepIndex]);
      assert.equal(step.orderPlan, orderPlans[index][stepIndex]);
      assert.equal(step.rendererOrderKey, rendererOrderKeys[index][stepIndex]);
      assert.equal(step.rendererDivergence, undefined);
      assert.equal(step.receiverOrderStamps, receiverOrderStamps[index][stepIndex]);
      assert.deepEqual(step.localOnly, localOnly[index][stepIndex]);
      assert.deepEqual(step.cacheProjection, cacheProjection[index][stepIndex]);
      assert.deepEqual(step.carriedCheckpoints, []);
      assert.deepEqual(step.seed, step.operation === 'createStoryline' ? { native: nativeSeed, renderer: [] } : null);
      assert.match(step.originalSha256, /^[a-f0-9]{64}$/u);
      assert.match(step.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
      assert(step.documents.length >= 2);
      for (const document of step.documents) {
        assert.match(document.documentId, /^(?:node-content|storyline):<id>$/u);
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
    assert.match(item.path, /^\.local-data\/apple-native\/storyline-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-storyline-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native storyline evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/storyline-acceptance-');
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
      { NATIVE_WORKSPACE_STORYLINE_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-storyline-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', '--import=./scripts/apple-workspace-element-kv-ids.mjs',
    'scripts/apple-workspace-storyline-check.ts',
    `--input=${directory}/workspace-storyline-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-storyline-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Storyline source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-storyline-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_storylines', status: 'passed',
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
