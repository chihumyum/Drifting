import { executeRendererDebugCommand } from './executor';
import { installFrontendDebugRegistry } from './registry';
import type { RendererDebugRequest, RendererDebugResult } from './types';

const RETRY_DELAY_MS = 750;
const TELEMETRY_BATCH_MS = 50;
const MAX_TRANSPORT_STRING = 8_192;

interface RendererTelemetry {
  at: string;
  channel: 'console' | 'network';
  level?: string;
  value: unknown;
  truncated?: boolean;
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('VITE_DRIFTING_FRONTEND_DEBUG_URL must be a loopback HTTP URL');
  }
  return url;
}

function transportValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (typeof value === 'string') {
    return value.length > MAX_TRANSPORT_STRING ? `${value.slice(0, MAX_TRANSPORT_STRING)}…` : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Element) {
    return {
      tag: value.tagName.toLowerCase(),
      id: value.id || null,
      debugId: value.getAttribute('data-debug-id'),
      ariaLabel: value.getAttribute('aria-label'),
    };
  }
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => transportValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      try {
        output[key] = transportValue(child, depth + 1);
      } catch {
        output[key] = '[UNSERIALIZABLE]';
      }
    }
    return output;
  }
  return value;
}

class TelemetryBatcher {
  private queued: RendererTelemetry[] = [];
  private timer: number | null = null;

  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}

  push(event: RendererTelemetry): void {
    this.queued.push({ ...event, value: transportValue(event.value) });
    if (this.queued.length >= 32) void this.flush();
    else if (!this.timer)
      this.timer = window.setTimeout(() => void this.flush(), TELEMETRY_BATCH_MS);
  }

  async flush(): Promise<void> {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.queued.length === 0) return;
    const events = this.queued.splice(0, this.queued.length);
    await fetch(new URL('/renderer/telemetry', this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ events }),
    }).catch(() => undefined);
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }
}

function installConsoleCapture(batcher: TelemetryBatcher): () => void {
  const levels = ['debug', 'info', 'log', 'warn', 'error'] as const;
  const originals = new Map<(typeof levels)[number], (...args: unknown[]) => void>();
  for (const level of levels) {
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originals.set(level, original);
    console[level] = (...args: unknown[]) => {
      batcher.push({ at: new Date().toISOString(), channel: 'console', level, value: args });
      original(...args);
    };
  }
  const onError = (event: ErrorEvent) => {
    batcher.push({
      at: new Date().toISOString(),
      channel: 'console',
      level: 'error',
      value: {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        error: event.error,
      },
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    batcher.push({
      at: new Date().toISOString(),
      channel: 'console',
      level: 'error',
      value: { unhandledRejection: event.reason },
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    for (const [level, original] of originals) console[level] = original;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

export function shouldCaptureFrontendDebugResource(name: string, baseUrl: URL): boolean {
  try {
    const resource = new URL(name);
    return !(
      resource.origin === baseUrl.origin &&
      (resource.pathname.startsWith('/renderer/') || resource.pathname === '/stream')
    );
  } catch {
    return true;
  }
}

function installResourceCapture(batcher: TelemetryBatcher, baseUrl: URL): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => undefined;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== 'resource') continue;
      const resource = entry as PerformanceResourceTiming;
      if (!shouldCaptureFrontendDebugResource(resource.name, baseUrl)) continue;
      batcher.push({
        at: new Date().toISOString(),
        channel: 'network',
        value: {
          name: resource.name,
          initiatorType: resource.initiatorType,
          startTime: resource.startTime,
          duration: resource.duration,
          transferSize: resource.transferSize,
          encodedBodySize: resource.encodedBodySize,
          decodedBodySize: resource.decodedBodySize,
          responseStatus: resource.responseStatus,
        },
      });
    }
  });
  observer.observe({ type: 'resource', buffered: true });
  return () => observer.disconnect();
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function postResult(baseUrl: URL, token: string, result: RendererDebugResult): Promise<void> {
  const response = await fetch(new URL('/renderer/result', baseUrl), {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(result),
  });
  if (!response.ok)
    throw new Error(`Frontend debug daemon rejected result with HTTP ${response.status}`);
}

async function poll(baseUrl: URL, token: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(new URL('/renderer/next', baseUrl), {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({
          url: location.href,
          userAgent: navigator.userAgent,
          capturedAt: new Date().toISOString(),
        }),
        signal,
        cache: 'no-store',
      });
      if (response.status === 204) continue;
      if (!response.ok) throw new Error(`Frontend debug daemon returned HTTP ${response.status}`);
      const request = (await response.json()) as RendererDebugRequest;
      let result: RendererDebugResult;
      try {
        result = { id: request.id, ok: true, result: await executeRendererDebugCommand(request) };
      } catch (error) {
        result = {
          id: request.id,
          ok: false,
          error: {
            code: 'RENDERER_COMMAND_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      await postResult(baseUrl, token, result);
    } catch (error) {
      if (signal.aborted) return;
      console.warn('[frontend-debug] renderer bridge poll failed:', error);
      await new Promise<void>((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

export function installFrontendDebugBridge(): () => void {
  if (!import.meta.env.DEV || import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG !== '1') {
    return () => undefined;
  }
  installFrontendDebugRegistry();
  if (import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG_TRANSPORT === 'android-cdp') {
    return () => {
      delete window.__DRIFTING_FRONTEND_DEBUG_V1__;
    };
  }
  const token = import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG_TOKEN?.trim();
  if (!token) throw new Error('VITE_DRIFTING_FRONTEND_DEBUG_TOKEN is required');
  const baseUrl = loopbackUrl(
    import.meta.env.VITE_DRIFTING_FRONTEND_DEBUG_URL?.trim() || 'http://127.0.0.1:4318',
  );
  const controller = new AbortController();
  const batcher = new TelemetryBatcher(baseUrl, token);
  const removeConsoleCapture = installConsoleCapture(batcher);
  const removeResourceCapture = installResourceCapture(batcher, baseUrl);
  void poll(baseUrl, token, controller.signal);
  return () => {
    controller.abort('Frontend debug bridge stopped');
    removeConsoleCapture();
    removeResourceCapture();
    void batcher.flush();
    delete window.__DRIFTING_FRONTEND_DEBUG_V1__;
  };
}
