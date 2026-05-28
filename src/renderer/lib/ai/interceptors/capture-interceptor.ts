/**
 * CaptureInterceptor — records every AI request/response into the in-memory
 * ring buffer (request-log.ts) and, optionally, persists each entry as a
 * Markdown file under userData/ai-log/ via the main-process IPC bridge.
 *
 * The file write is best-effort: failures get logged to console but never
 * surface to feature code. This interceptor is observer-class (after /
 * onError must not throw).
 *
 * Wiring: instantiated in build-default-client.ts and chained AFTER the
 * LoggingInterceptor so the compact one-liner still goes to console first.
 */
import loglevel from 'loglevel';
import type { RequestInterceptor } from './interceptor';
import type { AICompletionRequest, AICompletionResponse } from '../types';
import {
  getLogEntryById,
  pushLogEntry,
  snapshotRequest,
  snapshotResponse,
  updateLogEntry,
  type AIRequestLogEntry,
} from '../log/request-log';
import { filenameForEntry, formatEntryAsMarkdown } from '../log/markdown-format';

const log = loglevel.getLogger('ai-log');

export interface CaptureInterceptorOptions {
  /**
   * When true, every recorded entry is also written to disk as Markdown
   * via window.electronAPI.aiLog. Default = same as enabled (i.e. file
   * writes are on whenever capture is on).
   */
  writeFiles?: boolean;
}

export class CaptureInterceptor implements RequestInterceptor {
  // Track in-flight entries by a stable key derived from the request object
  // reference. Using a WeakMap means we don't accumulate state across runs
  // and don't keep request objects alive past their natural lifetime.
  private readonly inFlight = new WeakMap<AICompletionRequest, string>();
  private readonly writeFiles: boolean;

  constructor(options: CaptureInterceptorOptions = {}) {
    this.writeFiles = options.writeFiles ?? true;
  }

  before(req: AICompletionRequest): void {
    const id = makeShortId();
    const entry: AIRequestLogEntry = {
      id,
      startedAt: Date.now(),
      status: 'in-flight',
      request: snapshotRequest(req),
    };
    pushLogEntry(entry);
    this.inFlight.set(req, id);
  }

  after(req: AICompletionRequest, res: AICompletionResponse): void {
    const id = this.inFlight.get(req);
    if (!id) return;
    const finishedAt = Date.now();
    const entry = updateAndReturn(id, {
      status: 'success',
      finishedAt,
      response: snapshotResponse(res),
    });
    this.inFlight.delete(req);
    if (entry) void this.maybeWriteFile(entry);
  }

  onError(req: AICompletionRequest, err: unknown): void {
    const id = this.inFlight.get(req);
    if (!id) return;
    const finishedAt = Date.now();
    const entry = updateAndReturn(id, {
      status: 'error',
      finishedAt,
      error: normalizeError(err),
    });
    this.inFlight.delete(req);
    if (entry) void this.maybeWriteFile(entry);
  }

  private async maybeWriteFile(entry: AIRequestLogEntry): Promise<void> {
    if (!this.writeFiles) return;
    const aiLog = (globalThis as { electronAPI?: { aiLog?: { write: (...args: unknown[]) => unknown } } })
      .electronAPI?.aiLog;
    if (!aiLog) return; // not in Electron (test env / SSR)
    try {
      const filename = filenameForEntry(entry);
      const content = formatEntryAsMarkdown(entry);
      const result = (await (aiLog.write as (
        f: string,
        c: string,
      ) => Promise<{ ok: true; filePath: string } | { ok: false; error: string }>)(
        filename,
        content,
      ));
      if (!result.ok) {
        log.warn('[ai-log] file write failed:', result.error);
      }
    } catch (err) {
      log.warn('[ai-log] file write threw:', err);
    }
  }
}

function updateAndReturn(
  id: string,
  patch: Partial<AIRequestLogEntry>,
): AIRequestLogEntry | undefined {
  updateLogEntry(id, patch);
  const entry = getLogEntryById(id);
  if (entry && entry.finishedAt !== undefined && entry.durationMs === undefined) {
    entry.durationMs = entry.finishedAt - entry.startedAt;
  }
  return entry;
}

function normalizeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'Unknown', message: String(err) };
}

function makeShortId(): string {
  // 8 hex chars from crypto.getRandomValues; falls back to Math.random in
  // exotic envs that lack it (none expected, but cheap defense).
  const buf = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
