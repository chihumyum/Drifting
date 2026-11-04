import type {
  AgentAbortInput,
  AgentCancelPendingControlInput,
  AgentListPendingControlsInput,
  AgentPendingControl,
  AgentPermissionResolutionInput,
  AgentResetSessionInput,
  AgentStartInput,
  AgentSteeringInput,
  AgentStopAfterToolInput,
  AgentUserInputResponseInput,
  GeneralAgentAuthStatus,
} from './protocol';
import type { AgentRuntimeJournalEntry } from './runtime/types';

/**
 * Placeholder until the project runtime installs a transport. The product
 * installs the local in-process runtime on mount; `sidecar` and `remote` are
 * reserved seams with no implementation today.
 */
export const GENERAL_AGENT_UNSUPPORTED = {
  code: 'GENERAL_AGENT_UNSUPPORTED',
  message: 'General Agent is unavailable until the project runtime installs its transport.',
} as const;

export type GeneralAgentTransportKind = 'unsupported' | 'local' | 'sidecar' | 'remote';

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
  resolvePermission(input: AgentPermissionResolutionInput): Promise<GeneralAgentResult>;
  submitUserInput(input: AgentUserInputResponseInput): Promise<GeneralAgentResult>;
  steer(input: AgentSteeringInput): Promise<GeneralAgentResult>;
  stopAfterTool(input: AgentStopAfterToolInput): Promise<GeneralAgentResult>;
  listPendingControls(
    input: AgentListPendingControlsInput,
  ): Promise<GeneralAgentResult<AgentPendingControl[]>>;
  cancelPendingControl(
    input: AgentCancelPendingControlInput,
  ): Promise<GeneralAgentResult>;
  abort(input?: AgentAbortInput): Promise<GeneralAgentResult>;
  resetSession(input?: AgentResetSessionInput): Promise<GeneralAgentResult>;
  /**
   * Canonical, lossless runtime stream. Product UI should consume this journal
   * instead of the legacy renderer projection below.
   */
  subscribeJournal(
    callback: (entry: AgentRuntimeJournalEntry) => void,
  ): GeneralAgentResult<() => void>;
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
  resolvePermission: async () => unsupportedResult(),
  submitUserInput: async () => unsupportedResult(),
  steer: async () => unsupportedResult(),
  stopAfterTool: async () => unsupportedResult(),
  listPendingControls: async () => unsupportedResult(),
  cancelPendingControl: async () => unsupportedResult(),
  abort: async () => unsupportedResult(),
  resetSession: async () => unsupportedResult(),
  subscribeJournal: () => unsupportedResult(),
};

let activeTransport: GeneralAgentTransport = unsupportedGeneralAgentTransport;

interface JournalRelaySubscription {
  callback: (entry: AgentRuntimeJournalEntry) => void;
  cleanup: (() => void) | null;
}

const journalRelaySubscriptions = new Set<JournalRelaySubscription>();

function bindJournalRelay(subscription: JournalRelaySubscription): boolean {
  subscription.cleanup?.();
  subscription.cleanup = null;
  const result = activeTransport.subscribeJournal(subscription.callback);
  if (!result.ok) return false;
  subscription.cleanup = result.value;
  return true;
}

function rebindRelaySubscriptions(): void {
  for (const subscription of journalRelaySubscriptions) {
    bindJournalRelay(subscription);
  }
}

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
  resolvePermission: (input) => activeTransport.resolvePermission(input),
  submitUserInput: (input) => activeTransport.submitUserInput(input),
  steer: (input) => activeTransport.steer(input),
  stopAfterTool: (input) => activeTransport.stopAfterTool(input),
  listPendingControls: (input) => activeTransport.listPendingControls(input),
  cancelPendingControl: (input) => activeTransport.cancelPendingControl(input),
  abort: (input) => activeTransport.abort(input),
  resetSession: (input) => activeTransport.resetSession(input),
  subscribeJournal: (callback) => {
    const subscription: JournalRelaySubscription = { callback, cleanup: null };
    if (!bindJournalRelay(subscription)) return unsupportedResult();
    journalRelaySubscriptions.add(subscription);
    return {
      ok: true,
      value: () => {
        if (!journalRelaySubscriptions.delete(subscription)) return;
        subscription.cleanup?.();
        subscription.cleanup = null;
      },
    };
  },
};

/**
 * Installs a local/sidecar/remote implementation. The cleanup function only
 * restores the previous transport when the installed instance is still active.
 */
export function installGeneralAgentTransport(transport: GeneralAgentTransport): () => void {
  const previous = activeTransport;
  activeTransport = transport;
  rebindRelaySubscriptions();
  return () => {
    if (activeTransport !== transport) return;
    activeTransport = previous;
    rebindRelaySubscriptions();
  };
}
