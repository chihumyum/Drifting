// Collect actual parser, transaction-capture and SQLite journal test results.
// Neutral transaction facts do not certify authored alias-deletion intent.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const script = 'scripts/apple-yjs-provenance-acceptance.mjs';
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = option('output') ?? 'docs/apple-native/acceptance/yjs-transaction-provenance.json';
const indexed = (count, before, after = '') => Array.from({ length: count }, (_, index) => `${before}${index}${after}`);
const named = (group, names) => names.map(name => `${group} ${name}`).sort();

// Fixed expectations: never infer accepted names or counts from current tests.
const suites = [
  {
    file: 'src/renderer/sync/protocol/yjs-update-payload.test.ts', count: 56,
    names: named('Yjs update payload transaction evidence', [
      'preserves omitted-provenance legacy bytes and ignores unknown top-level fields without rewriting input',
      'keeps the existing non-empty byte contract without decoding or imposing a new update size cap',
      ...indexed(7, 'rejects an invalid legacy payload '),
      'parses actual Yjs transaction bytes and snapshots without claiming authored deletion semantics',
      'returns independent copies of update, provenance, snapshot, array and every range',
      'accepts state-transfer evidence only as its own copied exact shape',
      ...indexed(12, 'rejects present malformed, unknown or over-specified provenance ', ' instead of downgrading'),
      'does not downgrade a malformed inherited provenance field or accept missing own evidence keys',
      ...indexed(8, 'rejects malformed, non-round-tripping or oversized snapshot '),
      'accepts exact empty snapshot and boundary clock/client values, preserving adjacent range segmentation',
      ...indexed(21, 'rejects invalid, overflowing, unsorted or overlapping delete ranges '),
      'accepts 100,000 ranges and rejects 100,001 before reading elements',
    ]),
  },
  {
    file: 'src/renderer/sync/protocol/yjs-update-wire.test.ts', count: 13,
    names: named('optional Yjs transaction evidence across change-set and segment wire', [
      'preserves a real transaction snapshot, update and delete ranges exactly through both envelopes',
      'preserves the distinct state-transfer shape through both envelopes',
      'keeps an omitted supplement absent and preserves legacy payload bytes and hash',
      ...['before hashing completes', 'after hashing completes']
        .map(phase => `owns mutation payload and target when callers change inputs ${phase}`),
      ...['present null', 'unsupported inner version', 'state-transfer carrying deletes',
        'snapshot with trailing bytes', 'overlapping delete ranges']
        .map(name => `rejects correctly hashed ${name} evidence at both wire entry points`),
      ...['before snapshot', 'delete ranges', 'evidence kind']
        .map(name => `rejects syntactically valid ${name} tampering when the original payload hash is retained`),
    ]),
  },
  {
    file: 'src/renderer/services/yjs-transaction-evidence.test.ts', count: 18,
    names: named('actual Yjs transaction evidence capture', [
      'captures the exact eligible local insert event and the preceding snapshot',
      'distinguishes consecutive pure deletes whose state vectors are identical',
      'keeps rapid event bases and bytes independent of later events and listeners',
      'excludes non-approved, remote, full-state and already-persisted transactions',
      'rechecks locality after a remote apply nested inside an eligible local transaction',
      'uses one outer transaction basis for nested local transact calls',
      'preserves distinct observer-transaction bases without claiming event bytes are transaction-exclusive',
      'records structural replacement deletes as neutral transaction facts',
      'retains an explicit capture failure without throwing into Yjs or poisoning later cleanup',
      ...[['earlier listener', 'insert', true], ['earlier listener', 'delete', true],
        ['predicate', 'insert', true], ['predicate', 'delete', true],
        ['predicate', 'insert', false], ['predicate', 'delete', false]]
        .map(([source, operation, allowed]) => `refuses a contaminated basis from ${source} ${operation} even when eligibility is ${allowed}`),
      ...['beforeTransaction', 'update'].map(phase => `keeps an unknown origin accessor failure at ${phase} outside Yjs cleanup`),
      'disposes idempotently without discarding queued records and automatically detaches on destroy',
    ]),
  },
  {
    file: 'src/renderer/sync/journal/yjs-update.integration.test.ts', count: 15,
    names: named('authored Yjs journal', [
      'persists actual transaction evidence with identical update and immutable envelope bytes',
      'copies update and evidence before waiting for the SQLite transaction scheduler',
      ...['user', 'agent', 'system'].map(kind => `keeps ${kind} revision labels separate from wire evidence`),
      'keeps seed and restore state untagged unless an operation supplies evidence',
      'persists explicit state-transfer evidence without transaction delete claims',
      ...[{ version: 2, kind: 'state-transfer' },
        { version: 1, kind: 'transaction-event', beforeSnapshot: { 0: 255 }, transactionDeletes: [] },
        { version: 1, kind: 'state-transfer', transactionDeletes: [] }]
        .map(value => `rejects invalid explicit evidence before scheduling any database transaction: ${JSON.stringify(value)}`),
      'commits the update, revision, provenance and raw-byte mutation atomically',
      'commits a deterministic create seed with the owner and one complete authored change-set',
      'rolls every Yjs row back when the authored transaction cannot bind a SyncGeneration',
      'rolls back evidence and prose together when receipt observation fails after journaling',
      'enumerates snapshot-only documents for checkpoint capture',
    ]),
  },
  {
    file: 'src/renderer/sync/checkpoint/checkpoint.integration.test.ts', count: 20,
    names: named('provider-neutral checkpoint capture and isolated restore', [
      'materializes no project when any member of an atomic multi-SyncGeneration restore fails',
      'captures and restores snapshot-only, update-only, combined, and seed-only prose',
      'publishes every blob and the package before the only visible commit marker',
      'captures normalized authority and rebuilds a deliberately stale JSON projection',
      'fails capture before publishing a checkpoint with missing fractional list authority',
      'fails closed on missing/corrupt blobs and wrong projectSync without exposing a project',
      'rejects unknown package versions and invalid Yjs before materialization',
      ...['payload bytes', 'payload hash', 'forged payload with matching row hash', 'action',
        'target family', 'target kind', 'target id', 'incarnation', 'payload version', 'missing row',
        'extra row with out-of-range index', 'negative index', 'duplicate index']
        .map(label => `rejects rehashed checkpoint mutation-row ${label} without changing target domain state`),
    ]),
  },
  {
    file: 'src/renderer/sync/reducer/production-domain-kernel.integration.test.ts', count: 28,
    names: named('production SyncDomainMaterializationKernel on file-backed SQLite', [
      'classifies every frozen reducer target as implemented or explicitly fail-closed',
      'lets a narrative drop update an older chapter lifecycle without revalidating untouched book order',
      'rejects a newly authored chapter fractional-order register',
      'replays a locked built-in relation type before applying the next chapter creation bundle',
      'materializes a classified field and records no authored echo',
      'accepts the domain writing statuses and rejects retired ones',
      'keeps invalid effects as deterministic conflicts without touching domain rows',
      'validates relation invariants before a lifecycle seed reaches SQLite',
      'materializes membership OR-set state before the independent primary LWW register',
      'removes storyline memberships before materializing storyline trash',
      'accepts a local authored membership removal bundled with storyline trash',
      'blocks a primary register that does not reference a present membership',
      'materializes trash and full-seed restore as a new incarnation',
      'fails closed on scalar prose and prose lifecycles without one full Yjs state',
      'restores rows without deletedAt from physical trash projections at incarnation one',
      'keeps restored Yjs and asset ownership when late incarnation-zero operations arrive',
      'applies a valid Yjs update with remote provenance inside the receipt transaction',
      ...['transaction-event', 'state-transfer'].map(kind => `preserves ${kind} evidence in the remote envelope while materializing ordinary prose`),
      ...['present null', 'unsupported evidence version', 'snapshot with trailing bytes', 'overlapping delete ranges']
        .map(label => `rejects ${label} at the direct kernel validation seam without domain or Yjs writes`),
      'binds an asset only after verified blob staging and enforces one typed owner',
      'converges asset bind/unbind when the older bind arrives after the winner',
      'materializes sync-generation.purge without deleting the immutable sync receipt',
      'keeps sync-generation.purge absorbing across two-writer reorder, duplicate, and restart replay',
      'preserves the terminal purge register through checkpoint reducer-state restore',
    ]),
  },
  {
    file: 'src/renderer/sync/protocol/protocol.test.ts', count: 17,
    names: [
      'RFC 8949 deterministic CBOR encodes maps deterministically and keeps binary values as CBOR byte strings',
      'RFC 8949 deterministic CBOR quarantines valid but non-deterministically ordered CBOR',
      'RFC 8949 deterministic CBOR rejects non-finite numbers, undefined, sparse arrays and malformed hex',
      'UTF-8 and HLC total order orders strings by UTF-8 bytes instead of locale collation',
      'UTF-8 and HLC total order uses every frozen tie-break field in order',
      'UTF-8 and HLC total order advances local and received clocks monotonically',
      'versioned change sets and segments keeps exported mutation constants and runtime unions in lockstep',
      'versioned change sets and segments round-trips a complete change set and verifies each payload hash',
      'versioned change sets and segments quarantines unknown protocol and payload versions without an upconverter',
      'versioned change sets and segments rejects partial indexes, mismatched action families and payload tampering',
      'versioned change sets and segments requires one writer epoch, contiguous sequences and sorted blob dependencies',
      'snapshot packages and commit markers verifies canonical authored/reducer sections, Yjs bytes and seed payloads',
      'snapshot packages and commit markers keeps commit visibility separate from the snapshot body',
      'opaque provider object boundaries keeps provider/object constants and runtime unions in lockstep',
      'opaque provider object boundaries does not allow renderer absolute paths as LocalObjectRef values',
      'opaque provider object boundaries keeps provider authority out of individual bindings',
      'cross-runtime protocol v1 golden fixtures keeps every core envelope byte-for-byte stable',
    ].sort(),
  },
];
for (const suite of suites) {
  assert.equal(suite.names.length, suite.count);
  assert.equal(new Set(suite.names).size, suite.count);
}
const total = suites.reduce((sum, suite) => sum + suite.count, 0);
const acceptedCases = suites.flatMap(suite => suite.names.map(name => ({ file: suite.file, name, status: 'passed' })));
const scope = {
  acceptedCases: total,
  boundary: 'Structural validation and immutable wire transport of optional neutral transaction evidence, actual synthetic Yjs transaction capture, and file-backed SQLite authored-write atomicity. The helper is opt-in and transactionDeletes are not authored-deletion certificates.',
  accepted: ['Strict payload shape, snapshot round-trip, bounds, deep copies and legacy omission',
    'Change-set/segment integrity checks and unchanged protocol golden bytes',
    'Mutation creation snapshots target and canonical payload before hashing, including shared-buffer binary inputs',
    'Actual local Yjs event capture, pure-delete bases, contamination refusal and retained capture failures',
    'Explicit evidence persisted with update/journal bytes atomically and copied before asynchronous scheduling',
    'Checkpoint mutation bytes preserved exactly and direct production kernel evidence validation before writes'],
  excluded: ['Authored deletion intent or a reconstructible causal source basis',
    'Production automatic capture or live editor integration', 'Native alias deletion routing or repair',
    'Legacy-client deletion provenance recovery', 'Full checkpoint semantic acceptance',
    'Physical input, IME, native UI or real device execution', 'Real-account sync', 'Distribution'],
};
const hash = value => createHash('sha256').update(value).digest('hex');
function manifest() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0');
  const explicit = new Set([script, 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vitest.config.ts', 'vitest.shared.ts',
    'src/renderer/lib/db.ts', 'src/renderer/lib/yjs-persistence-origin.ts', 'src/renderer/lib/yjs-doc-id.ts',
    'src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite.ts',
    'src/renderer/lib/extensions/block-id.ts', 'src/renderer/lib/extensions/entity-link.ts',
    'src/renderer/services/atomic-sync-transaction-tracker.ts', 'src/renderer/services/snapshot-history.service.ts',
    'src/renderer/store/data-store.ts']);
  return [...new Set(files)].filter(file => file && existsSync(file) && (
    explicit.has(file) || file.startsWith('src/renderer/sync/') || file.startsWith('src/renderer/schema/')
    || file.startsWith('src/renderer/domain/') || file.startsWith('src/renderer/sqlite-repo/')
    || file.startsWith('src/renderer/services/yjs-') || file.startsWith('src/renderer/platform/database')
    || file.startsWith('src/renderer/lib/agent/runtime/yjs-') || file.startsWith('drizzle/') || file.startsWith('patches/')))
    .sort().map(file => ({ path: file, sha256: hash(readFileSync(file)) }));
}
function relative(file) {
  const value = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  assert(value && !value.startsWith('../') && !path.isAbsolute(value), 'Path must belong to this checkout');
  return value;
}
function validate(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'apple_yjs_transaction_provenance');
  assert.equal(report.status, 'passed'); assert.deepEqual(report.scope, scope);
  assert.equal(report.generator.path, script); assert.equal(report.generator.sha256, hash(readFileSync(script)));
  assert.deepEqual(report.source.files, manifest(), 'Yjs transaction provenance evidence is stale');
  assert.equal(report.source.fingerprint, hash(JSON.stringify(report.source.files)));
  assert.deepEqual(report.cases, acceptedCases);
  assert.deepEqual(report.run.requiredSuites, suites.map(suite => ({ file: suite.file, passed: suite.count, failed: 0, skipped: 0 })));
  assert(['collected-existing-vitest', 'ran-seven-vitest-suites'].includes(report.run.mode));
  assert.match(report.run.rawSha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.run.overall.success, true); assert.equal(report.run.overall.failed, 0);
  assert(report.run.overall.passed >= total);
  assert.equal(report.run.overall.skipped, report.run.skippedTests.length);
  assert.equal(report.run.overall.total, report.run.overall.passed + report.run.overall.skipped);
  for (const skipped of report.run.skippedTests) {
    assert(!suites.some(suite => suite.file === skipped.file)); assert.equal(relative(skipped.file), skipped.file);
    assert.equal(typeof skipped.name, 'string'); assert(['pending', 'skipped', 'todo'].includes(skipped.status));
  }
  assert(!/\/(?:Users|home|private\/var)\//u.test(JSON.stringify(report)), 'No local user paths in durable evidence');
}

const manifestPath = option('manifest');
if (manifestPath) {
  assert(!process.argv.includes('--check') && !option('collect') && !option('source-before'), '--manifest is a standalone source-freeze operation');
  const destination = relative(manifestPath);
  assert.equal(spawnSync('git', ['check-ignore', '--quiet', '--', destination]).status, 0, '--manifest output must be ignored');
  const files = manifest();
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(files, null, 2)}\n`);
  console.log(`Yjs transaction provenance source manifest: ${files.length} files. ${destination}`);
  process.exit(0);
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log(`Yjs transaction provenance: ${total} source-matched cases; deletion intent and native execution remain unaccepted.`);
  process.exit(0);
}

let rawPath = option('collect'), beforePath = option('source-before');
assert(Boolean(rawPath) === Boolean(beforePath), '--collect and --source-before must be provided together');
const mode = rawPath ? 'collected-existing-vitest' : 'ran-seven-vitest-suites';
if (!rawPath) {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const temporary = mkdtempSync('.local-data/apple-native/yjs-provenance-');
  rawPath = path.join(temporary, 'vitest.json'); beforePath = path.join(temporary, 'source-before.json');
  writeFileSync(beforePath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites.map(suite => suite.file), '--reporter=json', `--outputFile=${path.resolve(rawPath)}`],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(temporary, 'vitest.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, 'Yjs provenance Vitest run failed');
}
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
assert(Array.isArray(before));
const sortedBefore = [...before].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
assert.deepEqual(sortedBefore, manifest(), 'Source-before manifest must match every current scoped file exactly');
const rawBytes = readFileSync(rawPath), raw = JSON.parse(rawBytes);
assert.equal(raw.success, true); assert.equal(raw.numFailedTests, 0); assert.equal(raw.numFailedTestSuites, 0);
const all = raw.testResults.flatMap(suite => suite.assertionResults.map(test => ({ file: relative(suite.name),
  name: test.fullName, status: test.status })));
assert(all.length > 0 && all.every(test => ['passed', 'pending', 'skipped', 'todo'].includes(test.status)));
assert.equal(all.length, raw.numTotalTests);
const skippedTests = all.filter(test => test.status !== 'passed');
assert.equal(all.filter(test => test.status === 'passed').length, raw.numPassedTests);
assert.equal(skippedTests.length, raw.numPendingTests + raw.numTodoTests);
const requiredSuites = suites.map(suite => {
  const matches = raw.testResults.filter(result => relative(result.name) === suite.file);
  assert.equal(matches.length, 1, `Missing or repeated required Vitest suite: ${suite.file}`);
  assert.equal(matches[0].status, 'passed');
  const tests = all.filter(test => test.file === suite.file);
  assert(tests.every(test => test.status === 'passed'), `Skipped or failed required suite: ${suite.file}`);
  assert.deepEqual(tests.map(test => test.name).sort(), suite.names, `Every fixed case must execute exactly once: ${suite.file}`);
  assert.equal(tests.length, suite.count);
  return { file: suite.file, passed: tests.length, failed: 0, skipped: 0 };
});
assert.deepEqual(manifest(), sortedBefore, 'Scoped sources changed during collection');
const report = { schemaVersion: 1, kind: 'apple_yjs_transaction_provenance', status: 'passed', generatedAt: new Date().toISOString(),
  generator: { path: script, sha256: hash(readFileSync(script)) },
  source: { fingerprint: hash(JSON.stringify(sortedBefore)), files: sortedBefore }, scope, cases: acceptedCases,
  run: { mode, rawSha256: hash(rawBytes), requiredSuites,
    overall: { success: raw.success, total: raw.numTotalTests, passed: raw.numPassedTests, failed: raw.numFailedTests,
      skipped: skippedTests.length }, skippedTests },
};
validate(report);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Yjs transaction provenance: ${total} accepted structural/capture/SQLite cases. ${output}`);
