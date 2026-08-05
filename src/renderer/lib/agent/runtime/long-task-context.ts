import type {
  AgentRuntimeTaskChapterManifestState,
  AgentRuntimeTaskPlan,
  AgentRuntimeTaskScope,
} from '../../../domain/agent-runtime-long-task';
import type { AgentRuntimeLongTaskRepository } from '../../../sqlite-repo/agent-runtime-long-task-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import type { AgentContextSupplementalPinnedRow } from './context-message-adapter';
import type { AgentRuntimeContextPlanningHookInput } from './runtime-context-planning';

export const AGENT_LONG_TASK_PINNED_STEP_LIMIT = 1 as const;

function projectManifestStateForContext(state: AgentRuntimeTaskChapterManifestState) {
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
    needsExplicitReconciliation: state.status === 'drifted',
  };
}

function scopeFromHook(input: AgentRuntimeContextPlanningHookInput): AgentRuntimeTaskScope | null {
  const projectId =
    input.context.route.kind === 'test'
      ? input.context.route.projectId
      : input.context.route.projectId;
  return projectId ? { projectId, sessionId: input.sessionId } : null;
}

function progress(plan: AgentRuntimeTaskPlan) {
  return plan.steps.reduce(
    (counts, step) => {
      counts[step.status] += 1;
      return counts;
    },
    {
      pending: 0,
      in_progress: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      retired: 0,
    },
  );
}

function pinnedStepWindow(
  plan: AgentRuntimeTaskPlan,
  resolveCurrentChapterName?: (input: {
    projectId: string;
    resolvedChapterId: string;
  }) => string | null,
) {
  const inProgress = plan.steps.findIndex((step) => step.status === 'in_progress');
  const pending = plan.steps.findIndex((step) => step.status === 'pending');
  const firstActionable =
    inProgress >= 0
      ? inProgress
      : pending >= 0
        ? pending
        : plan.steps.findIndex((step) => step.status === 'blocked');
  const offset = firstActionable < 0 ? Math.max(0, plan.steps.length - 1) : firstActionable;
  return {
    offset,
    rows: plan.steps.slice(offset, offset + AGENT_LONG_TASK_PINNED_STEP_LIMIT).map((step) => {
      const currentName =
        step.target?.kind === 'chapter' && step.target.resolvedTargetId && resolveCurrentChapterName
          ? resolveCurrentChapterName({
              projectId: plan.task.projectId,
              resolvedChapterId: step.target.resolvedTargetId,
            })
          : undefined;
      const target = step.target
        ? {
            kind: step.target.kind,
            name:
              currentName === undefined || currentName === null ? step.target.name : currentName,
            ...(currentName === null
              ? { availability: 'missing' as const }
              : currentName !== undefined && currentName !== step.target.name
                ? { frozenName: step.target.name }
                : {}),
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
      };
    }),
  };
}

/**
 * Loads the current or most recently settled task and emits exact session-wide
 * runtime facts. Both rows are semantic-pinned by the context planner, so
 * verified compaction cannot summarize or discard the current progress pointer
 * or active constraints. Only the current deliverable is shown to the model;
 * the complete checklist remains durable for the product UI and advances one
 * item at a time.
 */
export function createAgentLongTaskSupplementalRowsHook(
  repository: AgentRuntimeLongTaskRepository,
  options: {
    resolveCurrentChapterName?: (input: {
      projectId: string;
      resolvedChapterId: string;
    }) => string | null;
  } = {},
): (
  input: AgentRuntimeContextPlanningHookInput,
) => Promise<readonly AgentContextSupplementalPinnedRow[]> {
  return async (input) => {
    const scope = scopeFromHook(input);
    if (!scope) return [];
    const plan = (await repository.getOpenPlan(scope)) ?? (await repository.getLatestPlan(scope));
    if (!plan) return [];
    const manifestState = await repository.getChapterManifestState(scope, plan.task.id);
    const commandEvidence = await repository.listCommandEvidence(scope, plan.task.id);
    const planCoverage = commandEvidence
      .filter(
        (evidence) =>
          evidence.toolName === 'update_task_plan' || evidence.toolName === 'update_task_step',
      )
      .map(({ turnOrdinal, callId, toolName }) => ({
        turnOrdinal,
        callId,
        toolName,
      }));
    const constraintCoverage = commandEvidence
      .filter((evidence) => evidence.toolName === 'update_task_constraint')
      .map(({ turnOrdinal, callId, toolName }) => ({
        turnOrdinal,
        callId,
        toolName,
      }));

    const window = pinnedStepWindow(plan, options.resolveCurrentChapterName);
    const activeConstraints = plan.constraints
      .filter((constraint) => constraint.status === 'active')
      .map((constraint) => ({
        constraintId: constraint.id,
        body: constraint.body,
        source: constraint.source,
      }));
    return [
      {
        sourceId: `long-task:${plan.task.id}:plan`,
        turnOrdinal: null,
        kind: 'task_plan',
        durableWriteCoverage: planCoverage,
        content: canonicalAgentRuntimeJson({
          schemaVersion: 4,
          task: {
            taskId: plan.task.id,
            objective: plan.task.objective,
            scopeKind: plan.task.scopeKind,
            workKind: plan.task.workKind,
            frozenChapterCount: plan.chapterManifest.length,
            status: plan.task.status,
            revision: plan.task.revision,
          },
          progress: {
            total: plan.steps.length,
            ...progress(plan),
          },
          chapterManifestState: projectManifestStateForContext(manifestState),
          stepWindow: {
            offset: window.offset,
            limit: AGENT_LONG_TASK_PINNED_STEP_LIMIT,
            returned: window.rows.length,
            total: plan.steps.length,
            currentStepOnly: true,
            steps: window.rows,
          },
          continuation: {
            instruction:
              'Prioritize the current authored deliverable shown here. Reuse evidence already returned and gather whatever concrete authored evidence is genuinely needed; avoid repeating discovery without a new reason. This focused projection is not a scope restriction: related authored objects may be inspected or modified when cross-object work requires it. Adopt reliable saved-change notes as progress, never repeat saved work, and mark this item completed once its authored result is saved. Compaction and restart preserve this handoff; continue until the checklist is complete or genuinely blocked.',
          },
        }),
      },
      {
        sourceId: `long-task:${plan.task.id}:constraints`,
        turnOrdinal: null,
        kind: 'task_constraints',
        durableWriteCoverage: constraintCoverage,
        content: canonicalAgentRuntimeJson({
          schemaVersion: 1,
          taskId: plan.task.id,
          taskRevision: plan.task.revision,
          activeConstraints,
        }),
      },
    ];
  };
}
