/**
 * Canonical persistence contracts for Agent write effects and their soft
 * review. They are provider-neutral and intentionally describe durable local
 * execution boundaries, not provider tool-call messages.
 */

export type AgentRuntimeWriteEffectPhase =
  | 'claimed'
  | 'confirmed'
  | 'mutation_started'
  | 'effect_committed'
  | 'result_committed'
  | 'uncertain'
  | 'failed'
  | 'declined';

export type AgentRuntimeWriteReversibility =
  | 'exact'
  | 'compensating'
  | 'irreversible'
  | 'unavailable';

export interface AgentRuntimeWriteRouteProvenance {
  projectId: string;
  routeKind: 'chat' | 'goal';
  conversationId: string | null;
  goalRunId: string | null;
  chapterId: string | null;
}

export interface PersistedAgentRuntimeWriteEffect
  extends AgentRuntimeWriteRouteProvenance {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  idempotencyKey: string;
  phase: AgentRuntimeWriteEffectPhase;
  arguments: unknown;
  expectedRevision: unknown | null;
  observedRevision: unknown | null;
  preimage: unknown | null;
  forward: unknown | null;
  inverse: unknown | null;
  reversibility: AgentRuntimeWriteReversibility | null;
  effect: unknown | null;
  result: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  claimedAt: string;
  confirmedAt: string | null;
  mutationStartedAt: string | null;
  effectCommittedAt: string | null;
  resultCommittedAt: string | null;
  uncertainAt: string | null;
  failedAt: string | null;
  declinedAt: string | null;
  updatedAt: string;
}

export interface ClaimAgentRuntimeWriteEffect
  extends AgentRuntimeWriteRouteProvenance {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  idempotencyKey: string;
  arguments: unknown;
  expectedRevision: unknown | null;
  claimedAt: string;
}

export type AgentRuntimeWriteEffectTransition =
  | {
      effectId: string;
      expectedPhase: 'claimed';
      nextPhase: 'confirmed';
      at: string;
    }
  | {
      effectId: string;
      expectedPhase: 'confirmed';
      nextPhase: 'mutation_started';
      at: string;
      observedRevision: unknown | null;
      preimage: unknown;
      forward: unknown;
      inverse: unknown | null;
      reversibility: AgentRuntimeWriteReversibility;
    }
  | {
      effectId: string;
      /**
       * `uncertain` may advance only after an entity-specific strategy proves
       * the already-entered mutation by an immutable durable receipt. This is
       * reconciliation, never permission to dispatch the write again.
       */
      expectedPhase: 'mutation_started' | 'uncertain';
      nextPhase: 'effect_committed';
      at: string;
      effect: unknown;
    }
  | {
      effectId: string;
      expectedPhase: 'effect_committed';
      nextPhase: 'result_committed';
      at: string;
      result: unknown;
    }
  | {
      effectId: string;
      expectedPhase: 'claimed' | 'confirmed' | 'mutation_started';
      nextPhase: 'failed';
      at: string;
      errorCode: string;
      errorMessage?: string | null;
    }
  | {
      effectId: string;
      expectedPhase: 'claimed' | 'confirmed';
      nextPhase: 'declined';
      at: string;
    }
  | {
      effectId: string;
      expectedPhase: 'mutation_started';
      nextPhase: 'uncertain';
      at: string;
      errorCode: string;
      errorMessage?: string | null;
    };

export type AgentRuntimeWriteReviewStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'accepted_effect'
  | 'revert_started'
  | 'reverted'
  | 'revert_failed'
  | 'revert_unavailable';

export interface PersistedAgentRuntimeWriteReview {
  id: string;
  effectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  status: AgentRuntimeWriteReviewStatus;
  decisionNote: unknown | null;
  revertEffect: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  revertStartedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

export interface CreateAgentRuntimeWriteReview {
  id: string;
  effectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  createdAt: string;
}

export type AgentRuntimeWriteReviewTransition =
  | {
      reviewId: string;
      expectedStatus: 'pending';
      nextStatus: 'accepted' | 'rejected';
      at: string;
      decisionNote?: unknown | null;
    }
  | {
      reviewId: string;
      expectedStatus: 'accepted';
      nextStatus: 'accepted_effect';
      at: string;
    }
  | {
      reviewId: string;
      expectedStatus: 'rejected';
      nextStatus: 'revert_started';
      at: string;
    }
  | {
      /** Retry a failed, receipt-backed inverse after its transient conflict clears. */
      reviewId: string;
      expectedStatus: 'revert_failed';
      nextStatus: 'revert_started';
      at: string;
    }
  | {
      reviewId: string;
      expectedStatus: 'rejected';
      nextStatus: 'revert_unavailable';
      at: string;
      errorCode: string;
      errorMessage?: string | null;
    }
  | {
      reviewId: string;
      expectedStatus: 'revert_started';
      nextStatus: 'reverted';
      at: string;
      revertEffect: unknown;
    }
  | {
      reviewId: string;
      expectedStatus: 'revert_started';
      nextStatus: 'revert_failed';
      at: string;
      errorCode: string;
      errorMessage?: string | null;
    };

export interface AgentRuntimeWritePersistenceSnapshot {
  effects: PersistedAgentRuntimeWriteEffect[];
  reviews: PersistedAgentRuntimeWriteReview[];
  /**
   * Canonical runtime turn ownership for context projection. Older in-memory
   * test doubles may omit it, but the SQLite repository always supplies it.
   */
  turnOrdinalsById?: Readonly<Record<string, number>>;
}
