/**
 * Durable, provider-neutral storage for oversized tool results.
 *
 * The provider only receives a bounded preview plus `resultRef`. The complete
 * UTF-8 payload lives in SQLite and remains page-readable after a renderer or
 * app restart. Blobs are content-addressed so identical results share physical
 * storage while every reference keeps its own project/session/tool provenance.
 */

export interface AgentRuntimeResultArtifactQuota {
  maxArtifactsPerSession: number;
  maxBytesPerSession: number;
}

export interface PersistAgentRuntimeResultArtifact {
  ref: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  idempotencyKey: string;
  arguments: Record<string, unknown>;
  serialized: string;
  createdAt: string;
  quota: AgentRuntimeResultArtifactQuota;
}

export interface PersistedAgentRuntimeResultArtifact {
  ref: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  idempotencyKey: string;
  arguments: Record<string, unknown>;
  contentHash: string;
  byteCount: number;
  charCount: number;
  serialized: string;
  createdAt: string;
}

export interface ReadAgentRuntimeResultArtifact {
  ref: string;
  projectId: string;
  sessionId: string;
}

export interface AgentRuntimeResultArtifactPage extends Omit<
  PersistedAgentRuntimeResultArtifact,
  'serialized'
> {
  offset: number;
  nextOffset: number;
  truncated: boolean;
  content: string;
}

export interface ReadAgentRuntimeResultArtifactPage extends ReadAgentRuntimeResultArtifact {
  offset: number;
  limit: number;
}

export interface CollectAgentRuntimeResultArtifacts {
  /** Delete references strictly older than this ISO timestamp. */
  expiresBefore: string;
  projectId?: string;
  sessionId?: string;
}

export interface AgentRuntimeResultArtifactGcResult {
  deletedArtifacts: number;
  deletedBlobs: number;
}
