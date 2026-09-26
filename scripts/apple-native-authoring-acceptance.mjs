import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const option = name => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const output = path.resolve(root, option('--output') ?? 'docs/apple-native/acceptance/native-authoring.json');
const read = name => readFileSync(path.resolve(root, name));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = name => JSON.parse(read(name));
const walk = dir => readdirSync(path.resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
  const name = `${dir}/${entry.name}`;
  return entry.name === 'target' ? [] : entry.isDirectory() ? walk(name) : entry.isFile() ? [name] : [];
});
const scriptNames = ['apple-native-authoring-acceptance.mjs', 'apple-native-event-order-oracle.ts', 'apple-native-journal-oracle.ts', 'apple-native-journal-wire-check.ts', 'apple-native-authoring-wire-check.ts'];
const rendererSpecs = [
  { file: 'src/renderer/lib/db.test.ts', count: 10 },
  { file: 'src/renderer/services/snapshot-restore-sync-boundary.acceptance.test.ts', count: 2 },
  { file: 'src/renderer/sync/journal/yjs-materialization.integration.test.ts', count: 14 },
  { file: 'src/renderer/sync/journal/yjs-update.integration.test.ts', count: 15 },
  { file: 'src/renderer/sync/reducer/production-domain-kernel.integration.test.ts', count: 27 },
  { file: 'src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.integration.test.ts', count: 12 },
];
function manifest() {
  return [...new Set([
    ...scriptNames.map(name => `scripts/${name}`),
    ...['drifting-core', 'drifting-document', 'drifting-prose', 'drifting-apple-bridge'].flatMap(name => walk(`crates/${name}`).filter(p => /\.(rs|json|toml|lock)$/u.test(p))),
    ...walk('vendor/yrs').filter(p => /\.(rs|toml|lock)$/u.test(p)), ...walk('drizzle'), ...walk('docs/apple-native/fixtures'),
    ...['src/renderer/sync', 'src/renderer/sqlite-repo', 'src/renderer/schema'].flatMap(walk),
    ...rendererSpecs.map(spec => spec.file),
    'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-doc-id.ts',
    'src/renderer/platform/database.ts', 'src/renderer/platform/database-recovery-store.ts',
    'src/renderer/lib/agent/runtime/yjs-prose-persistence-coordinator.ts',
    'src/renderer/lib/agent/runtime/yjs-prose-command.ts',
    'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
    'src/renderer/services/snapshot-restore.service.ts',
    'src/renderer/services/yjs-transaction-evidence.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
    'vitest.config.ts', 'vitest.shared.ts',
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'src/renderer/vite-env.d.ts', 'src/renderer/global.d.ts', 'src/renderer/deferred-settings.d.ts', 'src/renderer/deferred-super-views.d.ts',
  ])].sort().map(name => ({ path: name, sha256: sha(read(name)) }));
}
const specs = [
  { name: 'core', crate: 'drifting-core', required: [
    'original_operation::tests::original_operation_preserves_actual_native_events_and_accepts_all_client_group_orders',
    'original_operation::tests::original_operation_exact_event_parser_still_rejects_malformed_complete_hashed_envelopes',
    'native_journal_optional_evidence_roundtrips_file_original_and_archive_and_exports_real_wire',
    'native_journal_rejects_exact_event_and_schema_mismatches_without_advancing_writer_or_revision',
    'native_journal_nested_evidence_rejection_and_receipt_failure_rollback_preserve_outer_work',
    'native_journal_limits_optional_evidence_before_large_encoding_and_keeps_default_append_unchanged',
    'materialization_admission::tests::materialization_native_journal_records_actual_append_and_survives_prune_cold',
    'materialization_admission::tests::materialization_native_admission_failure_rolls_back_writer_revision_and_journal',
    'materialization_admission::tests::materialization_reader_refuses_missing_forged_and_mismatched_raw_without_writes',
    'materialization_admission::tests::materialization_receipts_are_immutable_and_equal_events_do_not_share_identity',
  ] },
  { name: 'document', crate: 'drifting-document', required: [
    'native_command_tests::native_command_captures_actual_chinese_emoji_and_multiple_source_items',
    'native_command_tests::native_command_does_not_classify_noop_insert_replace_structure_or_private_primitive',
    'native_command_tests::native_command_rejections_leave_bytes_history_and_capture_unchanged',
    'native_command_tests::native_command_history_is_raw_and_preserves_existing_local_undo_units',
    'native_command_tests::native_command_origin_is_removed_after_success_and_scope_drop_retains_only_raw_bytes',
    'native_command_tests::native_command_multiple_or_foreign_events_disqualify_without_dropping_authored_bytes',
    'native_command_tests::native_command_observers_cannot_open_a_nested_write_transaction',
    'native_command_tests::native_command_basis_includes_preexisting_deletions_but_event_does_not_reemit_them',
    'native_command_tests::native_command_mutable_after_transaction_expansion_never_inherits_delete_intent',
    'draft_evidence_tests::queued_evidence_rebuilds_live_snapshot_offset_and_cross_client_emoji_ids_after_prefix_insert',
    'draft_evidence_tests::queued_evidence_excludes_already_remote_deleted_ids_and_never_undoes_remote_deletion',
    'draft_evidence_tests::queued_evidence_interior_remote_insertion_stays_raw_without_deleting_or_claiming_remote_text',
    'draft_evidence_tests::queued_evidence_all_remote_deleted_produces_no_event_but_consumes_successful_sequence_once',
    'draft_evidence_tests::queued_evidence_rapid_followup_uses_visible_branch_ids_and_distinct_live_bases',
    'draft_evidence_tests::queued_evidence_failed_sequence_selection_and_half_emoji_leave_live_and_capture_unchanged',
    'draft_evidence_tests::queued_evidence_insert_replace_structural_and_remote_format_changes_are_unclassified',
  ] },
  { name: 'prose', crate: 'drifting-prose', required: [
    'native_persistence::native_delete_record_survives_projection_failure_and_later_input_before_retry',
    'native_persistence::sequential_native_declarations_rollback_as_one_batch_without_sequence_holes',
    'native_persistence::actual_native_multiclient_deletion_keeps_exact_event_through_original_store',
    'native_persistence::native_history_and_generic_delete_do_not_gain_standalone_command_intent',
    'native_persistence::queued_and_draft_commands_persist_live_basis_without_deleting_remote_insertions',
    'native_persistence::native_captured_deletion_refuses_changed_incarnation_without_losing_record',
    'native_persistence::native_captured_deletion_rechecks_scope_after_projection_callback_and_retries',
    'native_persistence::unscoped_native_deletion_refuses_persistence_and_retains_complete_record_after_later_input',
    'native_persistence::review_scoped_plain_replay_refuses_changed_incarnation_before_live_or_coverage_changes',
  ] },
  { name: 'bridge', crate: 'drifting-apple-bridge', required: ['tests::native_lab_scoped_deletion_persists_original_for_current_incarnation_and_cold_reopen'] },
];
const boundaries = [
  'Accepts actual native command capture, queued live-basis transformation and whole-record journal persistence with immutable original verification, file-backed rollback/retry and scoped lifecycle checks.',
  'Exact Yrs event bytes are preserved; delete-client groups may be in any order, while minimal varuint, complete consumption, duplicate-client, range overlap and declared-range checks remain enforced.',
  'NativeLab opens with a complete current scope and revalidates it before persistence; unscoped captured deletion is retained and rejected, never downgraded to an unclassified payload.',
  'Rust and renderer writers record positive local materialization in the append transaction. Renderer append tokens are bound to the innermost active transaction and exact original; rolled-back or same-bytes foreign originals cannot borrow them. No historical admission is backfilled.',
  'Renderer tests cover journal, reducer, Agent persistence, transaction/savepoint behavior and source-level snapshot service wiring; they do not establish live editor reconciliation or performance.',
  'Unsupported noncontiguous/structural/formatted intent remains raw; this evidence does not certify generic deletion intent, semantic alias deletion routing, receiver authority or capability negotiation.',
  'No OriginalAtomicOwner, isolated semantic authority module, provider/account, UI event synthesis, physical device, signing or release acceptance is included. Actual process-kill evidence is generated by its separate durability runner.',
];
function validate(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'passed');
  assert.deepEqual(report.source.files, manifest()); assert.equal(report.source.fingerprint, sha(JSON.stringify(report.source.files)));
  const version = /^rustc (\d+)\.(\d+)\./u.exec(report.toolchain.rustc);
  assert(version && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 96), 'Rust 1.96 or newer is required');
  assert.match(report.toolchain.cargo, /^cargo \d+\.\d+\./u);
  assert(Array.isArray(report.rawEvidence) && report.rawEvidence.length >= 25);
  const evidencePaths = new Set();
  for (const item of report.rawEvidence) {
    assert.match(item.path, /^\.local-data\/apple-native\/authoring-\d+\//u);
    assert.equal(path.posix.normalize(item.path), item.path);
    assert(!item.path.includes('..') && !item.path.includes('\\'));
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
    assert(!evidencePaths.has(item.path)); evidencePaths.add(item.path);
  }
  for (const required of ['rustc.log', 'cargo.log', 'journal-wire.json', 'journal-wire-result.json', 'native-wire-result.json', 'native-wire/native-plain.json', 'native-wire/native-multiclient.json', 'native-wire/native-queued.json', 'native-wire/native-draft.json', ...specs.map(spec => `${spec.name}.log`)]) {
    assert(report.rawEvidence.some(item => item.path.endsWith(`/${required}`)), `Missing evidence ${required}`);
  }
  assert.deepEqual(report.boundaries, boundaries); assert.equal(report.suites.length, specs.length);
  for (const spec of specs) {
    const suite = report.suites.find(item => item.name === spec.name); assert(suite);
    // Every listed test ran and passed; the count follows the crate itself.
    assert(suite.listed > 0); assert.equal(suite.passed, suite.listed); assert.equal(suite.failed, 0); assert.equal(suite.toolchain, report.toolchain.rustc);
    assert.equal(suite.cases.length, suite.listed); assert.equal(new Set(suite.cases).size, suite.listed);
    for (const name of spec.required) assert(suite.cases.includes(name), `Missing ${name}`);
  }
  assert.equal(report.rendererMaterialization.length, rendererSpecs.length);
  for (const spec of rendererSpecs) {
    const suite = report.rendererMaterialization.find(item => item.file === spec.file);
    assert(suite); assert.equal(suite.passed, spec.count); assert.equal(suite.failed, 0);
    assert.equal(suite.cases.length, spec.count); assert.equal(new Set(suite.cases).size, spec.count);
  }
  assert(report.rawEvidence.some(item => item.path.endsWith('/renderer.json')));
  assert.deepEqual(report.checks, { normalLibraries: true, strictTypeScript: true, rustfmt: true, eventOrderFixtures: { accepted: 11, rejected: 21, actualNativeEvents: 4 }, journalWireCases: 3, nativeWireCases: 4 });
}
if (process.argv.includes('--check')) {
  validate(json(output)); console.log(JSON.stringify({ status: 'passed', check: true, suites: specs.length })); process.exit(0);
}
const work = path.resolve(root, `.local-data/apple-native/authoring-${Date.now()}`);
mkdirSync(work, { recursive: true });
function run(name, command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 48 * 1024 * 1024, env: { ...process.env, ...extraEnv } });
  writeFileSync(path.join(work, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, `${name}: ${(result.stdout + result.stderr).slice(-10000)}`);
  return result.stdout;
}
const before = manifest();
const toolchain = { rustc: run('rustc', 'rustc', ['--version']).trim(), cargo: run('cargo', 'cargo', ['--version']).trim() };
run('event-order', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-native-event-order-oracle.ts', '--check']);
run('journal-fixture', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-native-journal-oracle.ts', '--check']);
const suites = [];
const wireDir = path.join(work, 'native-wire'); mkdirSync(wireDir);
for (const spec of specs) {
  const manifestPath = `crates/${spec.crate}/Cargo.toml`;
  run(`${spec.name}-check`, 'cargo', ['check', '--locked', '--lib', '--manifest-path', manifestPath]);
  run(`${spec.name}-fmt`, 'cargo', ['fmt', '--check', '--manifest-path', manifestPath]);
  const stdout = run(spec.name, 'cargo', ['test', '--locked', '--manifest-path', manifestPath], {
    NATIVE_JOURNAL_WIRE_OUTPUT: path.join(work, 'journal-wire.json'), NATIVE_AUTHORING_WIRE_DIR: wireDir,
  });
  const cases = [...stdout.matchAll(/^test (\S+) \.\.\. ok$/gmu)].map(match => match[1]);
  const listed = [...run(`${spec.name}-list`, 'cargo', ['test', '--locked', '--manifest-path', manifestPath, '--', '--list'])
    .matchAll(/^(\S+): test$/gmu)].length;
  assert.equal(cases.length, listed, `${spec.name} test count`); for (const name of spec.required) assert(cases.includes(name), name);
  suites.push({ name: spec.name, toolchain: toolchain.rustc, listed, passed: cases.length, failed: 0, cases, outputSha256: sha(stdout) });
}
run('journal-wire', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-native-journal-wire-check.ts', `--input=${path.join(work, 'journal-wire.json')}`, `--output=${path.join(work, 'journal-wire-result.json')}`]);
run('native-wire', 'pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-native-authoring-wire-check.ts', `--input=${wireDir}`, `--output=${path.join(work, 'native-wire-result.json')}`]);
assert.equal(json(path.join(work, 'journal-wire-result.json')).cases.length, 3); assert.equal(json(path.join(work, 'native-wire-result.json')).cases.length, 4);
const tsconfig = path.join(work, 'tsconfig.json');
writeFileSync(tsconfig, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: [], compilerOptions: { strict: true, noEmit: true }, files: [...scriptNames.filter(name => name.endsWith('.ts')).map(name => path.join(root, 'scripts', name)), ...['vite-env.d.ts', 'global.d.ts', 'deferred-settings.d.ts', 'deferred-super-views.d.ts'].map(name => path.join(root, 'src/renderer', name))] }, null, 2));
run('typecheck', 'pnpm', ['exec', 'tsc', '--project', tsconfig]);
run('renderer', 'pnpm', ['exec', 'vitest', 'run', ...rendererSpecs.map(spec => spec.file),
  '--maxWorkers=2', '--reporter=json', `--outputFile=${path.join(work, 'renderer.json')}`]);
const renderer = json(path.join(work, 'renderer.json'));
assert.equal(renderer.numFailedTests, 0); assert.equal(renderer.numPendingTests, 0);
const rendererMaterialization = rendererSpecs.map(spec => {
  const suite = renderer.testResults.find(item => path.resolve(item.name) === path.resolve(root, spec.file));
  assert(suite, spec.file); assert.equal(suite.assertionResults.length, spec.count);
  for (const test of suite.assertionResults) assert.equal(test.status, 'passed', test.fullName);
  return { file: spec.file, passed: spec.count, failed: 0, cases: suite.assertionResults.map(test => test.fullName) };
});
assert.deepEqual(manifest(), before, 'Source changed while acceptance was running');
const rawEvidence = walk(path.relative(root, work).split(path.sep).join('/')).sort().map(name => ({ path: name, sha256: sha(read(name)) }));
const report = { schemaVersion: 1, status: 'passed', toolchain, rawEvidence, source: { fingerprint: sha(JSON.stringify(before)), files: before }, suites, rendererMaterialization,
  checks: { normalLibraries: true, strictTypeScript: true, rustfmt: true, eventOrderFixtures: { accepted: 11, rejected: 21, actualNativeEvents: 4 }, journalWireCases: 3, nativeWireCases: 4 }, boundaries };
validate(report); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: 'passed', tests: suites.reduce((sum, suite) => sum + suite.passed, 0), rendererTests: rendererMaterialization.reduce((sum, suite) => sum + suite.passed, 0), sourceFingerprint: report.source.fingerprint }));
