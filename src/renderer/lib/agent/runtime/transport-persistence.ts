import type {
  AgentCancelPendingControlInput,
  AgentListPendingControlsInput,
  AgentPendingControl,
  AgentStartRoute,
} from '../protocol';
import type {
  AgentContextProviderEnvelopeV2,
} from './context-message-adapter';
import type { AgentContextSourceRow } from './context-planner';
import type {
  AgentModelMessage,
  AgentRuntimeJournalEntry,
  AgentRuntimeOutcome,
} from './types';

/**
 * Narrow durability boundary owned by the local transport.
 *
 * The transport deliberately does not know about Drizzle, SQLite tables, or a
 * provider SDK. A concrete adapter may atomically coordinate several canonical
 * runtime tables, while tests and future sidecar transports can implement the
 * same crash semantics without importing renderer persistence details.
 */
export interface AgentTransportPersistence {
  /**
   * Resolve or create the route-owned session and atomically accept its user
   * prompt before the provider is allowed to start.
   *
   * `candidateSessionId` is used only when no resumable matching session
   * exists. Implementations must reject a resume id owned by another route.
   * Returned history must contain complete provider-neutral messages only:
   * streamed assistant deltas are journal evidence, never model history.
   */
  prepareTurn(
    input: AgentTransportPrepareTurnInput,
    signal?: AbortSignal,
  ): Promise<AgentTransportPreparedTurn>;

  /** Persist the canonical immutable runtime journal in sequence order. */
  appendJournal(
    entry: AgentRuntimeJournalEntry,
    signal?: AbortSignal,
  ): void | Promise<void>;

  /**
   * Atomically commit complete messages produced by this turn and its terminal
   * status. The accepted user prompt is already durable and appears as the
   * first item in `turnMessages`; implementations must verify it rather than
   * insert a duplicate.
   */
  commitTurn(
    input: AgentTransportCommitTurnInput,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Inspect durable wait points left by a renderer process restart. */
  listPendingControls?(
    input: AgentListPendingControlsInput,
    signal?: AbortSignal,
  ): Promise<AgentPendingControl[]>;

  /**
   * Safely settle a recovered wait point as cancelled. It never approves or
   * supplies user input because the original execution stack no longer exists.
   */
  cancelPendingControl?(
    input: AgentCancelPendingControlInput,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface AgentTransportPrepareTurnInput {
  candidateSessionId: string;
  resumeSessionId?: string;
  newConversation: boolean;
  route: AgentStartRoute;
  provider: string;
  model: string | null;
  turnId: string;
  prompt: string;
  acceptedAt: string;
}

export interface AgentTransportPreparedTurn {
  sessionId: string;
  history: AgentModelMessage[];
  /** True when stale in-flight state was repaired before accepting this turn. */
  recovered: boolean;
}

export interface AgentTransportCommitTurnInput {
  sessionId: string;
  turnId: string;
  /**
   * Messages added by this turn, beginning with its already-accepted user
   * prompt. Only complete assistant/tool messages may follow it.
   */
  turnMessages: AgentModelMessage[];
  /**
   * Optional P4 context projection for the completed canonical history.
   *
   * The persistence adapter supplies `canonicalHistory` itself from durable
   * rows plus `turnMessages`; callers cannot substitute a shorter history.
   * The supplied bridge rows and envelope must therefore include this turn's
   * final assistant message or the commit fails closed.
   */
  contextCheckpointV2?: AgentTransportContextCheckpointV2Input;
  outcome: AgentRuntimeOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  endedAt: string;
}

export interface AgentTransportContextCheckpointV2Input {
  canonicalSourceRows: readonly AgentContextSourceRow[];
  providerEnvelope: AgentContextProviderEnvelopeV2;
}
