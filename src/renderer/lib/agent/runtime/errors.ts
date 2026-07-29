import type { AgentRuntimeFailureCode } from './types';

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: AgentRuntimeFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export class AgentRuntimeAbortError extends Error {
  constructor(message = 'Agent turn aborted') {
    super(message);
    this.name = 'AgentRuntimeAbortError';
  }
}

/**
 * Provider adapters may expose only a user-safe message through this error.
 * Raw HTTP bodies, headers, URLs, and credentials must remain adapter-local.
 */
export class AgentModelDriverError extends Error {
  constructor(public readonly publicMessage: string) {
    super(publicMessage);
    this.name = 'AgentModelDriverError';
  }
}

export function publicModelDriverErrorMessage(error: unknown): string {
  if (!(error instanceof AgentModelDriverError)) return 'Model driver failed';
  const message = error.publicMessage.trim() || 'Model driver failed';
  return message
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
    .replace(
      /\b(api[-_ ]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 500);
}

export function throwIfAgentAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentRuntimeAbortError(abortReason(signal));
}

export function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'Agent turn aborted';
}

export function isAgentAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof AgentRuntimeAbortError) return true;
  return error instanceof DOMException && error.name === 'AbortError';
}
