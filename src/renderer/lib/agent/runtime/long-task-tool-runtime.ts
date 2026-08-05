import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  AgentRuntimeTaskCommand,
  AgentRuntimeTaskChapterManifestSeed,
  AgentRuntimeTaskChapterManifestState,
  AgentRuntimeTaskPlan,
  AgentRuntimeTaskStepSeed,
  AgentRuntimeTaskStepReviewResult,
  AgentRuntimeTaskStepStatus,
  AgentRuntimeTaskTargetKind,
} from '../../../domain/agent-runtime-long-task';
import {
  AgentRuntimeLongTaskConflictError,
  createAgentRuntimeLongTaskRepository,
  type AgentRuntimeLongTaskRepository,
} from '../../../sqlite-repo/agent-runtime-long-task-repo';
import { isAgentAbort, throwIfAgentAborted } from './errors';
import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolPermissionPolicy,
  AgentToolRuntime,
  AgentToolSelectionHintRequest,
  AgentToolSelectionHints,
} from './types';
import {
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
  resolveAgentLongTaskToolAccess,
} from './long-task-tool-contract';

export {
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  AGENT_LONG_TASK_READ_TOOL,
  AGENT_LONG_TASK_STEP_TOOL,
  resolveAgentLongTaskToolAccess,
} from './long-task-tool-contract';

/**
 * Long-task writes mutate runtime orchestration metadata, not authored novel
 * state, so they may advance automatically inside an already-authorized Agent
 * session. Every mutation still passes strict schema validation, durable CAS,
 * command provenance, and exactly-once persistence.
 */
export function createAgentLongTaskAwarePermissionPolicy(
  fallback: AgentToolPermissionPolicy,
): AgentToolPermissionPolicy {
  return {
    async decide(request) {
      const access = resolveAgentLongTaskToolAccess(request.toolName);
      if (!access) return fallback.decide(request);
      if (access !== request.access) {
        return {
          decision: 'deny',
          reason: 'Long-task tool access classification changed.',
        };
      }
      return { decision: 'allow', scope: 'once' };
    },
  };
}

const TARGET_KINDS = [
  'book',
  'project',
  'chapter',
  'drift',
  'element',
  'storyline',
  'category',
  'other',
] as const satisfies readonly AgentRuntimeTaskTargetKind[];

const STEP_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'failed',
] as const satisfies readonly AgentRuntimeTaskStepStatus[];

const WHOLE_MANUSCRIPT_OBJECTIVE_PATTERN =
  /(?:全书|整本|整部|所有章节|全部章节|每一章|整个作品|全部正文|whole\s+(?:book|manuscript)|entire\s+(?:book|manuscript)|all\s+chapters|every\s+chapter)/iu;

function objectiveExplicitlyCoversWholeManuscript(objective: string): boolean {
  return WHOLE_MANUSCRIPT_OBJECTIVE_PATTERN.test(objective.normalize('NFKC'));
}

const targetSchema = Type.Object(
  {
    kind: Type.Union(TARGET_KINDS.map((kind) => Type.Literal(kind))),
    name: Type.String({
      minLength: 1,
      maxLength: 240,
      description:
        'One exact authored target name. Never combine several characters, chapters, or elements into a fabricated name; create one step per named primary object. A cross-object cleanup deliverable may instead target the current project.',
    }),
  },
  { additionalProperties: false },
);

const workKindSchema = Type.Union([Type.Literal('edit'), Type.Literal('review')]);
const persistedStepWorkKindSchema = Type.Union([
  Type.Literal('edit'),
  Type.Literal('review'),
  Type.Literal('research'),
]);
const providerStepWorkKindSchema = Type.Union([Type.Literal('edit'), Type.Literal('review')], {
  description:
    'Use edit for an author-visible saved result. Use review only for a standalone critique, diagnostic, or review report explicitly requested by the author. Reading, evidence gathering, and ordinary before/after self-checks happen inside the relevant edit and are never checklist items.',
});

const persistedStepSeedSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    workKind: Type.Optional(persistedStepWorkKindSchema),
    target: targetSchema,
  },
  { additionalProperties: false },
);

const providerStepSeedSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    workKind: Type.Optional(providerStepWorkKindSchema),
    target: targetSchema,
  },
  { additionalProperties: false },
);

const readPlanSchema = Type.Object(
  {
    taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

const readPlanProviderSchema = Type.Object(
  {
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

/**
 * Strict command schema used at the execution boundary.  Keep the discriminated
 * branches here even though the provider-facing schema below is deliberately a
 * single object: OpenAI-compatible providers such as DeepSeek reject function
 * schemas whose root is `anyOf` instead of `type: "object"`.
 */
const updatePlanCommandSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal('create'),
      scopeKind: Type.Literal('explicit_targets'),
      objective: Type.String({ minLength: 1, maxLength: 4_000 }),
      workKind: Type.Optional(workKindSchema),
      steps: Type.Array(persistedStepSeedSchema, {
        minItems: 1,
        maxItems: 128,
      }),
      constraints: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
          maxItems: 32,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('create'),
      scopeKind: Type.Literal('whole_book_chapters'),
      objective: Type.String({ minLength: 1, maxLength: 4_000 }),
      workKind: Type.Optional(workKindSchema),
      constraints: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
          maxItems: 32,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('append_steps'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
      steps: Type.Array(persistedStepSeedSchema, {
        minItems: 1,
        maxItems: 128,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('set_objective'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
      objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('reconcile_manifest'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('set_status'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
      status: Type.Union([
        Type.Literal('active'),
        Type.Literal('paused'),
        Type.Literal('blocked'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ]),
    },
    { additionalProperties: false },
  ),
]);

/**
 * Provider-compatible projection of {@link updatePlanCommandSchema}.
 *
 * Conditional required fields are described by the tool description and then
 * enforced by the strict command schema before execution.  This avoids making
 * provider quirks part of the durable command contract while still failing
 * closed on missing or cross-operation arguments.
 */
const updatePlanProviderSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal('create'),
      Type.Literal('append_steps'),
      Type.Literal('set_objective'),
      Type.Literal('reconcile_manifest'),
      Type.Literal('set_status'),
    ]),
    scopeKind: Type.Optional(
      Type.Union([Type.Literal('explicit_targets'), Type.Literal('whole_book_chapters')]),
    ),
    objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
    workKind: Type.Optional(workKindSchema),
    steps: Type.Optional(
      Type.Array(providerStepSeedSchema, {
        minItems: 1,
        maxItems: 128,
      }),
    ),
    constraints: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
        maxItems: 32,
      }),
    ),
    status: Type.Optional(
      Type.Union([
        Type.Literal('active'),
        Type.Literal('paused'),
        Type.Literal('blocked'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ]),
    ),
  },
  { additionalProperties: false },
);

const updatePlanSemanticCommandSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal('create'),
      scopeKind: Type.Literal('explicit_targets'),
      objective: Type.String({ minLength: 1, maxLength: 4_000 }),
      workKind: Type.Optional(workKindSchema),
      steps: Type.Array(providerStepSeedSchema, { minItems: 1, maxItems: 128 }),
      constraints: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('create'),
      scopeKind: Type.Literal('whole_book_chapters'),
      objective: Type.String({ minLength: 1, maxLength: 4_000 }),
      workKind: Type.Optional(workKindSchema),
      constraints: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('append_steps'),
      steps: Type.Array(providerStepSeedSchema, { minItems: 1, maxItems: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('set_objective'),
      objective: Type.String({ minLength: 1, maxLength: 4_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ operation: Type.Literal('reconcile_manifest') }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal('set_status'),
      status: Type.Union([
        Type.Literal('active'),
        Type.Literal('paused'),
        Type.Literal('blocked'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ]),
    },
    { additionalProperties: false },
  ),
]);

const citationSchema = Type.Object(
  {
    quote: Type.String({ minLength: 1, maxLength: 2_000 }),
    block: Type.Optional(Type.Integer({ minimum: 1 })),
    path: Type.Optional(Type.String({ maxLength: 1_000 })),
  },
  { additionalProperties: false },
);

const reviewResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    verdict: Type.Union([Type.Literal('pass'), Type.Literal('findings'), Type.Literal('blocked')]),
    synopsis: Type.String({ minLength: 1, maxLength: 8_000 }),
    claims: Type.Array(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal('event'),
            Type.Literal('character_state'),
            Type.Literal('canon'),
            Type.Literal('voice'),
            Type.Literal('timeline'),
            Type.Literal('unresolved'),
          ]),
          text: Type.String({ minLength: 1, maxLength: 4_000 }),
          citations: Type.Array(citationSchema, { minItems: 1, maxItems: 16 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    findings: Type.Array(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal('canon'),
            Type.Literal('continuity'),
            Type.Literal('voice'),
            Type.Literal('pov'),
            Type.Literal('pacing'),
            Type.Literal('logic'),
            Type.Literal('other'),
          ]),
          severity: Type.Union([
            Type.Literal('info'),
            Type.Literal('warning'),
            Type.Literal('error'),
          ]),
          message: Type.String({ minLength: 1, maxLength: 4_000 }),
          citations: Type.Array(citationSchema, { minItems: 1, maxItems: 16 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);

const updateStepSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1, maxLength: 240 }),
    expectedRevision: Type.Integer({ minimum: 0 }),
    stepId: Type.String({ minLength: 1, maxLength: 240 }),
    status: Type.Union(STEP_STATUSES.map((status) => Type.Literal(status))),
    resultNote: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    resultRef: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    ),
    reviewResult: Type.Optional(Type.Union([reviewResultSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

const updateStepProviderSchema = Type.Object(
  {
    step: Type.Union([
      Type.Integer({ minimum: 1, description: 'One-based checklist item number' }),
      Type.String({ minLength: 1, maxLength: 500 }),
    ]),
    status: Type.Union(STEP_STATUSES.map((status) => Type.Literal(status))),
    resultNote: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    reviewResult: Type.Optional(Type.Union([reviewResultSchema, Type.Null()])),
  },
  { additionalProperties: false },
);

const updateConstraintCommandSchema = Type.Union([
  Type.Object(
    {
      operation: Type.Literal('add'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
      body: Type.String({ minLength: 1, maxLength: 2_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('fulfill'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
      constraintId: Type.String({ minLength: 1, maxLength: 240 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal('supersede'),
      taskId: Type.String({ minLength: 1, maxLength: 240 }),
      expectedRevision: Type.Integer({ minimum: 0 }),
      constraintId: Type.String({ minLength: 1, maxLength: 240 }),
      replacementBody: Type.String({
        minLength: 1,
        maxLength: 2_000,
      }),
    },
    { additionalProperties: false },
  ),
]);

const updateConstraintProviderSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal('add'),
      Type.Literal('fulfill'),
      Type.Literal('supersede'),
    ]),
    taskId: Type.String({ minLength: 1, maxLength: 240 }),
    expectedRevision: Type.Integer({ minimum: 0 }),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    constraintId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    replacementBody: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  },
  { additionalProperties: false },
);

interface ProviderStepSeed {
  title: string;
  workKind?: 'edit' | 'review' | 'research';
  target: {
    kind: AgentRuntimeTaskTargetKind;
    name: string;
  };
}

type UpdatePlanInput =
  | {
      operation: 'create';
      scopeKind: 'explicit_targets';
      objective: string;
      workKind?: 'edit' | 'review';
      steps: ProviderStepSeed[];
      constraints?: string[];
    }
  | {
      operation: 'create';
      scopeKind: 'whole_book_chapters';
      objective: string;
      workKind?: 'edit' | 'review';
      constraints?: string[];
    }
  | {
      operation: 'append_steps';
      taskId?: string;
      expectedRevision?: number;
      steps: ProviderStepSeed[];
    }
  | {
      operation: 'set_objective';
      taskId?: string;
      expectedRevision?: number;
      objective: string;
    }
  | {
      operation: 'reconcile_manifest';
      taskId?: string;
      expectedRevision?: number;
    }
  | {
      operation: 'set_status';
      taskId?: string;
      expectedRevision?: number;
      status: 'active' | 'paused' | 'blocked' | 'completed' | 'failed';
    };

type UpdateConstraintInput =
  | {
      operation: 'add';
      taskId: string;
      expectedRevision: number;
      body: string;
    }
  | {
      operation: 'fulfill';
      taskId: string;
      expectedRevision: number;
      constraintId: string;
    }
  | {
      operation: 'supersede';
      taskId: string;
      expectedRevision: number;
      constraintId: string;
      replacementBody: string;
    };

export interface AgentLongTaskTargetResolverInput {
  projectId: string;
  kind: AgentRuntimeTaskTargetKind;
  name: string;
}

export interface AgentLongTaskWholeBookChapterManifestInput {
  projectId: string;
}

export interface AgentLongTaskCurrentChapterNameInput {
  projectId: string;
  resolvedChapterId: string;
}

export interface AgentLongTaskToolRuntimeOptions {
  repository?: AgentRuntimeLongTaskRepository;
  now?: () => string;
  /**
   * Product-owned, name-first resolver. The provider never supplies a node id;
   * unresolved names remain valid and can be reconciled by a later slice.
   */
  resolveTarget?: (
    input: AgentLongTaskTargetResolverInput,
  ) => string | null | Promise<string | null>;
  /**
   * Product-owned canonical reading-order snapshot. Whole-book create never
   * asks the provider to enumerate chapters; the runtime freezes this list and
   * derives exactly one step per entry.
   */
  getWholeBookChapterManifest?: (
    input: AgentLongTaskWholeBookChapterManifestInput,
  ) =>
    | readonly AgentRuntimeTaskChapterManifestSeed[]
    | Promise<readonly AgentRuntimeTaskChapterManifestSeed[]>;
  /**
   * Refreshes only the provider-visible display name for a frozen identity.
   * null means the chapter no longer exists and is projected fail-closed.
   */
  resolveCurrentChapterName?: (input: AgentLongTaskCurrentChapterNameInput) => string | null;
}

function validation(schema: TSchema, input: Record<string, unknown>) {
  if (Value.Check(schema, input)) {
    return { ok: true as const, value: input };
  }
  const first = Value.Errors(schema, input).First();
  return {
    ok: false as const,
    error: first
      ? `Invalid task tool input at ${first.path || '/'}: ${first.message}`
      : 'Invalid task tool input.',
  };
}

function validationEither(schemas: readonly TSchema[], input: Record<string, unknown>) {
  for (const schema of schemas) {
    const checked = validation(schema, input);
    if (checked.ok) return checked;
  }
  return validation(schemas[0]!, input);
}

function projectIdFromContext(context: AgentRuntimeContext): string | null {
  return context.route.kind === 'test'
    ? (context.route.projectId ?? null)
    : context.route.projectId;
}

function runtimeToolCallId(request: AgentToolExecutionRequest): string {
  return `agent-tool:${request.sessionId}:${request.turnId}:${request.callId}`;
}

function progress(plan: AgentRuntimeTaskPlan) {
  const counts = {
    pending: 0,
    inProgress: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    retired: 0,
  };
  for (const step of plan.steps) {
    if (step.status === 'in_progress') counts.inProgress += 1;
    else counts[step.status] += 1;
  }
  return {
    total: plan.steps.length,
    ...counts,
  };
}

function nextActionableStep(plan: AgentRuntimeTaskPlan) {
  const reviewSettledBlocked = plan.steps.find(
    (step) =>
      step.status === 'blocked' &&
      step.reviewEvidence !== null &&
      step.reviewEvidence.outcome !== 'pending' &&
      step.reviewEvidence.reviewStatus !== 'missing' &&
      step.reviewEvidence.reviewStatus !== 'revert_started',
  );
  return (
    plan.steps.find((step) => step.status === 'in_progress') ??
    plan.steps.find((step) => step.status === 'pending') ??
    reviewSettledBlocked ??
    null
  );
}

function resolveChecklistStep(plan: AgentRuntimeTaskPlan, selector: string | number) {
  if (typeof selector === 'number') {
    const step = plan.steps.find((candidate) => candidate.ordinal === selector - 1);
    if (step) return step;
    throw new AgentRuntimeLongTaskConflictError(
      'TASK_NOT_FOUND',
      `任务清单中没有第 ${selector} 项。`,
    );
  }
  const normalized = selector.trim().replace(/\s+/gu, ' ');
  const matches = plan.steps.filter((candidate) => {
    const labels = [candidate.title, candidate.target?.name, String(candidate.ordinal + 1)]
      .filter((label): label is string => typeof label === 'string')
      .map((label) => label.trim().replace(/\s+/gu, ' '));
    return labels.includes(normalized);
  });
  if (matches.length === 1) return matches[0]!;
  throw new AgentRuntimeLongTaskConflictError(
    'TASK_NOT_FOUND',
    matches.length === 0
      ? `任务清单中没有“${normalized}”。`
      : `任务清单中有多个“${normalized}”，请改用项目编号。`,
  );
}

function projectManifestStateForProvider(state: AgentRuntimeTaskChapterManifestState) {
  return {
    status: state.status,
    frozenCount: state.frozenCount,
    currentCount: state.currentCount,
    added: state.added.map(({ ordinal, name }) => ({ ordinal, name })),
    missing: state.missing.map(({ ordinal, name }) => ({ ordinal, name })),
    renamed: state.renamed.map(({ frozenName, currentName }) => ({
      frozenName,
      currentName,
    })),
    reordered: state.reordered.map(({ name, frozenOrdinal, currentOrdinal }) => ({
      name,
      frozenOrdinal,
      currentOrdinal,
    })),
    instruction:
      state.status === 'drifted'
        ? 'The book changed after this whole-book task was frozen. Call update_task_plan with operation=reconcile_manifest, taskId, and the current expectedRevision before claiming completion.'
        : null,
  };
}

/**
 * Provider-safe projection: runtime handles and human-readable named targets
 * are included; renderer-resolved domain ids are deliberately omitted.
 */
export function projectAgentLongTaskPlanForProvider(
  plan: AgentRuntimeTaskPlan,
  options: {
    offset?: number;
    limit?: number;
    manifestState?: AgentRuntimeTaskChapterManifestState;
    resolveCurrentChapterName?: (input: AgentLongTaskCurrentChapterNameInput) => string | null;
  } = {},
) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 32;
  const projectChapterName = (resolvedChapterId: string, frozenName: string) => {
    if (!options.resolveCurrentChapterName) {
      return { name: frozenName };
    }
    const currentName = options.resolveCurrentChapterName({
      projectId: plan.task.projectId,
      resolvedChapterId,
    });
    if (currentName === null) {
      return { name: frozenName, availability: 'missing' as const };
    }
    return currentName === frozenName ? { name: frozenName } : { name: currentName, frozenName };
  };
  const steps = plan.steps.slice(offset, offset + limit).map((step) => {
    const target =
      step.target?.kind === 'chapter' && step.target.resolvedTargetId
        ? {
            kind: step.target.kind,
            ...projectChapterName(step.target.resolvedTargetId, step.target.name),
          }
        : step.target
          ? {
              kind: step.target.kind,
              name: step.target.name,
            }
          : null;
    return {
      stepId: step.id,
      ordinal: step.ordinal,
      title: step.title,
      workKind: step.workKind,
      target,
      status: step.status,
      resultNote: step.resultNote,
      resultRef: step.resultRef,
      reviewEvidence: step.reviewEvidence,
      reviewResult: step.reviewResult,
      readEvidence: step.readEvidence,
    };
  });
  return {
    schemaVersion: 4,
    task: {
      taskId: plan.task.id,
      objective: plan.task.objective,
      scopeKind: plan.task.scopeKind,
      workKind: plan.task.workKind,
      status: plan.task.status,
      revision: plan.task.revision,
    },
    frozenChapterManifest: {
      total: plan.chapterManifest.length,
      entries: plan.chapterManifest.slice(offset, offset + limit).map((chapter) => ({
        ordinal: chapter.ordinal,
        ...projectChapterName(chapter.resolvedChapterId, chapter.name),
      })),
    },
    chapterManifestState: options.manifestState
      ? projectManifestStateForProvider(options.manifestState)
      : null,
    progress: progress(plan),
    steps,
    activeConstraints: plan.constraints
      .filter((constraint) => constraint.status === 'active')
      .map((constraint) => ({
        constraintId: constraint.id,
        body: constraint.body,
        source: constraint.source,
      })),
    page: {
      offset,
      limit,
      returned: steps.length,
      total: plan.steps.length,
      nextOffset: offset + steps.length < plan.steps.length ? offset + steps.length : null,
    },
    continuation: {
      nextStepId: nextActionableStep(plan)?.id ?? null,
      instruction:
        'Resume this same task after compaction or restart. Prioritize the current in_progress item, otherwise the first pending item. Reuse evidence already returned and gather whatever concrete authored evidence is genuinely needed for this deliverable; avoid repeating the same discovery without a new reason. This focus is not a scope restriction: inspect or modify related authored objects when cross-object work requires it. Adopt reliable saved-change notes, never repeat saved work, and mark the current item completed once its authored result is saved. Continue until the checklist is complete or progress is genuinely blocked.',
    },
  };
}

function taskPlanModelData(
  projection: ReturnType<typeof projectAgentLongTaskPlanForProvider>,
): string {
  const statusLabel: Record<string, string> = {
    active: '进行中',
    paused: '已暂停',
    blocked: '受阻',
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    in_progress: '进行中',
    retired: '已移出当前作品',
  };
  const lines = [
    `任务清单：${projection.task.objective}`,
    `状态：${statusLabel[projection.task.status] ?? projection.task.status}`,
    `进度：${projection.progress.completed}/${projection.progress.total} 已完成，${projection.progress.inProgress} 进行中，${projection.progress.pending} 待处理`,
  ];
  if (projection.chapterManifestState?.status === 'drifted') {
    lines.push('作品章节清单已经变化，需要先更新这份任务清单。');
  }
  const next =
    projection.steps.find((step) => step.status === 'in_progress') ??
    projection.steps.find((step) => step.status === 'pending') ??
    projection.steps.find((step) => step.status === 'blocked');
  if (next) {
    const target = next.target?.name ? `（${next.target.name}）` : '';
    const availability = next.target && 'availability' in next.target ? '，当前已不存在' : '';
    const workKind =
      next.workKind === 'research'
        ? ' [只读结论]'
        : next.workKind === 'review'
          ? ' [审阅结论]'
          : '';
    lines.push(
      `当前交付：${next.ordinal + 1}. [${statusLabel[next.status] ?? next.status}]${workKind} ${next.title}${target}${availability}${next.resultNote ? ` — ${next.resultNote}` : ''}`,
      '其余交付项已排队；优先完成并登记当前项。这只是执行焦点，不是范围限制：跨对象工作确有需要时，可以读取或修改相关作者对象。',
      '优先复用已经返回的作品证据；按当前交付实际需要获取具体证据，避免没有新理由地重复盘点。可靠的已保存结果无需重做。',
    );
  }
  if (projection.activeConstraints.length > 0) {
    lines.push(
      '作者要求：',
      ...projection.activeConstraints.map((constraint) => `- ${constraint.body}`),
    );
  }
  return lines.join('\n');
}

function normalizedProviderStepWorkKind(
  step: ProviderStepSeed,
  objective: string,
): ProviderStepSeed['workKind'] {
  if (step.workKind !== 'review') {
    return step.workKind ?? inferredReadOnlyStepKind(step.title);
  }
  const task = `${objective} ${step.title}`.normalize('NFKC');
  const includesMutation = includesAuthoredMutation(task);
  const explicitlyRequestsReviewDeliverable =
    /(?:评审报告|审稿报告|审阅意见|诊断报告|点评|批评|评估报告|分析报告)/u.test(task);
  return includesMutation && !explicitlyRequestsReviewDeliverable ? 'research' : 'review';
}

function normalizedProviderStepTitle(
  step: ProviderStepSeed & { workKind: NonNullable<ProviderStepSeed['workKind']> },
  siblingTargetNames: readonly string[],
): string {
  const title = step.title.trim();
  if (!['chapter', 'drift', 'element', 'storyline', 'category'].includes(step.target.kind)) {
    return title;
  }
  const ownName = step.target.name.trim();
  const foreignTargets = siblingTargetNames.filter(
    (name) => name !== ownName && name.length > 0 && title.includes(name),
  );
  if (foreignTargets.length < 2) return title;
  const action =
    step.workKind === 'review' ? '审阅' : step.workKind === 'research' ? '调查' : '整理';
  const targetLabel: Record<string, string> = {
    chapter: '章节',
    drift: '灵感',
    element: '要素',
    storyline: '故事线',
    category: '要素分类',
  };
  return `${action}${targetLabel[step.target.kind]}「${ownName}」`;
}

function includesAuthoredMutation(value: string): boolean {
  return /(?:修改|改写|润色|整理|清理|补写|补齐|创建|新建|删除|更新|修复|重构|建立|新增|追加|插入|移除|改名|合并)/u.test(
    value.normalize('NFKC'),
  );
}

function inferredReadOnlyStepKind(title: string): 'research' | undefined {
  const normalized = title.normalize('NFKC').trim();
  if (
    !/^(?:读取|阅读|查阅|浏览|搜索|检索|查找|收集|盘点|核对|检查|复核|自检|验收|确认)/u.test(
      normalized,
    )
  ) {
    return undefined;
  }
  return includesAuthoredMutation(normalized) ? undefined : 'research';
}

function isProcessOnlyEditStep(
  step: ProviderStepSeed & { workKind: NonNullable<ProviderStepSeed['workKind']> },
): boolean {
  if (step.workKind === 'research') return true;
  if (step.workKind !== 'edit') return false;
  const normalized = step.title.normalize('NFKC').trim();
  return (
    /^(?:读取|阅读|查阅|浏览|搜索|检索|查找|收集|盘点|核对|检查|复核|自检|验收|确认)/u.test(
      normalized,
    ) && !includesAuthoredMutation(normalized)
  );
}

export class AgentLongTaskToolRuntime implements AgentToolRuntime {
  private readonly repository: AgentRuntimeLongTaskRepository;
  private readonly now: () => string;
  private readonly resolveTarget: AgentLongTaskToolRuntimeOptions['resolveTarget'] | undefined;
  private readonly getWholeBookChapterManifest:
    | AgentLongTaskToolRuntimeOptions['getWholeBookChapterManifest']
    | undefined;
  private readonly resolveCurrentChapterName:
    | AgentLongTaskToolRuntimeOptions['resolveCurrentChapterName']
    | undefined;

  constructor(options: AgentLongTaskToolRuntimeOptions = {}) {
    this.repository = options.repository ?? createAgentRuntimeLongTaskRepository();
    this.now = options.now ?? (() => new Date().toISOString());
    this.resolveTarget = options.resolveTarget;
    this.getWholeBookChapterManifest = options.getWholeBookChapterManifest;
    this.resolveCurrentChapterName = options.resolveCurrentChapterName;
  }

  listDefinitions(_context: AgentRuntimeContext): readonly AgentToolDefinition[] {
    return [
      {
        name: AGENT_LONG_TASK_READ_TOOL,
        description:
          'Read the current writing-task checklist. Use pagination only when a whole-book checklist is long.',
        inputSchema: readPlanProviderSchema,
        access: 'read',
        validateInput: (input) => validation(readPlanSchema, input),
      },
      {
        name: AGENT_LONG_TASK_PLAN_TOOL,
        description:
          'Create or maintain the current writing-task checklist. A checklist contains unfinished author-facing deliverables, never separate steps for reading, browsing, searching, gathering evidence, or ordinary before/after self-checks; do those while completing the relevant edit deliverable. Use review only when the author explicitly requested a standalone critique, diagnostic, or review report with cited evidence. create requires scopeKind and objective. Use whole_book_chapters only when the objective explicitly says every chapter or the entire manuscript; it automatically uses the complete current chapter order and must omit steps. With explicit_targets, make one step per exact named primary authored object; never invent a compound element such as A/B/C档案. A genuinely cross-object cleanup may use one project target. If work was already saved before this checklist became available, include only unfinished deliverables; reliable saved-change notes remain the truth. append_steps adds named work, set_objective renames the task, reconcile_manifest refreshes a changed whole-book chapter list, and set_status changes the whole checklist status. Drifting resolves the active checklist and concurrency details automatically.',
        inputSchema: updatePlanProviderSchema,
        access: 'write',
        validateInput: (input) =>
          validationEither([updatePlanSemanticCommandSchema, updatePlanCommandSchema], input),
      },
      {
        name: AGENT_LONG_TASK_STEP_TOOL,
        description:
          'Change one item in the current writing-task checklist. Identify it by its one-based number, exact title, or authored target name. Only one item may be in_progress, but already-finished pending work may be marked completed directly. After a saved change satisfies an item, mark it completed before starting unrelated discovery; reliable saved-change notes remain valid across compaction and must not be repeated. For a standalone review completion, include the structured reviewResult with exact authored quotes. A read-only conclusion inherited from an older checklist completes with a short resultNote. Drifting binds saved reads and edits automatically.',
        inputSchema: updateStepProviderSchema,
        access: 'write',
        validateInput: (input) =>
          validationEither([updateStepProviderSchema, updateStepSchema], input),
      },
      {
        name: AGENT_LONG_TASK_CONSTRAINT_TOOL,
        description:
          'Add, fulfill, or supersede an active durable task constraint with CAS. All operations require taskId and expectedRevision. add requires body; fulfill requires constraintId; supersede requires constraintId and replacementBody. Active constraints remain pinned across context compaction.',
        inputSchema: updateConstraintProviderSchema,
        access: 'write',
        validateInput: (input) => validation(updateConstraintCommandSchema, input),
      },
    ];
  }

  async loadSelectionHints(
    request: AgentToolSelectionHintRequest,
  ): Promise<AgentToolSelectionHints> {
    throwIfAgentAborted(request.signal);
    const projectId = projectIdFromContext(request.context);
    if (!projectId) return {};
    const plan = await this.repository.getOpenPlan({
      projectId,
      sessionId: request.sessionId,
    });
    throwIfAgentAborted(request.signal);
    const nextStep = plan ? nextActionableStep(plan) : null;
    return plan
      ? {
          longTask: {
            status: plan.task.status,
            scopeKind: plan.task.scopeKind,
            workKind: plan.task.workKind,
            objective: plan.task.objective,
            ...(nextStep
              ? {
                  nextStep: {
                    title: nextStep.title,
                    workKind: nextStep.workKind,
                    status: nextStep.status,
                    target: nextStep.target
                      ? {
                          kind: nextStep.target.kind,
                          name: nextStep.target.name,
                        }
                      : null,
                  },
                }
              : {}),
          },
        }
      : {};
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    throwIfAgentAborted(request.signal);
    const definition = this.listDefinitions(request.context).find(
      (candidate) => candidate.name === request.name,
    );
    if (!definition) {
      return {
        ok: false,
        error: `Tool "${request.name}" is not a long-task runtime tool.`,
      };
    }
    if (definition.access !== request.access) {
      return {
        ok: false,
        error: `Tool "${request.name}" access does not match its runtime definition.`,
      };
    }
    const checked = definition.validateInput(request.arguments);
    if (!checked.ok) return { ok: false, error: checked.error };
    const projectId = projectIdFromContext(request.context);
    if (!projectId) {
      return {
        ok: false,
        error: 'A project-owned runtime route is required for task plans.',
      };
    }
    const scope = { projectId, sessionId: request.sessionId };

    try {
      if (request.name === AGENT_LONG_TASK_READ_TOOL) {
        const input = request.arguments as {
          taskId?: string;
          offset?: number;
          limit?: number;
        };
        const plan = input.taskId
          ? await this.repository.getPlan(scope, input.taskId)
          : await this.repository.getOpenPlan(scope);
        throwIfAgentAborted(request.signal);
        if (!plan) {
          return {
            ok: true,
            data: {
              schemaVersion: 1,
              task: null,
              message: 'No matching durable task plan exists.',
            },
            modelData: '当前没有进行中的任务清单。',
          };
        }
        const manifestState = await this.repository.getChapterManifestState(scope, plan.task.id);
        const projection = projectAgentLongTaskPlanForProvider(plan, {
          offset: input.offset ?? 0,
          limit: input.limit ?? 32,
          manifestState,
          ...(this.resolveCurrentChapterName
            ? {
                resolveCurrentChapterName: this.resolveCurrentChapterName,
              }
            : {}),
        });
        return {
          ok: true,
          data: projection,
          modelData: taskPlanModelData(projection),
        };
      }

      const command = await this.toCommand(request, projectId);
      throwIfAgentAborted(request.signal);
      const result = await this.repository.applyCommand(
        {
          projectId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          callId: request.callId,
          toolCallId: runtimeToolCallId(request),
          idempotencyKey: request.idempotencyKey,
          createdAt: this.now(),
        },
        command,
      );
      const manifestState = await this.repository.getChapterManifestState(
        scope,
        result.plan.task.id,
      );
      const projection = projectAgentLongTaskPlanForProvider(result.plan, {
        manifestState,
        ...(this.resolveCurrentChapterName
          ? {
              resolveCurrentChapterName: this.resolveCurrentChapterName,
            }
          : {}),
      });
      // Do not observe abort after commit: the write is durable and must return
      // its committed result to the runtime scheduler.
      return {
        ok: true,
        data: {
          replayed: result.outcome === 'duplicate',
          ...projection,
          ...(result.changedStepId ? { changedStepId: result.changedStepId } : {}),
          ...(result.changedConstraintId
            ? {
                changedConstraintId: result.changedConstraintId,
              }
            : {}),
          ...(result.manifestReconciliation
            ? { manifestReconciliation: result.manifestReconciliation }
            : {}),
        },
        modelData: taskPlanModelData(projection),
      };
    } catch (error) {
      if (isAgentAbort(error, request.signal)) throw error;
      if (error instanceof AgentRuntimeLongTaskConflictError) {
        return {
          ok: false,
          error: `${error.code}: ${error.message}`,
        };
      }
      console.error('[agent] long-task runtime operation failed', error);
      return {
        ok: false,
        error: 'Long-task runtime operation failed.',
      };
    }
  }

  private async resolveSteps(
    projectId: string,
    input: readonly ProviderStepSeed[],
    objective: string,
    taskWorkKind: 'edit' | 'review',
  ): Promise<AgentRuntimeTaskStepSeed[]> {
    const normalized = input.map((step) => ({
      ...step,
      workKind: normalizedProviderStepWorkKind(step, objective) ?? taskWorkKind,
    }));
    const deliverables =
      taskWorkKind === 'edit' && includesAuthoredMutation(objective)
        ? normalized.filter((step) => !isProcessOnlyEditStep(step))
        : normalized;
    if (deliverables.length === 0) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        '编辑任务清单只能列作者可验收的保存结果。请把阅读、资料收集和普通自检放进相关修改步骤，而不是单列清单项。',
      );
    }
    const siblingTargetNames = [
      ...new Set(deliverables.map((step) => step.target.name.trim()).filter(Boolean)),
    ];
    return Promise.all(
      deliverables.map(async (step) => ({
        title: normalizedProviderStepTitle(step, siblingTargetNames),
        workKind: step.workKind,
        target: step.target
          ? {
              kind: step.target.kind,
              name: step.target.name.trim(),
              resolvedTargetId: this.resolveTarget
                ? await this.resolveTarget({
                    projectId,
                    kind: step.target.kind,
                    name: step.target.name.trim(),
                  })
                : null,
            }
          : null,
      })),
    );
  }

  private async freezeWholeBookChapterManifest(
    projectId: string,
  ): Promise<AgentRuntimeTaskChapterManifestSeed[]> {
    if (!this.getWholeBookChapterManifest) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'The product did not provide a canonical whole-book chapter manifest.',
      );
    }
    const chapters = await this.getWholeBookChapterManifest({ projectId });
    if (chapters.length === 0) {
      throw new AgentRuntimeLongTaskConflictError(
        'TASK_PLAN_INVALID',
        'The current project has no chapters to freeze into a whole-book task.',
      );
    }
    const seenChapterIds = new Set<string>();
    return chapters.map((chapter, index) => {
      const name = chapter.name.trim();
      const resolvedChapterId = chapter.resolvedChapterId.trim();
      if (
        chapter.ordinal !== index ||
        !name ||
        !resolvedChapterId ||
        seenChapterIds.has(resolvedChapterId)
      ) {
        throw new AgentRuntimeLongTaskConflictError(
          'TASK_PLAN_INVALID',
          'The product returned an invalid or duplicate whole-book chapter manifest.',
        );
      }
      seenChapterIds.add(resolvedChapterId);
      return {
        ordinal: index,
        name,
        resolvedChapterId,
      };
    });
  }

  private async resolvePlanIdentity(
    request: AgentToolExecutionRequest,
    projectId: string,
    taskId?: string,
    expectedRevision?: number,
  ): Promise<{ taskId: string; expectedRevision: number; plan: AgentRuntimeTaskPlan }> {
    const scope = { projectId, sessionId: request.sessionId };
    const plan = taskId
      ? await this.repository.getPlan(scope, taskId)
      : await this.repository.getOpenPlan(scope);
    if (!plan) {
      throw new AgentRuntimeLongTaskConflictError('TASK_NOT_FOUND', '当前没有可更新的任务清单。');
    }
    return {
      taskId: taskId ?? plan.task.id,
      expectedRevision: expectedRevision ?? plan.task.revision,
      plan,
    };
  }

  private async toCommand(
    request: AgentToolExecutionRequest,
    projectId: string,
  ): Promise<AgentRuntimeTaskCommand> {
    if (request.name === AGENT_LONG_TASK_PLAN_TOOL) {
      const input = request.arguments as unknown as UpdatePlanInput;
      if (input.operation === 'create') {
        if (input.scopeKind === 'whole_book_chapters') {
          if (!objectiveExplicitlyCoversWholeManuscript(input.objective)) {
            throw new AgentRuntimeLongTaskConflictError(
              'TASK_PLAN_INVALID',
              '这不是明确覆盖每一章的整本任务。开头若干章或其他有限范围请改用 explicit_targets，并为每个作者对象列一个步骤。',
            );
          }
          const chapterManifest = await this.freezeWholeBookChapterManifest(projectId);
          return {
            toolName: AGENT_LONG_TASK_PLAN_TOOL,
            operation: 'create',
            objective: input.objective.trim(),
            scopeKind: input.scopeKind,
            workKind: input.workKind ?? 'edit',
            chapterManifest,
            steps: chapterManifest.map((chapter) => ({
              title: `${(input.workKind ?? 'edit') === 'review' ? '检查' : '处理'}章节：${chapter.name}`,
              workKind: input.workKind ?? 'edit',
              target: {
                kind: 'chapter',
                name: chapter.name,
                resolvedTargetId: chapter.resolvedChapterId,
              },
            })),
            constraints: (input.constraints ?? []).map((body) => ({
              body: body.trim(),
              source: 'agent' as const,
            })),
          };
        }
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'create',
          objective: input.objective.trim(),
          scopeKind: input.scopeKind,
          workKind: input.workKind ?? 'edit',
          chapterManifest: [],
          steps: await this.resolveSteps(
            projectId,
            input.steps,
            input.objective,
            input.workKind ?? 'edit',
          ),
          constraints: (input.constraints ?? []).map((body) => ({
            body: body.trim(),
            source: 'agent' as const,
          })),
        };
      }
      if (input.operation === 'append_steps') {
        const identity = await this.resolvePlanIdentity(
          request,
          projectId,
          input.taskId,
          input.expectedRevision,
        );
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'append_steps',
          taskId: identity.taskId,
          expectedRevision: identity.expectedRevision,
          steps: await this.resolveSteps(
            projectId,
            input.steps,
            identity.plan.task.objective,
            identity.plan.task.workKind,
          ),
        };
      }
      if (input.operation === 'set_objective') {
        const identity = await this.resolvePlanIdentity(
          request,
          projectId,
          input.taskId,
          input.expectedRevision,
        );
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'set_objective',
          taskId: identity.taskId,
          expectedRevision: identity.expectedRevision,
          objective: input.objective.trim(),
        };
      }
      if (input.operation === 'reconcile_manifest') {
        const identity = await this.resolvePlanIdentity(
          request,
          projectId,
          input.taskId,
          input.expectedRevision,
        );
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'reconcile_manifest',
          taskId: identity.taskId,
          expectedRevision: identity.expectedRevision,
        };
      }
      const identity = await this.resolvePlanIdentity(
        request,
        projectId,
        input.taskId,
        input.expectedRevision,
      );
      return {
        toolName: AGENT_LONG_TASK_PLAN_TOOL,
        operation: 'set_status',
        taskId: identity.taskId,
        expectedRevision: identity.expectedRevision,
        status: input.status,
      };
    }

    if (request.name === AGENT_LONG_TASK_STEP_TOOL) {
      const input = request.arguments as {
        taskId?: string;
        expectedRevision?: number;
        stepId?: string;
        step?: string | number;
        status: AgentRuntimeTaskStepStatus;
        resultNote?: string | null;
        resultRef?: string | null;
        reviewResult?: AgentRuntimeTaskStepReviewResult | null;
      };
      const identity = await this.resolvePlanIdentity(
        request,
        projectId,
        input.taskId,
        input.expectedRevision,
      );
      const stepId = input.stepId ?? resolveChecklistStep(identity.plan, input.step!).id;
      return {
        toolName: AGENT_LONG_TASK_STEP_TOOL,
        taskId: identity.taskId,
        expectedRevision: identity.expectedRevision,
        stepId,
        status: input.status,
        resultNote: typeof input.resultNote === 'string' ? input.resultNote.trim() : null,
        resultRef: typeof input.resultRef === 'string' ? input.resultRef.trim() : null,
        reviewResult: input.reviewResult ?? null,
      };
    }

    const input = request.arguments as unknown as UpdateConstraintInput;
    if (input.operation === 'add') {
      return {
        toolName: AGENT_LONG_TASK_CONSTRAINT_TOOL,
        operation: 'add',
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        body: input.body.trim(),
        source: 'agent',
      };
    }
    if (input.operation === 'fulfill') {
      return {
        toolName: AGENT_LONG_TASK_CONSTRAINT_TOOL,
        operation: 'fulfill',
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        constraintId: input.constraintId,
      };
    }
    return {
      toolName: AGENT_LONG_TASK_CONSTRAINT_TOOL,
      operation: 'supersede',
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      constraintId: input.constraintId,
      replacementBody: input.replacementBody.trim(),
      replacementSource: 'agent',
    };
  }
}
