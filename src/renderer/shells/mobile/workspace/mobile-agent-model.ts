import type { Editor } from '@tiptap/core';
import type {
  AgentChatMessage,
  AgentConversationContextRef,
} from '../../../domain/agent-conversation';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { toolEntityRef, type ActivityEntityType } from '../../../lib/agent/tool-entity-ref';

export interface MobileAgentEvidenceRef {
  entityType: ActivityEntityType;
  entityId: string;
  blockId?: string;
  operation: 'read' | 'write';
}

export function selectedMobileAgentBlockId(editor: Editor | null): string | undefined {
  if (!editor || editor.isDestroyed) return undefined;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const id = $from.node(depth).attrs?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

export function buildMobileAgentTurnContext(input: {
  projectId: string;
  projectName: string;
  target: WorkspaceTarget | null;
  targetLabel: string;
  blockId?: string;
}): AgentConversationContextRef[] {
  const refs: AgentConversationContextRef[] = [
    {
      kind: 'project',
      projectId: input.projectId,
      label: input.projectName || 'Current Project',
    },
  ];
  const target = input.target;
  if (!target || target.entityType === 'dashboard') return refs;
  if (target.entityType === 'all-chapters') {
    refs.push({
      kind: 'workspace',
      projectId: input.projectId,
      label: input.targetLabel,
      entityType: 'all-chapters',
      entityId: 'self',
    });
    return refs;
  }
  refs.push({
    kind: 'workspace',
    projectId: input.projectId,
    label: input.targetLabel,
    entityType: target.entityType,
    entityId: target.id,
    ...(input.blockId ? { blockId: input.blockId } : {}),
  });
  return refs;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blockIdsFromTool(message: Extract<AgentChatMessage, { kind: 'tool' }>): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  };
  const input = record(message.input);
  add(input?.blockId);
  for (const value of Array.isArray(input?.blockIds) ? input!.blockIds : []) add(value);
  if (message.result) {
    try {
      const result = record(JSON.parse(message.result));
      add(result?.blockId);
      for (const value of Array.isArray(result?.blockIds) ? result!.blockIds : []) add(value);
      for (const item of Array.isArray(result?.matches) ? result!.matches : []) {
        add(record(item)?.blockId);
      }
      for (const item of Array.isArray(result?.blocks) ? result!.blocks : []) {
        add(record(item)?.blockId);
      }
    } catch {
      // A human-readable result remains a valid tool row, just not a block link.
    }
  }
  return [...ids];
}

export function collectMobileAgentEvidence(
  messages: readonly AgentChatMessage[],
): MobileAgentEvidenceRef[] {
  const byKey = new Map<string, MobileAgentEvidenceRef>();
  for (const message of messages) {
    if (message.kind !== 'tool' || message.status !== 'ok') continue;
    const ref = toolEntityRef(message.name, message.input, message.result);
    if (!ref || (ref.op !== 'read' && ref.op !== 'write')) continue;
    const blockIds = [
      ...(ref.spots?.blocks ?? []),
      ...blockIdsFromTool(message),
    ];
    const operation = ref.op;
    if (blockIds.length === 0) {
      const evidence = { entityType: ref.entityType, entityId: ref.id, operation };
      byKey.set(`${ref.entityType}:${ref.id}`, evidence);
    } else {
      for (const blockId of blockIds) {
        const evidence = { entityType: ref.entityType, entityId: ref.id, blockId, operation };
        byKey.set(`${ref.entityType}:${ref.id}:${blockId}`, evidence);
      }
    }
    if (byKey.size >= 32) break;
  }
  return [...byKey.values()];
}

export function openMobileAgentEvidence(
  evidence: MobileAgentEvidenceRef,
  actions: {
    open: (target: WorkspaceTarget) => void;
    scrollToBlock: (entityId: string, blockId: string) => void;
  },
): void {
  actions.open({ entityType: evidence.entityType, id: evidence.entityId });
  if (evidence.blockId) actions.scrollToBlock(evidence.entityId, evidence.blockId);
}

export function mobileAgentOutputTitle(text: string): string {
  const first = text
    .split(/\n+/u)
    .map((line) => line.replace(/^\s*[-#>*]+\s*/u, '').trim())
    .find(Boolean);
  if (!first) return 'Agent 灵感';
  const normalized = first.replace(/[*_`]/gu, '').trim();
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
}

export function mobileAgentOutputProseJson(
  text: string,
  createBlockId: () => string,
): string {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/u)
    .map((part) => part.replace(/\n+/gu, ' ').trim())
    .filter(Boolean);
  return JSON.stringify({
    type: 'doc',
    content: (paragraphs.length > 0 ? paragraphs : ['']).map((part) => ({
      type: 'paragraph',
      attrs: { id: createBlockId() },
      content: part ? [{ type: 'text', text: part }] : [],
    })),
  });
}

export function mobileAgentTodoAnchor(
  refs: readonly AgentConversationContextRef[],
): { targetKind?: ActivityEntityType; targetId?: string; targetBlockId?: string } {
  const target = refs.find(
    (ref) =>
      ref.kind === 'workspace' &&
      ref.entityType !== 'all-chapters' &&
      ref.entityId &&
      ref.entityType,
  );
  if (!target?.entityType || target.entityType === 'all-chapters' || !target.entityId) return {};
  return {
    targetKind: target.entityType,
    targetId: target.entityId,
    ...(target.blockId ? { targetBlockId: target.blockId } : {}),
  };
}

export function mobileAgentContextBefore(
  messages: readonly AgentChatMessage[],
  messageIndex: number,
): AgentConversationContextRef[] {
  for (let index = Math.min(messageIndex - 1, messages.length - 1); index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'user') return message.context ?? [];
  }
  return [];
}
