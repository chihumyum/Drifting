export interface DriftingAgentWriteReviewProvenance {
  sessionId: string;
  turnId: string;
  callId: string;
  toolName: string;
}

export interface DurableReviewProvenanceRecord {
  id: string;
  effectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
}

export interface DurableEffectProvenanceRecord {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  phase: string;
}

/**
 * A tool-result JSON object is only a review candidate. Bind it back to the
 * immutable local write effect before the UI may expose Accept/Restore.
 */
export function matchesDriftingAgentWriteReviewProvenance(
  review: DurableReviewProvenanceRecord,
  effect: DurableEffectProvenanceRecord,
  expected: DriftingAgentWriteReviewProvenance,
): boolean {
  const toolCallId = `agent-tool:${expected.sessionId}:${expected.turnId}:${expected.callId}`;
  return (
    review.effectId === effect.id &&
    review.sessionId === expected.sessionId &&
    review.turnId === expected.turnId &&
    review.toolCallId === toolCallId &&
    effect.sessionId === expected.sessionId &&
    effect.turnId === expected.turnId &&
    effect.toolCallId === toolCallId &&
    effect.callId === expected.callId &&
    effect.toolName === expected.toolName &&
    effect.phase === 'result_committed'
  );
}
