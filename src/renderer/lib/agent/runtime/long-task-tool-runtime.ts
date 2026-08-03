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

const targetSchema = Type.Object(
  {
    kind: Type.Union(TARGET_KINDS.map((kind) => Type.Literal(kind))),
    name: Type.String({ minLength: 1, maxLength: 240 }),
  },
  { additionalProperties: false },
);

const workKindSchema = Type.Union([Type.Literal('edit'), Type.Literal('review')]);
const stepWorkKindSchema = Type.Union([
  Type.Literal('edit'),
  Type.Literal('review'),
  Type.Literal('research'),
]);

const stepSeedSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    workKind: Type.Optional(stepWorkKindSchema),
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
      steps: Type.Array(stepSeedSchema, {
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
      steps: Type.Array(stepSeedSchema, {
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
      Type.Array(stepSeedSchema, {
        minItems: 1,
        maxItems: 128,
      }),
    ),
    constraints: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), {
        maxItems: 32,
      }),
    ),
    taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
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
      taskId: string;
      expectedRevision: number;
      steps: ProviderStepSeed[];
    }
  | {
      operation: 'set_objective';
      taskId: string;
      expectedRevision: number;
      objective: string;
    }
  | {
      operation: 'reconcile_manifest';
      taskId: string;
      expectedRevision: number;
    }
  | {
      operation: 'set_status';
      taskId: string;
      expectedRevision: number;
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
        'Resume this same task after compaction or restart. Continue in_progress first, then pending work; revisit blocked review steps only after their status changes. Never repeat completed steps; continue until the plan is complete or progress is genuinely blocked.',
    },
  };
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
          'Read the durable task plan for this runtime session. Use pagination for a long whole-book plan.',
        inputSchema: readPlanSchema,
        access: 'read',
        validateInput: (input) => validation(readPlanSchema, input),
      },
      {
        name: AGENT_LONG_TASK_PLAN_TOOL,
        description:
          'Task-level operations only: create, extend, rename, reconcile a changed whole-book chapter manifest, pause, block, fail, or complete the durable long-task plan. NEVER change an individual step with this tool; update_task_step is the only step-status tool. operation=create requires scopeKind, objective, and an explicit task workKind: edit is the default for effect-producing work; review is the default for exact-source review. Each explicit-target step may override workKind with research, edit, or review. Use a bounded research step for preparatory exploration, then separate edit/review steps for effects or conclusions; do not turn initial discovery into an unfinishable "read the entire workspace" step when concrete follow-up units are already known. Use whole_book_chapters only when the author explicitly asks for every chapter/the whole book. A chosen subset or count such as five chapters MUST use explicit_targets with one named step per target. explicit_targets requires steps; whole_book_chapters must omit steps so the runtime freezes canonical chapter order. append_steps requires taskId, expectedRevision, and steps. set_objective requires taskId, expectedRevision, and objective. reconcile_manifest requires taskId and expectedRevision and is mandatory when read_task_plan reports chapterManifestState.status=drifted. set_status requires taskId, expectedRevision, and status. Never pass a chapter or drift UUID.',
        inputSchema: updatePlanProviderSchema,
        access: 'write',
        validateInput: (input) => validation(updatePlanCommandSchema, input),
      },
      {
        name: AGENT_LONG_TASK_STEP_TOOL,
        description:
          'The only tool for changing an individual durable step status. Advance exactly one step with taskId, expectedRevision, stepId, status; there is no set_step_status operation on update_task_plan. Independent step calls may share the revision read before a parallel batch: Drifting revalidates each named step against the current plan and safely rebases only non-conflicting step transitions. Only one step may be in_progress, but a pending step may be completed directly when its work already finished. Drifting owns resultRef: omit it for edit, review, and research completion. For edit, Drifting binds an unclaimed accepted durable workspace write for that exact target made during the current task, including work completed before a newly discovered step was appended. For review, read the named prose target when there is one, or the relevant project sources for a book/project/category review, then provide structured reviewResult. For research, perform at least one successful relevant workspace read and provide a non-empty resultNote without reviewResult. Every review claim/finding needs an exact source quote.',
        inputSchema: updateStepSchema,
        access: 'write',
        validateInput: (input) => validation(updateStepSchema, input),
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
          };
        }
        const manifestState = await this.repository.getChapterManifestState(scope, plan.task.id);
        return {
          ok: true,
          data: projectAgentLongTaskPlanForProvider(plan, {
            offset: input.offset ?? 0,
            limit: input.limit ?? 32,
            manifestState,
            ...(this.resolveCurrentChapterName
              ? {
                  resolveCurrentChapterName: this.resolveCurrentChapterName,
                }
              : {}),
          }),
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
      // Do not observe abort after commit: the write is durable and must return
      // its committed result to the runtime scheduler.
      return {
        ok: true,
        data: {
          replayed: result.outcome === 'duplicate',
          ...projectAgentLongTaskPlanForProvider(result.plan, {
            manifestState,
            ...(this.resolveCurrentChapterName
              ? {
                  resolveCurrentChapterName: this.resolveCurrentChapterName,
                }
              : {}),
          }),
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
  ): Promise<AgentRuntimeTaskStepSeed[]> {
    return Promise.all(
      input.map(async (step) => ({
        title: step.title.trim(),
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

  private async toCommand(
    request: AgentToolExecutionRequest,
    projectId: string,
  ): Promise<AgentRuntimeTaskCommand> {
    if (request.name === AGENT_LONG_TASK_PLAN_TOOL) {
      const input = request.arguments as unknown as UpdatePlanInput;
      if (input.operation === 'create') {
        if (input.scopeKind === 'whole_book_chapters') {
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
          steps: await this.resolveSteps(projectId, input.steps),
          constraints: (input.constraints ?? []).map((body) => ({
            body: body.trim(),
            source: 'agent' as const,
          })),
        };
      }
      if (input.operation === 'append_steps') {
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'append_steps',
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          steps: await this.resolveSteps(projectId, input.steps),
        };
      }
      if (input.operation === 'set_objective') {
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'set_objective',
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          objective: input.objective.trim(),
        };
      }
      if (input.operation === 'reconcile_manifest') {
        return {
          toolName: AGENT_LONG_TASK_PLAN_TOOL,
          operation: 'reconcile_manifest',
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
        };
      }
      return {
        toolName: AGENT_LONG_TASK_PLAN_TOOL,
        operation: 'set_status',
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        status: input.status,
      };
    }

    if (request.name === AGENT_LONG_TASK_STEP_TOOL) {
      const input = request.arguments as {
        taskId: string;
        expectedRevision: number;
        stepId: string;
        status: AgentRuntimeTaskStepStatus;
        resultNote?: string | null;
        resultRef?: string | null;
        reviewResult?: AgentRuntimeTaskStepReviewResult | null;
      };
      return {
        toolName: AGENT_LONG_TASK_STEP_TOOL,
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        stepId: input.stepId,
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
