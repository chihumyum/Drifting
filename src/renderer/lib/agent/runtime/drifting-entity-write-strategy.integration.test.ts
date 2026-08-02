import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeExpectedRevision,
  AgentRuntimeReadResult,
} from '../../../domain/agent-runtime-freshness';
import type { DbExecutor } from '../../../lib/db';
import { LocalSyncMutationTable } from '../../../schema/drizzle';
import { createAgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { createBookElementSqliteRepository } from '../../../sqlite-repo/element-repo';
import { createCommentRepository } from '../../../sqlite-repo/comment-repo';
import { createProjectRepository } from '../../../sqlite-repo/project-repo';
import { createStorylineRepository } from '../../../sqlite-repo/storyline-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import type { AgentToolContext } from '../tool-handlers';
import { P3FileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import { DriftingReadToolRuntime } from './drifting-read-tool-runtime';
import { DriftingWriteToolRuntime } from './drifting-write-tool-runtime';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from './types';

const PROJECT_ID = 'entity-write-project';
const SESSION_ID = 'entity-write-session';
const CONVERSATION_ID = 'entity-write-conversation';
const AT = '2026-07-31T00:00:00.000Z';
const initialDataState = useDataStore.getState();
const initialProjectState = useProjectStore.getState();

type ToolName =
  | 'update_element'
  | 'update_storyline'
  | 'update_project_facts'
  | 'create_comment';

describe('certified entity write runtime', () => {
  let fixture: EntityWriteFixture;

  beforeEach(async () => {
    useAgentEditStore.getState().clearAll();
    fixture = await EntityWriteFixture.create();
  });

  afterEach(async () => {
    useAgentEditStore.getState().clearAll();
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    await fixture.close();
  });

  it('commits all four domain writes with one outbox and typed receipt each without post-write reviews', async () => {
    const elementToken = await fixture.persistRead(
      'read-element',
      'read_element',
      'element',
      'element-1',
      AT,
    );
    const element = await fixture.execute(
      'write-element',
      'update_element',
      {
        element: '柳青',
        summary: 'Agent 新简介',
        facts: [{ key: '身份', value: '侦探' }],
        expectedRevision: elementToken,
      },
    );

    const storylineToken = await fixture.persistRead(
      'read-storyline',
      'get_storyline',
      'storyline',
      'storyline-1',
      AT,
    );
    const storyline = await fixture.execute(
      'write-storyline',
      'update_storyline',
      {
        storyline: '主线',
        summary: 'Agent 新梗概',
        facts: [{ key: 'POV', value: '柳青' }],
        expectedRevision: storylineToken,
      },
    );

    const projectBefore = await fixture.project();
    const projectToken = await fixture.persistRead(
      'read-project',
      'get_overview',
      'project',
      PROJECT_ID,
      projectBefore.updatedAt,
    );
    const project = await fixture.execute(
      'write-project',
      'update_project_facts',
      {
        facts: [{ key: '文风', value: '冷峻' }],
        expectedRevision: projectToken,
      },
    );

    const currentProject = await fixture.project();
    const commentToken = await fixture.persistRead(
      'read-comment-project',
      'get_project_brief',
      'project',
      PROJECT_ID,
      currentProject.updatedAt,
    );
    const comment = await fixture.execute(
      'write-comment',
      'create_comment',
      {
        body: '检查人物动机。',
        kind: 'todo',
        targetKind: 'element',
        target: '柳青',
        expectedRevision: commentToken,
      },
    );

    for (const result of [element, storyline, project, comment]) {
      expect(result).toMatchObject({
        ok: true,
        authorization: { kind: 'automatic' },
      });
    }
    expect(
      (await fixture.element()).summary,
    ).toBe('Agent 新简介');
    expect((await fixture.storyline()).summary).toBe('Agent 新梗概');
    expect((await fixture.project()).kvJson).toContain('冷峻');
    expect((await fixture.comments())).toHaveLength(1);
    expect((await fixture.comments())[0]).toMatchObject({
      authorKind: 'ai',
      source: 'api',
      metadataJson: null,
      targetKind: 'element',
      targetId: 'element-1',
    });
    expect(
      fixture.scalar(
        'SELECT count(*) FROM agent_runtime_entity_write_receipt',
      ),
    ).toBe(4);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      4,
    );

    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE direction = 'inverse'",
      ),
    ).toBe(0);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);
  });

  it('reconciles a post-commit process death from the immutable receipt without duplicating a comment or outbox row', async () => {
    const project = await fixture.project();
    const token = await fixture.persistRead(
      'read-crash',
      'get_project_brief',
      'project',
      PROJECT_ID,
      project.updatedAt,
    );
    const request = fixture.writeRequest(
      'write-crash',
      'create_comment',
      {
        body: '只应创建一次。',
        expectedRevision: token,
      },
    );
    fixture.seedToolCall(request);
    const base = createAgentRuntimeWriteEffectRepository(fixture.client);
    let interruptCommit = true;
    const interrupted: AgentRuntimeWriteEffectRepository = {
      ...base,
      transitionEffect: async (transition) => {
        if (
          interruptCommit &&
          transition.nextPhase === 'effect_committed'
        ) {
          interruptCommit = false;
          throw new Error('simulated death after entity receipt');
        }
        return base.transitionEffect(transition);
      },
    };

    expect(await fixture.runtime(interrupted).execute(request)).toEqual({
      ok: false,
      error: 'simulated death after entity receipt',
    });
    expect((await base.getEffect(`agent-write:${request.idempotencyKey}`))?.phase).toBe(
      'uncertain',
    );
    expect((await fixture.comments())).toHaveLength(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      1,
    );

    const recovered = await fixture.runtime(base).execute(request);
    expect(recovered).toMatchObject({
      ok: true,
      data: {
        writeRef: `agent-write:${request.idempotencyKey}`,
        authorization: { kind: 'automatic' },
        result: { ok: true },
      },
    });
    expect((await fixture.comments())).toHaveLength(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      1,
    );
    expect(
      fixture.scalar(
        'SELECT count(*) FROM agent_runtime_entity_write_receipt',
      ),
    ).toBe(1);
  });

  it('captures project freshness from get_overview and accepts that receipt for a project write', async () => {
    const request = fixture.readRequest('overview-freshness', 'get_overview');
    fixture.seedToolCall(request);
    const context: AgentToolContext = {
      projectId: PROJECT_ID,
      write: {} as AgentToolContext['write'],
    };
    const readRuntime = new DriftingReadToolRuntime({
      getContext: () => context,
      freshness: fixture.freshness,
      artifacts: null,
      now: () => '2026-07-31T00:20:00.000Z',
    });
    const read = await readRuntime.execute(request);
    expect(read).toMatchObject({
      ok: true,
      data: {
        freshness: {
          observations: [
            {
              entityKind: 'project',
              entityId: PROJECT_ID,
              revision: AT,
            },
          ],
        },
      },
    });
    if (!read.ok) throw new Error(read.error);
    const freshness = (
      read.data as AgentRuntimeReadResult
    ).freshness;
    const written = await fixture.execute(
      'overview-project-write',
      'update_project_facts',
      {
        facts: [{ key: '视角', value: '第一人称' }],
        expectedRevision: {
          receiptId: freshness.receiptId,
          observationId: freshness.observations[0]!.id,
          revision: freshness.observations[0]!.revision,
        },
      },
    );
    expect(written.ok).toBe(true);
  });

  it('fails closed when the SQLite entity revision changed after the cited read', async () => {
    const noOpToken = await fixture.persistRead(
      'read-noop',
      'read_element',
      'element',
      'element-1',
      AT,
    );
    expect(
      await fixture.execute('write-noop', 'update_element', {
        element: '柳青',
        summary: '旧简介',
        expectedRevision: noOpToken,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('would not change'),
    });

    const token = await fixture.persistRead(
      'read-stale',
      'read_element',
      'element',
      'element-1',
      AT,
    );
    await createBookElementSqliteRepository(
      PROJECT_ID,
      fixture.client,
    ).update('element-1', {
      summary: '作者先改',
      updatedAt: '2026-07-31T00:10:00.000Z',
    });
    const request = fixture.writeRequest(
      'write-stale',
      'update_element',
      {
        element: '柳青',
        summary: 'Agent 不应覆盖',
        expectedRevision: token,
      },
    );
    fixture.seedToolCall(request);

    expect(await fixture.runtime().execute(request)).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed after read_element'),
    });
    expect((await fixture.element()).summary).toBe('作者先改');
    expect(
      fixture.scalar(
        'SELECT count(*) FROM agent_runtime_entity_write_receipt',
      ),
    ).toBe(0);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      0,
    );
  });

  it('keeps hard-authorized writes final and revalidates comment targets inside the mutation transaction', async () => {
    const elementToken = await fixture.persistRead(
      'read-hash',
      'read_element',
      'element',
      'element-1',
      AT,
    );
    const written = await fixture.execute(
      'write-hash',
      'update_element',
      {
        element: '柳青',
        summary: 'Agent 值',
        expectedRevision: elementToken,
      },
    );
    if (!written.ok) throw new Error(written.error);
    fixture.gateway.database
      .prepare(
        "UPDATE element SET summary = '同 revision 篡改' WHERE id = 'element-1'",
      )
      .run();
    expect((await fixture.element()).summary).toBe('同 revision 篡改');
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);

    const project = await fixture.project();
    const commentToken = await fixture.persistRead(
      'read-target-delete',
      'get_project_brief',
      'project',
      PROJECT_ID,
      project.updatedAt,
    );
    await createBookElementSqliteRepository(
      PROJECT_ID,
      fixture.client,
    ).delete('element-1');
    const comment = await fixture.execute(
      'write-target-delete',
      'create_comment',
      {
        body: '不应成为悬挂批注',
        targetKind: 'element',
        target: '柳青',
        expectedRevision: commentToken,
      },
    );
    expect(comment).toMatchObject({
      ok: false,
      error: expect.stringContaining('no longer exists'),
    });
    expect(await fixture.comments()).toHaveLength(0);
  });
});

class EntityWriteFixture {
  readonly client: DbExecutor;
  readonly freshness;
  private tick = 0;

  private constructor(
    readonly directory: string,
    readonly gateway: P3FileBackedSqliteGateway,
  ) {
    this.client = gateway.client();
    this.freshness = createAgentRuntimeFreshnessRepository(this.client);
  }

  static async create(): Promise<EntityWriteFixture> {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-entity-write-runtime-'),
    );
    const gateway = new P3FileBackedSqliteGateway(
      path.join(directory, 'runtime.sqlite'),
    );
    gateway.database.exec(`
      ALTER TABLE project ADD COLUMN summary TEXT DEFAULT '' NOT NULL;
      ALTER TABLE project ADD COLUMN kv_json TEXT DEFAULT '[]' NOT NULL;
      ALTER TABLE project ADD COLUMN storyline_template_kv_json TEXT DEFAULT '[]' NOT NULL;
      CREATE TABLE element_category (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content_json TEXT DEFAULT '{}' NOT NULL,
        element_template_json TEXT DEFAULT '{}' NOT NULL,
        element_template_kv_json TEXT DEFAULT '[]' NOT NULL,
        layout_mode TEXT DEFAULT 'auto' NOT NULL,
        order_key INTEGER DEFAULT 0 NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE element (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        category_id TEXT,
        name TEXT NOT NULL,
        summary TEXT DEFAULT '' NOT NULL,
        content_json TEXT DEFAULT '{}' NOT NULL,
        kv_json TEXT DEFAULT '[]' NOT NULL,
        aliases_json TEXT DEFAULT '[]' NOT NULL,
        group_name TEXT,
        portrait_asset_id TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE storylines (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#888888' NOT NULL,
        summary TEXT DEFAULT '' NOT NULL,
        order_key REAL DEFAULT 0 NOT NULL,
        content_json TEXT DEFAULT '{}' NOT NULL,
        kv_json TEXT DEFAULT '[]' NOT NULL,
        node_content_template_json TEXT DEFAULT '{}' NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE comment (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        target_block_id TEXT,
        anchor_json TEXT DEFAULT '{}' NOT NULL,
        author_kind TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        body_json TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT,
        source TEXT NOT NULL,
        metadata_json TEXT,
        target_block_ids_json TEXT DEFAULT '[]' NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE local_sync_mutation (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        entity_type TEXT NOT NULL,
        mutation_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        payload_json TEXT,
        mutation_ts INTEGER NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        retry_count INTEGER DEFAULT 0 NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const fixture = new EntityWriteFixture(directory, gateway);
    fixture.seed();
    return fixture;
  }

  private seed(): void {
    const db = this.gateway.database;
    db.prepare(`
      INSERT INTO project (
        id, name, summary, kv_json, storyline_template_kv_json,
        user_id, created_at, updated_at
      ) VALUES (?, '测试书', '', '[]', '[]', 'user-1', ?, ?)
    `).run(PROJECT_ID, AT, AT);
    db.prepare(`
      INSERT INTO agent_conversation (
        id, project_id, title, created_at, updated_at
      ) VALUES (?, ?, 'Entity runtime', ?, ?)
    `).run(CONVERSATION_ID, PROJECT_ID, AT, AT);
    db.prepare(`
      INSERT INTO agent_runtime_session (
        id, project_id, route_kind, conversation_id, provider, model,
        provider_epoch, status, created_at, updated_at
      ) VALUES (?, ?, 'chat', ?, 'test', 'test', 0, 'running', ?, ?)
    `).run(SESSION_ID, PROJECT_ID, CONVERSATION_ID, AT, AT);
    db.prepare(`
      INSERT INTO element (
        id, project_id, name, summary, created_at, updated_at
      ) VALUES ('element-1', ?, '柳青', '旧简介', ?, ?)
    `).run(PROJECT_ID, AT, AT);
    db.prepare(`
      INSERT INTO storylines (
        id, project_id, name, summary, created_at, updated_at
      ) VALUES ('storyline-1', ?, '主线', '旧梗概', ?, ?)
    `).run(PROJECT_ID, AT, AT);
    const project = {
      id: PROJECT_ID,
      userId: 'user-1',
      name: '测试书',
      summary: '',
      kvJson: '[]',
      storylineTemplateKvJson: '[]',
      createdAt: AT,
      updatedAt: AT,
    };
    useProjectStore.setState({
      ...initialProjectState,
      currentProject: project,
      projects: [project],
    });
    useDataStore.setState({
      ...initialDataState,
      bookElements: [
        {
          id: 'element-1',
          projectId: PROJECT_ID,
          categoryId: null,
          name: '柳青',
          summary: '旧简介',
          contentJson: '{}',
          kvJson: '[]',
          aliases: [],
          groupName: null,
          portraitAssetId: null,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      storylines: [
        {
          id: 'storyline-1',
          projectId: PROJECT_ID,
          name: '主线',
          color: '#888888',
          summary: '旧梗概',
          orderKey: 0,
          contentJson: '{}',
          kvJson: '[]',
          nodeContentTemplateJson: '{}',
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      bookNodes: [],
      comments: [],
    });
  }

  runtime(
    repository: AgentRuntimeWriteEffectRepository =
      createAgentRuntimeWriteEffectRepository(this.client),
  ): DriftingWriteToolRuntime {
    const context: AgentToolContext = {
      projectId: PROJECT_ID,
      write: {} as AgentToolContext['write'],
    };
    const emptyReads: AgentToolRuntime = {
      listDefinitions: () => [],
      execute: async () => ({ ok: false, error: 'not used' }),
    };
    return new DriftingWriteToolRuntime({
      repository,
      freshness: this.freshness,
      readRuntime: emptyReads,
      getContext: () => context,
      elementPatchDb: this.client,
      elementPatchPersistSyncMutation: async (tx, mutation) => {
        const at = this.now();
        await tx.insert(LocalSyncMutationTable).values({
          entityType: mutation.entityType,
          mutationType: mutation.mutationType,
          entityId: mutation.entityId,
          projectId: mutation.projectId,
          parentId: mutation.parentId ?? null,
          payloadJson:
            mutation.payload === undefined
              ? null
              : canonicalAgentRuntimeJson(mutation.payload),
          mutationTs: mutation.timestamp,
          status: 'pending',
          retryCount: 0,
          lastError: null,
          createdAt: at,
          updatedAt: at,
        });
        return true;
      },
      elementPatchNotifySyncCommitted: () => {},
      now: () => this.now(),
    });
  }

  async execute(
    callId: string,
    name: ToolName,
    arguments_: Record<string, unknown>,
  ): Promise<
    | { ok: false; error: string }
    | {
        ok: true;
        writeRef: string;
        authorization: { kind: 'automatic' | 'author_approved' };
      }
  > {
    const request = this.writeRequest(callId, name, arguments_);
    this.seedToolCall(request);
    const result = await this.runtime().execute(request);
    if (!result.ok) return result;
    const data = result.data as {
      writeRef: string;
      authorization: { kind: 'automatic' | 'author_approved' };
    };
    return {
      ok: true,
      writeRef: data.writeRef,
      authorization: data.authorization,
    };
  }

  async persistRead(
    callId: string,
    toolName:
      | 'read_element'
      | 'get_storyline'
      | 'get_project_brief'
      | 'get_overview',
    entityKind: 'element' | 'storyline' | 'project',
    entityId: string,
    revision: string,
  ): Promise<AgentRuntimeExpectedRevision> {
    const request = this.readRequest(callId, toolName);
    this.seedToolCall(request);
    const observation = {
      id: observationId(request, 0),
      entityKind,
      entityId,
      revision,
    };
    const receiptId = `agent-read:${request.idempotencyKey}`;
    const result: AgentRuntimeReadResult = {
      result: {},
      freshness: {
        receiptId,
        observations: [observation],
      },
    };
    await this.freshness.persistReadReceipt({
      id: receiptId,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      turnId: request.turnId,
      toolCallId: runtimeToolCallId(request),
      callId,
      toolName,
      idempotencyKey: request.idempotencyKey,
      result,
      observations: [observation],
      createdAt: this.now(),
    });
    return {
      receiptId,
      observationId: observation.id,
      revision,
    };
  }

  writeRequest(
    callId: string,
    name: ToolName,
    arguments_: Record<string, unknown>,
  ): AgentToolExecutionRequest {
    return {
      sessionId: SESSION_ID,
      turnId: `turn:${callId}`,
      callId,
      idempotencyKey: `${SESSION_ID}:turn:${callId}:${callId}`,
      name,
      arguments: arguments_,
      access: 'write',
      authorization: automaticAuthorization(arguments_),
      context: runtimeContext(),
      control: {
        requestUserInput: async () => {
          throw new Error('not used');
        },
      },
      signal: new AbortController().signal,
    };
  }

  readRequest(
    callId: string,
    name:
      | 'read_element'
      | 'get_storyline'
      | 'get_project_brief'
      | 'get_overview',
  ): AgentToolExecutionRequest {
    return {
      sessionId: SESSION_ID,
      turnId: `turn:${callId}`,
      callId,
      idempotencyKey: `${SESSION_ID}:turn:${callId}:${callId}`,
      name,
      arguments:
        name === 'read_element'
          ? { element: '柳青' }
          : name === 'get_storyline'
            ? { storyline: '主线' }
            : {},
      access: 'read',
      context: runtimeContext(),
      control: {
        requestUserInput: async () => {
          throw new Error('not used');
        },
      },
      signal: new AbortController().signal,
    };
  }

  seedToolCall(request: AgentToolExecutionRequest): void {
    const at = this.now();
    this.gateway.database.prepare(`
      INSERT INTO agent_runtime_turn (
        id, session_id, ordinal, status, prompt_message_id,
        accepted_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      request.turnId,
      request.sessionId,
      ++this.tick,
      `message:${request.turnId}`,
      at,
      at,
      at,
    );
    this.gateway.database.prepare(`
      INSERT INTO agent_runtime_message (
        id, session_id, turn_id, ordinal, role, status,
        content_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'user', 'complete', '"fixture"', ?, ?)
    `).run(
      `message:${request.turnId}`,
      request.sessionId,
      request.turnId,
      ++this.tick,
      at,
      at,
    );
    this.gateway.database.prepare(`
      INSERT INTO agent_runtime_tool_call (
        id, session_id, turn_id, call_id, name, access, status,
        idempotency_key, arguments_json, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      runtimeToolCallId(request),
      request.sessionId,
      request.turnId,
      request.callId,
      request.name,
      request.access,
      request.idempotencyKey,
      canonicalAgentRuntimeJson(request.arguments),
      at,
      at,
    );
  }

  element() {
    return createBookElementSqliteRepository(
      PROJECT_ID,
      this.client,
    ).findById('element-1') as Promise<NonNullable<Awaited<ReturnType<ReturnType<typeof createBookElementSqliteRepository>['findById']>>>>;
  }

  storyline() {
    return createStorylineRepository(
      PROJECT_ID,
      this.client,
    ).getStorylineById('storyline-1') as Promise<NonNullable<Awaited<ReturnType<ReturnType<typeof createStorylineRepository>['getStorylineById']>>>>;
  }

  project() {
    return createProjectRepository(undefined, this.client).findById(
      PROJECT_ID,
    ) as Promise<NonNullable<Awaited<ReturnType<ReturnType<typeof createProjectRepository>['findById']>>>>;
  }

  comments() {
    return createCommentRepository(PROJECT_ID, this.client).findAll();
  }

  scalar(sql: string): number {
    const row = this.gateway.database.prepare(sql).get() as Record<
      string,
      unknown
    >;
    return Number(Object.values(row)[0] ?? 0);
  }

  async close(): Promise<void> {
    await this.gateway.close();
    await rm(this.directory, { recursive: true, force: true });
  }

  private now(): string {
    this.tick += 1;
    return new Date(Date.parse(AT) + this.tick).toISOString();
  }
}

function runtimeContext(): AgentRuntimeContext {
  return {
    route: {
      kind: 'chat',
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
    },
  };
}

function runtimeToolCallId(request: AgentToolExecutionRequest): string {
  return `agent-tool:${request.sessionId}:${request.turnId}:${request.callId}`;
}

function automaticAuthorization(arguments_: Record<string, unknown>) {
  return {
    kind: 'automatic' as const,
    requestId: null,
    argumentsHash: `sha256:${createHash('sha256')
      .update(canonicalAgentRuntimeJson(arguments_))
      .digest('hex')}`,
  };
}

function observationId(
  request: AgentToolExecutionRequest,
  ordinal: number,
): string {
  return `agent-observation:${request.idempotencyKey}:${ordinal}`;
}
