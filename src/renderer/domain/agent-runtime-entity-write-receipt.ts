import type { BookElement } from './book-element';
import type { Comment } from './comment';
import type { Project } from './project';
import type { Storyline } from './storyline';

export type AgentRuntimeEntityWriteDirection = 'forward' | 'inverse';
export type AgentRuntimeEntityWriteTool =
  | 'create_comment'
  | 'update_element'
  | 'update_storyline'
  | 'update_project_facts';
export type AgentRuntimeEntityWriteKind =
  | 'comment'
  | 'element'
  | 'storyline'
  | 'project';

/**
 * A closed, typed authored-state image. This is runtime recovery data and is
 * intentionally not stored in any entity metadata column.
 */
export type AgentRuntimeEntityWriteSnapshot =
  | { kind: 'comment'; value: Comment }
  | { kind: 'element'; value: BookElement }
  | { kind: 'storyline'; value: Storyline }
  | { kind: 'project'; value: Project };

export interface PersistedAgentRuntimeEntityWriteReceipt {
  id: string;
  effectId: string;
  commandId: string;
  direction: AgentRuntimeEntityWriteDirection;
  projectId: string;
  sessionId: string;
  toolName: AgentRuntimeEntityWriteTool;
  entityKind: AgentRuntimeEntityWriteKind;
  entityId: string;
  expectedRevision: string | null;
  resultRevision: string | null;
  preimage: AgentRuntimeEntityWriteSnapshot | null;
  preimageHash: string | null;
  postimage: AgentRuntimeEntityWriteSnapshot | null;
  postimageHash: string | null;
  createdAt: string;
}

export type CreateAgentRuntimeEntityWriteReceipt =
  PersistedAgentRuntimeEntityWriteReceipt;

export function snapshotAgentRuntimeEntity(
  value: Comment | BookElement | Storyline | Project,
  kind: AgentRuntimeEntityWriteKind,
): AgentRuntimeEntityWriteSnapshot {
  return { kind, value } as AgentRuntimeEntityWriteSnapshot;
}
