/**
 * A provider-neutral, opaque entity generation. SQL updated_at values, durable
 * Yjs counters, and future server ETags all fit without teaching the runtime
 * their storage-specific ordering rules. Freshness only requires exact match.
 */
export type AgentRuntimeEntityRevision = string;

export interface CreateAgentRuntimeReadObservation {
  id: string;
  entityKind: string;
  entityId: string;
  revision: AgentRuntimeEntityRevision;
  stateVector?: Uint8Array | null;
  stateHash?: string | null;
}

export interface CreateAgentRuntimeReadReceipt {
  id: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  idempotencyKey: string;
  result: unknown;
  observations: readonly CreateAgentRuntimeReadObservation[];
  createdAt: string;
}

export interface PersistedAgentRuntimeReadObservation {
  id: string;
  receiptId: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  ordinal: number;
  entityKind: string;
  entityId: string;
  revision: AgentRuntimeEntityRevision;
  stateVector: Uint8Array | null;
  stateHash: string | null;
  createdAt: string;
}

export interface PersistedAgentRuntimeReadReceipt {
  id: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  idempotencyKey: string;
  /** Exact UTF-8 bytes of the canonical JSON tool result. */
  resultBlob: Uint8Array;
  resultHash: string;
  result: unknown;
  observations: PersistedAgentRuntimeReadObservation[];
  createdAt: string;
}

export interface AttachAgentRuntimeWriteExpectations {
  effectId: string;
  projectId: string;
  sessionId: string;
  observations: readonly {
    id: string;
    observationId: string;
  }[];
  createdAt: string;
}

export interface PersistedAgentRuntimeWriteExpectation {
  id: string;
  effectId: string;
  projectId: string;
  sessionId: string;
  writeTurnId: string;
  writeToolCallId: string;
  observationId: string;
  readReceiptId: string;
  readTurnId: string;
  readToolCallId: string;
  entityKind: string;
  entityId: string;
  expectedRevision: AgentRuntimeEntityRevision;
  expectedStateVector: Uint8Array | null;
  expectedStateHash: string | null;
  createdAt: string;
}

export interface AgentRuntimeCurrentEntityVersion {
  revision: AgentRuntimeEntityRevision;
  stateVector?: Uint8Array | null;
  stateHash?: string | null;
}
