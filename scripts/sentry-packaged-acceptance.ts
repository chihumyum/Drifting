// Operator-only entry injected by the explicit packaged acceptance build.
// It is never imported by the normal application entry or distributed builds.
import { eq } from 'drizzle-orm';
import { platform } from '../src/renderer/platform';
import { useSettingsStore } from '../src/renderer/store/settings-store';
import { getDbIfInitialized } from '../src/renderer/lib/db';
import { BookNodeTable, ProjectTable } from '../src/renderer/schema/drizzle';
import { getChapterContentJson } from '../src/renderer/lib/agent/chapter-prose';
import { flushLocalApplicationPersistence } from '../src/renderer/lib/persistence-lifecycle';
import { flushCrashReports, reportDiagnosticLog } from '../src/renderer/services/diagnostics/crash-reporter';
import { runtimeViteEnv } from '../src/renderer/lib/vite-runtime-env';

async function installPackagedAcceptance() {
const KEY = '__DRIFTING_SENTRY_PACKAGED_ACCEPTANCE__';
const MARKER = 'SENTRY-PACKAGED-WRITING-20261029';
const projectName = 'Sentry packaged acceptance';
const release = runtimeViteEnv.VITE_SENTRY_RELEASE;
const dataPath = await platform.app.getPath('userData');
if (!/[/\\]cc\.drifting\.wt\.w[a-f0-9]{12}[/\\]?$/.test(dataPath)
  || window.location.protocol !== 'tauri:' || runtimeViteEnv.VITE_SENTRY_ENVIRONMENT !== 'sentry-acceptance') {
  throw new Error('Packaged acceptance requires an isolated native bundle');
}
type Attempt = { phase: string; eventId?: string; kind: string; outcome: number | 'injected-network-failure' | 'network-failure' };
type RecordState = { release: string | undefined; boots: Array<{ consent: boolean; queued: number }>;
  attempts: Attempt[]; checks: Record<string, boolean>; phase: string; queued: number; consent: boolean; writingBoot?: number };
const previous = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RecordState | null;
const queue = () => JSON.parse(localStorage.getItem('drifting.diagnostics.queue.v1') ?? '[]').length as number;
const record: RecordState = previous?.release === release ? previous : {
  release, boots: [], attempts: [], checks: {}, phase: 'ready', queued: 0, consent: true,
};
record.boots.push({ consent: useSettingsStore.getState().sendCrashLogs, queued: queue() });
record.checks.packagedTauriScheme = true;
record.checks.isolatedDataPath = true;
let failing = false;
let busy = false;
const section = document.createElement('section');
section.setAttribute('aria-label', 'Sentry package acceptance');
section.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:440px;max-height:65vh;overflow:auto;padding:12px;background:#fff;color:#111;border:1px solid #777;border-radius:12px;font:12px system-ui;box-shadow:0 6px 28px #0003';
const heading = document.createElement('strong');
heading.textContent = 'Sentry package acceptance';
section.append(heading);
const status = document.createElement('pre');
status.setAttribute('aria-label', 'Sentry acceptance report');
status.style.cssText = 'white-space:pre-wrap;max-height:220px;overflow:auto';
function persist() {
  record.queued = queue(); record.consent = useSettingsStore.getState().sendCrashLogs;
  localStorage.setItem(KEY, JSON.stringify(record));
  status.textContent = JSON.stringify(record, null, 2);
}
const originalFetch = window.fetch.bind(window);
const destination = new URL(runtimeViteEnv.VITE_SENTRY_DSN!).origin;
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url, location.href).origin !== destination) return originalFetch(input, init);
  const lines = String(init?.body ?? '').split('\n');
  const header = JSON.parse(lines[0]);
  const item = JSON.parse(lines[1]);
  const attempt: Attempt = { phase: record.phase, eventId: header.event_id,
    kind: item.type, outcome: failing ? 'injected-network-failure' : 'network-failure' };
  record.attempts.push(attempt); persist();
  if (failing) throw new TypeError('Synthetic Sentry connection unavailable');
  try { const response = await originalFetch(input, init); attempt.outcome = response.status; persist(); return response; }
  catch (error) { persist(); throw error; }
};
function throwPackagedError(phase: string): never {
  const error = new Error(`Drifting Sentry packaged verification ${phase}`);
  error.name = 'DriftingSentryPackagedError';
  throw error;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function syntheticError(phase: string) {
  record.phase = phase; persist();
  setTimeout(() => throwPackagedError(phase), 0);
  await pause(1000); await flushCrashReports();
  await pause(500); persist();
}
function button(label: string, action: () => Promise<void>) {
  const element = document.createElement('button'); element.textContent = label;
  element.style.cssText = 'margin:5px;padding:6px;border:1px solid #777;border-radius:6px;background:#eee;color:#111';
  element.onclick = async () => {
    if (busy) return; busy = true;
    try { await action(); } catch (error) { record.phase = `acceptance-failed:${error instanceof Error ? error.name : 'Error'}`; }
    finally { busy = false; persist(); }
  };
  section.append(element);
}
button('1. Send packaged error and log', async () => {
  useSettingsStore.getState().setSendCrashLogs(true);
  reportDiagnosticLog('update-check-completed', { durationMs: 41 });
  await syntheticError('initial');
  await (await import('../src/renderer/services/diagnostics/sentry-reporter')).flushSentryLogs();
  record.checks.initialErrorDelivered = record.attempts.some(a => a.phase === 'initial' && a.kind === 'event' && a.outcome === 200);
});
button('2. Verify opt-out and leave disabled', async () => {
  await (await import('../src/renderer/services/diagnostics/sentry-reporter')).flushSentryLogs();
  useSettingsStore.getState().setSendCrashLogs(false);
  const before = record.attempts.length;
  await syntheticError('optout');
  reportDiagnosticLog('update-check-completed', { durationMs: 42 });
  await (await import('../src/renderer/services/diagnostics/sentry-reporter')).flushSentryLogs();
  record.checks.optOutSilent = record.attempts.length === before && queue() === 0;
});
button('3. Queue error with injected Sentry outage', async () => {
  useSettingsStore.getState().setSendCrashLogs(true); failing = true;
  await syntheticError('retry');
  record.checks.failedDeliveryQueued = queue() === 1;
});
button('4. Restore Sentry connection and retry', async () => {
  failing = false; record.phase = 'retry';
  window.dispatchEvent(new Event('online'));
  await flushCrashReports(); await pause(1000);
  const failed = record.attempts.find(a => a.phase === 'retry' && a.outcome === 'injected-network-failure');
  record.checks.sameEventIdRetried = !!failed?.eventId && record.attempts.some(a => a.phase === 'retry'
    && a.outcome === 200 && a.eventId === failed.eventId) && queue() === 0;
});
button('5. Flush and check synthetic writing', async () => {
  await flushLocalApplicationPersistence();
  const db = getDbIfInitialized(); if (!db) throw new Error('Database not ready');
  const projects = await db.select().from(ProjectTable).where(eq(ProjectTable.name, projectName));
  if (projects.length !== 1) throw new Error('Synthetic library required');
  const nodes = await db.select().from(BookNodeTable).where(eq(BookNodeTable.projectId, projects[0].id));
  let found = false;
  for (const node of nodes) if ((await getChapterContentJson(node.id, null)).includes(MARKER)) found = true;
  record.checks.canonicalWritingFound = found;
  if (found && record.writingBoot === undefined) record.writingBoot = record.boots.length;
  if (found && record.boots.length > record.writingBoot!) record.checks.writingFoundAfterRelaunch = true;
  record.phase = found ? 'writing-verified' : 'writing-marker-missing';
});
section.append(status);
document.body.append(section);
persist();
}
void installPackagedAcceptance().catch(error => {
  const failure = document.createElement('pre');
  failure.textContent = `Packaged acceptance initialization failed: ${error instanceof Error ? error.message : 'Error'}`;
  document.body.append(failure);
});
