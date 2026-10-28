import { BrowserClient, Scope, createTransport, defaultStackParser, logger, withScope } from '@sentry/browser';
import type { CrashReportPayload } from './crash-reporter';
import { runtimeViteEnv } from '../../lib/vite-runtime-env';
import { configuredSentryDsn, sanitizeSentryEvent, sanitizeSentryLog } from './sentry-policy';
import type { DiagnosticLogAttributes, DiagnosticLogEvent } from './sentry-policy';

interface Reporter {
  client: BrowserClient;
  scope: Scope;
  deliveries: Map<string, boolean>;
  operations: Array<{ category: string; message: string; timestamp: number; data: DiagnosticLogAttributes }>;
}
let reporter: Reporter | null = null;

function getReporter(allowed: () => boolean): Reporter | null {
  const dsn = configuredSentryDsn(runtimeViteEnv.VITE_SENTRY_DSN);
  if (!dsn || !allowed()) return null;
  if (reporter) return reporter;
  const deliveries = new Map<string, boolean>();
  const client = new BrowserClient({
    dsn, release: runtimeViteEnv.VITE_SENTRY_RELEASE,
    environment: runtimeViteEnv.VITE_SENTRY_ENVIRONMENT ?? 'production',
    // Drifting owns all error listeners. No console, DOM, request, replay or session collection.
    integrations: [], sendClientReports: false, stackParser: defaultStackParser,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
      urlQueryParams: false, graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
    beforeSendMetric: () => null,
    beforeSend: event => allowed() ? sanitizeSentryEvent(event) : null,
    beforeSendLog: log => allowed() ? sanitizeSentryLog(log) : null,
    transport(options) {
      const transport = createTransport(options, async request => {
        if (!allowed()) return { statusCode: 0 };
        const response = await fetch(options.url, {
          method: 'POST', body: request.body as BodyInit, credentials: 'omit',
          referrerPolicy: 'no-referrer', keepalive: false,
          headers: { 'Content-Type': 'application/x-sentry-envelope' },
          signal: AbortSignal.timeout(10000),
        });
        return { statusCode: response.status, headers: {
          'retry-after': response.headers.get('retry-after'),
          'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
        } };
      });
      return { flush: timeout => transport.flush(timeout), send: envelope => transport.send(envelope).then(response => {
        const id = envelope[0].event_id;
        if (typeof id === 'string' && deliveries.has(id)) {
          const status = response.statusCode ?? 0;
          deliveries.set(id, status >= 200 && status < 500);
        }
        return response;
      }) };
    },
  });
  const scope = new Scope();
  scope.setClient(client);
  client.init();
  reporter = { client, scope, deliveries, operations: [] };
  return reporter;
}

export async function sendSentryReport(report: CrashReportPayload, allowed: () => boolean): Promise<boolean> {
  const active = getReporter(allowed);
  if (!active) return false;
  // Retries of one persisted report retain their ID; Sentry can deduplicate an ambiguous acknowledgement.
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    `${report.installationId}:${report.occurredAt}:${report.fingerprint}:${report.stack}`,
  ));
  const id = Array.from(new Uint8Array(hash).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  active.deliveries.set(id, false);
  const nativeVersion = report.kind === 'native-panic' ? report.context.crashedVersion : undefined;
  const reportedVersion = typeof nativeVersion === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(nativeVersion)
    ? nativeVersion : report.appVersion;
  try {
    active.scope.captureEvent({
      event_id: id, timestamp: Date.parse(report.occurredAt) / 1000,
      release: report.kind === 'native-panic' ? `drifting@${reportedVersion}` : undefined,
      level: report.severity, tags: { kind: report.kind, appVersion: reportedVersion, platform: report.platform },
      user: { id: report.installationId }, fingerprint: [report.fingerprint],
      exception: { values: [{ type: report.name, value: report.message,
        stacktrace: { frames: defaultStackParser(report.stack) } }] },
      contexts: report.kind === 'native-panic' ? { native: { backtrace: report.stack } } : undefined,
      breadcrumbs: active.operations.length ? [...active.operations] : undefined,
    });
    return await active.client.flush(5000) && active.deliveries.get(id) === true;
  } finally { active.deliveries.delete(id); }
}

export function sendSentryLog(event: DiagnosticLogEvent, attributes: DiagnosticLogAttributes,
  runtime: { appVersion: string; platform: string }, allowed: () => boolean): void {
  const active = getReporter(allowed);
  if (!active) return;
  active.operations.push({ category: 'drifting.operation', message: event, timestamp: Date.now() / 1000, data: attributes });
  active.operations = active.operations.slice(-20);
  withScope(active.scope, () => {
    const log = event.endsWith('failed') ? logger.warn : logger.info;
    log(event, { ...attributes, ...runtime });
  });
}

export async function flushSentryLogs(): Promise<void> { await reporter?.client.flush(5000); }
export async function resetSentryReporterForTests(): Promise<void> {
  await reporter?.client.close(100);
  reporter = null;
}
