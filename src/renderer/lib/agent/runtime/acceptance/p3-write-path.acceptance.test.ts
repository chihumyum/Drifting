import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  canonicalAgentRuntimeJson,
  createAgentRuntimePersistenceRepository,
} from '../../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  createAgentRuntimeWriteEffectRepository,
  type AgentRuntimeWriteEffectRepository,
} from '../../../../sqlite-repo/agent-runtime-write-effect-repo';
import { useDataStore } from '../../../../store/data-store';
import type {
  AgentToolContext,
  AgentWriteApi,
} from '../../tool-handlers';
import { DriftingWriteToolRuntime } from '../drifting-write-tool-runtime';
import { ReaderWriterAgentRuntimeScheduler } from '../scheduler';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from '../types';
import {
  hashYjsProseState,
  prepareYjsProseCommand,
  replaceYjsProseBlocks,
} from '../yjs-prose-command';
import { P3FileBackedSqliteGateway } from './p3-file-backed-sqlite';

const initialDataState = useDataStore.getState();
const PROJECT_ID = 'p3-project';
const CONVERSATION_ID = 'p3-conversation';
const SESSION_ID = 'p3-session';
const BASE_TIME_MS = Date.parse('2026-07-30T00:00:00.000Z');

type FaultPoint =
  | 'after_yjs_before_projection'
  | 'after_projection_before_outbox'
  | 'after_outbox_before_result';

interface SeededWrite {
  request: AgentToolExecutionRequest;
  nodeId: string;
  field: 'title' | 'summary';
  value: string;
}

describe('P3 file-backed write path acceptance', () => {
  const fixtures = new Set<P3WriteFixture>();

  beforeEach(() => {
    useDataStore.setState(initialDataState, true);
  });

  afterEach(async () => {
    useDataStore.setState(initialDataState, true);
    await Promise.all([...fixtures].map((fixture) => fixture.close()));
    fixtures.clear();
  });

  async function fixture(nodeCount = 1): Promise<P3WriteFixture> {
    const created = await P3WriteFixture.create(nodeCount);
    fixtures.add(created);
    return created;
  }

  it('runs scheduler -> authorized runtime -> usecase -> outbox, then persists a checkpoint', async () => {
    const subject = await fixture();
    const rename = subject.writeRequest(
      0,
      0,
      'rename_node',
      { node: 'node-0', title: 'Opening' },
    );
    const summary = subject.writeRequest(
      0,
      1,
      'set_node_summary',
      { node: 'node-0', summary: 'Agent summary' },
    );
    await subject.seedCanonicalCalls([rename, summary]);

    const first = await subject.execute(rename);
    const duplicate = await subject.execute(rename);
    const second = await subject.execute(summary);
    if (!first.ok) throw new Error(first.error);
    if (!duplicate.ok) throw new Error(duplicate.error);
    if (!second.ok) throw new Error(second.error);

    expect(first).toMatchObject({
      ok: true,
      data: {
        writeRef: `agent-write:${rename.idempotencyKey}`,
        authorization: { kind: 'automatic' },
      },
    });
    expect(duplicate).toEqual(first);
    expect(second).toMatchObject({
      ok: true,
      data: {
        writeRef: `agent-write:${summary.idempotencyKey}`,
        authorization: { kind: 'automatic' },
      },
    });
    expect(subject.usecaseDispatches).toBe(2);
    expect(subject.node('node-0')).toMatchObject({
      title: 'Opening',
      summary: 'Agent summary',
    });

    const checkpointHistory = [
      {
        role: 'user' as const,
        content: `Authorized writes: agent-write:${rename.idempotencyKey}, agent-write:${summary.idempotencyKey}`,
      },
    ];
    const checkpointContext = {
      schemaVersion: 4 as const,
      format: 'drifting.agent-runtime-checkpoint-digest-with-summaries' as const,
      canonicalMessageCount: checkpointHistory.length,
      canonicalHistoryHash: `sha256:${createHash('sha256')
        .update(JSON.stringify(checkpointHistory))
        .digest('hex')}`,
      durableSummaries: [],
    };
    await subject.runtimeRepository.createCheckpoint({
      id: 'p3-review-feedback-checkpoint',
      sessionId: SESSION_ID,
      throughTurnOrdinal: 0,
      messageCount: checkpointHistory.length,
      context: checkpointContext,
      contextHash: `sha256:${createHash('sha256')
        .update(JSON.stringify(checkpointContext))
        .digest('hex')}`,
      createdAt: iso(50_000),
    });
    const recovery =
      await subject.runtimeRepository.loadRecoverySnapshot(SESSION_ID);
    expect(recovery?.checkpoints).toHaveLength(1);
    expect(recovery?.checkpoints[0]?.context).toEqual(checkpointContext);

    expect(subject.scalar('SELECT count(*) FROM agent_runtime_write_effect')).toBe(
      2,
    );
    expect(subject.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(
      0,
    );
    expect(subject.scalar('SELECT count(*) FROM acceptance_sync_outbox')).toBe(2);
  });

  it('fails before mutation, marks every entered fault uncertain, and never blindly retries', async () => {
    const subject = await fixture();
    const missing = subject.writeRequest(
      0,
      0,
      'rename_node',
      { node: 'missing-node', title: 'Never applied' },
    );
    const afterYjs = subject.writeRequest(
      0,
      1,
      'rename_node',
      { node: 'node-0', title: 'Fault after Yjs' },
    );
    const afterProjection = subject.writeRequest(
      0,
      2,
      'rename_node',
      { node: 'node-0', title: 'Fault after projection' },
    );
    const afterOutbox = subject.writeRequest(
      0,
      3,
      'rename_node',
      { node: 'node-0', title: 'Fault after outbox' },
    );
    await subject.seedCanonicalCalls([
      missing,
      afterYjs,
      afterProjection,
      afterOutbox,
    ]);

    await expect(subject.execute(missing)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('No node'),
    });
    expect((await subject.effect(missing)).phase).toBe('failed');
    expect(subject.usecaseDispatches).toBe(0);

    const faults: Array<{
      point: FaultPoint;
      request: AgentToolExecutionRequest;
      durableProjection: boolean;
    }> = [
      {
        point: 'after_yjs_before_projection',
        request: afterYjs,
        durableProjection: false,
      },
      {
        point: 'after_projection_before_outbox',
        request: afterProjection,
        durableProjection: false,
      },
      {
        point: 'after_outbox_before_result',
        request: afterOutbox,
        durableProjection: true,
      },
    ];

    for (const fault of faults) {
      const dispatchesBefore = subject.usecaseDispatches;
      subject.armFault(fault.point);
      await expect(subject.execute(fault.request)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(fault.point),
      });
      expect((await subject.effect(fault.request)).phase).toBe('uncertain');
      const outboxAfterFirst = subject.scalar(
        'SELECT count(*) FROM acceptance_sync_outbox',
      );
      await expect(subject.execute(fault.request)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('inspect its durable effect'),
      });
      expect(subject.usecaseDispatches).toBe(dispatchesBefore + 1);
      expect(
        subject.scalar('SELECT count(*) FROM acceptance_sync_outbox'),
      ).toBe(outboxAfterFirst);
      if (!fault.durableProjection) {
        expect(
          subject.scalar(
            'SELECT count(*) FROM acceptance_node_projection WHERE title = ?',
            [String(fault.request.arguments.title)],
          ),
        ).toBe(0);
      }
    }

    expect(subject.yjsFaultWrites).toBe(3);
    expect(
      subject.scalar(
        "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'uncertain'",
      ),
    ).toBe(3);
    expect(subject.scalar('SELECT count(*) FROM acceptance_sync_outbox')).toBe(1);
  });

  it('rejects a stale Yjs revision/vector before touching the live document', async () => {
    const subject = await fixture();
    const doc = subject.proseDoc;
    const beforeHash = await hashYjsProseState(doc);
    const beforeUpdate = [...Y.encodeStateAsUpdate(doc)];
    let observedUpdates = 0;
    doc.on('update', () => {
      observedUpdates += 1;
    });

    await expect(
      prepareYjsProseCommand({
        commandId: 'p3-stale-zero-mutation',
        source: { kind: 'live', doc, revision: 9 },
        expectedBase: {
          revision: 8,
          stateVector: Y.encodeStateVector(doc),
        },
        operation: {
          kind: 'append',
          blocks: [
            {
              id: 'stale-block',
              type: 'paragraph',
              content: [{ kind: 'text', text: 'must not appear' }],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });

    expect(observedUpdates).toBe(0);
    expect([...Y.encodeStateAsUpdate(doc)]).toEqual(beforeUpdate);
    expect(await hashYjsProseState(doc)).toBe(beforeHash);
    expect(
      subject.scalar(
        "SELECT count(*) FROM yjs_updates WHERE document_id = 'node:node-0'",
      ),
    ).toBe(0);
    expect(subject.scalar('SELECT count(*) FROM acceptance_sync_outbox')).toBe(0);
  });

  it('persists hard authorization and never creates a post-write inverse review', async () => {
    const subject = await fixture();
    const rename = subject.writeRequest(
      0,
      0,
      'rename_node',
      { node: 'node-0', title: 'Temporary title' },
    );
    await subject.seedCanonicalCalls([rename]);
    const result = await subject.execute(rename);
    if (!result.ok) throw new Error(result.error);
    expect(await subject.effect(rename)).toMatchObject({
      phase: 'result_committed',
      authorization: {
        kind: 'automatic',
        requestId: null,
        argumentsHash: rename.authorization?.argumentsHash,
      },
    });
    expect(await subject.execute(rename)).toEqual(result);
    expect(subject.usecaseDispatches).toBe(1);
    expect(subject.node('node-0').title).toBe('Temporary title');
    expect(subject.scalar('SELECT count(*) FROM acceptance_sync_outbox')).toBe(1);
    expect(subject.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);
  });

  it(
    'serializes 100 seeds x 50 mixed operations without duplicate effects or cross-project writes',
    async () => {
      const subject = await fixture(100);
      const writes: SeededWrite[] = [];
      for (let seed = 0; seed < 100; seed += 1) {
        for (let ordinal = 0; ordinal < 10; ordinal += 1) {
          const field = ordinal % 2 === 0 ? 'title' : 'summary';
          const value = `${field}-${seed}-${ordinal}`;
          const request = subject.writeRequest(
            seed,
            ordinal,
            field === 'title' ? 'rename_node' : 'set_node_summary',
            field === 'title'
              ? { node: `node-${seed}`, title: value }
              : { node: `node-${seed}`, summary: value },
          );
          writes.push({
            request,
            nodeId: `node-${seed}`,
            field,
            value,
          });
        }
      }
      await subject.seedCanonicalCalls(writes.map((write) => write.request));

      let activeReads = 0;
      let maxActiveReads = 0;
      const operations: Array<Promise<unknown>> = [];
      for (let seed = 0; seed < 100; seed += 1) {
        const seedWrites = writes.filter(
          (write) => write.nodeId === `node-${seed}`,
        );
        const batch: Array<() => Promise<unknown>> = [];
        for (const write of seedWrites) {
          // Duplicate delivery is deliberately concurrent. Only one handler
          // may cross the durable idempotency boundary.
          batch.push(
            () => subject.execute(write.request),
            () => subject.execute(write.request),
          );
        }
        for (let read = 0; read < 30; read += 1) {
          const request = subject.readLeaseRequest(seed, read);
          batch.push(() =>
            subject.scheduler.runRead(request, async () => {
              activeReads += 1;
              maxActiveReads = Math.max(maxActiveReads, activeReads);
              await Promise.resolve();
              const snapshot = {
                yjsState: Y.encodeStateVector(subject.proseDoc).byteLength,
                nodeTitle: subject.node(`node-${seed}`).title,
              };
              activeReads -= 1;
              return snapshot;
            }),
          );
        }
        for (const operation of shuffle(batch, seed + 1)) {
          operations.push(operation());
        }
      }

      const results = await Promise.all(operations);
      const writeResults = results.filter(
        (value): value is { ok: boolean } =>
          value !== null &&
          typeof value === 'object' &&
          'ok' in value,
      );
      expect(writeResults).toHaveLength(2_000);
      const failedWrite = writeResults.find((result) => !result.ok);
      if (failedWrite && 'error' in failedWrite) {
        throw new Error(String(failedWrite.error));
      }
      expect(maxActiveReads).toBeGreaterThan(1);
      expect(subject.usecaseDispatches).toBe(1_000);
      expect(
        subject.scalar('SELECT count(*) FROM agent_runtime_write_effect'),
      ).toBe(1_000);
      expect(
        subject.scalar('SELECT count(*) FROM agent_runtime_write_review'),
      ).toBe(0);
      expect(subject.scalar('SELECT count(*) FROM acceptance_sync_outbox')).toBe(
        1_000,
      );
      expect(
        subject.scalar(
          `SELECT count(*) FROM (
             SELECT project_id, entity_id, field, value, count(*) AS copies
             FROM acceptance_sync_outbox
             GROUP BY project_id, entity_id, field, value
             HAVING copies <> 1 OR project_id <> ?
           )`,
          [PROJECT_ID],
        ),
      ).toBe(0);
      expect(
        subject.scalar(
          "SELECT count(*) FROM agent_runtime_write_effect WHERE phase <> 'result_committed'",
        ),
      ).toBe(0);
    },
    60_000,
  );
});

class P3WriteFixture {
  readonly writeRepository: AgentRuntimeWriteEffectRepository;
  readonly runtimeRepository: ReturnType<
    typeof createAgentRuntimePersistenceRepository
  >;
  readonly runtime: DriftingWriteToolRuntime;
  readonly scheduler = new ReaderWriterAgentRuntimeScheduler();
  readonly proseDoc = new Y.Doc({ gc: false });
  usecaseDispatches = 0;
  yjsFaultWrites = 0;
  private fault: FaultPoint | null = null;
  private timestampTick = 0;
  private closed = false;

  private constructor(
    readonly directory: string,
    readonly gateway: P3FileBackedSqliteGateway,
    private readonly context: AgentToolContext,
  ) {
    const client = gateway.client();
    this.writeRepository = createAgentRuntimeWriteEffectRepository(client);
    this.runtimeRepository = createAgentRuntimePersistenceRepository(client);
    this.runtime = new DriftingWriteToolRuntime({
      repository: this.writeRepository,
      freshness: null,
      getContext: () => this.context,
      readRuntime: emptyReadRuntime,
      now: () => iso(this.timestampTick++),
    });
  }

  static async create(nodeCount: number): Promise<P3WriteFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-p3-runtime-'));
    const gateway = new P3FileBackedSqliteGateway(
      path.join(directory, 'runtime.sqlite'),
    );
    const nodes = Array.from({ length: nodeCount }, (_, index) =>
      makeNode(index),
    );
    useDataStore.setState({
      ...initialDataState,
      bookNodes: nodes,
    });

    const fixtureRef: { current: P3WriteFixture | null } = {
      current: null,
    };
    const write = {
      renameNode: async (id: string, title: string) => {
        const current = fixtureRef.current;
        if (!current) throw new Error('P3 acceptance fixture is not ready');
        await current.applyNodeField(id, 'title', title);
      },
      updateNode: async (
        id: string,
        updates: { summary?: string },
      ) => {
        if (typeof updates.summary === 'string') {
          const current = fixtureRef.current;
          if (!current) throw new Error('P3 acceptance fixture is not ready');
          await current.applyNodeField(id, 'summary', updates.summary);
        }
      },
    } as unknown as AgentWriteApi;
    const context: AgentToolContext = {
      projectId: PROJECT_ID,
      write,
    };
    const fixture = new P3WriteFixture(directory, gateway, context);
    fixtureRef.current = fixture;
    fixture.seedBase(nodes);
    replaceYjsProseBlocks(fixture.proseDoc, [
      {
        id: 'opening',
        type: 'paragraph',
        content: [{ kind: 'text', text: 'Opening prose.' }],
      },
    ]);
    return fixture;
  }

  armFault(point: FaultPoint): void {
    this.fault = point;
  }

  writeRequest(
    seed: number,
    ordinal: number,
    name: 'rename_node' | 'set_node_summary',
    arguments_: Record<string, unknown>,
  ): AgentToolExecutionRequest {
    const callId = `call-${seed}-${ordinal}`;
    return {
      sessionId: SESSION_ID,
      turnId: `turn-${seed}`,
      callId,
      idempotencyKey: `${SESSION_ID}:turn-${seed}:${callId}`,
      name,
      arguments: arguments_,
      access: 'write',
      authorization: automaticAuthorization(arguments_),
      context: runtimeContext,
      signal: new AbortController().signal,
    };
  }

  readLeaseRequest(seed: number, ordinal: number): AgentToolExecutionRequest {
    return {
      sessionId: SESSION_ID,
      turnId: `turn-${seed}`,
      callId: `read-${seed}-${ordinal}`,
      idempotencyKey: `${SESSION_ID}:turn-${seed}:read-${ordinal}`,
      name: 'acceptance_read',
      arguments: {},
      access: 'read',
      context: runtimeContext,
      signal: new AbortController().signal,
    };
  }

  async execute(request: AgentToolExecutionRequest) {
    return this.scheduler.runWrite(request, () => this.runtime.execute(request));
  }

  async seedCanonicalCalls(
    requests: readonly AgentToolExecutionRequest[],
  ): Promise<void> {
    const db = this.gateway.database;
    const byTurn = new Map<string, AgentToolExecutionRequest[]>();
    for (const request of requests) {
      const group = byTurn.get(request.turnId) ?? [];
      group.push(request);
      byTurn.set(request.turnId, group);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const insertTurn = db.prepare(`
        INSERT OR IGNORE INTO agent_runtime_turn (
          id, session_id, ordinal, status, prompt_message_id,
          accepted_at, started_at, updated_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `);
      const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO agent_runtime_message (
          id, session_id, turn_id, ordinal, role, status,
          content_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, 'user', 'complete', ?, ?, ?)
      `);
      const insertTool = db.prepare(`
        INSERT OR IGNORE INTO agent_runtime_tool_call (
          id, session_id, turn_id, call_id, name, access, status,
          idempotency_key, arguments_json, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, 'write', 'running', ?, ?, ?, ?)
      `);
      let turnOrdinal = 0;
      for (const [turnId, turnRequests] of byTurn) {
        const numericSeed = Number(turnId.slice('turn-'.length));
        const messageId = `message-${turnId}`;
        const at = iso(1_000 + numericSeed);
        insertTurn.run(
          turnId,
          SESSION_ID,
          numericSeed,
          messageId,
          at,
          at,
          at,
        );
        insertMessage.run(
          messageId,
          SESSION_ID,
          turnId,
          turnOrdinal++,
          JSON.stringify(`seed ${numericSeed}`),
          at,
          at,
        );
        for (const request of turnRequests) {
          insertTool.run(
            runtimeToolCallId(request),
            SESSION_ID,
            turnId,
            request.callId,
            request.name,
            request.idempotencyKey,
            JSON.stringify(request.arguments),
            at,
            at,
          );
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  node(id: string) {
    const found = useDataStore
      .getState()
      .bookNodes.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Acceptance node ${id} was not found`);
    return found;
  }

  scalar(sql: string, parameters: readonly SQLInputValue[] = []): number {
    const statement = this.gateway.database.prepare(sql);
    const row = statement.get(...parameters) as Record<string, unknown>;
    return Number(Object.values(row)[0] ?? 0);
  }

  async effect(request: AgentToolExecutionRequest) {
    const effect = await this.writeRepository.getEffect(
      `agent-write:${request.idempotencyKey}`,
    );
    if (!effect) throw new Error(`Effect for ${request.callId} was not found`);
    return effect;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.proseDoc.destroy();
    await this.gateway.close();
    await rm(this.directory, { recursive: true, force: true });
  }

  private seedBase(nodes: ReturnType<typeof makeNode>[]): void {
    const db = this.gateway.database;
    const at = iso(0);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO project (id, name, user_id, created_at, updated_at)
        VALUES (?, 'P3 acceptance', 'acceptance-user', ?, ?)
      `).run(PROJECT_ID, at, at);
      db.prepare(`
        INSERT INTO agent_conversation (
          id, project_id, title, created_at, updated_at
        ) VALUES (?, ?, 'P3 acceptance', ?, ?)
      `).run(CONVERSATION_ID, PROJECT_ID, at, at);
      db.prepare(`
        INSERT INTO agent_runtime_session (
          id, project_id, route_kind, conversation_id, provider, model,
          provider_epoch, status, created_at, updated_at
        ) VALUES (?, ?, 'chat', ?, 'acceptance', 'deterministic', 0, 'running', ?, ?)
      `).run(SESSION_ID, PROJECT_ID, CONVERSATION_ID, at, at);
      const insertNode = db.prepare(`
        INSERT INTO acceptance_node_projection (
          id, project_id, title, summary, revision, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?)
      `);
      for (const node of nodes) {
        insertNode.run(
          node.id,
          PROJECT_ID,
          node.title,
          node.summary,
          node.updatedAt,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private async applyNodeField(
    nodeId: string,
    field: 'title' | 'summary',
    value: string,
  ): Promise<void> {
    this.usecaseDispatches += 1;
    const fault = this.fault;
    this.fault = null;
    if (fault) {
      this.proseDoc.transact(() => {
        this.proseDoc
          .getMap<string>('p3-fault-markers')
          .set(`${nodeId}:${field}:${this.yjsFaultWrites}`, value);
      }, `p3:${fault}`);
      this.yjsFaultWrites += 1;
      if (fault === 'after_yjs_before_projection') {
        throw new Error(fault);
      }
    }

    const updatedAt = iso(100_000 + this.timestampTick++);
    const db = this.gateway.database;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE acceptance_node_projection
        SET ${field} = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(value, updatedAt, nodeId, PROJECT_ID);
      if (fault === 'after_projection_before_outbox') {
        throw new Error(fault);
      }
      db.prepare(`
        INSERT INTO acceptance_sync_outbox (
          project_id, entity_id, field, value, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(PROJECT_ID, nodeId, field, value, updatedAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    updateStoreNode(nodeId, field, value, updatedAt);
    if (fault === 'after_outbox_before_result') {
      throw new Error(fault);
    }
  }
}

const runtimeContext: AgentRuntimeContext = {
  route: {
    kind: 'chat',
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
  },
};

const emptyReadRuntime: AgentToolRuntime = {
  listDefinitions: () => [],
  execute: async () => ({
    ok: false,
    error: 'Acceptance reads are scheduled directly',
  }),
};

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

function iso(offsetMs: number): string {
  return new Date(BASE_TIME_MS + offsetMs).toISOString();
}

function makeNode(index: number) {
  return {
    id: `node-${index}`,
    projectId: PROJECT_ID,
    kind: 'chapter' as const,
    title: `Chapter ${index}`,
    summary: `Summary ${index}`,
    narrativeOrder: null,
    driftGroupId: null,
    position: { x: 0, y: index },
    wordCount: 0,
    bookOrder: index,
    writingStatus: 'draft' as const,
    createdAt: iso(index),
    updatedAt: iso(index),
  };
}

function updateStoreNode(
  id: string,
  field: 'title' | 'summary',
  value: string,
  updatedAt: string,
): void {
  useDataStore.setState((state) => ({
    bookNodes: state.bookNodes.map((node) =>
      node.id === id
        ? {
            ...node,
            [field]: value,
            updatedAt,
          }
        : node,
    ),
  }));
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}
