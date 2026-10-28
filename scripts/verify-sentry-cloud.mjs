#!/usr/bin/env node

// Explicit operator-only acceptance. Credentials stay in the CLI credential store
// and process memory; only allowlisted verification results enter the repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({ options: {
  org: { type: 'string' }, project: { type: 'string' }, issue: { type: 'string' },
  alert: { type: 'string' }, manifest: { type: 'string' }, artifacts: { type: 'string' },
  'email-received': { type: 'boolean', default: false },
} });
for (const key of ['org', 'project', 'issue', 'alert', 'manifest', 'artifacts']) {
  assert(values[key], `--${key} is required`);
}
assert(/^[a-z0-9_-]+$/.test(values.org) && /^[a-z0-9_-]+$/.test(values.project));
assert(/^\d+$/.test(values.issue) && /^\d+$/.test(values.alert));
const manifest = JSON.parse(readFileSync(values.manifest, 'utf8'));
assert.equal(manifest.source, 'src/renderer/main.tsx');
assert(Number.isInteger(manifest.line) && manifest.line > 0);
assert(/^[a-zA-Z0-9@+._-]{1,160}$/.test(manifest.release));
assert(/^[a-zA-Z0-9._-]{1,40}$/.test(manifest.environment));
assert(/^[a-f0-9]{40}$/.test(manifest.gitRevision));
for (const key of ['sourceSha256', 'temporaryPatchSha256', 'distIndexSha256']) {
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest[key]));
}
const clientSources = ['crash-reporter.ts', 'crash-sanitize.ts', 'sentry-policy.ts', 'sentry-reporter.ts']
  .map(file => `src/renderer/services/diagnostics/${file}`);
const clientSourceSha256 = Object.fromEntries(clientSources.map(file => [file,
  `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`]));
assert.deepEqual(manifest.clientSourceSha256, clientSourceSha256, 'Canary client sources changed after its build');
const cli = (...args) => execFileSync('pnpm', ['exec', 'sentry', ...args], { encoding: 'utf8' }).trim();
const token = cli('auth', 'token');
const owner = JSON.parse(cli('auth', 'whoami', '--json'));
async function get(endpoint) {
  const response = await fetch(`https://sentry.io/api/0/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `Sentry acceptance request failed: HTTP ${response.status}`);
  return response.json();
}
const [project, issue, event, alert] = await Promise.all([
  get(`projects/${values.org}/${values.project}/`),
  get(`issues/${values.issue}/`), get(`issues/${values.issue}/events/latest/`),
  get(`organizations/${values.org}/workflows/${values.alert}/`),
]);
assert.equal(issue.project.slug, project.slug);
assert.equal(event.release.version, manifest.release);
const tag = key => event.tags.find(item => item.key === key)?.value;
assert.equal(tag('environment'), manifest.environment);
assert.equal(tag('platform'), 'macos');
assert.equal(tag('kind'), 'renderer-error');
assert.equal(event.errors.length, 0, 'Sentry reported event-processing errors');
const exceptions = event.entries.filter(entry => entry.type === 'exception').flatMap(entry => entry.data.values);
const exception = exceptions.find(item => item.type === 'DriftingSentrySetupError');
assert.equal(exception?.value, manifest.message);
const frame = exception.stacktrace.frames.find(item => item.filename.endsWith(manifest.source) && item.lineNo === manifest.line);
assert(frame, 'Cloud source mapping did not resolve the exact canary source line');
assert(frame.context.some(([line, text]) => line === manifest.line && text.includes(manifest.message)));
assert.equal(alert.enabled, true);
assert(alert.lastTriggered, 'Alert has not triggered');
assert.equal(alert.config.frequency, 30);
const triggers = alert.triggers.conditions.map(condition => condition.type).sort();
assert.deepEqual(triggers, ['first_seen_event', 'regression_event']);
assert(alert.actionFilters.some(filter => filter.conditions.some(condition => condition.type === 'level'
  && condition.comparison.level === 40 && condition.comparison.match === 'gte')
  && filter.actions.some(action => action.type === 'email' && action.config.targetType === 'user'
    && action.config.targetIdentifier === owner.id)));
const logsResult = JSON.parse(cli('log', 'list', `${values.org}/${values.project}`, '--fresh', '--json', '--limit', '25',
  '--query', `sentry.environment:${manifest.environment} sentry.release:${manifest.release}`));
const log = logsResult.data.find(item => item.message === 'update-check-completed'
  && Math.abs(Date.parse(item.timestamp) - Date.parse(event.dateCreated)) < 180000);
assert(log, 'The canary operational log was not found in Sentry');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
const artifacts = files(values.artifacts);
assert.equal(artifacts.filter(file => file.endsWith('.map')).length, 0);
const indexSha256 = `sha256:${createHash('sha256').update(readFileSync(path.join(values.artifacts, 'index.html'))).digest('hex')}`;
assert.equal(indexSha256, manifest.distIndexSha256);
const publicDsn = parseEnv(readFileSync('.env.local', 'utf8')).VITE_SENTRY_DSN;
const keys = await get(`projects/${values.org}/${values.project}/keys/`);
assert(keys.some(key => key.isActive && key.dsn.public === publicDsn));
const report = {
  schemaVersion: 1, verifiedAt: new Date().toISOString(),
  organization: values.org, project: values.project, status: 'cloud-error-log-and-alert-verified',
  build: { revision: manifest.gitRevision, release: manifest.release, environment: manifest.environment,
    runtime: 'fresh-isolated-tauri-debug-host-serving-minified-full-renderer', temporarySyntheticCanary: true,
    sourceSha256: manifest.sourceSha256, temporaryPatchSha256: manifest.temporaryPatchSha256,
    clientSourceSha256, distIndexSha256: indexSha256 },
  issue: { id: issue.id, shortId: issue.shortId, title: issue.title, url: issue.permalink, eventId: event.eventID },
  sourceMapping: { file: manifest.source, line: frame.lineNo, column: frame.colNo,
    exactSourceContextVerified: true, processingErrors: 0, localArtifactMapCount: 0 },
  log: { message: log.message, severity: log.severity, timestamp: log.timestamp },
  alert: { id: alert.id, url: `https://${values.org}.sentry.io/monitors/alerts/${alert.id}/`,
    enabled: alert.enabled, triggers, minimumLevel: 'error', throttleMinutes: alert.config.frequency,
    recipients: 'account-owner-only', lastTriggered: alert.lastTriggered,
    emailDelivery: values['email-received'] ? 'confirmed-by-owner' : 'not-confirmed-by-owner' },
  checks: ['active-public-dsn', 'real-mac-renderer-uncaught-error', 'exact-cloud-source-line',
    'source-maps-absent-from-local-artifacts', 'real-cloud-operational-log', 'enabled-and-triggered-email-rule'],
  limitations: ['debug-native-host-over-loopback-http-not-packaged-release',
    'email-receipt-is-a-separate-human-check', 'production-ci-and-distribution-not-enabled',
    'writing-restart-and-real-cloud-opt-out-retry-not-accepted'],
};
writeFileSync('docs/acceptance/sentry-cloud.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Verified ${issue.shortId}: ${manifest.source}:${frame.lineNo}; cloud log and alert present. Email receipt: ${report.alert.emailDelivery}.`);
