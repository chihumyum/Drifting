import type { BookElement } from './book-element';
import type { BookElementCategory } from './book-element';
import type { BookNode } from './book-node';
import type { Comment, CommentAction } from './comment';
import type { Project } from './project';
import type { Storyline } from './storyline';
import type { AgentMemory } from './agent-memory';

export type AgentRuntimeEntityWriteDirection = 'forward' | 'inverse';
export type AgentRuntimeEntityWriteTool =
  | 'create_comment'
  | 'update_comment'
  | 'delete_comment'
  | 'set_comment_status'
  | 'set_comment_kind'
  | 'create_node'
  | 'delete_node'
  | 'create_element'
  | 'delete_element'
  | 'create_storyline'
  | 'delete_storyline'
  | 'create_category'
  | 'update_category'
  | 'delete_category'
  | 'add_relation'
  | 'update_relation_kind'
  | 'remove_relation'
  | 'set_storyline_membership'
  | 'remember'
  | 'update_memory'
  | 'forget'
  | 'update_element'
  | 'update_storyline'
  | 'update_project_facts';
export type AgentRuntimeEntityWriteKind =
  | 'comment'
  | 'node'
  | 'element'
  | 'storyline'
  | 'category'
  | 'relation'
  | 'storyline_membership'
  | 'memory'
  | 'project';

export interface AgentRuntimeStorylineMembershipLinkSnapshot {
  nodeId: string;
  storylineId: string;
  isPrimary: boolean;
}

/**
 * Complete project-scoped storyline membership image. A write to one
 * storyline can change another storyline's `isPrimary` flag for a chapter, so
 * the receipt intentionally snapshots the whole graph instead of pretending a
 * single link row is an isolated entity.
 */
export interface AgentRuntimeStorylineMembershipSnapshotValue {
  /** The storyline whose `chapters.json` file was authored. */
  id: string;
  projectId: string;
  links: AgentRuntimeStorylineMembershipLinkSnapshot[];
  /** Opaque hash of `links`, used as the receipt revision. */
  updatedAt: string;
}

export interface AgentRuntimeEntityRelationSnapshotValue {
  id: string;
  projectId: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A closed, typed authored-state image. This is runtime recovery data and is
 * intentionally not stored in any entity metadata column.
 */
export type AgentRuntimeEntityWriteSnapshot =
  | { kind: 'comment'; value: Comment; actions?: CommentAction[] }
  | { kind: 'node'; value: BookNode }
  | { kind: 'element'; value: BookElement }
  | { kind: 'storyline'; value: Storyline }
  | { kind: 'category'; value: BookElementCategory }
  | { kind: 'relation'; value: AgentRuntimeEntityRelationSnapshotValue }
  | {
      kind: 'storyline_membership';
      value: AgentRuntimeStorylineMembershipSnapshotValue;
    }
  | { kind: 'memory'; value: AgentMemory }
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
  value:
    | Comment
    | BookNode
    | BookElement
    | Storyline
    | BookElementCategory
    | AgentRuntimeEntityRelationSnapshotValue
    | AgentRuntimeStorylineMembershipSnapshotValue
    | AgentMemory
    | Project,
  kind: AgentRuntimeEntityWriteKind,
): AgentRuntimeEntityWriteSnapshot {
  return { kind, value } as AgentRuntimeEntityWriteSnapshot;
}
