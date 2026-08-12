import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../../../../lib/db';
import { agentProjectHandoffModelData, createAgentProjectHandoffService } from '../project-handoff';
import {
  AGENT_PROJECT_HANDOFF_READ_TOOL,
  AgentLongTaskToolRuntime,
} from '../long-task-tool-runtime';
import { ProductFileBackedSqliteGateway } from './p3-file-backed-sqlite';

const PROJECT_ID = 'project-current-private-id';
const OTHER_PROJECT_ID = 'project-foreign-private-id';
const SOURCE_SESSION_ID = 'session-source-private-id';
const CURRENT_SESSION_ID = 'session-current-private-id';
const DELETED_SESSION_ID = 'session-deleted-private-id';
const FOREIGN_SESSION_ID = 'session-foreign-private-id';
const NOW = '2026-08-12T08:00:00.000Z';
const SNAPSHOT_AT = '2026-08-12T09:00:00.000Z';

const directories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

function seedProjectHandoff(gateway: ProductFileBackedSqliteGateway): void {
  const db = gateway.database;
  const insertProject = db.prepare(
    `INSERT INTO project (id, name, user_id, created_at, updated_at)
     VALUES (?, ?, 'user-1', ?, ?)`,
  );
  insertProject.run(PROJECT_ID, '漂流测试项目', NOW, NOW);
  insertProject.run(OTHER_PROJECT_ID, '外部项目', NOW, NOW);

  const insertConversation = db.prepare(
    `INSERT INTO agent_conversation (
       id, project_id, title, mode, messages_json, deleted_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'byok', ?, ?, ?, ?)`,
  );
  insertConversation.run(
    'conversation-source-private-id',
    PROJECT_ID,
    '旧会话：人物校对',
    JSON.stringify([{ role: 'user', content: 'SECRET_TRANSCRIPT_TEXT' }]),
    null,
    NOW,
    NOW,
  );
  insertConversation.run(
    'conversation-current-private-id',
    PROJECT_ID,
    '当前会话',
    '[]',
    null,
    NOW,
    NOW,
  );
  insertConversation.run(
    'conversation-deleted-private-id',
    PROJECT_ID,
    '已删除会话',
    '[]',
    NOW,
    NOW,
    NOW,
  );
  insertConversation.run(
    'conversation-foreign-private-id',
    OTHER_PROJECT_ID,
    '外部会话',
    '[]',
    null,
    NOW,
    NOW,
  );

  const insertSession = db.prepare(
    `INSERT INTO agent_runtime_session (
       id, project_id, route_kind, conversation_id, provider, provider_epoch,
       status, created_at, updated_at
     ) VALUES (?, ?, 'chat', ?, 'deepseek', 0, ?, ?, ?)`,
  );
  insertSession.run(
    SOURCE_SESSION_ID,
    PROJECT_ID,
    'conversation-source-private-id',
    'running',
    NOW,
    NOW,
  );
  insertSession.run(
    CURRENT_SESSION_ID,
    PROJECT_ID,
    'conversation-current-private-id',
    'idle',
    NOW,
    NOW,
  );
  insertSession.run(
    DELETED_SESSION_ID,
    PROJECT_ID,
    'conversation-deleted-private-id',
    'idle',
    NOW,
    NOW,
  );
  insertSession.run(
    FOREIGN_SESSION_ID,
    OTHER_PROJECT_ID,
    'conversation-foreign-private-id',
    'idle',
    NOW,
    NOW,
  );

  const insertTask = db.prepare(
    `INSERT INTO agent_runtime_task (
       id, project_id, session_id, objective, scope_kind, work_kind,
       status, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'explicit_targets', 'edit', 'active', 3, ?, ?)`,
  );
  insertTask.run(
    'task-source-private-id',
    PROJECT_ID,
    SOURCE_SESSION_ID,
    '校对米拉设定并补齐登场关系',
    NOW,
    NOW,
  );
  insertTask.run(
    'task-current-private-id',
    PROJECT_ID,
    CURRENT_SESSION_ID,
    'SECRET_CURRENT_SESSION_OBJECTIVE',
    NOW,
    NOW,
  );
  insertTask.run(
    'task-deleted-private-id',
    PROJECT_ID,
    DELETED_SESSION_ID,
    'SECRET_DELETED_CONVERSATION_OBJECTIVE',
    NOW,
    NOW,
  );
  insertTask.run(
    'task-foreign-private-id',
    OTHER_PROJECT_ID,
    FOREIGN_SESSION_ID,
    'SECRET_FOREIGN_PROJECT_OBJECTIVE',
    NOW,
    NOW,
  );

  const insertStep = db.prepare(
    `INSERT INTO agent_runtime_task_step (
       id, task_id, project_id, session_id, ordinal, title, work_kind,
       target_kind, target_name, status, result_note, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertStep.run(
    'step-source-complete-private-id',
    'task-source-private-id',
    PROJECT_ID,
    SOURCE_SESSION_ID,
    0,
    '核对现有设定',
    'research',
    'element',
    '米拉',
    'completed',
    'SECRET_PROSE_IN_RESULT_NOTE',
    NOW,
    NOW,
    NOW,
  );
  insertStep.run(
    'step-source-running-private-id',
    'task-source-private-id',
    PROJECT_ID,
    SOURCE_SESSION_ID,
    1,
    '补齐登场关系',
    'edit',
    'element',
    '米拉',
    'in_progress',
    null,
    NOW,
    NOW,
    null,
  );
  insertStep.run(
    'step-current-private-id',
    'task-current-private-id',
    PROJECT_ID,
    CURRENT_SESSION_ID,
    0,
    '当前会话私有步骤',
    'edit',
    'project',
    '当前项目',
    'pending',
    null,
    NOW,
    NOW,
    null,
  );

  db.prepare(
    `INSERT INTO agent_runtime_task_constraint (
       id, task_id, project_id, session_id, body, source, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'author', 'active', ?, ?)`,
  ).run(
    'constraint-source-private-id',
    'task-source-private-id',
    PROJECT_ID,
    SOURCE_SESSION_ID,
    '不要改写正文',
    NOW,
    NOW,
  );

  db.prepare(
    `INSERT INTO book_node (
       id, title, book_order, project_id, kind, deleted_at, created_at, updated_at,
       position_x, position_y
     ) VALUES
       ('chapter-current-private-id', '第一章', 0, ?, 'chapter', NULL, ?, ?, 0, 0),
       ('drift-current-private-id', '潮汐意象', NULL, ?, 'drift', NULL, ?, ?, 0, 0),
       ('chapter-deleted-private-id', 'SECRET_DELETED_CHAPTER', 1, ?, 'chapter', ?, ?, ?, 0, 0),
       ('chapter-foreign-private-id', 'SECRET_FOREIGN_CHAPTER', 0, ?, 'chapter', NULL, ?, ?, 0, 0)`,
  ).run(
    PROJECT_ID,
    NOW,
    NOW,
    PROJECT_ID,
    NOW,
    NOW,
    PROJECT_ID,
    NOW,
    NOW,
    NOW,
    OTHER_PROJECT_ID,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO element_category (
       id, name, color, project_id, deleted_at, created_at, updated_at
     ) VALUES ('category-current-private-id', '人物', '#fff', ?, NULL, ?, ?)`,
  ).run(PROJECT_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO element (
       id, project_id, category_id, name, deleted_at, created_at, updated_at
     ) VALUES ('element-current-private-id', ?, 'category-current-private-id', '米拉', NULL, ?, ?)`,
  ).run(PROJECT_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO storylines (
       id, project_id, name, color, order_key, deleted_at, created_at, updated_at
     ) VALUES ('storyline-current-private-id', ?, '主线', '#fff', 0, NULL, ?, ?)`,
  ).run(PROJECT_ID, NOW, NOW);

  seedWrite(gateway, {
    suffix: 'accepted',
    sessionId: SOURCE_SESSION_ID,
    conversationId: 'conversation-source-private-id',
    name: '米拉',
    ordinal: 0,
    reviewStatus: 'accepted_effect',
  });
  seedWrite(gateway, {
    suffix: 'reverted',
    sessionId: SOURCE_SESSION_ID,
    conversationId: 'conversation-source-private-id',
    name: '废弃写入',
    ordinal: 1,
    reviewStatus: 'reverted',
  });
  seedWrite(gateway, {
    suffix: 'pending',
    sessionId: SOURCE_SESSION_ID,
    conversationId: 'conversation-source-private-id',
    name: '艾文',
    ordinal: 2,
    reviewStatus: 'pending',
  });
  seedWrite(gateway, {
    suffix: 'current',
    sessionId: CURRENT_SESSION_ID,
    conversationId: 'conversation-current-private-id',
    name: 'SECRET_CURRENT_SESSION_WRITE',
    ordinal: 0,
    reviewStatus: 'accepted_effect',
  });
}

function seedWrite(
  gateway: ProductFileBackedSqliteGateway,
  input: {
    suffix: string;
    sessionId: string;
    conversationId: string;
    name: string;
    ordinal: number;
    reviewStatus: 'pending' | 'accepted_effect' | 'reverted';
  },
): void {
  const db = gateway.database;
  const turnId = `turn-${input.suffix}-private-id`;
  const callId = `call-${input.suffix}-private-id`;
  const toolCallId = `tool-call-${input.suffix}-private-id`;
  const effectId = `effect-${input.suffix}-private-id`;
  const idempotencyKey = `${input.sessionId}:${turnId}:${callId}`;
  db.prepare(
    `INSERT INTO agent_runtime_turn (
       id, session_id, ordinal, status, accepted_at, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`,
  ).run(turnId, input.sessionId, input.ordinal, NOW, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO agent_runtime_tool_call (
       id, session_id, turn_id, call_id, name, access, status, idempotency_key,
       arguments_json, result_json, created_at, started_at, completed_at
     ) VALUES (?, ?, ?, ?, 'update_element', 'write', 'completed', ?, ?, '{}', ?, ?, ?)`,
  ).run(
    toolCallId,
    input.sessionId,
    turnId,
    callId,
    idempotencyKey,
    JSON.stringify({ name: input.name, secret: 'SECRET_RAW_ARGUMENT' }),
    NOW,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO agent_runtime_write_effect (
       id, project_id, route_kind, conversation_id, session_id, turn_id,
       tool_call_id, call_id, tool_name, tool_access, idempotency_key, phase,
       arguments_json, observed_revision_json, preimage_json, forward_json,
       inverse_json, reversibility, effect_json, result_json, claimed_at,
       confirmed_at, mutation_started_at, effect_committed_at, result_committed_at,
       updated_at
     ) VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, 'update_element', 'write', ?,
       'result_committed', ?, '{}', '{}', '{}', '{}', 'exact', '{}', '{}',
       ?, ?, ?, ?, ?, ?)`,
  ).run(
    effectId,
    PROJECT_ID,
    input.conversationId,
    input.sessionId,
    turnId,
    toolCallId,
    callId,
    idempotencyKey,
    JSON.stringify({ name: input.name, secret: 'SECRET_RAW_ARGUMENT' }),
    NOW,
    NOW,
    NOW,
    NOW,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO agent_runtime_write_review (
       id, effect_id, session_id, turn_id, tool_call_id, status,
       created_at, accepted_at, rejected_at, revert_started_at,
       revert_effect_json, settled_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `review-${input.suffix}-private-id`,
    effectId,
    input.sessionId,
    turnId,
    toolCallId,
    input.reviewStatus,
    NOW,
    input.reviewStatus === 'accepted_effect' ? NOW : null,
    input.reviewStatus === 'reverted' ? NOW : null,
    input.reviewStatus === 'reverted' ? NOW : null,
    input.reviewStatus === 'reverted' ? '{}' : null,
    input.reviewStatus === 'pending' ? null : NOW,
    NOW,
  );
}

describe('General Agent project handoff acceptance', () => {
  it('rebuilds a bounded same-project projection without transcript, ids, or inherited authority', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-project-handoff-'));
    directories.add(directory);
    const databasePath = path.join(directory, 'drifting.db');
    let gateway = new ProductFileBackedSqliteGateway(databasePath);
    seedProjectHandoff(gateway);

    const first = await createAgentProjectHandoffService({
      database: createDatabaseClient(gateway),
      now: () => SNAPSHOT_AT,
    }).read({ projectId: PROJECT_ID, currentSessionId: CURRENT_SESSION_ID });

    expect(first.projectName).toBe('漂流测试项目');
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]).toMatchObject({
      sourceConversationTitle: '旧会话：人物校对',
      sourceSessionRunning: true,
      objective: '校对米拉设定并补齐登场关系',
      progress: { total: 2, completed: 1, remaining: 1 },
      activeConstraints: ['不要改写正文'],
    });
    expect(first.tasks[0]?.completedSteps[0]?.title).toBe('核对现有设定');
    expect(first.tasks[0]?.remainingSteps[0]?.title).toBe('补齐登场关系');
    expect(first.currentNames).toEqual({
      chapters: { names: ['第一章'], truncated: false },
      inspirations: { names: ['潮汐意象'], truncated: false },
      elements: { names: ['米拉'], truncated: false },
      categories: { names: ['人物'], truncated: false },
      storylines: { names: ['主线'], truncated: false },
    });
    expect(first.recentWrites).toEqual([
      {
        sourceConversationTitle: '旧会话：人物校对',
        target: '要素「艾文」',
        outcome: 'pending_review',
        updatedAt: NOW,
      },
      {
        sourceConversationTitle: '旧会话：人物校对',
        target: '要素「米拉」',
        outcome: 'accepted',
        updatedAt: NOW,
      },
    ]);

    const serialized = JSON.stringify(first);
    for (const secret of [
      SOURCE_SESSION_ID,
      CURRENT_SESSION_ID,
      'task-source-private-id',
      'conversation-source-private-id',
      'SECRET_TRANSCRIPT_TEXT',
      'SECRET_RAW_ARGUMENT',
      'SECRET_PROSE_IN_RESULT_NOTE',
      'SECRET_CURRENT_SESSION_OBJECTIVE',
      'SECRET_DELETED_CONVERSATION_OBJECTIVE',
      'SECRET_FOREIGN_PROJECT_OBJECTIVE',
      'SECRET_DELETED_CHAPTER',
      'SECRET_FOREIGN_CHAPTER',
      'SECRET_CURRENT_SESSION_WRITE',
      '废弃写入',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const modelData = agentProjectHandoffModelData(first);
    expect(modelData).toContain('只读接力快照');
    expect(modelData).toContain('不转移计划、权限或控制权');
    expect(modelData).toContain('来源会话仍在运行');
    expect(modelData).toContain('revision 检查');

    const runtime = new AgentLongTaskToolRuntime({
      projectHandoff: createAgentProjectHandoffService({
        database: createDatabaseClient(gateway),
        now: () => SNAPSHOT_AT,
      }),
    });
    expect(
      runtime
        .listDefinitions({ route: { kind: 'chat', projectId: PROJECT_ID } })
        .find((definition) => definition.name === AGENT_PROJECT_HANDOFF_READ_TOOL),
    ).toMatchObject({ access: 'read' });
    const toolResult = await runtime.execute({
      sessionId: CURRENT_SESSION_ID,
      turnId: 'handoff-read-turn',
      callId: 'handoff-read-call',
      idempotencyKey: 'handoff-read-idempotency',
      name: AGENT_PROJECT_HANDOFF_READ_TOOL,
      access: 'read',
      arguments: {},
      context: { route: { kind: 'chat', projectId: PROJECT_ID } },
      signal: new AbortController().signal,
    });
    expect(toolResult.ok).toBe(true);
    if (toolResult.ok) {
      expect(toolResult.data).toEqual(first);
      expect(toolResult.modelData).toContain('只读接力快照');
    }

    await gateway.close();
    gateway = new ProductFileBackedSqliteGateway(databasePath, false);
    const reopened = await createAgentProjectHandoffService({
      database: createDatabaseClient(gateway),
      now: () => SNAPSHOT_AT,
    }).read({ projectId: PROJECT_ID, currentSessionId: CURRENT_SESSION_ID });
    expect(reopened).toEqual(first);
    await gateway.close();
  });
});
