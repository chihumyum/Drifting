/**
 * A provider-neutral, opaque entity generation. SQL updated_at values, durable
 * Yjs counters, and future server ETags all fit without teaching the runtime
 * their storage-specific ordering rules. Freshness only requires exact match.
 */
export type AgentRuntimeEntityRevision = string;

/**
 * Opaque provider-facing citation copied from a successful read tool result.
 * Writes must echo this object exactly; they may not invent a revision from a
 * renderer store snapshot.
 */
export interface AgentRuntimeExpectedRevision {
  receiptId: string;
  observationId: string;
  revision: AgentRuntimeEntityRevision;
}

/** Renderer-usecase CAS capability. Manual callers omit this object. */
export interface AgentRuntimeNodeWriteGuard {
  expectedRevision: AgentRuntimeEntityRevision;
}

export interface AgentRuntimeReadFreshnessObservation {
  id: string;
  entityKind: string;
  entityId: string;
  revision: AgentRuntimeEntityRevision;
}

export interface AgentRuntimeReadFreshness {
  receiptId: string;
  observations: AgentRuntimeReadFreshnessObservation[];
}

/**
 * Canonical provider-neutral read envelope. The exact envelope, including its
 * stable receipt/observation ids, is persisted before it is returned.
 */
export interface AgentRuntimeReadResult<T = unknown> {
  result: T;
  freshness: AgentRuntimeReadFreshness;
}

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
