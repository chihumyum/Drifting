/**
 * Non-blocking confirmation for the agent's destructive tools (delete element /
 * comment / patch / relation).
 *
 * Replaces `window.confirm`, which (a) froze the whole renderer event loop and
 * (b) raced the transport request timeout — if the user sat on the prompt, the
 * caller timed out and told the agent the tool FAILED, yet the delete still ran
 * (delete succeeds while the agent believes it failed).
 *
 * This renders an in-app dialog instead and AUTO-DECLINES after a timeout well
 * under the transport deadline, so the tool returns a clean confirmed/declined
 * result before its caller gives up — and the destructive action only runs on an
 * explicit "allow".
 *
 * Requests are a FIFO, not a replaceable global slot. Every prompt carries a
 * stable provenance id and observes cancellation, so concurrent Agent turns
 * cannot strand an older promise or approve the wrong write.
 */
import { create } from 'zustand';

export interface PendingAgentConfirm {
  requestId: string;
  message: string;
  projectId: string | null;
  sessionId: string | null;
  turnId: string | null;
  callId: string | null;
  /** Resolve the request — wired to the in-flight promise + timeout cleanup. */
  respond: (ok: boolean) => void;
}

interface AgentConfirmState {
  pending: PendingAgentConfirm | null;
}

export const useAgentConfirmStore = create<AgentConfirmState>(() => ({ pending: null }));

export interface AgentConfirmRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId?: string;
  projectId?: string;
  sessionId?: string;
  turnId?: string;
  callId?: string;
}

interface QueuedAgentConfirm extends PendingAgentConfirm {
  timeoutMs: number;
  signal?: AbortSignal;
  resolve: (ok: boolean) => void;
  settled: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  onAbort: () => void;
}

const confirmQueue: QueuedAgentConfirm[] = [];
let activeConfirm: QueuedAgentConfirm | null = null;
let fallbackRequestSequence = 0;

/**
 * Ask the user to confirm a destructive agent action. Resolves true (allow),
 * false (cancel), or false on timeout. Non-blocking — shows AgentConfirmDialog.
 * Default 20s keeps it under the 30s bridge timeout.
 */
export function requestAgentConfirm(
  message: string,
  timeoutOrOptions: number | AgentConfirmRequestOptions = 20000,
): Promise<boolean> {
  const options =
    typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions;
  const timeoutMs = options.timeoutMs ?? 20000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const requestId =
      options.requestId ??
      `agent-confirm:${Date.now()}:${fallbackRequestSequence++}`;
    const queued: QueuedAgentConfirm = {
      requestId,
      message,
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
    queued.respond = (ok: boolean): void => settleConfirm(queued, ok);
    queued.onAbort = (): void => settleConfirm(queued, false);
    if (queued.signal?.aborted) {
      queued.settled = true;
      resolve(false);
      return;
    }
    queued.signal?.addEventListener('abort', queued.onAbort, { once: true });
    confirmQueue.push(queued);
    showNextConfirm();
  });
}

function showNextConfirm(): void {
  if (activeConfirm) return;
  while (confirmQueue.length > 0) {
    const next = confirmQueue.shift();
    if (!next || next.settled) continue;
    if (next.signal?.aborted) {
      settleConfirm(next, false);
      continue;
    }
    activeConfirm = next;
    next.timer = globalThis.setTimeout(
      () => settleConfirm(next, false),
      next.timeoutMs,
    );
    useAgentConfirmStore.setState({
      pending: {
        requestId: next.requestId,
        message: next.message,
        projectId: next.projectId,
        sessionId: next.sessionId,
        turnId: next.turnId,
        callId: next.callId,
        respond: next.respond,
      },
    });
    return;
  }
  useAgentConfirmStore.setState({ pending: null });
}

function settleConfirm(request: QueuedAgentConfirm, allowed: boolean): void {
  if (request.settled) return;
  request.settled = true;
  if (request.timer !== null) {
    globalThis.clearTimeout(request.timer);
    request.timer = null;
  }
  request.signal?.removeEventListener('abort', request.onAbort);

  if (activeConfirm === request) {
    activeConfirm = null;
    useAgentConfirmStore.setState({ pending: null });
  } else {
    const queuedIndex = confirmQueue.indexOf(request);
    if (queuedIndex >= 0) confirmQueue.splice(queuedIndex, 1);
  }
  request.resolve(allowed);
  showNextConfirm();
}
