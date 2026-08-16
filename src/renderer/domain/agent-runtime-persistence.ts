/**
 * Canonical persistence model for the provider-neutral Agent runtime.
 *
 * These types deliberately do not depend on a provider SDK. The old
 * AgentConversation.messages transcript remains a display/migration cache;
 * recovery must use the normalized session/turn/message/event records here.
 */

export type AgentRuntimeSessionStatus =
  | 'pending'
  | 'idle'
  | 'running'
  | 'recovering'
  | 'interrupted'
  | 'closed'
  | 'failed'
  | 'aborted';

export type PersistedAgentRuntimeRouteKind = 'chat' | 'goal';

export interface PersistedAgentRuntimeSession {
  id: string;
  projectId: string;
  routeKind: PersistedAgentRuntimeRouteKind;
  conversationId: string | null;
  goalRunId: string | null;
  chapterId: string | null;
  provider: string;
  model: string | null;
  providerEpoch: number;
  status: AgentRuntimeSessionStatus;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export type AgentRuntimeTurnStatus =
  | 'accepted'
  | 'running'
  | 'recovering'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'aborted';

export interface PersistedAgentRuntimeTurn {
  id: string;
  sessionId: string;
  ordinal: number;
  status: AgentRuntimeTurnStatus;
  promptMessageId: string | null;
  acceptedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export type AgentRuntimeMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type AgentRuntimeMessageStatus =
  | 'accepted'
  | 'streaming'
  | 'complete'
  | 'interrupted'
  | 'failed';

export interface PersistedAgentRuntimeMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  /** Stable provider-history order. Timestamps are never used for ordering. */
  ordinal: number;
  role: AgentRuntimeMessageRole;
  status: AgentRuntimeMessageStatus;
  content: unknown;
  createdAt: string;
  completedAt: string | null;
}

export interface PersistedAgentRuntimeEvent {
  eventId: string;
  sessionId: string;
  turnId: string;
  seq: number;
  schemaVersion: number;
  eventType: string;
  /**
   * Canonical JSON payload. The journal adapter should persist every field
   * needed to rebuild its provider-neutral reducer state (including route).
   */
  payload: unknown;
  wallTimeMs: number;
  createdAt: string;
}

export type AgentRuntimeToolCallAccess = 'read' | 'write';
export type AgentRuntimeToolCallStatus =
  | 'requested'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'uncertain';

/**
 * Durable tool lifecycle projection. The immutable journal remains the audit
 * log; this row lets recovery detect orphaned calls without interpreting
 * provider-specific messages.
 */
export interface PersistedAgentRuntimeToolCall {
  id: string;
  sessionId: string;
  turnId: string;
  callId: string;
  name: string;
  access: AgentRuntimeToolCallAccess;
  status: AgentRuntimeToolCallStatus;
  idempotencyKey: string;
  arguments: unknown;
  result: unknown | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type PersistedAgentRuntimeCheckpointContext =
  | {
      schemaVersion: 2;
      format: 'drifting.agent-runtime-checkpoint-context';
      canonicalHistory: unknown;
      canonicalSourceRows: unknown;
      providerEnvelope: unknown;
    }
  | {
      schemaVersion: 3;
      format: 'drifting.agent-runtime-checkpoint-context-with-summaries';
      canonicalHistory: unknown;
      durableSummaries: unknown;
    }
  | {
      schemaVersion: 4;
      format: 'drifting.agent-runtime-checkpoint-digest-with-summaries';
      canonicalMessageCount: number;
      canonicalHistoryHash: string;
      durableSummaries: unknown;
    };

/**
 * Provider-neutral context checkpoint. Exact provider history lives in
 * normalized message rows; current checkpoint envelopes add independently
 * verified context witnesses, summaries, or a bounded row digest.
 */
export interface PersistedAgentRuntimeCheckpoint {
  id: string;
  sessionId: string;
  throughTurnOrdinal: number;
  messageCount: number;
  context: PersistedAgentRuntimeCheckpointContext;
  contextHash: string;
  createdAt: string;
}

export interface AgentRuntimeRecoverySnapshot {
  session: PersistedAgentRuntimeSession;
  turns: PersistedAgentRuntimeTurn[];
  messages: PersistedAgentRuntimeMessage[];
  events: PersistedAgentRuntimeEvent[];
  toolCalls: PersistedAgentRuntimeToolCall[];
  checkpoints: PersistedAgentRuntimeCheckpoint[];
}
