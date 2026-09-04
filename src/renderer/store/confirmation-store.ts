/**
 * Application-wide, non-blocking confirmation queue.
 *
 * Product UI requests wait for an explicit response. Agent requests layer a
 * bounded timeout and call provenance on top so a transport timeout can never
 * race a destructive write. A single FIFO prevents concurrent callers from
 * replacing or accidentally approving one another.
 */
import { create } from 'zustand';

export type ConfirmationSource = 'app' | 'agent';

export interface PendingConfirmation {
  requestId: string;
  source: ConfirmationSource;
  message: string;
  title: string | null;
  confirmLabel: string | null;
  cancelLabel: string | null;
  destructive: boolean;
  projectId: string | null;
  sessionId: string | null;
  turnId: string | null;
  callId: string | null;
  /** Resolve the request — wired to the in-flight promise + timeout cleanup. */
  respond: (ok: boolean) => void;
}

interface ConfirmationState {
  pending: PendingConfirmation | null;
}

export const useConfirmationStore = create<ConfirmationState>(() => ({ pending: null }));

export interface ConfirmationRequestOptions {
  /** Null means wait for an explicit response. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  requestId?: string;
  source?: ConfirmationSource;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  projectId?: string;
  sessionId?: string;
  turnId?: string;
  callId?: string;
}

interface QueuedConfirmation extends PendingConfirmation {
  timeoutMs: number | null;
  signal?: AbortSignal;
  resolve: (ok: boolean) => void;
  settled: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  onAbort: () => void;
}

const confirmationQueue: QueuedConfirmation[] = [];
let activeConfirmation: QueuedConfirmation | null = null;
let fallbackRequestSequence = 0;

export function requestConfirmation(
  message: string,
  options: ConfirmationRequestOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const source = options.source ?? 'app';
    const requestId =
      options.requestId ??
      `${source}-confirm:${Date.now()}:${fallbackRequestSequence++}`;
    const queued: QueuedConfirmation = {
      requestId,
      source,
      message,
      title: options.title ?? null,
      confirmLabel: options.confirmLabel ?? null,
      cancelLabel: options.cancelLabel ?? null,
      destructive: options.destructive ?? true,
      projectId: options.projectId ?? null,
      sessionId: options.sessionId ?? null,
      turnId: options.turnId ?? null,
      callId: options.callId ?? null,
      respond: () => undefined,
      timeoutMs,
      signal: options.signal,
      resolve,
      settled: false,
      timer: null,
      onAbort: () => undefined,
    };
    queued.respond = (ok: boolean): void => settleConfirmation(queued, ok);
    queued.onAbort = (): void => settleConfirmation(queued, false);
    if (queued.signal?.aborted) {
      queued.settled = true;
      resolve(false);
      return;
    }
    queued.signal?.addEventListener('abort', queued.onAbort, { once: true });
    confirmationQueue.push(queued);
    showNextConfirmation();
  });
}

export type AgentConfirmRequestOptions = Omit<
  ConfirmationRequestOptions,
  'source' | 'timeoutMs'
> & {
  timeoutMs?: number;
};

/**
 * Agent-only compatibility wrapper. Defaults to 20 seconds so the destructive
 * tool returns a clean declined result before its transport caller times out.
 */
export function requestAgentConfirm(
  message: string,
  timeoutOrOptions: number | AgentConfirmRequestOptions = 20000,
): Promise<boolean> {
  const options =
    typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions;
  return requestConfirmation(message, {
    ...options,
    source: 'agent',
    timeoutMs: options.timeoutMs ?? 20000,
  });
}

function showNextConfirmation(): void {
  if (activeConfirmation) return;
  while (confirmationQueue.length > 0) {
    const next = confirmationQueue.shift();
    if (!next || next.settled) continue;
    if (next.signal?.aborted) {
      settleConfirmation(next, false);
      continue;
    }
    activeConfirmation = next;
    if (next.timeoutMs !== null) {
      next.timer = globalThis.setTimeout(
        () => settleConfirmation(next, false),
        next.timeoutMs,
      );
    }
    useConfirmationStore.setState({
      pending: {
        requestId: next.requestId,
        source: next.source,
        message: next.message,
        title: next.title,
        confirmLabel: next.confirmLabel,
        cancelLabel: next.cancelLabel,
        destructive: next.destructive,
        projectId: next.projectId,
        sessionId: next.sessionId,
        turnId: next.turnId,
        callId: next.callId,
        respond: next.respond,
      },
    });
    return;
  }
  useConfirmationStore.setState({ pending: null });
}

function settleConfirmation(request: QueuedConfirmation, allowed: boolean): void {
  if (request.settled) return;
  request.settled = true;
  if (request.timer !== null) {
    globalThis.clearTimeout(request.timer);
    request.timer = null;
  }
  request.signal?.removeEventListener('abort', request.onAbort);

  if (activeConfirmation === request) {
    activeConfirmation = null;
    useConfirmationStore.setState({ pending: null });
  } else {
    const queuedIndex = confirmationQueue.indexOf(request);
    if (queuedIndex >= 0) confirmationQueue.splice(queuedIndex, 1);
  }
  request.resolve(allowed);
  showNextConfirmation();
}
