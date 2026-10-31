import { v4 as uuidv4 } from 'uuid';
import { APP_CONFIG, canUseHostedService } from '../../lib/config';
import { getSessionToken } from '../../lib/session-token';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { useSettingsStore } from '../../store/settings-store';
import { reportFingerprint, reportToken, sanitizeReportText, sanitizeStack } from './crash-sanitize';
import { runtimeViteEnv } from '../../lib/vite-runtime-env';
import { configuredSentryDsn } from './sentry-policy';
import type { DiagnosticLogAttributes, DiagnosticLogEvent } from './sentry-policy';

/**
 * Content-free crash and integrity reports, sent to the Hosted service's
 * diagnostics endpoint (see the service's docs/diagnostics-v1.md), which emails
 * the maintainer. Builds without a Hosted service, development builds and
 * authors who turned off Settings → Privacy → Crash logs send nothing.
 */
export type CrashReportKind =
  | 'renderer-error'
  | 'unhandled-rejection'
  | 'render-failure'
  | 'native-panic'
  | 'integrity';
export type CrashReportSeverity = 'fatal' | 'error' | 'warning';

export interface CrashReportPayload {
  format: 'drifting.crash-report';
  formatVersion: 1;
  kind: CrashReportKind;
  severity: CrashReportSeverity;
  fingerprint: string;
  name: string;
  message: string;
  stack: string;
  appVersion: string;
  platform: string;
  installationId: string;
  occurredAt: string;
  context: Record<string, string | number | boolean>;
}

const INSTALLATION_KEY = 'drifting.diagnostics.installation.v1';
const QUEUE_KEY = 'drifting.diagnostics.queue.v1';
const FOLLOW_UPS_KEY = 'drifting.diagnostics.follow-ups.v1';
const MAX_QUEUED = 20;
const MAX_FOLLOW_UPS = 5;
const MAX_PER_SESSION = 30;
const REPEAT_WINDOW_MS = 60 * 60 * 1000;

const recent = new Map<string, number>();
let sentThisSession = 0;
let flushing: Promise<void> | null = null;
let logsThisSession = 0;
let sentryModule: Promise<typeof import('./sentry-reporter')> | undefined;
const loadSentry = () => sentryModule ??= import('./sentry-reporter');
// A render failure is explained on a later launch, never the one it broke.
let launchId = uuidv4();
let launchSettled: Promise<void> = Promise.resolve();

function reportsPermitted(): boolean {
  if (import.meta.env.DEV && import.meta.env.VITE_DRIFTING_CRASH_REPORTS_IN_DEV !== '1') return false;
  return !APP_CONFIG.LOCAL_ONLY_MODE && useSettingsStore.getState().sendCrashLogs;
}

function reportsEnabled(): boolean { return reportsPermitted() && canUseHostedService(); }

/** The random diagnostics-only installation ID that reports and feedback share. */
export function diagnosticsInstallationId(): string {
  try {
    const existing = localStorage.getItem(INSTALLATION_KEY);
    if (existing && /^diag-[a-f0-9-]{36}$/.test(existing)) return existing;
    const created = `diag-${uuidv4()}`;
    localStorage.setItem(INSTALLATION_KEY, created);
    return created;
  } catch {
    return 'diag-unavailable';
  }
}

function readQueue(): CrashReportPayload[] {
  try {
    const value = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? (value as CrashReportPayload[]).slice(-MAX_QUEUED) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: readonly CrashReportPayload[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUED)));
  } catch {
    // A lost diagnostics queue never affects writing.
  }
}

/**
 * A fatal failure the author may explain on a later launch: the report's
 * grouping key and time, and the service's id once it was delivered. The
 * author's note goes out as feedback (feedback.ts), never with the report.
 */
export interface CrashFollowUp {
  kind: 'render-failure' | 'native-panic';
  fingerprint: string;
  occurredAt: string;
  /** The service's id for the report; null when Sentry delivered it. */
  reportId: string | null;
}

interface StoredFollowUp extends CrashFollowUp {
  delivered: boolean;
  /** The launch a render failure happened in; it is offered on a later one. */
  launchId: string | null;
}

function readFollowUps(): StoredFollowUp[] {
  try {
    const value = JSON.parse(localStorage.getItem(FOLLOW_UPS_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? (value as StoredFollowUp[]).slice(-MAX_FOLLOW_UPS) : [];
  } catch {
    return [];
  }
}

function writeFollowUps(followUps: readonly StoredFollowUp[]): void {
  try {
    if (followUps.length === 0) localStorage.removeItem(FOLLOW_UPS_KEY);
    else localStorage.setItem(FOLLOW_UPS_KEY, JSON.stringify(followUps.slice(-MAX_FOLLOW_UPS)));
  } catch {
    // Losing the chance to explain a crash never affects writing.
  }
}

/** Record whether a fatal report reached the service; an undelivered one is never offered. */
function settleFollowUp(report: CrashReportPayload, delivered: boolean, reportId: string | null): void {
  const followUps = readFollowUps();
  const index = followUps.findIndex(
    (item) => item.fingerprint === report.fingerprint && item.occurredAt === report.occurredAt,
  );
  if (index < 0) return;
  if (delivered) followUps[index] = { ...followUps[index]!, delivered: true, reportId };
  else followUps.splice(index, 1);
  writeFollowUps(followUps);
}

/**
 * The newest delivered fatal report from before this launch that the author
 * has not been asked about, at most one per launch. Taking it also retires
 * older ones, so each report is offered once at most.
 */
export function takeCrashFollowUp(): CrashFollowUp | null {
  const followUps = readFollowUps();
  const ready = (item: StoredFollowUp) => item.delivered && item.launchId !== launchId;
  const offer = followUps.filter(ready).pop();
  writeFollowUps(followUps.filter((item) => !ready(item)));
  return offer
    ? { kind: offer.kind, fingerprint: offer.fingerprint, occurredAt: offer.occurredAt, reportId: offer.reportId }
    : null;
}

/** Resolves once this launch's recorded native panics and queued reports were sent or kept. */
export function crashReportsSettled(): Promise<void> {
  return launchSettled;
}

type SendOutcome = { done: false } | { done: true; delivered: boolean; id: string | null };

async function send(report: CrashReportPayload): Promise<SendOutcome> {
  try {
    if (!reportsEnabled()) return { done: false };
    if (configuredSentryDsn(runtimeViteEnv.VITE_SENTRY_DSN)) {
      const { sendSentryReport } = await loadSentry();
      return (await sendSentryReport(report, reportsEnabled))
        ? { done: true, delivered: true, id: null }
        : { done: false };
    }
    const token = getSessionToken();
    const response = await fetch(
      `${APP_CONFIG.API_BASE_URL.replace(/\/$/, '')}/api/diagnostics/v1/reports`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // No keepalive: WebKit refuses keepalive requests that need a CORS
        // preflight, and unsent reports are retried from the queue anyway.
        body: JSON.stringify(report),
      },
    );
    if (response.ok) {
      const body = typeof response.json === 'function'
        ? await response.json().catch(() => null) as { id?: unknown } | null
        : null;
      const id = typeof body?.id === 'string' && /^[A-Za-z0-9:._-]{1,64}$/.test(body.id) ? body.id : null;
      return { done: true, delivered: true, id };
    }
    // A rejected report (invalid, rate limited) is dropped rather than retried.
    return response.status >= 400 && response.status < 500
      ? { done: true, delivered: false, id: null }
      : { done: false };
  } catch {
    return { done: false };
  }
}

/**
 * Send the oldest report until the queue is empty or a send fails. The queue
 * is re-read after every send, so reports added meanwhile are neither lost
 * nor overwritten by a stale copy.
 */
async function drainQueue(): Promise<void> {
  for (;;) {
    if (!reportsEnabled()) return;
    const [next] = readQueue();
    if (!next) return;
    const outcome = await send(next);
    if (!outcome.done) return;
    settleFollowUp(next, outcome.delivered, outcome.id);
    const queue = readQueue();
    const index = queue.findIndex(
      (item) => item.fingerprint === next.fingerprint && item.occurredAt === next.occurredAt,
    );
    if (index >= 0) queue.splice(index, 1);
    writeQueue(queue);
  }
}

/** Bounded machine events only; raw console output is never collected. */
export function reportDiagnosticLog(event: DiagnosticLogEvent, attributes: DiagnosticLogAttributes = {}): void {
  if (!reportsEnabled() || !configuredSentryDsn(runtimeViteEnv.VITE_SENTRY_DSN) || logsThisSession >= 100) return;
  logsThisSession += 1;
  const runtime = getPlatformRuntime();
  void loadSentry().then(({ sendSentryLog }) => sendSentryLog(event, attributes, {
    appVersion: reportToken(runtime.appInfo?.version ?? 'unknown'),
    platform: reportToken(runtime.appInfo?.platform ?? runtime.nativePlatform ?? 'unknown'),
  }, reportsEnabled)).catch(() => { /* Diagnostics never interrupt writing. */ });
}

/** Send queued reports; unsent ones stay queued for the next launch. */
export function flushCrashReports(): Promise<void> {
  if (!reportsEnabled()) return Promise.resolve();
  // `finally` runs after the assignment, even when the queue is already empty.
  flushing ??= drainQueue().finally(() => {
    flushing = null;
  });
  return flushing;
}

export interface CrashReportInput {
  kind: CrashReportKind;
  severity: CrashReportSeverity;
  name: string;
  message: string;
  stack?: string;
  /** Stable code for grouping when there is no useful stack (integrity events). */
  code?: string;
  context?: Record<string, string | number | boolean>;
}

export function reportCrash(input: CrashReportInput): void {
  // Collection consent is independent of connectivity; retain offline failures
  // without loading the SDK until an online flush can actually deliver them.
  if (!reportsPermitted()) return;
  const name = reportToken(input.name, 120);
  const stack = sanitizeStack(input.stack);
  const fingerprint = input.code
    ? reportToken(`${input.kind}:${input.code}`, 128)
    : reportFingerprint(input.kind, name, stack);
  const now = Date.now();
  const repeatKey = configuredSentryDsn(runtimeViteEnv.VITE_SENTRY_DSN)
    ? `${fingerprint}:${stack.split('\n')[0] ?? ''}` : fingerprint;
  const previous = recent.get(repeatKey);
  if ((previous !== undefined && now - previous < REPEAT_WINDOW_MS) || sentThisSession >= MAX_PER_SESSION) return;
  recent.set(repeatKey, now);
  sentThisSession += 1;
  const runtime = getPlatformRuntime();
  const context = Object.fromEntries(
    Object.entries(input.context ?? {})
      .slice(0, 20)
      .map(([key, value]) => [
        reportToken(key),
        typeof value === 'string' ? sanitizeReportText(value, 200) : value,
      ]),
  );
  const report: CrashReportPayload = {
    format: 'drifting.crash-report',
    formatVersion: 1,
    kind: input.kind,
    severity: input.severity,
    fingerprint,
    name,
    message: sanitizeReportText(input.message),
    stack,
    appVersion: reportToken(runtime.appInfo?.version ?? 'unknown'),
    platform: reportToken(runtime.appInfo?.platform ?? runtime.nativePlatform ?? 'unknown', 32),
    installationId: diagnosticsInstallationId(),
    occurredAt: new Date(now).toISOString(),
    context,
  };
  writeQueue([...readQueue(), report]);
  if (input.kind === 'render-failure' || input.kind === 'native-panic') {
    writeFollowUps([...readFollowUps(), {
      kind: input.kind,
      fingerprint,
      occurredAt: report.occurredAt,
      reportId: null,
      delivered: false,
      // A native panic is recorded on the launch after it, so it is ready now.
      launchId: input.kind === 'render-failure' ? launchId : null,
    }]);
  }
  void flushCrashReports();
}

function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: typeof error, message: typeof error === 'string' ? error : 'Non-error value thrown' };
}

/** Report a caught error that should never happen in a healthy app. */
export function reportError(
  kind: CrashReportKind,
  error: unknown,
  severity: CrashReportSeverity = 'error',
  context?: CrashReportInput['context'],
): void {
  reportCrash({ kind, severity, ...describe(error), context });
}

/**
 * A data-integrity problem: a local write that could not be made durable, a
 * migration that needed recovery, a sync generation that cannot proceed.
 */
export function reportIntegrityEvent(
  code: string,
  error?: unknown,
  context?: CrashReportInput['context'],
): void {
  const described = error === undefined ? { name: 'IntegrityEvent', message: code } : describe(error);
  reportCrash({ kind: 'integrity', severity: 'error', code, ...described, context });
}

// Benign browser noise that says nothing about Drifting's health.
const IGNORED_MESSAGES = [/ResizeObserver loop/, /^Script error\.?$/];

/**
 * Send native panics recorded since the last launch. They are taken even when
 * reports are off, so an author's opt-out also clears them from disk.
 */
export async function reportNativeCrashes(): Promise<void> {
  let reports;
  try {
    reports = await platform.diagnostics.takeNativeCrashReports();
  } catch {
    return; // Not running in the native shell.
  }
  for (const report of reports) {
    reportCrash({
      kind: 'native-panic',
      severity: 'fatal',
      name: 'RustPanic',
      message: report.message,
      stack: report.backtrace,
      code: report.location || 'unknown-location',
      context: { thread: report.thread, location: report.location, crashedVersion: report.appVersion },
    });
  }
}

/** Capture uncaught renderer errors for the lifetime of the app. */
export function installCrashReporting(): () => void {
  const onError = (event: ErrorEvent) => {
    if (IGNORED_MESSAGES.some((pattern) => pattern.test(event.message))) return;
    reportCrash({ kind: 'renderer-error', severity: 'error', ...describe(event.error ?? event.message) });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportCrash({ kind: 'unhandled-rejection', severity: 'error', ...describe(event.reason) });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const onOnline = () => { void flushCrashReports(); };
  window.addEventListener('online', onOnline);
  launchSettled = reportNativeCrashes().finally(() => flushCrashReports());
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('online', onOnline);
  };
}

/** Tests reset per-session de-duplication. */
export function resetCrashReporterForTests(): void {
  recent.clear();
  sentThisSession = 0;
  flushing = null;
  logsThisSession = 0;
  sentryModule = undefined;
}

/** Tests start a new launch without reloading the module. */
export function startNewLaunchForTests(): void {
  launchId = uuidv4();
}
