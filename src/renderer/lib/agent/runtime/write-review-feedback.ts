import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';

const MAX_FEEDBACK_ITEMS = 20;
const MAX_ARGUMENT_CHARS = 240;

/**
 * Canonical user-decision feedback appended to the next model prompt.
 *
 * Decisions are read from SQLite rather than the display/edit localStorage
 * cache. Repeating a settled decision after restart is harmless and preferable
 * to losing the fact that an edit was rejected or its inverse failed.
 */
export async function buildAgentWriteReviewFeedback(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository =
    createAgentRuntimeWriteEffectRepository(),
): Promise<string> {
  if (!sessionId) return '';
  const snapshot = await repository.loadSnapshot(sessionId);
  const effects = new Map(snapshot.effects.map((effect) => [effect.id, effect]));
  const settled = snapshot.reviews
    .filter((review) =>
      [
        'accepted_effect',
        'reverted',
        'revert_failed',
        'revert_unavailable',
      ].includes(review.status),
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id),
    )
    .slice(0, MAX_FEEDBACK_ITEMS);
  if (settled.length === 0) return '';

  const lines = settled.flatMap((review) => {
    const effect = effects.get(review.effectId);
    if (!effect) return [];
    const args = clamp(
      JSON.stringify(effect.arguments),
      MAX_ARGUMENT_CHARS,
    );
    const prefix = `- ${effect.toolName}(${args})`;
    switch (review.status) {
      case 'accepted_effect':
        return [`${prefix} 已被用户接受，继续把该结果视为当前事实。`];
      case 'reverted':
        return [`${prefix} 已被用户拒绝并精确撤销，不要假设该改动仍然存在。`];
      case 'revert_failed':
        return [
          `${prefix} 被用户拒绝，但自动撤销失败；重新读取实体后再提出任何后续改动。`,
        ];
      case 'revert_unavailable':
        return [
          `${prefix} 被用户拒绝，但没有安全逆操作；不要重试，先请求用户处理。`,
        ];
      default:
        return [];
    }
  });
  return lines.length > 0
    ? [
        '[Agent write-review decisions since this session began]',
        ...lines,
      ].join('\n')
    : '';
}

function clamp(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}…`;
}
