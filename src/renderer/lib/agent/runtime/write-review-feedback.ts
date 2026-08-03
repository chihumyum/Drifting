import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import type { AgentContextSupplementalPinnedRow } from './context-message-adapter';

const MAX_FEEDBACK_ITEMS = 20;
const MAX_ARGUMENT_CHARS = 240;
const SETTLED_REVIEW_STATUSES = new Set([
  'accepted_effect',
  'reverted',
  'revert_failed',
  'revert_unavailable',
]);
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

const DURABLE_WRITE_RECEIPT_KIND = 'durable_write_receipt_archive' as const;

function isSettledReviewStatus(status: string): boolean {
  return SETTLED_REVIEW_STATUSES.has(status);
}

function blockReviewDecisionCounts(
  note: unknown,
): { accepted: number; reverted: number } | null {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return null;
  const record = note as Record<string, unknown>;
  if (record.kind !== 'block_review' || record.schemaVersion !== 1) return null;
  if (!Array.isArray(record.decisions)) return null;
  let accepted = 0;
  let reverted = 0;
  for (const item of record.decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const decision = (item as Record<string, unknown>).decision;
    if (decision === 'accepted') accepted += 1;
    else if (decision === 'reverted') reverted += 1;
    else return null;
  }
  return accepted + reverted > 0 ? { accepted, reverted } : null;
}

function writeCoverage(
  effect: {
    callId?: string;
    toolName: string;
  },
  turnOrdinal: number,
  enabled = true,
) {
  return enabled && typeof effect.callId === 'string' && effect.callId.length > 0
    ? [
        {
          turnOrdinal,
          callId: effect.callId,
          toolName: effect.toolName,
        },
      ]
    : [];
}

async function settledArchiveHash(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto SHA-256 is unavailable; settled write-review evidence cannot be archived.',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)) as BufferSource,
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

/**
 * Canonical user-decision feedback appended to the next model prompt.
 *
 * Decisions are read from SQLite rather than the display/edit localStorage
 * cache. Repeating a settled decision after restart is harmless and preferable
 * to losing the fact that an edit was rejected or its inverse failed.
 */
export async function buildAgentWriteReviewFeedback(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository = createAgentRuntimeWriteEffectRepository(),
): Promise<string> {
  if (!sessionId) return '';
  const snapshot = await repository.loadSnapshot(sessionId);
  const effects = new Map(snapshot.effects.map((effect) => [effect.id, effect]));
  const settled = snapshot.reviews
    .filter((review) => isSettledReviewStatus(review.status))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    )
    .slice(0, MAX_FEEDBACK_ITEMS);
  if (settled.length === 0) return '';

  const lines = settled.flatMap((review) => {
    const effect = effects.get(review.effectId);
    if (!effect) return [];
    const args = modelFacingWriteArguments(effect.arguments);
    const prefix = `- ${effect.toolName}(${args})`;
    switch (review.status) {
      case 'accepted_effect':
        {
          const blockDecisions = blockReviewDecisionCounts(review.decisionNote);
          if (blockDecisions?.reverted) {
            return [
              `${prefix} 已逐段审阅：接受 ${blockDecisions.accepted} 处、还原 ${blockDecisions.reverted} 处；以当前正文为准，继续编辑前先重新读取。`,
            ];
          }
        }
        return [
          review.decisionNote === 'auto mode'
            ? `${prefix} 已按自动编辑模式完成，继续把该结果视为当前事实。`
            : `${prefix} 已被用户接受，继续把该结果视为当前事实。`,
        ];
      case 'reverted':
        return [`${prefix} 已被用户拒绝并精确撤销，不要假设该改动仍然存在。`];
      case 'revert_failed':
        return [`${prefix} 被用户拒绝，但自动撤销失败；重新读取实体后再提出任何后续改动。`];
      case 'revert_unavailable':
        return [`${prefix} 被用户拒绝，但没有安全逆操作；不要重试，先请求用户处理。`];
      default:
        return [];
    }
  });
  return lines.length > 0
    ? ['[Agent write-review decisions since this session began]', ...lines].join('\n')
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
  repository: AgentRuntimeWriteEffectRepository = createAgentRuntimeWriteEffectRepository(),
  options: { currentTurnId?: string } = {},
): Promise<AgentContextSupplementalPinnedRow[]> {
  if (!sessionId) return [];
  const snapshot = await repository.loadSnapshot(sessionId);
  const effects = new Map(snapshot.effects.map((effect) => [effect.id, effect]));
  const eligible = snapshot.reviews
    .filter((review) => PINNED_REVIEW_STATUSES.has(review.status))
    .filter((review) => effects.has(review.effectId))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const unsettled = eligible.filter((review) => !isSettledReviewStatus(review.status));
  const allSettled = eligible.filter((review) => isSettledReviewStatus(review.status));
  const settled = allSettled.slice(-MAX_FEEDBACK_ITEMS);
  const archivedSettled = allSettled.slice(0, Math.max(0, allSettled.length - MAX_FEEDBACK_ITEMS));

  const exactRows: AgentContextSupplementalPinnedRow[] = [...settled, ...unsettled]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .map((review) => {
      const effect = effects.get(review.effectId)!;
      const turnOrdinal =
        snapshot.turnContextOrdinalsById?.[effect.turnId] ??
        snapshot.turnOrdinalsById?.[effect.turnId];
      if (turnOrdinal === undefined || !Number.isSafeInteger(turnOrdinal) || turnOrdinal < 0) {
        throw new Error(
          `Write review ${review.id} has no canonical turn ordinal for ${effect.turnId}.`,
        );
      }
      const settledReview = isSettledReviewStatus(review.status);
      const toolPairIsCanonical = snapshot.turnHasCanonicalHistoryById?.[effect.turnId] ?? true;
      return {
        sourceId: `write-review:${review.id}`,
        turnOrdinal,
        kind: 'write_review' as const,
        content: JSON.stringify({
          reviewId: review.id,
          effectId: effect.id,
          callId: effect.callId,
          turnOrdinal,
          toolName: effect.toolName,
          arguments: modelFacingWriteArguments(effect.arguments),
          effectPhase: effect.phase,
          reviewStatus: review.status,
          decisionNote: review.decisionNote,
          errorCode: review.errorCode,
          errorMessage: review.errorMessage,
        }),
        ...(settledReview
          ? {
              durableWriteCoverage: writeCoverage(
                effect,
                turnOrdinal,
                toolPairIsCanonical || effect.turnId === options.currentTurnId,
              ),
            }
          : {}),
      };
    });
  if (archivedSettled.length === 0) return exactRows;

  const archivedEvidence = archivedSettled.map((review) => {
    const effect = effects.get(review.effectId)!;
    const turnOrdinal =
      snapshot.turnContextOrdinalsById?.[effect.turnId] ??
      snapshot.turnOrdinalsById?.[effect.turnId];
    if (turnOrdinal === undefined || !Number.isSafeInteger(turnOrdinal) || turnOrdinal < 0) {
      throw new Error(
        `Write review ${review.id} has no canonical turn ordinal for ${effect.turnId}.`,
      );
    }
    return {
      reviewId: review.id,
      effectId: effect.id,
      status: review.status,
      turnOrdinal,
      callId: effect.callId,
      toolName: effect.toolName,
      toolPairIsCanonical: snapshot.turnHasCanonicalHistoryById?.[effect.turnId] ?? true,
    };
  });
  const archiveHash = await settledArchiveHash(archivedEvidence);
  const statusCounts = archivedEvidence.reduce<Record<string, number>>((counts, evidence) => {
    counts[evidence.status] = (counts[evidence.status] ?? 0) + 1;
    return counts;
  }, {});
  const latestTurnOrdinal = Math.max(...archivedEvidence.map((evidence) => evidence.turnOrdinal));
  return [
    {
      sourceId: `write-review:${sessionId}:settled-archive`,
      turnOrdinal: latestTurnOrdinal,
      kind: 'write_review',
      content: JSON.stringify({
        schemaVersion: 1,
        kind: 'settled_write_review_archive',
        reviewCount: archivedEvidence.length,
        statusCounts,
        throughTurnOrdinal: latestTurnOrdinal,
        evidenceHash: archiveHash,
        instruction:
          'Historical settled writes are represented by current domain state. Re-read affected entities before dependent edits.',
      }),
      durableWriteCoverage: archivedEvidence.flatMap((evidence) =>
        evidence.toolPairIsCanonical &&
        typeof evidence.callId === 'string' &&
        evidence.callId.length > 0
          ? [
              {
                turnOrdinal: evidence.turnOrdinal,
                callId: evidence.callId,
                toolName: evidence.toolName,
              },
            ]
          : [],
      ),
    },
    ...exactRows,
  ];
}

/**
 * One bounded, first-class receipt row for writes whose result is already
 * durable in SQLite. Its provider-visible body stays small while the
 * out-of-band provenance covers every matching canonical tool pair. This lets
 * the planner compact old create/update/delete calls without pretending that
 * the effects were merely conversational history.
 *
 * Effects with an unsettled editor review remain exact until that review is
 * settled. Failed/uncertain writes are never covered.
 */
export async function loadAgentDurableWriteReceiptContextRows(
  sessionId: string,
  repository: AgentRuntimeWriteEffectRepository = createAgentRuntimeWriteEffectRepository(),
  options: { currentTurnId?: string } = {},
): Promise<AgentContextSupplementalPinnedRow[]> {
  if (!sessionId) return [];
  const snapshot = await repository.loadSnapshot(sessionId);
  const unsettledEffectIds = new Set(
    snapshot.reviews
      .filter((review) => !isSettledReviewStatus(review.status))
      .map((review) => review.effectId),
  );
  const committed = snapshot.effects
    .filter(
      (effect) =>
        effect.phase === 'result_committed' &&
        effect.callId.length > 0 &&
        !unsettledEffectIds.has(effect.id),
    )
    .map((effect) => {
      const turnOrdinal =
        snapshot.turnContextOrdinalsById?.[effect.turnId] ??
        snapshot.turnOrdinalsById?.[effect.turnId];
      if (turnOrdinal === undefined || !Number.isSafeInteger(turnOrdinal) || turnOrdinal < 0) {
        throw new Error(
          `Committed write effect ${effect.id} has no canonical turn ordinal for ${effect.turnId}.`,
        );
      }
      const toolPairIsCanonical =
        (snapshot.turnHasCanonicalHistoryById?.[effect.turnId] ?? true) ||
        effect.turnId === options.currentTurnId;
      return { effect, turnOrdinal, toolPairIsCanonical };
    })
    .sort(
      (left, right) =>
        left.turnOrdinal - right.turnOrdinal ||
        left.effect.updatedAt.localeCompare(right.effect.updatedAt) ||
        left.effect.id.localeCompare(right.effect.id),
    );
  if (committed.length === 0) return [];

  const evidence = committed.map(({ effect, turnOrdinal }) => ({
    effectId: effect.id,
    turnOrdinal,
    callId: effect.callId,
    toolName: effect.toolName,
    idempotencyKey: effect.idempotencyKey,
    resultCommittedAt: effect.resultCommittedAt,
  }));
  const toolCounts = Object.fromEntries(
    [...committed.reduce<Map<string, number>>((counts, { effect }) => {
      counts.set(effect.toolName, (counts.get(effect.toolName) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
  const latestTurnOrdinal = Math.max(...committed.map((item) => item.turnOrdinal));

  return [
    {
      sourceId: `write-receipt:${sessionId}:committed-archive`,
      turnOrdinal: latestTurnOrdinal,
      kind: 'write_receipt',
      content: JSON.stringify({
        schemaVersion: 1,
        kind: DURABLE_WRITE_RECEIPT_KIND,
        effectCount: committed.length,
        toolCounts,
        throughTurnOrdinal: latestTurnOrdinal,
        evidenceHash: await settledArchiveHash(evidence),
        instruction:
          'These tool effects are durably committed. Treat current domain state as authoritative and re-read affected resources before dependent edits.',
      }),
      durableWriteCoverage: committed.flatMap(({ effect, turnOrdinal, toolPairIsCanonical }) =>
        toolPairIsCanonical
          ? [
              {
                turnOrdinal,
                callId: effect.callId,
                toolName: effect.toolName,
              },
            ]
          : [],
      ),
    },
  ];
}

function clamp(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function modelFacingWriteArguments(value: unknown): string {
  return clamp(JSON.stringify(stripWriteCoordination(value)), MAX_ARGUMENT_CHARS);
}

function stripWriteCoordination(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWriteCoordination);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      if (
        key.startsWith('__') ||
        /^(?:expectedRevision|revision|receiptId|observationId|stateVector|stateHash|nodeId|entityId|docId|commandId)$/i.test(
          key,
        )
      ) {
        return [];
      }
      return [[key, stripWriteCoordination(child)]];
    }),
  );
}
