import { useLayoutEffect, useReducer } from 'react';
import { BYOKCredentialsProvider } from '../ai/credentials/byok';
import { ChainCredentialsProvider } from '../ai/credentials/chain';
import { EnvCredentialsProvider } from '../ai/credentials/env';
import type { GeneralAgentAuthStatus } from './protocol';
import { createDriftingAgentProductComposition } from './runtime';
import { installGeneralAgentTransport, type GeneralAgentTransport } from './transport';
import {
  matchesDriftingAgentWriteReviewProvenance,
  type DriftingAgentWriteReviewProvenance,
} from './runtime/write-review-provenance';

async function readLocalAgentAuthStatus(): Promise<GeneralAgentAuthStatus> {
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
  let connected = false;
  try {
    connected = Boolean(await credentials.getApiKey('deepseek'));
  } catch {
    connected = false;
  }
  return {
    // Both legacy BYOK labels resolve to the same P1 DeepSeek credential. The
    // settings migration selects `apikey`; keeping both truthful makes an old
    // hydrated window usable before its state is rewritten.
    byokConnected: connected,
    apiKeyConnected: connected,
    hostedAvailable: false,
  };
}

export function createDriftingLocalAgentTransport(): GeneralAgentTransport {
  return createDriftingAgentProductComposition({
    authStatus: readLocalAgentAuthStatus,
  }).transport;
}

const driftingProductComposition = createDriftingAgentProductComposition({
  authStatus: readLocalAgentAuthStatus,
});

export interface DriftingAgentWriteReviewStatusEvent {
  reviewId: string;
  status: string;
}

const writeReviewStatusListeners = new Set<(event: DriftingAgentWriteReviewStatusEvent) => void>();

function publishWriteReviewStatus(event: DriftingAgentWriteReviewStatusEvent): void {
  for (const listener of writeReviewStatusListeners) listener(event);
}

export function subscribeDriftingAgentWriteReviewStatus(
  listener: (event: DriftingAgentWriteReviewStatusEvent) => void,
): () => void {
  writeReviewStatusListeners.add(listener);
  return () => writeReviewStatusListeners.delete(listener);
}

/** Refresh a tool-card review after reload or an entity-editor decision. */
export async function getDriftingAgentWriteReview(
  reviewId: string,
  expected: DriftingAgentWriteReviewProvenance,
): Promise<DriftingAgentWriteReviewStatusEvent | null> {
  const review = await driftingProductComposition.repositories.writeEffects.getReview(reviewId);
  if (!review) return null;
  const effect = await driftingProductComposition.repositories.writeEffects.getEffect(
    review.effectId,
  );
  if (!effect || !matchesDriftingAgentWriteReviewProvenance(review, effect, expected)) {
    return null;
  }
  return { reviewId: review.id, status: review.status };
}

/** Canonical soft-review actions for the Agent edit UI. */
export async function acceptDriftingAgentWriteReview(reviewId: string) {
  const result = await driftingProductComposition.tools.acceptReview(reviewId);
  publishWriteReviewStatus({
    reviewId: result.review.id,
    status: result.review.status,
  });
  return result;
}

export async function rejectDriftingAgentWriteReview(
  reviewId: string,
  decisionNote?: unknown,
  signal?: AbortSignal,
) {
  const result = await driftingProductComposition.tools.rejectReview(
    reviewId,
    decisionNote,
    signal,
  );
  publishWriteReviewStatus({
    reviewId: result.review.id,
    status: result.review.status,
  });
  return result;
}

// One product transport per renderer lifetime. React Strict Mode may mount,
// clean up, and remount effects; reusing this instance preserves subscriptions
// and prevents a turn from being attached to a discarded duplicate.
const driftingLocalAgentTransport = driftingProductComposition.transport;

/** Install the provider-neutral local runtime behind the existing chat seam. */
export function useDriftingAgentRuntime(): void {
  const [, refreshCapabilities] = useReducer((value: number) => value + 1, 0);
  useLayoutEffect(() => {
    const restore = installGeneralAgentTransport(driftingLocalAgentTransport);
    // The facade is intentionally external to React. Re-render the owning
    // layout once so child panels observe the newly installed capability
    // before paint instead of keeping their first unsupported projection.
    refreshCapabilities();
    return restore;
  }, []);
}
