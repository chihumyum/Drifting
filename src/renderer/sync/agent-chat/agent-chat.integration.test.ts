import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import {
  ProjectTable,
  SyncGenerationTable,
  AgentConversationTable,
  AgentChatBranchTable,
  AgentChatQueueTable,
  AgentChatObjectTable,
  AgentChatBindingTable,
  AgentChatCursorTable,
  AgentChatDeliveryTable,
  AgentRuntimeToolCallTable,
  AgentPermissionGrantTable,
} from '../../schema/drizzle';
import { AgentConversationSyncRepository } from './repository';
import { AgentChatSyncRuntime } from './runtime';
import { MemoryObjectLogProvider } from '../providers/memory-provider';
import { MemoryProviderLocalObjectStore } from '../providers/local-object-store';
import type { NativeSyncObjectCodec } from '../native-object-codec';
import { sha256Bytes } from '../protocol';
import { createAgentRuntimePersistenceRepository } from '../../sqlite-repo/agent-runtime-persistence-repo';
import { createRepositoryAgentTransportPersistence } from '../../lib/agent/runtime/repository-transport-persistence';
import type {
  AgentModelMessage,
  AgentRuntimeEvent,
  AgentRuntimeJournalEntry,
} from '../../lib/agent/runtime/types';
import {
  canonicalJson,
  chunkText,
  decodeChatWire,
  encodeChatWire,
  type ChatTurnPayload,
} from './protocol';
import { seedAgentChatSession } from './seed';
import { captureSnapshotV1 } from '../checkpoint';
import { createAgentRuntimeResultArtifactRepository } from '../../sqlite-repo/agent-runtime-result-artifact-repo';
import { loadCanonicalAgentTranscript } from '../../lib/agent/runtime/recovered-transcript';
import { agentModelMessagesToContextSources } from '../../lib/agent/runtime/context-message-adapter';
import { hashAgentContextSourceRows } from '../../lib/agent/runtime/context-planner';
import { recoverAgentRuntimeSnapshot } from '../../lib/agent/runtime/recovery';

const CLOCK = '0000000000000001:00000000-0000-0000-0000-000000000001';
const NOW = '2026-09-05T00:00:00.000Z';
const dirs: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];
async function client() {
  const dir = await mkdtemp(path.join(tmpdir(), 'drifting-chat-sync-'));
  dirs.push(dir);
  const gateway = new ProductFileBackedSqliteGateway(path.join(dir, 'test.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: 'p',
    name: 'Synthetic project',
    userId: 'local',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(SyncGenerationTable).values({
    syncGenerationId: 'g',
    projectSyncId: 'ps',
    projectId: 'p',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { db, repo: new AgentConversationSyncRepository(db), gateway };
}
function network() {
  const objects = new MemoryProviderLocalObjectStore();
  const provider = new MemoryObjectLogProvider(objects, { pageSize: 2 });
  let counter = 0;
  const codec: NativeSyncObjectCodec = {
    async stageProtocolBytes(bytes) {
      return {
        sourceRef: objects.put(`stage-${++counter}`, bytes),
        sizeBytes: bytes.byteLength,
        storedSha256: await sha256Bytes(bytes),
      };
    },
    async readProtocolBytes(ref) {
      return objects.read(ref, new AbortController().signal);
    },
    async stageAssetSource() {
      throw new Error('not used');
    },
  };
  const runtime = (db: DbClient) =>
    new AgentChatSyncRuntime({
      db,
      projectId: 'p',
      binding: {
        bindingId: 'b',
        syncGenerationId: 'g',
        accountRef: 'account',
        secretRef: 'secret-ref',
        authorityGeneration: 1,
      },
      provider,
      codec,
      verifyAuthority: false,
    });
  const nativeUpload = provider.uploadImmutable.bind(provider);
  vi.spyOn(provider, 'uploadImmutable').mockImplementation((input) => {
    expect(input.logicalKeyId).toMatch(/^sha256:[0-9a-f]{64}$/);
    return nativeUpload(input);
  });
  return { provider, codec, runtime };
}
const cycle = (runtime: AgentChatSyncRuntime) =>
  runtime.runCycle(new Set(['manual']), new AbortController().signal);
let nextTurn = 0;
async function complete(
  db: DbClient,
  id: string,
  prompt = 'Please read the chapter',
  reply = 'I read the chapter',
  outcome: 'completed' | 'failed' | 'aborted' = 'completed',
) {
  const repo = createAgentRuntimePersistenceRepository(db);
  const persistence = createRepositoryAgentTransportPersistence({
    repository: repo,
    resolveToolAccess: () => 'read',
  });
  const [existing] = await db
    .select()
    .from(AgentConversationTable)
    .where(eq(AgentConversationTable.id, id));
  if (!existing)
    await db
      .insert(AgentConversationTable)
      .values({ id, projectId: 'p', title: 'Chapter discussion', createdAt: NOW, updatedAt: NOW });
  const turnId = `turn-${++nextTurn}`;
  const route = { kind: 'chat' as const, projectId: 'p', conversationId: id };
  const prepared = await persistence.prepareTurn({
    candidateSessionId: `session-${turnId}`,
    newConversation: !existing,
    route,
    provider: 'test',
    model: null,
    turnId,
    prompt,
    acceptedAt: NOW,
  });
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  const events: AgentRuntimeEvent[] = [
    { type: 'turn_started', prompt },
    { type: 'model_iteration_started', iteration: 1, driverId: 'test' },
    { type: 'text_delta', iteration: 1, text: reply },
    { type: 'model_usage', iteration: 1, usage },
    { type: 'model_iteration_completed', iteration: 1, stopReason: 'end_turn' },
    {
      type: 'turn_finished',
      outcome,
      usage,
      modelIterations: 1,
      durationMs: 1,
      ...(outcome === 'failed' ? { failureCode: 'MODEL_ERROR' as const } : {}),
    },
  ];
  for (const [index, event] of events.entries())
    await persistence.appendJournal({
      schemaVersion: 1,
      route,
      event,
      sessionId: prepared.sessionId,
      turnId,
      seq: index + 1,
      eventId: `${turnId}:${String(index + 1).padStart(8, '0')}`,
      wallTimeMs: Date.parse(NOW) + index,
    } as AgentRuntimeJournalEntry);
  await recoverAgentRuntimeSnapshot((await repo.loadRecoverySnapshot(prepared.sessionId))!);
  await persistence.commitTurn({
    sessionId: prepared.sessionId,
    turnId,
    turnMessages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: [{ type: 'text', text: reply }] },
    ],
    outcome,
    errorCode: outcome === 'failed' ? 'MODEL_ERROR' : null,
    errorMessage: null,
    endedAt: NOW,
  });
  return prepared;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Agent chat extension: two independent product databases', () => {
  it('publishes committed canonical history and resumes under a new local session', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    const original = await complete(a.db, 'conversation');
    expect((await a.db.select().from(AgentChatQueueTable)).length).toBeGreaterThan(0);
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    const [remote] = await b.db.select().from(AgentConversationTable);
    expect(remote.messagesJson).toContain('I read the chapter');
    expect(remote.messagesJson).toContain('Please read the chapter');
    expect(remote.runtimeSessionId).toBeNull();
    const branch = await b.repo.forkForContinuation(remote.id);
    expect(branch).not.toBe(remote.id);
    const next = await complete(b.db, branch, 'Continue please', 'Continuing');
    expect(next.sessionId).not.toBe(original.sessionId);
    expect(next.history).toEqual([
      { role: 'user', content: 'Please read the chapter' },
      { role: 'assistant', content: [{ type: 'text', text: 'I read the chapter' }] },
    ]);
    expect(await b.db.select().from(AgentPermissionGrantTable)).toHaveLength(0);
    expect(await b.db.select().from(AgentRuntimeToolCallTable)).toHaveLength(0);
    await cycle(net.runtime(b.db));
    await cycle(net.runtime(a.db));
    expect((await a.db.select().from(AgentChatBranchTable)).map((row) => row.readiness)).toEqual([
      'ready',
      'ready',
    ]);
  });

  it.each(['failed', 'aborted'] as const)(
    'syncs %s display without promoting partial replies into model history',
    async (outcome) => {
      const a = await client();
      const b = await client();
      const net = network();
      await complete(a.db, 'partial', 'Please continue this task', 'An unfinished reply', outcome);
      await cycle(net.runtime(a.db));
      await cycle(net.runtime(b.db));
      expect((await b.db.select().from(AgentConversationTable))[0].messagesJson).toContain(
        'An unfinished reply',
      );
      const fork = await b.repo.forkForContinuation('partial');
      const next = await complete(b.db, fork, 'Try again');
      expect(next.history).toEqual([{ role: 'user', content: 'Please continue this task' }]);
    },
  );

  it('does not publish an executing root or block its first local session during backfill', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await a.db
      .insert(AgentConversationTable)
      .values({ id: 'live', projectId: 'p', title: 'Live', createdAt: NOW, updatedAt: NOW });
    await cycle(net.runtime(a.db));
    expect(await a.db.select().from(AgentChatBranchTable)).toHaveLength(0);
    expect(await a.repo.forkForContinuation('live')).toBe('live');
    await complete(a.db, 'live');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    expect((await b.db.select().from(AgentChatBranchTable))[0].readiness).toBe('ready');
  });

  it('preserves concurrent continuations and converges after reordered/repeated delivery', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'conversation');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    const fork = await b.repo.forkForContinuation('conversation');
    await complete(a.db, 'conversation', 'Desktop path', 'Desktop answer');
    await complete(b.db, fork, 'Phone path', 'Phone answer');
    await cycle(net.runtime(b.db));
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    const project = async (db: DbClient) =>
      (await db.select().from(AgentChatBranchTable)).sort((x, y) => x.id.localeCompare(y.id));
    expect(await project(a.db)).toEqual(await project(b.db));
    for (const branch of await project(a.db)) {
      const history = canonicalJson(await a.repo.history('p', branch.headTurnId));
      expect(history).toContain('I read the chapter');
      expect(history.includes('Desktop answer') && history.includes('Phone answer')).toBe(false);
    }
    const count = (await a.db.select().from(AgentChatObjectTable)).length;
    await cycle(net.runtime(a.db));
    expect(await a.db.select().from(AgentChatObjectTable)).toHaveLength(count);
  });

  it('retains tombstones when a late local turn completes', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'conversation');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await b.db
      .update(AgentConversationTable)
      .set({ deletedAt: NOW })
      .where(eq(AgentConversationTable.id, 'conversation'));
    await complete(a.db, 'conversation', 'A late message', 'A late answer');
    await cycle(net.runtime(b.db));
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    for (const db of [a.db, b.db])
      expect((await db.select().from(AgentChatBranchTable))[0].deletedAt).toBe(NOW);
  });

  it('keeps legacy display caches read-only and blocks incomplete history', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await a.db.insert(AgentConversationTable).values({
      id: 'archive',
      projectId: 'p',
      title: 'Archive',
      messagesJson: JSON.stringify([{ kind: 'assistant', text: 'Historical display only' }]),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await expect(b.repo.forkForContinuation('archive')).rejects.toThrow('not ready');
    expect((await b.db.select().from(AgentChatBranchTable))[0].readiness).toBe('archive');
  });

  it('leaves publication pending across a transport failure and restart', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'conversation');
    const failure = vi
      .spyOn(net.provider, 'uploadImmutable')
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { retryable: true }));
    await expect(cycle(net.runtime(a.db))).rejects.toThrow('offline');
    failure.mockRestore();
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    expect((await b.db.select().from(AgentConversationTable))[0].messagesJson).toContain(
      'I read the chapter',
    );
  });

  it('rejects immutable identity conflicts and foreign-generation envelopes', async () => {
    const a = await client();
    const blobs = await chunkText('p', 'hello');
    await a.repo.put(blobs[0]);
    await expect(a.repo.put({ ...blobs[0], text: 'changed' })).rejects.toThrow('changed content');
    const wire = encodeChatWire(blobs[0], 'ps', 'g');
    expect(() =>
      decodeChatWire(wire, { projectId: 'other', projectSyncId: 'ps', generationId: 'g' }),
    ).toThrow('project');
    expect(() =>
      decodeChatWire(wire, { projectId: 'p', projectSyncId: 'ps', generationId: 'wrong' }),
    ).toThrow('mismatch');
  });

  it('waits for all referenced chunks before opening a received turn', async () => {
    const a = await client();
    await a.repo.put({
      id: 'm:1',
      kind: 'branch',
      projectId: 'p',
      branchId: 'c',
      rootId: 'c',
      parentBranchId: null,
      forkTurnId: null,
      title: 'Pending',
      clock: CLOCK,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const payload: ChatTurnPayload = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      ],
      display: [{ kind: 'assistant', text: 'world' }],
      artifacts: [],
      summaries: [],
    };
    const chunks = await chunkText('p', canonicalJson(payload));
    await a.repo.put({
      id: 't:1',
      kind: 'turn',
      projectId: 'p',
      branchId: 'c',
      parentTurnId: null,
      outcome: 'completed',
      payloadIds: chunks.map((c) => c.id),
      createdAt: NOW,
    });
    await a.repo.reconcile('p');
    expect((await a.db.select().from(AgentChatBranchTable))[0].readiness).toBe('pending');
    for (const chunk of chunks) await a.repo.put(chunk);
    await a.repo.reconcile('p');
    expect((await a.db.select().from(AgentChatBranchTable))[0].readiness).toBe('ready');
    const fork = await a.repo.forkForContinuation('c');
    await seedAgentChatSession(a.db, fork, 'p', 'test', null);
    expect(
      (
        await a.db
          .select()
          .from(AgentChatBindingTable)
          .where(eq(AgentChatBindingTable.conversationId, fork))
      )[0].sessionId,
    ).toBeTruthy();
  });

  it('preserves visible author context without displaying hidden runtime instructions', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'conversation', 'Synthetic runtime context\n\nVisible question');
    const visible = {
      kind: 'user',
      text: 'Visible question',
      at: NOW,
      context: [{ kind: 'project', projectId: 'p', label: 'Synthetic project' }],
    };
    await a.db.update(AgentConversationTable).set({ messagesJson: JSON.stringify([visible]) });
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    const [remote] = await b.db.select().from(AgentConversationTable);
    expect(JSON.parse(remote.messagesJson)[0]).toEqual(visible);
    expect(remote.messagesJson).not.toContain('Synthetic runtime context');
  });

  it('imports repeated call IDs, verified summaries and paged results as inert local history', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await a.repo.put({
      id: 'm:tools',
      kind: 'branch',
      projectId: 'p',
      branchId: 'tools',
      rootId: 'tools',
      parentBranchId: null,
      forkTurnId: null,
      title: 'Tool history',
      clock: CLOCK,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const allMessages: AgentModelMessage[] = [];
    const longResult = 'Synthetic chapter 段落🙂\n'.repeat(12_000);
    for (const index of [1, 2]) {
      const ref = `agent-result:origin:${index}:reused-call`;
      const messages: AgentModelMessage[] = [
        { role: 'user', content: `Read chapter ${index}` },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'reused-call',
              name: 'read_chapter',
              arguments: { chapterId: String(index) },
              rawArguments: JSON.stringify({ chapterId: String(index) }),
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              callId: 'reused-call',
              name: 'read_chapter',
              ok: true,
              content: JSON.stringify({
                resultRef: ref,
                truncated: true,
                reread: { tool: 'read_result_page', arguments: { resultRef: ref } },
              }),
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: `Chapter ${index} read` }] },
      ];
      allMessages.push(...messages);
      const rows = agentModelMessagesToContextSources({
        systemPrompt: 'history validation',
        messages: allMessages,
        resolveToolAccess: () => 'read',
      }).sourceRows.filter((row) => row.kind !== 'system_policy');
      const candidate = {
        summaryId: `summary-${index}`,
        sourceIds: rows.map((row) => row.sourceId),
        sourceHash: await hashAgentContextSourceRows(rows),
        content: 'Verified synthetic chapter summary',
      };
      const artifacts = [
        {
          ref,
          toolName: 'read_chapter',
          callId: 'reused-call',
          arguments: { chapterId: String(index) },
          payloadIds: await a.repo.storeText('p', longResult, a.db),
        },
      ];
      const payload: ChatTurnPayload = {
        messages,
        artifacts,
        summaries: [
          candidate,
          { ...candidate, summaryId: 'tampered', sourceHash: 'sha256:' + '0'.repeat(64) },
        ],
        display: [
          { kind: 'user', text: `Read chapter ${index}` },
          { kind: 'assistant', text: `Chapter ${index} read` },
        ],
      };
      const payloadIds = await a.repo.storeText('p', canonicalJson(payload), a.db);
      await a.repo.put({
        id: `t:tool-${index}`,
        kind: 'turn',
        projectId: 'p',
        branchId: 'tools',
        parentTurnId: index === 1 ? null : 't:tool-1',
        outcome: 'completed',
        payloadIds,
        createdAt: NOW,
      });
    }
    await a.repo.reconcile('p');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    const fork = await b.repo.forkForContinuation('tools');
    const prepared = await complete(b.db, fork, 'Continue on this device');
    expect(prepared.history).toEqual(allMessages);
    const artifacts = createAgentRuntimeResultArtifactRepository(b.db);
    const ref = 'agent-result:origin:1:reused-call';
    const page = await artifacts.readPage({
      ref,
      projectId: 'p',
      sessionId: prepared.sessionId,
      offset: 65_500,
      limit: 1200,
    });
    expect(page?.content).toBe([...longResult].slice(65_500, 66_700).join(''));
    expect(page?.arguments).toEqual({ chapterId: '1' });
    expect(
      await artifacts.get({ ref, projectId: 'other', sessionId: prepared.sessionId }),
    ).toBeNull();
    expect(await artifacts.get({ ref, projectId: 'p', sessionId: 'unrelated' })).toBeNull();
    const repository = createAgentRuntimePersistenceRepository(b.db);
    const snapshot = (await repository.loadRecoverySnapshot(prepared.sessionId))!;
    expect(snapshot.checkpoints[0].context).not.toEqual(
      expect.objectContaining({
        durableSummaries: expect.arrayContaining([
          expect.objectContaining({ summaryId: 'tampered' }),
        ]),
      }),
    );
    expect(JSON.stringify(snapshot.checkpoints[0])).toContain('summary-2');
    const recovered = await recoverAgentRuntimeSnapshot(snapshot);
    expect(recovered.repairs).toHaveLength(0);
    expect(await loadCanonicalAgentTranscript(prepared.sessionId, repository)).toEqual(
      expect.arrayContaining([
        { kind: 'user', text: 'Read chapter 1' },
        { kind: 'assistant', text: 'Chapter 2 read' },
      ]),
    );
    expect(await b.db.select().from(AgentRuntimeToolCallTable)).toHaveLength(0);
    expect(await b.db.select().from(AgentPermissionGrantTable)).toHaveLength(0);
  });

  it('resumes bounded backfill and recovers an expired cursor without duplicate turns', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    for (let index = 0; index < 19; index++)
      await complete(a.db, 'long-chat', `Prompt ${index}`, `Answer ${index}`);
    await a.repo.flush('p');
    expect(
      (await a.db.select().from(AgentChatObjectTable)).filter((row) => row.kind === 'turn'),
    ).toHaveLength(16);
    expect(await a.db.select().from(AgentChatQueueTable)).toHaveLength(1);
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await b.db.update(AgentChatCursorTable).set({ cursor: 'invalid' });
    await expect(cycle(net.runtime(b.db))).rejects.toThrow();
    expect((await b.db.select().from(AgentChatCursorTable))[0].cursor).toBeNull();
    await cycle(net.runtime(b.db));
    expect(
      (await b.db.select().from(AgentChatObjectTable)).filter((row) => row.kind === 'turn'),
    ).toHaveLength(19);
  });

  it('leaves v1 prose snapshot bytes unchanged and blocks deleted project generations', async () => {
    const a = await client();
    const net = network();
    const capture = () =>
      captureSnapshotV1({
        db: a.db,
        projectId: 'p',
        syncGenerationId: 'g',
        snapshotId: 'snapshot',
        snapshotKind: 'genesis',
        packageLogicalKeyId: 'pending-package-key',
        capturedAt: { wallMs: 100, counter: 0 },
        committedAt: { wallMs: 101, counter: 0 },
      });
    const before = await capture();
    await complete(a.db, 'conversation');
    await cycle(net.runtime(a.db));
    expect((await capture()).packageBytes).toEqual(before.packageBytes);
    await a.db.delete(ProjectTable).where(eq(ProjectTable.id, 'p'));
    await expect(cycle(net.runtime(a.db))).rejects.toThrow('no longer active');
    await a.db.update(SyncGenerationTable).set({ status: 'retired', retiredAt: NOW });
    await expect(cycle(net.runtime(a.db))).rejects.toThrow('no longer active');
  });

  it('converges simultaneous title edits and quarantines malformed display per branch', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'good');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await a.db.update(AgentConversationTable).set({ title: 'Desktop title', updatedAt: NOW });
    await b.db.update(AgentConversationTable).set({ title: 'Mobile title', updatedAt: NOW });
    await a.repo.flush('p');
    await b.repo.flush('p');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await cycle(net.runtime(a.db));
    expect((await a.db.select().from(AgentChatBranchTable))[0].title).toBe(
      (await b.db.select().from(AgentChatBranchTable))[0].title,
    );
    const parent = (await b.db.select().from(AgentChatBranchTable))[0];
    await b.repo.put({
      id: 'm:bad',
      kind: 'branch',
      projectId: 'p',
      branchId: 'bad',
      rootId: 'bad',
      parentBranchId: null,
      forkTurnId: null,
      title: 'Bad history',
      clock: CLOCK,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const payloadIds = await b.repo.storeText(
      'p',
      JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        display: [{ kind: 'assistant', text: {} }],
        artifacts: [],
        summaries: [],
      }),
      b.db,
    );
    await b.repo.put({
      id: 't:bad',
      kind: 'turn',
      projectId: 'p',
      branchId: 'bad',
      parentTurnId: null,
      outcome: 'completed',
      payloadIds,
      createdAt: NOW,
    });
    await b.repo.reconcile('p');
    expect(
      (await b.db.select().from(AgentChatBranchTable).where(eq(AgentChatBranchTable.id, 'bad')))[0]
        .readiness,
    ).toBe('conflict');
    expect(
      (
        await b.db.select().from(AgentChatBranchTable).where(eq(AgentChatBranchTable.id, parent.id))
      )[0].readiness,
    ).toBe('ready');
  });

  it('retries database interruptions at export and receive without acknowledging lost objects', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'durable');
    a.gateway.failNextExecute(
      (sql) => sql.startsWith('insert') && sql.includes('"agent_chat_object"'),
      'Synthetic export storage interruption',
    );
    await expect(cycle(net.runtime(a.db))).rejects.toThrow();
    expect(await a.db.select().from(AgentChatQueueTable)).toHaveLength(1);
    expect(await a.db.select().from(AgentChatObjectTable)).toHaveLength(0);
    await cycle(net.runtime(a.db));
    b.gateway.failNextExecute(
      (sql) => sql.startsWith('insert') && sql.includes('"agent_chat_object"'),
      'Synthetic receive storage interruption',
    );
    await expect(cycle(net.runtime(b.db))).rejects.toThrow();
    expect(await b.db.select().from(AgentChatDeliveryTable)).toHaveLength(0);
    expect((await b.db.select().from(AgentChatCursorTable))[0].cursor).toBeNull();
    await cycle(net.runtime(b.db));
    expect((await b.db.select().from(AgentConversationTable))[0].messagesJson).toContain(
      'I read the chapter',
    );
    vi.spyOn(net.provider, 'listChanges').mockRejectedValueOnce(
      Object.assign(new Error('expired native cursor'), {
        code: 'invalid-cursor',
        retryable: false,
      }),
    );
    await expect(cycle(net.runtime(b.db))).rejects.toThrow('expired native cursor');
    expect((await b.db.select().from(AgentChatCursorTable))[0].cursor).toBeNull();
    await cycle(net.runtime(b.db));
  });

  it('converges concurrent deletion timestamps independently of receive order', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'deleted');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await a.db
      .update(AgentConversationTable)
      .set({ deletedAt: '2026-09-05T01:00:00.000Z', updatedAt: '2026-09-05T01:00:00.000Z' });
    await b.db
      .update(AgentConversationTable)
      .set({ deletedAt: '2026-09-05T02:00:00.000Z', updatedAt: '2026-09-05T02:00:00.000Z' });
    await a.repo.flush('p');
    await b.repo.flush('p');
    await cycle(net.runtime(a.db));
    await cycle(net.runtime(b.db));
    await cycle(net.runtime(a.db));
    expect(await a.db.select().from(AgentChatBranchTable)).toEqual(
      await b.db.select().from(AgentChatBranchTable),
    );
    await expect(a.repo.forkForContinuation('deleted')).rejects.toThrow('not ready');
  });

  it('rebuilds an acknowledged inbox after a crash before its conversation projection', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'inbox');
    await cycle(net.runtime(a.db));
    const interrupted = vi
      .spyOn(AgentConversationSyncRepository.prototype, 'reconcile')
      .mockRejectedValueOnce(new Error('Synthetic interruption before projection'));
    await expect(cycle(net.runtime(b.db))).rejects.toThrow('before projection');
    interrupted.mockRestore();
    expect((await b.db.select().from(AgentChatCursorTable))[0].cursor).not.toBeNull();
    expect(await b.db.select().from(AgentConversationTable)).toHaveLength(0);
    await cycle(net.runtime(b.db));
    expect((await b.db.select().from(AgentConversationTable))[0].messagesJson).toContain(
      'I read the chapter',
    );
  });

  it('does not advance a cancelled account cursor or apply its responses', async () => {
    const a = await client();
    const b = await client();
    const net = network();
    await complete(a.db, 'conversation');
    await cycle(net.runtime(a.db));
    const controller = new AbortController();
    const original = net.provider.downloadImmutable.bind(net.provider);
    vi.spyOn(net.provider, 'downloadImmutable').mockImplementation(async (input) => {
      const value = await original(input);
      controller.abort();
      return value;
    });
    await expect(
      net.runtime(b.db).runCycle(new Set(['manual']), controller.signal),
    ).rejects.toThrow();
    expect(await b.db.select().from(AgentChatDeliveryTable)).toHaveLength(0);
    expect(await b.db.select().from(AgentConversationTable)).toHaveLength(0);
  });
});
