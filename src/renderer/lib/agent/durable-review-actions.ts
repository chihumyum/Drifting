import type {
  AgentWriteReviewDecisionResult,
} from './runtime/drifting-write-tool-runtime';
import type {
  AgentEditReviewBatch,
} from '../../store/agent-edit-store';
import type { ActivityEntityType } from './tool-entity-ref';

type AcceptReview = (
  reviewId: string,
) => Promise<AgentWriteReviewDecisionResult>;

type RejectReview = (
  reviewId: string,
  decisionNote?: unknown,
  signal?: AbortSignal,
) => Promise<AgentWriteReviewDecisionResult>;

export interface OrderedDurableReviewBatches {
  reviewOrder: readonly string[];
  reviewBatches: Readonly<Record<string, AgentEditReviewBatch>>;
}

type DurableReviewBatchPredicate = (
  batch: AgentEditReviewBatch,
) => boolean;

export class DurableReviewSettlementError extends Error {
  constructor(
    readonly reviewId: string,
    readonly status: string,
  ) {
    super(
      `Durable Agent review "${reviewId}" did not settle successfully (status: ${status})`,
    );
    this.name = 'DurableReviewSettlementError';
  }
}

/**
 * Settle one canonical review before removing its local visual batch. The
 * callback is deliberately last: a failed/partial canonical transition must
 * leave the UI pending and retryable.
 */
export async function approveDurableAgentReview(
  reviewId: string,
  acceptReview: AcceptReview,
  onAccepted: () => void,
): Promise<void> {
  const result = await acceptReview(reviewId);
  if (result.review.status !== 'accepted_effect') {
    throw new DurableReviewSettlementError(
      reviewId,
      result.review.status,
    );
  }
  onAccepted();
}

/**
 * Accept every durable batch represented by one merged UI affordance. Local
 * presentation state is cleared only after every canonical review reached
 * accepted_effect; partial failures remain visible and are safe to retry.
 */
export async function approveDurableAgentReviewsForEntity(input: {
  entityType: ActivityEntityType;
  id: string;
  batches: OrderedDurableReviewBatches;
  acceptReview: AcceptReview;
  onAllAccepted: (
    reviewIds: readonly string[],
    batches: readonly AgentEditReviewBatch[],
  ) => void;
  matchesBatch?: DurableReviewBatchPredicate;
}): Promise<readonly string[]> {
  const ordered = matchingBatches({
    ...input,
    approveModeOnly: false,
  });
  const reviewIds = ordered.map((batch) => batch.reviewId);
  for (const reviewId of reviewIds) {
    const result = await input.acceptReview(reviewId);
    if (result.review.status !== 'accepted_effect') {
      throw new DurableReviewSettlementError(
        reviewId,
        result.review.status,
      );
    }
  }
  if (reviewIds.length > 0) {
    input.onAllAccepted(reviewIds, ordered);
  }
  return reviewIds;
}

/**
 * Reject every still-active approve-mode durable batch for one entity, newest
 * first. Each call reaches the runtime's exact guarded inverse. Local batches
 * and feedback are touched only after every inverse settled; a conflict at any
 * depth leaves the full visual review stack intact.
 */
export async function rejectDurableAgentReviewsForEntity(input: {
  entityType: ActivityEntityType;
  id: string;
  batches: OrderedDurableReviewBatches;
  rejectReview: RejectReview;
  onAllReverted: (
    reviewIds: readonly string[],
    batches: readonly AgentEditReviewBatch[],
  ) => void;
  decisionNote?: unknown;
  signal?: AbortSignal;
  matchesBatch?: DurableReviewBatchPredicate;
}): Promise<readonly string[]> {
  const ordered = matchingBatches({
    ...input,
    approveModeOnly: true,
  }).reverse();
  const reviewIds = ordered.map((batch) => batch.reviewId);
  for (const reviewId of reviewIds) {
    const result = await input.rejectReview(
      reviewId,
      input.decisionNote,
      input.signal,
    );
    if (result.review.status !== 'reverted') {
      throw new DurableReviewSettlementError(
        reviewId,
        result.review.status,
      );
    }
  }
  input.onAllReverted(reviewIds, ordered);
  return reviewIds;
}

function matchingBatches(input: {
  entityType: ActivityEntityType;
  id: string;
  batches: OrderedDurableReviewBatches;
  approveModeOnly: boolean;
  matchesBatch?: DurableReviewBatchPredicate;
}): AgentEditReviewBatch[] {
  return input.batches.reviewOrder
    .map((reviewId) => input.batches.reviewBatches[reviewId])
    .filter(
      (batch): batch is AgentEditReviewBatch =>
        Boolean(
          batch &&
            batch.entityType === input.entityType &&
            batch.id === input.id &&
            (!input.approveModeOnly ||
              batch.changes.some(
                (change) => (change.mode ?? 'approve') === 'approve',
              )) &&
            (!input.matchesBatch || input.matchesBatch(batch)),
        ),
    );
}
