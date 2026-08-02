import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeExpectedRevision,
  AgentRuntimeReadResult,
  CreateAgentRuntimeReadObservation,
} from '../../../domain/agent-runtime-freshness';
import type { DbExecutor } from '../../../lib/db';
import { LocalSyncMutationTable } from '../../../schema/drizzle';
import { createAgentRuntimeElementPatchReceiptRepository } from '../../../sqlite-repo/agent-runtime-element-patch-receipt-repo';
import { createAgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { createElementPatchRepository } from '../../../sqlite-repo/element-patch-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import type { AgentToolContext } from '../tool-handlers';
import { DriftingWriteToolRuntime } from './drifting-write-tool-runtime';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import {
  elementPatchRevision,
  elementPatchSetRevision,
} from './element-patch-revision';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from './types';
import { P3FileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';

const PROJECT_ID = 'patch-project';
const OTHER_PROJECT_ID = 'patch-project-other';
const SESSION_ID = 'patch-session';
const OTHER_SESSION_ID = 'patch-session-other';
const CONVERSATION_ID = 'patch-conversation';
const OTHER_CONVERSATION_ID = 'patch-conversation-other';
const AT = '2026-07-30T00:00:00.000Z';
const initialDataState = useDataStore.getState();

describe('certified element patch runtime', () => {
  let fixture: ElementPatchFixture;

  beforeEach(async () => {
    useAgentEditStore.getState().clearAll();
    fixture = await ElementPatchFixture.create();
  });

  afterEach(async () => {
    useAgentEditStore.getState().clearAll();
    useDataStore.setState(initialDataState, true);
    await fixture.close();
  });

  it('reconciles a receipt-proven create after restart without a second patch or outbox row', async () => {
    const token = await fixture.persistPatchRead(
      'read-create',
      'element-1',
      [],
      SESSION_ID,
      PROJECT_ID,
    );
    const request = fixture.writeRequest('create-crash', 'create_element_patch', {
      element: '柳青',
      title: '立场转变',
      body: '她决定公开反抗。',
      expectedRevision: token,
    });
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
          throw new Error('simulated process death after patch receipt');
        }
        return base.transitionEffect(transition);
      },
    };

    const first = await fixture.runtime(interrupted).execute(request);
    expect(first).toEqual({
      ok: false,
      error: 'simulated process death after patch receipt',
    });
    expect((await base.getEffect(`agent-write:${request.idempotencyKey}`))?.phase).toBe(
      'uncertain',
    );
    expect(fixture.scalar('SELECT count(*) FROM element_patch')).toBe(1);
    expect(
      fixture.scalar(
        'SELECT count(*) FROM agent_runtime_element_patch_receipt',
      ),
    ).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);

    const recovered = await fixture.runtime(base).execute(request);
    expect(recovered).toMatchObject({
      ok: true,
      data: {
        writeRef: `agent-write:${request.idempotencyKey}`,
        authorization: { kind: 'automatic' },
        result: { ok: true, title: '立场转变' },
      },
    });
    expect(fixture.scalar('SELECT count(*) FROM element_patch')).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);
    expect(
      fixture.scalar(
        'SELECT count(*) FROM agent_runtime_element_patch_receipt',
      ),
    ).toBe(1);
  });

  it('updates with patch CAS and creates no post-write review or inverse', async () => {
    const patch = await fixture.insertPatch('patch-1', '旧标题', '旧正文');
    const token = await fixture.persistPatchRead(
      'read-update',
      'element-1',
      [patch],
      SESSION_ID,
      PROJECT_ID,
      patch.id,
    );
    const request = fixture.writeRequest('update-1', 'update_element_patch', {
      patchId: patch.id,
      title: '新标题',
      body: '新正文',
      expectedRevision: token,
    });
    fixture.seedToolCall(request);
    const runtime = fixture.runtime();
    const written = await runtime.execute(request);
    expect(written).toMatchObject({
      ok: true,
      data: {
        writeRef: `agent-write:${request.idempotencyKey}`,
        authorization: { kind: 'automatic' },
      },
    });
    expect((await fixture.patch(patch.id))?.title).toBe('新标题');
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_element_patch_receipt WHERE direction = 'inverse'",
      ),
    ).toBe(0);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);
    expect(await fixture.runtime().execute(request)).toEqual(written);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);

  });

  it('hard-deletes an approved patch with an immutable null-postimage receipt', async () => {
    const patch = await fixture.insertPatch('patch-delete', '待删除', '正文');
    const token = await fixture.persistPatchRead(
      'read-delete',
      'element-1',
      [patch],
      SESSION_ID,
      PROJECT_ID,
      patch.id,
    );
    const request = fixture.writeRequest('delete-1', 'delete_element_patch', {
      patchId: patch.id,
      expectedRevision: token,
    });
    fixture.seedToolCall(request);

    const written = await fixture.runtime().execute(request);

    expect(written).toMatchObject({
      ok: true,
      data: {
        authorization: { kind: 'author_approved' },
        result: { ok: true, patchId: patch.id },
      },
    });
    expect(await fixture.patch(patch.id)).toBeNull();
    expect(
      fixture.rows(
        "SELECT tool_name, direction, result_revision, postimage_json " +
          "FROM agent_runtime_element_patch_receipt",
      ),
    ).toEqual([
      {
        tool_name: 'delete_element_patch',
        direction: 'forward',
        result_revision: null,
        postimage_json: null,
      },
    ]);
    expect(
      fixture.rows(
        "SELECT entity_type, mutation_type, entity_id FROM local_sync_mutation",
      ),
    ).toEqual([
      {
        entity_type: 'elementPatch',
        mutation_type: 'delete',
        entity_id: patch.id,
      },
    ]);
    expect(await fixture.runtime().execute(request)).toEqual(written);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);

    const effect = await createAgentRuntimeWriteEffectRepository(
      fixture.client,
    ).getEffect(`agent-write:${request.idempotencyKey}`);
    if (!effect) throw new Error('Missing certified delete effect');
    const strategy = getDriftingWriteStrategy('delete_element_patch', {
      freshness: fixture.freshness,
      elementPatchDb: fixture.client,
      elementPatchReceipts: createAgentRuntimeElementPatchReceiptRepository(
        fixture.client,
      ),
      elementPatchNotifySyncCommitted: () => {},
    });
    if (!strategy) throw new Error('Missing certified delete strategy');
    await expect(
      strategy.applyInverse(
        effect,
        { projectId: PROJECT_ID, write: {} as AgentToolContext['write'] },
        request.signal,
      ),
    ).resolves.toMatchObject({
      kind: 'element_patch_revert',
      patchId: patch.id,
    });
    expect(await fixture.patch(patch.id)).toMatchObject({
      id: patch.id,
      title: patch.title,
      contentJson: patch.contentJson,
      updatedAt: patch.updatedAt,
    });
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_element_patch_receipt WHERE direction = 'inverse'",
      ),
    ).toBe(1);
  });

  it('fails closed for stale patch content and cross-project receipts', async () => {
    const patch = await fixture.insertPatch('patch-race', '初始', '正文');
    const stale = await fixture.persistPatchRead(
      'read-stale',
      'element-1',
      [patch],
      SESSION_ID,
      PROJECT_ID,
      patch.id,
    );
    await createElementPatchRepository(fixture.client).update(patch.id, {
      title: '人工先改',
    });
    const staleWrite = fixture.writeRequest(
      'write-stale',
      'update_element_patch',
      {
        patchId: patch.id,
        title: 'Agent 改',
        expectedRevision: stale,
      },
    );
    fixture.seedToolCall(staleWrite);
    expect(await fixture.runtime().execute(staleWrite)).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed after it was read'),
    });
    expect((await fixture.patch(patch.id))?.title).toBe('人工先改');

    const foreign = await fixture.persistPatchRead(
      'foreign-read',
      'foreign-element',
      [],
      OTHER_SESSION_ID,
      OTHER_PROJECT_ID,
    );
    const cross = fixture.writeRequest('cross-project', 'create_element_patch', {
      element: '柳青',
      title: '越界',
      expectedRevision: foreign,
    });
    fixture.seedToolCall(cross);
    expect(await fixture.runtime().execute(cross)).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'get_element_patches receipt from this project and session',
      ),
    });

    const latest = (await fixture.patch(patch.id))!;
    const updateToken = await fixture.persistPatchRead(
      'read-conflict',
      'element-1',
      [latest],
      SESSION_ID,
      PROJECT_ID,
      patch.id,
    );
    const update = fixture.writeRequest(
      'write-conflict',
      'update_element_patch',
      {
        patchId: patch.id,
        title: 'Agent 标题',
        expectedRevision: updateToken,
      },
    );
    fixture.seedToolCall(update);
    const runtime = fixture.runtime();
    const result = await runtime.execute(update);
    if (!result.ok) throw new Error(result.error);
    await createElementPatchRepository(fixture.client).update(patch.id, {
      title: '作者最终标题',
    });
    expect((await fixture.patch(patch.id))?.title).toBe('作者最终标题');
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);
  });

  it('does not update or build on a patch that is pending author deletion', async () => {
    const patch = await fixture.insertPatch('patch-pending-delete', '旧标题', '旧正文');
    const updateToken = await fixture.persistPatchRead(
      'read-before-delete',
      'element-1',
      [patch],
      SESSION_ID,
      PROJECT_ID,
      patch.id,
    );
    const createToken = await fixture.persistPatchRead(
      'read-set-before-delete',
      'element-1',
      [patch],
      SESSION_ID,
      PROJECT_ID,
    );
    useAgentEditStore.setState({
      pending: {
        'element:element-1': {
          entityType: 'element',
          id: 'element-1',
          changes: [
            {
              blockId: `field:patch:${patch.id}`,
              op: 'deleted',
              oldText: '旧正文',
              newText: '',
              afterPrevId: null,
              field: {
                kind: 'patch',
                key: patch.id,
                label: '演化记录',
              },
            },
          ],
        },
      },
    });

    const update = fixture.writeRequest(
      'update-pending-delete',
      'update_element_patch',
      {
        patchId: patch.id,
        title: '不应写入',
        expectedRevision: updateToken,
      },
    );
    fixture.seedToolCall(update);
    await expect(fixture.runtime().execute(update)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('not available for Agent changes'),
    });

    const create = fixture.writeRequest(
      'create-after-pending-delete',
      'create_element_patch',
      {
        element: '柳青',
        title: '不应基于隐藏集合创建',
        expectedRevision: createToken,
      },
    );
    fixture.seedToolCall(create);
    await expect(fixture.runtime().execute(create)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('changed after it was read'),
    });
    expect((await fixture.patch(patch.id))?.title).toBe('旧标题');
    expect(fixture.scalar('SELECT count(*) FROM element_patch')).toBe(1);
  });

  it('does not schedule an inverse after a hard-authorized patch update', async () => {
    const patch = await fixture.insertPatch('patch-post-commit', '旧标题', '旧正文');
    const token = await fixture.persistPatchRead(
      'read-post-commit',
      'element-1',
      [patch],
      SESSION_ID,
      PROJECT_ID,
      patch.id,
    );
    const request = fixture.writeRequest(
      'update-post-commit',
      'update_element_patch',
      {
        patchId: patch.id,
        title: 'Agent 标题',
        expectedRevision: token,
      },
    );
    fixture.seedToolCall(request);
    let notifications = 0;
    const runtime = fixture.runtime(undefined, () => {
      notifications += 1;
    });
    const written = await runtime.execute(request);
    if (!written.ok) throw new Error(written.error);
    expect(written).toMatchObject({
      data: { authorization: { kind: 'automatic' } },
    });
    expect((await fixture.patch(patch.id))?.title).toBe('Agent 标题');
    expect(notifications).toBe(1);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_element_patch_receipt WHERE direction = 'inverse'",
      ),
    ).toBe(0);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);
  });
});

class ElementPatchFixture {
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

  static async create(): Promise<ElementPatchFixture> {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-element-patch-runtime-'),
    );
    const gateway = new P3FileBackedSqliteGateway(
      path.join(directory, 'runtime.sqlite'),
    );
    gateway.database.exec(`
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
      CREATE TABLE element_patch (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        source_node_id TEXT,
        source_block_id TEXT,
        source_block_text TEXT,
        text_anchor_json TEXT,
        invalidated_at TEXT,
        title TEXT,
        content_json TEXT DEFAULT '{}' NOT NULL,
        order_key INTEGER DEFAULT 0 NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE comment (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT
      );
      CREATE TABLE entity_relation (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_id TEXT NOT NULL
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
    const fixture = new ElementPatchFixture(directory, gateway);
    fixture.seed();
    return fixture;
  }

  private seed(): void {
    const db = this.gateway.database;
    for (const [projectId, conversationId, sessionId] of [
      [PROJECT_ID, CONVERSATION_ID, SESSION_ID],
      [OTHER_PROJECT_ID, OTHER_CONVERSATION_ID, OTHER_SESSION_ID],
    ]) {
      db.prepare(`
        INSERT INTO project (id, name, user_id, created_at, updated_at)
        VALUES (?, ?, 'user-1', ?, ?)
      `).run(projectId, projectId, AT, AT);
      db.prepare(`
        INSERT INTO agent_conversation (
          id, project_id, title, created_at, updated_at
        ) VALUES (?, ?, 'Patch runtime', ?, ?)
      `).run(conversationId, projectId, AT, AT);
      db.prepare(`
        INSERT INTO agent_runtime_session (
          id, project_id, route_kind, conversation_id, provider, model,
          provider_epoch, status, created_at, updated_at
        ) VALUES (?, ?, 'chat', ?, 'test', 'test', 0, 'running', ?, ?)
      `).run(sessionId, projectId, conversationId, AT, AT);
    }
    db.prepare(`
      INSERT INTO element (
        id, project_id, name, created_at, updated_at
      ) VALUES ('element-1', ?, '柳青', ?, ?)
    `).run(PROJECT_ID, AT, AT);
    db.prepare(`
      INSERT INTO element (
        id, project_id, name, created_at, updated_at
      ) VALUES ('foreign-element', ?, '外项目角色', ?, ?)
    `).run(OTHER_PROJECT_ID, AT, AT);
    useDataStore.setState({
      ...initialDataState,
      bookElements: [
        makeElement('element-1', PROJECT_ID, '柳青'),
        makeElement('foreign-element', OTHER_PROJECT_ID, '外项目角色'),
      ],
      bookNodes: [],
    });
  }

  runtime(
    repository: AgentRuntimeWriteEffectRepository =
      createAgentRuntimeWriteEffectRepository(this.client),
    notifySyncCommitted: () => void = () => {},
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
      elementPatchReceipts:
        createAgentRuntimeElementPatchReceiptRepository(this.client),
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
      elementPatchNotifySyncCommitted: notifySyncCommitted,
      now: () => this.now(),
    });
  }

  async insertPatch(id: string, title: string, body: string) {
    return createElementPatchRepository(this.client).create({
      id,
      projectId: PROJECT_ID,
      elementId: 'element-1',
      title,
      contentJson: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: body }],
          },
        ],
      }),
    });
  }

  patch(id: string) {
    return createElementPatchRepository(this.client).findById(id);
  }

  async persistPatchRead(
    callId: string,
    elementId: string,
    patches: Awaited<ReturnType<ElementPatchFixture['patch']>>[],
    sessionId: string,
    projectId: string,
    targetPatchId?: string,
  ): Promise<AgentRuntimeExpectedRevision> {
    const request = this.readRequest(
      callId,
      sessionId,
      projectId,
      projectId === PROJECT_ID ? CONVERSATION_ID : OTHER_CONVERSATION_ID,
    );
    this.seedToolCall(request);
    const live = patches.filter((patch): patch is NonNullable<typeof patch> =>
      Boolean(patch),
    );
    const observations: CreateAgentRuntimeReadObservation[] = [
      {
        id: observationId(request, 0),
        entityKind: 'element_patch_set',
        entityId: elementId,
        revision: await elementPatchSetRevision(live),
      },
      ...await Promise.all(
        live.map(async (patch, index) => ({
          id: observationId(request, index + 1),
          entityKind: 'element_patch',
          entityId: patch.id,
          revision: await elementPatchRevision(patch),
        })),
      ),
    ];
    const receiptId = `agent-read:${request.idempotencyKey}`;
    const result: AgentRuntimeReadResult = {
      result: { patches: live.map((patch) => ({ patchId: patch.id })) },
      freshness: {
        receiptId,
        observations: observations.map((observation) => ({
          id: observation.id,
          entityKind: observation.entityKind,
          entityId: observation.entityId,
          revision: observation.revision,
        })),
      },
    };
    await this.freshness.persistReadReceipt({
      id: receiptId,
      projectId,
      sessionId,
      turnId: request.turnId,
      toolCallId: runtimeToolCallId(request),
      callId,
      toolName: 'get_element_patches',
      idempotencyKey: request.idempotencyKey,
      result,
      observations,
      createdAt: this.now(),
    });
    const target = targetPatchId
      ? observations.find(
          (observation) =>
            observation.entityKind === 'element_patch' &&
            observation.entityId === targetPatchId,
        )
      : observations[0];
    if (!target) throw new Error('Missing patch freshness target');
    return {
      receiptId,
      observationId: target.id,
      revision: target.revision,
    };
  }

  writeRequest(
    callId: string,
    name:
      | 'create_element_patch'
      | 'update_element_patch'
      | 'delete_element_patch',
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
      authorization:
        name === 'delete_element_patch'
          ? authorApprovedAuthorization(callId, arguments_)
          : automaticAuthorization(arguments_),
      context: runtimeContext(),
      control: {
        requestUserInput: async () => {
          throw new Error('not used');
        },
      },
      signal: new AbortController().signal,
    };
  }

  private readRequest(
    callId: string,
    sessionId: string,
    projectId: string,
    conversationId: string,
  ): AgentToolExecutionRequest {
    return {
      sessionId,
      turnId: `turn:${callId}`,
      callId,
      idempotencyKey: `${sessionId}:turn:${callId}:${callId}`,
      name: 'get_element_patches',
      arguments: {
        element: projectId === PROJECT_ID ? '柳青' : '外项目角色',
      },
      access: 'read',
      context: {
        route: { kind: 'chat', projectId, conversationId },
      },
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

  scalar(sql: string): number {
    const row = this.gateway.database.prepare(sql).get() as Record<
      string,
      unknown
    >;
    return Number(Object.values(row)[0] ?? 0);
  }

  rows(sql: string): Record<string, unknown>[] {
    return this.gateway.database.prepare(sql).all() as Record<string, unknown>[];
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

function authorApprovedAuthorization(
  callId: string,
  arguments_: Record<string, unknown>,
) {
  return {
    ...automaticAuthorization(arguments_),
    kind: 'author_approved' as const,
    requestId: `permission:${callId}`,
  };
}

function observationId(
  request: AgentToolExecutionRequest,
  ordinal: number,
): string {
  return `agent-observation:${request.sessionId}:${request.turnId}:${request.callId}:${ordinal}`;
}

function makeElement(id: string, projectId: string, name: string) {
  return {
    id,
    projectId,
    categoryId: null,
    name,
    summary: '',
    contentJson: '{}',
    kvJson: '[]',
    aliases: [],
    groupName: null,
    portraitAssetId: null,
    createdAt: AT,
    updatedAt: AT,
  };
}
