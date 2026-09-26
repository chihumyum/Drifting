// Reproduce an open alias-deletion ambiguity with the actual document CLI and
// installed Yjs. A successful diagnostic run is not deletion acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const script = 'scripts/apple-alias-delete-diagnostic.mjs';
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
  ?? 'docs/apple-native/acceptance/alias-delete-diagnostic.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
});
const inputs = () => [...new Set(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
  .filter(file => file && existsSync(file) && (file.startsWith('crates/drifting-document/')
    || file.startsWith('vendor/yrs/') || [script, 'package.json', 'pnpm-lock.yaml'].includes(file)))
  .sort().map(file => ({ path: file, sha256: hash(readFileSync(file)) }));
const source = () => ({ generator: script, generatorSha256: hash(readFileSync(script)),
  fingerprint: hash(JSON.stringify(inputs())), yjsVersion: JSON.parse(readFileSync('node_modules/yjs/package.json')).version,
  yrsVersion: '0.28.0' });
const scope = {
  layer: 'Actual DocumentSession CLI and ordinary Yjs, synthetic right-survivor partial quote deletion',
  deletionCases: 'Three old-layout source deletions, each delivered as an exact event and a full state after native insertion repair',
  ambiguity: 'An actual source deletion coalesced with the repaired state has the same full-state and same-state-vector differential bytes as a harmless repeat',
  compatibility: 'Ordinary Yjs duplicate and safe suffix state-vector differential remain accepted by the current native document API',
  excluded: ['Durable owner blocked-row cancellation', 'Author or operation provenance', 'General alias delete support',
    'Physical input', 'Performance', 'P2 completion'],
};
const variants = [
  { name: 'late-only', offset: 0, length: 1, oldText: '潮汐', expected: '潮航\n远🙂终章' },
  { name: 'base-only', offset: 1, length: 1, oldText: '保汐', expected: '保航\n远🙂终章' },
  { name: 'late-and-base', offset: 0, length: 2, oldText: '汐', expected: '航\n远🙂终章' },
];
const before = '保潮航\n远🙂终章';
const controls = ['same-state-vector-repeat', 'aware-peer-safe-suffix-differential'];
function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'apple_alias_delete_diagnostic');
  assert.equal(report.status, 'open');
  assert.equal(report.diagnosticReproduced, true);
  assert.equal(report.productDeletionAcceptance, 'not-established');
  assert.deepEqual(report.scope, scope);
  assert.deepEqual(report.source, source(), 'Alias deletion diagnostic is stale; rerun its generator');
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  assert.match(report.cli.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.cli.sourceFingerprint, report.source.fingerprint);
  assert.equal(report.cli.build, 'cargo build --locked --manifest-path crates/drifting-document/Cargo.toml --example document_protocol');
  assert.deepEqual(report.deletionCases.map(value => `${value.variant}/${value.delivery}`),
    variants.flatMap(value => ['event', 'full'].map(delivery => `${value.name}/${delivery}`)));
  for (const value of report.deletionCases) {
    const variant = variants.find(item => item.name === value.variant);
    assert.equal(value.scope, 'after-repair-old-layout-delete');
    assert.equal(value.before, before);
    assert.equal(value.actual, before);
    assert.equal(value.expectedIfLogicalSourceDeletionWereSupported, variant.expected);
    assert.equal(value.actualOldPeerSourceText, variant.oldText);
    assert.equal(value.applyAccepted, true);
    assert.equal(value.hasPending, false);
    assert.equal(value.deleteSemanticsSatisfied, false);
    assert.equal(value.outcome, 'accepted-without-logical-source-deletion');
    assert.match(value.inputSha256, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(report.indistinguishableCases.map(value => value.variant), variants.map(value => value.name));
  for (const value of report.indistinguishableCases) {
    assert.equal(value.scope, 'coalesced-wire-ambiguity');
    assert.equal(value.fullBytesEqual, true); assert.equal(value.differentialBytesEqual, true);
    assert.equal(value.fullSha256, value.fullWithOldDeleteSha256);
    assert.equal(value.differentialSha256, value.differentialWithOldDeleteSha256);
    for (const key of ['fullSha256', 'fullWithOldDeleteSha256', 'differentialSha256', 'differentialWithOldDeleteSha256']) {
      assert.match(value[key], /^[a-f0-9]{64}$/u);
    }
  }
  assert.deepEqual(report.compatibilityControls.map(value => value.name), controls);
  for (const value of report.compatibilityControls) {
    assert.equal(value.scope, 'current-normal-incremental-compatibility');
    assert.match(value.inputSha256, /^[a-f0-9]{64}$/u);
    assert.equal(value.applyAccepted, true); assert.equal(value.hasPending, false);
    assert.equal(value.expected, value.actual);
    assert.equal(value.carriesProtectedSourceDeleteSet, true);
    assert.equal(value.containsAliasMapStructs, false);
  }
  assert.equal(report.compatibilityControls[0].structs, 0);
  assert.equal(report.compatibilityControls[1].structs, 1);
  assert.equal(report.compatibilityControls[0].actual, before);
  assert.equal(report.compatibilityControls[1].actual, '保潮航\n安远🙂终章');
  assert(!/\/(?:Users|home|private\/var)\//u.test(JSON.stringify(report)), 'Diagnostic must not contain personal paths');
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Alias deletion diagnostic is source-current: six unresolved deletions and three wire ambiguities; status open.');
  process.exit(0);
}

const baseline = source();
mkdirSync('.local-data/apple-native', { recursive: true });
const temporary = mkdtempSync('.local-data/apple-native/alias-delete-diagnostic-');
const cli = 'crates/drifting-document/target/debug/examples/document_protocol';
try {
  writeFileSync(path.join(temporary, 'build.log'), run('cargo', [
    'build', '--locked', '--manifest-path', 'crates/drifting-document/Cargo.toml', '--example', 'document_protocol',
  ]));
} catch (error) {
  writeFileSync(path.join(temporary, 'build.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  throw new Error('Alias diagnostic CLI build failed; inspect the ignored diagnostic build log');
}
assert.deepEqual(source(), baseline, 'Document sources changed during diagnostic build');
const cliSha256 = hash(readFileSync(cli));
const processHandle = spawn(cli, [], { stdio: ['pipe', 'pipe', 'pipe'] });
let pending;
const protocolErrors = [];
processHandle.stderr.on('data', value => protocolErrors.push(String(value)));
createInterface({ input: processHandle.stdout }).on('line', line => {
  const request = pending; pending = null;
  if (!request) return;
  try {
    const result = JSON.parse(line);
    if (result.ok) request.resolve(result.value); else request.reject(new Error(result.error));
  } catch (error) { request.reject(error); }
});
processHandle.on('error', error => { pending?.reject(error); pending = null; });
const exited = new Promise(resolve => processHandle.on('exit', code => {
  pending?.reject(new Error('Document diagnostic CLI exited during a request')); pending = null; resolve(code);
}));
function request(session, command, body = {}) {
  assert(!pending, 'Document diagnostic requests must be sequential');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending = null; reject(new Error(`Document diagnostic timeout: ${command}`)); }, 30_000);
    pending = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
    processHandle.stdin.write(`${JSON.stringify({ session, command, ...body })}\n`);
  });
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const bytes = value => Buffer.from(value, 'base64');
function text(doc, id) {
  function visit(root) {
    for (const value of root.toArray()) {
      if (!(value instanceof Y.XmlElement)) continue;
      if (value.getAttribute('id') === id) return value.get(0);
      const nested = visit(value); if (nested) return nested;
    }
  }
  const value = visit(doc.getXmlFragment('default'));
  assert(value instanceof Y.XmlText, `Missing synthetic ${id}`); return value;
}
function document(initial, client) {
  const doc = new Y.Doc(); doc.clientID = client;
  if (initial) Y.applyUpdate(doc, initial); return doc;
}
function seedDocument() {
  const doc = document(null, 37501);
  const paragraph = (id, value) => {
    const node = new Y.XmlElement('paragraph'); node.setAttribute('id', id);
    node.insert(0, [new Y.XmlText(value)]); return node;
  };
  const quote = (id, children) => {
    const node = new Y.XmlElement('blockquote'); node.setAttribute('id', id); node.insert(0, children); return node;
  };
  doc.getXmlFragment('default').push([
    quote('left', [paragraph('b', '潮汐')]), quote('right', [paragraph('c', '夜航'), paragraph('d', '终章')]),
  ]);
  return doc;
}
function event(doc, operation) {
  let update; const observer = value => { assert(!update); update = value; };
  doc.on('update', observer);
  try { operation(); assert(update, 'Expected a real Yjs update event'); return update; }
  finally { doc.off('update', observer); }
}
function sourceId(text, index) {
  const id = Y.createRelativePositionFromTypeIndex(text, index, 0).item;
  assert(id); return id;
}
const report = { schemaVersion: 1, kind: 'apple_alias_delete_diagnostic', status: 'open',
  generatedAt: new Date().toISOString(), diagnosticReproduced: true, productDeletionAcceptance: 'not-established',
  source: baseline, cli: { build: 'cargo build --locked --manifest-path crates/drifting-document/Cargo.toml --example document_protocol',
    sha256: cliSha256, sourceFingerprint: baseline.fingerprint }, scope,
  deletionCases: [], indistinguishableCases: [], compatibilityControls: [],
  interpretation: [
    'The current document API accepts these old-layout deletes after relocation repair without deleting their visible logical counterparts.',
    'The same deletion can disappear into pre-existing structural and repair DeleteSets; identical wire bytes cannot identify an author or a newly intended operation.',
    'Local alias receipts prove source-to-render mappings, not the provenance of a newly received DeleteSet.',
    'Requiring every incoming packet to carry a complete repair closure would also retain normal state-vector differential traffic; these controls expose that compatibility cost.',
    'This report keeps the defect open. It is neither successful deletion acceptance nor authorization to reinterpret raw DeleteSets as authored intent.',
  ] };
const documents = [];
try {
  const seed = seedDocument(); documents.push(seed);
  const seedBytes = Y.encodeStateAsUpdate(seed), author = document(seedBytes, 37901); documents.push(author);
  const dependency = event(author, () => text(author, 'd').insert(0, '远🙂'));
  const insertion = event(author, () => text(author, 'b').insert(0, '保'));
  const protectedIds = [sourceId(text(author, 'b'), 0), sourceId(text(author, 'b'), 1)];
  const authoredBeforeDelete = Y.encodeStateAsUpdate(author);
  await request('basis', 'open', { clientId: 599001 });
  await request('basis', 'apply', { update: b64(seedBytes) });
  const initial = await request('basis', 'projection');
  assert.equal(initial.text, '潮汐\n夜航\n终章');
  await request('basis', 'replace', { edit: { revision: initial.revision, range: { location: 1, length: 3 }, text: '' } });
  await request('basis', 'apply', { update: b64(Y.mergeUpdates([insertion, dependency])) });
  assert.equal((await request('basis', 'projection')).text, before);
  const repaired = bytes(await request('basis', 'export'));
  // These actual old-layout operations occur after the native repair; the
  // author has not received that repair and still targets original b items.
  const deletionFixtures = variants.map((variant, index) => {
    const writer = document(authoredBeforeDelete, 37910 + index); documents.push(writer);
    const deletion = event(writer, () => text(writer, 'b').delete(variant.offset, variant.length));
    assert.equal(text(writer, 'b').toString(), variant.oldText);
    return { ...variant, event: deletion, full: Y.encodeStateAsUpdate(writer) };
  });
  for (const [index, fixture] of deletionFixtures.entries()) {
    for (const delivery of ['event', 'full']) {
      const session = `${fixture.name}-${delivery}`;
      await request(session, 'open', { clientId: 599010 + index * 2 + Number(delivery === 'full') });
      await request(session, 'apply', { update: b64(repaired) });
      assert.equal((await request(session, 'projection')).text, before);
      const applied = await request(session, 'apply', { update: b64(fixture[delivery]) });
      const actual = (await request(session, 'projection')).text;
      report.deletionCases.push({ scope: 'after-repair-old-layout-delete', variant: fixture.name, delivery,
        inputSha256: hash(fixture[delivery]), before, actualOldPeerSourceText: fixture.oldText,
        expectedIfLogicalSourceDeletionWereSupported: fixture.expected, actual,
        applyAccepted: true, hasPending: applied.pending, deleteSemanticsSatisfied: actual === fixture.expected,
        outcome: 'accepted-without-logical-source-deletion' });
      await request(session, 'close');
    }
  }
  const peer = document(repaired, 599020); documents.push(peer);
  const normalFull = Y.encodeStateAsUpdate(peer), vector = Y.encodeStateVector(peer);
  const repeat = Y.encodeStateAsUpdate(peer, vector);
  for (const [index, fixture] of deletionFixtures.entries()) {
    const withDelete = document(normalFull, 599030 + index); documents.push(withDelete);
    Y.applyUpdate(withDelete, fixture.event);
    const changedFull = Y.encodeStateAsUpdate(withDelete), changedDiff = Y.encodeStateAsUpdate(withDelete, vector);
    assert.deepEqual(changedFull, normalFull); assert.deepEqual(changedDiff, repeat);
    report.indistinguishableCases.push({ scope: 'coalesced-wire-ambiguity', variant: fixture.name,
      fullBytesEqual: true, differentialBytesEqual: true, fullSha256: hash(normalFull), fullWithOldDeleteSha256: hash(changedFull),
      differentialSha256: hash(repeat), differentialWithOldDeleteSha256: hash(changedDiff) });
  }
  for (const name of controls) {
    let update = repeat;
    if (name === controls[1]) { text(peer, 'd').insert(0, '安'); update = Y.encodeStateAsUpdate(peer, vector); }
    const decoded = Y.decodeUpdate(update), expected = name === controls[0] ? before : '保潮航\n安远🙂终章';
    const protectedCoverage = protectedIds.every(id => Y.isDeleted(decoded.ds, id));
    const aliases = decoded.structs.some(value => typeof value.parent === 'string' && value.parent.startsWith('drifting.native.relocation-'));
    const applied = await request('basis', 'apply', { update: b64(update) });
    report.compatibilityControls.push({ scope: 'current-normal-incremental-compatibility', name,
      inputSha256: hash(update), applyAccepted: true, hasPending: applied.pending, expected,
      actual: (await request('basis', 'projection')).text, structs: decoded.structs.length,
      carriesProtectedSourceDeleteSet: protectedCoverage, containsAliasMapStructs: aliases });
  }
  await request('basis', 'close');
  processHandle.stdin.end();
  assert.equal(await exited, 0, 'Document diagnostic CLI did not exit normally');
  assert.deepEqual(source(), baseline, 'Document sources changed during diagnosis');
  assert.equal(hash(readFileSync(cli)), cliSha256, 'Document CLI changed during diagnosis');
  validate(report);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Open alias deletion diagnostic reproduced: 6 unresolved deliveries, 3 indistinguishable pairs, 2 compatibility controls. ${output}`);
} finally {
  processHandle.stdin.end();
  for (const doc of documents) doc.destroy();
  writeFileSync(path.join(temporary, 'protocol.log'), protocolErrors.join(''));
  // Close normally first. On a failed request, bound cleanup to this exact
  // child; a hung diagnostic must not leave a document process behind.
  const waitForExit = milliseconds => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    exited.then(() => { clearTimeout(timer); resolve(true); });
  });
  if (processHandle.exitCode === null && processHandle.signalCode === null && !await waitForExit(1_000)) {
    processHandle.kill('SIGTERM');
    if (!await waitForExit(1_000)) {
      processHandle.kill('SIGKILL');
      assert(await waitForExit(1_000), 'Diagnostic child did not terminate during bounded cleanup');
    }
  }
}
