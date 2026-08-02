import type { AgentChatMessage } from './agent-conversation';
import type { AgentModelMessage } from '../lib/agent/runtime/types';
import type { ProseEntityType } from '../lib/yjs-doc-id';

/**
 * A user checkpoint is deliberately separate from the runtime's rolling
 * compaction checkpoint. Runtime checkpoints may be compacted; these rows are
 * author-visible restore points and remain complete until the user removes
 * them (or an automatic, unpinned row reaches its retention policy).
 */
export type AgentUserCheckpointKind = 'automatic' | 'manual';
export type AgentUserCheckpointStatus = 'capturing' | 'ready' | 'invalid';

export interface AgentUserCheckpoint {
  id: string;
  projectId: string;
  conversationId: string;
  runtimeSessionId: string | null;
  sourceTurnId: string | null;
  parentCheckpointId: string | null;
  kind: AgentUserCheckpointKind;
  status: AgentUserCheckpointStatus;
  label: string;
  pinned: boolean;
  canonicalThroughTurnOrdinal: number;
  canonicalContextHash: string | null;
  conversationMessages: AgentChatMessage[];
  /** Provider-neutral history used only as product-owned context in a fork. */
  providerHistory: AgentModelMessage[];
  longTaskState: unknown | null;
  acceptedWriteEffectIds: string[];
  entityCount: number;
  createdAt: string;
  finalizedAt: string | null;
  deletedAt: string | null;
}

export interface AgentUserCheckpointEntity {
  checkpointId: string;
  ordinal: number;
  projectId: string;
  entityKind: ProseEntityType;
  entityId: string;
  displayName: string;
  documentId: string;
  yjsRevision: number;
  stateVector: Uint8Array;
  stateHash: string;
  /** Hash of canonical ProseMirror JSON; COVER restore verifies this value. */
  contentHash: string;
  stateBlob: Uint8Array;
  metadataJson: string;
  metadataHash: string;
  capturedAt: string;
}

export interface AgentUserCheckpointSummary {
  id: string;
  conversationId: string;
  sourceTurnId: string | null;
  kind: AgentUserCheckpointKind;
  label: string;
  pinned: boolean;
  entityCount: number;
  createdAt: string;
}

export type AgentUserCheckpointActionKind =
  | 'conversation_fork'
  | 'manuscript_restore'
  | 'restore_and_fork';

export type AgentUserCheckpointActionStatus =
  | 'previewed'
  | 'applying'
  | 'compensating'
  | 'completed'
  | 'compensated'
  | 'failed';

export type AgentUserCheckpointEntityActionStatus =
  | 'pending'
  | 'applied'
  | 'compensated'
  | 'failed';

export interface AgentUserCheckpointPreviewEntity {
  entityKind: ProseEntityType;
  entityId: string;
  displayName: string;
  checkpointStateHash: string;
  currentStateHash: string | null;
  changed: boolean;
  currentRevision: number | null;
  checkpointRevision: number;
  missing: boolean;
}

export interface AgentUserCheckpointPreview {
  actionId: string;
  checkpointId: string;
  projectId: string;
  /** One-use token; only its SHA-256 digest is persisted. */
  previewToken: string;
  expiresAt: string;
  entities: AgentUserCheckpointPreviewEntity[];
  changedEntityCount: number;
  unchangedEntityCount: number;
  requiresExplicitOverwrite: boolean;
}

export interface AgentUserCheckpointRestoreResult {
  actionId: string;
  checkpointId: string;
  restoredEntityCount: number;
  conversationId: string | null;
  replayed: boolean;
}
