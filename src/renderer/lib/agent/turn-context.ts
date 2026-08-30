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

/**
 * Hidden provider note for the same chips the author sees. It is a starting
 * point, not an authority shortcut: the Agent must still read live prose.
 */
export function agentTurnContextPrompt(refs: readonly AgentConversationContextRef[]): string {
  if (refs.length === 0) return '';
  const lines = refs.map((ref) => {
    if (ref.kind === 'project') return `- Project: ${JSON.stringify(ref.label)}`;
    const identity = [
      ref.entityType ? `kind=${ref.entityType}` : '',
      ref.entityId ? `id=${JSON.stringify(ref.entityId)}` : '',
      ref.blockId ? `stableBlockId=${JSON.stringify(ref.blockId)}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `- Workspace: ${JSON.stringify(ref.label)}${identity ? ` (${identity})` : ''}`;
  });
  return [
    '[Visible mobile turn context]',
    ...lines,
    'Use this only as the author-visible starting point. Read current authored evidence before making factual claims, and report any changes you make precisely — never claim a change you did not perform.',
  ].join('\n');
}
