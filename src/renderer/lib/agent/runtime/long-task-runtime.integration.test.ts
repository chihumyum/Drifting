import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentRuntimeTaskCommand,
  AgentRuntimeTaskCommandProvenance,
} from '../../../domain/agent-runtime-long-task';
import {
  AgentRuntimeLongTaskConflictError,
  createAgentRuntimeLongTaskRepository,
} from '../../../sqlite-repo/agent-runtime-long-task-repo';
import { createAgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { createAgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  agentModelMessagesToContextSources,
  planAgentModelContext,
} from './context-message-adapter';
import { classifyAgentContextSource } from './context-planner';
import { createAgentLongTaskSupplementalRowsHook } from './long-task-context';
import {
  AgentLongTaskToolRuntime,
  AGENT_LONG_TASK_CONSTRAINT_TOOL,
  AGENT_LONG_TASK_PLAN_TOOL,
  projectAgentLongTaskPlanForProvider,
} from './long-task-tool-runtime';
import type { AgentRuntimeContextPlanningHookInput } from './runtime-context-planning';
import type { AgentModelMessage, AgentToolExecutionRequest } from './types';
import { ProductFileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';

const PROJECT_ID = 'project-long-task';
const SESSION_ID = 'session-long-task';
const TURN_ID = 'turn-long-task';
const NOW = '2026-07-31T00:00:00.000Z';

interface Fixture {
  directory: string;
  databasePath: string;
  gateway: ProductFileBackedSqliteGateway;
  nextProvenance(
    toolName:
      | 'update_task_plan'
      | 'update_task_step'
      | 'update_task_constraint'
      | 'update_project_facts'
      | 'edit_block'
      | 'rename_node',
    scope?: {
      projectId: string;
      sessionId: string;
      turnId: string;
    },
  ): AgentRuntimeTaskCommandProvenance;
}

const directories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-long-task-'));
  directories.add(directory);
  const databasePath = path.join(directory, 'drifting.db');
  const gateway = new ProductFileBackedSqliteGateway(databasePath);
  const db = gateway.database;
  db.prepare(
    `INSERT INTO project (id, name, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(PROJECT_ID, 'Long task project', 'user-1', NOW, NOW);
  db.prepare(
    `INSERT INTO agent_conversation (
       id, project_id, title, mode, messages_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('conversation-long-task', PROJECT_ID, 'Whole-book polish', 'byok', '[]', NOW, NOW);
  db.prepare(
    `INSERT INTO agent_runtime_session (
       id, project_id, route_kind, conversation_id, provider, provider_epoch,
       status, created_at, updated_at
     ) VALUES (?, ?, 'chat', ?, 'deepseek', 0, 'running', ?, ?)`,
  ).run(SESSION_ID, PROJECT_ID, 'conversation-long-task', NOW, NOW);
  db.prepare(
    `INSERT INTO agent_runtime_turn (
       id, session_id, ordinal, status, accepted_at, started_at, updated_at
     ) VALUES (?, ?, 0, 'running', ?, ?, ?)`,
  ).run(TURN_ID, SESSION_ID, NOW, NOW, NOW);
  replaceCanonicalChapters(gateway, WHOLE_BOOK_MANIFEST);

  let callOrdinal = 0;
  return {
    directory,
    databasePath,
    gateway,
    nextProvenance(toolName, scope) {
      callOrdinal += 1;
      const owner = scope ?? {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
      };
      const callId = `task-call-${callOrdinal}`;
      const idempotencyKey = `${owner.sessionId}:${owner.turnId}:${callId}`;
      const toolCallId = `agent-tool:${owner.sessionId}:${owner.turnId}:${callId}`;
      db.prepare(
        `INSERT INTO agent_runtime_tool_call (
           id, session_id, turn_id, call_id, name, access, status,
           idempotency_key, arguments_json, created_at, started_at
         ) VALUES (?, ?, ?, ?, ?, 'write', 'running', ?, '{}', ?, ?)`,
      ).run(toolCallId, owner.sessionId, owner.turnId, callId, toolName, idempotencyKey, NOW, NOW);
      return {
        ...owner,
        callId,
        toolCallId,
        idempotencyKey,
        createdAt: NOW,
      };
    },
  };
}

function replaceCanonicalChapters(
  gateway: ProductFileBackedSqliteGateway,
  manifest: readonly {
    ordinal: number;
    name: string;
    resolvedChapterId: string;
  }[],
): void {
  const db = gateway.database;
  db.prepare('DELETE FROM book_node WHERE project_id = ?').run(PROJECT_ID);
  const insert = db.prepare(
    `INSERT INTO book_node (
       id, title, book_order, project_id, kind, created_at, updated_at,
       position_x, position_y
     ) VALUES (?, ?, ?, ?, 'chapter', ?, ?, 0, 0)`,
  );
  for (const chapter of manifest) {
    insert.run(chapter.resolvedChapterId, chapter.name, chapter.ordinal, PROJECT_ID, NOW, NOW);
  }
}

function idFactory() {
  let ordinal = 0;
  return (kind: 'task' | 'step' | 'constraint') => `${kind}-${++ordinal}`;
}

function createCommand(): Extract<
  AgentRuntimeTaskCommand,
  { toolName: 'update_task_plan'; operation: 'create' }
> {
  return {
    toolName: 'update_task_plan',
    operation: 'create',
    objective: '逐章润色整本小说，同时保持人物语气与事实一致',
    scopeKind: 'explicit_targets',
    chapterManifest: [],
    steps: [
      {
        title: '润色第一章',
        target: {
          kind: 'chapter',
          name: '第一章 雨夜',
          resolvedTargetId: 'node-secret-1',
        },
      },
      {
        title: '润色第二章',
        target: {
          kind: 'chapter',
          name: '第二章 来客',
          resolvedTargetId: 'node-secret-2',
        },
      },
    ],
    constraints: [
      {
        body: '不得改变已经确立的世界观事实',
        source: 'author',
      },
    ],
  };
}

const WHOLE_BOOK_MANIFEST = [
  {
    ordinal: 0,
    name: '第一章 雨夜',
    resolvedChapterId: 'node-secret-1',
  },
  {
    ordinal: 1,
    name: '第二章 来客',
    resolvedChapterId: 'node-secret-2',
  },
] as const;

function wholeBookCommand(): Extract<
  AgentRuntimeTaskCommand,
  { toolName: 'update_task_plan'; operation: 'create' }
> {
  return {
    toolName: 'update_task_plan',
    operation: 'create',
    objective: '逐章润色整本小说',
    scopeKind: 'whole_book_chapters',
    chapterManifest: WHOLE_BOOK_MANIFEST.map((chapter) => ({
      ...chapter,
    })),
    steps: WHOLE_BOOK_MANIFEST.map((chapter) => ({
      title: `处理章节：${chapter.name}`,
      target: {
        kind: 'chapter',
        name: chapter.name,
        resolvedTargetId: chapter.resolvedChapterId,
      },
    })),
    constraints: [],
  };
}

async function createAcceptedWriteReview(
  test: Fixture,
  input: {
    chapterId: string;
    chapterName: string;
    toolName?: 'edit_block' | 'rename_node';
  },
): Promise<string> {
  const toolName = input.toolName ?? 'edit_block';
  const provenance = test.nextProvenance(toolName);
  const repository = createAgentRuntimeWriteEffectRepository(test.gateway.client());
  const arguments_ = {
    node: input.chapterName,
    block: 0,
    text: '润色后的段落',
  };
  test.gateway.database
    .prepare('UPDATE agent_runtime_tool_call SET arguments_json = ? WHERE id = ?')
    .run(canonicalAgentRuntimeJson(arguments_), provenance.toolCallId);
  const effectId = `accepted-effect:${provenance.callId}`;
  const effect = (
    await repository.claimEffect({
      id: effectId,
      projectId: provenance.projectId,
      routeKind: 'chat',
      conversationId: 'conversation-long-task',
      goalRunId: null,
      chapterId: null,
      sessionId: provenance.sessionId,
      turnId: provenance.turnId,
      toolCallId: provenance.toolCallId,
      callId: provenance.callId,
      toolName,
      idempotencyKey: provenance.idempotencyKey,
      authorization: {
        kind: 'automatic',
        requestId: null,
        argumentsHash: 'sha256:test-arguments',
        authorizedAt: NOW,
      },
      arguments: arguments_,
      expectedRevision: null,
      claimedAt: NOW,
    })
  ).effect;
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'claimed',
    nextPhase: 'confirmed',
    at: NOW,
  });
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'confirmed',
    nextPhase: 'mutation_started',
    observedRevision: null,
    preimage: { text: '原段落' },
    forward: { text: '润色后的段落' },
    inverse: { text: '原段落' },
    reversibility: 'exact',
    at: NOW,
  });
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'mutation_started',
    nextPhase: 'effect_committed',
    effect: { chapterId: input.chapterId },
    at: NOW,
  });
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'effect_committed',
    nextPhase: 'result_committed',
    result: { ok: true, chapterId: input.chapterId },
    at: NOW,
  });
  const reviewId = `accepted-review:${provenance.callId}`;
  await repository.createReview({
    id: reviewId,
    effectId: effect.id,
    sessionId: effect.sessionId,
    turnId: effect.turnId,
    toolCallId: effect.toolCallId,
    createdAt: NOW,
  });
  await repository.transitionReview({
    reviewId,
    expectedStatus: 'pending',
    nextStatus: 'accepted',
    decisionNote: 'accepted in test',
    at: NOW,
  });
  await repository.transitionReview({
    reviewId,
    expectedStatus: 'accepted',
    nextStatus: 'accepted_effect',
    at: NOW,
  });
  return reviewId;
}

async function createChapterReadReceipt(
  test: Fixture,
  input: { chapterId: string; chapterName: string; prose: string; ordinal: number },
): Promise<string> {
  const callId = `review-read-${input.ordinal}`;
  const idempotencyKey = `${SESSION_ID}:${TURN_ID}:${callId}`;
  const toolCallId = `agent-tool:${SESSION_ID}:${TURN_ID}:${callId}`;
  const receiptId = `review-receipt-${input.ordinal}`;
  const arguments_ = { node: input.chapterName, kind: 'chapter', prose: true };
  test.gateway.database
    .prepare(
      `INSERT INTO agent_runtime_tool_call (
         id, session_id, turn_id, call_id, name, access, status,
         idempotency_key, arguments_json, created_at, started_at
       ) VALUES (?, ?, ?, ?, 'read_node', 'read', 'running', ?, ?, ?, ?)`,
    )
    .run(
      toolCallId,
      SESSION_ID,
      TURN_ID,
      callId,
      idempotencyKey,
      canonicalAgentRuntimeJson(arguments_),
      NOW,
      NOW,
    );
  const freshness = createAgentRuntimeFreshnessRepository(test.gateway.client());
  await freshness.persistReadReceipt({
    id: receiptId,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    toolCallId,
    callId,
    toolName: 'read_node',
    idempotencyKey,
    result: {
      result: {
        node: { kind: 'chapter', name: input.chapterName },
        prose: {
          blocks: [
            {
              block: 1,
              blockId: `block-${input.ordinal}`,
              text: input.prose,
            },
          ],
        },
      },
      freshness: {
        receiptId,
        observations: [
          {
            id: `review-observation-${input.ordinal}`,
            entityKind: 'node_prose',
            entityId: input.chapterId,
            revision: `yjs:${input.ordinal + 1}`,
          },
        ],
      },
    },
    observations: [
      {
        id: `review-observation-${input.ordinal}`,
        entityKind: 'node_prose',
        entityId: input.chapterId,
        revision: `yjs:${input.ordinal + 1}`,
      },
    ],
    createdAt: NOW,
  });
  test.gateway.database
    .prepare(
      `UPDATE agent_runtime_tool_call
       SET status = 'completed', completed_at = ?
       WHERE id = ?`,
    )
    .run(NOW, toolCallId);
  return receiptId;
}

async function createProjectWriteReview(test: Fixture, settle: boolean): Promise<string> {
  const provenance = test.nextProvenance('update_project_facts');
  const repository = createAgentRuntimeWriteEffectRepository(test.gateway.client());
  const arguments_ = { facts: { evaluation: 'complete' } };
  test.gateway.database
    .prepare('UPDATE agent_runtime_tool_call SET arguments_json = ? WHERE id = ?')
    .run(canonicalAgentRuntimeJson(arguments_), provenance.toolCallId);
  const effectId = `project-effect:${provenance.callId}`;
  const effect = (
    await repository.claimEffect({
      id: effectId,
      projectId: provenance.projectId,
      routeKind: 'chat',
      conversationId: 'conversation-long-task',
      goalRunId: null,
      chapterId: null,
      sessionId: provenance.sessionId,
      turnId: provenance.turnId,
      toolCallId: provenance.toolCallId,
      callId: provenance.callId,
      toolName: 'update_project_facts',
      idempotencyKey: provenance.idempotencyKey,
      authorization: {
        kind: 'automatic',
        requestId: null,
        argumentsHash: 'sha256:test-arguments',
        authorizedAt: NOW,
      },
      arguments: arguments_,
      expectedRevision: null,
      claimedAt: NOW,
    })
  ).effect;
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'claimed',
    nextPhase: 'confirmed',
    at: NOW,
  });
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'confirmed',
    nextPhase: 'mutation_started',
    observedRevision: null,
    preimage: { kind: 'project', entityId: PROJECT_ID },
    forward: {
      kind: 'entity_write_command',
      entityKind: 'project',
      entityId: PROJECT_ID,
    },
    inverse: { kind: 'entity_write_command', entityKind: 'project', entityId: PROJECT_ID },
    reversibility: 'exact',
    at: NOW,
  });
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'mutation_started',
    nextPhase: 'effect_committed',
    effect: { projectId: PROJECT_ID },
    at: NOW,
  });
  await repository.transitionEffect({
    effectId,
    expectedPhase: 'effect_committed',
    nextPhase: 'result_committed',
    result: { ok: true, data: { result: { projectId: PROJECT_ID } } },
    at: NOW,
  });
  const reviewId = `project-review:${provenance.callId}`;
  await repository.createReview({
    id: reviewId,
    effectId: effect.id,
    sessionId: effect.sessionId,
    turnId: effect.turnId,
    toolCallId: effect.toolCallId,
    createdAt: NOW,
  });
  if (settle) {
    await repository.transitionReview({
      reviewId,
      expectedStatus: 'pending',
      nextStatus: 'accepted',
      decisionNote: 'auto mode',
      at: NOW,
    });
    await repository.transitionReview({
      reviewId,
      expectedStatus: 'accepted',
      nextStatus: 'accepted_effect',
      at: NOW,
    });
  }
  return reviewId;
}

describe('durable Agent long-task runtime', () => {
  it('completes review work from exact cited reads, rejects forged quotes, and survives restart', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    let plan = (
      await repository.applyCommand(test.nextProvenance('update_task_plan'), {
        ...wholeBookCommand(),
        objective: '逐章检查人物状态与连续性，不改正文',
        workKind: 'review',
        steps: WHOLE_BOOK_MANIFEST.map((chapter) => ({
          title: `检查章节：${chapter.name}`,
          target: {
            kind: 'chapter',
            name: chapter.name,
            resolvedTargetId: chapter.resolvedChapterId,
          },
        })),
      })
    ).plan;
    expect(plan.task.workKind).toBe('review');

    const completeStep = async (stepIndex: number, prose: string, quote: string) => {
      const step = plan.steps[stepIndex]!;
      plan = (
        await repository.applyCommand(test.nextProvenance('update_task_step'), {
          toolName: 'update_task_step',
          taskId: plan.task.id,
          expectedRevision: plan.task.revision,
          stepId: step.id,
          status: 'in_progress',
          resultNote: null,
          resultRef: null,
        })
      ).plan;
      const receiptId = await createChapterReadReceipt(test, {
        chapterId: step.target!.resolvedTargetId!,
        chapterName: step.target!.name,
        prose,
        ordinal: stepIndex,
      });
      const reviewResult = {
        schemaVersion: 1 as const,
        verdict: 'pass' as const,
        synopsis: `已核查${step.target!.name}的当前人物状态。`,
        claims: [
          {
            kind: 'character_state' as const,
            text: '人物状态由当前原文直接支持。',
            citations: [{ quote, block: 1 }],
          },
        ],
        findings: [],
      };
      plan = (
        await repository.applyCommand(test.nextProvenance('update_task_step'), {
          toolName: 'update_task_step',
          taskId: plan.task.id,
          expectedRevision: plan.task.revision,
          stepId: step.id,
          status: 'completed',
          resultNote: null,
          resultRef: null,
          reviewResult,
        })
      ).plan;
      expect(plan.steps[stepIndex]).toMatchObject({
        status: 'completed',
        resultRef: receiptId,
        reviewResult,
        readEvidence: {
          receiptId,
          toolName: 'read_node',
          exactTargetEvidence: true,
          citationCount: 1,
        },
      });
    };

    await completeStep(0, '雨水敲着旧窗，亚历克始终没有回头。', '亚历克始终没有回头');

    const second = plan.steps[1]!;
    plan = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        stepId: second.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      })
    ).plan;
    await createChapterReadReceipt(test, {
      chapterId: second.target!.resolvedTargetId!,
      chapterName: second.target!.name,
      prose: '来客摘下湿透的帽子，把信压在桌角。',
      ordinal: 1,
    });
    const revisionBeforeForgery = plan.task.revision;
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: revisionBeforeForgery,
        stepId: second.id,
        status: 'completed',
        resultNote: null,
        resultRef: null,
        reviewResult: {
          schemaVersion: 1,
          verdict: 'pass',
          synopsis: '伪造结论',
          claims: [
            {
              kind: 'event',
              text: '不存在的事件',
              citations: [{ quote: '他当场焚毁了整座城市' }],
            },
          ],
          findings: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'TASK_READ_EVIDENCE_INVALID' });
    expect(
      (await repository.getPlan({ projectId: PROJECT_ID, sessionId: SESSION_ID }, plan.task.id))
        ?.task.revision,
    ).toBe(revisionBeforeForgery);

    plan = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: revisionBeforeForgery,
        stepId: second.id,
        status: 'completed',
        resultNote: null,
        resultRef: null,
        reviewResult: {
          schemaVersion: 1,
          verdict: 'pass',
          synopsis: '来客带来一封信。',
          claims: [
            {
              kind: 'event',
              text: '来客将信放在桌角。',
              citations: [{ quote: '把信压在桌角' }],
            },
          ],
          findings: [],
        },
      })
    ).plan;
    plan = (
      await repository.applyCommand(test.nextProvenance('update_task_plan'), {
        toolName: 'update_task_plan',
        operation: 'set_status',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        status: 'completed',
      })
    ).plan;
    expect(plan.task.status).toBe('completed');
    expect(
      test.gateway.database
        .prepare('SELECT count(*) AS count FROM agent_runtime_write_effect')
        .get(),
    ).toEqual({ count: 0 });

    const restarted = createAgentRuntimeLongTaskRepository(test.gateway.client());
    const recovered = await restarted.getLatestPlan({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    expect(recovered?.steps.every((step) => step.readEvidence?.exactTargetEvidence)).toBe(true);
    expect(recovered?.steps.map((step) => step.reviewResult?.synopsis)).toEqual([
      '已核查第一章 雨夜的当前人物状态。',
      '来客带来一封信。',
    ]);
    await test.gateway.close();
  });

  it('uses canonical entity-write targets and explains pending review blocking', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const command: Extract<
      AgentRuntimeTaskCommand,
      { toolName: 'update_task_plan'; operation: 'create' }
    > = {
      toolName: 'update_task_plan',
      operation: 'create',
      objective: '更新项目写作事实',
      scopeKind: 'explicit_targets',
      chapterManifest: [],
      steps: [
        {
          title: '更新项目事实',
          target: {
            kind: 'project',
            name: 'Long task project',
            resolvedTargetId: PROJECT_ID,
          },
        },
      ],
      constraints: [],
    };
    let plan = (await repository.applyCommand(test.nextProvenance('update_task_plan'), command))
      .plan;
    const step = plan.steps[0]!;
    plan = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        stepId: step.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      })
    ).plan;

    const pendingReviewId = await createProjectWriteReview(test, false);
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        stepId: step.id,
        status: 'completed',
        resultNote: '不应提前完成',
        resultRef: pendingReviewId,
      }),
    ).rejects.toMatchObject({
      code: 'TASK_WRITE_EVIDENCE_INVALID',
      message: expect.stringContaining('status="blocked"'),
    });

    const acceptedReviewId = await createProjectWriteReview(test, true);
    plan = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        stepId: step.id,
        status: 'completed',
        resultNote: '项目事实已更新',
        resultRef: acceptedReviewId,
      })
    ).plan;
    expect(plan.steps[0]).toMatchObject({
      status: 'completed',
      reviewEvidence: {
        outcome: 'accepted_target_write',
        acceptedTargetEvidence: true,
        toolName: 'update_project_facts',
      },
    });
    expect(plan.task.status).toBe('completed');
    await expect(
      repository.getOpenPlan({ projectId: PROJECT_ID, sessionId: SESSION_ID }),
    ).resolves.toBeNull();
    await test.gateway.close();
  });

  it('accepts an exact target write made after step creation but before in-progress bookkeeping', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    let plan = (
      await repository.applyCommand(test.nextProvenance('update_task_plan'), createCommand())
    ).plan;
    const step = plan.steps[0]!;
    const reviewId = await createAcceptedWriteReview(test, {
      chapterId: step.target!.resolvedTargetId!,
      chapterName: step.target!.name,
    });

    plan = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        stepId: step.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      })
    ).plan;
    test.gateway.database
      .prepare('UPDATE agent_runtime_task_step SET started_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00.000Z', step.id);

    const completed = await repository.applyCommand(test.nextProvenance('update_task_step'), {
      toolName: 'update_task_step',
      taskId: plan.task.id,
      expectedRevision: plan.task.revision,
      stepId: step.id,
      status: 'completed',
      resultNote: '正文先完成，随后补记步骤状态',
      resultRef: reviewId,
    });
    expect(completed.plan.steps[0]).toMatchObject({
      status: 'completed',
      resultRef: reviewId,
      reviewEvidence: {
        acceptedTargetEvidence: true,
        outcome: 'accepted_target_write',
      },
    });
    await test.gateway.close();
  });

  it('rolls the plan back when its exactly-once receipt cannot commit', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const provenance = test.nextProvenance('update_task_plan');
    test.gateway.database.exec(`
      CREATE TRIGGER acceptance_abort_task_receipt
      BEFORE INSERT ON agent_runtime_task_command
      BEGIN
        SELECT RAISE(ABORT, 'acceptance receipt fault');
      END;
    `);

    await expect(repository.applyCommand(provenance, createCommand())).rejects.toThrow();
    expect(
      test.gateway.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM agent_runtime_task) AS tasks,
             (SELECT count(*) FROM agent_runtime_task_step) AS steps,
             (SELECT count(*) FROM agent_runtime_task_constraint) AS constraints,
             (SELECT count(*) FROM agent_runtime_task_command) AS commands`,
        )
        .get(),
    ).toEqual({
      tasks: 0,
      steps: 0,
      constraints: 0,
      commands: 0,
    });

    test.gateway.database.exec('DROP TRIGGER acceptance_abort_task_receipt');
    await expect(repository.applyCommand(provenance, createCommand())).resolves.toMatchObject({
      outcome: 'inserted',
      plan: { task: { revision: 0 } },
    });
    await test.gateway.close();
  });

  it('uses one crash-safe command transaction with exact replay and CAS', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const createProvenance = test.nextProvenance('update_task_plan');
    const created = await repository.applyCommand(createProvenance, createCommand());

    expect(created.outcome).toBe('inserted');
    expect(created.plan.task).toMatchObject({
      id: 'task-1',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      status: 'active',
      revision: 0,
    });
    expect(
      created.plan.steps.map((step) => ({
        id: step.id,
        target: step.target,
        status: step.status,
      })),
    ).toEqual([
      {
        id: 'step-2',
        target: {
          kind: 'chapter',
          name: '第一章 雨夜',
          resolvedTargetId: 'node-secret-1',
        },
        status: 'pending',
      },
      {
        id: 'step-3',
        target: {
          kind: 'chapter',
          name: '第二章 来客',
          resolvedTargetId: 'node-secret-2',
        },
        status: 'pending',
      },
    ]);

    const replay = await repository.applyCommand(createProvenance, createCommand());
    expect(replay).toMatchObject({
      outcome: 'duplicate',
      plan: {
        task: { id: 'task-1', revision: 0 },
      },
    });
    expect(
      test.gateway.database
        .prepare('SELECT count(*) AS count FROM agent_runtime_task_command')
        .get(),
    ).toEqual({ count: 1 });

    await expect(
      repository.applyCommand(createProvenance, {
        ...createCommand(),
        objective: '复用同一 key 的漂移参数',
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_CONFLICT',
    });

    const firstStep = created.plan.steps[0]!;
    const secondStep = created.plan.steps[1]!;
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: created.plan.task.id,
        expectedRevision: 0,
        stepId: firstStep.id,
        status: 'completed',
        resultNote: 'Skipped execution and review.',
        resultRef: null,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STEP_TRANSITION',
    });
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: created.plan.task.id,
        expectedRevision: 0,
        stepId: firstStep.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      }),
    ).resolves.toMatchObject({
      plan: { task: { revision: 1 } },
      changedStepId: firstStep.id,
    });

    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: created.plan.task.id,
        expectedRevision: 1,
        stepId: secondStep.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STEP_TRANSITION',
    });
    expect(
      (
        await repository.getPlan(
          {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
          },
          created.plan.task.id,
        )
      )?.task.revision,
    ).toBe(1);

    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: created.plan.task.id,
        expectedRevision: 1,
        stepId: firstStep.id,
        status: 'completed',
        resultNote: '没有 durable review 的伪完成',
        resultRef: 'arbitrary-result-ref',
      }),
    ).rejects.toMatchObject({
      code: 'TASK_WRITE_EVIDENCE_INVALID',
    });
    const acceptedReviewId = await createAcceptedWriteReview(test, {
      chapterId: 'node-secret-1',
      chapterName: '第一章 雨夜',
    });
    const completed = await repository.applyCommand(test.nextProvenance('update_task_step'), {
      toolName: 'update_task_step',
      taskId: created.plan.task.id,
      expectedRevision: 1,
      stepId: firstStep.id,
      status: 'completed',
      resultNote: '完成第一章润色',
      resultRef: acceptedReviewId,
    });
    expect(completed.plan.task.revision).toBe(2);
    expect(completed.plan.steps[0]?.resultRef).toBe(acceptedReviewId);

    const originalConstraint = completed.plan.constraints[0]!;
    const superseded = await repository.applyCommand(
      test.nextProvenance('update_task_constraint'),
      {
        toolName: 'update_task_constraint',
        operation: 'supersede',
        taskId: created.plan.task.id,
        expectedRevision: 2,
        constraintId: originalConstraint.id,
        replacementBody: '不得改变世界观事实；允许修正明显的前后笔误',
        replacementSource: 'author',
      },
    );
    expect(superseded.plan.task.revision).toBe(3);
    expect(
      superseded.plan.constraints.map((constraint) => ({
        body: constraint.body,
        status: constraint.status,
        supersededById: constraint.supersededById,
      })),
    ).toEqual([
      {
        body: '不得改变已经确立的世界观事实',
        status: 'superseded',
        supersededById: superseded.changedConstraintId,
      },
      {
        body: '不得改变世界观事实；允许修正明显的前后笔误',
        status: 'active',
        supersededById: null,
      },
    ]);

    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: created.plan.task.id,
        expectedRevision: 2,
        stepId: secondStep.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      }),
    ).rejects.toMatchObject({
      code: 'TASK_REVISION_CONFLICT',
    });

    await test.gateway.close();
    const reopened = new ProductFileBackedSqliteGateway(test.databasePath);
    test.gateway = reopened;
    const recovered = await createAgentRuntimeLongTaskRepository(reopened.client()).getOpenPlan({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    expect(recovered).toMatchObject({
      task: {
        id: created.plan.task.id,
        revision: 3,
        status: 'active',
      },
      steps: [{ status: 'completed' }, { status: 'pending' }],
    });
    expect(
      recovered?.constraints.filter((constraint) => constraint.status === 'active'),
    ).toHaveLength(1);
    reopened.database.prepare('DELETE FROM agent_runtime_session WHERE id = ?').run(SESSION_ID);
    expect(
      reopened.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM agent_runtime_task) AS tasks,
             (SELECT count(*) FROM agent_runtime_task_step) AS steps,
             (SELECT count(*) FROM agent_runtime_task_constraint) AS constraints,
             (SELECT count(*) FROM agent_runtime_task_command) AS commands`,
        )
        .get(),
    ).toEqual({
      tasks: 0,
      steps: 0,
      constraints: 0,
      commands: 0,
    });
    await reopened.close();
  });

  it('deduplicates append_steps by stable target identity across batches and budget-style retries', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const created = await repository.applyCommand(
      test.nextProvenance('update_task_plan'),
      createCommand(),
    );
    const append = {
      toolName: 'update_task_plan' as const,
      operation: 'append_steps' as const,
      taskId: created.plan.task.id,
      expectedRevision: 0,
      steps: [
        {
          title: '重复润色第一章',
          target: {
            kind: 'chapter' as const,
            name: '  第一章   雨夜 ',
            resolvedTargetId: 'node-secret-1',
          },
        },
        {
          title: '润色第三章',
          target: {
            kind: 'chapter' as const,
            name: '第三章 归途',
            resolvedTargetId: 'node-secret-3',
          },
        },
        {
          title: '再次润色第三章',
          target: {
            kind: 'chapter' as const,
            name: '第三章 归途',
            resolvedTargetId: 'node-secret-3',
          },
        },
      ],
    };
    const appended = await repository.applyCommand(test.nextProvenance('update_task_plan'), append);
    expect(appended.plan.task.revision).toBe(1);
    expect(appended.plan.steps).toHaveLength(3);
    expect(appended.plan.steps.map((step) => step.target?.resolvedTargetId)).toEqual([
      'node-secret-1',
      'node-secret-2',
      'node-secret-3',
    ]);

    const retryProvenance = test.nextProvenance('update_task_plan');
    const semanticRetry = {
      ...append,
      expectedRevision: 1,
      steps: append.steps.slice(1).map((step) => ({
        ...step,
        target: {
          ...step.target,
          resolvedTargetId: null,
        },
      })),
    };
    const retried = await repository.applyCommand(retryProvenance, semanticRetry);
    expect(retried).toMatchObject({
      outcome: 'inserted',
      plan: {
        task: { revision: 1 },
        steps: expect.any(Array),
      },
    });
    expect(retried.plan.steps).toHaveLength(3);
    await expect(repository.applyCommand(retryProvenance, semanticRetry)).resolves.toMatchObject({
      outcome: 'duplicate',
      plan: { task: { revision: 1 } },
    });
    await test.gateway.close();
  });

  it('rejects missing, duplicate, and foreign chapter coverage for a whole-book create', async () => {
    const malformedCommands: AgentRuntimeTaskCommand[] = [
      {
        ...wholeBookCommand(),
        steps: wholeBookCommand().steps.slice(0, 1),
      },
      {
        ...wholeBookCommand(),
        steps: [wholeBookCommand().steps[0]!, wholeBookCommand().steps[0]!],
      },
      {
        ...wholeBookCommand(),
        steps: [
          wholeBookCommand().steps[0]!,
          {
            title: '处理外来章节',
            target: {
              kind: 'chapter',
              name: '外来章节',
              resolvedTargetId: 'foreign-node',
            },
          },
        ],
      },
    ];

    for (const command of malformedCommands) {
      const test = await fixture();
      const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
        createId: idFactory(),
      });
      await expect(
        repository.applyCommand(test.nextProvenance('update_task_plan'), command),
      ).rejects.toMatchObject({ code: 'TASK_PLAN_INVALID' });
      expect(
        test.gateway.database.prepare('SELECT count(*) AS count FROM agent_runtime_task').get(),
      ).toEqual({ count: 0 });
      await test.gateway.close();
    }
  });

  it('revalidates exact frozen-manifest coverage before whole-book completion', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    let plan = (
      await repository.applyCommand(test.nextProvenance('update_task_plan'), wholeBookCommand())
    ).plan;
    expect(plan.task.scopeKind).toBe('whole_book_chapters');
    expect(
      plan.chapterManifest.map(({ ordinal, name, resolvedChapterId }) => ({
        ordinal,
        name,
        resolvedChapterId,
      })),
    ).toEqual(WHOLE_BOOK_MANIFEST);

    for (const step of plan.steps) {
      plan = (
        await repository.applyCommand(test.nextProvenance('update_task_step'), {
          toolName: 'update_task_step',
          taskId: plan.task.id,
          expectedRevision: plan.task.revision,
          stepId: step.id,
          status: 'in_progress',
          resultNote: null,
          resultRef: null,
        })
      ).plan;
      if (step.ordinal === 0) {
        const wrongToolReviewId = await createAcceptedWriteReview(test, {
          chapterId: step.target!.resolvedTargetId!,
          chapterName: step.target!.name,
          toolName: 'rename_node',
        });
        await expect(
          repository.applyCommand(test.nextProvenance('update_task_step'), {
            toolName: 'update_task_step',
            taskId: plan.task.id,
            expectedRevision: plan.task.revision,
            stepId: step.id,
            status: 'completed',
            resultNote: '仅重命名章节不能证明正文已润色',
            resultRef: wrongToolReviewId,
          }),
        ).rejects.toMatchObject({
          code: 'TASK_WRITE_EVIDENCE_INVALID',
        });
        plan = (
          await repository.applyCommand(test.nextProvenance('update_task_step'), {
            toolName: 'update_task_step',
            taskId: plan.task.id,
            expectedRevision: plan.task.revision,
            stepId: step.id,
            status: 'blocked',
            resultNote: '错误工具证据',
            resultRef: wrongToolReviewId,
          })
        ).plan;
        expect(plan.steps[0]?.reviewEvidence).toMatchObject({
          reviewStatus: 'accepted_effect',
          outcome: 'invalid',
          acceptedTargetEvidence: false,
          toolName: 'rename_node',
        });
        plan = (
          await repository.applyCommand(test.nextProvenance('update_task_step'), {
            toolName: 'update_task_step',
            taskId: plan.task.id,
            expectedRevision: plan.task.revision,
            stepId: step.id,
            status: 'in_progress',
            resultNote: null,
            resultRef: null,
          })
        ).plan;
      }
      const acceptedReviewId = await createAcceptedWriteReview(test, {
        chapterId: step.target!.resolvedTargetId!,
        chapterName: step.ordinal === 0 ? '第一章 暴雨之夜' : step.target!.name,
      });
      plan = (
        await repository.applyCommand(test.nextProvenance('update_task_step'), {
          toolName: 'update_task_step',
          taskId: plan.task.id,
          expectedRevision: plan.task.revision,
          stepId: step.id,
          status: 'completed',
          resultNote: `完成 ${step.target!.name}`,
          resultRef: acceptedReviewId,
        })
      ).plan;
    }

    test.gateway.database
      .prepare(
        `DELETE FROM agent_runtime_task_chapter_manifest
         WHERE task_id = ? AND ordinal = 1`,
      )
      .run(plan.task.id);
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_plan'), {
        toolName: 'update_task_plan',
        operation: 'set_status',
        taskId: plan.task.id,
        expectedRevision: plan.task.revision,
        status: 'completed',
      }),
    ).rejects.toMatchObject({ code: 'TASK_MANIFEST_DRIFT' });

    test.gateway.database
      .prepare(
        `INSERT INTO agent_runtime_task_chapter_manifest (
           task_id, project_id, session_id, ordinal, name, resolved_chapter_id
         ) VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(
        plan.task.id,
        PROJECT_ID,
        SESSION_ID,
        WHOLE_BOOK_MANIFEST[1].name,
        WHOLE_BOOK_MANIFEST[1].resolvedChapterId,
      );
    const completed = await repository.applyCommand(test.nextProvenance('update_task_plan'), {
      toolName: 'update_task_plan',
      operation: 'set_status',
      taskId: plan.task.id,
      expectedRevision: plan.task.revision,
      status: 'completed',
    });
    expect(completed.plan.task.status).toBe('completed');
    await test.gateway.close();
  });

  it('reconciles added, removed, renamed, reordered, and restored chapters atomically across restart', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const created = await repository.applyCommand(
      test.nextProvenance('update_task_plan'),
      wholeBookCommand(),
    );
    const taskId = created.plan.task.id;
    const removedStepId = created.plan.steps[1]!.id;
    const db = test.gateway.database;
    db.prepare(
      `UPDATE book_node
       SET title = ?, book_order = 1, updated_at = ?
       WHERE id = ?`,
    ).run('第一章 暴雨之夜', NOW, 'node-secret-1');
    db.prepare(
      `UPDATE book_node
       SET deleted_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(NOW, NOW, 'node-secret-2');
    db.prepare(
      `INSERT INTO book_node (
         id, title, book_order, project_id, kind, created_at, updated_at,
         position_x, position_y
       ) VALUES (?, ?, 0, ?, 'chapter', ?, ?, 0, 0)`,
    ).run('node-secret-3', '第三章 新增', PROJECT_ID, NOW, NOW);

    const drifted = await repository.getChapterManifestState(
      { projectId: PROJECT_ID, sessionId: SESSION_ID },
      taskId,
    );
    expect(drifted).toMatchObject({
      status: 'drifted',
      frozenCount: 2,
      currentCount: 2,
      added: [{ ordinal: 0, name: '第三章 新增' }],
      missing: [{ ordinal: 1, name: '第二章 来客' }],
      renamed: [{ frozenName: '第一章 雨夜', currentName: '第一章 暴雨之夜' }],
      reordered: [{ name: '第一章 暴雨之夜', frozenOrdinal: 0, currentOrdinal: 1 }],
    });
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_plan'), {
        toolName: 'update_task_plan',
        operation: 'set_status',
        taskId,
        expectedRevision: 0,
        status: 'completed',
      }),
    ).rejects.toMatchObject({ code: 'TASK_MANIFEST_DRIFT' });

    db.exec(`
      CREATE TRIGGER acceptance_abort_manifest_receipt
      BEFORE INSERT ON agent_runtime_task_command
      BEGIN
        SELECT RAISE(ABORT, 'manifest receipt fault');
      END;
    `);
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_plan'), {
        toolName: 'update_task_plan',
        operation: 'reconcile_manifest',
        taskId,
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    db.exec('DROP TRIGGER acceptance_abort_manifest_receipt');
    const afterRollback = await repository.getPlan(
      { projectId: PROJECT_ID, sessionId: SESSION_ID },
      taskId,
    );
    expect(afterRollback?.task.revision).toBe(0);
    expect(afterRollback?.chapterManifest.map((chapter) => chapter.name)).toEqual([
      '第一章 雨夜',
      '第二章 来客',
    ]);
    expect(afterRollback?.steps.some((step) => step.status === 'retired')).toBe(false);

    const reconciled = await repository.applyCommand(test.nextProvenance('update_task_plan'), {
      toolName: 'update_task_plan',
      operation: 'reconcile_manifest',
      taskId,
      expectedRevision: 0,
    });
    expect(reconciled.manifestReconciliation).toMatchObject({
      addedStepIds: [expect.any(String)],
      retiredStepIds: [removedStepId],
      reopenedStepIds: [],
      retainedCompletedStepIds: [],
      renamedChapterCount: 1,
      reorderedChapterCount: 1,
    });
    expect(reconciled.plan.chapterManifest.map((chapter) => chapter.name)).toEqual([
      '第三章 新增',
      '第一章 暴雨之夜',
    ]);
    expect(
      reconciled.plan.steps.map((step) => ({
        name: step.target?.name,
        status: step.status,
      })),
    ).toEqual([
      { name: '第三章 新增', status: 'pending' },
      { name: '第一章 暴雨之夜', status: 'pending' },
      { name: '第二章 来客', status: 'retired' },
    ]);

    db.prepare(
      `UPDATE book_node
       SET deleted_at = NULL, book_order = 2, updated_at = ?
       WHERE id = ?`,
    ).run(NOW, 'node-secret-2');
    const restored = await repository.applyCommand(test.nextProvenance('update_task_plan'), {
      toolName: 'update_task_plan',
      operation: 'reconcile_manifest',
      taskId,
      expectedRevision: 1,
    });
    expect(restored.manifestReconciliation?.reopenedStepIds).toEqual([removedStepId]);
    expect(restored.plan.steps).toHaveLength(3);
    expect(restored.plan.steps[2]).toMatchObject({
      id: removedStepId,
      status: 'pending',
      resultNote: null,
      resultRef: null,
      startedAt: null,
      completedAt: null,
    });

    await test.gateway.close();
    const reopenedGateway = new ProductFileBackedSqliteGateway(test.databasePath);
    const reopenedRepository = createAgentRuntimeLongTaskRepository(reopenedGateway.client(), {
      createId: idFactory(),
    });
    await expect(
      reopenedRepository.getChapterManifestState(
        { projectId: PROJECT_ID, sessionId: SESSION_ID },
        taskId,
      ),
    ).resolves.toMatchObject({ status: 'current', frozenCount: 3, currentCount: 3 });
    await expect(
      reopenedRepository.getPlan({ projectId: PROJECT_ID, sessionId: SESSION_ID }, taskId),
    ).resolves.toMatchObject({ task: { revision: 2 }, steps: { length: 3 } });
    await reopenedGateway.close();
  });

  it('auto-generates and freezes whole-book steps without leaking renderer chapter ids', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const currentManifest: Array<{
      ordinal: number;
      name: string;
      resolvedChapterId: string;
    }> = WHOLE_BOOK_MANIFEST.map((chapter) => ({ ...chapter }));
    const currentNames = new Map<string, string>(
      WHOLE_BOOK_MANIFEST.map((chapter) => [chapter.resolvedChapterId, chapter.name]),
    );
    const resolveCurrentChapterName = ({ resolvedChapterId }: { resolvedChapterId: string }) =>
      currentNames.get(resolvedChapterId) ?? null;
    const runtime = new AgentLongTaskToolRuntime({
      repository,
      now: () => NOW,
      getWholeBookChapterManifest: () => currentManifest,
      resolveCurrentChapterName,
    });
    const definition = runtime
      .listDefinitions({
        route: {
          kind: 'chat',
          projectId: PROJECT_ID,
          conversationId: 'conversation-long-task',
        },
      })
      .find((candidate) => candidate.name === AGENT_LONG_TASK_PLAN_TOOL)!;
    expect(definition.inputSchema).toMatchObject({ type: 'object' });
    expect((definition.inputSchema as { anyOf?: unknown }).anyOf).toBeUndefined();
    const constraintDefinition = runtime
      .listDefinitions({
        route: {
          kind: 'chat',
          projectId: PROJECT_ID,
          conversationId: 'conversation-long-task',
        },
      })
      .find((candidate) => candidate.name === AGENT_LONG_TASK_CONSTRAINT_TOOL)!;
    expect(constraintDefinition.inputSchema).toMatchObject({ type: 'object' });
    expect((constraintDefinition.inputSchema as { anyOf?: unknown }).anyOf).toBeUndefined();
    expect(
      constraintDefinition.validateInput({
        operation: 'supersede',
        taskId: 'task-1',
        expectedRevision: 0,
        constraintId: 'constraint-1',
      }),
    ).toMatchObject({ ok: false });
    expect(
      definition.validateInput({
        operation: 'create',
        scopeKind: 'whole_book_chapters',
        objective: '润色整本书',
        steps: [{ title: '只做第一章' }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      definition.validateInput({
        operation: 'create',
        scopeKind: 'explicit_targets',
        objective: '只做一次定向修改',
        steps: [{ title: '缺少目标的不可完成步骤' }],
      }),
    ).toMatchObject({ ok: false });

    const provenance = test.nextProvenance('update_task_plan');
    const result = await runtime.execute({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      callId: provenance.callId,
      idempotencyKey: provenance.idempotencyKey,
      name: AGENT_LONG_TASK_PLAN_TOOL,
      access: 'write',
      arguments: {
        operation: 'create',
        scopeKind: 'whole_book_chapters',
        objective: '润色整本书',
      },
      context: {
        route: {
          kind: 'chat',
          projectId: PROJECT_ID,
          conversationId: 'conversation-long-task',
        },
      },
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    await expect(
      runtime.loadSelectionHints({
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        context: {
          route: {
            kind: 'chat',
            projectId: PROJECT_ID,
            conversationId: 'conversation-long-task',
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      longTask: {
        status: 'active',
        scopeKind: 'whole_book_chapters',
        workKind: 'edit',
        objective: '润色整本书',
        nextStep: {
          title: '处理章节：第一章 雨夜',
          status: 'pending',
          target: {
            kind: 'chapter',
            name: '第一章 雨夜',
          },
        },
      },
    });
    currentManifest.push({
      ordinal: 2,
      name: '第三章 新增',
      resolvedChapterId: 'node-secret-3',
    });

    const frozen = await repository.getOpenPlan({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    expect(frozen?.chapterManifest).toHaveLength(2);
    expect(frozen?.steps).toHaveLength(2);
    const providerProjection = projectAgentLongTaskPlanForProvider(frozen!);
    expect(providerProjection.frozenChapterManifest.entries).toEqual([
      { ordinal: 0, name: '第一章 雨夜' },
      { ordinal: 1, name: '第二章 来客' },
    ]);
    expect(JSON.stringify(providerProjection)).not.toContain('node-secret-');
    expect(JSON.stringify(providerProjection)).not.toContain('resolvedChapterId');
    expect(JSON.stringify(result)).not.toContain('node-secret-');
    currentNames.set('node-secret-1', '第一章 暴雨之夜');
    currentNames.delete('node-secret-2');
    const refreshedProjection = projectAgentLongTaskPlanForProvider(frozen!, {
      resolveCurrentChapterName,
    });
    expect(refreshedProjection.steps[0]?.target).toEqual({
      kind: 'chapter',
      name: '第一章 暴雨之夜',
      frozenName: '第一章 雨夜',
    });
    expect(refreshedProjection.steps[1]?.target).toEqual({
      kind: 'chapter',
      name: '第二章 来客',
      availability: 'missing',
    });
    let prioritized = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: frozen!.task.id,
        expectedRevision: frozen!.task.revision,
        stepId: frozen!.steps[0]!.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      })
    ).plan;
    prioritized = (
      await repository.applyCommand(test.nextProvenance('update_task_step'), {
        toolName: 'update_task_step',
        taskId: prioritized.task.id,
        expectedRevision: prioritized.task.revision,
        stepId: prioritized.steps[0]!.id,
        status: 'blocked',
        resultNote: '等待审阅',
        resultRef: 'pending-review',
      })
    ).plan;
    expect(projectAgentLongTaskPlanForProvider(prioritized).continuation.nextStepId).toBe(
      prioritized.steps[1]!.id,
    );
    await test.gateway.close();
  });

  it('projects accepted target evidence for the oldest of 22 settled chapter reviews', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const manifest = Array.from({ length: 22 }, (_, ordinal) => ({
      ordinal,
      name: `第 ${ordinal + 1} 章`,
      resolvedChapterId: `chapter-internal-${ordinal + 1}`,
    }));
    replaceCanonicalChapters(test.gateway, manifest);
    let plan = (
      await repository.applyCommand(test.nextProvenance('update_task_plan'), {
        toolName: 'update_task_plan',
        operation: 'create',
        objective: '逐章润色二十二章',
        scopeKind: 'whole_book_chapters',
        chapterManifest: manifest,
        steps: manifest.map((chapter) => ({
          title: `处理章节：${chapter.name}`,
          target: {
            kind: 'chapter',
            name: chapter.name,
            resolvedTargetId: chapter.resolvedChapterId,
          },
        })),
        constraints: [],
      })
    ).plan;

    for (const originalStep of [...plan.steps]) {
      plan = (
        await repository.applyCommand(test.nextProvenance('update_task_step'), {
          toolName: 'update_task_step',
          taskId: plan.task.id,
          expectedRevision: plan.task.revision,
          stepId: originalStep.id,
          status: 'in_progress',
          resultNote: null,
          resultRef: null,
        })
      ).plan;
      const reviewId = await createAcceptedWriteReview(test, {
        chapterId: originalStep.target!.resolvedTargetId!,
        chapterName: originalStep.target!.name,
      });
      plan = (
        await repository.applyCommand(test.nextProvenance('update_task_step'), {
          toolName: 'update_task_step',
          taskId: plan.task.id,
          expectedRevision: plan.task.revision,
          stepId: originalStep.id,
          status: 'blocked',
          resultNote: '等待 durable review 状态投影',
          resultRef: reviewId,
        })
      ).plan;
    }

    const projected = projectAgentLongTaskPlanForProvider(plan, {
      limit: 100,
    });
    expect(projected.steps).toHaveLength(22);
    expect(projected.steps[0]?.reviewEvidence).toEqual({
      reviewStatus: 'accepted_effect',
      outcome: 'accepted_target_write',
      acceptedTargetEvidence: true,
      toolName: 'edit_block',
      settledAt: NOW,
    });
    expect(projected.steps[21]?.reviewEvidence).toMatchObject({
      reviewStatus: 'accepted_effect',
      acceptedTargetEvidence: true,
    });
    expect(JSON.stringify(projected)).not.toContain('chapter-internal-');

    const hook = createAgentLongTaskSupplementalRowsHook(repository);
    const rows = await hook({
      purpose: 'provider_call',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      iteration: 0,
      driverId: 'test-driver',
      context: {
        route: {
          kind: 'chat',
          projectId: PROJECT_ID,
          conversationId: 'conversation-long-task',
        },
      },
      systemPrompt: 'Continue durable work.',
      messages: [{ role: 'user', content: '继续' }],
      tools: [],
      signal: new AbortController().signal,
    });
    const pinnedPlan = JSON.parse(rows[0]!.content) as {
      stepWindow: {
        steps: Array<{
          reviewEvidence: {
            acceptedTargetEvidence: boolean;
          } | null;
        }>;
      };
    };
    expect(pinnedPlan.stepWindow.steps[0]?.reviewEvidence?.acceptedTargetEvidence).toBe(true);

    const oldest = plan.steps[0]!;
    const completed = await repository.applyCommand(test.nextProvenance('update_task_step'), {
      toolName: 'update_task_step',
      taskId: plan.task.id,
      expectedRevision: plan.task.revision,
      stepId: oldest.id,
      status: 'completed',
      resultNote: '旧审阅证据仍可安全收口',
      resultRef: oldest.resultRef,
    });
    expect(completed.plan.steps[0]).toMatchObject({
      status: 'completed',
      reviewEvidence: {
        outcome: 'accepted_target_write',
        acceptedTargetEvidence: true,
      },
    });
    await test.gateway.close();
  });

  it('keeps project/session isolation and rejects foreign task handles', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const created = await repository.applyCommand(
      test.nextProvenance('update_task_plan'),
      createCommand(),
    );
    const db = test.gateway.database;
    db.prepare(
      `INSERT INTO project (id, name, user_id, created_at, updated_at)
       VALUES ('project-foreign', 'Foreign', 'user-1', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO agent_conversation (
         id, project_id, title, mode, messages_json, created_at, updated_at
       ) VALUES (
         'conversation-foreign', 'project-foreign', 'Foreign', 'byok', '[]', ?, ?
       )`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO agent_runtime_session (
         id, project_id, route_kind, conversation_id, provider, provider_epoch,
         status, created_at, updated_at
       ) VALUES (
         'session-foreign', 'project-foreign', 'chat',
         'conversation-foreign', 'deepseek', 0, 'running', ?, ?
       )`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO agent_runtime_turn (
         id, session_id, ordinal, status, accepted_at, started_at, updated_at
       ) VALUES (
         'turn-foreign', 'session-foreign', 0, 'running', ?, ?, ?
       )`,
    ).run(NOW, NOW, NOW);

    const foreignScope = {
      projectId: 'project-foreign',
      sessionId: 'session-foreign',
      turnId: 'turn-foreign',
    };
    expect(
      await repository.getPlan(
        {
          projectId: foreignScope.projectId,
          sessionId: foreignScope.sessionId,
        },
        created.plan.task.id,
      ),
    ).toBeNull();
    await expect(
      repository.applyCommand(test.nextProvenance('update_task_step', foreignScope), {
        toolName: 'update_task_step',
        taskId: created.plan.task.id,
        expectedRevision: 0,
        stepId: created.plan.steps[0]!.id,
        status: 'in_progress',
        resultNote: null,
        resultRef: null,
      }),
    ).rejects.toBeInstanceOf(AgentRuntimeLongTaskConflictError);
    await test.gateway.close();
  });

  it('exposes strict name-first tools and pins resumable progress plus active constraints', async () => {
    const test = await fixture();
    const repository = createAgentRuntimeLongTaskRepository(test.gateway.client(), {
      createId: idFactory(),
    });
    const provenance = test.nextProvenance('update_task_plan');
    const runtime = new AgentLongTaskToolRuntime({
      repository,
      now: () => NOW,
      resolveTarget: ({ kind, name }) => (kind === 'chapter' ? `internal:${name}` : null),
    });
    const context = {
      route: {
        kind: 'chat' as const,
        projectId: PROJECT_ID,
        conversationId: 'conversation-long-task',
      },
    };
    const definition = runtime
      .listDefinitions(context)
      .find((candidate) => candidate.name === AGENT_LONG_TASK_PLAN_TOOL)!;
    expect(
      definition.validateInput({
        operation: 'create',
        scopeKind: 'explicit_targets',
        objective: '润色整本书',
        steps: [
          {
            title: '润色第一章',
            target: {
              kind: 'chapter',
              name: '第一章',
              id: 'model-must-not-pass-node-id',
            },
          },
        ],
      }),
    ).toMatchObject({ ok: false });

    const request: AgentToolExecutionRequest = {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      callId: provenance.callId,
      idempotencyKey: provenance.idempotencyKey,
      name: AGENT_LONG_TASK_PLAN_TOOL,
      access: 'write',
      arguments: {
        operation: 'create',
        scopeKind: 'explicit_targets',
        objective: '润色整本书',
        steps: [
          {
            title: '润色第一章',
            target: {
              kind: 'chapter',
              name: '第一章',
            },
          },
          {
            title: '润色第二章',
            target: {
              kind: 'chapter',
              name: '第二章',
            },
          },
        ],
        constraints: ['保持第一人称叙事'],
      },
      context,
      signal: new AbortController().signal,
    };
    const result = await runtime.execute(request);
    expect(result).toMatchObject({
      ok: true,
      data: {
        task: {
          objective: '润色整本书',
          revision: 0,
        },
        activeConstraints: [{ body: '保持第一人称叙事' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('internal:');
    expect(JSON.stringify(result)).not.toContain('resolvedTargetId');

    const hook = createAgentLongTaskSupplementalRowsHook(repository);
    const hookInput: AgentRuntimeContextPlanningHookInput = {
      purpose: 'provider_call',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      iteration: 0,
      driverId: 'test-driver',
      context,
      systemPrompt: 'Follow the durable plan.',
      messages: [{ role: 'user', content: '继续任务' }],
      tools: [],
      signal: new AbortController().signal,
    };
    const rows = await hook(hookInput);
    expect(rows.map((row) => row.kind)).toEqual(['task_plan', 'task_constraints']);
    expect(rows.every((row) => row.turnOrdinal === null)).toBe(true);
    expect(rows[0]?.content).toContain('第一章');
    expect(rows[0]?.content).not.toContain('internal:');
    expect(rows[0]?.durableWriteCoverage).toEqual([
      {
        turnOrdinal: 0,
        callId: provenance.callId,
        toolName: 'update_task_plan',
      },
    ]);
    expect(rows[1]?.durableWriteCoverage).toEqual([]);

    const bridge = agentModelMessagesToContextSources({
      systemPrompt: hookInput.systemPrompt,
      messages: hookInput.messages,
      resolveToolAccess: () => null,
      supplementalRows: rows,
    });
    const taskSources = bridge.sourceRows.filter(
      (row) => row.kind === 'task_plan' || row.kind === 'task_constraints',
    );
    expect(taskSources.map((row) => classifyAgentContextSource(row))).toEqual(['pinned', 'pinned']);
    const planned = await planAgentModelContext({
      systemPrompt: hookInput.systemPrompt,
      messages: hookInput.messages,
      resolveToolAccess: () => null,
      supplementalRows: rows,
      planner: {
        contextWindowTokens: 32_768,
        requestedOutputTokens: 4_096,
        fixedInputTokens: 0,
      },
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.plan.checkpoint.pinned.sourceIds).toEqual(
        expect.arrayContaining(rows.map((row) => row.sourceId)),
      );
    }
    const coveredMessages: AgentModelMessage[] = [
      { role: 'user', content: '建立整书任务' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: provenance.callId,
            name: 'update_task_plan',
            arguments: request.arguments,
            rawArguments: JSON.stringify(request.arguments),
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            callId: provenance.callId,
            name: 'update_task_plan',
            ok: true,
            content: JSON.stringify(result),
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '任务已建立' }],
      },
      { role: 'user', content: '继续第一章' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '准备第一章' }],
      },
      { role: 'user', content: '继续' },
    ];
    const coveredPlan = await planAgentModelContext({
      systemPrompt: hookInput.systemPrompt,
      messages: coveredMessages,
      resolveToolAccess: (name) => (name === 'update_task_plan' ? 'write' : null),
      supplementalRows: rows,
      planner: {
        contextWindowTokens: 32_768,
        requestedOutputTokens: 4_096,
        fixedInputTokens: 0,
      },
    });
    expect(coveredPlan.ok).toBe(true);
    if (coveredPlan.ok) {
      const taskPair = coveredPlan.plan.segments.filter(
        (segment) =>
          segment.type === 'source' &&
          (segment.row.kind === 'tool_call' || segment.row.kind === 'tool_result') &&
          segment.row.callId === provenance.callId,
      );
      expect(taskPair).toHaveLength(2);
      expect(taskPair).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: 'compressible',
            pinReason: null,
          }),
        ]),
      );
      expect(coveredPlan.plan.checkpoint.pinned.sourceIds).toEqual(
        expect.arrayContaining(rows.map((row) => row.sourceId)),
      );
    }
    await test.gateway.close();
  });
});
