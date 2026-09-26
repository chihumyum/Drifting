import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { defaultDeleteFilter, defaultProtectedNodes } from '@tiptap/y-tiptap';

// Runs the actual Rust session in a separate process and the installed old Yjs
// implementation here. All documents/peer IDs are synthetic and deterministic.
const fixture = JSON.parse(readFileSync('docs/apple-native/fixtures/document-v1.json'));
const base = Buffer.from(fixture.updateBase64, 'base64');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? 'docs/apple-native/acceptance/p2a-document.json';
const logDirectory = '.local-data/apple-native/document';
const requiredUnitTests = [
  'relocation_history_tests::relocation_history_gap_receipt_conflict_rejects_before_mutation',
  'relocation_history_tests::relocation_history_gap_second_alias_rejects_without_blocking_contiguous_history',
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
];
mkdirSync(logDirectory, { recursive: true });
const run = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
  } catch (error) {
    writeFileSync(`${logDirectory}/failed-command.log`, `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    throw new Error(`${command} ${args.join(' ')} failed; see ${logDirectory}/failed-command.log\n${String(error.stdout ?? '').slice(-12000)}\n${String(error.stderr ?? '').slice(-2000)}`);
  }
};
const sources = [...new Set(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
  .filter(file => file && existsSync(file) && (file.startsWith('crates/drifting-document/') || file.startsWith('vendor/yrs/') || [
    'scripts/check-yrs-vendor.mjs', 'scripts/generate-yrs-provenance.mjs', 'scripts/apple-yrs-diagnostic.mjs',
    'scripts/apple-document-acceptance.mjs', 'scripts/apple-structure-oracle.ts', 'scripts/apple-quote-history-oracle.ts', 'scripts/apple-comment-oracle.ts', 'scripts/generate-apple-fixtures.mjs',
    'src/renderer/domain/comment.ts', 'src/renderer/domain/entity-kinds.ts',
    'src/renderer/components/editor/chapter-static-html.ts', 'src/renderer/lib/extensions/block-id.ts',
    'src/renderer/lib/extensions/paragraph-indent.ts', 'src/renderer/lib/extensions/entity-link.ts',
    'src/renderer/lib/retroactive-entity-links.ts', 'src/renderer/hooks/useEntityEditor.ts',
    'patches/@tiptap__y-tiptap@3.0.8.patch',
    'docs/apple-native/fixtures/document-v1.json', 'package.json', 'pnpm-lock.yaml',
  ].includes(file))).sort();
const hash = data => createHash('sha256').update(data).digest('hex');
const fingerprint = () => hash(JSON.stringify(sources.map(path => ({ path, sha256: hash(readFileSync(path)) }))));
const report = {
  schemaVersion: 1, kind: 'apple_native_p2a_document_compatibility', generatedAt: new Date().toISOString(), status: 'running',
  source: { commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty: Boolean(run('git', ['status', '--porcelain']).trim()), fingerprint: fingerprint() },
  libraries: { yjs: JSON.parse(readFileSync('node_modules/yjs/package.json')).version, yrs: '0.28.0',
    localYrsPatches: ['follow-redone-offset', 'sparse-hole-pending-replay', 'undo-deletion-filter'],
    localYrsTestPatches: ['awareness-summary-fixed-clock'], offsetKind: 'utf16', garbageCollection: true, nativeUndoOrigin: 'native-local', inputEncodings: [1, 2], outputEncodings: [1] },
  knownLimitations: [
    { name: 'Yrs v2 binary-array emission', mitigation: 'Reject v2 output; keep published v1 output. Binary map/array/XML attribute values remain supported.' },
    { name: 'V1 JSON-only format/embed values', mitigation: 'Reject non-JSON format/embed values before remote integration and v1 export; validate missing-dependency structs and unknown roots as well as visible prose.' },
    { name: 'Late text under deleted or copied parents', mitigation: 'Persisted aliases route unformatted insertions inside the retained left prefix of the two supported right-survivor quote shapes, including packets with safe suffix text from another writer or later clocks of the same writer. Exact persisted safe-clock proof covers same-writer interleaving outside one alias graph. Unknown holes, fresh formatting, collisions, alias-graph text and other deleted parents remain behind the raw-retention barrier; general relocation and its performance remain open. Context-aware durable tail recovery is recorded separately by the persistence report.' },
  ],
  cases: [], limits: { nativeTextBinding: 'separate-binding-report', ime: 'not-run', splitMergeAnchorRemap: 'sibling/scoped quote maps, comment history and disjoint structural draft maps tested; subtree relocation and production sync open',
    nativeCommandEvidence: 'plain contiguous native/queued/draft deletions capture exact live transaction facts; journal and version ownership are checked separately by the authoring report; semantic deletion authority is not enabled',
    sqliteDurableReplay: 'separate-durability-report', physicalDevice: 'not-run', realAccount: 'not-run', distribution: 'not-run' },
};
if (process.argv.includes('--check')) {
  const previous = JSON.parse(readFileSync(output));
  assert.equal(previous.status, 'passed', 'P2a document acceptance must pass');
  assert(previous.unitTests?.passed >= 132 && previous.unitTests.failed === 0, 'Document unit tests must execute');
  assert.deepEqual(previous.unitTests.requiredCases, requiredUnitTests.map(name => ({ name, status: 'passed' })));
  assert.equal(previous.relocationAliasAcceptance?.status, 'passed', 'Original-prefix routing must pass');
  assert.equal(previous.relocationAliasAcceptance.scenarios.length, 2, 'Both supported quote shapes must execute');
  assert.equal(previous.relocationAliasAcceptance.mixedPackets?.length, 4, 'Both shapes must preserve mixed original-prefix and safe suffix text from same and independent writers');
  assert.equal(previous.safeClockGaps?.status, 'passed', 'Proved safe clock gaps must pass');
  assert.equal(previous.safeClockGaps.scenarios.length, 12, 'Both quote shapes, gap patterns and delivery boundaries must execute');
  assert(previous.safeClockGaps.scenarios.every(value => value.independentReceiver && value.stages.length === 5 && value.stages.every(stage => stage.persistentSkipProof && stage.canonicalOnlyGc && stage.checkpointReopened)));
  assert.equal(previous.safeClockGaps.negativeCases.length, 2, 'Residual pending must refuse atomically for both shapes');
  assert(previous.safeClockGaps.negativeCases.every(value => value.atomicRefusal));
  assert.equal(previous.source.fingerprint, report.source.fingerprint, 'P2a evidence is stale: run pnpm apple:document:acceptance');
  assert.equal(previous.sparseReplayDiagnostic.sha256, hash(readFileSync('docs/apple-native/acceptance/yrs-random-array-diagnostic.json')),
    'Sparse-replay diagnostic changed: regenerate document evidence');
  console.log('P2a document evidence matches its source inputs.');
  process.exit(0);
}
const encoded = value => Buffer.from(value).toString('base64');
const decoded = value => Buffer.from(value, 'base64');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonical(child)]));
    if (result.marks) result.marks.sort((a, b) => a.type.localeCompare(b.type, 'en'));
    return result;
  }
  return value;
}
const semantic = doc => canonical(yDocToProsemirrorJSON(doc, 'default'));
function jsDoc(clientID, initial = base) {
  const doc = new Y.Doc(); doc.clientID = clientID;
  if (initial) Y.applyUpdate(doc, initial, 'remote');
  return doc;
}
function findBlock(doc, id) {
  function visit(node) {
    if (node instanceof Y.XmlElement && node.getAttribute('id') === id) return node;
    for (const child of node.toArray?.() ?? []) { const result = visit(child); if (result) return result; }
    return null;
  }
  const block = visit(doc.getXmlFragment('default'));
  assert(block, `Missing synthetic block ${id}`);
  return block;
}
const text = (doc, id = 'fixture-paragraph') => findBlock(doc, id).get(0);
const plain = (doc, id = 'fixture-paragraph') => text(doc, id).toDelta().map(segment => segment.insert).join('');
function jsEdit(doc, edit) {
  doc.transact(() => {
    const target = edit.block ? findBlock(doc, edit.block) : null;
    switch (edit.operation) {
      case 'insert':
        if (target.length === 0) target.insert(0, [new Y.XmlText(edit.text)]);
        else target.get(0).insert(edit.offset, edit.text);
        break;
      case 'delete': target.get(0).delete(edit.offset, edit.length); break;
      case 'format': target.get(0).format(edit.offset, edit.length, edit.attributes); break;
      case 'setAttribute': target.setAttribute(edit.key, edit.value); break;
      case 'appendParagraph': {
        const block = new Y.XmlElement('paragraph'); block.setAttribute('id', edit.id);
        block.insert(0, [new Y.XmlText(edit.text)]); doc.getXmlFragment('default').push([block]); break;
      }
      case 'deleteBlock': doc.getXmlFragment('default').delete(doc.getXmlFragment('default').toArray().indexOf(target), 1); break;
      default: throw new Error(`Unknown test edit ${edit.operation}`);
    }
  }, 'js-local');
}
let processHandle;
let pending;
let errors = '';
function request(session, command, body = {}) {
  assert(!pending, 'Protocol requests must be sequential');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending = null; reject(new Error(`Rust protocol timeout: ${command}`)); }, 30000);
    pending = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(new Error(`${session}/${command}: ${error.message}; request=${JSON.stringify(body)}`)); } };
    processHandle.stdin.write(`${JSON.stringify({ session, command, ...body })}\n`);
  });
}
async function open(name, clientId, initial = base, encoding = 1) {
  assert.equal((await request(name, 'open', { clientId })).yrs, report.libraries.yrs);
  if (initial) await request(name, 'apply', { update: encoded(initial), encoding });
}
const state = async name => canonical((await request(name, 'state')).semantic);
async function exportToJS(name, client = 987654, encoding = 1) {
  const doc = jsDoc(client, null);
  const bytes = decoded(await request(name, 'export', { encoding }));
  if (encoding === 1) Y.applyUpdate(doc, bytes, 'remote'); else Y.applyUpdateV2(doc, bytes, 'remote');
  return doc;
}
async function check(name, work, details = {}) {
  console.log(`Document compatibility: ${name}`);
  await work(); report.cases.push({ name, status: 'passed', ...details });
}
try {
  report.toolchain = { rustc: run('rustc', ['--version']).trim(), node: process.version };
  run(process.execPath, ['scripts/generate-apple-fixtures.mjs', '--check']);
  run(process.execPath, ['scripts/check-yrs-vendor.mjs']);
  run(process.execPath, ['scripts/apple-yrs-diagnostic.mjs', '--check']);
  report.sparseReplayDiagnostic = { path: 'yrs-random-array-diagnostic.json',
    sha256: hash(readFileSync('docs/apple-native/acceptance/yrs-random-array-diagnostic.json')) };
  const upstreamLog = run('cargo', ['test', '--manifest-path', 'vendor/yrs/Cargo.toml', '--lib', '--features', 'sync', '--locked',
    '--target-dir', '.local-data/apple-native/yrs-upstream', '--', '--skip', 'tests::edit_traces_tests::',
    '--skip', 'tests::compatibility_tests::test_small_data_set', '--skip', 'tests::compatibility_tests::test_medium_data_set']);
  writeFileSync(`${logDirectory}/yrs-upstream.log`, upstreamLog);
  const upstreamCounts = upstreamLog.match(/test result: ok\. (\d+) passed; 0 failed; (\d+) ignored; 0 measured; (\d+) filtered out/);
  assert(upstreamCounts && Number(upstreamCounts[1]) >= 378, 'Vendored Yrs self-contained tests must execute');
  report.upstreamRegression = { passed: Number(upstreamCounts[1]), ignored: Number(upstreamCounts[2]),
    excluded: Number(upstreamCounts[3]), exclusionReason: 'Seven upstream trace/dataset tests need assets absent from the published crate; not claimed as passed.' };
  const testLog = run('cargo', ['test', '--manifest-path', 'crates/drifting-document/Cargo.toml', '--locked']);
  writeFileSync(`${logDirectory}/rust-tests.log`, testLog);
  const testCount = [...testLog.matchAll(/test result: ok\. (\d+) passed;/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert(testCount >= 132, 'Document, comment, selection and sparse-replay unit tests must actually execute');
  for (const name of requiredUnitTests) assert(testLog.includes(`test ${name} ... ok`), `Missing document regression: ${name}`);
  report.unitTests = { passed: testCount, failed: 0, requiredCases: requiredUnitTests.map(name => ({ name, status: 'passed' })) };
  run('cargo', ['build', '--manifest-path', 'crates/drifting-document/Cargo.toml', '--locked', '--example', 'document_protocol']);
  processHandle = spawn('crates/drifting-document/target/debug/examples/document_protocol', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  processHandle.stderr.on('data', value => { errors += String(value).slice(0, 8192); });
  createInterface({ input: processHandle.stdout }).on('line', line => {
    const waiting = pending; pending = null;
    if (!waiting) return;
    try { const response = JSON.parse(line); if (response.ok) waiting.resolve(response.value); else waiting.reject(new Error(response.error)); }
    catch (error) { waiting.reject(error); }
  });
  processHandle.on('error', error => { const waiting = pending; pending = null; waiting?.reject(error); });
  processHandle.on('exit', code => { const waiting = pending; pending = null; waiting?.reject(new Error(`Rust process exited ${code}: ${errors}`)); });

  await check('v1/v2 input and v1 output preserve XML, marks, opaque metadata, shared roots and binary values', async () => {
    const js = jsDoc(100);
    js.getMap('future-native-metadata').set('nested', { version: 7, values: [false, null, '合成 👩🏽‍🚀', { intact: true }] });
    const nested = new Y.Map(); nested.set('retained', 'a shared type');
    js.getMap('future-native-metadata').set('shared', nested);
    js.getArray('future-list').push([1, { preserved: true }, new Uint8Array([1, 2, 255])]);
    js.getMap('comments').set('fixture-comment', fixture.comments[0]);
    for (const encoding of [1, 2]) {
      const name = `encoding-${encoding}`;
      await open(name, 2 ** 40 + encoding, encoding === 1 ? Y.encodeStateAsUpdate(js) : Y.encodeStateAsUpdateV2(js), encoding);
      assert.deepEqual(await state(name), semantic(js));
      await request(name, 'edit', { edit: { operation: 'insert', block: 'fixture-heading', offset: 0, text: '原生 ' } });
      jsEdit(js, { operation: 'insert', block: 'fixture-heading', offset: 0, text: '原生 ' });
      const received = await exportToJS(name, 101 + encoding);
      assert.deepEqual(semantic(received), semantic(js));
      for (const root of ['future-native-metadata', 'comments']) assert.deepEqual(received.getMap(root).toJSON(), js.getMap(root).toJSON());
      assert.deepEqual(received.getArray('future-list').toJSON(), js.getArray('future-list').toJSON());
      await assert.rejects(request(name, 'export', { encoding: 2 }), /pinned to v1/);
      assert.deepEqual(findBlock(received, 'fixture-opaque').getAttributes(), findBlock(js, 'fixture-opaque').getAttributes());
      received.destroy(); await request(name, 'close');
    }
    js.destroy();
  });

  await check('differential targeted edits and incremental exchange in both directions', async () => {
    const edits = [
      { operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '🌊序言 ' },
      { operation: 'format', block: 'fixture-paragraph', offset: 1 + '🌊序言 '.length, length: 6, attributes: { italic: {}, underline: {}, futureMark: { preserve: true } } },
      { operation: 'format', block: 'fixture-paragraph', offset: 5 + '🌊序言 '.length, length: 2, attributes: { bold: null, link: { href: 'https://example.invalid/synthetic' } } },
      { operation: 'delete', block: 'fixture-paragraph', offset: 0, length: '🌊序言 '.length },
      { operation: 'setAttribute', block: 'fixture-heading', key: 'level', value: 3 },
      { operation: 'insert', block: 'fixture-list-paragraph', offset: 2, text: '嵌套 e\u0301' },
      { operation: 'appendParagraph', id: 'new-paragraph', text: '尾声 𠮷 👨‍👩‍👧‍👦' },
      { operation: 'deleteBlock', block: 'fixture-rule' },
    ];
    await open('diff-a', 201); await open('diff-b', 202);
    const expected = jsDoc(203); const receiver = jsDoc(204);
    for (const edit of edits) {
      const jsVector = Y.encodeStateVector(expected);
      jsEdit(expected, edit);
      await request('diff-a', 'edit', { edit });
      Y.applyUpdate(receiver, decoded(await request('diff-a', 'export', { stateVector: encoded(Y.encodeStateVector(receiver)) })), 'remote');
      await request('diff-b', 'apply', { update: encoded(Y.encodeStateAsUpdate(expected, jsVector)) });
      assert.deepEqual(await state('diff-a'), semantic(expected));
      assert.deepEqual(await state('diff-b'), semantic(expected));
      assert.deepEqual(semantic(receiver), semantic(expected));
    }
    expected.destroy(); receiver.destroy(); await request('diff-a', 'close'); await request('diff-b', 'close');
  }, { operations: 8 });

  await check('pinned upstream v2 binary-array failure is reproduced and production output rejects v2', async () => {
    const js = jsDoc(250, null); js.getArray('synthetic-binary').push([new Uint8Array([1, 2, 255])]);
    await open('v2-regression', 251, Y.encodeStateAsUpdate(js));
    const broken = decoded(await request('v2-regression', 'probeUpstreamV2'));
    const receiver = new Y.Doc();
    assert.throws(() => Y.applyUpdateV2(receiver, broken));
    await assert.rejects(request('v2-regression', 'export', { encoding: 2 }), /pinned to v1/);
    const safe = await exportToJS('v2-regression');
    assert.deepEqual(safe.getArray('synthetic-binary').toJSON(), js.getArray('synthetic-binary').toJSON());
    js.destroy(); receiver.destroy(); safe.destroy(); await request('v2-regression', 'close');
  });

  await check('local undo/redo preserves concurrent remote edits and formatting', async () => {
    await open('undo', 301); const js = jsDoc(302);
    const manager = new Y.UndoManager(js.getXmlFragment('default'), { trackedOrigins: new Set(['js-local']), captureTimeout: 0 });
    await request('undo', 'edit', { edit: { operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '本地' } });
    jsEdit(js, { operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '远端' });
    const nativeUpdate = decoded(await request('undo', 'export', { stateVector: encoded(Y.encodeStateVector(js)) }));
    await request('undo', 'apply', { update: encoded(Y.encodeStateAsUpdate(js)) });
    Y.applyUpdate(js, nativeUpdate, 'remote');
    assert.deepEqual(await state('undo'), semantic(js));
    assert.equal(await request('undo', 'undo'), true);
    const baseline = jsDoc(309); const original = plain(baseline); baseline.destroy();
    const afterUndo = await exportToJS('undo');
    assert.equal(plain(afterUndo), `远端${original}`);
    assert.equal(await request('undo', 'undo'), false, 'Remote edit must never enter local undo history');
    assert.equal(await request('undo', 'redo'), true);
    assert.deepEqual(await state('undo'), semantic(js));
    manager.undo();
    await request('undo', 'apply', { update: encoded(Y.encodeStateAsUpdate(js)) });
    const nativeOnly = await exportToJS('undo');
    assert.equal(plain(nativeOnly), `本地${original}`);
    manager.redo();
    await request('undo', 'apply', { update: encoded(Y.encodeStateAsUpdate(js)) });
    assert.deepEqual(await state('undo'), semantic(js));
    const beforeFormat = await state('undo');
    await request('undo', 'edit', { edit: { operation: 'format', block: 'fixture-paragraph', offset: 0, length: 4, attributes: { bold: {}, underline: {} } } });
    const formatted = await state('undo'); assert.notDeepEqual(formatted, beforeFormat);
    assert.equal(await request('undo', 'undo'), true); assert.deepEqual(await state('undo'), beforeFormat);
    assert.equal(await request('undo', 'redo'), true); assert.deepEqual(await state('undo'), formatted);
    afterUndo.destroy(); nativeOnly.destroy(); manager.destroy(); js.destroy(); await request('undo', 'close');
  });

  await check('empty paragraphs keep metadata, accept first input and preserve start/end affinity', async () => {
    const js = jsDoc(550);
    const empty = new Y.XmlElement('paragraph'); empty.setAttribute('id', 'empty'); empty.setAttribute('future', { intact: true });
    js.getXmlFragment('default').push([empty]);
    await open('empty', 551, Y.encodeStateAsUpdate(js));
    assert.deepEqual(await state('empty'), semantic(js));
    const start = await request('empty', 'anchor', { block: 'empty', offset: 0, before: true });
    const end = await request('empty', 'anchor', { block: 'empty', offset: 0, before: false });
    for (const anchor of [start, end]) {
      assert.equal(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(decoded(anchor)), js).index, 0);
    }
    const edit = { operation: 'insert', block: 'empty', offset: 0, text: '第一笔 👩🏽‍🚀' };
    await request('empty', 'edit', { edit }); jsEdit(js, edit);
    assert.deepEqual(await state('empty'), semantic(js));
    assert.deepEqual(await request('empty', 'resolve', { anchor: start }), { block: 'empty', offset: 0 });
    assert.deepEqual(await request('empty', 'resolve', { anchor: end }), { block: 'empty', offset: edit.text.length });
    assert.equal(await request('empty', 'undo'), true);
    assert.deepEqual(await request('empty', 'resolve', { anchor: end }), { block: 'empty', offset: 0 });
    assert.equal(await request('empty', 'redo'), true);
    assert.deepEqual(await state('empty'), semantic(js));
    js.destroy(); await request('empty', 'close');
  });

  await check('reordered duplicate updates and pending deletions survive snapshot reload', async () => {
    const js = jsDoc(401); const updates = [];
    js.on('update', update => updates.push(update));
    jsEdit(js, { operation: 'appendParagraph', id: 'late', text: '等待因果更新' });
    jsEdit(js, { operation: 'insert', block: 'late', offset: 2, text: '👩🏽‍🚀' });
    jsEdit(js, { operation: 'delete', block: 'late', offset: 0, length: 2 });
    for (const encoding of [1, 2]) {
      await open('reorder', 410 + encoding, null);
      for (const update of [updates[2], updates[1], updates[1]]) await request('reorder', 'apply', {
        update: encoded(encoding === 1 ? update : Y.convertUpdateFormatV1ToV2(update)), encoding,
      });
      assert.equal((await request('reorder', 'state')).pending, true);
      const saved = decoded(await request('reorder', 'export'));
      await request('reorder', 'close');
      await open('reorder', 420 + encoding, saved);
      for (const update of [updates[0], base, updates[0], updates[2]]) await request('reorder', 'apply', { update: encoded(update) });
      assert.equal((await request('reorder', 'state')).pending, false);
      assert.deepEqual(await state('reorder'), semantic(js));
      const received = await exportToJS('reorder', 430 + encoding);
      assert.deepEqual(semantic(received), semantic(js)); received.destroy(); await request('reorder', 'close');
    }
    js.destroy();
  });

  await check('sparse dependencies replay across all update orders, encodings and pending checkpoints before further local/remote editing', async () => {
    const source = jsDoc(14001);
    const updates = [];
    source.on('update', update => updates.push(update));
    jsEdit(source, { operation: 'insert', block: 'fixture-paragraph', offset: 0, text: 'A' });
    jsEdit(source, { operation: 'insert', block: 'fixture-paragraph', offset: 1, text: 'B' });
    source.getText('independent-root').insert(0, 'C');
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let scenario = 0;
    for (const encoding of [1, 2]) {
      for (const order of orders) {
        for (const restartAfter of [0, 1, 2]) {
          const name = 'sparse-replay';
          const expected = jsDoc(15000 + scenario++, Y.encodeStateAsUpdate(source));
          await open(name, 16000 + scenario);
          for (const [step, index] of order.entries()) {
            const update = encoded(encoding === 1 ? updates[index] : Y.convertUpdateFormatV1ToV2(updates[index]));
            await request(name, 'apply', {update, encoding});
            await request(name, 'apply', {update, encoding});
            if (step + 1 === restartAfter) {
              const checkpoint = decoded(await request(name, 'export'));
              await request(name, 'close');
              await open(name, 17000 + scenario, checkpoint);
            }
          }
          const converged = await request(name, 'state');
          assert.equal(converged.pending, false, `encoding ${encoding}, order ${order}, restart ${restartAfter}`);
          assert.deepEqual(canonical(converged.semantic), semantic(expected));
          assert.deepEqual(Y.decodeStateVector(decoded(converged.stateVector)), Y.decodeStateVector(Y.encodeStateVector(expected)));
          assert.equal(await request(name, 'undo'), false, 'Replay must not enter local history');
          await request(name, 'edit', { edit: {operation: 'insert', block: 'fixture-paragraph', offset: 2, text: '原生👩🏽‍🚀'} });
          const nativeUpdate = decoded(await request(name, 'export', {stateVector: encoded(Y.encodeStateVector(expected))}));
          const beforeRemote = Y.encodeStateVector(expected);
          jsEdit(expected, {operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '远端'});
          const remoteOnly = semantic(expected);
          await request(name, 'apply', {update: encoded(Y.encodeStateAsUpdate(expected, beforeRemote))});
          Y.applyUpdate(expected, nativeUpdate, 'remote');
          assert.deepEqual(await state(name), semantic(expected));
          assert.equal(await request(name, 'undo'), true);
          assert.deepEqual(await state(name), remoteOnly);
          assert.equal(await request(name, 'redo'), true);
          assert.deepEqual(await state(name), semantic(expected));
          const checkpoint = decoded(await request(name, 'export'));
          await request(name, 'close');
          await open(name, 18000 + scenario, checkpoint);
          assert.equal((await request(name, 'state')).pending, false);
          assert.deepEqual(await state(name), semantic(expected));
          const receiver = await exportToJS(name);
          assert.equal(receiver.getText('independent-root').toString(), 'C');
          receiver.destroy(); expected.destroy(); await request(name, 'close');
        }
      }
    }
    source.destroy();
  }, { arrivalOrders: 6, encodings: [1, 2], restartStages: [0, 1, 2], scenarios: 36 });

  await check('Yjs relative positions and native anchors agree after insert, delete and parent removal', async () => {
    await open('anchor', 501); const js = jsDoc(502);
    for (const before of [false, true]) {
      for (const offset of [0, 5, 7, 16, plain(js).length]) {
        const nativeAnchor = decoded(await request('anchor', 'anchor', { block: 'fixture-paragraph', offset, before }));
        const jsAnchor = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text(js), offset, before ? -1 : 0));
        assert.deepEqual(await request('anchor', 'resolve', { anchor: encoded(jsAnchor) }), { block: 'fixture-paragraph', offset });
        assert.equal(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(nativeAnchor), js).index, offset);
      }
    }
    const anchor = await request('anchor', 'anchor', { block: 'fixture-paragraph', offset: 5 });
    for (const edit of [{ operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '前缀👩🏽‍🚀' },
      { operation: 'delete', block: 'fixture-paragraph', offset: 0, length: 2 }]) {
      jsEdit(js, edit); await request('anchor', 'apply', { update: encoded(Y.encodeStateAsUpdate(js)) });
      const resolved = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(decoded(anchor)), js);
      assert.deepEqual(await request('anchor', 'resolve', { anchor }), { block: 'fixture-paragraph', offset: resolved.index });
    }
    jsEdit(js, { operation: 'deleteBlock', block: 'fixture-paragraph' });
    await request('anchor', 'apply', { update: encoded(Y.encodeStateAsUpdate(js)) });
    assert.equal(await request('anchor', 'resolve', { anchor }), null);
    js.destroy(); await request('anchor', 'close');
  });

  await check('invalid edits preserve the full document and unsupported nodes remain intact', async () => {
    await open('invalid', 601);
    const saved = await request('invalid', 'export');
    for (const edit of [
      { operation: 'insert', block: 'fixture-paragraph', offset: 9, text: 'bad' },
      { operation: 'delete', block: 'fixture-paragraph', offset: 999999, length: 1 },
      { operation: 'insert', block: 'fixture-opaque', offset: 0, text: 'bad' },
      { operation: 'deleteBlock', block: 'fixture-opaque' },
      { operation: 'setAttribute', block: 'fixture-heading', key: 'id', value: 'replacement' },
    ]) {
      await assert.rejects(request('invalid', 'edit', { edit }));
      assert.equal(await request('invalid', 'export'), saved);
    }
    assert.equal(await request('invalid', 'undo'), false);
    await request('invalid', 'close');
  });

  await check('seeded concurrent UTF-16 edits converge through incremental and duplicate exchanges', async () => {
    const tokens = ['合成', '𠮷', '👩🏽‍🚀', 'e\u0301', 'שלום', '👨‍👩‍👧‍👦', '\n', 'A'];
    for (let seed = 1; seed <= 24; seed++) {
      let random = seed;
      const next = max => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % max; };
      const js = jsDoc(7000 + seed); await open('fuzz', 8000 + seed);
      const trace = [];
      try {
        for (let round = 0; round < 12; round++) {
          for (const owner of ['native', 'js']) {
            const view = owner === 'native' ? await exportToJS('fuzz') : js;
            const value = plain(view); const boundaries = [0];
            for (const ch of value) boundaries.push(boundaries.at(-1) + ch.length);
            const start = next(boundaries.length); const offset = boundaries[start];
            let edit;
            const kind = next(3);
            if (kind === 0 || start === boundaries.length - 1) edit = { operation: 'insert', block: 'fixture-paragraph', offset, text: tokens[next(tokens.length)] };
            else {
              const length = boundaries[start + 1 + next(boundaries.length - start - 1)] - offset;
              edit = kind === 1 ? { operation: 'delete', block: 'fixture-paragraph', offset, length }
                : { operation: 'format', block: 'fixture-paragraph', offset, length, attributes: { italic: next(2) ? {} : null } };
            }
            trace.push({ round, owner, edit });
            if (owner === 'native') { await request('fuzz', 'edit', { edit }); view.destroy(); } else jsEdit(js, edit);
          }
          const nativeVector = (await request('fuzz', 'state')).stateVector;
          const nativeUpdate = decoded(await request('fuzz', 'export', { stateVector: encoded(Y.encodeStateVector(js)) }));
          const jsUpdate = encoded(Y.encodeStateAsUpdate(js, decoded(nativeVector)));
          await request('fuzz', 'apply', { update: jsUpdate }); await request('fuzz', 'apply', { update: jsUpdate });
          Y.applyUpdate(js, nativeUpdate, 'remote'); Y.applyUpdate(js, nativeUpdate, 'remote');
          assert.deepEqual(await state('fuzz'), semantic(js));
          assert.deepEqual(Y.decodeStateVector(decoded((await request('fuzz', 'state')).stateVector)), Y.decodeStateVector(Y.encodeStateVector(js)));
        }
      } catch (error) { throw new Error(`Concurrent seed ${seed}: ${error.message}; trace=${JSON.stringify(trace)}`); }
      finally { js.destroy(); await request('fuzz', 'close'); }
    }
  }, { seeds: 24, roundsPerSeed: 12, authoredOperations: 576 });

  await check('native UTF-16 projection and atomic replacement preserve marks, anchors and opaque metadata', async () => {
    await open('native-view', 9001);
    const js = jsDoc(9002);
    const view = await request('native-view', 'projection');
    const paragraph = view.blocks.find(block => block.id === 'fixture-paragraph');
    assert.equal(view.text.slice(paragraph.range.location, paragraph.range.location + paragraph.range.length), plain(js));
    assert.equal(view.blocks.find(block => block.id === 'fixture-opaque').editable, false);
    assert.equal(view.blocks.find(block => block.id === 'fixture-list-paragraph').depth, 2);
    const anchor = await request('native-view', 'anchor', { block: 'fixture-paragraph', offset: 5 });
    const oldVector = Y.encodeStateVector(js);
    const edited = await request('native-view', 'replace', { edit: { revision: view.revision,
      range: { location: paragraph.range.location, length: 2 }, text: '合成𠮷' } });
    Y.applyUpdate(js, decoded(await request('native-view', 'export', { stateVector: encoded(oldVector) })));
    assert.deepEqual(await state('native-view'), semantic(js));
    assert.equal(plain(js), '合成𠮷员来到北塔。👩🏽‍🚀 é 𠮷 שלום');
    assert.deepEqual(findBlock(js, 'fixture-paragraph').getAttribute('nativeUnknownAttribute'), { keep: true, revision: 3 });
    assert.equal(text(js).toDelta().find(part => part.insert === '北塔').attributes.entityLink.targetId, 'fixture-element');
    assert.deepEqual(await request('native-view', 'resolve', { anchor }), { block: 'fixture-paragraph', offset: 7 });
    const saved = await request('native-view', 'export');
    for (const edit of [
      { revision: view.revision, range: { location: 0, length: 0 }, text: 'stale' },
      { revision: edited.revision, range: { location: edited.blocks[1].range.location + edited.blocks[1].range.length, length: 1 }, text: '' },
      { revision: edited.revision, range: { location: paragraph.range.location, length: 0 }, text: '\r' },
      { revision: edited.revision, range: { location: paragraph.range.location + 3, length: 0 }, text: 'surrogate' },
    ]) {
      await assert.rejects(request('native-view', 'replace', { edit }));
      assert.equal(await request('native-view', 'export'), saved);
    }
    assert.equal(await request('native-view', 'undo'), true);
    assert.equal((await request('native-view', 'projection')).text, view.text);
    assert.equal(await request('native-view', 'undo'), false);
    assert.equal(await request('native-view', 'redo'), true);
    assert.equal((await request('native-view', 'projection')).text, edited.text);
    js.destroy(); await request('native-view', 'close');
  });

  const structuralCases = { accepted: 0, retainedWithoutMutation: 0, oracle: 'actual chapter schema + ProseMirror + existing BlockId plugin' };
  let structuralDefaults;
  await check('supported structural replacements agree with the real chapter schema; unsafe relocation is retained atomically', async () => {
    const oracle = JSON.parse(run('pnpm', ['exec', 'tsx', 'scripts/apple-structure-oracle.ts']));
    structuralDefaults = oracle.defaults;
    assert(oracle.cases.length >= 38, 'Structural corpus lost expected cases');
    for (const [index, test] of oracle.cases.entries()) {
      await open('structure-oracle', 11000 + index, decoded(test.updateBase64));
      const before = await request('structure-oracle', 'projection');
      if (test.rejection) {
        const saved = await request('structure-oracle', 'export');
        await assert.rejects(request('structure-oracle', 'replace', {edit: {
          revision: before.revision, range: test.range, text: test.text,
        }}), error => error.message.includes(test.rejection));
        assert.equal(await request('structure-oracle', 'export'), saved, test.name);
        assert.deepEqual(await request('structure-oracle', 'projection'), before, test.name);
        assert.equal(await request('structure-oracle', 'undo'), false, test.name);
        structuralCases.retainedWithoutMutation++;
        await request('structure-oracle', 'close');
        continue;
      }
      const initialIds = new Set(before.blocks.map(block => block.id));
      // Containers also have stable IDs even though the text view flattens them.
      const collect = node => { if (node.attrs?.id) initialIds.add(node.attrs.id); node.content?.forEach(collect); };
      collect(test.before);
      const normalize = value => {
        let nextId = 0;
        const walk = node => {
          const result = structuredClone(node);
          if (result.type !== 'text') {
            result.attrs = { ...oracle.defaults[result.type], ...result.attrs };
            if (result.attrs.id && !initialIds.has(result.attrs.id)) {
              assert.match(result.attrs.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
              result.attrs.id = `new-${nextId++}`;
            }
            if (Object.keys(result.attrs).length === 0) delete result.attrs;
          }
          if (result.content?.length) result.content = result.content.map(walk);
          else delete result.content;
          if (result.marks) result.marks = result.marks.map(mark => {
            mark.type = mark.type.replace(/--[a-zA-Z0-9+/=]{8}$/u, '');
            if (mark.attrs && Object.keys(mark.attrs).length === 0) delete mark.attrs;
            return mark;
          }).sort((a, b) => a.type.localeCompare(b.type, 'en'));
          return result;
        };
        return walk(value);
      };
      await request('structure-oracle', 'replace', { edit: {revision: before.revision, range: test.range, text: test.text} });
      const actual = await state('structure-oracle');
      assert.deepEqual(normalize(actual), normalize(test.expected), test.name);
      const peer = await exportToJS('structure-oracle', 12000 + index);
      assert.deepEqual(normalize(semantic(peer)), normalize(actual), `Yjs receives ${test.name}`);
      // The PM semantic helper decodes overlapping mark names. Also compare
      // the raw Yjs wire marks so normalization cannot hide lost hash keys.
      const projected = await request('structure-oracle', 'projection');
      for (const block of projected.blocks) {
        const element = findBlock(peer, block.id);
        const runs = element.get(0)?.toDelta() ?? [];
        assert.deepEqual(runs.map(run => ({text: run.insert, attributes: run.attributes ?? {}})),
          block.runs.map(run => ({text: projected.text.slice(run.range.location, run.range.location + run.range.length), attributes: run.attributes})),
          `Raw marks survive Yjs exchange: ${test.name}`);
      }
      assert.equal(await request('structure-oracle', 'undo'), true);
      const restored = await state('structure-oracle');
      assert.deepEqual(normalize(restored), normalize(test.before), `one undo: ${test.name}`);
      assert.equal(await request('structure-oracle', 'undo'), false, `one undo unit: ${test.name}`);
      assert.equal(await request('structure-oracle', 'redo'), true);
      assert.deepEqual(await state('structure-oracle'), actual, `stable IDs after redo: ${test.name}`);
      peer.destroy(); await request('structure-oracle', 'close');
      structuralCases.accepted++;
    }
  }, structuralCases);

  let quoteHistoryOracle;
  const quoteHistoryDetails = { scenarios: 0, stages: 0, independentCheckpointReopens: 0,
    oracle: 'production @tiptap/y-tiptap updateYFragment and defaultDeleteFilter',
    identityScope: 'original right wrapper, joined paragraph and unselected suffix physical Y.Item IDs',
    oldClientDiagnostics: 'recorded separately; not native acceptance expectations' };
  const originalPrefixAcceptance = { name: 'late original-left quote prefix edits after copying',
    classification: 'scoped-native-acceptance', status: 'not-run',
    scope: 'Unformatted insertion in the retained original-left prefix of the two supported right-survivor quote shapes; mixed safe suffix text retains its original identity when authored by another writer or after the prefix on the same writer.',
    mechanism: 'Persistent source-clock aliases, deterministic canonical strings and receipt-owned history renders; original XML objects are not cloned.',
    scenarios: [], mixedPackets: [] };
  await check('quote boundary history matches production binding semantics while retaining original right suffix items across remote edits and independent checkpoint reopens', async () => {
    const oracle = JSON.parse(run('pnpm', ['exec', 'tsx', '--conditions=import', 'scripts/apple-quote-history-oracle.ts']));
    assert.equal(oracle.schemaVersion, 1);
    assert.equal(oracle.source, quoteHistoryDetails.oracle);
    quoteHistoryOracle = oracle;
    assert.deepEqual(oracle.cases.map(test => test.name), [
      'join adjacent quotes preserving right suffix identity',
      'delete across adjacent quotes preserving right suffix identity',
    ], 'Expected both bounded identity-preserving quote cases');
    assert(structuralDefaults, 'The actual chapter schema defaults must be available');
    const normalize = value => {
      const node = structuredClone(value);
      if (node.type !== 'text') {
        node.attrs = { ...structuralDefaults[node.type], ...node.attrs };
        if (Object.keys(node.attrs).length === 0) delete node.attrs;
      }
      if (node.content?.length) node.content = node.content.map(normalize);
      else delete node.content;
      return canonical(node);
    };
    const itemId = node => {
      assert(node._item, 'Expected an integrated physical Y.Item');
      return `${node._item.id.client}:${node._item.id.clock}`;
    };
    for (const [caseIndex, test] of oracle.cases.entries()) {
      const name = `quote-history-${caseIndex}`;
      await open(name, 31000 + caseIndex, decoded(test.updateBase64));
      const initial = await request(name, 'projection');
      assert.deepEqual(test.stages.map(stage => stage.action), ['joined', 'apply', 'undo', 'apply', 'redo', 'undo', 'redo']);
      await request(name, 'replace', { edit: { revision: initial.revision, range: test.range, text: test.text } });
      const inspectCheckpoint = (peer, stage, label) => {
        assert.deepEqual(normalize(semantic(peer)), normalize(stage.semantic), `${label}: Yjs semantics`);
        const suffix = findBlock(peer, 'd');
        assert.equal(itemId(suffix), test.identities.suffix, `${label}: original unselected suffix identity`);
        assert.equal(itemId(suffix), stage.suffix.itemId, `${label}: oracle suffix identity`);
        assert.equal(text(peer, 'd').toString(), stage.suffix.text, `${label}: remote suffix prose`);
        assert.deepEqual(suffix.getAttributes(), stage.suffix.attributes, `${label}: remote suffix metadata`);
        // The native join changes the logical IDs on the retained right
        // objects. Undo restores those IDs without replacing their CRDT items.
        const joined = stage.semantic.content.length === 1;
        const wrapper = findBlock(peer, joined ? 'qleft' : 'qright');
        const joinedBlock = findBlock(peer, joined ? 'b' : 'c');
        assert.equal(itemId(wrapper), test.identities.wrapper, `${label}: original right wrapper identity`);
        assert.equal(itemId(joinedBlock), test.identities.joinedBlock, `${label}: original right paragraph identity`);
        assert.equal(suffix._item.parent, wrapper, `${label}: suffix parent never relocated`);
      };
      for (const [stageIndex, stage] of test.stages.entries()) {
        const label = `${test.name}/${stageIndex}/${stage.name}`;
        if (stage.action === 'apply') {
          await request(name, 'apply', { update: stage.updateBase64 });
        } else if (stage.action !== 'joined') {
          assert.equal(await request(name, stage.action), true, `${label}: history action`);
        }
        const current = await state(name);
        assert.deepEqual(normalize(current), normalize(stage.semantic), `${label}: native semantics`);
        const checkpoint = decoded(await request(name, 'export'));
        const peer = jsDoc(32000 + stageIndex, checkpoint);
        try {
          inspectCheckpoint(peer, stage, label);
          Y.applyUpdate(peer, checkpoint, 'duplicate-checkpoint');
          inspectCheckpoint(peer, stage, `${label}/duplicate`);
        } finally { peer.destroy(); }

        // Export-to-JS alone does not prove native restart. Reopen every
        // stage into a separate Rust session with a distinct local client ID.
        const reopened = `${name}-checkpoint-${stageIndex}`;
        await open(reopened, 33000 + stageIndex, checkpoint);
        try {
          assert.deepEqual(await state(reopened), current, `${label}: independent Rust restart semantics`);
          assert.equal(await request(reopened, 'undo'), false, `${label}: checkpoint did not import local undo history`);
          const reopenedPeer = await exportToJS(reopened, 34000 + stageIndex);
          try { inspectCheckpoint(reopenedPeer, stage, `${label}/reopened`); }
          finally { reopenedPeer.destroy(); }
        } finally { await request(reopened, 'close'); }
        quoteHistoryDetails.stages++;
        quoteHistoryDetails.independentCheckpointReopens++;
      }
      await request(name, 'close');
      quoteHistoryDetails.scenarios++;

      // The unsynchronized author still writes into original b. This scoped
      // acceptance is separate from the unchanged 14-stage production oracle:
      // the old binding itself did not preserve this late original-b text.
      const delayedName = `${name}-original-left`;
      await open(delayedName, 35000 + caseIndex, decoded(test.updateBase64));
      const delayedBefore = await request(delayedName, 'projection');
      await request(delayedName, 'replace', { edit: { revision: delayedBefore.revision, range: test.range, text: test.text } });
      const delayedPeer = jsDoc(36000 + caseIndex, decoded(test.updateBase64));
      const receivingPeer = jsDoc(36500 + caseIndex, decoded(test.updateBase64));
      const stages = [];
      try {
        const joinedBefore = await request(delayedName, 'projection');
        const joinedCheckpoint = decoded(await request(delayedName, 'export'));
        const basis = Y.encodeStateVector(delayedPeer);
        text(delayedPeer, 'b').insert(0, '保');
        const update = Y.encodeStateAsUpdate(delayedPeer, basis);
        const oldFullState = Y.encodeStateAsUpdate(delayedPeer);
        Y.applyUpdate(receivingPeer, update, 'original-author');
        await request(delayedName, 'apply', { update: encoded(update) });
        assert.equal((await request(delayedName, 'projection')).text, `保${joinedBefore.text}`);

        // This receiver has no in-memory alias/history. Its independently
        // generated repair must converge with the still-open history owner.
        const coldName = `${delayedName}-cold-before-receive`;
        await open(coldName, 37000 + caseIndex, joinedCheckpoint);
        try {
          await request(coldName, 'apply', { update: encoded(oldFullState) });
          assert.equal((await request(coldName, 'projection')).text, `保${joinedBefore.text}`);
          const coldRepair = await request(coldName, 'export');
          const liveRepair = await request(delayedName, 'export');
          await request(coldName, 'apply', { update: liveRepair });
          await request(delayedName, 'apply', { update: coldRepair });
          assert.deepEqual(await state(coldName), await state(delayedName), 'Independent alias materializers converge');
        } finally { await request(coldName, 'close'); }

        for (const [stageIndex, action] of ['joined', 'undo', 'redo', 'undo', 'redo'].entries()) {
          if (action !== 'joined') assert.equal(await request(delayedName, action), true);
          const projection = await request(delayedName, 'projection');
          const expected = `保${action === 'undo' ? delayedBefore.text : joinedBefore.text}`;
          assert.equal(projection.text, expected, `Routed prefix survives ${action}`);
          assert.equal(projection.text.split('保').length - 1, 1, 'One canonical/rendered copy of the original character');
          // Same raw event and the old full state are both idempotent, even
          // after a new history incarnation has rendered the retained text.
          const saved = await request(delayedName, 'export');
          await request(delayedName, 'apply', { update: encoded(update) });
          await request(delayedName, 'apply', { update: encoded(oldFullState) });
          assert.equal(await request(delayedName, 'export'), saved, 'Duplicate source clocks do not allocate another render');
          const current = await state(delayedName), checkpoint = decoded(saved);
          Y.applyUpdate(receivingPeer, checkpoint, `native-${action}`);
          assert.deepEqual(normalize(semantic(receivingPeer)), normalize(current), 'An existing Yjs peer receives the same repaired history');
          const ids = new Set();
          const collect = node => {
            if (node.attrs?.id) { assert(!ids.has(node.attrs.id), `Duplicate public ID ${node.attrs.id}`); ids.add(node.attrs.id); }
            node.content?.forEach(collect);
          };
          collect(current);
          assert.equal(itemId(findBlock(receivingPeer, 'd')), test.identities.suffix);
          assert.equal(itemId(findBlock(receivingPeer, action === 'undo' ? 'c' : 'b')), test.identities.joinedBlock);
          const sourceEvidence = [...receivingPeer.getMap('drifting.native.relocation-alias.v1').entries()]
            .filter(([key]) => key.startsWith('source/')).map(([, value]) => JSON.parse(value));
          assert(sourceEvidence.some(value => value.text === '保'), 'Original source payload remains durable after integration');

          const reopened = `${delayedName}-stage-${stageIndex}`;
          await open(reopened, 37500 + caseIndex * 10 + stageIndex, checkpoint);
          try {
            assert.deepEqual(await state(reopened), current);
            await request(reopened, 'apply', { update: encoded(oldFullState) });
            assert.deepEqual(await state(reopened), current, 'Duplicate full state remains idempotent after checkpoint reopen');
            assert.equal(await request(reopened, 'undo'), false, 'Checkpoint does not import local undo history');
            const reader = await exportToJS(reopened, 38000 + stageIndex);
            try { assert.deepEqual(normalize(semantic(reader)), normalize(current)); }
            finally { reader.destroy(); }
          } finally { await request(reopened, 'close'); }
          stages.push({ action, visibleText: projection.text, remotePrefixVisible: true,
            delivery: 'automatically-routed', yjsConverged: true, duplicateIdempotent: true, checkpointReopened: true });
        }
      } finally { delayedPeer.destroy(); receivingPeer.destroy(); await request(delayedName, 'close'); }
      originalPrefixAcceptance.scenarios.push({ operation: test.name, range: test.range, stages });

      for (const sameWriter of [true, false]) {
        const mixedName = `${name}-mixed-${sameWriter}`;
        const client = 39000 + caseIndex * 100 + (sameWriter ? 0 : 10);
        await open(mixedName, client, decoded(test.updateBase64));
        const before = await request(mixedName, 'projection');
        await request(mixedName, 'replace', {edit: {revision: before.revision, range: test.range, text: test.text}});
        const joinedText = (await request(mixedName, 'projection')).text;
        const anchor = await request(mixedName, 'anchor', {block: 'd', offset: 1});
        await request(mixedName, 'setComments', {records: [{id: 'mixed-suffix-comment', targetBlockId: 'd',
          targetBlockIdsJson: '["d"]', anchorJson: JSON.stringify({future: {keep: true}, selectedText: '章',
            textAnchor: {startBlockId: 'd', startOffset: 1, endBlockId: 'd', endOffset: 2, text: '章'}})}]});
        const author = jsDoc(client + 1, decoded(test.updateBase64));
        const suffixAuthor = sameWriter ? author : jsDoc(client + 2, decoded(test.updateBase64));
        const legacy = jsDoc(client + 3, decoded(test.updateBase64));
        const mixedStages = [];
        try {
          const prefixBasis = Y.encodeStateVector(author), suffixBasis = Y.encodeStateVector(suffixAuthor);
          author.transact(() => {
            text(author, 'b').insert(0, '并');
            if (sameWriter) text(author, 'd').insert(1, '合');
          });
          if (!sameWriter) text(suffixAuthor, 'd').insert(1, '合');
          const raw = sameWriter ? Y.encodeStateAsUpdate(author, prefixBasis)
            : Y.mergeUpdates([Y.encodeStateAsUpdate(author, prefixBasis), Y.encodeStateAsUpdate(suffixAuthor, suffixBasis)]);
          const full = sameWriter ? Y.encodeStateAsUpdate(author)
            : Y.mergeUpdates([Y.encodeStateAsUpdate(author), Y.encodeStateAsUpdate(suffixAuthor)]);
          Y.applyUpdate(legacy, raw);
          const safeCharacter = Y.createRelativePositionFromTypeIndex(text(legacy, 'd'), 1);
          const safeTextType = itemId(text(legacy, 'd'));
          await request(mixedName, 'apply', {update: encoded(raw)});
          for (const [stageIndex, action] of ['joined', 'undo', 'redo', 'undo', 'redo'].entries()) {
            if (action !== 'joined') assert.equal(await request(mixedName, action), true);
            const projection = await request(mixedName, 'projection');
            const expected = `并${(action === 'undo' ? before.text : joinedText).replace('终章', '终合章')}`;
            assert.equal(projection.text, expected, 'Mixed safe text and late prefix survive history together');
            assert.deepEqual(await request(mixedName, 'resolve', {anchor}), {block: 'd', offset: 2});
            const comment = projection.comments.find(value => value.id === 'mixed-suffix-comment');
            assert.equal(comment.status, 'anchored');
            assert.equal(comment.quote, '章');
            const d = projection.blocks.find(value => value.id === 'd');
            assert.deepEqual(comment.ranges, [{location: d.range.location + 2, length: 1}]);
            const saved = await request(mixedName, 'export');
            await request(mixedName, 'apply', {update: encoded(raw)});
            await request(mixedName, 'apply', {update: encoded(full)});
            assert.equal(await request(mixedName, 'export'), saved, 'Mixed duplicate clocks do not author another repair');
            Y.applyUpdate(legacy, decoded(saved));
            assert.deepEqual(normalize(semantic(legacy)), normalize(await state(mixedName)));
            assert.equal(itemId(findBlock(legacy, 'd')), test.identities.suffix);
            assert.equal(itemId(text(legacy, 'd')), safeTextType);
            const absolute = Y.createAbsolutePositionFromRelativePosition(safeCharacter, legacy);
            assert(absolute && absolute.type === text(legacy, 'd') && absolute.index === 1,
              'Safe suffix insertion must retain its original Yjs character identity');
            const evidence = [...legacy.getMap('drifting.native.relocation-alias.v1').entries()]
              .filter(([key]) => key.startsWith('source/')).map(([, value]) => JSON.parse(value));
            assert(evidence.some(value => value.text === '并'));
            assert(!evidence.some(value => value.text.includes('合')), 'Safe suffix text must not enter relocation evidence');
            const reopened = `${mixedName}-reopen-${stageIndex}`;
            await open(reopened, client + 20 + stageIndex, decoded(saved));
            try {
              await request(reopened, 'apply', {update: encoded(full)});
              assert.deepEqual(await state(reopened), await state(mixedName));
              assert.deepEqual(await request(reopened, 'resolve', {anchor}), {block: 'd', offset: 2});
            } finally { await request(reopened, 'close'); }
            mixedStages.push({action, yjsConverged: true, safeItemIdentity: true, commentsAndAnchor: true, checkpointReopened: true});
          }
        } finally {
          author.destroy(); if (!sameWriter) suffixAuthor.destroy(); legacy.destroy();
          await request(mixedName, 'close');
        }
        originalPrefixAcceptance.mixedPackets.push({operation: test.name,
          writers: sameWriter ? 'one-prefix-before-suffix' : 'independent', stages: mixedStages});
      }
    }
    assert.equal(originalPrefixAcceptance.scenarios.length, 2);
    assert.equal(originalPrefixAcceptance.mixedPackets.length, 4);
    originalPrefixAcceptance.status = 'passed';
    report.relocationAliasAcceptance = originalPrefixAcceptance;
    report.oldClientDiagnostics = oracle.diagnostics.map(diagnostic => {
      assert.equal(diagnostic.classification, 'diagnostic-only-not-native-acceptance');
      return { name: diagnostic.name, classification: diagnostic.classification,
        source: oracle.source, reason: diagnostic.reason, observations: diagnostic.observations };
    });
  }, quoteHistoryDetails);

  const safeClockGaps = { status: 'running', scope: 'One alias in either supported right-survivor quote shape; original plain prefix strings separated by exactly proved live non-alias string clocks.',
    mechanism: 'Persistent exact UTF-16 skip receipts; source evidence keeps sparse original clocks across history, while only proved canonical gaps become GC.',
    boundaries: { independentBFirst: 'atomic-retention-refusal-until-complete-closure',
      ownerBlockedRowLookahead: 'not-implemented', novelFormatOrDelete: 'retention-refusal', unknownHole: 'retention-refusal',
      aliasGraphText: 'not-safe-gap-proof', residualPendingWithLostText: 'atomic-retention-refusal' },
    scenarios: [], negativeCases: [] };
  await check('proved safe clock gaps preserve original suffix identities across Yjs exchange, delivery boundaries and native history', async () => {
    assert(quoteHistoryOracle && structuralDefaults);
    const normalize = value => {
      const node = structuredClone(value);
      if (node.type !== 'text') {
        node.attrs = { ...structuralDefaults[node.type], ...node.attrs };
        if (!Object.keys(node.attrs).length) delete node.attrs;
      }
      if (node.content?.length) node.content = node.content.map(normalize); else delete node.content;
      return canonical(node);
    };
    const itemId = node => `${node._item.id.client}:${node._item.id.clock}`;
    const suffixValue = '远🙂e\u0301';
    const metadataRoot = 'drifting.native.relocation-alias.v1';
    const metadata = (doc, prefix) => [...doc.getMap(metadataRoot)].filter(([key]) => key.startsWith(prefix)).map(([, value]) => JSON.parse(value));
    const record = (id, block, start, end, quote) => ({ id, targetBlockId: block,
      targetBlockIdsJson: JSON.stringify([block]), anchorJson: JSON.stringify({future: {keep: 'safe-clock-gap'},
        selectedText: quote, textAnchor: {startBlockId: block, startOffset: start, endBlockId: block, endOffset: end, text: quote}}) });
    const assertComments = async (name, quotes) => {
      const projection = await request(name, 'projection');
      for (const [id, quote] of Object.entries(quotes)) {
        const comment = projection.comments.find(value => value.id === id);
        assert.equal(comment?.status, 'anchored'); assert.equal(comment.quote, quote);
        assert.equal(comment.ranges.map(range => projection.text.slice(range.location, range.location + range.length)).join(''), quote);
      }
      for (const value of await request(name, 'comments')) assert.deepEqual(JSON.parse(value.anchorJson).future, {keep: 'safe-clock-gap'});
      return projection;
    };
    for (const [caseIndex, test] of quoteHistoryOracle.cases.entries()) {
      for (const pattern of ['d→b', 'b→d→b']) {
        const deliveries = pattern === 'd→b' ? ['complete', 'normal-split', 'independent-b-refused-then-closure']
          : ['complete', 'normal-split', 'dependent-b-pending-then-closure'];
        for (const delivery of deliveries) {
          const index = safeClockGaps.scenarios.length, client = 500000 + index * 100;
          const name = `safe-gaps-${caseIndex}-${index}`;
          const seed = jsDoc(client + 80, decoded(test.updateBase64));
          // All formats and metadata predate the alias: no novel Format item
          // is allowed merely because a packet also contains safe text.
          text(seed, 'd').format(0, 2, {bold: true});
          text(seed, 'd').setAttribute('futureGapText', {keep: true, version: 1});
          findBlock(seed, 'd').setAttribute('futureGapBlock', {keep: true, version: 1});
          const initial = Y.encodeStateAsUpdate(seed);
          const author = jsDoc(client + 1, initial), legacy = jsDoc(client + 2, initial);
          seed.destroy(); await open(name, client, initial);
          const stages = [];
          try {
            const before = await request(name, 'projection');
            await request(name, 'replace', {edit: {revision: before.revision, range: test.range, text: test.text}});
            const joinedText = (await request(name, 'projection')).text;
            const joinedCheckpoint = decoded(await request(name, 'export'));
            const originalSuffixAnchor = await request(name, 'anchor', {block: 'd', offset: 1});
            await request(name, 'setComments', {records: [record('gap-old-suffix', 'd', 1, 2, '章')]});
            const packets = [];
            const insert = (block, offset, value) => {
              const vector = Y.encodeStateVector(author); text(author, block).insert(offset, value);
              packets.push(Y.encodeStateAsUpdate(author, vector));
            };
            if (pattern === 'b→d→b') insert('b', 0, '保');
            insert('d', 1, suffixValue);
            insert('b', pattern === 'd→b' ? 0 : 1, pattern === 'd→b' ? '保' : '续');
            const prefix = pattern === 'd→b' ? '保' : '保续';
            const raw = Y.mergeUpdates(packets), full = Y.encodeStateAsUpdate(author);
            const safePositions = Array.from({length: suffixValue.length}, (_, i) => Y.createRelativePositionFromTypeIndex(text(author, 'd'), 1 + i));
            const safeIds = safePositions.map(position => position.item);
            assert(safeIds.every(value => value && value.client === client + 1));
            const expectedSuffix = {blockId: itemId(findBlock(author, 'd')), textId: itemId(text(author, 'd')),
              attributes: findBlock(author, 'd').getAttributes(), textAttributes: text(author, 'd').getAttributes(), delta: text(author, 'd').toDelta()};
            assert(expectedSuffix.delta.some(run => run.insert.includes(suffixValue) && run.attributes?.bold === true));
            if (delivery === 'complete') await request(name, 'apply', {update: encoded(raw)});
            else if (delivery === 'normal-split') {
              for (const packet of packets) await request(name, 'apply', {update: encoded(packet)});
            } else if (pattern === 'd→b') {
              const unchanged = await request(name, 'export'), projection = await request(name, 'projection');
              await assert.rejects(request(name, 'apply', {update: encoded(packets.at(-1))}), /REMOTE_TEXT_RETENTION_REQUIRED/);
              assert.equal(await request(name, 'export'), unchanged);
              assert.deepEqual(await request(name, 'projection'), projection);
              assert.equal((await request(name, 'state')).pending, false);
              await request(name, 'apply', {update: encoded(raw)});
            } else {
              await request(name, 'apply', {update: encoded(packets.at(-1))});
              assert.equal((await request(name, 'state')).pending, true, 'The last b has an actual missing first-b origin');
              assert.equal((await request(name, 'projection')).text, joinedText);
              await request(name, 'apply', {update: encoded(Y.mergeUpdates(packets.slice(0, -1)))});
            }
            assert.equal((await request(name, 'state')).pending, false);
            // A second native receiver has the same alias but no local history.
            // It independently derives GC/proof from an old full-state packet.
            const second = `${name}-second`;
            await open(second, client + 3, joinedCheckpoint);
            try {
              await request(second, 'apply', {update: encoded(full)});
              const a = await request(name, 'export'), b = await request(second, 'export');
              await request(name, 'apply', {update: b}); await request(second, 'apply', {update: a});
              assert.deepEqual(await state(name), await state(second));
            } finally { await request(second, 'close'); }
            const comments = await request(name, 'comments');
            comments.push(record('gap-inserted-suffix', 'd', 1, 1 + suffixValue.length, suffixValue),
              record('gap-prefix', 'b', 0, prefix.length, prefix));
            await request(name, 'setComments', {records: comments});
            const quoted = {'gap-old-suffix': '章', 'gap-inserted-suffix': suffixValue, 'gap-prefix': prefix};
            Y.applyUpdate(legacy, raw, 'original-author');
            for (const [stageIndex, action] of ['joined', 'undo', 'redo', 'undo', 'redo'].entries()) {
              if (action !== 'joined') assert.equal(await request(name, action), true);
              const projection = await assertComments(name, quoted);
              assert.equal(projection.text, `${prefix}${(action === 'undo' ? before.text : joinedText).replace('终章', `终${suffixValue}章`)}`);
              assert.deepEqual(await request(name, 'resolve', {anchor: originalSuffixAnchor}), {block: 'd', offset: 1 + suffixValue.length});
              const saved = await request(name, 'export');
              await request(name, 'apply', {update: encoded(raw)}); await request(name, 'apply', {update: encoded(full)});
              assert.equal(await request(name, 'export'), saved, 'Duplicates cannot allocate a new gap/render');
              const checkpoint = decoded(saved); Y.applyUpdate(legacy, checkpoint, `native-${action}`);
              assert.deepEqual(normalize(semantic(legacy)), normalize(await state(name)));
              assert.equal(itemId(findBlock(legacy, 'd')), expectedSuffix.blockId);
              assert.equal(itemId(text(legacy, 'd')), expectedSuffix.textId);
              assert.deepEqual(findBlock(legacy, 'd').getAttributes(), expectedSuffix.attributes);
              assert.deepEqual(text(legacy, 'd').getAttributes(), expectedSuffix.textAttributes);
              assert.deepEqual(text(legacy, 'd').toDelta(), expectedSuffix.delta);
              for (const [offset, position] of safePositions.entries()) {
                const absolute = Y.createAbsolutePositionFromRelativePosition(position, legacy);
                assert(absolute && absolute.type === text(legacy, 'd') && absolute.index === 1 + offset);
                assert.deepEqual(Y.createRelativePositionFromTypeIndex(text(legacy, 'd'), 1 + offset).item, safeIds[offset]);
              }
              const skipped = metadata(legacy, 'skip/'), source = metadata(legacy, 'source/');
              assert(skipped.length > 0, 'Exact safe-clock proof must persist in the checkpoint');
              assert(source.some(value => value.text.includes('保')) && !source.some(value => value.text.includes('远')));
              const parsed = Y.decodeUpdate(checkpoint);
              const active = [...legacy.getMap('drifting.native.relocation-active.v1').values()].map(value => JSON.parse(value));
              assert.equal(active.length, 1);
              const canonicalClient = Number(BigInt(client + 1) ^ BigInt(active[0].namespace));
              for (const [offset, sourceId] of safeIds.entries()) {
                assert.equal(Y.isDeleted(parsed.ds, sourceId), false, 'Safe original IDs must not enter repair DeleteSet');
                const proofs = skipped.filter(value => value.source.client === sourceId.client && value.source.clock <= sourceId.clock
                  && sourceId.clock < value.source.clock + value.text.length);
                assert(proofs.length > 0);
                for (const proof of proofs) {
                  assert.equal(`${proof.parent_text.client}:${proof.parent_text.clock}`, expectedSuffix.textId);
                  assert.equal(proof.text[sourceId.clock - proof.source.clock], suffixValue[offset]);
                }
                assert(parsed.structs.some(value => value instanceof Y.GC && value.id.client === canonicalClient
                  && value.id.clock <= sourceId.clock && sourceId.clock < value.id.clock + value.length), 'Only canonical writer clocks are GC-covered');
              }
              const reopened = `${name}-reopen-${stageIndex}`;
              await open(reopened, client + 20 + stageIndex, checkpoint);
              try {
                await request(reopened, 'setComments', {records: await request(name, 'comments')});
                await request(reopened, 'apply', {update: encoded(full)});
                assert.deepEqual(await state(reopened), await state(name)); await assertComments(reopened, quoted);
                assert.equal(await request(reopened, 'undo'), false);
                const reader = await exportToJS(reopened, client + 30 + stageIndex);
                try {
                  assert.deepEqual(normalize(semantic(reader)), normalize(await state(name)));
                  assert.deepEqual(metadata(reader, 'skip/').sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), skipped.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
                  assert.equal(itemId(text(reader, 'd')), expectedSuffix.textId);
                } finally { reader.destroy(); }
              } finally { await request(reopened, 'close'); }
              stages.push({action, yjsConverged: true, safeOriginalIdsMarksAndMetadata: true,
                commentsAndAnchor: true, persistentSkipProof: true, sparseSourceClockReplay: true,
                canonicalOnlyGc: true, duplicateIdempotent: true, checkpointReopened: true});
            }
          } finally { author.destroy(); legacy.destroy(); await request(name, 'close'); }
          safeClockGaps.scenarios.push({operation: test.name, pattern, delivery, independentReceiver: true, stages});
        }
      }
      const name = `safe-gaps-residual-pending-${caseIndex}`, client = 520000 + caseIndex * 10;
      await open(name, client, decoded(test.updateBase64));
      const before = await request(name, 'projection');
      await request(name, 'replace', {edit: {revision: before.revision, range: test.range, text: test.text}});
      const prefix = jsDoc(client + 1, decoded(test.updateBase64)), suffix = jsDoc(client + 2, decoded(test.updateBase64));
      try {
        const vector = Y.encodeStateVector(prefix); text(prefix, 'b').insert(0, '保');
        const lost = Y.encodeStateAsUpdate(prefix, vector);
        text(suffix, 'd').insert(1, '扣'); const missing = Y.encodeStateVector(suffix);
        text(suffix, 'd').insert(1, '缺'); const dependent = Y.encodeStateAsUpdate(suffix, missing);
        const unchanged = await request(name, 'export'), projection = await request(name, 'projection');
        await assert.rejects(request(name, 'apply', {update: encoded(Y.mergeUpdates([lost, dependent]))}), /REMOTE_TEXT_RETENTION_REQUIRED/);
        assert.equal(await request(name, 'export'), unchanged); assert.deepEqual(await request(name, 'projection'), projection);
        assert.equal((await request(name, 'state')).pending, false);
        safeClockGaps.negativeCases.push({operation: test.name, case: 'lost-prefix-with-unrelated-residual-pending', atomicRefusal: true});
      } finally { prefix.destroy(); suffix.destroy(); await request(name, 'close'); }
    }
    assert.equal(safeClockGaps.scenarios.length, 12); assert.equal(safeClockGaps.negativeCases.length, 2);
    safeClockGaps.status = 'passed'; report.safeClockGaps = safeClockGaps;
  }, {scenarios: 12, historyStages: 60, residualPendingRefusals: 2, boundary: 'DocumentSession; no durable blocked-row lookahead claim'});

  await check('split/join maps comment endpoints and preserves quotes, marks, unknown metadata and restart identities', async () => {
    await open('mapped-structure', 13001);
    const before = await request('mapped-structure', 'projection');
    const block = before.blocks.find(block => block.id === 'fixture-paragraph');
    const original = { ...fixture.comments[0].textAnchor, futureAnchorField: { keep: true } };
    const split = await request('mapped-structure', 'replace', { edit: {
      revision: before.revision, range: {location: block.range.location + 6, length: 0}, text: '\n',
    }, comments: [original], points: [{block: block.id, offset: 7}] });
    const mapped = split.mappedComments[0];
    assert.equal(mapped.textAnchor.startBlockId, block.id);
    assert.equal(mapped.textAnchor.startOffset, 5);
    assert.notEqual(mapped.textAnchor.endBlockId, block.id);
    assert.equal(mapped.textAnchor.endOffset, 1);
    assert.equal(mapped.textAnchor.text, '北塔');
    assert.deepEqual(mapped.textAnchor.futureAnchorField, {keep: true});
    assert.equal(mapped.collapsed, false);
    const afterSemantic = await state('mapped-structure');
    for (const id of mapped.targetBlockIds) {
      const peer = await exportToJS('mapped-structure');
      assert.deepEqual(findBlock(peer, id).getAttribute('nativeUnknownAttribute'), {keep: true, revision: 3});
      assert.equal(text(peer, id).toDelta().find(part => part.insert.includes(id === block.id ? '北' : '塔')).attributes.entityLink.targetId, 'fixture-element');
      peer.destroy();
    }
    const relocated = split.mappedPoints[0];
    const anchor = await request('mapped-structure', 'anchor', relocated);
    const checkpoint = decoded(await request('mapped-structure', 'export'));
    await open('mapped-reopened', 13002, checkpoint);
    assert.deepEqual(await state('mapped-reopened'), afterSemantic);
    assert.deepEqual(await request('mapped-reopened', 'resolve', {anchor}), {block: relocated.block, offset: relocated.offset});
    await request('mapped-reopened', 'close');
    const join = await request('mapped-structure', 'replace', {edit: {revision: split.revision,
      range: {location: block.range.location + 6, length: 1}, text: ''}, comments: [mapped.textAnchor]});
    assert.deepEqual(join.mappedComments[0].textAnchor, original);
    assert.equal(join.text, before.text);
    assert.equal(await request('mapped-structure', 'undo'), true);
    assert.deepEqual(await state('mapped-structure'), afterSemantic);
    assert.equal(await request('mapped-structure', 'undo'), true);
    const originalPeer = jsDoc(13003); assert.deepEqual(await state('mapped-structure'), semantic(originalPeer)); originalPeer.destroy();
    await request('mapped-structure', 'close');
  });

  await check('comment history and checkpoint anchors survive Yjs exchange and legacy comment readers', async () => {
    await open('comment-owner', 14001);
    const js = jsDoc(14002);
    const original = {selectedText: '北塔', textAnchor: fixture.comments[0].textAnchor,
      blockSnapshots: [{blockId: 'fixture-paragraph', blockText: plain(js)}], futureComment: {keep: true}};
    await request('comment-owner', 'setComments', {records: [{id: 'fixture-comment', anchorJson: JSON.stringify(original),
      targetBlockId: 'fixture-paragraph', targetBlockIdsJson: '["fixture-paragraph"]'}]});
    const before = await request('comment-owner', 'projection');
    const at = before.comments[0].ranges[0].location;
    await request('comment-owner', 'replace', {edit: {revision: before.revision, range: {location: at + 1, length: 0}, text: '\n'}});
    Y.applyUpdate(js, decoded(await request('comment-owner', 'export')), 'remote');
    const vector = Y.encodeStateVector(js);
    jsEdit(js, {operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '远'});
    await request('comment-owner', 'apply', {update: encoded(Y.encodeStateAsUpdate(js, vector))});
    assert.equal(await request('comment-owner', 'undo'), true);
    let projected = await request('comment-owner', 'projection');
    assert.equal(projected.comments[0].status, 'anchored');
    assert.equal(projected.comments[0].ranges[0].location, at + 1);
    assert.equal(await request('comment-owner', 'redo'), true);
    const records = await request('comment-owner', 'comments');
    const stored = JSON.parse(records[0].anchorJson);
    assert.equal(stored.textAnchor.text, original.textAnchor.text);
    assert.deepEqual(stored.blockSnapshots, original.blockSnapshots);
    assert.deepEqual(stored.futureComment, original.futureComment);
    const checkpoint = decoded(await request('comment-owner', 'export'));
    await open('comment-reopened', 14003, checkpoint);
    await request('comment-reopened', 'setComments', {records});
    projected = await request('comment-reopened', 'projection');
    assert.equal(projected.comments[0].ranges[0].location, at + 1);
    assert.equal(projected.comments[0].ranges[0].length, 3);
    const legacy = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/apple-comment-oracle.ts'],
      {input: JSON.stringify(records), encoding: 'utf8', timeout: 30000}))[0];
    assert.deepEqual(legacy.textAnchor, stored.textAnchor);
    assert.equal(legacy.quote, '北塔');
    assert.deepEqual(legacy.snapshots, original.blockSnapshots);
    assert.deepEqual(legacy.blockIds, JSON.parse(records[0].targetBlockIdsJson));
    const received = jsDoc(14004, checkpoint);
    for (const [side, expected] of [['start', 6], ['end', 1]]) {
      const relative = Y.decodeRelativePosition(Uint8Array.from(stored.nativeAnchorV1[side]));
      const absolute = Y.createAbsolutePositionFromRelativePosition(relative, received);
      assert(absolute, 'Canonical comment position must resolve without the native undo manager');
      assert.equal(absolute.type, text(received, stored.textAnchor[`${side}BlockId`]));
      assert.equal(absolute.index, expected);
    }
    await request('comment-reopened', 'replace', {edit: {revision: projected.revision, range: {location: at + 2, length: 1}, text: ''}});
    assert.equal((await request('comment-reopened', 'projection')).comments[0].status, 'anchored');
    js.destroy(); received.destroy();
    await request('comment-owner', 'close'); await request('comment-reopened', 'close');
  });

  await check('ephemeral view selections agree with Yjs relative positions across remote edits and local history', async () => {
    await open('selection-owner', 15001);
    const peer = jsDoc(15002);
    const before = await request('selection-owner', 'projection');
    const block = before.blocks.find(block => block.id === 'fixture-paragraph');
    const start = Y.createRelativePositionFromTypeIndex(text(peer), 5, 0);
    const end = Y.createRelativePositionFromTypeIndex(text(peer), 7, -1);
    await request('selection-owner', 'select', {selection: {viewId: 'synthetic-view', epoch: 1,
      revision: before.revision, range: {location: block.range.location + 5, length: 2}}});
    const vector = Y.encodeStateVector(peer);
    jsEdit(peer, {operation: 'insert', block: 'fixture-heading', offset: 0, text: '远方'});
    jsEdit(peer, {operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '潮汐'});
    jsEdit(peer, {operation: 'insert', block: 'fixture-quote-paragraph', offset: 0, text: '星河'});
    await request('selection-owner', 'apply', {update: encoded(Y.encodeStateAsUpdate(peer, vector))});
    const projected = await request('selection-owner', 'projection');
    const location = projected.blocks.find(block => block.id === 'fixture-paragraph').range.location;
    const expectedStart = Y.createAbsolutePositionFromRelativePosition(start, peer).index;
    const expectedEnd = Y.createAbsolutePositionFromRelativePosition(end, peer).index;
    assert.deepEqual(projected.selections[0].range, {location: location + expectedStart, length: expectedEnd - expectedStart});
    assert.equal(await request('selection-owner', 'undo'), false, 'selection and remote edits must not create local history');
    const split = await request('selection-owner', 'replace', {edit: {revision: projected.revision,
      range: {location: location + expectedStart + 1, length: 0}, text: '\n'}});
    assert.equal(split.selections[0].range.length, 3);
    assert.equal(await request('selection-owner', 'undo'), true);
    assert.deepEqual((await request('selection-owner', 'projection')).selections[0].range, projected.selections[0].range);
    assert.equal(await request('selection-owner', 'redo'), true);
    assert.deepEqual((await request('selection-owner', 'projection')).selections[0].range, split.selections[0].range);
    const snapshot = decoded(await request('selection-owner', 'export'));
    await open('selection-reloaded', 15003, snapshot);
    assert.deepEqual((await request('selection-reloaded', 'projection')).selections, []);
    await request('selection-owner', 'dropSelection', {viewId: 'synthetic-view'});
    assert.equal(await request('selection-owner', 'undo'), true);
    assert.deepEqual((await request('selection-owner', 'projection')).selections, []);
    peer.destroy(); await request('selection-owner', 'close'); await request('selection-reloaded', 'close');
  });


  await check('new selections follow copied sibling text through repeated history and Yjs prefix updates', async () => {
    await open('lineage-owner', 16001);
    const reference = jsDoc(16002);
    const start = Y.createRelativePositionFromTypeIndex(text(reference), 6, 0);
    const end = Y.createRelativePositionFromTypeIndex(text(reference), 7, -1);
    const before = await request('lineage-owner', 'projection');
    const baseAt = before.blocks.find(b => b.id === 'fixture-paragraph').range.location;
    await request('lineage-owner', 'replace', {edit: {revision: before.revision,
      range: {location: baseAt + 6, length: 0}, text: '\n'}});
    const vector = Y.encodeStateVector(reference);
    jsEdit(reference, {operation: 'insert', block: 'fixture-paragraph', offset: 0, text: '远方'});
    await request('lineage-owner', 'apply', {update: encoded(Y.encodeStateAsUpdate(reference, vector))});
    for (let epoch = 1; epoch <= 3; epoch++) {
      const view = await request('lineage-owner', 'projection');
      await request('lineage-owner', 'select', {selection: {viewId: 'new-tail', epoch,
        revision: view.revision, range: {location: baseAt + 9, length: 1}}});
      assert.equal(await request('lineage-owner', 'undo'), true);
      const expected = Y.createAbsolutePositionFromRelativePosition(start, reference).index;
      const expectedEnd = Y.createAbsolutePositionFromRelativePosition(end, reference).index;
      assert.deepEqual((await request('lineage-owner', 'projection')).selections[0].range,
        {location: baseAt + expected, length: expectedEnd - expected});
      const checkpoint = await exportToJS('lineage-owner', 16003 + epoch);
      assert.deepEqual(semantic(checkpoint), semantic(reference)); checkpoint.destroy();
      assert.equal(await request('lineage-owner', 'redo'), true);
      assert.deepEqual((await request('lineage-owner', 'projection')).selections[0].range,
        {location: baseAt + 9, length: 1});
    }
    reference.destroy(); await request('lineage-owner', 'close');
  });

  await check('protected structural undo retains remote subtree content, history and checkpoints against the old collaboration filter', async () => {
    // IDs/metadata on a retained parent are tested separately below. The old
    // plugin may undo those attributes and relies on its BlockId plugin later.
    const body = node => ({type: node.type, ...(node.text !== undefined ? {text: node.text} : {}),
      ...(node.marks ? {marks: node.marks} : {}), ...(node.content ? {content: node.content.map(body)} : {})});
    const scenarios = ['prefix', 'suffix', 'middle', 'remote-delete-format', 'copied-delete', 'copied-format'];
    for (const kind of ['paragraph', 'heading']) for (const scenario of scenarios) {
      const name = `protected-${kind}-${scenario}`;
      const seed = jsDoc(17001, null);
      const block = new Y.XmlElement(kind); block.setAttribute('id', 'original'); block.setAttribute('future', 'keep');
      if (kind === 'heading') block.setAttribute('level', 2);
      block.insert(0, [new Y.XmlText('甲北塔乙')]); seed.getXmlFragment('default').push([block]);
      const initial = Y.encodeStateAsUpdate(seed);
      await open(name, 17002, initial);
      const oracle = jsDoc(17003, initial);
      // Paragraph uses the old plugin's actual default. Heading protection is
      // an explicit native extension, expressed through its supported option.
      const protectedNodes = new Set([...defaultProtectedNodes, ...(kind === 'heading' ? ['heading'] : [])]);
      const undo = new Y.UndoManager(oracle.getXmlFragment('default'), {captureTimeout: 0,
        trackedOrigins: new Set(['native-split']), deleteFilter: item => defaultDeleteFilter(item, protectedNodes)});
      const vector = Y.encodeStateVector(oracle);
      const view = await request(name, 'projection');
      const split = await request(name, 'replace', {edit: {revision: view.revision,
        range: {location: 2, length: 0}, text: '\n'}});
      Y.applyUpdate(oracle, decoded(await request(name, 'export', {stateVector: encoded(vector)})), 'native-split');
      const copied = split.blocks[1].id;
      const peerVector = Y.encodeStateVector(oracle);
      const target = text(oracle, copied);
      oracle.transact(() => {
        if (scenario === 'copied-delete') target.delete(0, 1);
        else if (scenario === 'copied-format') target.format(0, 1, {bold: true});
        else {
          const at = scenario === 'suffix' ? 2 : scenario === 'middle' ? 1 : 0;
          target.insert(at, '远方潮汐');
          if (scenario === 'remote-delete-format') { target.delete(1, 1); target.format(1, 2, {italic: true}); }
        }
      }, 'remote');
      await request(name, 'apply', {update: encoded(Y.encodeStateAsUpdate(oracle, peerVector))});
      const remoteOwned = !scenario.startsWith('copied-');
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(await request(name, 'undo'), true); assert(undo.undo());
        assert.deepEqual(body(await state(name)), body(semantic(oracle)), `${name} undo body mismatch`);
        const undone = await request(name, 'projection');
        if (remoteOwned) {
          assert(undone.text.includes(scenario === 'remote-delete-format' ? '远潮汐' : '远方潮汐'));
          const retained = undone.blocks.find(b => b.id === copied);
          assert(retained?.editable, `${name} retained text lost its stable ID`);
          assert.equal(retained.attributes.future, 'keep');
          if (kind === 'heading') assert.equal(retained.attributes.level, 2);
        }
        const checkpoint = await exportToJS(name, 17004);
        assert.deepEqual(semantic(checkpoint), await state(name)); checkpoint.destroy();
        assert.equal(await request(name, 'redo'), true); assert(undo.redo());
        assert.deepEqual(body(await state(name)), body(semantic(oracle)), `${name} redo body mismatch`);
      }
      await open(`${name}-reopened`, 17005, decoded(await request(name, 'export')));
      assert.deepEqual(await state(`${name}-reopened`), await state(name));
      await request(`${name}-reopened`, 'close'); await request(name, 'close');
      undo.destroy(); oracle.destroy(); seed.destroy();
    }
  }, {scenarios: 12, cycles: 2,
    semantics: 'Remote-owned text survives. Deletion/formatting of local copied items follows the old plugin; those items disappear on undo and are redone later, not transferred to their pre-split originals.'});

  await check('snapshot-authored draft updates converge with Yjs and undo preserves overlapping remote prose', async () => {
    const scenarios = ['before', 'inside', 'same-start', 'delete', 'replace', 'format'];
    for (const scenario of scenarios) {
      const name = `draft-${scenario}`;
      await open(name, 18001);
      const peer = jsDoc(18002);
      const before = await request(name, 'projection');
      const at = before.blocks.find(b => b.id === 'fixture-paragraph').range.location + 5;
      const exported = await request(name, 'export');
      await request(name, 'beginDraft', {start: {key: 'ime', revision: before.revision, range: {location: at, length: 2}}});
      assert.equal(await request(name, 'export'), exported, 'Draft start must not publish any marked text');
      const vector = Y.encodeStateVector(peer);
      if (scenario === 'delete' || scenario === 'replace') jsEdit(peer, {operation: 'delete', block: 'fixture-paragraph', offset: 6, length: 1});
      if (scenario === 'format') jsEdit(peer, {operation: 'format', block: 'fixture-paragraph', offset: 0, length: 2, attributes: {italic: true}});
      else if (scenario !== 'delete') jsEdit(peer, {operation: 'insert', block: 'fixture-paragraph',
        offset: scenario === 'before' ? 0 : scenario === 'same-start' ? 5 : 6, text: '远端'});
      const remoteUpdate = Y.encodeStateAsUpdate(peer, vector);
      await request(name, 'apply', {update: encoded(remoteUpdate)});
      const remoteOnly = await state(name);
      const peerBeforeCommit = Y.encodeStateVector(peer);
      const committed = await request(name, 'commitDraft', {commit: {key: 'ime', text: '新词',
        selection: {viewId: 'ime-view', epoch: 1, range: {location: at + 2, length: 0}}}});
      assert(committed.text.includes('新词'));
      if (!['delete', 'format'].includes(scenario)) assert(committed.text.includes('远端'));
      assert.equal(committed.selections[0].range.location, committed.text.indexOf('新词') + 2,
        'Caret must follow its authored replacement, independent of concurrent insertion ordering');
      const update = decoded(await request(name, 'export', {stateVector: encoded(peerBeforeCommit)}));
      Y.applyUpdate(peer, update, 'native-draft'); Y.applyUpdate(peer, update, 'duplicate');
      assert.deepEqual(await state(name), semantic(peer));
      assert.deepEqual(findBlock(peer, 'fixture-paragraph').getAttribute('nativeUnknownAttribute'), {keep: true, revision: 3});
      const merged = semantic(peer);
      assert.equal(await request(name, 'undo'), true);
      assert.deepEqual(await state(name), remoteOnly, 'Draft undo must not revert remote text or marks');
      Y.applyUpdate(peer, decoded(await request(name, 'export')), 'native-undo');
      assert.deepEqual(await state(name), semantic(peer));
      assert.equal(await request(name, 'undo'), false, 'Remote input is not a local undo unit');
      assert.equal(await request(name, 'redo'), true);
      Y.applyUpdate(peer, decoded(await request(name, 'export')), 'native-redo');
      assert.deepEqual(await state(name), merged); assert.deepEqual(semantic(peer), merged);
      await open(`${name}-reopened`, 18003, decoded(await request(name, 'export')));
      assert.deepEqual(await state(`${name}-reopened`), merged);
      await assert.rejects(request(`${name}-reopened`, 'commitDraft', {commit: {key: 'ime', text: 'duplicate'}}), /Unknown/);
      peer.destroy(); await request(name, 'close'); await request(`${name}-reopened`, 'close');
    }
  }, {scenarios: 6, scope: 'inline authored drafts; native queue tested in separate binding report; same-block structural drafts remain open'});

  await check('queued input branches preserve visible item identity across remote merge, incremental Yjs exchange and history', async () => {
    const name = 'input-branches';
    await open(name, 19001);
    const peer = jsDoc(19002);
    const before = await request(name, 'projection');
    const at = before.blocks.find(b => b.id === 'fixture-paragraph').range.location + 5;
    await request(name, 'forkInput', {key: 'shared'});
    await request(name, 'forkInput', {key: 'ime', source: 'shared'});
    const vector = Y.encodeStateVector(peer);
    jsEdit(peer, {operation: 'insert', block: 'fixture-paragraph', offset: 6, text: '远端'});
    await request(name, 'apply', {update: encoded(Y.encodeStateAsUpdate(peer, vector))});
    const remoteOnly = await state(name);
    async function exchange() {
      const delta = decoded(await request(name, 'export', {stateVector: encoded(Y.encodeStateVector(peer))}));
      Y.applyUpdate(peer, delta, 'native'); Y.applyUpdate(peer, delta, 'duplicate');
      assert.deepEqual(await state(name), semantic(peer));
    }
    let author = await request(name, 'replaceInput', {edit: {key: 'ime', sequence: 0, range: {location: at, length: 2}, text: '新'}});
    assert.equal(author.text, before.text.slice(0, at) + '新' + before.text.slice(at + 2));
    await exchange();
    author = await request(name, 'replaceInput', {edit: {key: 'ime', sequence: 1, range: {location: at + 1, length: 0}, text: '续'}});
    assert(author.text.includes('新续') && !author.text.includes('远端'));
    await exchange();
    await request(name, 'replaceInput', {edit: {key: 'shared', sequence: 0, range: {location: at, length: 1}, text: '另'}});
    await exchange();
    const merged = await state(name), mergedText = plain(peer);
    assert(mergedText.includes('远端') && mergedText.includes('新续') && mergedText.includes('另'));
    assert.deepEqual(findBlock(peer, 'fixture-paragraph').getAttribute('nativeUnknownAttribute'), {keep: true, revision: 3});
    await assert.rejects(request(name, 'replaceInput', {edit: {key: 'ime', sequence: 1, range: {location: at + 1, length: 0}, text: '重复'}}), /Stale input sequence/);
    assert.deepEqual(await state(name), merged);
    for (let i = 0; i < 3; i++) { assert.equal(await request(name, 'undo'), true); await exchange(); }
    assert.deepEqual(await state(name), remoteOnly);
    for (let i = 0; i < 3; i++) { assert.equal(await request(name, 'redo'), true); await exchange(); }
    assert.deepEqual(await state(name), merged);
    await request(name, 'dropInput', {key: 'ime'}); await request(name, 'dropInput', {key: 'shared'});
    await open('input-branches-reopen', 19003, decoded(await request(name, 'export')));
    assert.deepEqual(await state('input-branches-reopen'), merged);
    peer.destroy(); await request(name, 'close'); await request('input-branches-reopen', 'close');
  });

  await check('disjoint remote inline edits allow structural input branches, queued typing and local history', async () => {
    for (const structure of ['split', 'join']) for (const remoteKind of ['insert', 'delete', 'format']) {
      const name = `disjoint-${structure}-${remoteKind}`;
      const seed = jsDoc(20000, null);
      for (const [id, value] of [['lead', '远段'], ['work', '甲甲👩🏽‍🚀乙'], ['next', '尾词'], ['end', '后段']]) {
        jsEdit(seed, {operation: 'appendParagraph', id, text: value});
      }
      findBlock(seed, 'work').setAttribute('future', {opaque: ['keep', 7]});
      jsEdit(seed, {operation: 'format', block: 'work', offset: 2, length: 7, attributes: {bold: {}}});
      const initial = Y.encodeStateAsUpdate(seed);
      const peer = jsDoc(20002, initial);
      await open(name, 20001, initial);
      const before = await request(name, 'projection');
      const block = before.blocks.find(b => b.id === 'work');
      const at = block.range.location + (structure === 'split' ? 2 : block.range.length);
      const length = structure === 'split' ? 0 : 1, inserted = structure === 'split' ? '\n' : '';
      await request(name, 'forkInput', {key: 'typing'});
      const vector = Y.encodeStateVector(peer), remoteBlock = remoteKind === 'format' ? 'end' : 'lead';
      jsEdit(peer, {operation: remoteKind, block: remoteBlock, offset: 0, length: 1, text: '云', attributes: {italic: {}}});
      const remote = Y.encodeStateAsUpdate(peer, vector);
      await request(name, 'apply', {update: encoded(remote)});
      const remoteOnly = await state(name);
      let author = await request(name, 'replaceInput', {edit: {key: 'typing', sequence: 0,
        range: {location: at, length}, text: inserted}});
      const expectedAuthor = before.text.slice(0, at) + inserted + before.text.slice(at + length);
      assert.equal(author.text, expectedAuthor);
      author = await request(name, 'replaceInput', {edit: {key: 'typing', sequence: 1,
        range: {location: at + inserted.length, length: 0}, text: '续'}});
      assert.equal(author.text, expectedAuthor.slice(0, at + inserted.length) + '续' + expectedAuthor.slice(at + inserted.length));
      const native = decoded(await request(name, 'export', {stateVector: encoded(Y.encodeStateVector(peer))}));
      Y.applyUpdate(peer, native, 'native'); Y.applyUpdate(peer, native, 'duplicate');
      const merged = await state(name);
      assert.deepEqual(semantic(peer), merged);
      assert.deepEqual(findBlock(peer, 'work').getAttribute('future'), {opaque: ['keep', 7]});
      for (const updates of [[remote, native], [native, remote]]) {
        const replica = jsDoc(20003, initial);
        for (const update of [...updates, ...updates]) Y.applyUpdate(replica, update);
        assert.deepEqual(semantic(replica), merged, 'Update delivery order changed disjoint structural output');
        replica.destroy();
      }
      for (let i = 0; i < 2; i++) assert.equal(await request(name, 'undo'), true);
      assert.deepEqual(await state(name), remoteOnly, 'Structural undo must preserve remote text and marks');
      assert.equal(await request(name, 'undo'), false);
      for (let i = 0; i < 2; i++) assert.equal(await request(name, 'redo'), true);
      assert.deepEqual(await state(name), merged);
      Y.applyUpdate(peer, decoded(await request(name, 'export')));
      assert.deepEqual(semantic(peer), merged);
      await open(`${name}-reopen`, 20004, decoded(await request(name, 'export')));
      assert.deepEqual(await state(`${name}-reopen`), merged);
      await request(name, 'close'); await request(`${name}-reopen`, 'close');
      peer.destroy(); seed.destroy();
    }
  }, {scenarios: 6, scope: 'same-parent structural commands; remote edits outside affected blocks; same-block and cross-container concurrent reconciliation remain open'});

  await check('same-paragraph Enter preserves concurrent prefix insertions, queued author offsets and selection history', async () => {
    for (const offset of [0, 1]) for (const inserted of ['远', 'e\u0301', '👩🏽‍🚀']) {
      const name = `prefix-enter-${offset}-${inserted.length}`;
      const seed = jsDoc(24001, null), original = '甲甲👩🏽‍🚀乙';
      for (const [id, value] of [['lead', '前'], ['work', original], ['end', '后']]) {
        jsEdit(seed, {operation: 'appendParagraph', id, text: value});
      }
      findBlock(seed, 'work').setAttribute('future', {keep: ['opaque', 3]});
      text(seed, 'work').setAttribute('futureText', new Uint8Array([1, 128, 255]));
      jsEdit(seed, {operation: 'format', block: 'work', offset: 2, length: 7, attributes: {bold: {}}});
      const initial = Y.encodeStateAsUpdate(seed), peer = jsDoc(24002, initial);
      const anchorStart = Y.createRelativePositionFromTypeIndex(text(peer, 'work'), 2, 0);
      const anchorEnd = Y.createRelativePositionFromTypeIndex(text(peer, 'work'), 9, -1);
      await open(name, 24003, initial);
      const before = await request(name, 'projection');
      const baseAt = before.blocks.find(block => block.id === 'work').range.location, at = baseAt + 2;
      await request(name, 'forkInput', {key: 'typing'});
      const vector = Y.encodeStateVector(peer);
      jsEdit(peer, {operation: 'insert', block: 'work', offset, text: inserted});
      const remote = Y.encodeStateAsUpdate(peer, vector);
      await request(name, 'apply', {update: encoded(remote)});
      const remoteOnly = await state(name);
      let author = await request(name, 'replaceInput', {edit: {key: 'typing', sequence: 0,
        range: {location: at, length: 0}, text: '\n'}});
      const authored = before.text.slice(0, at) + '\n' + before.text.slice(at);
      assert.equal(author.text, authored, 'The continuing input branch must keep its authored offsets');
      author = await request(name, 'replaceInput', {edit: {key: 'typing', sequence: 1,
        range: {location: at + 1, length: 0}, text: '续'}});
      assert.equal(author.text, authored.slice(0, at + 1) + '续' + authored.slice(at + 1));
      const live = await request(name, 'projection');
      assert.equal(live.text, '前\n' + original.slice(0, offset) + inserted + original.slice(offset, 2) + '\n续' + original.slice(2) + '\n后');
      const selected = {location: at + inserted.length + 2, length: 7};
      await request(name, 'select', {selection: {viewId: 'new-tail', epoch: 1, revision: live.revision, range: selected}});
      const native = decoded(await request(name, 'export', {stateVector: encoded(Y.encodeStateVector(peer))}));
      const merged = await state(name);
      for (const updates of [[remote, native], [native, remote]]) {
        const replica = jsDoc(24004, initial);
        for (const update of [...updates, ...updates]) Y.applyUpdate(replica, update);
        assert.deepEqual(semantic(replica), merged);
        const blocks = replica.getXmlFragment('default').toArray();
        assert.equal(new Set(blocks.map(block => block.getAttribute('id'))).size, blocks.length);
        for (const block of blocks.slice(1, 3)) {
          assert.deepEqual(block.getAttribute('future'), {keep: ['opaque', 3]});
          assert.deepEqual(block.get(0).getAttribute('futureText'), new Uint8Array([1, 128, 255]));
        }
        replica.destroy();
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(await request(name, 'undo'), true); assert.equal(await request(name, 'undo'), true);
        assert.deepEqual(await state(name), remoteOnly);
        const start = Y.createAbsolutePositionFromRelativePosition(anchorStart, peer).index;
        const end = Y.createAbsolutePositionFromRelativePosition(anchorEnd, peer).index;
        assert.deepEqual((await request(name, 'projection')).selections[0].range, {location: baseAt + start, length: end - start});
        assert.equal(await request(name, 'undo'), false, 'Remote prefix must not enter local history');
        assert.equal(await request(name, 'redo'), true); assert.equal(await request(name, 'redo'), true);
        assert.deepEqual(await state(name), merged);
        assert.deepEqual((await request(name, 'projection')).selections[0].range, selected);
      }
      const checkpoint = decoded(await request(name, 'export'));
      Y.applyUpdate(peer, checkpoint); assert.deepEqual(semantic(peer), merged);
      await open(`${name}-reopen`, 24005, checkpoint);
      assert.deepEqual(await state(`${name}-reopen`), merged);
      assert.equal(await request(`${name}-reopen`, 'undo'), false);
      await request(name, 'close'); await request(`${name}-reopen`, 'close'); peer.destroy(); seed.destroy();
    }
  }, {scenarios: 6, historyCycles: 2, scope: 'interior paragraph Enter; remote inserted items strictly before the cut; original items, metadata and copied tail unchanged'});

  await check('same-paragraph Enter preserves remote prefix deletions, author offsets and repeated selection history', async () => {
    const scenarios = [
      {id: 'repeated-first', original: '甲甲👩🏽‍🚀乙', cut: 2, deletions: [[0, 1]]},
      {id: 'adjacent-to-cut', original: '甲甲👩🏽‍🚀乙', cut: 2, deletions: [[1, 1]]},
      {id: 'whole-prefix', original: '甲甲👩🏽‍🚀乙', cut: 2, deletions: [[0, 2]]},
      {id: 'emoji-prefix', original: '甲👩🏽‍🚀北e\u0301尾', cut: 9, deletions: [[0, 8]]},
      {id: 'whole-emoji-prefix', original: '甲👩🏽‍🚀北e\u0301尾', cut: 9, deletions: [[0, 9]]},
      {id: 'separate-prefix-gaps', original: '甲甲丙甲👩🏽‍🚀尾', cut: 4, deletions: [[3, 1], [0, 1]]},
      {id: 'retained-combining-mark', original: '甲e\u0301👩🏽‍🚀尾', cut: 3, deletions: [[1, 1]]},
      {id: 'fragmented-nonmonotonic-clocks', original: '甲乙丙丁👩🏽‍🚀尾', cut: 4,
        deletions: [[2, 1], [0, 1]], fragmented: true},
    ];
    for (const {id, original, cut, deletions, fragmented} of scenarios) {
      const name = `prefix-delete-enter-${id}`, seed = jsDoc(25001, null);
      for (const [blockId, value] of [['lead', '前'], ['work', original], ['end', '后']]) {
        jsEdit(seed, {operation: 'appendParagraph', id: blockId, text: fragmented && blockId === 'work' ? value.slice(1) : value});
      }
      if (fragmented) {
        // Document order is not CRDT clock order. Split prefix runs also have
        // different raw marks while the copied tail remains unchanged.
        jsEdit(seed, {operation: 'insert', block: 'work', offset: 0, text: original.slice(0, 1)});
        for (let offset = 0; offset < cut; offset += 2) {
          jsEdit(seed, {operation: 'format', block: 'work', offset, length: 1, attributes: {italic: {}}});
        }
      }
      findBlock(seed, 'work').setAttribute('future', {keep: ['opaque', 3]});
      text(seed, 'work').setAttribute('futureText', new Uint8Array([1, 128, 255]));
      jsEdit(seed, {operation: 'format', block: 'work', offset: cut, length: original.length - cut, attributes: {bold: {}}});
      const initial = Y.encodeStateAsUpdate(seed), peer = jsDoc(25002, initial);
      const startAnchor = Y.createRelativePositionFromTypeIndex(text(peer, 'work'), cut, 0);
      const endAnchor = Y.createRelativePositionFromTypeIndex(text(peer, 'work'), original.length, -1);
      await open(name, 25003, initial);
      const before = await request(name, 'projection');
      const baseAt = before.blocks.find(block => block.id === 'work').range.location, at = baseAt + cut;
      await request(name, 'forkInput', {key: 'typing'});
      const vector = Y.encodeStateVector(peer);
      for (const [offset, length] of deletions) jsEdit(peer, {operation: 'delete', block: 'work', offset, length});
      const remote = Y.encodeStateAsUpdate(peer, vector), remoteOnly = semantic(peer);
      const liveCut = Y.createAbsolutePositionFromRelativePosition(startAnchor, peer).index;
      const remoteBody = plain(peer, 'work');
      assert.equal(liveCut, cut - deletions.reduce((sum, [, length]) => sum + length, 0));
      await request(name, 'apply', {update: encoded(remote)});
      assert.deepEqual(await state(name), remoteOnly);
      let author = await request(name, 'replaceInput', {edit: {key: 'typing', sequence: 0,
        range: {location: at, length: 0}, text: '\n'}});
      const authored = before.text.slice(0, at) + '\n' + before.text.slice(at);
      assert.equal(author.text, authored, 'Queued input must retain its pre-deletion author basis');
      author = await request(name, 'replaceInput', {edit: {key: 'typing', sequence: 1,
        range: {location: at + 1, length: 0}, text: '续'}});
      assert.equal(author.text, authored.slice(0, at + 1) + '续' + authored.slice(at + 1));
      const live = await request(name, 'projection');
      assert.equal(live.text, '前\n' + remoteBody.slice(0, liveCut) + '\n续' + original.slice(cut) + '\n后');
      const selected = {location: baseAt + liveCut + 2, length: original.length - cut};
      await request(name, 'select', {selection: {viewId: 'new-tail', epoch: 1, revision: live.revision, range: selected}});
      const native = decoded(await request(name, 'export', {stateVector: encoded(Y.encodeStateVector(peer))}));
      const merged = await state(name);
      for (const updates of [[remote, native], [native, remote]]) {
        const replica = jsDoc(25004, initial);
        for (const update of [...updates, ...updates]) Y.applyUpdate(replica, update);
        assert.deepEqual(semantic(replica), merged);
        const blocks = replica.getXmlFragment('default').toArray();
        assert.equal(new Set(blocks.map(block => block.getAttribute('id'))).size, blocks.length);
        for (const block of blocks.slice(1, 3)) {
          assert.deepEqual(block.getAttribute('future'), {keep: ['opaque', 3]});
          assert.deepEqual(block.get(0).getAttribute('futureText'), new Uint8Array([1, 128, 255]));
        }
        replica.destroy();
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(await request(name, 'undo'), true); assert.equal(await request(name, 'undo'), true);
        assert.deepEqual(await state(name), remoteOnly, 'Local undo must not resurrect remote prefix deletions');
        const end = Y.createAbsolutePositionFromRelativePosition(endAnchor, peer).index;
        assert.deepEqual((await request(name, 'projection')).selections[0].range,
          {location: baseAt + liveCut, length: end - liveCut});
        assert.equal(await request(name, 'undo'), false, 'Remote deletion is not a local undo unit');
        assert.equal(await request(name, 'redo'), true); assert.equal(await request(name, 'redo'), true);
        assert.deepEqual(await state(name), merged);
        assert.deepEqual((await request(name, 'projection')).selections[0].range, selected);
      }
      // The old implementation edits the newly copied tail after receiving
      // native history, then an independent native owner reopens those bytes.
      Y.applyUpdate(peer, decoded(await request(name, 'export')));
      assert.deepEqual(semantic(peer), merged);
      const tail = (await request(name, 'projection')).blocks[2].id;
      const vectorAfterHistory = Y.encodeStateVector(peer);
      jsEdit(peer, {operation: 'insert', block: tail, offset: 1, text: '来'});
      await request(name, 'apply', {update: encoded(Y.encodeStateAsUpdate(peer, vectorAfterHistory))});
      assert.deepEqual(await state(name), semantic(peer));
      const checkpoint = decoded(await request(name, 'export'));
      await open(`${name}-reopen`, 25005, checkpoint);
      assert.deepEqual(await state(`${name}-reopen`), semantic(peer));
      assert.equal(await request(`${name}-reopen`, 'undo'), false);
      await request(name, 'close'); await request(`${name}-reopen`, 'close'); peer.destroy(); seed.destroy();
    }
  }, {scenarios: 8, historyCycles: 2, updateOrders: 2,
    scope: 'interior paragraph Enter; pure deletion of original items before the cut, including the whole prefix; copied tail, metadata and remaining marks unchanged; mixed insertion/deletion remains rejected'});


  await check('structural copies preserve v1-canonical marks and raw binary XML metadata types', async () => {
    for (const [operation, at, length, inserted, expectedText] of [
      ['split', 1, 0, '\n', '甲\n乙\n丙丁'],
      ['join', 2, 1, '', '甲乙丙丁'],
      ['inline', 1, 0, '续', '甲续乙\n丙丁'],
    ]) {
      const seed = jsDoc(21000, null);
      const marks = { futureBinary: new Uint8Array([1, 0, 255]), futureNested: { payload: new Uint8Array([7, 128]) } };
      for (const [id, value] of [['p', '甲乙'], ['q', '丙丁']]) {
        jsEdit(seed, {operation: 'appendParagraph', id, text: value});
        findBlock(seed, id).setAttribute('futureBlock', new Uint8Array([9, 255]));
        text(seed, id).setAttribute('futureText', new Uint8Array([3, 255]));
        text(seed, id).format(0, value.length, marks);
      }
      const name = `typed-marks-${operation}`;
      const initial = Y.encodeStateAsUpdate(seed);
      // V1 Format values are JSON strings in Yjs itself. Binary mark values
      // already become numeric-keyed objects on this wire, unlike XML attrs.
      const canonicalSeed = jsDoc(21004, initial);
      const canonicalMarks = text(canonicalSeed, 'p').toDelta()[0].attributes;
      canonicalSeed.destroy();
      await open(name, 21001, initial);
      const before = await request(name, 'projection');
      await request(name, 'replace', {edit: {revision: before.revision, range: {location: at, length}, text: inserted}});
      const verify = async expected => {
        const received = await exportToJS(name, 21002);
        const blocks = received.getXmlFragment('default').toArray();
        assert.equal(blocks.map(block => block.get(0).toDelta().map(run => run.insert).join('')).join('\n'), expected);
        for (const block of blocks) {
          assert.deepEqual(block.getAttribute('futureBlock'), new Uint8Array([9, 255]));
          assert.deepEqual(block.get(0).getAttribute('futureText'), new Uint8Array([3, 255]));
          for (const run of block.get(0).toDelta()) assert.deepEqual(run.attributes, canonicalMarks, 'Copied/inherited marks must retain their original v1 values');
        }
        received.destroy();
      };
      await verify(expectedText);
      assert.equal(await request(name, 'undo'), true); await verify(before.text);
      assert.equal(await request(name, 'redo'), true); await verify(expectedText);
      const bytes = decoded(await request(name, 'export'));
      await request(name, 'close'); await open(name, 21003, bytes);
      await verify(expectedText);
      await request(name, 'close'); seed.destroy();
    }
  }, {scenarios: 3, scope: 'Yjs v1-canonical mark values and typed binary XML attributes across editing, history and checkpoint reopen'});

  await check('non-JSON v2 format values reject atomically before live or pending integration', async () => {
    for (const [index, value] of [new Uint8Array([1, 255]), undefined, {nested: new Uint8Array([7])}, NaN].entries()) {
      const source = jsDoc(22001 + index, null);
      const future = source.getText('future-text-root');
      future.insert(0, '合成');
      const vector = Y.encodeStateVector(source);
      future.format(0, 1, {futureMark: value});
      for (const [mode, update] of [['complete', Y.encodeStateAsUpdateV2(source)], ['missing-parent', Y.encodeStateAsUpdateV2(source, vector)]]) {
        const name = `unsupported-format-${index}-${mode}`;
        await open(name, 23001 + index);
        const before = await request(name, 'projection'), saved = await request(name, 'export');
        await assert.rejects(request(name, 'apply', {update: encoded(update), encoding: 2}), /non-JSON/);
        assert.deepEqual(await request(name, 'projection'), before);
        assert.equal(await request(name, 'export'), saved);
        assert.equal(await request(name, 'undo'), false);
        await request(name, 'close');
      }
      source.destroy();
    }
  }, {scenarios: 8, scope: 'v1-incompatible format/embed JSON values reject; raw binary map/array/XML attributes remain supported'});

  assert.equal(fingerprint(), report.source.fingerprint, 'Compatibility inputs changed during the run');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message.replaceAll(process.cwd(), '<repository>');
  process.exitCode = 1;
} finally {
  processHandle?.stdin.end(); processHandle?.kill();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${output}`);
  if (report.failure) console.error(report.failure);
}
