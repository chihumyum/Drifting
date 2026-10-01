import type { AgentConversationContextRef } from '../../domain/agent-conversation';

function clean(value: string, maxLength: number): string {
  const normalized = value.replaceAll('\u0000', '').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

/** Stable de-duplication keeps a retry from multiplying the same context chip. */
export function normalizeAgentTurnContext(
  refs: readonly AgentConversationContextRef[] | undefined,
): AgentConversationContextRef[] {
  const byKey = new Map<string, AgentConversationContextRef>();
  for (const ref of refs ?? []) {
    const projectId = clean(ref.projectId, 200);
    const label = clean(ref.label, 500);
    if (!projectId || !label) continue;
    const entityId = ref.entityId ? clean(ref.entityId, 300) : undefined;
    const blockId = ref.blockId ? clean(ref.blockId, 300) : undefined;
    const key = [ref.kind, projectId, ref.entityType ?? '', entityId ?? '', blockId ?? ''].join(':');
    byKey.set(key, {
      kind: ref.kind,
      projectId,
      label,
      ...(ref.entityType ? { entityType: ref.entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(blockId ? { blockId } : {}),
    });
  }
  return [...byKey.values()];
}
