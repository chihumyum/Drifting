// Native original-byte/declaration verification, optional journal evidence and
// the read-only SQLite body archive.
// This does not enable semantic deletion, authorize writers, or accept a UI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const script = 'scripts/apple-original-operation-acceptance.mjs';
const output = 'docs/apple-native/acceptance/original-operation.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const decoderNames = [
  'accepts_real_ts_envelopes_and_returns_all_exact_materialized_rows',
  'rejects_ts_binding_schema_hash_versions_and_unclassified_event_corpus',
  'complete_canonical_value_model_matches_production_cborg',
  'bounds_envelope_before_decode_and_owns_selected_bytes',
  'yjs_snapshot_and_event_readers_fail_closed_without_allocating_claimed_collections',
  'rejects_hashed_event_trailing_bytes_that_ts_update_decoder_ignores',
  'preserves_actual_native_events_and_accepts_all_client_group_orders',
  'exact_event_parser_still_rejects_malformed_complete_hashed_envelopes',
].map(name => `original_operation::tests::original_operation_${name}`);
const storeNames = [
  'reads_actual_single_and_multi_operation_without_side_effects',
  'verifies_unselected_mutation_target_action_payload_and_complete_indices',
  'verifies_envelope_header_and_refuses_unaccepted_originals',
  'wrong_reference_and_missing_original_release_own_read_transaction',
  'reads_one_wal_snapshot_while_another_connection_commits',
  'refuses_oversize_envelope_and_row_blobs_before_copying_them',
  'refuses_rehashed_companion_insert_with_published_guards_intact',
  'never_uses_a_foreign_gateway_transaction',
  'requires_an_actual_matching_apply_receipt',
  'leaves_callers_work_intact_after_success_and_failure',
  'limits_corrupt_text_cells_before_gateway_allocation',
].map(name => `original_operation_store::tests::original_store_${name}`);
const archiveNames = [
  'archive_generic_envelope_layer_does_not_claim_standalone_deletion_intent',
  'archive_collects_real_seed_insert_delete_originals_and_reopens_without_intent_for_bodies',
  'archive_canonical_discovery_rejects_hidden_target_and_unselected_row_tampering',
  'archive_requires_applied_receipt_original_bytes_scope_and_known_references',
  'archive_reads_one_wal_snapshot_across_original_and_all_materialized_rows',
  'archive_bounds_reads_before_copy_and_leaves_caller_transaction_intact',
].map(name => `original_body_archive::tests::${name}`);
const journalNames = [
  'native_journal_optional_evidence_roundtrips_file_original_and_archive_and_exports_real_wire',
  'native_journal_rejects_exact_event_and_schema_mismatches_without_advancing_writer_or_revision',
  'native_journal_nested_evidence_rejection_and_receipt_failure_rollback_preserve_outer_work',
  'native_journal_limits_optional_evidence_before_large_encoding_and_keeps_default_append_unchanged',
];
const admissionNames = [
  'materialization_native_journal_records_actual_append_and_survives_prune_cold',
  'materialization_native_admission_failure_rolls_back_writer_revision_and_journal',
  'materialization_reader_refuses_missing_forged_and_mismatched_raw_without_writes',
  'materialization_receipts_are_immutable_and_equal_events_do_not_share_identity',
].map(name => `materialization_admission::tests::${name}`);
const requiredCases = [...decoderNames, ...storeNames, ...archiveNames, ...journalNames, ...admissionNames];
const expectedTests = 66;
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
function sources() {
  const files = [...new Set(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
    .filter(file => file && existsSync(file) && (
      /^(?:crates\/drifting-core\/|crates\/drifting-document\/|vendor\/yrs\/|drizzle\/|src\/renderer\/sync\/protocol\/)/u.test(file)
      || [script, 'scripts/apple-original-operation-oracle.ts', 'scripts/apple-original-body-archive-oracle.ts',
        'scripts/apple-native-event-order-oracle.ts', 'scripts/apple-native-journal-oracle.ts',
        'src/renderer/services/yjs-transaction-evidence.ts', 'src/renderer/lib/yjs-persistence-origin.ts',
        'docs/apple-native/fixtures/prose-journal-v1.json', 'package.json', 'pnpm-lock.yaml'].includes(file)
    )).sort();
  return files.map(path => ({ path, sha256: hash(readFileSync(path)) }));
}
function fixtureCounts() {
  const fixture = JSON.parse(readFileSync('crates/drifting-core/tests/fixtures/original-operation.json', 'utf8'));
  const counts = { validEnvelopes: fixture.positives.length, invalidEnvelopes: fixture.negatives.length,
    canonicalValues: fixture.cbor.length, strictEventByteCases: fixture.strictBoundaries.length };
  assert.deepEqual(counts, { validEnvelopes: 8, invalidEnvelopes: 49, canonicalValues: 52, strictEventByteCases: 1 });
  const store = JSON.parse(readFileSync('crates/drifting-core/src/original_operation_store/fixtures.json', 'utf8'));
  assert.deepEqual(store.map(item => [item.name, item.mutations.length]), [['single', 1], ['multiple', 2]]);
  const archive = JSON.parse(readFileSync('crates/drifting-core/tests/fixtures/original-body-archive.json', 'utf8'));
  assert.equal(archive.synthetic, true);
  const bodyArchive = {
    originals: archive.originalOperations.length,
    mutations: archive.originalOperations.reduce((sum, entry) => sum + entry.mutations.length, 0),
    targetBodies: archive.targetUpdateBase64.length,
  };
  assert.deepEqual(bodyArchive, { originals: 4, mutations: 5, targetBodies: 3 });
  const events = JSON.parse(readFileSync('crates/drifting-core/tests/fixtures/event-order.json', 'utf8'));
  const eventOrder = { accepted: events.cases.filter(entry => entry.accepted).length,
    rejected: events.cases.filter(entry => !entry.accepted).length };
  assert.deepEqual(eventOrder, { accepted: 11, rejected: 21 });
  const journal = JSON.parse(readFileSync('crates/drifting-core/tests/fixtures/native-journal-evidence.json', 'utf8'));
  assert.equal(journal.cases.length, 3);
  return { ...counts, bodyArchive, eventOrder, journalEvidence: { cases: journal.cases.length } };
}
function validateReport(report) {
  assert.equal(report.kind, 'native_original_operation_verification');
  assert.equal(report.status, 'passed');
  assert.equal(report.productionSemanticDeletionEnabled, false);
  assert.deepEqual(report.source.files, sources(), 'Original-operation evidence is stale; regenerate it');
  assert.equal(report.source.fingerprint, hash(JSON.stringify(report.source.files)));
  assert.deepEqual(report.fixtureCases, fixtureCounts());
  assert.deepEqual(report.tests.requiredCases, requiredCases);
  assert.deepEqual([report.tests.passed, report.tests.failed, report.tests.ignored], [expectedTests, 0, 0]);
  assert.equal(report.tests.rustToolchain, '1.88.0');
  assert.match(report.tests.logSha256, /^[0-9a-f]{64}$/u);
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  validateReport(report);
  console.log(`Native original-operation evidence is current: ${expectedTests} core tests, ${report.source.files.length} inputs.`);
} else {
  const oracle = JSON.parse(run('pnpm', ['exec', 'tsx', '--conditions=import',
    'scripts/apple-original-operation-oracle.ts', '--check']).trim());
  assert.equal(oracle.positive, 8);
  const archiveOracle = JSON.parse(run('pnpm', ['exec', 'tsx', '--conditions=import',
    'scripts/apple-original-body-archive-oracle.ts', '--check']).trim());
  assert.equal(archiveOracle.status, 'passed');
  assert.equal(archiveOracle.targetBodies, 3);
  run('pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-native-event-order-oracle.ts', '--check']);
  run('pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-native-journal-oracle.ts', '--check']);
  const before = sources();
  mkdirSync('.local-data/apple-native', { recursive: true });
  const directory = mkdtempSync('.local-data/apple-native/original-operation-acceptance-');
  writeFileSync(path.join(directory, 'source-before.json'), JSON.stringify(before, null, 2) + '\n');
  const result = spawnSync('cargo', ['+1.88.0', 'test', '--manifest-path', 'crates/drifting-core/Cargo.toml', '--locked'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(path.join(directory, 'core.log'), log);
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, log.slice(-8000));
  const testCounts = [...log.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/gu)].map(match => {
    assert.equal(match[2], '0'); assert.equal(match[3], '0'); return Number(match[1]);
  });
  assert.deepEqual(testCounts, [62, 4, 0]);
  for (const name of requiredCases) assert(log.includes(`test ${name} ... ok`), `Missing case: ${name}`);
  assert.deepEqual(sources(), before, 'Source changed during original-operation acceptance');
  const report = { schemaVersion: 1, kind: 'native_original_operation_verification', status: 'passed',
    productionSemanticDeletionEnabled: false,
    source: { fingerprint: hash(JSON.stringify(before)), files: before },
    fixtureCases: fixtureCounts(),
    tests: { rustToolchain: '1.88.0', passed: expectedTests, failed: 0, ignored: 0,
      requiredCases, logSha256: hash(log) },
    scope: [
      'Canonical original envelope and every mutation schema, payload hash and full selected reference',
      'Exact declared pure-deletion event bytes and causal snapshot syntax; no higher-level command classifier',
      'One SQLite snapshot for original bytes, matching application receipt and all materialized mutation rows',
      'Rehashed sibling substitution, missing or extra rows, wrong references and unaccepted originals refuse without writes',
      'WAL snapshot consistency, caller-owned transaction preservation and bounded SQLite cells',
      'Canonical originals identify same-scope body events independently of mutable target indices',
      'Read-only seed, insert and deletion collection verifies generation catalog, original receipts and every sibling row',
      'Missing required originals, forged target indices, absent receipts and exceeded local collection budgets refuse',
      'Legal Yjs/Yrs event client orders preserve exact bytes; complete parsing rejects malformed, duplicate and trailing data',
      'Optional native journal declarations bind exact events to canonical originals and roll back rejected evidence without advancing writer sequence',
      'The default journal payload remains byte-compatible; actual command capture and scoped owner behavior have a separate authoring report',
      'Positive materialization receipts bind actual journal appends, survive raw compaction, and remain distinct for equal events in different originals',
      'Receipt failure rolls back the native append and writer sequence; missing historical admission is never backfilled',
    ],
    limits: {
      sourceVisibility: 'not-established-by-this-reader', writerIdentity: 'not-authenticated-by-hashes',
      liveDeletionAuthority: 'not-enabled', durableAuthorityCommit: 'not-implemented', capabilityRollout: 'not-implemented',
      retainedCollectionCompleteness: 'not-established', lostOrGarbageCollectedBodyRecovery: 'not-implemented',
      archiveReadBudgets: { envelopes: 4096, aggregateBytes: 64 * 1024 * 1024, envelopeBytes: 16 * 1024 * 1024 },
      simulator: 'not-run-by-this-report', physicalInput: 'not-run', device: 'not-run', account: 'not-run', distribution: 'not-run',
    },
  };
  validateReport(report);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, tests: expectedTests, fingerprint: report.source.fingerprint, rawEvidence: directory }));
}
