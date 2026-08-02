import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  max,
  or,
  sql,
} from 'drizzle-orm';
import type {
  AgentRuntimeTaskCommand,
  AgentRuntimeTaskCommandProvenance,
  AgentRuntimeTaskCommandResult,
  AgentRuntimeTaskChapterManifestSeed,
  AgentRuntimeTaskChapterManifestState,
  AgentRuntimeTaskManifestReconciliationResult,
  AgentRuntimeTaskConstraintSource,
  AgentRuntimeTaskConstraintStatus,
  AgentRuntimeTaskPlan,
  AgentRuntimeTaskScope,
  AgentRuntimeTaskScopeKind,
  AgentRuntimeTaskStepReadEvidence,
  AgentRuntimeTaskStepReviewResult,
  AgentRuntimeTaskStepReviewEvidence,
  AgentRuntimeTaskStatus,
  AgentRuntimeTaskStepStatus,
  AgentRuntimeTaskTargetKind,
  AgentRuntimeTaskWorkKind,
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
  BookNodeTable,
  AgentRuntimeTaskCommandTable,
  AgentRuntimeTaskChapterManifestTable,
  AgentRuntimeTaskConstraintTable,
  AgentRuntimeReadObservationTable,
  AgentRuntimeReadReceiptTable,
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
      | 'TASK_READ_EVIDENCE_INVALID'
      | 'TASK_MANIFEST_DRIFT'
      | 'TASK_PLAN_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeLongTaskConflictError';
  }
}

function reviewEvidenceError(message: string): never {
  throw new AgentRuntimeLongTaskConflictError('TASK_READ_EVIDENCE_INVALID', message);
}

function reviewRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return reviewEvidenceError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function reviewText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    return reviewEvidenceError(`${label} must be non-empty text.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    return reviewEvidenceError(`${label} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeTaskStepReviewResult(value: unknown): AgentRuntimeTaskStepReviewResult {
  const row = reviewRecord(value, 'reviewResult');
  if (row.schemaVersion !== 1) {
    return reviewEvidenceError('reviewResult.schemaVersion must be 1.');
  }
  if (row.verdict !== 'pass' && row.verdict !== 'findings' && row.verdict !== 'blocked') {
    return reviewEvidenceError('reviewResult.verdict is invalid.');
  }
  if (!Array.isArray(row.claims) || row.claims.length > 128) {
    return reviewEvidenceError('reviewResult.claims must contain at most 128 entries.');
  }
  if (!Array.isArray(row.findings) || row.findings.length > 128) {
    return reviewEvidenceError('reviewResult.findings must contain at most 128 entries.');
  }
  const normalizeCitations = (value_: unknown, label: string) => {
    if (!Array.isArray(value_) || value_.length === 0 || value_.length > 16) {
      return reviewEvidenceError(`${label} must contain 1 to 16 exact citations.`);
    }
    return value_.map((raw, index) => {
      const citation = reviewRecord(raw, `${label}[${index}]`);
      const block = citation.block;
      const path = citation.path;
      if (block !== undefined && (!Number.isSafeInteger(block) || Number(block) < 1)) {
        return reviewEvidenceError(`${label}[${index}].block must be a positive integer.`);
      }
      if (path !== undefined && typeof path !== 'string') {
        return reviewEvidenceError(`${label}[${index}].path must be text.`);
      }
      return {
        quote: reviewText(citation.quote, `${label}[${index}].quote`, 2_000),
        ...(block === undefined ? {} : { block: Number(block) }),
        ...(path === undefined ? {} : { path: path.slice(0, 1_000) }),
      };
    });
  };
  const claimKinds = new Set([
    'event',
    'character_state',
    'canon',
    'voice',
    'timeline',
    'unresolved',
  ]);
  const findingKinds = new Set(['canon', 'continuity', 'voice', 'pov', 'pacing', 'logic', 'other']);
  const claims = row.claims.map((raw, index) => {
    const claim = reviewRecord(raw, `reviewResult.claims[${index}]`);
    if (typeof claim.kind !== 'string' || !claimKinds.has(claim.kind)) {
      return reviewEvidenceError(`reviewResult.claims[${index}].kind is invalid.`);
    }
    return {
      kind: claim.kind as AgentRuntimeTaskStepReviewResult['claims'][number]['kind'],
      text: reviewText(claim.text, `reviewResult.claims[${index}].text`, 4_000),
      citations: normalizeCitations(claim.citations, `reviewResult.claims[${index}].citations`),
    };
  });
  const findings = row.findings.map((raw, index) => {
    const finding = reviewRecord(raw, `reviewResult.findings[${index}]`);
    if (typeof finding.kind !== 'string' || !findingKinds.has(finding.kind)) {
      return reviewEvidenceError(`reviewResult.findings[${index}].kind is invalid.`);
    }
    if (
      finding.severity !== 'info' &&
      finding.severity !== 'warning' &&
      finding.severity !== 'error'
    ) {
      return reviewEvidenceError(`reviewResult.findings[${index}].severity is invalid.`);
    }
    return {
      kind: finding.kind as AgentRuntimeTaskStepReviewResult['findings'][number]['kind'],
      severity:
        finding.severity as AgentRuntimeTaskStepReviewResult['findings'][number]['severity'],
      message: reviewText(finding.message, `reviewResult.findings[${index}].message`, 4_000),
      citations: normalizeCitations(finding.citations, `reviewResult.findings[${index}].citations`),
    };
  });
  if (claims.length + findings.length === 0) {
    return reviewEvidenceError('reviewResult must include at least one cited claim or finding.');
  }
  if (row.verdict === 'pass' && findings.length > 0) {
    return reviewEvidenceError('A pass verdict cannot contain findings.');
  }
  if (row.verdict === 'findings' && findings.length === 0) {
    return reviewEvidenceError('A findings verdict requires at least one finding.');
  }
  return {
    schemaVersion: 1,
    verdict: row.verdict,
    synopsis: reviewText(row.synopsis, 'reviewResult.synopsis', 8_000),
    claims,
    findings,
  };
}

function parseStoredReviewResult(value: string | null): AgentRuntimeTaskStepReviewResult | null {
  if (!value) return null;
  try {
    return normalizeTaskStepReviewResult(JSON.parse(value) as unknown);
  } catch {
    return null;
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
  getChapterManifestState(
    scope: AgentRuntimeTaskScope,
    taskId: string,
  ): Promise<AgentRuntimeTaskChapterManifestState>;
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
    workKind: (row.workKind || 'edit') as AgentRuntimeTaskWorkKind,
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
    reviewResult: parseStoredReviewResult(row.reviewResultJson),
    readEvidence: null,
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

export function compareAgentRuntimeTaskChapterManifest(
  scopeKind: AgentRuntimeTaskScopeKind,
  frozen: readonly PersistedAgentRuntimeTaskChapterManifestEntry[],
  current: readonly AgentRuntimeTaskChapterManifestSeed[],
): AgentRuntimeTaskChapterManifestState {
  if (scopeKind !== 'whole_book_chapters') {
    return {
      status: 'not_applicable',
      frozenCount: 0,
      currentCount: 0,
      current: [],
      added: [],
      missing: [],
      renamed: [],
      reordered: [],
    };
  }
  const frozenById = new Map(frozen.map((entry) => [entry.resolvedChapterId, entry]));
  const currentById = new Map(current.map((entry) => [entry.resolvedChapterId, entry]));
  const added = current.filter((entry) => !frozenById.has(entry.resolvedChapterId));
  const missing = frozen.filter((entry) => !currentById.has(entry.resolvedChapterId));
  const renamed = current.flatMap((entry) => {
    const previous = frozenById.get(entry.resolvedChapterId);
    return previous && previous.name !== entry.name
      ? [
          {
            resolvedChapterId: entry.resolvedChapterId,
            frozenName: previous.name,
            currentName: entry.name,
          },
        ]
      : [];
  });
  const reordered = current.flatMap((entry) => {
    const previous = frozenById.get(entry.resolvedChapterId);
    return previous && previous.ordinal !== entry.ordinal
      ? [
          {
            resolvedChapterId: entry.resolvedChapterId,
            name: entry.name,
            frozenOrdinal: previous.ordinal,
            currentOrdinal: entry.ordinal,
          },
        ]
      : [];
  });
  return {
    status:
      added.length > 0 || missing.length > 0 || renamed.length > 0 || reordered.length > 0
        ? 'drifted'
        : 'current',
    frozenCount: frozen.length,
    currentCount: current.length,
    current: current.map((entry) => ({ ...entry })),
    added: added.map((entry) => ({ ...entry })),
    missing: missing.map((entry) => ({ ...entry })),
    renamed,
    reordered,
  };
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
    status?: AgentRuntimeTaskStepStatus;
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
  if (input.steps.length < input.chapterManifest.length) {
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_PLAN_INVALID',
      'A whole-book task must contain one active step for every frozen chapter.',
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
      !requireNonBlank(chapter.resolvedChapterId, `chapterManifest[${index}].resolvedChapterId`)
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
  for (const historical of input.steps.slice(input.chapterManifest.length)) {
    if (historical.status !== 'completed' && historical.status !== 'retired') {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'A whole-book task may retain only completed or retired historical steps outside the current manifest.',
      );
    }
  }
}

async function loadCurrentChapterManifest(
  executor: DbExecutor,
  projectId: string,
): Promise<AgentRuntimeTaskChapterManifestSeed[]> {
  const rows = await executor
    .select({
      resolvedChapterId: BookNodeTable.id,
      name: BookNodeTable.title,
    })
    .from(BookNodeTable)
    .where(
      and(
        eq(BookNodeTable.projectId, projectId),
        eq(BookNodeTable.kind, 'chapter'),
        isNull(BookNodeTable.deletedAt),
      ),
    )
    .orderBy(asc(BookNodeTable.bookOrder), asc(BookNodeTable.id));
  return rows.map((row, ordinal) => ({
    ordinal,
    name: row.name,
    resolvedChapterId: row.resolvedChapterId,
  }));
}

function chapterManifestSeedsMatch(
  frozen: readonly AgentRuntimeTaskChapterManifestSeed[],
  current: readonly AgentRuntimeTaskChapterManifestSeed[],
): boolean {
  return (
    frozen.length === current.length &&
    frozen.every(
      (chapter, index) =>
        chapter.ordinal === current[index]?.ordinal &&
        chapter.name === current[index]?.name &&
        chapter.resolvedChapterId === current[index]?.resolvedChapterId,
    )
  );
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
  const forward = input.effectForwardJson ? writeArguments(input.effectForwardJson) : null;
  if (forward) {
    const entityKind =
      typeof forward.entityKind === 'string' ? stableTaskText(forward.entityKind) : null;
    const expectedKind = stableTaskText(target.kind);
    const canonicalTargets: Array<{ kind: string | null; id: unknown }> = [
      { kind: entityKind, id: forward.entityId },
      {
        kind: target.kind === 'chapter' || target.kind === 'drift' ? expectedKind : null,
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
      return typeof value === 'string' && expected.has(stableTaskText(value));
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
    category: ['category', 'entity', 'target'],
    other: ['entity', 'target'],
  };
  return fields[target.kind].some((field) => {
    const value = arguments_[field];
    return typeof value === 'string' && expected.has(stableTaskText(value));
  });
}

const WHOLE_BOOK_PROSE_MUTATION_TOOLS = new Set([
  'edit_file',
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
  'authorized_effect',
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
    (evidence.reviewSettledAt === null || evidence.reviewSettledAt >= startedAt) &&
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
    (reviewStatus === 'accepted_effect' || reviewStatus === 'authorized_effect') &&
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
    if (command.scopeKind === 'whole_book_chapters') {
      return {
        toolName: command.toolName,
        operation: command.operation,
        objective: command.objective,
        scopeKind: command.scopeKind,
        workKind: command.workKind ?? 'edit',
        constraints: command.constraints,
      };
    }
    return {
      toolName: command.toolName,
      operation: command.operation,
      objective: command.objective,
      scopeKind: command.scopeKind,
      workKind: command.workKind ?? 'edit',
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
  if (command.toolName === 'update_task_plan' && command.operation === 'append_steps') {
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

function receiptBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  return reviewEvidenceError(`${label} is not a valid binary result.`);
}

async function decodeVerifiedReadReceiptResult(
  row: typeof AgentRuntimeReadReceiptTable.$inferSelect,
): Promise<unknown> {
  const bytes = receiptBytes(row.resultBlob, `Read receipt ${row.id}`);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return reviewEvidenceError('Web Crypto SHA-256 is unavailable for read-evidence verification.');
  }
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  const actualHash = `sha256:${bytesToHex(new Uint8Array(digest))}`;
  if (actualHash !== row.resultHash) {
    return reviewEvidenceError(`Read receipt "${row.id}" failed integrity verification.`);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const result = JSON.parse(text) as unknown;
    if (canonicalAgentRuntimeJson(result) !== text) throw new Error('non-canonical JSON');
    return result;
  } catch (cause) {
    return reviewEvidenceError(
      `Read receipt "${row.id}" contains invalid canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
}

function collectReadStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReadStrings(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectReadStrings(item, output);
  }
}

function reviewTargetObservationKind(step: PersistedAgentRuntimeTaskStep): string | null {
  switch (step.target?.kind) {
    case 'chapter':
    case 'drift':
      return 'node_prose';
    case 'element':
      return 'element_prose';
    case 'storyline':
      return 'storyline_prose';
    case 'category':
      return 'category_prose';
    default:
      return null;
  }
}

function reviewCitations(result: AgentRuntimeTaskStepReviewResult) {
  return [
    ...result.claims.flatMap((claim) => claim.citations),
    ...result.findings.flatMap((finding) => finding.citations),
  ];
}

async function resolveTaskStepReadEvidence(input: {
  executor: DbExecutor;
  scope: AgentRuntimeTaskScope;
  step: PersistedAgentRuntimeTaskStep;
  reviewResult: AgentRuntimeTaskStepReviewResult;
  requiredReceiptId?: string;
}): Promise<AgentRuntimeTaskStepReadEvidence> {
  const { executor, scope, step, reviewResult } = input;
  const observationKind = reviewTargetObservationKind(step);
  if (!step.startedAt || !step.target?.resolvedTargetId || !observationKind) {
    return reviewEvidenceError(
      `Review step "${step.id}" must be in progress and target one readable prose entity.`,
    );
  }
  const candidates = await executor
    .select({
      receipt: AgentRuntimeReadReceiptTable,
      observationKind: AgentRuntimeReadObservationTable.entityKind,
    })
    .from(AgentRuntimeReadObservationTable)
    .innerJoin(
      AgentRuntimeReadReceiptTable,
      eq(AgentRuntimeReadReceiptTable.id, AgentRuntimeReadObservationTable.receiptId),
    )
    .where(
      and(
        eq(AgentRuntimeReadObservationTable.projectId, scope.projectId),
        eq(AgentRuntimeReadObservationTable.sessionId, scope.sessionId),
        eq(AgentRuntimeReadObservationTable.entityKind, observationKind),
        eq(AgentRuntimeReadObservationTable.entityId, step.target.resolvedTargetId),
        gte(AgentRuntimeReadReceiptTable.createdAt, step.startedAt),
        ...(input.requiredReceiptId
          ? [eq(AgentRuntimeReadReceiptTable.id, input.requiredReceiptId)]
          : []),
      ),
    )
    .orderBy(desc(AgentRuntimeReadReceiptTable.createdAt), desc(AgentRuntimeReadReceiptTable.id))
    .limit(20);
  const exact = candidates[0]?.receipt;
  if (!exact) {
    return reviewEvidenceError(
      `Review step "${step.id}" has no exact target read after it entered in_progress. Read the target prose and then retry completion.`,
    );
  }

  const relatedRows = await executor
    .select()
    .from(AgentRuntimeReadReceiptTable)
    .where(
      and(
        eq(AgentRuntimeReadReceiptTable.projectId, scope.projectId),
        eq(AgentRuntimeReadReceiptTable.sessionId, scope.sessionId),
        eq(AgentRuntimeReadReceiptTable.turnId, exact.turnId),
        gte(AgentRuntimeReadReceiptTable.createdAt, step.startedAt),
        or(
          eq(AgentRuntimeReadReceiptTable.callId, exact.callId),
          like(AgentRuntimeReadReceiptTable.callId, `${exact.callId}:%`),
        ),
      ),
    )
    .orderBy(asc(AgentRuntimeReadReceiptTable.createdAt), asc(AgentRuntimeReadReceiptTable.id));
  const corpus: string[] = [];
  for (const row of relatedRows) {
    collectReadStrings(await decodeVerifiedReadReceiptResult(row), corpus);
  }
  const citations = reviewCitations(reviewResult);
  const missing = citations.find(
    (citation) => !corpus.some((source) => source.includes(citation.quote)),
  );
  if (missing) {
    return reviewEvidenceError(
      `Review citation was not found verbatim in the verified target read: ${JSON.stringify(missing.quote.slice(0, 160))}.`,
    );
  }
  return {
    receiptId: exact.id,
    toolName: exact.toolName,
    observedAt: exact.createdAt,
    exactTargetEvidence: true,
    citationCount: citations.length,
  };
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
            reviewToolCallId: AgentRuntimeWriteReviewTable.toolCallId,
            reviewCreatedAt: AgentRuntimeWriteReviewTable.createdAt,
            reviewUpdatedAt: AgentRuntimeWriteReviewTable.updatedAt,
            reviewSettledAt: AgentRuntimeWriteReviewTable.settledAt,
            effectPhase: AgentRuntimeWriteEffectTable.phase,
            effectProjectId: AgentRuntimeWriteEffectTable.projectId,
            effectSessionId: AgentRuntimeWriteEffectTable.sessionId,
            effectTurnId: AgentRuntimeWriteEffectTable.turnId,
            effectToolCallId: AgentRuntimeWriteEffectTable.toolCallId,
            effectToolName: AgentRuntimeWriteEffectTable.toolName,
            effectChapterId: AgentRuntimeWriteEffectTable.chapterId,
            effectArgumentsJson: AgentRuntimeWriteEffectTable.argumentsJson,
            effectForwardJson: AgentRuntimeWriteEffectTable.forwardJson,
            effectResultJson: AgentRuntimeWriteEffectTable.resultJson,
            effectResultCommittedAt: AgentRuntimeWriteEffectTable.resultCommittedAt,
          })
          .from(AgentRuntimeWriteReviewTable)
          .innerJoin(
            AgentRuntimeWriteEffectTable,
            eq(AgentRuntimeWriteEffectTable.id, AgentRuntimeWriteReviewTable.effectId),
          )
          .where(
            and(
              inArray(AgentRuntimeWriteReviewTable.id, batch),
              eq(AgentRuntimeWriteReviewTable.sessionId, scope.sessionId),
              eq(AgentRuntimeWriteEffectTable.projectId, scope.projectId),
              eq(AgentRuntimeWriteEffectTable.sessionId, scope.sessionId),
            ),
          )),
      );
      const authorizedEffects = await executor
        .select({
          effectId: AgentRuntimeWriteEffectTable.id,
          effectPhase: AgentRuntimeWriteEffectTable.phase,
          effectProjectId: AgentRuntimeWriteEffectTable.projectId,
          effectSessionId: AgentRuntimeWriteEffectTable.sessionId,
          effectTurnId: AgentRuntimeWriteEffectTable.turnId,
          effectToolCallId: AgentRuntimeWriteEffectTable.toolCallId,
          effectToolName: AgentRuntimeWriteEffectTable.toolName,
          effectChapterId: AgentRuntimeWriteEffectTable.chapterId,
          effectArgumentsJson: AgentRuntimeWriteEffectTable.argumentsJson,
          effectForwardJson: AgentRuntimeWriteEffectTable.forwardJson,
          effectResultJson: AgentRuntimeWriteEffectTable.resultJson,
          effectResultCommittedAt: AgentRuntimeWriteEffectTable.resultCommittedAt,
          authorizedAt: AgentRuntimeWriteEffectTable.authorizedAt,
          updatedAt: AgentRuntimeWriteEffectTable.updatedAt,
        })
        .from(AgentRuntimeWriteEffectTable)
        .where(
          and(
            inArray(AgentRuntimeWriteEffectTable.id, batch),
            eq(AgentRuntimeWriteEffectTable.projectId, scope.projectId),
            eq(AgentRuntimeWriteEffectTable.sessionId, scope.sessionId),
            isNotNull(AgentRuntimeWriteEffectTable.authorizationKind),
            isNotNull(AgentRuntimeWriteEffectTable.authorizationArgumentsHash),
            isNotNull(AgentRuntimeWriteEffectTable.authorizedAt),
          ),
        );
      rows.push(
        ...authorizedEffects.flatMap((effect) =>
          effect.authorizedAt && effect.effectResultCommittedAt
            ? [
                {
                  reviewId: effect.effectId,
                  reviewStatus: 'authorized_effect',
                  reviewSessionId: effect.effectSessionId,
                  reviewTurnId: effect.effectTurnId,
                  reviewToolCallId: effect.effectToolCallId,
                  reviewCreatedAt: effect.authorizedAt,
                  reviewUpdatedAt: effect.updatedAt,
                  reviewSettledAt: effect.effectResultCommittedAt,
                  effectPhase: effect.effectPhase,
                  effectProjectId: effect.effectProjectId,
                  effectSessionId: effect.effectSessionId,
                  effectTurnId: effect.effectTurnId,
                  effectToolCallId: effect.effectToolCallId,
                  effectToolName: effect.effectToolName,
                  effectChapterId: effect.effectChapterId,
                  effectArgumentsJson: effect.effectArgumentsJson,
                  effectForwardJson: effect.effectForwardJson,
                  effectResultJson: effect.effectResultJson,
                  effectResultCommittedAt: effect.effectResultCommittedAt,
                },
              ]
            : [],
        ),
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
    const reviewEvidenceRows =
      task.workKind === 'edit'
        ? await loadReviewEvidenceRows(
            executor,
            scope,
            domainSteps
              .map((step) => step.resultRef)
              .filter((value): value is string => value !== null),
          )
        : [];
    const reviewEvidenceById = new Map(
      reviewEvidenceRows.map((evidence) => [evidence.reviewId, evidence]),
    );
    const hydratedSteps = await Promise.all(
      domainSteps.map(async (step) => {
        if (task.workKind === 'edit') {
          return {
            ...step,
            reviewEvidence: evaluateTaskStepReviewEvidence({
              scope,
              scopeKind: task.scopeKind,
              step,
              evidence: step.resultRef ? reviewEvidenceById.get(step.resultRef) : undefined,
            }),
          };
        }
        let readEvidence: AgentRuntimeTaskStepReadEvidence | null = null;
        if (step.resultRef && step.reviewResult) {
          try {
            readEvidence = await resolveTaskStepReadEvidence({
              executor,
              scope,
              step,
              reviewResult: step.reviewResult,
              requiredReceiptId: step.resultRef,
            });
          } catch {
            readEvidence = null;
          }
        }
        return { ...step, reviewEvidence: null, readEvidence };
      }),
    );
    return {
      task,
      chapterManifest: chapterManifest.map(chapterManifestEntryToDomain),
      steps: hydratedSteps,
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
        'A completed task step requires its target and an authorized durable writeRef in resultRef.',
      );
    }
    const evidenceRows = await loadReviewEvidenceRows(executor, scope, [resultRef]);
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
          `Write "${resultRef}" is still awaiting a legacy review. Do not retry completion; call update_task_step with status="blocked", the same taskId/stepId/resultRef, and the current expectedRevision.`,
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
        name: requireNonBlank(chapter.name, `chapterManifest[${chapter.ordinal}].name`),
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

  const loadManifestState = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    plan: AgentRuntimeTaskPlan,
  ): Promise<AgentRuntimeTaskChapterManifestState> =>
    compareAgentRuntimeTaskChapterManifest(
      plan.task.scopeKind,
      plan.chapterManifest,
      await loadCurrentChapterManifest(executor, scope.projectId),
    );

  const reconcileChapterManifest = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    plan: AgentRuntimeTaskPlan,
    expectedRevision: number,
    at: string,
  ): Promise<AgentRuntimeTaskManifestReconciliationResult> => {
    if (plan.task.scopeKind !== 'whole_book_chapters') {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'Only a whole-book task has a chapter manifest to reconcile.',
      );
    }
    const manifestState = await loadManifestState(executor, scope, plan);
    if (manifestState.status !== 'drifted') {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'The frozen chapter manifest already matches the current book.',
      );
    }
    if (manifestState.current.length === 0) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_MANIFEST_DRIFT',
        'The project has no active chapters. Add a chapter or explicitly pause/fail the whole-book task; an empty book cannot be silently reconciled as complete.',
      );
    }

    const existingByChapterId = new Map(
      plan.steps.flatMap((step) =>
        step.target?.kind === 'chapter' && step.target.resolvedTargetId
          ? [[step.target.resolvedTargetId, step] as const]
          : [],
      ),
    );
    const maxOrdinal = plan.steps.reduce((highest, step) => Math.max(highest, step.ordinal), -1);
    const temporaryOffset = maxOrdinal + plan.steps.length + manifestState.current.length + 2;
    if (plan.steps.length > 0) {
      await executor
        .update(AgentRuntimeTaskStepTable)
        .set({
          ordinal: sql`${AgentRuntimeTaskStepTable.ordinal} + ${temporaryOffset}`,
        })
        .where(eq(AgentRuntimeTaskStepTable.taskId, plan.task.id));
    }

    const addedStepIds: string[] = [];
    const reopenedStepIds: string[] = [];
    const currentIds = new Set(manifestState.current.map((chapter) => chapter.resolvedChapterId));
    for (const chapter of manifestState.current) {
      const existing = existingByChapterId.get(chapter.resolvedChapterId);
      if (!existing) {
        const stepId = createId('step');
        await executor.insert(AgentRuntimeTaskStepTable).values({
          id: stepId,
          taskId: plan.task.id,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          ordinal: chapter.ordinal,
          title: `处理章节：${chapter.name}`,
          targetKind: 'chapter',
          targetName: chapter.name,
          resolvedTargetId: chapter.resolvedChapterId,
          status: 'pending',
          resultNote: null,
          resultRef: null,
          createdAt: at,
          updatedAt: at,
          startedAt: null,
          completedAt: null,
        });
        addedStepIds.push(stepId);
        continue;
      }
      const reopened = existing.status === 'retired';
      await executor
        .update(AgentRuntimeTaskStepTable)
        .set({
          ordinal: chapter.ordinal,
          title:
            existing.target && existing.title.includes(existing.target.name)
              ? existing.title.replace(existing.target.name, chapter.name)
              : existing.title,
          targetKind: 'chapter',
          targetName: chapter.name,
          resolvedTargetId: chapter.resolvedChapterId,
          status: reopened ? 'pending' : existing.status,
          resultNote: reopened ? null : existing.resultNote,
          resultRef: reopened ? null : existing.resultRef,
          updatedAt: at,
          startedAt: reopened ? null : existing.startedAt,
          completedAt: reopened ? null : existing.completedAt,
        })
        .where(eq(AgentRuntimeTaskStepTable.id, existing.id));
      if (reopened) reopenedStepIds.push(existing.id);
    }

    const historical = plan.steps
      .filter(
        (step) =>
          step.target?.kind === 'chapter' &&
          step.target.resolvedTargetId &&
          !currentIds.has(step.target.resolvedTargetId),
      )
      .sort((left, right) => left.ordinal - right.ordinal);
    const retiredStepIds: string[] = [];
    const retainedCompletedStepIds: string[] = [];
    for (const [index, step] of historical.entries()) {
      const retainedCompleted = step.status === 'completed';
      await executor
        .update(AgentRuntimeTaskStepTable)
        .set({
          ordinal: manifestState.current.length + index,
          status: retainedCompleted ? 'completed' : 'retired',
          resultNote: retainedCompleted
            ? step.resultNote
            : `Retired after explicit manifest reconciliation because chapter "${step.target?.name ?? step.title}" is no longer active.`,
          resultRef: retainedCompleted ? step.resultRef : null,
          updatedAt: at,
          completedAt: retainedCompleted ? step.completedAt : at,
        })
        .where(eq(AgentRuntimeTaskStepTable.id, step.id));
      if (retainedCompleted) retainedCompletedStepIds.push(step.id);
      else retiredStepIds.push(step.id);
    }

    await executor
      .delete(AgentRuntimeTaskChapterManifestTable)
      .where(eq(AgentRuntimeTaskChapterManifestTable.taskId, plan.task.id));
    await insertChapterManifest(executor, { taskId: plan.task.id, scope }, manifestState.current);
    await bumpRevision(executor, plan.task.id, expectedRevision, at);
    return {
      addedStepIds,
      retiredStepIds,
      reopenedStepIds,
      retainedCompletedStepIds,
      renamedChapterCount: manifestState.renamed.length,
      reorderedChapterCount: manifestState.reordered.length,
    };
  };

  return {
    getPlan: (scope, taskId) => loadPlan(dbProvider(), scope, taskId),

    async getChapterManifestState(scope, taskId) {
      const executor = dbProvider();
      const plan = await requirePlan(executor, scope, taskId);
      return loadManifestState(executor, scope, plan);
    },

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
          let manifestReconciliation: AgentRuntimeTaskManifestReconciliationResult | undefined;

          if (command.toolName === 'update_task_plan' && command.operation === 'create') {
            const workKind = command.workKind ?? 'edit';
            if (workKind !== 'edit' && workKind !== 'review') {
              throw new AgentRuntimeLongTaskConflictError(
                'TASK_PLAN_INVALID',
                'Task workKind must be edit or review.',
              );
            }
            assertFrozenChapterManifestCoverage({
              scopeKind: command.scopeKind,
              chapterManifest: command.chapterManifest,
              steps: command.steps,
            });
            if (command.scopeKind === 'whole_book_chapters') {
              const currentManifest = await loadCurrentChapterManifest(tx, scope.projectId);
              if (!chapterManifestSeedsMatch(command.chapterManifest, currentManifest)) {
                throw new AgentRuntimeLongTaskConflictError(
                  'TASK_MANIFEST_DRIFT',
                  'The canonical chapter order changed while the whole-book task was being created. Read the workspace again and retry plan creation.',
                );
              }
            }
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
              workKind,
              status: 'active',
              revision: 0,
              createdAt: at,
              updatedAt: at,
              endedAt: null,
            });
            await insertChapterManifest(tx, { taskId, scope }, command.chapterManifest);
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
              } else if (command.operation === 'reconcile_manifest') {
                manifestReconciliation = await reconcileChapterManifest(
                  tx,
                  scope,
                  plan,
                  command.expectedRevision,
                  at,
                );
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
                if (command.status === 'completed') {
                  const manifestState = await loadManifestState(tx, scope, plan);
                  if (manifestState.status === 'drifted') {
                    throw new AgentRuntimeLongTaskConflictError(
                      'TASK_MANIFEST_DRIFT',
                      'The current chapter set differs from the frozen task manifest. Read the plan, call reconcile_manifest with the current revision, then complete every current chapter step.',
                    );
                  }
                  assertFrozenChapterManifestCoverage({
                    scopeKind: plan.task.scopeKind,
                    chapterManifest: plan.chapterManifest,
                    steps: plan.steps,
                  });
                  if (
                    plan.steps.some(
                      (step) => step.status !== 'completed' && step.status !== 'retired',
                    )
                  ) {
                    throw new AgentRuntimeLongTaskConflictError(
                      'INVALID_TASK_TRANSITION',
                      'Task cannot complete while any current step is not completed.',
                    );
                  }
                  if (
                    plan.task.workKind === 'review' &&
                    plan.steps.some(
                      (step) =>
                        step.status === 'completed' && !step.readEvidence?.exactTargetEvidence,
                    )
                  ) {
                    throw new AgentRuntimeLongTaskConflictError(
                      'TASK_READ_EVIDENCE_INVALID',
                      'Task cannot complete because one or more review steps lost exact read evidence.',
                    );
                  }
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
                if (plan.task.workKind === 'edit') {
                  await assertAcceptedWriteEvidence(
                    tx,
                    scope,
                    plan.task.scopeKind,
                    step,
                    command.resultRef,
                  );
                }
              }
              let effectiveResultRef = command.resultRef;
              let effectiveResultNote = command.resultNote;
              let effectiveReviewResult: AgentRuntimeTaskStepReviewResult | null = null;
              if (plan.task.workKind === 'review' && command.status === 'completed') {
                if (command.resultRef) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'TASK_READ_EVIDENCE_INVALID',
                    'Review resultRef is product-owned. Omit it; Drifting will bind the latest exact target read.',
                  );
                }
                effectiveReviewResult = normalizeTaskStepReviewResult(command.reviewResult);
                const readEvidence = await resolveTaskStepReadEvidence({
                  executor: tx,
                  scope,
                  step,
                  reviewResult: effectiveReviewResult,
                });
                effectiveResultRef = readEvidence.receiptId;
                effectiveResultNote ??= effectiveReviewResult.synopsis;
              } else if (command.reviewResult !== undefined && command.reviewResult !== null) {
                throw new AgentRuntimeLongTaskConflictError(
                  'TASK_READ_EVIDENCE_INVALID',
                  'reviewResult is only valid when completing a review task step.',
                );
              }
              await tx
                .update(AgentRuntimeTaskStepTable)
                .set({
                  status: command.status,
                  resultNote: effectiveResultNote,
                  resultRef: effectiveResultRef,
                  reviewResultJson: effectiveReviewResult
                    ? canonicalAgentRuntimeJson(effectiveReviewResult)
                    : null,
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
            ...(manifestReconciliation ? { manifestReconciliation } : {}),
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
