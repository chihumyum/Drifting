import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import type { AgentContextSupplementalPinnedRow } from './context-message-adapter';

const MAX_FEEDBACK_ITEMS = 20;
const MAX_ARGUMENT_CHARS = 240;
const PINNED_REVIEW_STATUSES = new Set([
  'pending',
  'accepted',
  'rejected',
  'revert_started',
  'accepted_effect',
  'reverted',
  'revert_failed',
  'revert_unavailable',
]);

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

/**
 * First-class context rows for current durable review decisions.
 *
 * Unlike the legacy prompt prefix, these rows retain canonical provenance and
 * remain semantically pinned by the context planner. Pending/in-progress
 * decisions are never trimmed; settled history is bounded because accepted
 * domain state must be re-read through tools rather than growing an eternal
 * prompt log.
 */
export async function loadAgentWriteReviewContextRows(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository =
    createAgentRuntimeWriteEffectRepository(),
): Promise<AgentContextSupplementalPinnedRow[]> {
  if (!sessionId) return [];
  const snapshot = await repository.loadSnapshot(sessionId);
  const effects = new Map(snapshot.effects.map((effect) => [effect.id, effect]));
  const eligible = snapshot.reviews
    .filter((review) => PINNED_REVIEW_STATUSES.has(review.status))
    .filter((review) => effects.has(review.effectId))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  const unsettled = eligible.filter((review) =>
    ['pending', 'accepted', 'rejected', 'revert_started'].includes(
      review.status,
    ),
  );
  const settled = eligible
    .filter((review) => !unsettled.includes(review))
    .slice(-MAX_FEEDBACK_ITEMS);

  return [...settled, ...unsettled]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map((review) => {
      const effect = effects.get(review.effectId)!;
      return {
        sourceId: `write-review:${review.id}`,
        turnOrdinal: null,
        kind: 'write_review',
        content: JSON.stringify({
          reviewId: review.id,
          effectId: effect.id,
          toolName: effect.toolName,
          arguments: clamp(
            JSON.stringify(effect.arguments),
            MAX_ARGUMENT_CHARS,
          ),
          effectPhase: effect.phase,
          reviewStatus: review.status,
          decisionNote: review.decisionNote,
          errorCode: review.errorCode,
          errorMessage: review.errorMessage,
        }),
      };
    });
}

function clamp(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}…`;
}
