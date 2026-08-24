import type { GoogleDriveNativeDiagnostics } from '../../platform/contracts';

const STORAGE_KEY = 'drifting.google-drive-operation-traces.v1';
const STORAGE_VERSION = 1;
const MAX_TRACES = 3;
const MAX_EVENTS = 48;
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/u;

export type GoogleDriveTraceLayer =
  | 'renderer-settings'
  | 'renderer-product-command'
  | 'renderer-disconnect'
  | 'tauri-adapter'
  | 'rust-native'
  | 'ios-google-sign-in'
  | 'android-google-authorization';

export type GoogleDriveTraceOutcome = 'started' | 'passed' | 'skipped' | 'failed';

export interface GoogleDriveTraceEvent {
  readonly offsetMs: number;
  readonly layer: GoogleDriveTraceLayer;
  readonly phase: string;
  readonly outcome: GoogleDriveTraceOutcome;
  readonly code?: string;
  readonly native?: GoogleDriveNativeDiagnostics;
}

interface StoredGoogleDriveOperationTrace {
  readonly traceId: string;
  readonly operation: 'disconnect-google-drive';
  readonly startedAt: string;
  readonly status: 'in-flight' | 'succeeded' | 'failed';
  readonly durationMs: number | null;
  readonly events: readonly GoogleDriveTraceEvent[];
}

interface StoredTraceEnvelope {
  readonly version: 1;
  readonly traces: readonly StoredGoogleDriveOperationTrace[];
}

export interface SanitizedGoogleDriveOperationTrace {
  readonly operation: 'disconnect-google-drive';
  readonly startedAt: string;
  readonly status: 'in-flight' | 'succeeded' | 'failed';
  readonly durationMs: number | null;
  readonly events: readonly GoogleDriveTraceEvent[];
}

const inMemoryTraces: StoredGoogleDriveOperationTrace[] = [];

function traceStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function safeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && SAFE_TOKEN.test(value);
}

function safeNativeDiagnostics(value: unknown): value is GoogleDriveNativeDiagnostics {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<GoogleDriveNativeDiagnostics>;
  if (
    input.schemaVersion !== 1 ||
    !safeToken(input.operation) ||
    !safeToken(input.platform) ||
    !safeToken(input.phase) ||
    !safeInteger(input.elapsedMs, 30 * 60 * 1000) ||
    !Array.isArray(input.completedPhases) ||
    input.completedPhases.length > 24 ||
    !input.completedPhases.every(safeToken) ||
    !Array.isArray(input.errorChain) ||
    input.errorChain.length > 4
  ) {
    return false;
  }
  return input.errorChain.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return (
      safeToken(entry.family) &&
      safeToken(entry.domain) &&
      Number.isSafeInteger(entry.code) &&
      entry.code >= -2_147_483_648 &&
      entry.code <= 2_147_483_647 &&
      (entry.reason === null || safeToken(entry.reason)) &&
      (entry.httpStatus === null || safeInteger(entry.httpStatus, 599))
    );
  });
}

const LAYERS = new Set<GoogleDriveTraceLayer>([
  'renderer-settings',
  'renderer-product-command',
  'renderer-disconnect',
  'tauri-adapter',
  'rust-native',
  'ios-google-sign-in',
  'android-google-authorization',
]);
const OUTCOMES = new Set<GoogleDriveTraceOutcome>(['started', 'passed', 'skipped', 'failed']);

function safeEvent(value: unknown): value is GoogleDriveTraceEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<GoogleDriveTraceEvent>;
  return (
    safeInteger(event.offsetMs, 30 * 60 * 1000) &&
    LAYERS.has(event.layer as GoogleDriveTraceLayer) &&
    safeToken(event.phase) &&
    OUTCOMES.has(event.outcome as GoogleDriveTraceOutcome) &&
    (event.code === undefined || safeToken(event.code)) &&
    (event.native === undefined || safeNativeDiagnostics(event.native))
  );
}

function safeTrace(value: unknown): value is StoredGoogleDriveOperationTrace {
  if (!value || typeof value !== 'object') return false;
  const trace = value as Partial<StoredGoogleDriveOperationTrace>;
  return (
    typeof trace.traceId === 'string' &&
    /^[a-f0-9-]{16,64}$/u.test(trace.traceId) &&
    trace.operation === 'disconnect-google-drive' &&
    typeof trace.startedAt === 'string' &&
    Number.isFinite(Date.parse(trace.startedAt)) &&
    (trace.status === 'in-flight' || trace.status === 'succeeded' || trace.status === 'failed') &&
    (trace.durationMs === null || safeInteger(trace.durationMs, 30 * 60 * 1000)) &&
    Array.isArray(trace.events) &&
    trace.events.length <= MAX_EVENTS &&
    trace.events.every(safeEvent)
  );
}

function readStoredTraces(): StoredGoogleDriveOperationTrace[] {
  const storage = traceStorage();
  if (!storage) return [...inMemoryTraces];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [...inMemoryTraces];
    const envelope = JSON.parse(raw) as Partial<StoredTraceEnvelope>;
    if (
      envelope.version !== STORAGE_VERSION ||
      !Array.isArray(envelope.traces) ||
      envelope.traces.length > MAX_TRACES ||
      !envelope.traces.every(safeTrace)
    ) {
      return [...inMemoryTraces];
    }
    return [...envelope.traces];
  } catch {
    return [...inMemoryTraces];
  }
}

function writeStoredTraces(traces: readonly StoredGoogleDriveOperationTrace[]): void {
  const bounded = traces.slice(-MAX_TRACES);
  inMemoryTraces.splice(0, inMemoryTraces.length, ...bounded);
  const storage = traceStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, traces: bounded }));
  } catch {
    // Diagnostics must never block or change a provider transition.
  }
}

function newTraceId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16);
    return `${Date.now().toString(16)}-${random.padStart(16, '0')}`;
  }
}

function elapsedMs(trace: StoredGoogleDriveOperationTrace): number {
  return Math.max(0, Math.min(30 * 60 * 1000, Date.now() - Date.parse(trace.startedAt)));
}

export function beginGoogleDriveDisconnectTrace(): string {
  const traceId = newTraceId();
  const trace: StoredGoogleDriveOperationTrace = {
    traceId,
    operation: 'disconnect-google-drive',
    startedAt: new Date().toISOString(),
    status: 'in-flight',
    durationMs: null,
    events: [],
  };
  writeStoredTraces([...readStoredTraces(), trace]);
  return traceId;
}

export function recordGoogleDriveTraceEvent(
  traceId: string,
  event: Omit<GoogleDriveTraceEvent, 'offsetMs'>,
): void {
  const traces = readStoredTraces();
  const index = traces.findIndex((trace) => trace.traceId === traceId);
  if (index < 0) return;
  const trace = traces[index];
  const candidate: GoogleDriveTraceEvent = {
    offsetMs: elapsedMs(trace),
    ...event,
  };
  if (!safeEvent(candidate)) return;
  traces[index] = {
    ...trace,
    events: [...trace.events, candidate].slice(-MAX_EVENTS),
  };
  writeStoredTraces(traces);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (safeToken(code)) return code;
  }
  return 'unexpected';
}

function nativeDiagnostics(error: unknown): GoogleDriveNativeDiagnostics | undefined {
  if (!error || typeof error !== 'object' || !('diagnostics' in error)) return undefined;
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  return safeNativeDiagnostics(diagnostics) ? diagnostics : undefined;
}

export function finishGoogleDriveDisconnectTrace(
  traceId: string,
  status: 'succeeded' | 'failed',
  error?: unknown,
): void {
  if (status === 'failed') {
    const native = nativeDiagnostics(error);
    recordGoogleDriveTraceEvent(traceId, {
      layer: native?.platform === 'ios' ? 'ios-google-sign-in' : 'rust-native',
      phase: native?.phase ?? 'disconnect-failed',
      outcome: 'failed',
      code: errorCode(error),
      ...(native ? { native } : {}),
    });
  }
  const traces = readStoredTraces();
  const index = traces.findIndex((trace) => trace.traceId === traceId);
  if (index < 0) return;
  const trace = traces[index];
  traces[index] = { ...trace, status, durationMs: elapsedMs(trace) };
  writeStoredTraces(traces);
}

export function recordActiveGoogleDriveNativeDiagnostics(
  diagnostics: GoogleDriveNativeDiagnostics | null | undefined,
): void {
  if (!safeNativeDiagnostics(diagnostics)) return;
  const trace = [...readStoredTraces()]
    .reverse()
    .find((candidate) => candidate.status === 'in-flight');
  if (!trace) return;
  recordGoogleDriveTraceEvent(trace.traceId, {
    layer:
      diagnostics.platform === 'ios'
        ? 'ios-google-sign-in'
        : diagnostics.platform === 'android'
          ? 'android-google-authorization'
          : 'rust-native',
    phase: diagnostics.phase,
    outcome: 'passed',
    native: diagnostics,
  });
}

export function getSanitizedGoogleDriveOperationTraces(): readonly SanitizedGoogleDriveOperationTrace[] {
  return readStoredTraces().map(({ operation, startedAt, status, durationMs, events }) => ({
    operation,
    startedAt,
    status,
    durationMs,
    events,
  }));
}

export function clearGoogleDriveOperationTracesForTests(): void {
  inMemoryTraces.length = 0;
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, traces: [] }),
    );
  } catch {
    // Test-only cleanup also stays best effort.
  }
}
