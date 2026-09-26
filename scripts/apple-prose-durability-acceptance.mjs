import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

// The native worker stops inside the real Rust persistence path. The parent
// waits for its flushed marker, SIGKILLs it, then starts independent readers.
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const boundaries = [
  'authored-before-commit', 'authored-after-commit',
  'remote-committed-before-replay', 'replay-applied-before-coverage',
  'checkpoint-after-snapshot', 'checkpoint-after-prune', 'checkpoint-after-commit',
  'local-n-plus-two-before-replay', 'local-n-plus-two-after-checkpoint',
];
const checks = ['prose', 'anchors', 'revision', 'journal', 'receipt', 'covered-tail', 'isolation', 'integrity', 'foreign-keys'];
const blockedBoundaries = ['blocked-remote-before-commit', 'blocked-remote-after-commit', 'blocked-remote-after-replay-rejection'];
const blockedChecks = ['raw-update-retention', 'open-disposition', 'covered-tail', 'snapshot-retention',
  'receipt-not-created', 'isolation', 'integrity', 'foreign-keys'];
const repairBoundaries = ['repair-before-commit', 'repair-after-commit', 'repair-after-live-replay'];
const repairChecks = ['raw-update-retention', 'derived-system-journal', 'snapshot-coverage', 'comment-cas',
  'retry-no-duplicate', 'covered-tail', 'no-user-undo', 'no-remote-frontier', 'isolation', 'integrity', 'foreign-keys'];
const nativeDeletionBoundaries = [
  'native-delete-authored-before-commit', 'native-delete-authored-after-commit',
  'native-delete-checkpoint-after-snapshot', 'native-delete-checkpoint-after-prune',
  'native-delete-checkpoint-after-commit',
];
const nativeDeletionChecks = ['prose', 'safe-comment', 'native-command-declaration', 'exact-update',
  'original-envelope', 'body-archive', 'revision', 'journal-receipt', 'covered-tail', 'isolation', 'integrity', 'foreign-keys'];
const requiredOwnerTests = [
  'native_persistence::native_delete_record_survives_projection_failure_and_later_input_before_retry',
  'native_persistence::sequential_native_declarations_rollback_as_one_batch_without_sequence_holes',
  'native_persistence::actual_native_multiclient_deletion_keeps_exact_event_through_original_store',
  'native_persistence::native_history_and_generic_delete_do_not_gain_standalone_command_intent',
  'native_persistence::queued_and_draft_commands_persist_live_basis_without_deleting_remote_insertions',
  'native_persistence::native_captured_deletion_refuses_changed_incarnation_without_losing_record',
  'native_persistence::native_captured_deletion_rechecks_scope_after_projection_callback_and_retries',
  'native_persistence::unscoped_native_deletion_refuses_persistence_and_retains_complete_record_after_later_input',
  'native_persistence::review_scoped_plain_replay_refuses_changed_incarnation_before_live_or_coverage_changes',

  'mixed_same_writer_prefix_and_safe_suffix_repair_journals_once_and_survives_history_reopen',
  'safe_clock_gap_between_original_prefix_inserts_preserves_two_history_cycles_and_cold_replay',
  'safe_clock_gap_pending_last_prefix_survives_checkpoint_prune_cold_open_and_dependency_comment_cas',
  'lookahead_releases_first_retained_row_only_after_complete_durable_dependency_and_replays_actual_gapped_ids',
  'lookahead_cold_recovery_uses_stored_full_closure_without_duplicate_system_journal',
  'lookahead_malformed_formatted_and_still_pending_tail_members_reject_the_entire_candidate',
  'lookahead_comment_cas_rollback_preserves_raw_receipts_live_state_and_retry',
  'lookahead_preceding_safe_step_and_pending_local_event_commit_with_one_basis_and_local_only_undo',
  'lookahead_committed_snapshot_survives_interrupt_before_live_apply_without_repair_echo',
  'lookahead_explicit_cancellation_without_derived_repair_remains_atomically_retained_by_owner_scope',
];
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? 'docs/apple-native/acceptance/p2c-durability.json';
const smoke = process.argv.includes('--smoke');
const worker = path.resolve('crates/drifting-prose/target/debug/examples/durability-worker');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
function fingerprint() {
  const files = [...new Set(command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
    .filter((file) => file && existsSync(file) && (
      /^(?:crates\/(?:drifting-core|drifting-document|drifting-prose)\/|vendor\/yrs\/|drizzle\/|docs\/apple-native\/fixtures\/|src\/renderer\/sync\/(?:journal|protocol)\/)/u.test(file)
      || ['scripts/apple-prose-journal-oracle.ts', 'scripts/apple-prose-durability-acceptance.mjs',
        'src/renderer/sqlite-repo/yjs-repo.ts', 'src/renderer/lib/yjs-doc-id.ts', 'src/renderer/schema/drizzle.ts',
        'src/renderer/services/yjs-document-session.ts', 'src/renderer/services/yjs-local-durability.service.ts',
        'package.json', 'pnpm-lock.yaml'].includes(file)))
    .sort();
  return hash(JSON.stringify(files.map((file) => ({ path: file, sha256: hash(readFileSync(file)) }))));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    if (result.marks) result.marks.sort((left, right) => left.type.localeCompare(right.type, 'en'));
    return result;
  }
  return value;
}

function verifyYjs(restart) {
  assert.equal(typeof restart.details?.updateBase64, 'string', 'Rust worker omitted recovered update bytes');
  assert(restart.details.semantic && typeof restart.details.semantic === 'object', 'Rust worker omitted recovered semantic projection');
  const update = Buffer.from(restart.details.updateBase64, 'base64');
  assert.equal(update.toString('base64'), restart.details.updateBase64, 'Rust worker emitted noncanonical base64');
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, update);
    const semantic = canonical(yDocToProsemirrorJSON(document, 'default'));
    assert.deepEqual(semantic, canonical(restart.details.semantic), 'Yjs disagrees with recovered Rust semantic projection');
    const vector = Y.encodeStateVector(document);
    Y.applyUpdate(document, update);
    assert.deepEqual(Y.encodeStateVector(document), vector, 'Repeated recovered update changed the Yjs clock');
    assert.deepEqual(canonical(yDocToProsemirrorJSON(document, 'default')), semantic, 'Repeated recovered update changed Yjs prose');
    return { implementation: 'Yjs', semanticHash: hash(JSON.stringify(semantic)), duplicateReplay: 'passed' };
  } finally { document.destroy(); }
}

function blockedFixture(styled = true) {
  const document = new Y.Doc();
  document.clientID = 46101;
  for (const [id, paragraphs] of [['left', [['b', '潮汐']]], ['right', [['c', '夜航'], ['d', '终章']]]]) {
    const quote = new Y.XmlElement('blockquote');
    quote.setAttribute('id', id);
    const children = [];
    for (const [blockId, content] of paragraphs) {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.setAttribute('id', blockId);
      const text = new Y.XmlText(); text.insert(0, content);
      paragraph.insert(0, [text]); children.push(paragraph);
    }
    quote.insert(0, children);
    document.getXmlFragment('default').insert(document.getXmlFragment('default').length, [quote]);
  }
  const seed = Y.encodeStateAsUpdate(document);
  const peer = new Y.Doc(); Y.applyUpdate(peer, seed); peer.clientID = 46102;
  let incoming;
  peer.once('update', (bytes) => { incoming = new Uint8Array(bytes); });
  // New formatting remains outside the supported plain-prefix relocation contract.
  const original = peer.getXmlFragment('default').get(0).get(0).get(0);
  if (styled) original.insert(0, '保', { bold: true });
  else original.insert(0, '保');
  assert(incoming, 'Synthetic peer did not emit an authored insertion');
  const item = Y.decodeUpdate(incoming).structs.find((value) => value instanceof Y.Item
    && value.content instanceof Y.ContentString && value.content.str === '保');
  assert(item, 'Synthetic incoming event lost the original authored character');
  const result = { seedBase64: Buffer.from(seed).toString('base64'), updateBase64: Buffer.from(incoming).toString('base64'),
    protectedItem: { client: item.id.client, clock: item.id.clock, text: '保' },
    operation: { range: { location: 1, length: 3 }, text: '' }, expectedJoinedText: '潮航\n终章' };
  document.destroy(); peer.destroy();
  return result;
}

function dependencyClosureFixture() {
  const base = blockedFixture(false);
  const peer = new Y.Doc(); Y.applyUpdate(peer, Buffer.from(base.seedBase64, 'base64')); peer.clientID = 46103;
  const source = peer.getXmlFragment('default').get(0).get(0).get(0);
  const safe = peer.getXmlFragment('default').get(1).get(1).get(0);
  let dependency, blocked;
  peer.once('update', bytes => { dependency = new Uint8Array(bytes); });
  safe.insert(0, '远🙂');
  peer.once('update', bytes => { blocked = new Uint8Array(bytes); });
  source.insert(0, '保');
  const item = Y.decodeUpdate(blocked).structs.find(value => value instanceof Y.Item
    && value.content instanceof Y.ContentString && value.content.str === '保');
  assert(item && dependency, 'Synthetic dependency closure did not emit both source events');
  const result = { ...base, updateBase64: Buffer.from(blocked).toString('base64'),
    dependencyBase64: Buffer.from(dependency).toString('base64'),
    protectedItem: { client: item.id.client, clock: item.id.clock, text: '保' },
    safeAnchorBase64: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(safe, 1, 0))).toString('base64'),
    expectedJoinedText: '潮航\n远🙂终章' };
  peer.destroy();
  return result;
}

function verifyRetained(restart, fixture) {
  const committed = restart.boundary !== 'blocked-remote-before-commit';
  assert.equal(restart.details.retentionOnly, true);
  assert.equal(restart.details.committed, committed);
  assert.equal(restart.details.openBlocked, committed);
  if (committed) {
    assert.match(restart.details.openError, /original bytes retained.*REMOTE_TEXT_RETENTION_REQUIRED/u);
  } else assert.equal(restart.details.openError, null);
  const state = restart.details.state;
  assert.equal(state.stateHash, restart.stateHash);
  assert.equal(state.revision, committed ? 2 : 1);
  assert.equal(state.journalCount, 1);
  assert.equal(state.receiptCount, 1, 'Lab receive manufactured an applied remote receipt');
  assert.equal(state.tail.length, committed ? 1 : 0);
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state.snapshotBase64, 'base64'));
    const semantic = canonical(yDocToProsemirrorJSON(document, 'default'));
    const paragraphs = [];
    function walk(node) {
      if (node.type === 'paragraph') paragraphs.push((node.content ?? []).map((child) => child.text ?? '').join(''));
      else for (const child of node.content ?? []) walk(child);
    }
    walk(semantic);
    assert.equal(paragraphs.join('\n'), fixture.expectedJoinedText, 'Blocked receive rewrote the safe snapshot');
    if (committed) {
      assert(Number.isSafeInteger(state.tail[0].id) && state.tail[0].id > 0);
      assert.equal(state.tail[0].updateBase64, fixture.updateBase64, 'Original event bytes changed during retention');
      const update = Y.decodeUpdate(Buffer.from(state.tail[0].updateBase64, 'base64'));
      const identity = fixture.protectedItem;
      const item = update.structs.find((value) => value.id.client === identity.client
        && value.id.clock <= identity.clock && identity.clock < value.id.clock + value.length);
      assert(item instanceof Y.Item && item.content instanceof Y.ContentString, 'Retained event was replaced by a GC checkpoint');
      assert.equal(item.content.str.slice(identity.clock - item.id.clock, identity.clock - item.id.clock + identity.text.length), identity.text);
      assert(!(update.ds.clients.get(identity.client) ?? []).some((range) => range.clock <= identity.clock
        && identity.clock < range.clock + range.len), 'Authored insertion was reclassified as deleted');
    }
    return { implementation: 'Yjs', safeSnapshotSemanticHash: hash(JSON.stringify(semantic)),
      exactIncomingUpdateSha256: hash(Buffer.from(fixture.updateBase64, 'base64')),
      rawAuthoredCharacter: committed ? 'retained' : 'not-committed', semanticMerge: 'not-applied' };
  } finally { document.destroy(); }
}

function verifyRepair(restart, fixture) {
  const state = restart.details.state;
  const closure = typeof fixture.dependencyBase64 === 'string';
  const rawCount = closure ? 2 : 1;
  assert.equal(restart.details.dependencyClosure, closure);
  assert.equal(state.stateHash, restart.stateHash);
  assert.equal(state.revision, rawCount + 2);
  assert.equal(state.journalCount, 2);
  assert.equal(state.receiptCount, 2, 'Expected one local join and one local System repair receipt');
  assert.equal(restart.details.systemJournalCount, 1);
  assert.equal(restart.details.remoteFrontierCount, 0);
  assert.equal(restart.details.retryStable, true);
  assert.deepEqual(restart.details.commentRanges, [{ location: 1, length: 1 }]);
  assert.equal(state.tail.length, rawCount + 1);
  assert.equal(state.tail[0].updateBase64, fixture.updateBase64, 'Repair replaced the raw authored event');
  assert(state.tail.every((row, index) => index === 0 || row.id > state.tail[index - 1].id));
  if (closure) {
    assert.equal(state.tail[1].updateBase64, fixture.dependencyBase64, 'Repair replaced the original dependency event');
    assert.equal(restart.details.safeAnchorBase64, fixture.safeAnchorBase64);
    assert.deepEqual(restart.details.allCommentRanges, [
      { id: 'synthetic-comment', quote: '潮', ranges: [{ location: 1, length: 1 }] },
      { id: 'synthetic-tail-comment', quote: '终', ranges: [{ location: 7, length: 1 }] },
    ]);
  }
  assert.equal(restart.details.coveredId, state.tail[rawCount].id);
  const incoming = Y.decodeUpdate(Buffer.from(state.tail[0].updateBase64, 'base64'));
  const identity = fixture.protectedItem;
  const item = incoming.structs.find((value) => value.id.client === identity.client
    && value.id.clock <= identity.clock && identity.clock < value.id.clock + value.length);
  assert(item instanceof Y.Item && item.content instanceof Y.ContentString);
  assert.equal(item.content.str.slice(identity.clock - item.id.clock, identity.clock - item.id.clock + identity.text.length), identity.text);
  assert(!(incoming.ds.clients.get(identity.client) ?? []).some((range) => range.clock <= identity.clock
    && identity.clock < range.clock + range.len));
  const repair = Y.decodeUpdate(Buffer.from(state.tail[rawCount].updateBase64, 'base64'));
  assert(repair.structs.some((value) => value instanceof Y.Item
    && value.content instanceof Y.ContentString && value.content.str.includes('保')), 'System event omitted repaired prose');
  assert((repair.ds.clients.get(identity.client) ?? []).some((range) => range.clock <= identity.clock
    && identity.clock < range.clock + range.len), 'System event omitted explicit original-item retirement');
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state.snapshotBase64, 'base64'));
    const semantic = canonical(yDocToProsemirrorJSON(document, 'default'));
    assert.deepEqual(semantic, canonical(restart.details.semantic), 'Repair snapshot did not cover live prose');
    const paragraphs = [], ids = [];
    function walk(node) {
      if (node.attrs?.id) ids.push(node.attrs.id);
      if (node.type === 'paragraph') paragraphs.push((node.content ?? []).map((child) => child.text ?? '').join(''));
      else for (const child of node.content ?? []) walk(child);
    }
    walk(semantic);
    assert.equal(paragraphs.join('\n'), `保${fixture.expectedJoinedText}`);
    assert.equal(new Set(ids).size, ids.length, 'Repair duplicated a public node ID');
    assert(ids.includes('b') && ids.includes('d'));
    if (closure) {
      const suffix = document.getXmlFragment('default').get(0).get(1);
      assert.equal(suffix.getAttribute('id'), 'd');
      assert.equal(Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(suffix.get(0), 1, 0))).toString('base64'), fixture.safeAnchorBase64, 'Safe d item was copied');
      const safe = Y.decodeUpdate(Buffer.from(fixture.dependencyBase64, 'base64')).structs.find(value => value instanceof Y.Item && value.content instanceof Y.ContentString);
      assert(safe && safe.content.str === '远🙂');
      assert(!(repair.ds.clients.get(safe.id.client) ?? []).some(range => range.clock < safe.id.clock + safe.length && safe.id.clock < range.clock + range.len), 'Repair retired safe original d clocks');
      assert([...document.getMap('drifting.native.relocation-alias.v1')].some(([key, value]) => key.startsWith('skip/') && JSON.parse(value).text === '远🙂'), 'Covering snapshot omitted reusable gap proof');
    }
    // Both raw and derived event delivery orders are idempotent against the
    // covering snapshot; the immutable raw event remains separately available.
    for (const row of [...state.tail].reverse().concat(state.tail)) {
      Y.applyUpdate(document, Buffer.from(row.updateBase64, 'base64'));
    }
    assert.deepEqual(canonical(yDocToProsemirrorJSON(document, 'default')), semantic);
    return { ...verifyYjs(restart), rawAuthoredCharacter: 'retained', systemRepair: 'journaled',
      coveringSnapshot: 'passed', duplicateAndReorderedReplay: 'passed',
      exactIncomingUpdateSha256: hash(Buffer.from(fixture.updateBase64, 'base64')),
      ...(closure ? { exactDependencyUpdateSha256: hash(Buffer.from(fixture.dependencyBase64, 'base64')), safeOriginalIdentity: 'passed', persistedGapProof: 'passed' } : {}) };
  } finally { document.destroy(); }
}


function verifyNativeDeletion(restart, marker) {
  const committed = restart.boundary !== 'native-delete-authored-before-commit';
  const details = restart.details;
  assert.equal(details.nativeDeletion, true);
  assert.equal(details.committed, committed);
  assert.equal(details.retryStable, true);
  assert.equal(details.noUserUndo, true);
  assert.equal(details.revision, committed ? 3 : 2);
  assert.equal(details.journalCount, details.revision);
  assert.equal(details.receiptCount, details.revision);
  assert.equal(details.tailCount, Number(committed && restart.boundary !== 'native-delete-checkpoint-after-commit'));
  assert.deepEqual(details.scope, { projectId: 'synthetic-project', projectSyncId: 'synthetic-project-sync',
    syncGenerationId: 'synthetic-generation', documentId: 'node-content:synthetic-node', incarnation: 0 });
  assert.deepEqual(details.commentRanges, [{ location: committed ? 3 : 5, length: 2 }]);
  const original = marker.details.stagedOriginal;
  assert.equal(original.archiveBodyCount, 3);
  assert.equal(original.deviceSeq, 3);
  assert.equal(original.reference.target.incarnation, 0);
  assert.equal(original.reference.originalEnvelopeSha256, hash(Buffer.from(original.envelopeBase64, 'base64')));
  assert.match(original.reference.payloadSha256, /^sha256:[0-9a-f]{64}$/u);
  if (committed) assert.deepEqual(details.original, original, 'Cold original/envelope/captured evidence changed');
  else assert.equal(details.original, null, 'Uncommitted deletion acquired a durable original');
  const before = new Y.Doc();
  try {
    Y.applyUpdate(before, Buffer.from(marker.details.beforeUpdateBase64, 'base64'));
    const target = before.getXmlFragment('default').get(0).get(0);
    assert.equal(target.toString(), '甲北塔乙');
    assert.deepEqual(original.intent.targetText, { client: target._item.id.client, clock: target._item.id.clock });
    assert.equal(original.intent.offsetUtf16, 1);
    assert.equal(original.intent.lengthUtf16, 2);
    const selected = Y.createRelativePositionFromTypeIndex(target, 1, 0).item;
    assert(selected, 'Synthetic deletion has no original source item');
    assert.deepEqual(original.intent.selectedSourceRanges, [{ client: selected.client, clock: selected.clock, length: 2 }]);
    assert.deepEqual(Buffer.from(Y.encodeSnapshot(Y.snapshot(before))), Buffer.from(original.beforeSnapshotBase64, 'base64'));
    const event = Buffer.from(original.exactUpdateBase64, 'base64');
    const decoded = Y.decodeUpdate(event);
    assert.equal(decoded.structs.length, 0, 'Native deletion event gained a structural tail');
    const ranges = [...decoded.ds.clients].flatMap(([client, entries]) => entries.map(value => ({ client, clock: value.clock, length: value.len })));
    assert.deepEqual(ranges, original.intent.selectedSourceRanges);
    const vector = Y.encodeStateVector(before);
    Y.applyUpdate(before, event);
    assert.deepEqual(Y.encodeStateVector(before), vector, 'Pure deletion changed the state vector');
    assert.equal(target.toString(), '甲乙');
    const semantic = canonical(yDocToProsemirrorJSON(before, 'default'));
    if (committed) assert.deepEqual(semantic, canonical(details.semantic));
    Y.applyUpdate(before, event);
    assert.deepEqual(canonical(yDocToProsemirrorJSON(before, 'default')), semantic);
    return { ...verifyYjs(restart), declaration: committed ? 'durable-and-reverified' : 'not-committed',
      exactEventSha256: hash(event), envelopeSha256: hash(Buffer.from(original.envelopeBase64, 'base64')),
      actualSourceSelection: 'passed', beforeSnapshot: 'passed', pureDeleteStateVector: 'unchanged', duplicateEvent: 'passed' };
  } finally { before.destroy(); }
}

function validateBoundary(marker) {
  assert.match(marker.expectedStateHash, /^[0-9a-f]{64}$/u);
  assert.match(marker.baselineStateHash, /^[0-9a-f]{64}$/u);
  if (nativeDeletionBoundaries.includes(marker.boundary)) {
    assert.equal(marker.details.nativeDeletion, true);
    const committed = marker.boundary !== 'native-delete-authored-before-commit';
    assert.equal(marker.details.committed, committed);
    assert.equal(typeof marker.details.beforeUpdateBase64, 'string');
    assert(marker.details.stagedOriginal, 'Actual native declaration was not inspected in its transaction');
    if (committed) assert.notEqual(marker.expectedStateHash, marker.baselineStateHash);
    else { assert.equal(marker.expectedStateHash, marker.baselineStateHash); assert.equal(marker.details.transactionWritten, true); }
    if (marker.boundary.includes('checkpoint-')) assert.equal(marker.details.snapshotAndPruneSameTransaction, true);
    return;
  }
  if (repairBoundaries.includes(marker.boundary)) {
    const committed = marker.boundary !== 'repair-before-commit';
    const closure = marker.details.dependencyClosure;
    assert.equal(typeof closure, 'boolean');
    assert.equal(marker.details.blockedBeforeDependency, closure);
    const rawCount = closure ? 2 : 1;
    assert.equal(marker.details.rawCommitted, true);
    assert.equal(marker.details.transactionWritten, true);
    assert.equal(marker.details.repairCommitted, committed);
    assert.equal(marker.details.liveReplayApplied, marker.boundary === 'repair-after-live-replay');
    assert.equal(marker.details.coveredBeforeReplay, 0);
    assert.deepEqual(marker.details.staged, { text: closure ? '保潮航\n远🙂终章' : '保潮航\n终章', journalCount: 2 });
    assert.equal(marker.details.state.stateHash, marker.expectedStateHash);
    assert.equal(marker.details.state.tail.length, rawCount + Number(committed));
    assert.equal(marker.details.rawUpdateId, marker.details.state.tail[0].id);
    assert.deepEqual(marker.details.rawUpdateIds, marker.details.state.tail.slice(0, rawCount).map(row => row.id));
    if (committed) assert.notEqual(marker.expectedStateHash, marker.baselineStateHash);
    else assert.equal(marker.expectedStateHash, marker.baselineStateHash);
    return;
  }
  if (blockedBoundaries.includes(marker.boundary)) {
    assert.equal(marker.details.retentionOnly, true);
    assert.equal(marker.details.coveredId, 0);
    const committed = marker.boundary !== 'blocked-remote-before-commit';
    assert.equal(marker.details.committed, committed);
    assert.equal(marker.details.state.stateHash, marker.expectedStateHash);
    assert.equal(marker.details.state.tail.length, committed ? 1 : 0);
    if (committed) assert.notEqual(marker.expectedStateHash, marker.baselineStateHash);
    else {
      assert.equal(marker.expectedStateHash, marker.baselineStateHash);
      assert.equal(marker.details.transactionWritten, true);
    }
    if (marker.boundary === 'blocked-remote-after-commit') assert.equal(marker.details.replayAttempted, false);
    if (marker.boundary === 'blocked-remote-after-replay-rejection') {
      for (const key of ['replayAttempted', 'replayRejected', 'checkpointRejected', 'duplicateReceivePreserved', 'liveUnchanged']) {
        assert.equal(marker.details[key], true);
      }
      assert.equal(marker.details.blockedUpdateId, marker.details.state.tail[0].id);
      assert(marker.details.blockedUpdateId > marker.details.coveredId);
      assert.match(marker.details.reason, /REMOTE_TEXT_RETENTION_REQUIRED/u);
    }
    return;
  }
  if (marker.boundary === 'authored-before-commit') {
    assert.equal(marker.expectedStateHash, marker.baselineStateHash);
    assert.equal(marker.details.transactionWritten, true);
  } else {
    assert.notEqual(marker.expectedStateHash, marker.baselineStateHash, 'Crash case made no durable semantic change');
  }
  if (marker.boundary === 'authored-after-commit') assert.equal(marker.details.committedBeforeReplay, true);
  if (marker.boundary.startsWith('checkpoint-')) assert.equal(marker.details.snapshotAndPruneSameTransaction, true);
  if (marker.boundary.startsWith('local-n-plus-two')) {
    const details = marker.details;
    assert.equal(details.gapProved, true);
    assert.equal(details.liveContainedLocal, true);
    assert.equal(details.liveContainedRemote, false);
    assert(Number.isSafeInteger(details.remoteId) && details.remoteId > 0);
    assert(Number.isSafeInteger(details.localId) && details.localId > details.remoteId);
    assert(Number.isSafeInteger(details.coveredBeforeReplay) && details.coveredBeforeReplay < details.remoteId);
    if (marker.boundary === 'local-n-plus-two-after-checkpoint') {
      assert.equal(details.coveredAfterCheckpoint, details.localId);
      assert(Number.isSafeInteger(details.lateId) && details.lateId > details.coveredAfterCheckpoint);
      assert.equal(details.lateTailRetained, true);
    }
  }
}

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'apple_native_prose_process_recovery');
  assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/u);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(report.oracleSourceFingerprint, /^[0-9a-f]{64}$/u);
  assert.match(report.environment.workerSha256, /^[0-9a-f]{64}$/u);
  assert.equal(report.rustTests.status, 'passed');
  assert(report.rustTests.passed > 0, 'Native owner unit tests were not run');
  assert.deepEqual(report.rustTests.requiredCases, requiredOwnerTests.map(name => ({ name, status: 'passed' })));
  assert.deepEqual(report.acceptance, { processRecovery: 'passed', nativeSqliteGateway: 'passed',
    powerLoss: 'not-run', physicalDevice: 'not-run', realAccount: 'not-run', distribution: 'not-run' });
  assert.deepEqual(report.cases.map(({ boundary }) => boundary).sort(), [...boundaries].sort());
  for (const entry of report.cases) {
    assert.equal(entry.seed.event, 'seeded');
    assert.equal(entry.seed.boundary, entry.boundary);
    assert.deepEqual(entry.seed.exit, { code: 0, signal: null });
    assert.deepEqual(entry.seed.details.sqlite, { journalMode: 'wal', synchronous: 1 });
    assert.equal(entry.kill.event, 'ready');
    assert.equal(entry.kill.boundary, entry.boundary);
    validateBoundary(entry.kill);
    assert.deepEqual(entry.kill.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(entry.restarts.length, 2);
    for (const restart of entry.restarts) {
      assert.equal(restart.event, 'recovered');
      assert.equal(restart.boundary, entry.boundary);
      assert.deepEqual(restart.exit, { code: 0, signal: null });
      assert.deepEqual(restart.checks, checks);
      assert.equal(restart.stateHash, entry.kill.expectedStateHash);
      assert.deepEqual(restart.oracle, verifyYjs(restart));
    }
    assert.equal(entry.restarts[0].stateHash, entry.restarts[1].stateHash);
    assert.equal(entry.restarts[0].oracle.semanticHash, entry.restarts[1].oracle.semanticHash);
  }
  assert.deepEqual(report.nativeDeletionCases.map(({ boundary }) => boundary).sort(), [...nativeDeletionBoundaries].sort());
  for (const entry of report.nativeDeletionCases) {
    assert.equal(entry.classification, 'actual-native-deletion-capture-recovery');
    assert.equal(entry.seed.event, 'seeded');
    assert.equal(entry.seed.boundary, entry.boundary);
    assert.deepEqual(entry.seed.exit, { code: 0, signal: null });
    assert.deepEqual(entry.seed.details.sqlite, { journalMode: 'wal', synchronous: 1 });
    assert.equal(entry.kill.event, 'ready');
    assert.equal(entry.kill.boundary, entry.boundary);
    assert.deepEqual(entry.kill.exit, { code: null, signal: 'SIGKILL' });
    validateBoundary(entry.kill);
    assert.equal(entry.restarts.length, 2);
    for (const restart of entry.restarts) {
      assert.equal(restart.event, 'recovered');
      assert.equal(restart.boundary, entry.boundary);
      assert.deepEqual(restart.exit, { code: 0, signal: null });
      assert.deepEqual(restart.checks, nativeDeletionChecks);
      assert.equal(restart.stateHash, entry.kill.expectedStateHash);
      assert.deepEqual(restart.oracle, verifyNativeDeletion(restart, entry.kill));
    }
    assert.equal(entry.restarts[0].stateHash, entry.restarts[1].stateHash);
  }
  assert.deepEqual(report.blockedCases.map(({ boundary }) => boundary).sort(), [...blockedBoundaries].sort());
  for (const entry of report.blockedCases) {
    assert.equal(entry.classification, 'raw-retention-not-semantic-merge');
    assert.equal(entry.seed.event, 'seeded');
    assert.equal(entry.seed.boundary, entry.boundary);
    assert.deepEqual(entry.seed.exit, { code: 0, signal: null });
    assert.deepEqual(entry.seed.details.sqlite, { journalMode: 'wal', synchronous: 1 });
    assert.equal(entry.kill.event, 'ready');
    assert.equal(entry.kill.boundary, entry.boundary);
    assert.deepEqual(entry.kill.exit, { code: null, signal: 'SIGKILL' });
    validateBoundary(entry.kill);
    assert.equal(entry.restarts.length, 2);
    for (const restart of entry.restarts) {
      assert.equal(restart.event, 'recovered');
      assert.equal(restart.boundary, entry.boundary);
      assert.deepEqual(restart.exit, { code: 0, signal: null });
      assert.deepEqual(restart.checks, blockedChecks);
      assert.equal(restart.stateHash, entry.kill.expectedStateHash);
      assert.deepEqual(restart.oracle, verifyRetained(restart, entry.fixture));
      assert.equal(restart.details.state.snapshotBase64, entry.kill.details.state.snapshotBase64);
    }
    assert.equal(entry.restarts[0].stateHash, entry.restarts[1].stateHash);
  }
  assert.deepEqual(report.repairCases.map(({ boundary }) => boundary).sort(), [...repairBoundaries].sort());
  assert.deepEqual(report.closureCases.map(({ boundary }) => boundary).sort(), [...repairBoundaries].sort());
  for (const entry of [...report.repairCases, ...report.closureCases]) {
    const closure = report.closureCases.includes(entry);
    assert.equal(typeof entry.fixture.dependencyBase64 === 'string', closure);
    assert.equal(entry.kill.details.dependencyClosure, closure);
    assert.equal(entry.classification, closure ? 'stored-dependency-closure-recovery' : 'plain-prefix-relocation-recovery');
    assert.equal(entry.seed.event, 'seeded');
    assert.equal(entry.seed.boundary, entry.boundary);
    assert.deepEqual(entry.seed.exit, { code: 0, signal: null });
    assert.deepEqual(entry.seed.details.sqlite, { journalMode: 'wal', synchronous: 1 });
    assert.equal(entry.kill.event, 'ready');
    assert.equal(entry.kill.boundary, entry.boundary);
    assert.deepEqual(entry.kill.exit, { code: null, signal: 'SIGKILL' });
    validateBoundary(entry.kill);
    assert.equal(entry.restarts.length, 2);
    assert.equal(entry.restarts[0].details.beforeState.stateHash, entry.kill.expectedStateHash);
    assert.equal(entry.restarts[1].details.beforeState.stateHash, entry.restarts[0].stateHash);
    assert.equal(entry.restarts[0].details.beforeState.journalCount, entry.boundary === 'repair-before-commit' ? 1 : 2);
    if (entry.boundary !== 'repair-before-commit') assert.equal(entry.restarts[0].stateHash, entry.kill.expectedStateHash);
    for (const restart of entry.restarts) {
      assert.equal(restart.event, 'recovered');
      assert.equal(restart.boundary, entry.boundary);
      assert.deepEqual(restart.exit, { code: 0, signal: null });
      assert.deepEqual(restart.checks, repairChecks);
      assert.deepEqual(restart.oracle, verifyRepair(restart, entry.fixture));
    }
    assert.equal(entry.restarts[0].stateHash, entry.restarts[1].stateHash);
  }
}

const children = new Set();
let interrupted = false;
function stop() {
  interrupted = true;
  for (const child of children) child.kill('SIGKILL');
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);

function start(mode, directory, boundary) {
  assert.equal(interrupted, false, 'Native recovery acceptance interrupted');
  const child = spawn(worker, [mode, directory, boundary], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '', message, failure, timedOut = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12_000); });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      try {
        assert.equal(message, undefined, 'Worker emitted more than one result');
        assert(line.length < 4 * 1024 * 1024, 'Worker JSON marker exceeded limit');
        message = JSON.parse(line);
        assert.equal(message.boundary, boundary);
        assert.equal(message.event, mode === 'seed' ? 'seeded' : mode === 'crash' ? 'ready' : 'recovered');
        if (mode === 'seed') assert.deepEqual(message.details.sqlite, { journalMode: 'wal', synchronous: 1 });
        if (mode === 'crash') {
          validateBoundary(message);
          assert.equal(child.kill('SIGKILL'), true, 'Could not terminate paused native worker');
        }
      } catch (error) { failure = error; child.kill('SIGKILL'); }
    });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code, signal) => {
      clearTimeout(timer); children.delete(child); lines.close();
      try {
        if (failure) throw failure;
        assert.equal(interrupted, false, 'Native recovery acceptance interrupted');
        assert.equal(timedOut, false, `Worker timed out: ${mode}/${boundary}`);
        assert(message, `Worker exited without a marker: ${mode}/${boundary} (${code}/${signal})`);
        assert.deepEqual({ code, signal }, mode === 'crash' ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null });
        if (mode === 'recover') {
          assert.deepEqual(message.checks, nativeDeletionBoundaries.includes(boundary) ? nativeDeletionChecks
            : repairBoundaries.includes(boundary) ? repairChecks
            : blockedBoundaries.includes(boundary) ? blockedChecks : checks);
          assert.match(message.stateHash, /^[0-9a-f]{64}$/u);
        }
        resolve({ ...message, exit: { code, signal } });
      } catch (error) {
        reject(new Error(`${error.message}\n${stderr}`.replaceAll(root, '<repository>/')));
      }
    });
  });
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(await readFile(output, 'utf8'));
  validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Native durability evidence is stale; regenerate it');
  command('pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-prose-journal-oracle.ts', '--check']);
  const oracle = JSON.parse(await readFile('docs/apple-native/fixtures/prose-journal-v1.json', 'utf8'));
  assert.equal(report.oracleSourceFingerprint, oracle.sourceFingerprint);
  console.log(`Native prose recovery: ${boundaries.length} merge/recovery, ${blockedBoundaries.length} retention and ${repairBoundaries.length * 2} repair/closure and ${nativeDeletionBoundaries.length} actual native deletion SIGKILL cases; ${(boundaries.length + blockedBoundaries.length + repairBoundaries.length * 2 + nativeDeletionBoundaries.length) * 2} independent restarts match source.`);
} else {
  assert.notEqual(process.platform, 'win32', 'Native process recovery requires POSIX SIGKILL');
  command('pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-prose-journal-oracle.ts', '--check']);
  const source = { commit: command('git', ['rev-parse', 'HEAD']).trim(),
    dirty: Boolean(command('git', ['status', '--porcelain']).trim()), fingerprint: fingerprint() };
  if (!smoke) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify({ schemaVersion: 1, kind: 'apple_native_prose_process_recovery',
      status: 'running', generatedAt: new Date().toISOString(), source, cases: [], blockedCases: [], repairCases: [], closureCases: [], nativeDeletionCases: [] }, null, 2)}\n`);
  }
  const testLog = command('cargo', ['test', '--locked', '--manifest-path', 'crates/drifting-prose/Cargo.toml', '--target-dir', 'crates/drifting-prose/target']);
  await mkdir('.local-data/apple-native/durability', { recursive: true });
  await writeFile('.local-data/apple-native/durability/rust-tests.log', testLog);
  const passed = [...testLog.matchAll(/test result: ok\. (\d+) passed;/gu)]
    .reduce((count, match) => count + Number(match[1]), 0);
  assert(passed > 0, 'Native owner unit tests were not run');
  for (const name of requiredOwnerTests) assert(testLog.includes(`test ${name} ... ok`), `Missing native owner regression: ${name}`);
  const rustTests = { status: 'passed', passed, requiredCases: requiredOwnerTests.map(name => ({ name, status: 'passed' })) };
  command('cargo', ['build', '--locked', '--manifest-path', 'crates/drifting-prose/Cargo.toml', '--target-dir', 'crates/drifting-prose/target', '--example', 'durability-worker']);
  assert(existsSync(worker), 'Native durability worker has not been built');
  const oracle = JSON.parse(await readFile('docs/apple-native/fixtures/prose-journal-v1.json', 'utf8'));
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-native-durability-'));
  const cases = [];
  const blockedCases = [];
  const repairCases = [];
  const closureCases = [];
  const nativeDeletionCases = [];
  try {
    for (const boundary of smoke ? ['remote-committed-before-replay'] : boundaries) {
      const current = path.join(directory, boundary);
      await mkdir(current, { recursive: true });
      const seed = await start('seed', current, boundary);
      const kill = await start('crash', current, boundary);
      const restarts = [await start('recover', current, boundary), await start('recover', current, boundary)];
      for (const restart of restarts) {
        assert.equal(restart.stateHash, kill.expectedStateHash, `${boundary}: recovered the wrong state`);
        restart.oracle = verifyYjs(restart);
      }
      cases.push({ boundary, seed, kill, restarts });
      console.log(`Recovered ${cases.length}/${smoke ? 1 : boundaries.length}: ${boundary}`);
    }
    for (const boundary of smoke ? ['blocked-remote-after-replay-rejection'] : blockedBoundaries) {
      const current = path.join(directory, boundary);
      await mkdir(current, { recursive: true });
      const fixture = blockedFixture();
      await writeFile(path.join(current, 'blocked-fixture.json'), JSON.stringify(fixture));
      const seed = await start('seed', current, boundary);
      const kill = await start('crash', current, boundary);
      const restarts = [await start('recover', current, boundary), await start('recover', current, boundary)];
      for (const restart of restarts) {
        assert.equal(restart.stateHash, kill.expectedStateHash, `${boundary}: retained data changed after restart`);
        restart.oracle = verifyRetained(restart, fixture);
      }
      blockedCases.push({ boundary, classification: 'raw-retention-not-semantic-merge', fixture, seed, kill, restarts });
      console.log(`Retained ${blockedCases.length}/${smoke ? 1 : blockedBoundaries.length}: ${boundary}`);
    }
    for (const boundary of smoke ? ['repair-before-commit'] : repairBoundaries) {
      const current = path.join(directory, boundary);
      await mkdir(current, { recursive: true });
      const fixture = blockedFixture(false);
      await writeFile(path.join(current, 'blocked-fixture.json'), JSON.stringify(fixture));
      const seed = await start('seed', current, boundary);
      const kill = await start('crash', current, boundary);
      const restarts = [await start('recover', current, boundary), await start('recover', current, boundary)];
      assert.equal(restarts[0].details.beforeState.stateHash, kill.expectedStateHash);
      assert.equal(restarts[1].details.beforeState.stateHash, restarts[0].stateHash);
      assert.equal(restarts[0].stateHash, restarts[1].stateHash, 'Second cold replay duplicated the repair');
      for (const restart of restarts) restart.oracle = verifyRepair(restart, fixture);
      repairCases.push({ boundary, classification: 'plain-prefix-relocation-recovery', fixture, seed, kill, restarts });
      console.log(`Repaired ${repairCases.length}/${smoke ? 1 : repairBoundaries.length}: ${boundary}`);
    }
    for (const boundary of smoke ? ['repair-before-commit'] : repairBoundaries) {
      const current = path.join(directory, `closure-${boundary}`);
      await mkdir(current, { recursive: true });
      const fixture = dependencyClosureFixture();
      await writeFile(path.join(current, 'blocked-fixture.json'), JSON.stringify(fixture));
      const seed = await start('seed', current, boundary);
      const kill = await start('crash', current, boundary);
      const restarts = [await start('recover', current, boundary), await start('recover', current, boundary)];
      assert.equal(restarts[0].details.beforeState.stateHash, kill.expectedStateHash);
      assert.equal(restarts[1].details.beforeState.stateHash, restarts[0].stateHash);
      assert.equal(restarts[0].stateHash, restarts[1].stateHash, 'Second cold replay duplicated the repair');
      for (const restart of restarts) restart.oracle = verifyRepair(restart, fixture);
      closureCases.push({ boundary, classification: 'stored-dependency-closure-recovery', fixture, seed, kill, restarts });
      console.log(`Closed ${closureCases.length}/${smoke ? 1 : repairBoundaries.length}: ${boundary}`);
    }
    for (const boundary of smoke ? ['native-delete-authored-after-commit'] : nativeDeletionBoundaries) {
      const current = path.join(directory, boundary);
      await mkdir(current, { recursive: true });
      const seed = await start('seed', current, boundary);
      const kill = await start('crash', current, boundary);
      const restarts = [await start('recover', current, boundary), await start('recover', current, boundary)];
      for (const restart of restarts) {
        assert.equal(restart.stateHash, kill.expectedStateHash, `${boundary}: native declaration recovery changed committed state`);
        restart.oracle = verifyNativeDeletion(restart, kill);
      }
      nativeDeletionCases.push({ boundary, classification: 'actual-native-deletion-capture-recovery', seed, kill, restarts });
      console.log(`Recovered native declaration ${nativeDeletionCases.length}/${smoke ? 1 : nativeDeletionBoundaries.length}: ${boundary}`);
    }
    assert.equal(fingerprint(), source.fingerprint, 'Native persistence sources changed during acceptance');
    if (smoke) {
      console.log('Native durability smoke passed; no complete acceptance report was written.');
    } else {
      const report = {
        schemaVersion: 1, kind: 'apple_native_prose_process_recovery', status: 'passed', generatedAt: new Date().toISOString(),
        source, oracleSourceFingerprint: oracle.sourceFingerprint, rustTests,
        environment: { platform: process.platform, arch: process.arch, node: process.version,
          rustc: command('rustc', ['--version']).trim(), workerSha256: hash(readFileSync(worker)) },
        cases, blockedCases, repairCases, closureCases, nativeDeletionCases,
        acceptance: { processRecovery: 'passed', nativeSqliteGateway: 'passed', powerLoss: 'not-run',
          physicalDevice: 'not-run', realAccount: 'not-run', distribution: 'not-run' },
        limitations: [
          'Native deletion cases use actual NativeReplacement capture and scoped authoring, verify committed originals/archive after restart, and retain unchanged writer/revision/receipt counts. Before-COMMIT termination correctly leaves no durable deletion declaration; this does not preserve an uncommitted editor buffer or implement remote deletion routing.',
          'SIGKILL exercises native process termination and SQLite recovery; it does not simulate OS crash, disk failure or power loss.',
          'The native WAL/NORMAL configuration remains in force. This report is not a power-loss durability guarantee.',
          'The worker uses synthetic data in a separate temporary directory. It does not exercise UI backgrounding, a physical device, account synchronization or signed distribution.',
          'Coverage is checked at exact transaction/replay boundaries; timing-independent phase markers do not simulate interruption inside SQLite COMMIT itself.',
          'Blocked cases prove exact incoming bytes survive process termination and two cold opens. They do not prove semantic relocation, successful merge, or production remote reducer/receipt integration.',
          'Repair cases cover plain insertions in the copied retained prefix with a local System journal and covering snapshot. They do not prove arbitrary formatting/deletion relocation or production network delivery.',
          'Closure cases first retain a blocked source update, then receive its safe-clock dependency; only complete closures with an explicit derived repair are accepted. No-repair cancellation remains outside this recovery path.',
        ],
      };
      validate(report);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ status: 'passed', output, cases: cases.length, blockedCases: blockedCases.length, repairCases: repairCases.length, closureCases: closureCases.length, nativeDeletionCases: nativeDeletionCases.length }));
    }
  } catch (error) {
    if (!smoke) await writeFile(output, `${JSON.stringify({ schemaVersion: 1, kind: 'apple_native_prose_process_recovery',
      status: 'failed', generatedAt: new Date().toISOString(), source, rustTests, cases, blockedCases, repairCases, closureCases, nativeDeletionCases,
      failure: error.message.replaceAll(root, '<repository>/') }, null, 2)}\n`);
    throw error;
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}
