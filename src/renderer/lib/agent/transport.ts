import type { AgentEventEnvelope, AgentStartInput, GeneralAgentAuthStatus } from './protocol';

export const GENERAL_AGENT_UNSUPPORTED = {
  code: 'GENERAL_AGENT_UNSUPPORTED',
  message:
    'General Agent is not supported in the Tauri client because the current Anthropic runtime requires the desktop Node/Claude CLI SDK.',
  future:
    'A future desktop sidecar or authenticated remote-agent service can implement the transport without changing the renderer chat or tool runtime.',
} as const;

export type GeneralAgentTransportKind = 'unsupported' | 'sidecar' | 'remote';

export interface GeneralAgentCapability {
  available: boolean;
  kind: GeneralAgentTransportKind;
  reason?: string;
}

export type GeneralAgentResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: typeof GENERAL_AGENT_UNSUPPORTED.code | string; error: string };

export interface GeneralAgentTransport {
  readonly capability: GeneralAgentCapability;
  authPrepare(): Promise<GeneralAgentResult<{ url: string }>>;
  authSubmitCode(code: string): Promise<GeneralAgentResult>;
  authStatus(): Promise<GeneralAgentResult<GeneralAgentAuthStatus>>;
  authLogout(): Promise<GeneralAgentResult>;
  start(input: AgentStartInput): Promise<GeneralAgentResult>;
  abort(): Promise<GeneralAgentResult>;
  resetSession(): Promise<GeneralAgentResult>;
  subscribeEvents(callback: (event: AgentEventEnvelope) => void): GeneralAgentResult<() => void>;
}

function unsupportedResult<T = void>(): GeneralAgentResult<T> {
  return {
    ok: false,
    code: GENERAL_AGENT_UNSUPPORTED.code,
    error: GENERAL_AGENT_UNSUPPORTED.message,
  };
}

export const unsupportedGeneralAgentTransport: GeneralAgentTransport = {
  capability: {
    available: false,
    kind: 'unsupported',
    reason: GENERAL_AGENT_UNSUPPORTED.message,
  },
  authPrepare: async () => unsupportedResult(),
  authSubmitCode: async () => unsupportedResult(),
  authStatus: async () => unsupportedResult(),
  authLogout: async () => unsupportedResult(),
  start: async () => unsupportedResult(),
  abort: async () => unsupportedResult(),
  resetSession: async () => unsupportedResult(),
  subscribeEvents: () => unsupportedResult(),
};

let activeTransport: GeneralAgentTransport = unsupportedGeneralAgentTransport;

/** Stable delegating facade used by stores/components. */
export const generalAgentTransport: GeneralAgentTransport = {
  get capability() {
    return activeTransport.capability;
  },
  authPrepare: () => activeTransport.authPrepare(),
  authSubmitCode: (code) => activeTransport.authSubmitCode(code),
  authStatus: () => activeTransport.authStatus(),
  authLogout: () => activeTransport.authLogout(),
  start: (input) => activeTransport.start(input),
  abort: () => activeTransport.abort(),
  resetSession: () => activeTransport.resetSession(),
  subscribeEvents: (callback) => activeTransport.subscribeEvents(callback),
};

/**
 * Installs a future sidecar/remote implementation. The cleanup function only
 * restores the previous transport when the installed instance is still active.
 */
export function installGeneralAgentTransport(transport: GeneralAgentTransport): () => void {
  const previous = activeTransport;
  activeTransport = transport;
  return () => {
    if (activeTransport === transport) activeTransport = previous;
  };
}
