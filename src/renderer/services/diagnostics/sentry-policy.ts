import type { ErrorEvent, Log, StackFrame } from '@sentry/browser';
import { reportToken, sanitizeReportText } from './crash-sanitize';

export const DIAGNOSTIC_LOG_EVENTS = [
  'update-check-completed', 'update-check-failed', 'update-download-completed',
  'update-download-failed', 'update-install-started', 'sync-cycle-failed',
] as const;
export type DiagnosticLogEvent = typeof DIAGNOSTIC_LOG_EVENTS[number];
export interface DiagnosticLogAttributes { durationMs?: number; bytes?: number }

function safeMessage(value: string, max = 300): string {
  return sanitizeReportText(value, max)
    .replace(/(?:~\/|[A-Za-z]:[\\/]|\/(?:Users|home|Volumes|private|tmp|var|etc|opt)\/)[^\s)"']+/g, '[path]')
    .replace(/https?:\/\/[^\s)]+/g, '[url]')
    .replace(/(["'`“‘「『])[^"'`”’」』\n]*(["'`”’」』])/gu, '$1[text]$2')
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, '[text]');
}

export function configuredSentryDsn(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && /^[a-f0-9]{32}$/i.test(url.username) && !url.password
      && /^\/(?:[a-zA-Z0-9_-]+\/)*\d+$/.test(url.pathname) && !url.search && !url.hash
      ? url.href : null;
  } catch { return null; }
}

/** Only bundled JS locations survive; no file:// paths, query strings or URLs to user content. */
function safeCodeFile(value: string | undefined): string | undefined {
  if (!value || value.includes('?') || value.includes('#')) return undefined;
  return /^(?:(?:https?|tauri):\/\/[a-zA-Z0-9.:[\]-]+|app:\/\/)?\/assets\/[a-zA-Z0-9._-]+\.(?:m?js)$/.test(value)
    ? value : undefined;
}

function safeFrame(frame: StackFrame): StackFrame | null {
  const filename = safeCodeFile(frame.filename);
  if (!filename) return null;
  return { filename, function: frame.function ? reportToken(frame.function, 160) : undefined,
    lineno: frame.lineno, colno: frame.colno, in_app: true };
}

/** Rebuild the outbound event, so SDK scope/request/breadcrumb data cannot leak into reports. */
export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  const kind = reportToken(String(event.tags?.kind ?? 'renderer-error'));
  const tags = Object.fromEntries(['kind', 'appVersion', 'platform'].flatMap(key =>
    event.tags?.[key] === undefined ? [] : [[key, reportToken(String(event.tags[key]), 120)]]));
  const images = event.debug_meta?.images?.flatMap(image => {
    const filename = safeCodeFile(image.code_file);
    return image.type === 'sourcemap' && filename && /^[a-f0-9-]{36}$/i.test(image.debug_id)
      ? [{ type: 'sourcemap' as const, code_file: filename, debug_id: image.debug_id }] : [];
  });
  return {
    type: undefined,
    event_id: event.event_id, timestamp: event.timestamp, platform: 'javascript',
    release: event.release, environment: event.environment, level: event.level, tags,
    user: typeof event.user?.id === 'string' && /^diag-[a-f0-9-]{36}$/.test(event.user.id)
      ? { id: event.user.id } : undefined,
    exception: { values: event.exception?.values?.slice(0, 1).map(exception => ({
      type: reportToken(exception.type ?? 'Error', 120), value: safeMessage(exception.value ?? ''),
      mechanism: { type: `drifting.${kind}`, handled: kind !== 'renderer-error' && kind !== 'unhandled-rejection' },
      stacktrace: { frames: exception.stacktrace?.frames?.slice(-40).flatMap(frame => {
        const safe = safeFrame(frame); return safe ? [safe] : [];
      }) },
    })) },
    // JS errors use Sentry's source-mapped grouping. Stable domain codes remain explicit.
    fingerprint: kind === 'integrity' || kind === 'native-panic'
      ? event.fingerprint?.slice(0, 1).map(value => reportToken(value, 128)) : undefined,
    contexts: kind === 'native-panic' && typeof event.contexts?.native?.backtrace === 'string'
      ? { native: { backtrace: safeMessage(event.contexts.native.backtrace, 12000) } } : undefined,
    breadcrumbs: event.breadcrumbs?.filter(crumb => crumb.category === 'drifting.operation'
      && (DIAGNOSTIC_LOG_EVENTS as readonly string[]).includes(crumb.message ?? '')).slice(-20).map(crumb => ({
      category: 'drifting.operation', message: crumb.message, timestamp: crumb.timestamp,
      data: Object.fromEntries(Object.entries(crumb.data ?? {}).filter(([key, value]) =>
        ['durationMs', 'bytes'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0)),
    })),
    debug_meta: images?.length ? { images } : undefined,
  };
}

export function sanitizeSentryLog(log: Log): Log | null {
  if (!(DIAGNOSTIC_LOG_EVENTS as readonly string[]).includes(log.message)) return null;
  const attributes = Object.fromEntries(Object.entries(log.attributes ?? {}).filter(([key, value]) => {
    if (['durationMs', 'bytes'].includes(key)) return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (typeof value !== 'string') return false;
    if (['appVersion', 'platform'].includes(key)) return /^[a-zA-Z0-9._+-]{1,80}$/.test(value);
    if (key === 'sentry.release') return /^[a-zA-Z0-9@+._-]{1,160}$/.test(value);
    if (key === 'sentry.environment') return /^[a-zA-Z0-9._-]{1,40}$/.test(value);
    return false;
  }));
  return { ...log, attributes };
}
