/**
 * Durable, provider-neutral orchestration state for work that spans several
 * Agent turns, model-budget slices, or renderer restarts.
 *
 * Domain entity references stay name-first at the model boundary. A product
 * adapter may resolve a target name to a local id before persistence, but that
 * id is never required from the model.
 */

export type AgentRuntimeTaskStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'failed';

export type AgentRuntimeTaskStepStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  /**
   * The frozen target no longer belongs to the reconciled whole-book
   * manifest. It remains as durable audit history and is never silently
   * counted as authored work.
   */
  | 'retired';

export type AgentRuntimeTaskConstraintStatus = 'active' | 'superseded' | 'fulfilled';

export type AgentRuntimeTaskConstraintSource = 'author' | 'agent' | 'runtime';

/**
 * Explicit provider-visible planning boundary. Whole-book coverage must never
 * be inferred from free-form objective text.
 */
export type AgentRuntimeTaskScopeKind = 'explicit_targets' | 'whole_book_chapters';

/** Edit tasks prove accepted manuscript effects; review tasks prove exact reads. */
export type AgentRuntimeTaskWorkKind = 'edit' | 'review';

export type AgentRuntimeTaskTargetKind =
  | 'book'
  | 'project'
  | 'chapter'
  | 'drift'
  | 'element'
  | 'storyline'
  | 'category'
  | 'other';

export interface AgentRuntimeTaskScope {
  projectId: string;
  sessionId: string;
}

export interface PersistedAgentRuntimeTask extends AgentRuntimeTaskScope {
  id: string;
  objective: string;
  scopeKind: AgentRuntimeTaskScopeKind;
  workKind: AgentRuntimeTaskWorkKind;
  status: AgentRuntimeTaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface PersistedAgentRuntimeTaskChapterManifestEntry extends AgentRuntimeTaskScope {
  taskId: string;
  ordinal: number;
  name: string;
  /**
   * Renderer-owned frozen chapter identity. This never enters provider-facing
   * context; provider projections expose only ordinal + name.
   */
  resolvedChapterId: string;
}

export interface AgentRuntimeTaskTarget {
  kind: AgentRuntimeTaskTargetKind;
  name: string;
  /**
   * Renderer-owned identity resolved from (project, kind, name). This field is
   * persistence-only and must not be included in provider-facing tool input.
   */
  resolvedTargetId: string | null;
}

export interface PersistedAgentRuntimeTaskStep extends AgentRuntimeTaskScope {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  target: AgentRuntimeTaskTarget | null;
  status: AgentRuntimeTaskStepStatus;
  resultNote: string | null;
  resultRef: string | null;
  /**
   * Provider-safe durable review/effect projection resolved from resultRef.
   * This is derived on read, not copied from the bounded recent-review
   * context window.
   */
  reviewEvidence: AgentRuntimeTaskStepReviewEvidence | null;
  /** Structured semantic result supplied by the model and verified by Drifting. */
  reviewResult: AgentRuntimeTaskStepReviewResult | null;
  /** Product-owned exact-target read proof; never supplied as an opaque model id. */
  readEvidence: AgentRuntimeTaskStepReadEvidence | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type AgentRuntimeTaskReviewClaimKind =
  | 'event'
  | 'character_state'
  | 'canon'
  | 'voice'
  | 'timeline'
  | 'unresolved';

export type AgentRuntimeTaskReviewFindingKind =
  | 'canon'
  | 'continuity'
  | 'voice'
  | 'pov'
  | 'pacing'
  | 'logic'
  | 'other';

export interface AgentRuntimeTaskReviewCitation {
  /** Exact non-empty passage copied from the canonical target read. */
  quote: string;
  block?: number;
  path?: string;
}

export interface AgentRuntimeTaskReviewClaim {
  kind: AgentRuntimeTaskReviewClaimKind;
  text: string;
  citations: AgentRuntimeTaskReviewCitation[];
}

export interface AgentRuntimeTaskReviewFinding {
  kind: AgentRuntimeTaskReviewFindingKind;
  severity: 'info' | 'warning' | 'error';
  message: string;
  citations: AgentRuntimeTaskReviewCitation[];
}

export interface AgentRuntimeTaskStepReviewResult {
  schemaVersion: 1;
  verdict: 'pass' | 'findings' | 'blocked';
  synopsis: string;
  claims: AgentRuntimeTaskReviewClaim[];
  findings: AgentRuntimeTaskReviewFinding[];
}

export interface AgentRuntimeTaskStepReadEvidence {
  receiptId: string;
  toolName: string;
  observedAt: string;
  exactTargetEvidence: boolean;
  citationCount: number;
}

export interface AgentRuntimeTaskStepReviewEvidence {
  reviewStatus:
    | 'authorized_effect'
    | 'pending'
    | 'accepted'
    | 'rejected'
    | 'accepted_effect'
    | 'revert_started'
    | 'reverted'
    | 'revert_failed'
    | 'revert_unavailable'
    | 'missing';
  outcome: 'pending' | 'accepted_target_write' | 'rejected_or_reverted' | 'invalid';
  acceptedTargetEvidence: boolean;
  toolName: string | null;
  settledAt: string | null;
}

export interface PersistedAgentRuntimeTaskConstraint extends AgentRuntimeTaskScope {
  id: string;
  taskId: string;
  body: string;
  source: AgentRuntimeTaskConstraintSource;
  status: AgentRuntimeTaskConstraintStatus;
  supersededById: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface AgentRuntimeTaskPlan {
  task: PersistedAgentRuntimeTask;
  chapterManifest: PersistedAgentRuntimeTaskChapterManifestEntry[];
  steps: PersistedAgentRuntimeTaskStep[];
  constraints: PersistedAgentRuntimeTaskConstraint[];
}

export interface AgentRuntimeTaskChapterManifestSeed {
  ordinal: number;
  name: string;
  resolvedChapterId: string;
}

export interface AgentRuntimeTaskChapterManifestRename {
  resolvedChapterId: string;
  frozenName: string;
  currentName: string;
}

export interface AgentRuntimeTaskChapterManifestMove {
  resolvedChapterId: string;
  name: string;
  frozenOrdinal: number;
  currentOrdinal: number;
}

/**
 * Transaction-derived comparison between the persisted whole-book snapshot
 * and the current active SQLite chapter order. Internal ids never enter the
 * provider projection, but they are required to distinguish rename/reorder
 * from delete-and-create.
 */
export interface AgentRuntimeTaskChapterManifestState {
  status: 'not_applicable' | 'current' | 'drifted';
  frozenCount: number;
  currentCount: number;
  current: AgentRuntimeTaskChapterManifestSeed[];
  added: AgentRuntimeTaskChapterManifestSeed[];
  missing: PersistedAgentRuntimeTaskChapterManifestEntry[];
  renamed: AgentRuntimeTaskChapterManifestRename[];
  reordered: AgentRuntimeTaskChapterManifestMove[];
}

export interface AgentRuntimeTaskManifestReconciliationResult {
  addedStepIds: string[];
  retiredStepIds: string[];
  reopenedStepIds: string[];
  retainedCompletedStepIds: string[];
  renamedChapterCount: number;
  reorderedChapterCount: number;
}

export interface AgentRuntimeTaskStepSeed {
  title: string;
  target: AgentRuntimeTaskTarget | null;
}

export interface AgentRuntimeTaskConstraintSeed {
  body: string;
  source: AgentRuntimeTaskConstraintSource;
}

export interface AgentRuntimeTaskCommandProvenance extends AgentRuntimeTaskScope {
  turnId: string;
  callId: string;
  toolCallId: string;
  idempotencyKey: string;
  createdAt: string;
}

export type AgentRuntimeTaskPlanCommand =
  | {
      toolName: 'update_task_plan';
      operation: 'create';
      objective: string;
      scopeKind: AgentRuntimeTaskScopeKind;
      /** Defaults to edit for old callers; new providers must choose explicitly. */
      workKind?: AgentRuntimeTaskWorkKind;
      /**
       * Product-owned snapshot captured at command construction time. It is
       * deliberately absent from provider tool input.
       */
      chapterManifest: AgentRuntimeTaskChapterManifestSeed[];
      steps: AgentRuntimeTaskStepSeed[];
      constraints: AgentRuntimeTaskConstraintSeed[];
    }
  | {
      toolName: 'update_task_plan';
      operation: 'append_steps';
      taskId: string;
      expectedRevision: number;
      steps: AgentRuntimeTaskStepSeed[];
    }
  | {
      toolName: 'update_task_plan';
      operation: 'set_objective';
      taskId: string;
      expectedRevision: number;
      objective: string;
    }
  | {
      toolName: 'update_task_plan';
      operation: 'reconcile_manifest';
      taskId: string;
      expectedRevision: number;
    }
  | {
      toolName: 'update_task_plan';
      operation: 'set_status';
      taskId: string;
      expectedRevision: number;
      status: AgentRuntimeTaskStatus;
    };

export interface AgentRuntimeTaskStepCommand {
  toolName: 'update_task_step';
  taskId: string;
  expectedRevision: number;
  stepId: string;
  status: AgentRuntimeTaskStepStatus;
  resultNote: string | null;
  resultRef: string | null;
  reviewResult?: AgentRuntimeTaskStepReviewResult | null;
}

export type AgentRuntimeTaskConstraintCommand =
  | {
      toolName: 'update_task_constraint';
      operation: 'add';
      taskId: string;
      expectedRevision: number;
      body: string;
      source: AgentRuntimeTaskConstraintSource;
    }
  | {
      toolName: 'update_task_constraint';
      operation: 'fulfill';
      taskId: string;
      expectedRevision: number;
      constraintId: string;
    }
  | {
      toolName: 'update_task_constraint';
      operation: 'supersede';
      taskId: string;
      expectedRevision: number;
      constraintId: string;
      replacementBody: string;
      replacementSource: AgentRuntimeTaskConstraintSource;
    };

export type AgentRuntimeTaskCommand =
  | AgentRuntimeTaskPlanCommand
  | AgentRuntimeTaskStepCommand
  | AgentRuntimeTaskConstraintCommand;

export interface AgentRuntimeTaskCommandResult {
  outcome: 'inserted' | 'duplicate';
  plan: AgentRuntimeTaskPlan;
  changedStepId?: string;
  changedConstraintId?: string;
  manifestReconciliation?: AgentRuntimeTaskManifestReconciliationResult;
}

const TASK_TRANSITIONS: Record<AgentRuntimeTaskStatus, ReadonlySet<AgentRuntimeTaskStatus>> = {
  active: new Set(['active', 'paused', 'blocked', 'completed', 'failed']),
  paused: new Set(['paused', 'active', 'blocked', 'failed']),
  blocked: new Set(['blocked', 'active', 'paused', 'failed']),
  completed: new Set(['completed']),
  failed: new Set(['failed']),
};

const STEP_TRANSITIONS: Record<
  AgentRuntimeTaskStepStatus,
  ReadonlySet<AgentRuntimeTaskStepStatus>
> = {
  // A planned unit cannot be declared complete without first entering the
  // execution/review path. It may still fail or block during preflight.
  pending: new Set(['pending', 'in_progress', 'blocked', 'failed']),
  in_progress: new Set(['in_progress', 'blocked', 'completed', 'failed']),
  blocked: new Set(['blocked', 'pending', 'in_progress', 'completed', 'failed']),
  completed: new Set(['completed']),
  failed: new Set(['failed']),
  retired: new Set(['retired']),
};

export function canTransitionAgentRuntimeTask(
  current: AgentRuntimeTaskStatus,
  next: AgentRuntimeTaskStatus,
): boolean {
  return TASK_TRANSITIONS[current].has(next);
}

export function canTransitionAgentRuntimeTaskStep(
  current: AgentRuntimeTaskStepStatus,
  next: AgentRuntimeTaskStepStatus,
): boolean {
  return STEP_TRANSITIONS[current].has(next);
}

export function isOpenAgentRuntimeTaskStatus(status: AgentRuntimeTaskStatus): boolean {
  return status === 'active' || status === 'paused' || status === 'blocked';
}

export function isTerminalAgentRuntimeTaskStepStatus(status: AgentRuntimeTaskStepStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'retired';
}
