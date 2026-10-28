#!/usr/bin/env node

// Read only the explicit test bundle, its private WebKit report and synthetic
// cloud events. Never export storage contents, manuscript text or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const { values } = parseArgs({ options: { manifest: { type: 'string' } } });
assert(values.manifest, '--manifest is required');
const manifest = JSON.parse(readFileSync(values.manifest, 'utf8'));
assert(/^cc\.drifting\.wt\.w[a-f0-9]{12}$/.test(manifest.identifier));
assert.equal(manifest.serviceOrigin, 'https://sentry-acceptance.invalid');
assert.equal(manifest.buildApp, true);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
for (const [file, hash] of Object.entries(manifest.sourceSha256)) assert.equal(sha(readFileSync(file)), hash, `Stale package source: ${file}`);
const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(manifest.appBundlePath, 'Contents/Info.plist')], { encoding: 'utf8' }));
assert.equal(info.CFBundleIdentifier, manifest.identifier);
execFileSync('codesign', ['--verify', '--deep', '--strict', manifest.appBundlePath]);
assert.equal(sha(readFileSync(path.join(manifest.appBundlePath, 'Contents/MacOS', info.CFBundleExecutable))), manifest.executableSha256);
assert.equal(sha(readFileSync(path.join(manifest.frontendDirectory, 'index.html'))), manifest.frontendIndexSha256);
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
assert.equal(files(manifest.frontendDirectory).filter(file => file.endsWith('.map')).length, 0);
assert.equal(files(manifest.appBundlePath).filter(file => file.endsWith('.map')).length, 0);
const tauri = JSON.parse(readFileSync(manifest.configPath, 'utf8'));
assert.equal(tauri.build.frontendDist, manifest.frontendDirectory);
assert.equal(tauri.build.devUrl, null);
assert.equal(tauri.bundle.createUpdaterArtifacts, false);
assert.equal(tauri.app.windows[0].incognito, false);
const storageRoot = path.join(homedir(), 'Library', 'WebKit', manifest.identifier, 'WebsiteData');
let observation;
for (const file of files(storageRoot).filter(file => file.endsWith('/localstorage.sqlite3'))) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('__DRIFTING_SENTRY_PACKAGED_ACCEPTANCE__');
    if (row) observation = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf16le'));
  } finally { db.close(); }
}
assert(observation, 'No app-generated acceptance observation');
assert.equal(observation.release, manifest.release);
for (const key of ['packagedTauriScheme', 'isolatedDataPath', 'initialErrorDelivered', 'optOutSilent',
  'failedDeliveryQueued', 'sameEventIdRetried', 'canonicalWritingFound', 'writingFoundAfterRelaunch']) {
  assert.equal(observation.checks[key], true, `Packaged check failed: ${key}`);
}
assert(observation.boots.length >= 2 && observation.boots[1].consent === false, 'Opt-out preference did not persist');
assert.equal(observation.queued, 0);
assert.equal(observation.attempts.filter(attempt => attempt.phase === 'optout').length, 0);
const initial = observation.attempts.find(attempt => attempt.phase === 'initial' && attempt.kind === 'event' && attempt.outcome === 200);
const failed = observation.attempts.find(attempt => attempt.outcome === 'injected-network-failure');
assert(initial && failed && /^[a-f0-9]{32}$/.test(initial.eventId) && /^[a-f0-9]{32}$/.test(failed.eventId));
assert(observation.attempts.some(attempt => attempt.eventId === failed.eventId && attempt.outcome === 200));
const cli = (...args) => execFileSync('pnpm', ['exec', 'sentry', ...args], { encoding: 'utf8' }).trim();
const token = cli('auth', 'token');
async function event(id) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`https://sentry.io/api/0/projects/drifting/drifting-client/events/${id}/`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 404 || attempt === 3) break;
    await pause(2000); // Ingest acknowledgement precedes event indexing.
  }
  assert(response.ok, `Cloud event HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.release.version, manifest.release);
  assert.equal(result.tags.find(tag => tag.key === 'environment')?.value, 'sentry-acceptance');
  assert.equal(result.tags.find(tag => tag.key === 'platform')?.value, 'macos');
  assert.equal(result.errors.length, 0);
  assert(!JSON.stringify(result).includes('SENTRY-PACKAGED-WRITING-20261029'), 'Synthetic writing leaked to event');
  const exception = result.entries.find(entry => entry.type === 'exception').data.values[0];
  assert.equal(exception.type, 'DriftingSentryPackagedError');
  const frame = exception.stacktrace.frames.find(frame => frame.filename.endsWith(manifest.canarySource) && frame.lineNo === manifest.canaryLine);
  assert(frame && frame.context.some(([line, code]) => line === manifest.canaryLine && code.includes('new Error')));
  const raw = exception.rawStacktrace?.frames ?? [];
  assert(raw.some(frame => (frame.absPath ?? frame.filename ?? '').startsWith('tauri://localhost/assets/')), 'Cloud did not retain a packaged native frame');
  return { id, issueId: result.groupID, title: result.title, file: manifest.canarySource, line: frame.lineNo, column: frame.colNo };
}
const [firstEvent, retryEvent] = await Promise.all([event(initial.eventId), event(failed.eventId)]);
const logs = JSON.parse(cli('log', 'list', 'drifting/drifting-client', '--fresh', '--json', '--limit', '25',
  '--query', `sentry.environment:sentry-acceptance sentry.release:${manifest.release}`));
assert(logs.data.some(log => log.message === 'update-check-completed' && log.severity === 'info'));
const report = {
  schemaVersion: 1, verifiedAt: new Date().toISOString(), status: 'passed',
  mainRevision: manifest.mainRevision, buildRevision: manifest.revision, release: manifest.release,
  environment: 'sentry-acceptance', sourceSha256: manifest.sourceSha256,
  artifact: { name: path.basename(manifest.appBundlePath), identifier: manifest.identifier,
    nativeBuild: 'debug', rendererBuild: 'production-minified', signature: 'verified-local-apple-development',
    executableSha256: manifest.executableSha256, frontendIndexSha256: manifest.frontendIndexSha256,
    scheme: 'tauri://localhost', sourceMapFiles: 0, notarized: false },
  cloud: { project: 'drifting/drifting-client', firstEvent, retryEvent,
    issueUrl: `https://drifting.sentry.io/issues/${firstEvent.issueId}/`, operationalLogFound: true },
  checks: observation.checks, restart: { launches: observation.boots.length,
    optOutPreferencePreserved: true, canonicalWritingPreserved: true },
  delivery: { optOutRequests: 0, finalQueueLength: 0, stableRetryEventId: failed.eventId,
    outageMethod: 'destination-specific-fetch-fault-injection', recovery: 'real-sentry-https-delivery' },
  limitations: ['local-debug-package-not-notarized-distribution', 'network-outage-injected-no-system-network-change',
    'normal-exit-and-relaunch-not-power-loss', 'production-ci-and-publishing-remain-paused'],
};
writeFileSync('docs/acceptance/sentry-packaged.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Packaged Mac acceptance passed: ${report.cloud.issueUrl}; ${Object.keys(report.checks).length} app-generated checks verified.`);
