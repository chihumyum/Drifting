// Sanitized failed-attempt evidence; never an accepted renderer performance baseline.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert(option('input'), 'Provide --input=<raw-report.json> explicitly');
const bytes = readFileSync(path.resolve(root, option('input'))), raw = JSON.parse(bytes);
const failure = JSON.parse(readFileSync(path.join(root, '.local-data/apple-native/editor-performance/renderer.failed.json')));
const prepared = JSON.parse(readFileSync(path.join(root, '.local-data/apple-native/editor-performance/renderer.prepared.json')));
assert.equal(raw.kind, 'apple-editor-performance-renderer');
assert.equal(raw.status, 'failed');
assert.deepEqual(raw, failure.measurement, 'Failure provenance must belong to this exact attempt');
assert.deepEqual(failure.source, prepared.sourceProvenance);
assert.equal(raw.corpusSha256, prepared.corpus.corpusSha256);
assert(Array.isArray(raw.samples) && Array.isArray(raw.focusTransitions));
assert(['Error: Visible window did not deliver animation frame', 'Error: Performance window lost foreground visibility/focus'].includes(raw.message));
const state = value => {
  assert(Number.isFinite(value.atMs) && value.atMs >= 0);
  assert.equal(typeof value.focused, 'boolean');
  assert(['visible', 'hidden'].includes(value.visibility));
  return { atMs: value.atMs, focused: value.focused, visibility: value.visibility };
};
const digest = value => { assert.match(value, /^[a-f0-9]{64}$/); return value; };
const report = {
  schemaVersion: 1, kind: 'apple-renderer-performance-diagnostic', status: 'incomplete', generatedAt: failure.generatedAt,
  rawReportSha256: sha256(bytes), corpusSha256: digest(raw.corpusSha256),
  runtimeSourceFingerprint: digest(failure.source.fingerprint),
  preparedArtifact: { executableSha256: digest(prepared.artifact.sha256), bundleSha256: digest(prepared.artifact.bundleSha256),
    procMacroWrapperSha256: digest(prepared.artifact.procMacroLinkerWorkaround.wrapperSha256) },
  generatorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  failureMessage: raw.message, completedSampleCount: raw.samples.length,
  observation: state({ atMs: raw.observedAtMs, focused: raw.focused, visibility: raw.visibility }),
  focusTransitions: raw.focusTransitions.map(row => {
    assert(['focus', 'blur', 'visibilitychange'].includes(row.event));
    return { event: row.event, ...state(row) };
  }),
  boundary: 'One failed foreground attempt. No old renderer baseline or performance comparison accepted.',
  timingBoundary: 'Monotonic milliseconds relative to the renderer performance clock; no physical input latency inferred.',
  limitations: ['Earlier attempts are not aggregated. Focus events do not identify who or which application took focus.',
    'This diagnostic does not establish normal shutdown or database replay acceptance.'],
};
assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
const output = path.resolve(root, option('output') ?? 'docs/apple-native/acceptance/p2c-renderer-performance-diagnostic.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log('Sanitized renderer diagnostic generated; status incomplete.');
