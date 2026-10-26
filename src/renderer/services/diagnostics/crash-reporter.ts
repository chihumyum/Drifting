import { v4 as uuidv4 } from 'uuid';
import { APP_CONFIG, canUseHostedService } from '../../lib/config';
import { getSessionToken } from '../../lib/session-token';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { useSettingsStore } from '../../store/settings-store';
import { reportFingerprint, reportToken, sanitizeReportText, sanitizeStack } from './crash-sanitize';

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

interface CrashReportPayload {
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
const MAX_QUEUED = 20;
const MAX_PER_SESSION = 30;
const REPEAT_WINDOW_MS = 60 * 60 * 1000;

const recent = new Map<string, number>();
let sentThisSession = 0;
let flushing: Promise<void> | null = null;

function reportsEnabled(): boolean {
  if (import.meta.env.DEV && import.meta.env.VITE_DRIFTING_CRASH_REPORTS_IN_DEV !== '1') return false;
  return canUseHostedService() && useSettingsStore.getState().sendCrashLogs;
}

function installationId(): string {
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

async function send(report: CrashReportPayload): Promise<boolean> {
  const token = getSessionToken();
  try {
    const response = await fetch(
      `${APP_CONFIG.API_BASE_URL.replace(/\/$/, '')}/api/diagnostics/v1/reports`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(report),
        keepalive: true,
      },
    );
    // A rejected report (invalid, rate limited) is dropped rather than retried.
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

/** Send queued reports; unsent ones stay queued for the next launch. */
export function flushCrashReports(): Promise<void> {
  if (!reportsEnabled()) return Promise.resolve();
  flushing ??= (async () => {
    try {
      let queue = readQueue();
      while (queue.length > 0) {
        if (!(await send(queue[0]!))) break;
        queue = queue.slice(1);
        writeQueue(queue);
      }
    } finally {
      flushing = null;
    }
  })();
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
  if (!reportsEnabled()) return;
  const name = reportToken(input.name, 120);
  const stack = sanitizeStack(input.stack);
  const fingerprint = input.code
    ? reportToken(`${input.kind}:${input.code}`, 128)
    : reportFingerprint(input.kind, name, stack);
  const now = Date.now();
  const previous = recent.get(fingerprint);
  if ((previous !== undefined && now - previous < REPEAT_WINDOW_MS) || sentThisSession >= MAX_PER_SESSION) return;
  recent.set(fingerprint, now);
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
    installationId: installationId(),
    occurredAt: new Date(now).toISOString(),
    context,
  };
  writeQueue([...readQueue(), report]);
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
  void reportNativeCrashes().finally(() => flushCrashReports());
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Tests reset per-session de-duplication. */
export function resetCrashReporterForTests(): void {
  recent.clear();
  sentThisSession = 0;
  flushing = null;
}
