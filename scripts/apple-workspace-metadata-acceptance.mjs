import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length)
  ?? 'docs/apple-native/acceptance/p3i-metadata.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = name => JSON.parse(readFileSync(name, 'utf8'));
const groups = ['metadata-project-and-nodes'];
const operations = [['updateProject', 'reorderFacts', 'setNodeSummary', 'setNodeStatus', 'setNodeStatus', 'setNodeSummary']];
const targets = [['project', 'project', 'chapter', 'chapter', 'drift', 'drift']];
// Actions of every original of a step, in journal order.
const actions = [[
  [['entity.purge', 'field.set', 'entity.create', 'order.move', 'entity.create', 'entity.create', 'order.move', 'order.move', 'field.set']],
  [Array(6).fill('order.rebalance')], [['field.set']], [['field.set']], [['field.set']], [['field.set']],
]];
// Project incarnation for project updates, node incarnation otherwise.
const incarnations = [[0, 0, 0, 0, 0, 0]];
// Native kv-entry IDs replayed into the renderer KV authority per step.
const kvEntryIds = [[3, 0, 0, 0, 0, 0]];
const orderPlans = [[{ facts: 'moves', 'storyline-template': 'moves' }, { facts: 'rebalance' }, null, null, null, null]];
// Receipt faults injected before each original of the step.
const faults = [[1, 0, 0, 1, 0, 0]];
// Receiver stamps pinned per step: a KV-only project update (from the reorder
// on), and the drift held at its status register once its later summary edit
// sorts before it (field:summary < field:writingStatus).
const projectStamps = [[0, 1, 1, 1, 1, 1]];
const registerOrderStamps = [[0, 0, 0, 0, 0, 1]];
const specs = [
  { name: 'core-metadata', crate: 'drifting-core', filter: 'workspace::metadata::tests::', required: [
    'workspace::metadata::tests::workspace_metadata_node_summary_and_status',
    'workspace::metadata::tests::workspace_metadata_project_summary_facts_and_template',
  ] },
  { name: 'core-fractional-indexing', crate: 'drifting-core', filter: 'fractional::tests::', required: [
    'fractional::tests::matches_the_javascript_package',
  ] },
  { name: 'bridge-metadata', crate: 'drifting-apple-bridge', filter: 'workspace_tests::metadata::', required: [
    'workspace_tests::metadata::workspace_metadata_project_facts_template_and_node_edits',
  ] },
];
const expectedTables = [
  'project', 'book_node', 'node_content', 'entity_kv_entry', 'storylines', 'node_storyline_link', 'book_act', 'drift_group',
  'entity_relation', 'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
];
const exemptions = [
  'New kv-entry IDs: the renderer KV authority mints uuidv7 while native mints host IDs, so its uuid import is replaced (scripts/apple-workspace-element-kv-ids.mjs) by the created kv-entry IDs of the native original in mutation order; each renderer step must drain exactly that queue.',
  'The use-case clock (new Date() in updateProject and updateNodeSummary, Date.now() in nextNodeUpdatedAt) and the project owner (useProject userId, the stored project.user_id) are injected; the renderer computes every fact reconciliation, order key, stamp, projection and wire byte itself.',
];
const localOnlyEffects = [
  'A facts- or template-only updateProject carries no project owner field: the authoring side stamps project.updated_at (native and the renderer use case alike) while a receiving reducer keeps the time of the project\'s UTF-8-last field register (here the summary edit). Tracked per row with exact values until an owner field re-stamps it.',
  'A status edit (updateNode) within the millisecond of the node\'s previous stamp floors updated_at at that stamp + 1 ms on the authoring side (native and the renderer alike) while a receiver stamps the winning HLC; when it occurs it is tracked per row with exact values.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences = [];
const reducerDefects = [
  'TS remote node stamps follow field-register order, not time: every remote apply re-materializes each field register of the reduced state in effect-id (UTF-8) order and each write stamps updated_at with that register\'s winning HLC, so a node ends at the time of its UTF-8-last field register. After a drift\'s summary edit later than its status edit (field:summary sorts before field:writingStatus), a receiver keeps the older status time while native and the renderer keep the summary time. Pinned per row with exact values.',
];
// Source-level native/renderer differences on paths these exports do not reach.
const unexportedDivergences = [
  'ProjectDashboard commits a facts or template edit as updateProject({ name, summary, kvJson, storylineTemplateKvJson }) with the current name, summary and other namespace, so its original also journals unchanged field.set name and field.set summary after the edited namespace (and rewrites the other projection without mutations); native journals only the edited namespace. Redundant unchanged field sets, not a divergent value.',
  'useProject.updateProject with nothing changed: a facts- or template-only call (such as the Agent update_project_facts tool merging facts that already hold) records no mutation, so its authored transaction throws; a call naming the summary or name journals it even when unchanged. Native returns the current project and writes nothing.',
  'useBookNode.updateNodeSummary has no unchanged guard: it journals field.set summary and stamps updated_at for the current summary. Its editor callers (ChapterEditor, NodeCardPopover) trim and skip unchanged summaries before calling; the Agent review accept path does not. Native writes nothing for an unchanged summary and stores the command string untrimmed.',
  'Receiver-only (TS reducer): emptying a KV namespace (facts or template set to []) purges every entry, but rebuildNormalizedProjections rebuilds only owners that still have rows, so a receiver keeps the stale kv_json / storyline_template_kv_json (storyline, element and category projections alike) while native and the renderer write []. Reproduced against the production reducer; not exported here.',
];
const boundaries = {
  source: 'Real native project summary/facts/storyline-template and chapter/drift summary/status commands over a synthetic file-backed workspace.',
  agreedGroups: [
    'Update the project in one command: edit one default fact\'s value, drop another, append a new fact, set a two-row storyline template (a row with a blank value is kept) and change the summary; the one original journals the facts (purge, field.set value, create, an order move for the appended run), then the template (creates, moves), then field.set summary. Reorder the facts last to first (one order.rebalance per entry and nothing else); facts, template and summary survive cold reopen.',
    'Set a chapter summary (a wall-clock stamp), set its status to finished (updateNode floors its stamp at the previous + 1 ms), set a drift to resting and edit its summary; each is one field.set on the node at its live incarnation.',
    'A receipt failure before the project update and before the chapter status leaves state intact and each retry writes exactly its canonical original; a status of the other kind, unknown nodes and unknown fields are refused, and unchanged status and project edits write nothing.',
  ],
  rendererParity: 'The renderer use cases (useProject.updateProject with the command\'s fields as UpdateProjectInput, useBookNode.updateNodeSummary, and the useEntityCellAction status path through useBookNode.updateNode and persistBookNodeUpdateWithSync) run through the production authored runner, including its production-kernel post-write validation, on each prior native database and author byte-identical originals, one per native original, with native kv-entry IDs and the use-case clock injected: identical journal, lifecycle, field-clock, order and writer rows and the same project (summary, fact and template projections, stamp), node and kv-entry rows. The production decoder, reducer transaction and repositories consume every native original in order without conflicts (chapter and drift statuses included); twenty-two tables match under the listed roles and pins, kv_json and storyline_template_kv_json project the KV authority on both roles, every mutation target, payload and order key equals an independent plan against the native after-state, each command changes exactly its fields and stamp, and the bridge result equals what the project and node repositories read back from both databases. Each comparison rejects a one-cell corruption. The committed fractional-indexing vectors equal the JavaScript package.',
  roleDifferences,
  excludedColumns: [],
  exemptions,
  localOnlyEffects,
  rendererDivergences,
  reducerDefects,
  unexportedDivergences,
  limitations: [
    'Native local project and node metadata commands; the TypeScript remote reducer is a compatibility oracle, not a native remote receive or provider transport claim.',
    'Unchanged edits, refusals and cold reopen are bridge- and core-test evidence; dropping fully blank fact rows (key and value blank under ECMAScript trim) and cloning the edited template into a new storyline are core-test evidence. Key renames (field.set key), same-slot reconciliation and emptying a namespace are not exported here.',
    'Project names, node titles and statuses authored outside these commands (Agent tools, drift conversion) and UI summary trimming (ChapterEditor and NodeCardPopover trim node summaries; ProjectPickerView and the mobile sheet trim project summaries, the dashboard does not) are not covered; native stores the command string as given.',
    'Synthetic in-process receipt failure and cold reopen; no SIGKILL, power loss, UI, physical device, cloud account or release acceptance.',
  ],
};
function sources() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
    .filter(name => name && existsSync(name) && (
      /^(?:crates\/|vendor\/yrs\/|drizzle\/|src\/renderer\/(?:sync|sqlite-repo|schema|domain)\/)/u.test(name)
      || [
        'scripts/apple-workspace-metadata-acceptance.mjs', 'scripts/apple-workspace-metadata-check.ts',
        'scripts/apple-workspace-element-kv-ids.mjs',
        'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
        'src/renderer/lib/db.ts', 'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
        'src/renderer/services/atomic-sync-transaction-tracker.ts',
        'src/renderer/hooks/useEntityCellAction.ts', 'src/renderer/views/ProjectDashboard.tsx',
        'src/renderer/usecase/useProject.ts', 'src/renderer/usecase/useBookNode.ts', 'src/renderer/usecase/book-node-write.ts',
        'src/renderer/usecase/normalized-kv-alias-authority.ts', 'src/renderer/usecase/sync-lifecycle-restore.ts',
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
  assert.equal(report.kind, 'native_metadata');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, sources(), 'Metadata evidence is stale; rerun its generator');
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
  const vectors = 'crates/drifting-core/tests/fixtures/fractional-indexing.json';
  assert.deepEqual(report.renderer.fractionalIndexing, { status: 'passed', cases: json(vectors).length,
    errors: json(vectors).filter(item => item[3] === 'ERR').length, fixtureSha256: sha(readFileSync(vectors)) });
  assert.deepEqual(report.renderer.cases.map(item => item.name), groups);
  for (const [index, item] of report.renderer.cases.entries()) {
    assert.equal(item.status, 'passed');
    assert.match(item.beforeDatabaseSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(item.steps.map(step => step.operation), operations[index]);
    let flooredSoFar = 0;
    for (const [stepIndex, step] of item.steps.entries()) {
      assert.equal(step.target, targets[index][stepIndex]);
      assert.deepEqual(step.originals.map(original => original.actions), actions[index][stepIndex]);
      for (const original of step.originals) {
        assert.match(original.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(original.mutationCount, original.actions.length);
      }
      assert.equal(step.incarnation, incarnations[index][stepIndex]);
      assert.equal(step.kvEntryIds, kvEntryIds[index][stepIndex]);
      assert.deepEqual(step.orderPlans, orderPlans[index][stepIndex]);
      const project = step.target === 'project';
      for (const check of ['localDomainWire', 'rendererAuthority', 'rendererRow', 'duplicate', 'command', 'result']) {
        assert.equal(step[check], 'passed');
      }
      assert.equal(step.factAuthority, project ? 'passed' : null);
      assert.equal(step.proseOwners, 'unchanged');
      assert.equal(step.faultRollback, faults[index][stepIndex]);
      assert.equal(typeof step.flooredStamp, 'boolean');
      assert(!step.flooredStamp || step.operation === 'setNodeStatus', 'Only a status edit floors its stamp');
      if (step.flooredStamp) flooredSoFar += 1;
      // A floored status (timing-dependent) holds a receiver stamp until its node is re-stamped.
      const { floor } = step.receiverStamps;
      assert(Number.isInteger(floor) && floor >= 0 && floor <= flooredSoFar);
      assert.deepEqual(step.receiverStamps, { project: projectStamps[index][stepIndex],
        registerOrder: registerOrderStamps[index][stepIndex], floor });
      const heldNodes = step.receiverStamps.registerOrder + floor > 0 ? ['book_node.updated_at'] : [];
      const heldProject = step.receiverStamps.project > 0 ? ['project.updated_at'] : [];
      assert.deepEqual(step.pinnedCells, [...heldNodes, ...heldProject]);
      assert.deepEqual(step.nonVacuity, { original: 'rejected', rendererRow: 'rejected', table: 'rejected', result: 'rejected',
        factAuthority: project ? 'rejected' : null });
      assert.match(step.afterDatabaseSha256, /^[a-f0-9]{64}$/u);
      assert.equal(step.documents.length, 3, 'Two chapter bodies and the drift body stay untouched');
      for (const document of step.documents) {
        assert.equal(document.documentId, 'node-content:<id>');
        assert.match(document.stateSha256, /^[a-f0-9]{64}$/u);
      }
      assert.deepEqual(step.tables.map(table => table.table), expectedTables);
      for (const table of step.tables) {
        assert(Number.isInteger(table.rows) && table.rows >= 0);
        assert.match(table.sha256, /^[a-f0-9]{64}$/u);
      }
    }
  }
  assert(Array.isArray(report.rawEvidence));
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/metadata-acceptance-[A-Za-z0-9]+\/[^/]+$/u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  for (const name of ['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-metadata-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log']) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${name}`)), `Missing raw evidence ${name}`);
  }
}
if (process.argv.includes('--check')) {
  validate(json(output));
  console.log('Native metadata evidence is current.');
} else {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/metadata-acceptance-');
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
      { NATIVE_WORKSPACE_METADATA_EXPORT_DIR: path.resolve(directory) });
    const cases = [...log.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
    assert.deepEqual([...cases].sort(), [...spec.required].sort());
    return { name: spec.name, passed: cases.length, failed: 0, cases, logSha256: sha(log) };
  });
  const wire = { schemaVersion: 1, cases: groups.map(name => {
    const item = json(`${directory}/${name}.json`);
    assert.equal(item.name, name);
    return item;
  }) };
  writeFileSync(`${directory}/workspace-metadata-wire.json`, `${JSON.stringify(wire, null, 2)}\n`);
  run('renderer', 'pnpm', ['exec', 'tsx', '--conditions=import', '--import=./scripts/apple-workspace-element-kv-ids.mjs',
    'scripts/apple-workspace-metadata-check.ts',
    `--input=${directory}/workspace-metadata-wire.json`, `--output=${directory}/renderer.json`]);
  const config = `${directory}/tsconfig.json`;
  writeFileSync(config, `${JSON.stringify({ extends: path.resolve('tsconfig.json'), include: [],
    compilerOptions: { strict: true, noEmit: true },
    files: [path.resolve('scripts/apple-workspace-metadata-check.ts'),
      ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.resolve('src/renderer', name))],
  }, null, 2)}\n`);
  run('typecheck', 'pnpm', ['exec', 'tsc', '--project', config]);
  assert.deepEqual(sources(), before, 'Metadata source changed during acceptance');
  const names = [...new Set(['source-before.json', 'rustc.log', 'cargo.log', ...specs.map(spec => `${spec.name}.log`),
    'workspace-metadata-wire.json', 'renderer.json', 'renderer.log', 'typecheck.log',
    ...groups.map(name => `${name}.json`),
    ...wire.cases.flatMap(item => [item.beforeDatabase, ...item.steps.map(step => step.afterDatabase)])])];
  const report = { schemaVersion: 1, kind: 'native_metadata', status: 'passed',
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
