import { FRONTEND_DEBUG_LIMITS, type TelemetryEvent } from './types';

const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|api[-_]?key|token|byok/i;
const PROSE_KEY = /contentJson|prose|manuscript|documentHtml|rawHtml/i;

function redactString(value: string, key: string): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, 'sk-[REDACTED]');
  if (/url|uri|name|documentURL/i.test(key)) {
    try {
      const url = new URL(redacted);
      for (const parameter of [...url.searchParams.keys()]) {
        if (SENSITIVE_KEY.test(parameter)) url.searchParams.set(parameter, '[REDACTED]');
      }
      url.hash = '';
      redacted = url.toString();
    } catch {
      // Non-URL names still receive the generic credential masks above.
    }
  }
  return truncateText(redacted).value;
}

export function truncateText(
  value: string,
  limit: number = FRONTEND_DEBUG_LIMITS.textChars,
): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= limit) return { value, truncated: false };
  return { value: `${value.slice(0, limit)}…`, truncated: true };
}

export function redactDebugValue(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (PROSE_KEY.test(key)) return '[OMITTED_PROSE]';
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactString(value, key);
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => redactDebugValue(item, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactDebugValue(child, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

export class BoundedTelemetryBuffer {
  private events: TelemetryEvent[] = [];
  private bytes = 0;
  private nextId = 1;
  private didTruncate = false;

  push(input: Omit<TelemetryEvent, 'id'>): TelemetryEvent {
    const event = {
      ...input,
      id: this.nextId++,
      value: redactDebugValue(input.value),
    } satisfies TelemetryEvent;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push(event);
    this.bytes += bytes;
    while (
      this.events.length > FRONTEND_DEBUG_LIMITS.events ||
      this.bytes > FRONTEND_DEBUG_LIMITS.channelBytes
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= Buffer.byteLength(JSON.stringify(removed));
      this.didTruncate = true;
    }
    return event;
  }

  list(afterId = 0): { events: TelemetryEvent[]; truncated: boolean } {
    return {
      events: this.events.filter((event) => event.id > afterId),
      truncated: this.didTruncate,
    };
  }
}
