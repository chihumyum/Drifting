import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import type {
  AgentRuntimeTaskCommand,
  AgentRuntimeTaskCommandProvenance,
  AgentRuntimeTaskCommandResult,
  AgentRuntimeTaskConstraintSource,
  AgentRuntimeTaskConstraintStatus,
  AgentRuntimeTaskPlan,
  AgentRuntimeTaskScope,
  AgentRuntimeTaskScopeKind,
  AgentRuntimeTaskStepReviewEvidence,
  AgentRuntimeTaskStatus,
  AgentRuntimeTaskStepStatus,
  AgentRuntimeTaskTargetKind,
  PersistedAgentRuntimeTask,
  PersistedAgentRuntimeTaskChapterManifestEntry,
  PersistedAgentRuntimeTaskConstraint,
  PersistedAgentRuntimeTaskStep,
} from '../domain/agent-runtime-long-task';
import {
  canTransitionAgentRuntimeTask,
  canTransitionAgentRuntimeTaskStep,
  isOpenAgentRuntimeTaskStatus,
} from '../domain/agent-runtime-long-task';
import { getDb, type DbExecutor } from '../lib/db';
import {
  AgentRuntimeTurnTable,
  AgentRuntimeTaskCommandTable,
  AgentRuntimeTaskChapterManifestTable,
  AgentRuntimeTaskConstraintTable,
  AgentRuntimeTaskStepTable,
  AgentRuntimeTaskTable,
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteReviewTable,
} from '../schema/drizzle';
import { canonicalAgentRuntimeJson } from './agent-runtime-persistence-repo';

export class AgentRuntimeLongTaskConflictError extends Error {
  constructor(
    readonly code:
      | 'COMMAND_CONFLICT'
      | 'TASK_SCOPE_MISMATCH'
      | 'TASK_ALREADY_ACTIVE'
      | 'TASK_NOT_FOUND'
      | 'TASK_REVISION_CONFLICT'
      | 'INVALID_TASK_TRANSITION'
      | 'INVALID_STEP_TRANSITION'
      | 'INVALID_CONSTRAINT_TRANSITION'
      | 'TASK_WRITE_EVIDENCE_INVALID'
      | 'TASK_PLAN_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeLongTaskConflictError';
  }
}

export interface AgentRuntimeLongTaskCommandEvidence {
  taskId: string;
  turnOrdinal: number;
  callId: string;
  toolName: string;
}

export interface AgentRuntimeLongTaskRepository {
  getPlan(scope: AgentRuntimeTaskScope, taskId: string): Promise<AgentRuntimeTaskPlan | null>;
  getOpenPlan(scope: AgentRuntimeTaskScope): Promise<AgentRuntimeTaskPlan | null>;
  getLatestPlan(scope: AgentRuntimeTaskScope): Promise<AgentRuntimeTaskPlan | null>;
  listCommandEvidence(
    scope: AgentRuntimeTaskScope,
    taskId: string,
  ): Promise<AgentRuntimeLongTaskCommandEvidence[]>;
  applyCommand(
    provenance: AgentRuntimeTaskCommandProvenance,
    command: AgentRuntimeTaskCommand,
  ): Promise<AgentRuntimeTaskCommandResult>;
}

export interface AgentRuntimeLongTaskRepositoryOptions {
  now?: () => string;
  createId?: (kind: 'task' | 'step' | 'constraint') => string;
}

function defaultId(kind: 'task' | 'step' | 'constraint'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_PLAN_INVALID',
      'Web Crypto randomUUID is unavailable; a durable task id cannot be allocated.',
    );
  }
  return `agent-${kind}:${uuid}`;
}

function taskToDomain(row: typeof AgentRuntimeTaskTable.$inferSelect): PersistedAgentRuntimeTask {
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    objective: row.objective,
    scopeKind: row.scopeKind as AgentRuntimeTaskScopeKind,
    status: row.status as AgentRuntimeTaskStatus,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt ?? null,
  };
}

function chapterManifestEntryToDomain(
  row: typeof AgentRuntimeTaskChapterManifestTable.$inferSelect,
): PersistedAgentRuntimeTaskChapterManifestEntry {
  return {
    taskId: row.taskId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    ordinal: row.ordinal,
    name: row.name,
    resolvedChapterId: row.resolvedChapterId,
  };
}

function stepToDomain(
  row: typeof AgentRuntimeTaskStepTable.$inferSelect,
): PersistedAgentRuntimeTaskStep {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    ordinal: row.ordinal,
    title: row.title,
    target:
      row.targetKind && row.targetName
        ? {
            kind: row.targetKind as AgentRuntimeTaskTargetKind,
            name: row.targetName,
            resolvedTargetId: row.resolvedTargetId ?? null,
          }
        : null,
    status: row.status as AgentRuntimeTaskStepStatus,
    resultNote: row.resultNote ?? null,
    resultRef: row.resultRef ?? null,
    reviewEvidence: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

function constraintToDomain(
  row: typeof AgentRuntimeTaskConstraintTable.$inferSelect,
): PersistedAgentRuntimeTaskConstraint {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    body: row.body,
    source: row.source as AgentRuntimeTaskConstraintSource,
    status: row.status as AgentRuntimeTaskConstraintStatus,
    supersededById: row.supersededById ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settledAt: row.settledAt ?? null,
  };
}

function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AgentRuntimeLongTaskConflictError('TASK_PLAN_INVALID', `${label} must not be blank.`);
  }
  return normalized;
}

function requireExpectedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_PLAN_INVALID',
      'Task expectedRevision must be a non-negative safe integer.',
    );
  }
  return value;
}

function stableTaskText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function stableTaskStepKeys(step: {
  title: string;
  target: {
    kind: AgentRuntimeTaskTargetKind;
    name: string;
    resolvedTargetId?: string | null;
  } | null;
}): string[] {
  if (step.target) {
    return [
      `target:${step.target.kind}:name:${stableTaskText(step.target.name)}`,
      ...(step.target.resolvedTargetId?.trim()
        ? [`target:${step.target.kind}:id:${stableTaskText(step.target.resolvedTargetId)}`]
        : []),
    ];
  }
  return [`title:${stableTaskText(step.title)}`];
}

function assertFrozenChapterManifestCoverage(input: {
  scopeKind: AgentRuntimeTaskScopeKind;
  chapterManifest: readonly {
    ordinal: number;
    name: string;
    resolvedChapterId: string;
  }[];
  steps: readonly {
    target: {
      kind: AgentRuntimeTaskTargetKind;
      name: string;
      resolvedTargetId?: string | null;
    } | null;
  }[];
}): void {
  if (input.scopeKind === 'explicit_targets') {
    if (input.chapterManifest.length > 0) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'An explicit-target task cannot persist a whole-book chapter manifest.',
      );
    }
    return;
  }
  if (input.chapterManifest.length === 0) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_PLAN_INVALID',
      'A whole-book task requires a non-empty frozen chapter manifest.',
    );
  }
  if (input.steps.length !== input.chapterManifest.length) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_PLAN_INVALID',
      'A whole-book task must contain exactly one step for every frozen chapter.',
    );
  }
  const chapterIds = new Set<string>();
  for (let index = 0; index < input.chapterManifest.length; index += 1) {
    const chapter = input.chapterManifest[index]!;
    const step = input.steps[index]!;
    if (
      chapter.ordinal !== index ||
      !Number.isSafeInteger(chapter.ordinal) ||
      !requireNonBlank(chapter.name, `chapterManifest[${index}].name`) ||
      !requireNonBlank(
        chapter.resolvedChapterId,
        `chapterManifest[${index}].resolvedChapterId`,
      )
    ) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'The frozen whole-book chapter manifest must use contiguous stable ordinals.',
      );
    }
    if (chapterIds.has(chapter.resolvedChapterId)) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'The frozen whole-book chapter manifest contains a duplicate chapter.',
      );
    }
    chapterIds.add(chapter.resolvedChapterId);
    if (
      step.target?.kind !== 'chapter' ||
      step.target.resolvedTargetId !== chapter.resolvedChapterId ||
      stableTaskText(step.target.name) !== stableTaskText(chapter.name)
    ) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        `Whole-book step ${index} does not match its frozen manifest chapter.`,
      );
    }
  }
}

function writeArguments(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function acceptedWriteMatchesStepTarget(input: {
  step: PersistedAgentRuntimeTaskStep;
  effectChapterId: string | null;
  effectArgumentsJson: string;
  effectForwardJson: string | null;
  effectResultJson: string;
}): boolean {
  const target = input.step.target;
  if (!target) return false;
  const expected = new Set(
    [target.name, target.resolvedTargetId]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(stableTaskText),
  );
  if (input.effectChapterId && expected.has(stableTaskText(input.effectChapterId))) {
    return true;
  }
  const forward = input.effectForwardJson
    ? writeArguments(input.effectForwardJson)
    : null;
  if (forward) {
    const entityKind =
      typeof forward.entityKind === 'string'
        ? stableTaskText(forward.entityKind)
        : null;
    const expectedKind = stableTaskText(target.kind);
    const canonicalTargets: Array<{ kind: string | null; id: unknown }> = [
      { kind: entityKind, id: forward.entityId },
      {
        kind:
          target.kind === 'chapter' || target.kind === 'drift'
            ? expectedKind
            : null,
        id: forward.nodeId,
      },
      { kind: 'chapter', id: forward.chapterId },
    ];
    if (
      canonicalTargets.some(
        (candidate) =>
          typeof candidate.id === 'string' &&
          (candidate.kind === null || candidate.kind === expectedKind) &&
          expected.has(stableTaskText(candidate.id)),
      )
    ) {
      return true;
    }
  }
  const result = writeArguments(input.effectResultJson);
  if (
    result &&
    ['nodeId', 'chapterId', 'entityId'].some((field) => {
      const value = result[field];
      return (
        typeof value === 'string' &&
        expected.has(stableTaskText(value))
      );
    })
  ) {
    return true;
  }
  const arguments_ = writeArguments(input.effectArgumentsJson);
  if (!arguments_) return false;
  const fields: Record<AgentRuntimeTaskTargetKind, readonly string[]> = {
    book: ['book', 'entity', 'target'],
    project: ['project', 'entity', 'target'],
    chapter: ['node', 'chapter', 'entity', 'target'],
    drift: ['node', 'entity', 'target'],
    element: ['element', 'entity', 'target'],
    storyline: ['storyline', 'entity', 'target'],
    other: ['entity', 'target'],
  };
  return fields[target.kind].some((field) => {
    const value = arguments_[field];
    return typeof value === 'string' && expected.has(stableTaskText(value));
  });
}

const WHOLE_BOOK_PROSE_MUTATION_TOOLS = new Set([
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
]);

interface DurableTaskStepReviewRow {
  reviewId: string;
  reviewStatus: string;
  reviewSessionId: string;
  reviewTurnId: string;
  reviewToolCallId: string;
  reviewCreatedAt: string;
  reviewUpdatedAt: string;
  reviewSettledAt: string | null;
  effectPhase: string;
  effectProjectId: string;
  effectSessionId: string;
  effectTurnId: string;
  effectToolCallId: string;
  effectToolName: string;
  effectChapterId: string | null;
  effectArgumentsJson: string;
  effectForwardJson: string | null;
  effectResultJson: string | null;
  effectResultCommittedAt: string | null;
}

const TASK_STEP_REVIEW_STATUSES = new Set([
  'pending',
  'accepted',
  'rejected',
  'accepted_effect',
  'revert_started',
  'reverted',
  'revert_failed',
  'revert_unavailable',
]);

function evaluateTaskStepReviewEvidence(input: {
  scope: AgentRuntimeTaskScope;
  scopeKind: AgentRuntimeTaskScopeKind;
  step: PersistedAgentRuntimeTaskStep;
  evidence: DurableTaskStepReviewRow | undefined;
}): AgentRuntimeTaskStepReviewEvidence | null {
  if (!input.step.resultRef) return null;
  const evidence = input.evidence;
  if (!evidence) {
    return {
      reviewStatus: 'missing',
      outcome: 'invalid',
      acceptedTargetEvidence: false,
      toolName: null,
      settledAt: null,
    };
  }
  const reviewStatus = TASK_STEP_REVIEW_STATUSES.has(evidence.reviewStatus)
    ? (evidence.reviewStatus as Exclude<
        AgentRuntimeTaskStepReviewEvidence['reviewStatus'],
        'missing'
      >)
    : 'missing';
  const startedAt = input.step.startedAt;
  const provenanceValid =
    evidence.reviewId === input.step.resultRef &&
    evidence.reviewSessionId === input.scope.sessionId &&
    evidence.effectProjectId === input.scope.projectId &&
    evidence.effectSessionId === input.scope.sessionId &&
    evidence.reviewTurnId === evidence.effectTurnId &&
    evidence.reviewToolCallId === evidence.effectToolCallId &&
    evidence.effectPhase === 'result_committed' &&
    evidence.effectResultJson !== null &&
    evidence.effectResultCommittedAt !== null &&
    startedAt !== null &&
    evidence.effectResultCommittedAt >= startedAt &&
    evidence.reviewCreatedAt >= startedAt &&
    evidence.reviewUpdatedAt >= startedAt &&
    (evidence.reviewSettledAt === null ||
      evidence.reviewSettledAt >= startedAt) &&
    (input.scopeKind !== 'whole_book_chapters' ||
      WHOLE_BOOK_PROSE_MUTATION_TOOLS.has(evidence.effectToolName)) &&
    acceptedWriteMatchesStepTarget({
      step: input.step,
      effectChapterId: evidence.effectChapterId,
      effectArgumentsJson: evidence.effectArgumentsJson,
      effectForwardJson: evidence.effectForwardJson,
      effectResultJson: evidence.effectResultJson ?? '{}',
    });
  const acceptedTargetEvidence =
    provenanceValid &&
    reviewStatus === 'accepted_effect' &&
    evidence.reviewSettledAt !== null &&
    startedAt !== null &&
    evidence.reviewSettledAt >= startedAt;
  let outcome: AgentRuntimeTaskStepReviewEvidence['outcome'];
  if (!provenanceValid || reviewStatus === 'missing') {
    outcome = 'invalid';
  } else if (acceptedTargetEvidence) {
    outcome = 'accepted_target_write';
  } else if (
    reviewStatus === 'rejected' ||
    reviewStatus === 'revert_started' ||
    reviewStatus === 'reverted' ||
    reviewStatus === 'revert_failed' ||
    reviewStatus === 'revert_unavailable'
  ) {
    outcome = 'rejected_or_reverted';
  } else {
    outcome = 'pending';
  }
  return {
    reviewStatus,
    outcome,
    acceptedTargetEvidence,
    toolName: evidence.effectToolName,
    settledAt: evidence.reviewSettledAt,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function commandHashShape(command: AgentRuntimeTaskCommand): unknown {
  if (command.toolName === 'update_task_plan' && command.operation === 'create') {
    if (
      command.scopeKind === 'whole_book_chapters'
    ) {
      return {
        toolName: command.toolName,
        operation: command.operation,
        objective: command.objective,
        scopeKind: command.scopeKind,
        constraints: command.constraints,
      };
    }
    return {
      toolName: command.toolName,
      operation: command.operation,
      objective: command.objective,
      scopeKind: command.scopeKind,
      steps: command.steps.map((step) => ({
        title: step.title,
        target: step.target
          ? {
              kind: step.target.kind,
              name: step.target.name,
            }
          : null,
      })),
      constraints: command.constraints,
    };
  }
  if (
    command.toolName === 'update_task_plan' &&
    command.operation === 'append_steps'
  ) {
    return {
      ...command,
      steps: command.steps.map((step) => ({
        title: step.title,
        target: step.target
          ? {
              kind: step.target.kind,
              name: step.target.name,
            }
          : null,
      })),
    };
  }
  return command;
}

async function hashCommand(command: AgentRuntimeTaskCommand): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_PLAN_INVALID',
      'Web Crypto SHA-256 is unavailable; task command idempotency cannot be verified.',
    );
  }
  const bytes = new TextEncoder().encode(canonicalAgentRuntimeJson(commandHashShape(command)));
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function assertScope(expected: AgentRuntimeTaskScope, actual: AgentRuntimeTaskScope): void {
  if (expected.projectId !== actual.projectId || expected.sessionId !== actual.sessionId) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_SCOPE_MISMATCH',
      'Agent task belongs to a different project or runtime session.',
    );
  }
}

function taskIdForCommand(command: AgentRuntimeTaskCommand): string | null {
  return command.toolName === 'update_task_plan' && command.operation === 'create'
    ? null
    : command.taskId;
}

function parseStoredResult(json: string): AgentRuntimeTaskCommandResult {
  const value = JSON.parse(json) as AgentRuntimeTaskCommandResult;
  if (!value || typeof value !== 'object' || !value.plan || !value.plan.task) {
    throw new AgentRuntimeLongTaskConflictError(
      'COMMAND_CONFLICT',
      'Durable task command result is corrupt.',
    );
  }
  return value;
}

export function createAgentRuntimeLongTaskRepository(
  dbOverride?: DbExecutor,
  options: AgentRuntimeLongTaskRepositoryOptions = {},
): AgentRuntimeLongTaskRepository {
  const dbProvider = (): DbExecutor => dbOverride ?? getDb();
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? defaultId;

  const loadReviewEvidenceRows = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    reviewIds: readonly string[],
  ): Promise<DurableTaskStepReviewRow[]> => {
    if (reviewIds.length === 0) return [];
    const uniqueIds = [...new Set(reviewIds)];
    const rows: DurableTaskStepReviewRow[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 400) {
      const batch = uniqueIds.slice(offset, offset + 400);
      rows.push(
        ...(await executor
          .select({
            reviewId: AgentRuntimeWriteReviewTable.id,
            reviewStatus: AgentRuntimeWriteReviewTable.status,
            reviewSessionId: AgentRuntimeWriteReviewTable.sessionId,
            reviewTurnId: AgentRuntimeWriteReviewTable.turnId,
            reviewToolCallId:
              AgentRuntimeWriteReviewTable.toolCallId,
            reviewCreatedAt: AgentRuntimeWriteReviewTable.createdAt,
            reviewUpdatedAt: AgentRuntimeWriteReviewTable.updatedAt,
            reviewSettledAt: AgentRuntimeWriteReviewTable.settledAt,
            effectPhase: AgentRuntimeWriteEffectTable.phase,
            effectProjectId: AgentRuntimeWriteEffectTable.projectId,
            effectSessionId: AgentRuntimeWriteEffectTable.sessionId,
            effectTurnId: AgentRuntimeWriteEffectTable.turnId,
            effectToolCallId:
              AgentRuntimeWriteEffectTable.toolCallId,
            effectToolName: AgentRuntimeWriteEffectTable.toolName,
            effectChapterId: AgentRuntimeWriteEffectTable.chapterId,
            effectArgumentsJson:
              AgentRuntimeWriteEffectTable.argumentsJson,
            effectForwardJson:
              AgentRuntimeWriteEffectTable.forwardJson,
            effectResultJson: AgentRuntimeWriteEffectTable.resultJson,
            effectResultCommittedAt:
              AgentRuntimeWriteEffectTable.resultCommittedAt,
          })
          .from(AgentRuntimeWriteReviewTable)
          .innerJoin(
            AgentRuntimeWriteEffectTable,
            eq(
              AgentRuntimeWriteEffectTable.id,
              AgentRuntimeWriteReviewTable.effectId,
            ),
          )
          .where(
            and(
              inArray(AgentRuntimeWriteReviewTable.id, batch),
              eq(
                AgentRuntimeWriteReviewTable.sessionId,
                scope.sessionId,
              ),
              eq(
                AgentRuntimeWriteEffectTable.projectId,
                scope.projectId,
              ),
              eq(
                AgentRuntimeWriteEffectTable.sessionId,
                scope.sessionId,
              ),
            ),
          )),
      );
    }
    return rows;
  };

  const loadPlan = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    taskId: string,
  ): Promise<AgentRuntimeTaskPlan | null> => {
    const taskRows = await executor
      .select()
      .from(AgentRuntimeTaskTable)
      .where(
        and(
          eq(AgentRuntimeTaskTable.id, taskId),
          eq(AgentRuntimeTaskTable.projectId, scope.projectId),
          eq(AgentRuntimeTaskTable.sessionId, scope.sessionId),
        ),
      )
      .limit(1);
    const taskRow = taskRows[0];
    if (!taskRow) return null;
    const [chapterManifest, steps, constraints] = await Promise.all([
      executor
        .select()
        .from(AgentRuntimeTaskChapterManifestTable)
        .where(
          and(
            eq(AgentRuntimeTaskChapterManifestTable.taskId, taskId),
            eq(AgentRuntimeTaskChapterManifestTable.projectId, scope.projectId),
            eq(AgentRuntimeTaskChapterManifestTable.sessionId, scope.sessionId),
          ),
        )
        .orderBy(asc(AgentRuntimeTaskChapterManifestTable.ordinal)),
      executor
        .select()
        .from(AgentRuntimeTaskStepTable)
        .where(
          and(
            eq(AgentRuntimeTaskStepTable.taskId, taskId),
            eq(AgentRuntimeTaskStepTable.projectId, scope.projectId),
            eq(AgentRuntimeTaskStepTable.sessionId, scope.sessionId),
          ),
        )
        .orderBy(asc(AgentRuntimeTaskStepTable.ordinal)),
      executor
        .select()
        .from(AgentRuntimeTaskConstraintTable)
        .where(
          and(
            eq(AgentRuntimeTaskConstraintTable.taskId, taskId),
            eq(AgentRuntimeTaskConstraintTable.projectId, scope.projectId),
            eq(AgentRuntimeTaskConstraintTable.sessionId, scope.sessionId),
          ),
        )
        .orderBy(
          asc(AgentRuntimeTaskConstraintTable.createdAt),
          asc(AgentRuntimeTaskConstraintTable.id),
        ),
    ]);
    const task = taskToDomain(taskRow);
    const domainSteps = steps.map(stepToDomain);
    const reviewEvidenceRows = await loadReviewEvidenceRows(
      executor,
      scope,
      domainSteps
        .map((step) => step.resultRef)
        .filter((value): value is string => value !== null),
    );
    const reviewEvidenceById = new Map(
      reviewEvidenceRows.map((evidence) => [
        evidence.reviewId,
        evidence,
      ]),
    );
    return {
      task,
      chapterManifest: chapterManifest.map(chapterManifestEntryToDomain),
      steps: domainSteps.map((step) => ({
        ...step,
        reviewEvidence: evaluateTaskStepReviewEvidence({
          scope,
          scopeKind: task.scopeKind,
          step,
          evidence: step.resultRef
            ? reviewEvidenceById.get(step.resultRef)
            : undefined,
        }),
      })),
      constraints: constraints.map(constraintToDomain),
    };
  };

  const requirePlan = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    taskId: string,
  ): Promise<AgentRuntimeTaskPlan> => {
    const plan = await loadPlan(executor, scope, taskId);
    if (!plan) {
      const anyScope = await executor
        .select({
          projectId: AgentRuntimeTaskTable.projectId,
          sessionId: AgentRuntimeTaskTable.sessionId,
        })
        .from(AgentRuntimeTaskTable)
        .where(eq(AgentRuntimeTaskTable.id, taskId))
        .limit(1);
      throw new AgentRuntimeLongTaskConflictError(
        anyScope[0] ? 'TASK_SCOPE_MISMATCH' : 'TASK_NOT_FOUND',
        anyScope[0]
          ? 'Agent task belongs to a different project or runtime session.'
          : `Agent task "${taskId}" does not exist.`,
      );
    }
    return plan;
  };

  const assertMutableRevision = (plan: AgentRuntimeTaskPlan, expectedRevision: number): void => {
    requireExpectedRevision(expectedRevision);
    if (plan.task.revision !== expectedRevision) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_REVISION_CONFLICT',
        `Task revision changed: expected ${expectedRevision}, current ${plan.task.revision}.`,
      );
    }
    if (!isOpenAgentRuntimeTaskStatus(plan.task.status)) {
      throw new AgentRuntimeLongTaskConflictError(
        'INVALID_TASK_TRANSITION',
        `Terminal task "${plan.task.id}" cannot be mutated.`,
      );
    }
  };

  const assertAcceptedWriteEvidence = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    scopeKind: AgentRuntimeTaskScopeKind,
    step: PersistedAgentRuntimeTaskStep,
    resultRef: string | null,
  ): Promise<void> => {
    if (!resultRef || !step.target) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_WRITE_EVIDENCE_INVALID',
        'A completed task step requires its target and an accepted durable write-review id in resultRef.',
      );
    }
    const evidenceRows = await loadReviewEvidenceRows(
      executor,
      scope,
      [resultRef],
    );
    const evidence = evidenceRows[0];
    const reviewEvidence = evaluateTaskStepReviewEvidence({
      scope,
      scopeKind,
      step: { ...step, resultRef },
      evidence,
    });
    if (!reviewEvidence?.acceptedTargetEvidence) {
      if (reviewEvidence?.outcome === 'pending') {
        throw new AgentRuntimeLongTaskConflictError(
          'TASK_WRITE_EVIDENCE_INVALID',
          `Review "${resultRef}" is still pending. Do not retry completion; call update_task_step with status="blocked", the same taskId/stepId/resultRef, and the current expectedRevision.`,
        );
      }
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_WRITE_EVIDENCE_INVALID',
        `Task step "${step.id}" cannot complete without an accepted durable write for its exact target.`,
      );
    }
  };

  const bumpRevision = async (
    executor: DbExecutor,
    taskId: string,
    expectedRevision: number,
    updatedAt: string,
    values: Partial<typeof AgentRuntimeTaskTable.$inferInsert> = {},
  ): Promise<void> => {
    await executor
      .update(AgentRuntimeTaskTable)
      .set({
        ...values,
        revision: expectedRevision + 1,
        updatedAt,
      })
      .where(
        and(
          eq(AgentRuntimeTaskTable.id, taskId),
          eq(AgentRuntimeTaskTable.revision, expectedRevision),
        ),
      );
  };

  const insertSteps = async (
    executor: DbExecutor,
    plan: {
      taskId: string;
      scope: AgentRuntimeTaskScope;
      firstOrdinal: number;
      createdAt: string;
    },
    seeds: Extract<
      AgentRuntimeTaskCommand,
      { toolName: 'update_task_plan'; operation: 'create' | 'append_steps' }
    >['steps'],
  ): Promise<void> => {
    if (seeds.length === 0) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'A task-plan step batch must contain at least one step.',
      );
    }
    if (seeds.some((seed) => !seed.target)) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'Every task step requires a named write target.',
      );
    }
    const rows = seeds.map((seed, index) => ({
      id: createId('step'),
      taskId: plan.taskId,
      projectId: plan.scope.projectId,
      sessionId: plan.scope.sessionId,
      ordinal: plan.firstOrdinal + index,
      title: requireNonBlank(seed.title, `steps[${index}].title`),
      targetKind: seed.target?.kind ?? null,
      targetName: seed.target
        ? requireNonBlank(seed.target.name, `steps[${index}].target.name`)
        : null,
      resolvedTargetId: seed.target?.resolvedTargetId ?? null,
      status: 'pending',
      resultNote: null,
      resultRef: null,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      startedAt: null,
      completedAt: null,
    }));
    await executor.insert(AgentRuntimeTaskStepTable).values(rows);
  };

  const insertChapterManifest = async (
    executor: DbExecutor,
    plan: {
      taskId: string;
      scope: AgentRuntimeTaskScope;
    },
    manifest: readonly {
      ordinal: number;
      name: string;
      resolvedChapterId: string;
    }[],
  ): Promise<void> => {
    if (manifest.length === 0) return;
    await executor.insert(AgentRuntimeTaskChapterManifestTable).values(
      manifest.map((chapter) => ({
        taskId: plan.taskId,
        projectId: plan.scope.projectId,
        sessionId: plan.scope.sessionId,
        ordinal: chapter.ordinal,
        name: requireNonBlank(
          chapter.name,
          `chapterManifest[${chapter.ordinal}].name`,
        ),
        resolvedChapterId: requireNonBlank(
          chapter.resolvedChapterId,
          `chapterManifest[${chapter.ordinal}].resolvedChapterId`,
        ),
      })),
    );
  };

  const insertConstraints = async (
    executor: DbExecutor,
    plan: {
      taskId: string;
      scope: AgentRuntimeTaskScope;
      createdAt: string;
    },
    seeds: readonly {
      body: string;
      source: AgentRuntimeTaskConstraintSource;
    }[],
  ): Promise<string[]> => {
    if (seeds.length === 0) return [];
    const rows = seeds.map((seed, index) => ({
      id: createId('constraint'),
      taskId: plan.taskId,
      projectId: plan.scope.projectId,
      sessionId: plan.scope.sessionId,
      body: requireNonBlank(seed.body, `constraints[${index}].body`),
      source: seed.source,
      status: 'active',
      supersededById: null,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      settledAt: null,
    }));
    await executor.insert(AgentRuntimeTaskConstraintTable).values(rows);
    return rows.map((row) => row.id);
  };

  return {
    getPlan: (scope, taskId) => loadPlan(dbProvider(), scope, taskId),

    async getOpenPlan(scope) {
      const rows = await dbProvider()
        .select({ id: AgentRuntimeTaskTable.id })
        .from(AgentRuntimeTaskTable)
        .where(
          and(
            eq(AgentRuntimeTaskTable.projectId, scope.projectId),
            eq(AgentRuntimeTaskTable.sessionId, scope.sessionId),
            inArray(AgentRuntimeTaskTable.status, ['active', 'paused', 'blocked']),
          ),
        )
        .orderBy(desc(AgentRuntimeTaskTable.updatedAt))
        .limit(1);
      return rows[0] ? loadPlan(dbProvider(), scope, rows[0].id) : null;
    },

    async getLatestPlan(scope) {
      const rows = await dbProvider()
        .select({ id: AgentRuntimeTaskTable.id })
        .from(AgentRuntimeTaskTable)
        .where(
          and(
            eq(AgentRuntimeTaskTable.projectId, scope.projectId),
            eq(AgentRuntimeTaskTable.sessionId, scope.sessionId),
          ),
        )
        .orderBy(desc(AgentRuntimeTaskTable.updatedAt), desc(AgentRuntimeTaskTable.id))
        .limit(1);
      return rows[0] ? loadPlan(dbProvider(), scope, rows[0].id) : null;
    },

    async listCommandEvidence(scope, taskId) {
      return dbProvider()
        .select({
          taskId: AgentRuntimeTaskCommandTable.taskId,
          turnOrdinal: AgentRuntimeTurnTable.ordinal,
          callId: AgentRuntimeTaskCommandTable.callId,
          toolName: AgentRuntimeTaskCommandTable.toolName,
        })
        .from(AgentRuntimeTaskCommandTable)
        .innerJoin(
          AgentRuntimeTurnTable,
          and(
            eq(AgentRuntimeTurnTable.id, AgentRuntimeTaskCommandTable.turnId),
            eq(AgentRuntimeTurnTable.sessionId, AgentRuntimeTaskCommandTable.sessionId),
          ),
        )
        .where(
          and(
            eq(AgentRuntimeTaskCommandTable.taskId, taskId),
            eq(AgentRuntimeTaskCommandTable.projectId, scope.projectId),
            eq(AgentRuntimeTaskCommandTable.sessionId, scope.sessionId),
          ),
        )
        .orderBy(
          asc(AgentRuntimeTurnTable.ordinal),
          asc(AgentRuntimeTaskCommandTable.createdAt),
          asc(AgentRuntimeTaskCommandTable.idempotencyKey),
        );
    },

    async applyCommand(provenance, command) {
      for (const [value, label] of [
        [provenance.projectId, 'projectId'],
        [provenance.sessionId, 'sessionId'],
        [provenance.turnId, 'turnId'],
        [provenance.callId, 'callId'],
        [provenance.toolCallId, 'toolCallId'],
        [provenance.idempotencyKey, 'idempotencyKey'],
      ] as const) {
        requireNonBlank(value, label);
      }
      if (
        provenance.idempotencyKey !==
        `${provenance.sessionId}:${provenance.turnId}:${provenance.callId}`
      ) {
        throw new AgentRuntimeLongTaskConflictError(
          'COMMAND_CONFLICT',
          'Task command idempotency provenance is invalid.',
        );
      }
      const argumentsHash = await hashCommand(command);

      return dbProvider().transaction(
        async (tx) => {
          const existingRows = await tx
            .select()
            .from(AgentRuntimeTaskCommandTable)
            .where(eq(AgentRuntimeTaskCommandTable.idempotencyKey, provenance.idempotencyKey))
            .limit(1);
          const existing = existingRows[0];
          if (existing) {
            if (
              existing.projectId !== provenance.projectId ||
              existing.sessionId !== provenance.sessionId ||
              existing.turnId !== provenance.turnId ||
              existing.toolCallId !== provenance.toolCallId ||
              existing.callId !== provenance.callId ||
              existing.toolName !== command.toolName ||
              existing.argumentsHash !== argumentsHash
            ) {
              throw new AgentRuntimeLongTaskConflictError(
                'COMMAND_CONFLICT',
                'Task command idempotency key was reused with different provenance or arguments.',
              );
            }
            const stored = parseStoredResult(existing.resultJson);
            return { ...stored, outcome: 'duplicate' as const };
          }

          const scope: AgentRuntimeTaskScope = {
            projectId: provenance.projectId,
            sessionId: provenance.sessionId,
          };
          const at = provenance.createdAt || now();
          let taskId = taskIdForCommand(command);
          let changedStepId: string | undefined;
          let changedConstraintId: string | undefined;

          if (command.toolName === 'update_task_plan' && command.operation === 'create') {
            assertFrozenChapterManifestCoverage({
              scopeKind: command.scopeKind,
              chapterManifest: command.chapterManifest,
              steps: command.steps,
            });
            const openRows = await tx
              .select({ id: AgentRuntimeTaskTable.id })
              .from(AgentRuntimeTaskTable)
              .where(
                and(
                  eq(AgentRuntimeTaskTable.projectId, scope.projectId),
                  eq(AgentRuntimeTaskTable.sessionId, scope.sessionId),
                  inArray(AgentRuntimeTaskTable.status, ['active', 'paused', 'blocked']),
                ),
              )
              .limit(1);
            if (openRows[0]) {
              throw new AgentRuntimeLongTaskConflictError(
                'TASK_ALREADY_ACTIVE',
                `Session already has open task "${openRows[0].id}".`,
              );
            }
            taskId = createId('task');
            await tx.insert(AgentRuntimeTaskTable).values({
              id: taskId,
              projectId: scope.projectId,
              sessionId: scope.sessionId,
              objective: requireNonBlank(command.objective, 'objective'),
              scopeKind: command.scopeKind,
              status: 'active',
              revision: 0,
              createdAt: at,
              updatedAt: at,
              endedAt: null,
            });
            await insertChapterManifest(
              tx,
              { taskId, scope },
              command.chapterManifest,
            );
            await insertSteps(
              tx,
              {
                taskId,
                scope,
                firstOrdinal: 0,
                createdAt: at,
              },
              command.steps,
            );
            await insertConstraints(tx, { taskId, scope, createdAt: at }, command.constraints);
          } else {
            if (!taskId) {
              throw new AgentRuntimeLongTaskConflictError(
                'TASK_PLAN_INVALID',
                'Task id is required for this task command.',
              );
            }
            const plan = await requirePlan(tx, scope, taskId);
            assertScope(scope, plan.task);

            if (command.toolName === 'update_task_plan') {
              assertMutableRevision(plan, command.expectedRevision);
              if (command.operation === 'append_steps') {
                if (plan.task.scopeKind === 'whole_book_chapters') {
                  throw new AgentRuntimeLongTaskConflictError(
                    'TASK_PLAN_INVALID',
                    'A frozen whole-book task cannot append chapter steps.',
                  );
                }
                const knownStepKeys = new Set(plan.steps.flatMap(stableTaskStepKeys));
                const uniqueSteps = command.steps.filter((step) => {
                  const keys = stableTaskStepKeys(step);
                  if (keys.some((key) => knownStepKeys.has(key))) return false;
                  for (const key of keys) knownStepKeys.add(key);
                  return true;
                });
                if (uniqueSteps.length === 0) {
                  // A retried semantic append may arrive with a fresh provider
                  // call id after a budget/recovery boundary. Record the
                  // command receipt below, but keep plan revision and ordinals
                  // unchanged.
                } else {
                  const maxRows = await tx
                    .select({ value: max(AgentRuntimeTaskStepTable.ordinal) })
                    .from(AgentRuntimeTaskStepTable)
                    .where(eq(AgentRuntimeTaskStepTable.taskId, taskId));
                  await insertSteps(
                    tx,
                    {
                      taskId,
                      scope,
                      firstOrdinal: Number(maxRows[0]?.value ?? -1) + 1,
                      createdAt: at,
                    },
                    uniqueSteps,
                  );
                  await bumpRevision(tx, taskId, command.expectedRevision, at);
                }
              } else if (command.operation === 'set_objective') {
                const objective = requireNonBlank(command.objective, 'objective');
                if (objective === plan.task.objective) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'TASK_PLAN_INVALID',
                    'Task objective update is a no-op.',
                  );
                }
                await bumpRevision(tx, taskId, command.expectedRevision, at, { objective });
              } else {
                if (
                  command.status === plan.task.status ||
                  !canTransitionAgentRuntimeTask(plan.task.status, command.status)
                ) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'INVALID_TASK_TRANSITION',
                    `Task cannot transition from ${plan.task.status} to ${command.status}.`,
                  );
                }
                if (
                  command.status === 'completed' &&
                  plan.steps.some((step) => step.status !== 'completed')
                ) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'INVALID_TASK_TRANSITION',
                    'Task cannot complete while any step is not completed.',
                  );
                }
                if (command.status === 'completed') {
                  assertFrozenChapterManifestCoverage({
                    scopeKind: plan.task.scopeKind,
                    chapterManifest: plan.chapterManifest,
                    steps: plan.steps,
                  });
                }
                await bumpRevision(tx, taskId, command.expectedRevision, at, {
                  status: command.status,
                  endedAt:
                    command.status === 'completed' || command.status === 'failed' ? at : null,
                });
              }
            } else if (command.toolName === 'update_task_step') {
              assertMutableRevision(plan, command.expectedRevision);
              const step = plan.steps.find((candidate) => candidate.id === command.stepId);
              if (!step) {
                throw new AgentRuntimeLongTaskConflictError(
                  'TASK_SCOPE_MISMATCH',
                  `Task step "${command.stepId}" is not owned by this task.`,
                );
              }
              if (
                step.status === command.status ||
                !canTransitionAgentRuntimeTaskStep(step.status, command.status)
              ) {
                throw new AgentRuntimeLongTaskConflictError(
                  'INVALID_STEP_TRANSITION',
                  `Task step cannot transition from ${step.status} to ${command.status}.`,
                );
              }
              if (
                command.status === 'in_progress' &&
                plan.steps.some(
                  (candidate) => candidate.id !== step.id && candidate.status === 'in_progress',
                )
              ) {
                throw new AgentRuntimeLongTaskConflictError(
                  'INVALID_STEP_TRANSITION',
                  'Only one task step may be in progress at a time.',
                );
              }
              if (command.status === 'completed') {
                await assertAcceptedWriteEvidence(
                  tx,
                  scope,
                  plan.task.scopeKind,
                  step,
                  command.resultRef,
                );
              }
              await tx
                .update(AgentRuntimeTaskStepTable)
                .set({
                  status: command.status,
                  resultNote: command.resultNote,
                  resultRef: command.resultRef,
                  updatedAt: at,
                  startedAt:
                    step.startedAt ??
                    (command.status === 'in_progress' ||
                    command.status === 'completed' ||
                    command.status === 'failed'
                      ? at
                      : null),
                  completedAt:
                    command.status === 'completed' || command.status === 'failed' ? at : null,
                })
                .where(
                  and(
                    eq(AgentRuntimeTaskStepTable.id, command.stepId),
                    eq(AgentRuntimeTaskStepTable.taskId, taskId),
                    eq(AgentRuntimeTaskStepTable.projectId, scope.projectId),
                    eq(AgentRuntimeTaskStepTable.sessionId, scope.sessionId),
                  ),
                );
              await bumpRevision(tx, taskId, command.expectedRevision, at);
              changedStepId = command.stepId;
            } else {
              assertMutableRevision(plan, command.expectedRevision);
              if (command.operation === 'add') {
                const [created] = await insertConstraints(tx, { taskId, scope, createdAt: at }, [
                  { body: command.body, source: command.source },
                ]);
                changedConstraintId = created;
              } else {
                const current = plan.constraints.find(
                  (candidate) => candidate.id === command.constraintId,
                );
                if (!current) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'TASK_SCOPE_MISMATCH',
                    `Task constraint "${command.constraintId}" is not owned by this task.`,
                  );
                }
                if (current.status !== 'active') {
                  throw new AgentRuntimeLongTaskConflictError(
                    'INVALID_CONSTRAINT_TRANSITION',
                    `Only an active constraint can be ${command.operation === 'fulfill' ? 'fulfilled' : 'superseded'}.`,
                  );
                }
                if (command.operation === 'fulfill') {
                  await tx
                    .update(AgentRuntimeTaskConstraintTable)
                    .set({
                      status: 'fulfilled',
                      settledAt: at,
                      updatedAt: at,
                    })
                    .where(
                      and(
                        eq(AgentRuntimeTaskConstraintTable.id, command.constraintId),
                        eq(AgentRuntimeTaskConstraintTable.taskId, taskId),
                      ),
                    );
                  changedConstraintId = command.constraintId;
                } else {
                  const [replacementId] = await insertConstraints(
                    tx,
                    { taskId, scope, createdAt: at },
                    [
                      {
                        body: command.replacementBody,
                        source: command.replacementSource,
                      },
                    ],
                  );
                  await tx
                    .update(AgentRuntimeTaskConstraintTable)
                    .set({
                      status: 'superseded',
                      supersededById: replacementId,
                      settledAt: at,
                      updatedAt: at,
                    })
                    .where(
                      and(
                        eq(AgentRuntimeTaskConstraintTable.id, command.constraintId),
                        eq(AgentRuntimeTaskConstraintTable.taskId, taskId),
                      ),
                    );
                  changedConstraintId = replacementId;
                }
              }
              await bumpRevision(tx, taskId, command.expectedRevision, at);
            }
          }

          if (!taskId) {
            throw new AgentRuntimeLongTaskConflictError(
              'TASK_PLAN_INVALID',
              'Task command did not resolve a task id.',
            );
          }
          const persistedPlan = await requirePlan(tx, scope, taskId);
          const result: AgentRuntimeTaskCommandResult = {
            outcome: 'inserted',
            plan: persistedPlan,
            ...(changedStepId ? { changedStepId } : {}),
            ...(changedConstraintId ? { changedConstraintId } : {}),
          };
          await tx.insert(AgentRuntimeTaskCommandTable).values({
            idempotencyKey: provenance.idempotencyKey,
            projectId: provenance.projectId,
            sessionId: provenance.sessionId,
            turnId: provenance.turnId,
            toolCallId: provenance.toolCallId,
            callId: provenance.callId,
            toolName: command.toolName,
            toolAccess: 'write',
            taskId,
            argumentsHash,
            resultJson: canonicalAgentRuntimeJson(result),
            createdAt: at,
          });
          return result;
        },
        { behavior: 'immediate' },
      );
    },
  };
}
