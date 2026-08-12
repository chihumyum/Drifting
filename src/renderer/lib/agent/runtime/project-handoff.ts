import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

import {
  AGENT_PROJECT_HANDOFF_SCHEMA_VERSION,
  type AgentProjectHandoff,
  type AgentProjectHandoffNameList,
  type AgentProjectHandoffStepSummary,
  type AgentProjectHandoffTaskSummary,
  type AgentProjectHandoffWriteSummary,
} from '../../../domain/agent-project-handoff';
import { getDb, type DbExecutor } from '../../../lib/db';
import {
  AgentConversationTable,
  AgentRuntimeSessionTable,
  AgentRuntimeTaskTable,
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteReviewTable,
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  ProjectTable,
  StorylineTable,
} from '../../../schema/drizzle';
import { createAgentRuntimeLongTaskRepository } from '../../../sqlite-repo/agent-runtime-long-task-repo';
import { describeAgentWriteTarget } from './workspace-domain-language';

export const AGENT_PROJECT_HANDOFF_TASK_LIMIT = 5 as const;
export const AGENT_PROJECT_HANDOFF_STEP_LIMIT = 12 as const;
export const AGENT_PROJECT_HANDOFF_NAME_LIMIT = 48 as const;
export const AGENT_PROJECT_HANDOFF_WRITE_LIMIT = 20 as const;
const HANDOFF_SHORT_TEXT_LIMIT = 240;
const HANDOFF_LONG_TEXT_LIMIT = 1_000;

export interface ReadAgentProjectHandoffInput {
  projectId: string;
  currentSessionId?: string;
}

export interface AgentProjectHandoffReader {
  read(input: ReadAgentProjectHandoffInput): Promise<AgentProjectHandoff>;
}

export interface AgentProjectHandoffServiceOptions {
  database?: DbExecutor;
  now?: () => string;
}

const RUNNING_SESSION_STATUSES = new Set(['pending', 'running', 'recovering']);

function handoffText(value: string, maxLength: number): string {
  const normalized = value.replaceAll('\u0000', '').replace(/\s+/gu, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function projectStep(step: {
  ordinal: number;
  title: string;
  workKind: AgentProjectHandoffStepSummary['workKind'];
  target: { kind: string; name: string } | null;
  status: AgentProjectHandoffStepSummary['status'];
}): AgentProjectHandoffStepSummary {
  return {
    ordinal: step.ordinal,
    title: handoffText(step.title, HANDOFF_LONG_TEXT_LIMIT),
    workKind: step.workKind,
    target: step.target
      ? {
          kind: handoffText(step.target.kind, HANDOFF_SHORT_TEXT_LIMIT),
          name: handoffText(step.target.name, HANDOFF_SHORT_TEXT_LIMIT),
        }
      : null,
    status: step.status,
  };
}

function progressForTask(
  steps: readonly { status: AgentProjectHandoffStepSummary['status'] }[],
): AgentProjectHandoffTaskSummary['progress'] {
  let completed = 0;
  let blocked = 0;
  let failed = 0;
  let retired = 0;
  for (const step of steps) {
    if (step.status === 'completed') completed += 1;
    else if (step.status === 'blocked') blocked += 1;
    else if (step.status === 'failed') failed += 1;
    else if (step.status === 'retired') retired += 1;
  }
  return {
    total: steps.length,
    completed,
    remaining: steps.length - completed - retired,
    blocked,
    failed,
    retired,
  };
}

function boundedNames(rows: readonly { name: string }[]): AgentProjectHandoffNameList {
  return {
    names: rows
      .slice(0, AGENT_PROJECT_HANDOFF_NAME_LIMIT)
      .map((row) => handoffText(row.name, HANDOFF_SHORT_TEXT_LIMIT)),
    truncated: rows.length > AGENT_PROJECT_HANDOFF_NAME_LIMIT,
  };
}

function reviewOutcome(status: string | null): AgentProjectHandoffWriteSummary['outcome'] | null {
  if (status === null) return 'committed';
  if (status === 'pending') return 'pending_review';
  if (status === 'accepted' || status === 'accepted_effect') return 'accepted';
  if (status === 'revert_failed' || status === 'revert_unavailable') {
    return 'attention_required';
  }
  // Rejected/reverting/reverted prose is not reliable completed work.
  return null;
}

export function createAgentProjectHandoffService(
  options: AgentProjectHandoffServiceOptions = {},
): AgentProjectHandoffReader {
  const dbProvider = (): DbExecutor => options.database ?? getDb();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async read(input) {
      const database = dbProvider();
      const projectRows = await database
        .select({ name: ProjectTable.name })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectId))
        .limit(1);

      const taskPredicates = [
        eq(AgentRuntimeTaskTable.projectId, input.projectId),
        inArray(AgentRuntimeTaskTable.status, ['active', 'paused', 'blocked']),
        eq(AgentRuntimeSessionTable.routeKind, 'chat'),
        isNull(AgentConversationTable.deletedAt),
      ];
      if (input.currentSessionId) {
        taskPredicates.push(ne(AgentRuntimeTaskTable.sessionId, input.currentSessionId));
      }
      const taskRows = await database
        .select({
          taskId: AgentRuntimeTaskTable.id,
          sessionId: AgentRuntimeTaskTable.sessionId,
          sessionStatus: AgentRuntimeSessionTable.status,
          conversationTitle: AgentConversationTable.title,
        })
        .from(AgentRuntimeTaskTable)
        .innerJoin(
          AgentRuntimeSessionTable,
          and(
            eq(AgentRuntimeSessionTable.id, AgentRuntimeTaskTable.sessionId),
            eq(AgentRuntimeSessionTable.projectId, AgentRuntimeTaskTable.projectId),
          ),
        )
        .innerJoin(
          AgentConversationTable,
          and(
            eq(AgentConversationTable.id, AgentRuntimeSessionTable.conversationId),
            eq(AgentConversationTable.projectId, AgentRuntimeTaskTable.projectId),
          ),
        )
        .where(and(...taskPredicates))
        .orderBy(desc(AgentRuntimeTaskTable.updatedAt), desc(AgentRuntimeTaskTable.id))
        .limit(AGENT_PROJECT_HANDOFF_TASK_LIMIT + 1);

      const longTasks = createAgentRuntimeLongTaskRepository(database);
      const tasks: AgentProjectHandoffTaskSummary[] = [];
      for (const row of taskRows.slice(0, AGENT_PROJECT_HANDOFF_TASK_LIMIT)) {
        const plan = await longTasks.getPlan(
          { projectId: input.projectId, sessionId: row.sessionId },
          row.taskId,
        );
        if (!plan || !['active', 'paused', 'blocked'].includes(plan.task.status)) continue;
        const completed = plan.steps.filter((step) => step.status === 'completed');
        const remaining = plan.steps.filter(
          (step) => step.status !== 'completed' && step.status !== 'retired',
        );
        tasks.push({
          sourceConversationTitle:
            handoffText(row.conversationTitle, HANDOFF_SHORT_TEXT_LIMIT) || '未命名会话',
          sourceSessionRunning: RUNNING_SESSION_STATUSES.has(row.sessionStatus),
          objective: handoffText(plan.task.objective, HANDOFF_LONG_TEXT_LIMIT),
          scopeKind: plan.task.scopeKind,
          workKind: plan.task.workKind,
          status: plan.task.status as AgentProjectHandoffTaskSummary['status'],
          updatedAt: plan.task.updatedAt,
          progress: progressForTask(plan.steps),
          activeConstraints: plan.constraints
            .filter((constraint) => constraint.status === 'active')
            .slice(0, 32)
            .map((constraint) => handoffText(constraint.body, HANDOFF_LONG_TEXT_LIMIT)),
          completedSteps: completed.slice(-AGENT_PROJECT_HANDOFF_STEP_LIMIT).map(projectStep),
          remainingSteps: remaining.slice(0, AGENT_PROJECT_HANDOFF_STEP_LIMIT).map(projectStep),
          stepsTruncated:
            completed.length > AGENT_PROJECT_HANDOFF_STEP_LIMIT ||
            remaining.length > AGENT_PROJECT_HANDOFF_STEP_LIMIT,
        });
      }

      const chapterRows = await database
        .select({ name: BookNodeTable.title })
        .from(BookNodeTable)
        .where(
          and(
            eq(BookNodeTable.projectId, input.projectId),
            eq(BookNodeTable.kind, 'chapter'),
            isNull(BookNodeTable.deletedAt),
          ),
        )
        .orderBy(asc(BookNodeTable.bookOrder), asc(BookNodeTable.title))
        .limit(AGENT_PROJECT_HANDOFF_NAME_LIMIT + 1);
      const inspirationRows = await database
        .select({ name: BookNodeTable.title })
        .from(BookNodeTable)
        .where(
          and(
            eq(BookNodeTable.projectId, input.projectId),
            eq(BookNodeTable.kind, 'drift'),
            isNull(BookNodeTable.deletedAt),
          ),
        )
        .orderBy(asc(BookNodeTable.title))
        .limit(AGENT_PROJECT_HANDOFF_NAME_LIMIT + 1);
      const elementRows = await database
        .select({ name: BookElementTable.name })
        .from(BookElementTable)
        .where(
          and(eq(BookElementTable.projectId, input.projectId), isNull(BookElementTable.deletedAt)),
        )
        .orderBy(asc(BookElementTable.name))
        .limit(AGENT_PROJECT_HANDOFF_NAME_LIMIT + 1);
      const categoryRows = await database
        .select({ name: ElementCategoryTable.name })
        .from(ElementCategoryTable)
        .where(
          and(
            eq(ElementCategoryTable.projectId, input.projectId),
            isNull(ElementCategoryTable.deletedAt),
          ),
        )
        .orderBy(asc(ElementCategoryTable.name))
        .limit(AGENT_PROJECT_HANDOFF_NAME_LIMIT + 1);
      const storylineRows = await database
        .select({ name: StorylineTable.name })
        .from(StorylineTable)
        .where(and(eq(StorylineTable.projectId, input.projectId), isNull(StorylineTable.deletedAt)))
        .orderBy(asc(StorylineTable.orderKey), asc(StorylineTable.name))
        .limit(AGENT_PROJECT_HANDOFF_NAME_LIMIT + 1);

      const writePredicates = [
        eq(AgentRuntimeWriteEffectTable.projectId, input.projectId),
        eq(AgentRuntimeWriteEffectTable.routeKind, 'chat'),
        eq(AgentRuntimeWriteEffectTable.phase, 'result_committed'),
        isNull(AgentConversationTable.deletedAt),
      ];
      if (input.currentSessionId) {
        writePredicates.push(ne(AgentRuntimeWriteEffectTable.sessionId, input.currentSessionId));
      }
      const writeRows = await database
        .select({
          toolName: AgentRuntimeWriteEffectTable.toolName,
          argumentsJson: AgentRuntimeWriteEffectTable.argumentsJson,
          updatedAt: AgentRuntimeWriteEffectTable.updatedAt,
          reviewStatus: AgentRuntimeWriteReviewTable.status,
          conversationTitle: AgentConversationTable.title,
        })
        .from(AgentRuntimeWriteEffectTable)
        .innerJoin(
          AgentRuntimeSessionTable,
          and(
            eq(AgentRuntimeSessionTable.id, AgentRuntimeWriteEffectTable.sessionId),
            eq(AgentRuntimeSessionTable.projectId, AgentRuntimeWriteEffectTable.projectId),
          ),
        )
        .innerJoin(
          AgentConversationTable,
          and(
            eq(AgentConversationTable.id, AgentRuntimeSessionTable.conversationId),
            eq(AgentConversationTable.projectId, AgentRuntimeWriteEffectTable.projectId),
          ),
        )
        .leftJoin(
          AgentRuntimeWriteReviewTable,
          eq(AgentRuntimeWriteReviewTable.effectId, AgentRuntimeWriteEffectTable.id),
        )
        .where(and(...writePredicates))
        .orderBy(
          desc(AgentRuntimeWriteEffectTable.updatedAt),
          desc(AgentRuntimeWriteEffectTable.id),
        )
        .limit(AGENT_PROJECT_HANDOFF_WRITE_LIMIT * 4);

      const recentWrites: AgentProjectHandoffWriteSummary[] = [];
      const seenTargets = new Set<string>();
      let eligibleWriteCount = 0;
      for (const row of writeRows) {
        const outcome = reviewOutcome(row.reviewStatus ?? null);
        if (!outcome) continue;
        let arguments_: unknown;
        try {
          arguments_ = JSON.parse(row.argumentsJson) as unknown;
        } catch {
          continue;
        }
        const target = describeAgentWriteTarget(row.toolName, arguments_);
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        eligibleWriteCount += 1;
        if (recentWrites.length >= AGENT_PROJECT_HANDOFF_WRITE_LIMIT) continue;
        recentWrites.push({
          sourceConversationTitle:
            handoffText(row.conversationTitle, HANDOFF_SHORT_TEXT_LIMIT) || '未命名会话',
          target: handoffText(target, HANDOFF_LONG_TEXT_LIMIT),
          outcome,
          updatedAt: row.updatedAt,
        });
      }

      return {
        schemaVersion: AGENT_PROJECT_HANDOFF_SCHEMA_VERSION,
        snapshotAt: now(),
        projectName: projectRows[0]
          ? handoffText(projectRows[0].name, HANDOFF_SHORT_TEXT_LIMIT)
          : null,
        tasks,
        taskLimitReached: taskRows.length > AGENT_PROJECT_HANDOFF_TASK_LIMIT,
        currentNames: {
          chapters: boundedNames(chapterRows),
          inspirations: boundedNames(inspirationRows),
          elements: boundedNames(elementRows),
          categories: boundedNames(categoryRows),
          storylines: boundedNames(storylineRows),
        },
        recentWrites,
        writeLimitReached: eligibleWriteCount > AGENT_PROJECT_HANDOFF_WRITE_LIMIT,
      };
    },
  };
}

export async function readAgentProjectHandoff(
  input: ReadAgentProjectHandoffInput,
): Promise<AgentProjectHandoff> {
  return createAgentProjectHandoffService().read(input);
}

export function agentProjectHandoffModelData(handoff: AgentProjectHandoff): string {
  if (handoff.tasks.length === 0 && handoff.recentWrites.length === 0) {
    return '当前项目没有可接力的其他会话任务或可靠写入。';
  }
  const taskLines = handoff.tasks.map((task) => {
    const running = task.sourceSessionRunning ? '，来源会话仍在运行' : '';
    return `- 「${task.sourceConversationTitle}」：${task.objective}（${task.progress.completed}/${task.progress.total} 项完成${running}）`;
  });
  const writeLines = handoff.recentWrites.slice(0, 12).map((write) => {
    const outcome =
      write.outcome === 'pending_review'
        ? '等待作者审阅'
        : write.outcome === 'attention_required'
          ? '需要作者处理'
          : '已有可靠保存结果';
    return `- ${write.target}：${outcome}`;
  });
  return [
    '这是同一项目其他会话的只读接力快照。它不转移计划、权限或控制权，也不能代替写入前的当前对象读取与 revision 检查。',
    ...(taskLines.length > 0 ? ['未完成任务：', ...taskLines] : []),
    ...(writeLines.length > 0 ? ['最近写入：', ...writeLines] : []),
  ].join('\n');
}
