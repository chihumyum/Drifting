/**
 * Canonical persistence contracts for Agent write effects and their settlement
 * receipts. New writes cross a provenance-bound authorization gate before an
 * effect may be claimed. Prose writes then create a settlement receipt after
 * their Yjs mutation commits. These contracts are provider-neutral and
 * describe durable local execution boundaries, not provider tool-call messages.
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

/** Immutable evidence that the central runtime authorized a write before any
 * renderer usecase, Yjs transaction, or authored journal mutation existed. */
export interface AgentRuntimeWriteAuthorization {
  kind: 'automatic' | 'author_approved';
  /** Present only when the author explicitly resolved a permission request. */
  requestId: string | null;
  /** SHA-256 of the exact provider-visible, schema-validated arguments. */
  argumentsHash: string;
  authorizedAt: string;
}

export interface AgentRuntimeWriteRouteProvenance {
  projectId: string;
  routeKind: 'chat';
  conversationId: string | null;
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
  /** NULL only for effects written before central authorization was introduced. */
  authorization: AgentRuntimeWriteAuthorization | null;
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
  authorization: AgentRuntimeWriteAuthorization;
  /** Provider-validated arguments recorded on the outer tool lifecycle row.
   * Runtime facades may persist a richer, deterministic command in
   * `arguments` while this preserves exact model-call provenance. */
  toolCallArguments?: unknown;
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

/**
 * Internal settlement receipt for a result-committed write. General Agent
 * writes commit directly, so a review only advances to `accepted_effect`; the
 * author-facing reject/revert states were retired by migration 0018.
 */
export type AgentRuntimeWriteReviewStatus =
  | 'pending'
  | 'accepted'
  | 'accepted_effect';

export interface PersistedAgentRuntimeWriteReview {
  id: string;
  effectId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  status: AgentRuntimeWriteReviewStatus;
  createdAt: string;
  acceptedAt: string | null;
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
  /** Exact immutable block order derived from the committed prose effect. */
  blocks?: readonly {
    blockId: string;
    ordinal: number;
  }[];
}

export type AgentRuntimeWriteReviewBlockStatus = 'pending' | 'accepted';

export interface PersistedAgentRuntimeWriteReviewBlock {
  reviewId: string;
  effectId: string;
  blockId: string;
  ordinal: number;
  status: AgentRuntimeWriteReviewBlockStatus;
  createdAt: string;
  settledAt: string | null;
  updatedAt: string;
}

export interface AgentRuntimeWriteReviewBlockTransition {
  reviewId: string;
  blockId: string;
  expectedStatus: 'pending';
  nextStatus: 'accepted';
  at: string;
}

export type AgentRuntimeWriteReviewTransition =
  | {
      reviewId: string;
      expectedStatus: 'pending';
      nextStatus: 'accepted';
      at: string;
    }
  | {
      reviewId: string;
      expectedStatus: 'accepted';
      nextStatus: 'accepted_effect';
      at: string;
    };

export interface AgentRuntimeWritePersistenceSnapshot {
  effects: PersistedAgentRuntimeWriteEffect[];
  reviews: PersistedAgentRuntimeWriteReview[];
  /**
   * Canonical runtime turn ownership for context projection. Older in-memory
   * test doubles may omit it, but the SQLite repository always supplies it.
   */
  turnOrdinalsById?: Readonly<Record<string, number>>;
  /**
   * Ordinals in canonical provider history. Failed/aborted turns have no model
   * messages, so their physical runtime ordinals cannot be used directly.
   */
  turnContextOrdinalsById?: Readonly<Record<string, number>>;
  /** Whether the turn's tool pair is present in canonical provider history. */
  turnHasCanonicalHistoryById?: Readonly<Record<string, boolean>>;
}
