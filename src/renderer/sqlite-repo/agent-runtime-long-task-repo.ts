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
  AgentRuntimeTaskStepWorkKind,
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

function assertNonEditResultNoteDoesNotClaimMutation(value: string | null): void {
  if (!value) return;
  const mutation =
    /(?:已|已经|现已|刚刚)\s*(?:补写|写入|改写|修改|更新|新建|创建|添加|删除|移除|清理|调整|建立)|(?:补写|写入|改写|修改|更新|新建|创建|添加|删除|移除|清理|调整|建立)\s*(?:了|完成|完毕|成功)|\bI\s+(?:have\s+)?(?:written|wrote|updated|created|deleted|removed|edited|rewritten|added)\b/iu;
  if (!mutation.test(value)) return;
  throw new AgentRuntimeLongTaskConflictError(
    'TASK_READ_EVIDENCE_INVALID',
    '检查或研究步骤不能只用结论文字声称已经修改作品。先执行真实的作者对象写入，并将这项工作记录为编辑步骤；检查结论只能描述已读取的当前内容。',
  );
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
    workKind: (row.workKind || 'edit') as AgentRuntimeTaskStepWorkKind,
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

function stableTaskStepKeys(
  step: {
    title: string;
    workKind?: AgentRuntimeTaskStepWorkKind;
    target: {
      kind: AgentRuntimeTaskTargetKind;
      name: string;
      resolvedTargetId?: string | null;
    } | null;
  },
  defaultWorkKind: AgentRuntimeTaskWorkKind = 'edit',
): string[] {
  const workKind = step.workKind ?? defaultWorkKind;
  if (step.target) {
    return [
      `${workKind}:target:${step.target.kind}:name:${stableTaskText(step.target.name)}`,
      ...(step.target.resolvedTargetId?.trim()
        ? [
            `${workKind}:target:${step.target.kind}:id:${stableTaskText(step.target.resolvedTargetId)}`,
          ]
        : []),
    ];
  }
  return [`${workKind}:title:${stableTaskText(step.title)}`];
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

interface TaskWriteEvidenceIdentity {
  ids: Set<string>;
  names: Set<string>;
  operations: Set<string>;
  paths: string[][];
}

function evidenceRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEvidenceJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return evidenceRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function evidencePathSegments(value: string): string[] {
  return value
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return stableTaskText(decodeURIComponent(segment));
      } catch {
        return stableTaskText(segment);
      }
    });
}

function collectTaskWriteEvidenceIdentity(
  evidence: DurableTaskStepReviewRow,
): TaskWriteEvidenceIdentity {
  const identity: TaskWriteEvidenceIdentity = {
    ids: new Set(evidence.effectChapterId ? [evidence.effectChapterId] : []),
    names: new Set(),
    operations: new Set([stableTaskText(evidence.effectToolName)]),
    paths: [],
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    const row = evidenceRecord(value);
    if (!row) return;
    for (const key of [
      'entity',
      'entityId',
      'node',
      'nodeId',
      'chapterId',
      'element',
      'elementId',
      'storyline',
      'storylineId',
      'categoryId',
      'relation',
      'relationId',
      'comment',
      'commentId',
    ]) {
      const candidate = row[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        identity.ids.add(candidate);
      }
    }
    for (const key of ['title', 'category', 'targetName']) {
      const candidate = row[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        identity.names.add(stableTaskText(candidate));
      }
    }
    for (const key of ['name', 'operation', 'kind']) {
      const candidate = row[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        identity.operations.add(stableTaskText(candidate));
      }
    }
    const path = row.path;
    if (typeof path === 'string' && path.trim()) {
      identity.paths.push(evidencePathSegments(path));
    }
    for (const key of [
      '__workspaceCommand',
      'arguments',
      'data',
      'modelData',
      'result',
      'presentation',
    ]) {
      visit(row[key], depth + 1);
    }
  };
  visit(parseEvidenceJson(evidence.effectArgumentsJson), 0);
  visit(parseEvidenceJson(evidence.effectForwardJson), 0);
  visit(parseEvidenceJson(evidence.effectResultJson), 0);
  return identity;
}

function writeEvidenceMatchesStepTarget(
  step: PersistedAgentRuntimeTaskStep,
  evidence: DurableTaskStepReviewRow,
): boolean {
  const target = step.target;
  if (!target || target.kind === 'book' || target.kind === 'project') return true;
  const identity = collectTaskWriteEvidenceIdentity(evidence);
  if (target.resolvedTargetId && identity.ids.has(target.resolvedTargetId)) return true;
  const targetName = stableTaskText(authoredTaskTargetName(target.kind, target.name));
  const pathMatches = identity.paths.some((segments) => {
    if (segments.length < 2) return false;
    if (target.kind === 'chapter') {
      return segments[0] === 'chapters' && segments[1] === targetName;
    }
    if (target.kind === 'drift') {
      return segments[0] === 'drifts' && segments[1] === targetName;
    }
    if (target.kind === 'storyline') {
      return segments[0] === 'storylines' && segments[1] === targetName;
    }
    if (target.kind === 'element') {
      return segments[0] === 'elements' && segments.includes(targetName);
    }
    if (target.kind === 'category') {
      return (
        (segments[0] === 'categories' || segments[0] === 'elements') &&
        segments[1] === targetName
      );
    }
    return segments.includes(targetName);
  });
  if (pathMatches || identity.names.has(targetName)) return true;
  if (target.kind !== 'other') return false;
  const keyword = targetName.replace(/[-_\s]+/gu, '');
  return [...identity.operations].some((operation) => {
    const normalized = operation.replace(/[-_\s]+/gu, '');
    if (keyword.includes('relation') || keyword.includes('关系')) {
      return normalized.includes('relation');
    }
    if (keyword.includes('comment') || keyword.includes('批注')) {
      return normalized.includes('comment');
    }
    if (keyword.includes('todo') || keyword.includes('待办')) {
      return normalized.includes('todo') || normalized.includes('comment');
    }
    return normalized.includes(keyword) || keyword.includes(normalized);
  });
}

function authoredTaskTargetName(
  kind: NonNullable<PersistedAgentRuntimeTaskStep['target']>['kind'],
  value: string,
): string {
  const name = value.trim();
  const patterns: Partial<Record<typeof kind, RegExp>> = {
    chapter: /^章节[「“"](.+?)[」”"](?:正文|摘要|标题)?$/u,
    drift: /^(?:灵感|漂移)[「“"](.+?)[」”"](?:正文|摘要|标题)?$/u,
    element: /^(?:人物|角色|地点|区域|组织|势力|物品|道具|要素)[「“"](.+?)[」”"](?:正文|设定|说明|摘要|名称|别名|事实|分组|分类|完整档案)?$/u,
    storyline: /^故事线[「“"](.+?)[」”"](?:正文|设定|说明|摘要|名称|事实|章节关系|章节|完整档案)?$/u,
    category: /^要素分类[「“"](.+?)[」”"](?:正文|设定|说明|完整档案)?$/u,
  };
  return patterns[kind]?.exec(name)?.[1]?.trim() || name;
}

function evaluateTaskStepReviewEvidence(input: {
  scope: AgentRuntimeTaskScope;
  scopeKind: AgentRuntimeTaskScopeKind;
  step: PersistedAgentRuntimeTaskStep;
  evidence: DurableTaskStepReviewRow | undefined;
  evidenceBoundaryAt: string;
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
  // A model may discover a missing unit, perform its write, and append the
  // corresponding plan step afterwards. The task creation boundary rejects
  // pre-task effects without forcing model bookkeeping to precede useful work.
  const evidenceBoundaryAt = input.evidenceBoundaryAt;
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
    evidence.effectResultCommittedAt >= evidenceBoundaryAt &&
    evidence.reviewCreatedAt >= evidenceBoundaryAt &&
    evidence.reviewUpdatedAt >= evidenceBoundaryAt &&
    (evidence.reviewSettledAt === null || evidence.reviewSettledAt >= evidenceBoundaryAt) &&
    writeEvidenceMatchesStepTarget(input.step, evidence);
  const acceptedTargetEvidence =
    provenanceValid &&
    (reviewStatus === 'accepted_effect' || reviewStatus === 'authorized_effect') &&
    evidence.reviewSettledAt !== null &&
    evidence.reviewSettledAt >= evidenceBoundaryAt;
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
        workKind: step.workKind ?? command.workKind ?? 'edit',
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
        workKind: step.workKind ?? null,
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
  const boundaryAt = step.startedAt ?? step.createdAt;
  const observationKind = reviewTargetObservationKind(step);
  let boundReceipt: typeof AgentRuntimeReadReceiptTable.$inferSelect | undefined;
  let corpusRows: Array<typeof AgentRuntimeReadReceiptTable.$inferSelect> = [];
  let exactTargetEvidence = false;
  if (step.target?.resolvedTargetId && observationKind) {
    const candidates = await executor
      .select({ receipt: AgentRuntimeReadReceiptTable })
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
          gte(AgentRuntimeReadReceiptTable.createdAt, boundaryAt),
          ...(input.requiredReceiptId
            ? [eq(AgentRuntimeReadReceiptTable.id, input.requiredReceiptId)]
            : []),
        ),
      )
      .orderBy(desc(AgentRuntimeReadReceiptTable.createdAt), desc(AgentRuntimeReadReceiptTable.id))
      .limit(20);
    boundReceipt = candidates[0]?.receipt;
    if (!boundReceipt) {
      return reviewEvidenceError(
        `Review step "${step.id}" has no verified read of its named prose target after the step was created.`,
      );
    }
    corpusRows = await executor
      .select()
      .from(AgentRuntimeReadReceiptTable)
      .where(
        and(
          eq(AgentRuntimeReadReceiptTable.projectId, scope.projectId),
          eq(AgentRuntimeReadReceiptTable.sessionId, scope.sessionId),
          eq(AgentRuntimeReadReceiptTable.turnId, boundReceipt.turnId),
          gte(AgentRuntimeReadReceiptTable.createdAt, boundaryAt),
          or(
            eq(AgentRuntimeReadReceiptTable.callId, boundReceipt.callId),
            like(AgentRuntimeReadReceiptTable.callId, `${boundReceipt.callId}:%`),
          ),
        ),
      )
      .orderBy(asc(AgentRuntimeReadReceiptTable.createdAt), asc(AgentRuntimeReadReceiptTable.id));
    exactTargetEvidence = true;
  } else {
    const candidates = await executor
      .select()
      .from(AgentRuntimeReadReceiptTable)
      .where(
        and(
          eq(AgentRuntimeReadReceiptTable.projectId, scope.projectId),
          eq(AgentRuntimeReadReceiptTable.sessionId, scope.sessionId),
          gte(AgentRuntimeReadReceiptTable.createdAt, boundaryAt),
          ...(input.requiredReceiptId
            ? [eq(AgentRuntimeReadReceiptTable.id, input.requiredReceiptId)]
            : []),
        ),
      )
      .orderBy(desc(AgentRuntimeReadReceiptTable.createdAt), desc(AgentRuntimeReadReceiptTable.id));
    for (const candidate of candidates) {
      if (NON_RESEARCH_READ_TOOLS.has(candidate.toolName)) continue;
      try {
        await decodeVerifiedReadReceiptResult(candidate);
        boundReceipt = candidate;
        break;
      } catch {
        // A corrupt candidate cannot hide an earlier valid project read.
      }
    }
    if (!boundReceipt) {
      return reviewEvidenceError(
        `Review step "${step.id}" has no verified workspace read after the step was created.`,
      );
    }
    corpusRows = await executor
      .select()
      .from(AgentRuntimeReadReceiptTable)
      .where(
        and(
          eq(AgentRuntimeReadReceiptTable.projectId, scope.projectId),
          eq(AgentRuntimeReadReceiptTable.sessionId, scope.sessionId),
          gte(AgentRuntimeReadReceiptTable.createdAt, boundaryAt),
        ),
      )
      .orderBy(asc(AgentRuntimeReadReceiptTable.createdAt), asc(AgentRuntimeReadReceiptTable.id));
  }
  const corpus: string[] = [];
  for (const row of corpusRows) {
    if (NON_RESEARCH_READ_TOOLS.has(row.toolName)) continue;
    try {
      collectReadStrings(await decodeVerifiedReadReceiptResult(row), corpus);
    } catch {
      // A broad review may span many reads. Ignore unrelated corrupt receipts;
      // the bound receipt itself was verified above.
    }
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
    receiptId: boundReceipt.id,
    toolName: boundReceipt.toolName,
    observedAt: boundReceipt.createdAt,
    exactTargetEvidence,
    citationCount: citations.length,
  };
}

const NON_RESEARCH_READ_TOOLS = new Set(['read_task_plan']);

/**
 * Research steps prove that discovery actually happened after the step began,
 * without pretending a broad scan has one exact prose target. Read receipts
 * are renderer-created only after successful read execution and are hash
 * verified again here before they may settle durable progress.
 */
async function resolveResearchStepReadEvidence(input: {
  executor: DbExecutor;
  scope: AgentRuntimeTaskScope;
  step: PersistedAgentRuntimeTaskStep;
  requiredReceiptId?: string;
}): Promise<AgentRuntimeTaskStepReadEvidence> {
  const { executor, scope, step } = input;
  const boundaryAt = step.startedAt ?? step.createdAt;
  const candidates = await executor
    .select()
    .from(AgentRuntimeReadReceiptTable)
    .where(
      and(
        eq(AgentRuntimeReadReceiptTable.projectId, scope.projectId),
        eq(AgentRuntimeReadReceiptTable.sessionId, scope.sessionId),
        gte(AgentRuntimeReadReceiptTable.createdAt, boundaryAt),
        ...(input.requiredReceiptId
          ? [eq(AgentRuntimeReadReceiptTable.id, input.requiredReceiptId)]
          : []),
      ),
    )
    .orderBy(desc(AgentRuntimeReadReceiptTable.createdAt), desc(AgentRuntimeReadReceiptTable.id))
    .limit(50);
  for (const receipt of candidates) {
    if (NON_RESEARCH_READ_TOOLS.has(receipt.toolName)) continue;
    try {
      await decodeVerifiedReadReceiptResult(receipt);
      return {
        receiptId: receipt.id,
        toolName: receipt.toolName,
        observedAt: receipt.createdAt,
        exactTargetEvidence: false,
        citationCount: 0,
      };
    } catch {
      // Keep looking for a valid immutable receipt. A corrupt candidate must
      // neither settle the step nor hide an earlier valid read.
    }
  }
  return reviewEvidenceError(
    `Research step "${step.id}" has no verified workspace read after it entered in_progress. Read the relevant workspace state and retry completion.`,
  );
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
    const reviewEvidenceRows = await loadReviewEvidenceRows(
      executor,
      scope,
      domainSteps
        .filter((step) => step.workKind === 'edit')
        .map((step) => step.resultRef)
        .filter((value): value is string => value !== null),
    );
    const reviewEvidenceById = new Map(
      reviewEvidenceRows.map((evidence) => [evidence.reviewId, evidence]),
    );
    const hydratedSteps = await Promise.all(
      domainSteps.map(async (step) => {
        if (step.workKind === 'edit') {
          return {
            ...step,
            reviewEvidence: evaluateTaskStepReviewEvidence({
              scope,
              scopeKind: task.scopeKind,
              step,
              evidence: step.resultRef ? reviewEvidenceById.get(step.resultRef) : undefined,
              evidenceBoundaryAt: task.createdAt,
            }),
          };
        }
        let readEvidence: AgentRuntimeTaskStepReadEvidence | null = null;
        if (step.workKind === 'review' && step.resultRef && step.reviewResult) {
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
        } else if (step.workKind === 'research' && step.resultRef) {
          try {
            readEvidence = await resolveResearchStepReadEvidence({
              executor,
              scope,
              step,
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

  const mutableStepRevision = (
    plan: AgentRuntimeTaskPlan,
    expectedRevision: number,
  ): number => {
    requireExpectedRevision(expectedRevision);
    if (expectedRevision > plan.task.revision) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_REVISION_CONFLICT',
        `Task revision is behind the requested step transition: expected ${expectedRevision}, current ${plan.task.revision}.`,
      );
    }
    if (!isOpenAgentRuntimeTaskStatus(plan.task.status)) {
      throw new AgentRuntimeLongTaskConflictError(
        'INVALID_TASK_TRANSITION',
        `Terminal task "${plan.task.id}" cannot be mutated.`,
      );
    }
    // Step transitions name one stable step and are revalidated against the
    // current plan below. This makes parallel tool calls for independent steps
    // safe without weakening CAS for plan, manifest, objective, or constraint
    // mutations.
    return plan.task.revision;
  };

  const resolveAcceptedWriteEvidence = async (
    executor: DbExecutor,
    scope: AgentRuntimeTaskScope,
    task: PersistedAgentRuntimeTask,
    step: PersistedAgentRuntimeTaskStep,
    preferredResultRef: string | null,
    claimedResultRefs: ReadonlySet<string>,
  ): Promise<string> => {
    const candidateRefs: string[] = [];
    if (preferredResultRef && !claimedResultRefs.has(preferredResultRef)) {
      candidateRefs.push(preferredResultRef);
    }
    const effects = await executor
      .select({
        id: AgentRuntimeWriteEffectTable.id,
        toolName: AgentRuntimeWriteEffectTable.toolName,
      })
      .from(AgentRuntimeWriteEffectTable)
      .where(
        and(
          eq(AgentRuntimeWriteEffectTable.projectId, scope.projectId),
          eq(AgentRuntimeWriteEffectTable.sessionId, scope.sessionId),
          eq(AgentRuntimeWriteEffectTable.phase, 'result_committed'),
          gte(AgentRuntimeWriteEffectTable.resultCommittedAt, task.createdAt),
          isNotNull(AgentRuntimeWriteEffectTable.authorizationKind),
          isNotNull(AgentRuntimeWriteEffectTable.authorizationArgumentsHash),
          isNotNull(AgentRuntimeWriteEffectTable.authorizedAt),
        ),
      )
      .orderBy(
        desc(AgentRuntimeWriteEffectTable.resultCommittedAt),
        desc(AgentRuntimeWriteEffectTable.id),
      );
    for (const effect of effects) {
      if (
        effect.toolName === 'update_task_plan' ||
        effect.toolName === 'update_task_step' ||
        effect.toolName === 'update_task_constraint'
      ) {
        continue;
      }
      if (
        effect.id !== preferredResultRef &&
        !candidateRefs.includes(effect.id)
      ) {
        candidateRefs.push(effect.id);
      }
    }
    const evidenceRows = await loadReviewEvidenceRows(executor, scope, candidateRefs);
    const evidenceById = new Map(evidenceRows.map((evidence) => [evidence.reviewId, evidence]));
    const preferredEvidence = preferredResultRef
      ? evaluateTaskStepReviewEvidence({
          scope,
        scopeKind: 'explicit_targets',
        step: { ...step, resultRef: preferredResultRef },
        evidence: evidenceById.get(preferredResultRef),
        evidenceBoundaryAt: task.createdAt,
      })
      : null;
    if (preferredResultRef && claimedResultRefs.has(preferredResultRef)) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_WRITE_EVIDENCE_INVALID',
        `Write "${preferredResultRef}" is already claimed by another task step.`,
      );
    }
    if (preferredResultRef && preferredEvidence?.acceptedTargetEvidence) {
      return preferredResultRef;
    }
    if (preferredResultRef && preferredEvidence?.outcome === 'pending') {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_WRITE_EVIDENCE_INVALID',
        `Write "${preferredResultRef}" is still awaiting author review. Block the step only if no independent work can continue.`,
      );
    }
    for (const resultRef of candidateRefs) {
      if (resultRef === preferredResultRef || claimedResultRefs.has(resultRef)) continue;
      const reviewEvidence = evaluateTaskStepReviewEvidence({
        scope,
        scopeKind: 'explicit_targets',
        step: { ...step, resultRef },
        evidence: evidenceById.get(resultRef),
        evidenceBoundaryAt: task.createdAt,
      });
      if (reviewEvidence?.acceptedTargetEvidence) return resultRef;
    }
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_WRITE_EVIDENCE_INVALID',
      `Task step "${step.id}" has no unclaimed accepted durable workspace write for its exact target during this task.`,
    );
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
      defaultWorkKind: AgentRuntimeTaskWorkKind;
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
        'Every task step requires a named target.',
      );
    }
    if (
      seeds.some(
        (seed) =>
          seed.workKind !== undefined &&
          seed.workKind !== 'edit' &&
          seed.workKind !== 'review' &&
          seed.workKind !== 'research',
      )
    ) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'Task step workKind must be edit, review, or research.',
      );
    }
    const rows = seeds.map((seed, index) => ({
      id: createId('step'),
      taskId: plan.taskId,
      projectId: plan.scope.projectId,
      sessionId: plan.scope.sessionId,
      ordinal: plan.firstOrdinal + index,
      title: requireNonBlank(seed.title, `steps[${index}].title`),
      workKind: seed.workKind ?? plan.defaultWorkKind,
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
          workKind: plan.task.workKind,
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
            if (
              command.scopeKind === 'whole_book_chapters' &&
              command.steps.some(
                (step) => step.workKind !== undefined && step.workKind !== workKind,
              )
            ) {
              throw new AgentRuntimeLongTaskConflictError(
                'TASK_PLAN_INVALID',
                'Whole-book chapter steps must use the task workKind.',
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
            const creationTurnRows = await tx
              .select({ acceptedAt: AgentRuntimeTurnTable.acceptedAt })
              .from(AgentRuntimeTurnTable)
              .where(
                and(
                  eq(AgentRuntimeTurnTable.id, provenance.turnId),
                  eq(AgentRuntimeTurnTable.sessionId, provenance.sessionId),
                ),
              )
              .limit(1);
            const taskEvidenceBoundaryAt = creationTurnRows[0]?.acceptedAt ?? at;
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
              // A provider can discover that a campaign needs durable memory
              // only after making useful edits. Start the evidence boundary at
              // the accepted turn, so an exact write from earlier in this same
              // turn can be adopted without admitting work from older turns.
              createdAt: taskEvidenceBoundaryAt,
              updatedAt: at,
              endedAt: null,
            });
            await insertChapterManifest(tx, { taskId, scope }, command.chapterManifest);
            await insertSteps(
              tx,
              {
                taskId,
                scope,
                defaultWorkKind: workKind,
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
                const knownStepKeys = new Set(
                  plan.steps.flatMap((step) => stableTaskStepKeys(step, plan.task.workKind)),
                );
                const uniqueSteps = command.steps.filter((step) => {
                  const keys = stableTaskStepKeys(step, plan.task.workKind);
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
                      defaultWorkKind: plan.task.workKind,
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
                  // Providers sometimes pair create with an identical
                  // set_objective in the same response. The authored task is
                  // already in the requested state: keep the revision stable
                  // and record the semantic receipt below instead of turning
                  // harmless redundancy into a recovery loop.
                } else {
                  await bumpRevision(tx, taskId, command.expectedRevision, at, { objective });
                }
              } else if (command.operation === 'reconcile_manifest') {
                manifestReconciliation = await reconcileChapterManifest(
                  tx,
                  scope,
                  plan,
                  command.expectedRevision,
                  at,
                );
              } else {
                if (command.status === plan.task.status) {
                  // Providers may pair create with an explicit set_status=active
                  // in the same batch. Creation is already active, so replay the
                  // semantic intent without manufacturing a visible failure or
                  // advancing the revision.
                } else if (!canTransitionAgentRuntimeTask(plan.task.status, command.status)) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'INVALID_TASK_TRANSITION',
                    `Task cannot transition from ${plan.task.status} to ${command.status}.`,
                  );
                } else {
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
                      plan.steps.some(
                        (step) =>
                          step.status === 'completed' &&
                          step.workKind === 'review' &&
                          !step.readEvidence,
                      )
                    ) {
                      throw new AgentRuntimeLongTaskConflictError(
                        'TASK_READ_EVIDENCE_INVALID',
                        'Task cannot complete because one or more review steps lost verified read evidence.',
                      );
                    }
                    if (
                      plan.steps.some(
                        (step) =>
                          step.status === 'completed' &&
                          step.workKind === 'research' &&
                          !step.readEvidence,
                      )
                    ) {
                      throw new AgentRuntimeLongTaskConflictError(
                        'TASK_READ_EVIDENCE_INVALID',
                        'Task cannot complete because one or more research steps lost verified read evidence.',
                      );
                    }
                  }
                  await bumpRevision(tx, taskId, command.expectedRevision, at, {
                    status: command.status,
                    endedAt:
                      command.status === 'completed' || command.status === 'failed' ? at : null,
                  });
                }
              }
            } else if (command.toolName === 'update_task_step') {
              const currentRevision = mutableStepRevision(
                plan,
                command.expectedRevision,
              );
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
              let effectiveResultRef = command.resultRef;
              let effectiveResultNote = command.resultNote;
              let effectiveReviewResult: AgentRuntimeTaskStepReviewResult | null = null;
              if (step.workKind === 'edit' && command.status === 'completed') {
                effectiveResultRef = await resolveAcceptedWriteEvidence(
                  tx,
                  scope,
                  plan.task,
                  step,
                  command.resultRef,
                  new Set(
                    plan.steps
                      .filter((candidate) => candidate.id !== step.id)
                      .map((candidate) => candidate.resultRef)
                      .filter((value): value is string => value !== null),
                  ),
                );
              } else if (step.workKind === 'review' && command.status === 'completed') {
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
              } else if (step.workKind === 'research' && command.status === 'completed') {
                if (command.resultRef) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'TASK_READ_EVIDENCE_INVALID',
                    'Research resultRef is product-owned. Omit it; Drifting will bind the latest verified workspace read.',
                  );
                }
                if (command.reviewResult !== undefined && command.reviewResult !== null) {
                  throw new AgentRuntimeLongTaskConflictError(
                    'TASK_READ_EVIDENCE_INVALID',
                    'reviewResult is not valid for a research step.',
                  );
                }
                effectiveResultNote = reviewText(command.resultNote, 'resultNote', 4_000);
                const readEvidence = await resolveResearchStepReadEvidence({
                  executor: tx,
                  scope,
                  step,
                });
                effectiveResultRef = readEvidence.receiptId;
              } else if (command.reviewResult !== undefined && command.reviewResult !== null) {
                throw new AgentRuntimeLongTaskConflictError(
                  'TASK_READ_EVIDENCE_INVALID',
                  'reviewResult is only valid when completing a review task step.',
                );
              }
              if (step.workKind !== 'edit' && command.status === 'completed') {
                assertNonEditResultNoteDoesNotClaimMutation(effectiveResultNote);
              }
              const finalizesExplicitTask =
                command.status === 'completed' &&
                plan.task.status === 'active' &&
                plan.task.scopeKind === 'explicit_targets' &&
                plan.steps.every(
                  (candidate) =>
                    candidate.id === step.id ||
                    candidate.status === 'completed' ||
                    candidate.status === 'retired',
                );
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
              await bumpRevision(
                tx,
                taskId,
                currentRevision,
                at,
                finalizesExplicitTask
                  ? {
                      status: 'completed',
                      endedAt: at,
                    }
                  : {},
              );
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
