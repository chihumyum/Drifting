/**
 * In-memory ring buffer of recent AI requests + lightweight pub/sub for
 * dev tools. The capture-interceptor pushes entries here on every call;
 * dev-console exposes a small API for browsing/exporting from DevTools.
 *
 * Persistence is the markdown-file writer's job (see file-writer.ts); this
 * module stays in-process so it survives HMR but resets on app reload.
 */
import type { AICompletionRequest, AICompletionResponse } from '../types';

export interface AIRequestLogEntry {
  /** Short uuid-ish id used in filename + console tag. */
  id: string;
  startedAt: number; // ms epoch
  finishedAt?: number;
  durationMs?: number;
  status: 'in-flight' | 'success' | 'error';
  /** Snapshot of the request — provider-agnostic shape. */
  request: {
    model: string;
    feature: string;
    promptId?: string;
    promptVersion?: number;
    system?: string;
    messages: { role: string; content: string }[];
    toolNames: string[];
    metadata?: Record<string, unknown>;
  };
  /** Filled on success. */
  response?: {
    text?: string;
    toolCall?: { name: string; arguments: unknown };
    usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  };
  /** Filled on error. */
  error?: { name: string; message: string; stack?: string };
}

const RING_CAPACITY = 100;

const buffer: AIRequestLogEntry[] = [];
const listeners = new Set<(entry: AIRequestLogEntry) => void>();

export function pushLogEntry(entry: AIRequestLogEntry): void {
  buffer.push(entry);
  if (buffer.length > RING_CAPACITY) buffer.splice(0, buffer.length - RING_CAPACITY);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore — observer must not break callers */
    }
  }
}

export function updateLogEntry(id: string, patch: Partial<AIRequestLogEntry>): void {
  const entry = buffer.find((e) => e.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
}

export function getRecentLogEntries(limit = 20): AIRequestLogEntry[] {
  if (limit <= 0) return [];
  return buffer.slice(-limit).reverse();
}

export function getLogEntryById(id: string): AIRequestLogEntry | undefined {
  return buffer.find((e) => e.id === id);
}

export function clearLogBuffer(): void {
  buffer.length = 0;
}

export function subscribeToLog(fn: (entry: AIRequestLogEntry) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Snapshot a request into the entry shape. */
export function snapshotRequest(req: AICompletionRequest): AIRequestLogEntry['request'] {
  return {
    model: req.model,
    feature: (req.metadata?.feature as string | undefined) ?? 'unknown',
    promptId: req.metadata?.promptId as string | undefined,
    promptVersion: req.metadata?.promptVersion as number | undefined,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    toolNames: req.tools?.map((t) => t.name) ?? [],
    metadata: req.metadata,
  };
}

export function snapshotResponse(res: AICompletionResponse): AIRequestLogEntry['response'] {
  return {
    text: res.text,
    toolCall: res.toolCall ? { name: res.toolCall.name, arguments: res.toolCall.arguments } : undefined,
    usage: {
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cachedTokens: res.usage.cachedTokens,
    },
  };
}
