import type { ElementPatch } from '../sqlite-repo/element-patch-repo';

export type AgentRuntimeElementPatchCommandDirection = 'forward' | 'inverse';
export type AgentRuntimeElementPatchCommandTool =
  | 'create_element_patch'
  | 'update_element_patch';

/**
 * Exact authored-state snapshot carried by the immutable command receipt.
 * Runtime provenance is stored in dedicated columns; this payload is only the
 * element_patch postimage needed to reconcile a process death and guard reject.
 */
export interface AgentRuntimeElementPatchSnapshot {
  id: string;
  projectId: string;
  elementId: string;
  sourceNodeId: string | null;
  sourceBlockId: string | null;
  sourceBlockText: string | null;
  textAnchorJson: string | null;
  invalidatedAt: string | null;
  title: string | null;
  contentJson: string;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAgentRuntimeElementPatchReceipt {
  id: string;
  effectId: string;
  commandId: string;
  direction: AgentRuntimeElementPatchCommandDirection;
  projectId: string;
  sessionId: string;
  toolName: AgentRuntimeElementPatchCommandTool;
  patchId: string;
  expectedRevision: string | null;
  resultRevision: string | null;
  postimage: AgentRuntimeElementPatchSnapshot | null;
  postimageHash: string | null;
  createdAt: string;
}

export type CreateAgentRuntimeElementPatchReceipt =
  PersistedAgentRuntimeElementPatchReceipt;

export function snapshotElementPatch(
  patch: ElementPatch,
): AgentRuntimeElementPatchSnapshot {
  return {
    id: patch.id,
    projectId: patch.projectId,
    elementId: patch.elementId,
    sourceNodeId: patch.sourceNodeId,
    sourceBlockId: patch.sourceBlockId,
    sourceBlockText: patch.sourceBlockText,
    textAnchorJson: patch.textAnchorJson,
    invalidatedAt: patch.invalidatedAt,
    title: patch.title,
    contentJson: patch.contentJson,
    orderKey: patch.orderKey,
    createdAt: patch.createdAt,
    updatedAt: patch.updatedAt,
  };
}
