import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeExpectedRevision,
  AgentRuntimeReadResult,
  AgentRuntimeNodeWriteGuard,
} from '../../../domain/agent-runtime-freshness';
import type { BookNode } from '../../../domain/book-node';
import { createDatabaseClient, type DbExecutor } from '../../../lib/db';
import {
  BookNodeTable,
  LocalSyncMutationTable,
} from '../../../schema/drizzle';
import { createAgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import {
  canonicalAgentRuntimeJson,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { useDataStore } from '../../../store/data-store';
import {
  persistBookNodeUpdateWithSync,
  type BookNodeAtomicTransactionRunner,
} from '../../../usecase/book-node-write';
import {
  runAgentTool,
  type AgentToolContext,
  type AgentWriteApi,
} from '../tool-handlers';
import {
  DriftingReadToolRuntime,
  type TruncatedAgentToolResult,
} from './drifting-read-tool-runtime';
import { DriftingWriteToolRuntime } from './drifting-write-tool-runtime';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
} from './types';
import { P3FileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';

const PROJECT_ID = 'p4-product-project';
const OTHER_PROJECT_ID = 'p4-other-project';
const SESSION_ID = 'p4-product-session';
const OTHER_SESSION_ID = 'p4-other-session';
const CONVERSATION_ID = 'p4-product-conversation';
const OTHER_CONVERSATION_ID = 'p4-other-conversation';
const INITIAL_REVISION = '2026-07-30T00:00:00.000Z';
const initialDataState = useDataStore.getState();

describe('Drifting product freshness path', () => {
  let fixture: ProductFreshnessFixture;

  beforeEach(async () => {
    fixture = await ProductFreshnessFixture.create();
  });

  afterEach(async () => {
    useDataStore.setState(initialDataState, true);
    await fixture.close();
  });

  it('persists exact read/page receipts and gates both certified node writes with renderer CAS', async () => {
    const read = fixture.readRequest('read-1', 'read_node', {
      node: 'Chapter One',
      prose: false,
    });
    fixture.seedToolCall(read);
    const firstRead = readEnvelope(await fixture.readRuntime.execute(read));
    const firstToken = expectedRevision(firstRead);

    expect(firstRead.result).toContain('Chapter One');
    expect(firstRead.freshness.observations).toEqual([
      {
        id: firstToken.observationId,
        entityKind: 'node',
        entityId: 'node-1',
        revision: INITIAL_REVISION,
      },
    ]);
    const durableRead = await fixture.freshness.getReadReceipt(
      firstToken.receiptId,
    );
    expect(durableRead?.result).toEqual(firstRead);

    // Same delivery is a pure receipt replay: the dispatcher is not called.
    expect(readEnvelope(await fixture.readRuntime.execute(read))).toEqual(
      firstRead,
    );
    expect(fixture.readDispatches.get('read_node')).toBe(1);

    const rename = fixture.writeRequest('write-rename', 'rename_node', {
      node: 'Chapter One',
      title: 'Opening',
      expectedRevision: firstToken,
    });
    fixture.seedToolCall(rename);
    const renameResult = await fixture.writeRuntime.execute(rename);
    expect(renameResult).toMatchObject({
      ok: true,
      data: { review: { status: 'pending' } },
    });
    expect(fixture.node('node-1').title).toBe('Opening');
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);

    // A committed effect validates its durable expectation, not the now-new
    // node revision, then returns the canonical result without mutation.
    expect(await fixture.writeRuntime.execute(rename)).toEqual(renameResult);
    expect(fixture.writeUsecaseCalls).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);

    const summaryRead = fixture.readRequest('read-2', 'read_node', {
      node: 'Opening',
      prose: false,
    });
    fixture.seedToolCall(summaryRead);
    const summaryToken = expectedRevision(
      readEnvelope(await fixture.readRuntime.execute(summaryRead)),
    );
    const summary = fixture.writeRequest(
      'write-summary',
      'set_node_summary',
      {
        node: 'Opening',
        summary: 'A guarded summary.',
        expectedRevision: summaryToken,
      },
    );
    fixture.seedToolCall(summary);
    expect(await fixture.writeRuntime.execute(summary)).toMatchObject({
      ok: true,
      data: { review: { status: 'pending' } },
    });
    expect(fixture.node('node-1').summary).toBe('A guarded summary.');
    expect(fixture.writeUsecaseCalls).toBe(2);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(2);

    // read_tool_result is itself a canonical read lifecycle with an empty
    // observation set. Its exact persisted bytes equal the provider result.
    const oversized = fixture.readRequest('large-read', 'get_project_brief', {});
    fixture.seedToolCall(oversized);
    const oversizedEnvelope = readEnvelope(
      await fixture.readRuntime.execute(oversized),
    );
    const truncated = oversizedEnvelope.result as TruncatedAgentToolResult;
    expect(truncated.truncated).toBe(true);
    const page = fixture.readRequest('page-read', 'read_tool_result', {
      resultRef: truncated.resultRef,
      offset: 10,
      limit: 19,
    });
    fixture.seedToolCall(page);
    const pageEnvelope = readEnvelope(
      await fixture.readRuntime.execute(page),
    );
    expect(pageEnvelope.freshness.observations).toEqual([]);
    expect(pageEnvelope.result).toMatchObject({
      resultRef: truncated.resultRef,
      offset: 10,
    });
    const pageReceipt = await fixture.freshness.getReadReceipt(
      pageEnvelope.freshness.receiptId,
    );
    expect(pageReceipt?.result).toEqual(pageEnvelope);
    expect(
      new TextDecoder().decode(pageReceipt?.resultBlob),
    ).toBe(canonicalAgentRuntimeJson(pageEnvelope));

    expect(
      fixture.scalar('SELECT count(*) FROM agent_runtime_read_receipt'),
    ).toBe(4);
    expect(
      fixture.scalar('SELECT count(*) FROM agent_runtime_write_expectation'),
    ).toBe(2);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'result_committed'",
      ),
    ).toBe(2);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_write_review WHERE status = 'pending'",
      ),
    ).toBe(2);
  });

  it('fails closed for stale, cross-project, wrong-entity, missing, and drifted expectations', async () => {
    const staleRead = fixture.readRequest('stale-read', 'read_node', {
      node: 'Chapter One',
      prose: false,
    });
    fixture.seedToolCall(staleRead);
    const staleToken = expectedRevision(
      readEnvelope(await fixture.readRuntime.execute(staleRead)),
    );
    await fixture.manualNodeUpdate('node-1', {
      title: 'Manual title',
      updatedAt: '2026-07-30T00:00:01.000Z',
    });
    const staleWrite = fixture.writeRequest('stale-write', 'rename_node', {
      node: 'Manual title',
      title: 'Must not land',
      expectedRevision: staleToken,
    });
    fixture.seedToolCall(staleWrite);
    const staleResult = await fixture.writeRuntime.execute(staleWrite);
    expect(staleResult).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed after read_node'),
    });
    expect(await fixture.writeRuntime.execute(staleWrite)).toEqual(
      staleResult,
    );

    const wrongRead = fixture.readRequest('wrong-read', 'read_node', {
      node: 'Manual title',
      prose: false,
    });
    fixture.seedToolCall(wrongRead);
    const wrongToken = expectedRevision(
      readEnvelope(await fixture.readRuntime.execute(wrongRead)),
    );
    const wrongEntity = fixture.writeRequest(
      'wrong-entity-write',
      'rename_node',
      {
        node: 'Chapter Two',
        title: 'Must not land either',
        expectedRevision: wrongToken,
      },
    );
    fixture.seedToolCall(wrongEntity);
    expect(await fixture.writeRuntime.execute(wrongEntity)).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        'does not match the requested node observation',
      ),
    });

    const crossToken = await fixture.seedForeignReadReceipt();
    const crossProject = fixture.writeRequest(
      'cross-project-write',
      'set_node_summary',
      {
        node: 'Manual title',
        summary: 'foreign',
        expectedRevision: crossToken,
      },
    );
    fixture.seedToolCall(crossProject);
    expect(await fixture.writeRuntime.execute(crossProject)).toMatchObject({
      ok: false,
      error: expect.stringContaining('this project and session'),
    });

    const missing = fixture.writeRequest('missing-freshness', 'rename_node', {
      node: 'Manual title',
      title: 'No token',
    });
    fixture.seedToolCall(missing);
    expect(await fixture.writeRuntime.execute(missing)).toMatchObject({
      ok: false,
      error: expect.stringContaining('require expectedRevision'),
    });

    expect(fixture.writeUsecaseCalls).toBe(0);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(0);

    // First complete a valid write, then reuse the same idempotency key with a
    // different expectation. The immutable claim rejects parameter drift and
    // the already-committed mutation remains single-copy.
    const valid = fixture.writeRequest('stable-key', 'rename_node', {
      node: 'Manual title',
      title: 'Canonical title',
      expectedRevision: wrongToken,
    });
    fixture.seedToolCall(valid);
    expect(await fixture.writeRuntime.execute(valid)).toMatchObject({ ok: true });
    const changedExpectation = {
      ...valid,
      arguments: {
        ...valid.arguments,
        expectedRevision: {
          ...wrongToken,
          revision: '2026-07-30T00:00:09.000Z',
        },
      },
    };
    expect(
      await fixture.writeRuntime.execute(changedExpectation),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('different parameters'),
    });
    expect(fixture.writeUsecaseCalls).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);
  });

  it('closes the validation-to-mutation race with one SQL CAS and rolls back the outbox', async () => {
    const read = fixture.readRequest('race-read', 'read_node', {
      node: 'Chapter One',
      prose: false,
    });
    fixture.seedToolCall(read);
    const token = expectedRevision(
      readEnvelope(await fixture.readRuntime.execute(read)),
    );
    fixture.armCasRace();
    const write = fixture.writeRequest('race-write', 'rename_node', {
      node: 'Chapter One',
      title: 'Agent must lose',
      expectedRevision: token,
    });
    fixture.seedToolCall(write);

    const staleCas = await fixture.writeRuntime.execute(write);
    expect(staleCas).toMatchObject({
      ok: false,
      error: expect.stringContaining('changed after Agent observation'),
    });
    expect(fixture.writeUsecaseCalls).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(0);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM book_node WHERE id = 'node-1' AND title = 'Concurrent manual title'",
      ),
    ).toBe(1);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'failed' AND error_code = 'STALE_REVISION'",
      ),
    ).toBe(1);
    expect(await fixture.writeRuntime.execute(write)).toEqual(staleCas);
    expect(fixture.writeUsecaseCalls).toBe(1);

    await expect(fixture.persistMissingNodeWithoutGuard()).rejects.toThrow(
      'no longer exists',
    );
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(0);
  });

  it('uses the forward postimage revision as the exact-inverse SQL CAS guard', async () => {
    const read = fixture.readRequest('inverse-read', 'read_node', {
      node: 'Chapter One',
      prose: false,
    });
    fixture.seedToolCall(read);
    const token = expectedRevision(
      readEnvelope(await fixture.readRuntime.execute(read)),
    );
    const write = fixture.writeRequest('inverse-write', 'rename_node', {
      node: 'Chapter One',
      title: 'Agent title',
      expectedRevision: token,
    });
    fixture.seedToolCall(write);
    const written = await fixture.writeRuntime.execute(write);
    if (!written.ok) throw new Error(written.error);
    const reviewId = (
      written.data as { review?: { id?: unknown } }
    ).review?.id;
    if (typeof reviewId !== 'string') {
      throw new Error('Certified write did not create its review');
    }

    fixture.armCasRace();
    const rejected = await fixture.writeRuntime.rejectReview(reviewId);

    expect(rejected.review).toMatchObject({
      status: 'revert_failed',
      errorMessage: expect.stringContaining('changed after Agent observation'),
    });
    expect(fixture.writeUsecaseCalls).toBe(2);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM book_node WHERE id = 'node-1' AND title = 'Concurrent manual title'",
      ),
    ).toBe(1);
  });
});

class ProductFreshnessFixture {
  readonly client: DbExecutor;
  readonly freshness;
  readonly readRuntime: DriftingReadToolRuntime;
  readonly writeRuntime: DriftingWriteToolRuntime;
  readonly readDispatches = new Map<string, number>();
  writeUsecaseCalls = 0;
  private casRaceArmed = false;
  private tick = 0;

  private constructor(
    readonly directory: string,
    readonly gateway: P3FileBackedSqliteGateway,
  ) {
    this.client = createDatabaseClient(gateway);
    this.freshness = createAgentRuntimeFreshnessRepository(this.client);
    const context: AgentToolContext = {
      projectId: PROJECT_ID,
      write: this.createWriteApi(),
    };
    this.readRuntime = new DriftingReadToolRuntime({
      freshness: this.freshness,
      getContext: () => context,
      now: () => this.now(),
      dispatch: async (name) => {
        this.readDispatches.set(
          name,
          (this.readDispatches.get(name) ?? 0) + 1,
        );
        if (name === 'get_project_brief') return 'x'.repeat(13_000);
        if (name === 'read_node') {
          const node = this.node('node-1');
          return `${node.kind} "${node.title}"\nsummary: ${node.summary}`;
        }
        throw new Error(`Unexpected acceptance read ${name}`);
      },
    });
    this.writeRuntime = new DriftingWriteToolRuntime({
      repository: createAgentRuntimeWriteEffectRepository(this.client),
      freshness: this.freshness,
      readRuntime: this.readRuntime,
      getContext: () => context,
      now: () => this.now(),
      dispatch: runAgentTool,
    });
  }

  static async create(): Promise<ProductFreshnessFixture> {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-p4-product-freshness-'),
    );
    const gateway = new P3FileBackedSqliteGateway(
      path.join(directory, 'runtime.sqlite'),
    );
    gateway.database.exec(`
      CREATE TABLE book_node (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        summary TEXT DEFAULT '' NOT NULL,
        book_order INTEGER,
        narrative_order INTEGER,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        word_count INTEGER DEFAULT 0 NOT NULL,
        writing_status TEXT DEFAULT 'draft' NOT NULL,
        kind TEXT DEFAULT 'chapter' NOT NULL,
        drift_group_id TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        position_x REAL NOT NULL,
        position_y REAL NOT NULL
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
    const fixture = new ProductFreshnessFixture(directory, gateway);
    fixture.seedBase();
    return fixture;
  }

  private seedBase(): void {
    const db = this.gateway.database;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
        db.prepare(`
          INSERT INTO project (id, name, user_id, created_at, updated_at)
          VALUES (?, ?, 'user-1', ?, ?)
        `).run(projectId, projectId, INITIAL_REVISION, INITIAL_REVISION);
      }
      db.prepare(`
        INSERT INTO agent_conversation (
          id, project_id, title, created_at, updated_at
        ) VALUES (?, ?, 'P4 product', ?, ?)
      `).run(
        CONVERSATION_ID,
        PROJECT_ID,
        INITIAL_REVISION,
        INITIAL_REVISION,
      );
      db.prepare(`
        INSERT INTO agent_conversation (
          id, project_id, title, created_at, updated_at
        ) VALUES (?, ?, 'P4 foreign', ?, ?)
      `).run(
        OTHER_CONVERSATION_ID,
        OTHER_PROJECT_ID,
        INITIAL_REVISION,
        INITIAL_REVISION,
      );
      this.insertSession(
        SESSION_ID,
        PROJECT_ID,
        CONVERSATION_ID,
      );
      this.insertSession(
        OTHER_SESSION_ID,
        OTHER_PROJECT_ID,
        OTHER_CONVERSATION_ID,
      );
      const insertNode = db.prepare(`
        INSERT INTO book_node (
          id, title, summary, book_order, narrative_order, project_id,
          word_count, writing_status, kind, drift_group_id, deleted_at,
          created_at, updated_at, position_x, position_y
        ) VALUES (?, ?, ?, ?, NULL, ?, 0, 'draft', 'chapter', NULL, NULL, ?, ?, 0, 0)
      `);
      insertNode.run(
        'node-1',
        'Chapter One',
        'Before',
        1,
        PROJECT_ID,
        INITIAL_REVISION,
        INITIAL_REVISION,
      );
      insertNode.run(
        'node-2',
        'Chapter Two',
        'Second',
        2,
        PROJECT_ID,
        INITIAL_REVISION,
        INITIAL_REVISION,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    useDataStore.setState({
      ...initialDataState,
      bookNodes: [
        makeNode('node-1', 'Chapter One', 'Before', 1),
        makeNode('node-2', 'Chapter Two', 'Second', 2),
      ],
    });
  }

  private insertSession(
    sessionId: string,
    projectId: string,
    conversationId: string,
  ): void {
    this.gateway.database.prepare(`
      INSERT INTO agent_runtime_session (
        id, project_id, route_kind, conversation_id, provider, model,
        provider_epoch, status, created_at, updated_at
      ) VALUES (?, ?, 'chat', ?, 'acceptance', 'deterministic', 0, 'running', ?, ?)
    `).run(
      sessionId,
      projectId,
      conversationId,
      INITIAL_REVISION,
      INITIAL_REVISION,
    );
  }

  seedToolCall(request: AgentToolExecutionRequest): void {
    const at = this.now();
    const turnOrdinal = ++this.tick;
    const messageId = `message:${request.turnId}`;
    this.gateway.database.prepare(`
      INSERT OR IGNORE INTO agent_runtime_turn (
        id, session_id, ordinal, status, prompt_message_id,
        accepted_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      request.turnId,
      request.sessionId,
      turnOrdinal,
      messageId,
      at,
      at,
      at,
    );
    this.gateway.database.prepare(`
      INSERT OR IGNORE INTO agent_runtime_message (
        id, session_id, turn_id, ordinal, role, status,
        content_json, created_at, completed_at
      ) VALUES (?, ?, ?, 0, 'user', 'complete', '"fixture"', ?, ?)
    `).run(messageId, request.sessionId, request.turnId, at, at);
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

  readRequest(
    callId: string,
    name: string,
    arguments_: Record<string, unknown>,
  ): AgentToolExecutionRequest {
    return {
      sessionId: SESSION_ID,
      turnId: `turn:${callId}`,
      callId,
      idempotencyKey: `${SESSION_ID}:turn:${callId}:${callId}`,
      name,
      arguments: arguments_,
      access: 'read',
      context: runtimeContext(),
      control: unavailableControl(),
      signal: new AbortController().signal,
    };
  }

  writeRequest(
    callId: string,
    name: 'rename_node' | 'set_node_summary',
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
      context: runtimeContext(),
      control: unavailableControl(),
      signal: new AbortController().signal,
    };
  }

  async seedForeignReadReceipt(): Promise<AgentRuntimeExpectedRevision> {
    const callId = 'foreign-read';
    const request: AgentToolExecutionRequest = {
      sessionId: OTHER_SESSION_ID,
      turnId: 'turn:foreign-read',
      callId,
      idempotencyKey: `${OTHER_SESSION_ID}:turn:foreign-read:${callId}`,
      name: 'read_node',
      arguments: { node: 'foreign-node', prose: false },
      access: 'read',
      context: {
        route: {
          kind: 'chat',
          projectId: OTHER_PROJECT_ID,
          conversationId: OTHER_CONVERSATION_ID,
        },
      },
      control: unavailableControl(),
      signal: new AbortController().signal,
    };
    this.seedToolCall(request);
    const receiptId = `agent-read:${request.idempotencyKey}`;
    const observationId = `agent-observation:${request.idempotencyKey}:0`;
    const revision = INITIAL_REVISION;
    const result: AgentRuntimeReadResult = {
      result: 'foreign',
      freshness: {
        receiptId,
        observations: [
          {
            id: observationId,
            entityKind: 'node',
            entityId: 'foreign-node',
            revision,
          },
        ],
      },
    };
    await this.freshness.persistReadReceipt({
      id: receiptId,
      projectId: OTHER_PROJECT_ID,
      sessionId: OTHER_SESSION_ID,
      turnId: request.turnId,
      toolCallId: runtimeToolCallId(request),
      callId,
      toolName: request.name,
      idempotencyKey: request.idempotencyKey,
      result,
      observations: [
        {
          id: observationId,
          entityKind: 'node',
          entityId: 'foreign-node',
          revision,
        },
      ],
      createdAt: this.now(),
    });
    return { receiptId, observationId, revision };
  }

  async manualNodeUpdate(
    id: string,
    updates: { title: string; updatedAt: string },
  ): Promise<void> {
    await this.client
      .update(BookNodeTable)
      .set(updates)
      .where(
        and(
          eq(BookNodeTable.id, id),
          eq(BookNodeTable.projectId, PROJECT_ID),
        ),
      );
    useDataStore.getState().updateBookNode(id, updates);
  }

  armCasRace(): void {
    this.casRaceArmed = true;
  }

  node(id: string): BookNode {
    const node = useDataStore
      .getState()
      .bookNodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Missing fixture node ${id}`);
    return node;
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

  async persistMissingNodeWithoutGuard(): Promise<void> {
    await persistBookNodeUpdateWithSync(
      {
        projectId: PROJECT_ID,
        nodeId: 'missing-node',
        updates: {
          title: 'ghost',
          updatedAt: '2026-07-30T00:00:08.000Z',
        },
        syncPayload: { title: 'ghost' },
      },
      this.atomicRunner(),
    );
  }

  private atomicRunner(): BookNodeAtomicTransactionRunner {
    return (
      projectId,
      work,
    ) =>
      this.client.transaction(async (tx) =>
        work(tx, async (
          entityType,
          mutationType,
          entityId,
          mutationProjectId,
          payload,
          parentId,
        ) => {
          if (mutationProjectId !== projectId) {
            throw new Error('cross-project fixture sync');
          }
          const at = this.now();
          await tx.insert(LocalSyncMutationTable).values({
            entityType,
            mutationType,
            entityId,
            projectId,
            parentId: parentId ?? null,
            payloadJson:
              payload === undefined ? null : JSON.stringify(payload),
            mutationTs: Date.parse(at),
            status: 'pending',
            retryCount: 0,
            lastError: null,
            createdAt: at,
            updatedAt: at,
          });
        }),
      );
  }

  private createWriteApi(): AgentWriteApi {
    const runAtomic = this.atomicRunner();
    const persist = async (
      id: string,
      updates: { title?: string; summary?: string },
      guard?: AgentRuntimeNodeWriteGuard,
    ) => {
      this.writeUsecaseCalls += 1;
      const current = this.node(id);
      const updatedAt = new Date(
        Math.max(Date.parse(this.now()), Date.parse(current.updatedAt) + 1),
      ).toISOString();
      if (this.casRaceArmed) {
        this.casRaceArmed = false;
        await this.client
          .update(BookNodeTable)
          .set({
            title: 'Concurrent manual title',
            updatedAt: '2026-07-30T00:00:05.000Z',
          })
          .where(
            and(
              eq(BookNodeTable.id, id),
              eq(BookNodeTable.projectId, PROJECT_ID),
            ),
          );
      }
      const result = await persistBookNodeUpdateWithSync(
        {
          projectId: PROJECT_ID,
          nodeId: id,
          updates: { ...updates, updatedAt },
          syncPayload: updates,
          guard,
        },
        runAtomic,
      );
      if (!result) throw new Error('Fixture node update returned no row');
      useDataStore.getState().updateBookNode(id, {
        ...updates,
        updatedAt: result.updatedAt,
      });
      return result;
    };

    const api: Pick<AgentWriteApi, 'renameNode' | 'updateNode'> = {
      renameNode: (id, title, guard) =>
        persist(id, { title }, guard),
      updateNode: (id, updates, guard) =>
        persist(id, { summary: updates.summary }, guard),
    };
    return api as AgentWriteApi;
  }

  private now(): string {
    this.tick += 1;
    return new Date(Date.parse(INITIAL_REVISION) + this.tick).toISOString();
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

function unavailableControl(): AgentToolExecutionRequest['control'] {
  return {
    requestUserInput: async () => {
      throw new Error('User input is unavailable in this integration test');
    },
  };
}

function runtimeToolCallId(request: AgentToolExecutionRequest): string {
  return `agent-tool:${request.sessionId}:${request.turnId}:${request.callId}`;
}

function readEnvelope(
  result: Awaited<ReturnType<DriftingReadToolRuntime['execute']>>,
): AgentRuntimeReadResult {
  if (!result.ok) throw new Error(result.error);
  return result.data as AgentRuntimeReadResult;
}

function expectedRevision(
  envelope: AgentRuntimeReadResult,
): AgentRuntimeExpectedRevision {
  const observation = envelope.freshness.observations[0];
  if (!observation) throw new Error('Expected one freshness observation');
  return {
    receiptId: envelope.freshness.receiptId,
    observationId: observation.id,
    revision: observation.revision,
  };
}

function makeNode(
  id: string,
  title: string,
  summary: string,
  bookOrder: number,
): BookNode {
  return {
    id,
    projectId: PROJECT_ID,
    kind: 'chapter',
    title,
    summary,
    bookOrder,
    narrativeOrder: null,
    driftGroupId: null,
    position: { x: 0, y: 0 },
    wordCount: 0,
    writingStatus: 'draft',
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  };
}
