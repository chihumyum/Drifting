import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRuntimeExpectedRevision } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeSession } from '../../../domain/agent-runtime-persistence';
import { createDatabaseClient } from '../../../lib/db';
import {
  canonicalAgentRuntimeJson,
  type AgentRuntimePersistenceRepository,
} from '../../../sqlite-repo/agent-runtime-persistence-repo';
import { createAgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { createAgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import type {
  AgentToolContext,
  AgentWriteApi,
} from '../tool-handlers';
import { P3FileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import { DriftingWriteToolRuntime } from './drifting-write-tool-runtime';
import { createRepositoryAgentTransportPersistence } from './repository-transport-persistence';
import {
  createYjsProseSeedState,
} from './yjs-prose-command';
import {
  YjsProsePersistenceCoordinator,
} from './yjs-prose-persistence-coordinator';
import type { AgentToolExecutionRequest } from './types';

const PROJECT_ID = 'restart-project';
const CONVERSATION_ID = 'restart-conversation';
const SESSION_ID = 'restart-session';
const READ_TURN_ID = 'restart-read-turn';
const WRITE_TURN_ID = 'restart-write-turn';
const READ_CALL_ID = 'restart-read-call';
const WRITE_CALL_ID = 'restart-write-call';
const READ_IDEMPOTENCY_KEY =
  `${SESSION_ID}:${READ_TURN_ID}:${READ_CALL_ID}`;
const WRITE_IDEMPOTENCY_KEY =
  `${SESSION_ID}:${WRITE_TURN_ID}:${WRITE_CALL_ID}`;
const AT = '2026-07-30T00:00:00.000Z';
const CONTENT_JSON = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'block-a' },
      content: [{ type: 'text', text: 'Before restart' }],
    },
  ],
});
const initialDataState = useDataStore.getState();

afterEach(() => {
  useAgentEditStore.getState().clearAll();
  useDataStore.setState(initialDataState, true);
});

describe('interrupted Agent write product recovery', () => {
  it('reopens the file DB and settles one Yjs receipt before session resume without replaying the mutation', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-agent-write-restart-'),
    );
    const databasePath = path.join(directory, 'runtime.sqlite');
    let gateway = new P3FileBackedSqliteGateway(databasePath);
    try {
      seedProductRows(gateway);
      seedNodeStore();
      const firstDb = createDatabaseClient(gateway);
      const firstFreshness =
        createAgentRuntimeFreshnessRepository(firstDb);
      const firstEffects =
        createAgentRuntimeWriteEffectRepository(firstDb);
      const firstCoordinator = new YjsProsePersistenceCoordinator({
        database: firstDb,
        getLiveDocument: () => undefined,
        flushLiveDocument: async () => undefined,
        now: () => AT,
      });
      const seed = await createYjsProseSeedState(CONTENT_JSON);
      const base = await firstCoordinator.readBase(
        'node-content:node-1',
        seed,
      );
      const expected: AgentRuntimeExpectedRevision = {
        receiptId: `agent-read:${READ_IDEMPOTENCY_KEY}`,
        observationId: `agent-observation:${READ_IDEMPOTENCY_KEY}:0`,
        revision: `yjs:${base.revision}`,
      };
      await firstFreshness.persistReadReceipt({
        id: expected.receiptId,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        turnId: READ_TURN_ID,
        toolCallId: toolCallId(READ_TURN_ID, READ_CALL_ID),
        callId: READ_CALL_ID,
        toolName: 'read_node',
        idempotencyKey: READ_IDEMPOTENCY_KEY,
        result: {
          result: 'Before restart',
          freshness: {
            receiptId: expected.receiptId,
            observations: [
              {
                id: expected.observationId,
                entityKind: 'node_prose',
                entityId: 'node-1',
                revision: expected.revision,
              },
            ],
          },
        },
        observations: [
          {
            id: expected.observationId,
            entityKind: 'node_prose',
            entityId: 'node-1',
            revision: expected.revision,
            stateVector: base.stateVector,
            stateHash: base.stateHash,
          },
        ],
        createdAt: AT,
      });

      const request = writeRequest(expected);
      const effectId = `agent-write:${WRITE_IDEMPOTENCY_KEY}`;
      await firstEffects.claimEffect({
        id: effectId,
        projectId: PROJECT_ID,
        routeKind: 'chat',
        conversationId: CONVERSATION_ID,
        goalRunId: null,
        chapterId: null,
        sessionId: SESSION_ID,
        turnId: WRITE_TURN_ID,
        toolCallId: toolCallId(WRITE_TURN_ID, WRITE_CALL_ID),
        callId: WRITE_CALL_ID,
        toolName: request.name,
        idempotencyKey: WRITE_IDEMPOTENCY_KEY,
        arguments: request.arguments,
        expectedRevision: expected,
        claimedAt: AT,
      });
      const expectations = (
        await firstFreshness.attachWriteExpectations({
          effectId,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          observations: [
            {
              id: `agent-expectation:${WRITE_IDEMPOTENCY_KEY}:0`,
              observationId: expected.observationId,
            },
          ],
          createdAt: AT,
        })
      ).expectations;
      const strategy = getDriftingWriteStrategy('edit_block', {
        proseCoordinator: firstCoordinator,
        readNodeContent: async () => CONTENT_JSON,
      });
      if (!strategy) throw new Error('Missing certified prose strategy');
      const prepared = await strategy.prepare(
        request,
        toolContext(),
        expectations[0],
      );
      await firstEffects.transitionEffect({
        effectId,
        expectedPhase: 'claimed',
        nextPhase: 'confirmed',
        at: AT,
      });
      await firstEffects.transitionEffect({
        effectId,
        expectedPhase: 'confirmed',
        nextPhase: 'mutation_started',
        observedRevision: expected,
        preimage: prepared.preimage,
        forward: prepared.forward,
        inverse: prepared.inverse,
        reversibility: prepared.reversibility,
        at: AT,
      });
      const command = (
        prepared.execution as {
          command: Parameters<YjsProsePersistenceCoordinator['commit']>[0]['command'];
        }
      ).command;
      await firstCoordinator.commit({
        command,
        direction: 'forward',
        expectedRevision: base.revision,
        persistProjection: async () => undefined,
        persistOutbox: async () => undefined,
      });
      await firstEffects.transitionEffect({
        effectId,
        expectedPhase: 'mutation_started',
        nextPhase: 'uncertain',
        errorCode: 'WRITE_EFFECT_UNCERTAIN',
        errorMessage: 'simulated renderer crash',
        at: AT,
      });
      expect(receiptCount(gateway)).toBe(1);

      await gateway.close();
      useAgentEditStore.getState().clearAll();
      gateway = new P3FileBackedSqliteGateway(databasePath, false);
      const restartedDb = createDatabaseClient(gateway);
      const restartedEffects =
        createAgentRuntimeWriteEffectRepository(restartedDb);
      const restartedFreshness =
        createAgentRuntimeFreshnessRepository(restartedDb);
      const restartedCoordinator = new YjsProsePersistenceCoordinator({
        database: restartedDb,
        getLiveDocument: () => undefined,
        flushLiveDocument: async () => undefined,
        now: () => AT,
      });
      const restartedRuntime = new DriftingWriteToolRuntime({
        repository: restartedEffects,
        freshness: restartedFreshness,
        getContext: toolContext,
        now: () => AT,
        proseCoordinator: restartedCoordinator,
        readNodeContent: async () => CONTENT_JSON,
      });
      let recoveryResult:
        | Awaited<
            ReturnType<
              DriftingWriteToolRuntime['reconcileInterruptedWrites']
            >
          >
        | undefined;
      const persistence = createRepositoryAgentTransportPersistence({
        repository: resumeRepository(),
        beforeResumeSession: async (sessionId, signal) => {
          recoveryResult =
            await restartedRuntime.reconcileInterruptedWrites(
              sessionId,
              signal,
            );
        },
        resolveToolAccess: () => 'read',
      });

      await persistence.prepareTurn({
        candidateSessionId: 'unused-session',
        resumeSessionId: SESSION_ID,
        newConversation: false,
        route: {
          kind: 'chat',
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
        },
        provider: 'restart-test',
        model: null,
        turnId: 'turn-after-restart',
        prompt: 'resume',
        acceptedAt: AT,
      });

      expect(recoveryResult).toEqual({
        inspected: 1,
        reconciled: 1,
        unresolved: 0,
        issues: [],
      });
      expect((await restartedEffects.getEffect(effectId))?.phase).toBe(
        'result_committed',
      );
      expect(
        await restartedEffects.getReview(`agent-review:${effectId}`),
      ).toMatchObject({
        effectId,
        status: 'pending',
      });
      expect(receiptCount(gateway)).toBe(1);
    } finally {
      await gateway.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function seedProductRows(gateway: P3FileBackedSqliteGateway): void {
  const db = gateway.database;
  db.prepare(`
    INSERT INTO project (id, name, user_id, created_at, updated_at)
    VALUES (?, 'Restart', 'user-1', ?, ?)
  `).run(PROJECT_ID, AT, AT);
  db.prepare(`
    INSERT INTO agent_conversation (
      id, project_id, title, created_at, updated_at
    ) VALUES (?, ?, 'Restart', ?, ?)
  `).run(CONVERSATION_ID, PROJECT_ID, AT, AT);
  db.prepare(`
    INSERT INTO agent_runtime_session (
      id, project_id, route_kind, conversation_id, provider, model,
      provider_epoch, status, created_at, updated_at
    ) VALUES (?, ?, 'chat', ?, 'restart-test', NULL, 0, 'running', ?, ?)
  `).run(SESSION_ID, PROJECT_ID, CONVERSATION_ID, AT, AT);
  for (const [ordinal, turnId, callId, name, access, idempotencyKey] of [
    [0, READ_TURN_ID, READ_CALL_ID, 'read_node', 'read', READ_IDEMPOTENCY_KEY],
    [1, WRITE_TURN_ID, WRITE_CALL_ID, 'edit_block', 'write', WRITE_IDEMPOTENCY_KEY],
  ] as const) {
    const messageId = `message:${turnId}`;
    db.prepare(`
      INSERT INTO agent_runtime_turn (
        id, session_id, ordinal, status, prompt_message_id,
        accepted_at, started_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(turnId, SESSION_ID, ordinal, messageId, AT, AT, AT);
    db.prepare(`
      INSERT INTO agent_runtime_message (
        id, session_id, turn_id, ordinal, role, status,
        content_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'user', 'complete', '"fixture"', ?, ?)
    `).run(messageId, SESSION_ID, turnId, ordinal, AT, AT);
    db.prepare(`
      INSERT INTO agent_runtime_tool_call (
        id, session_id, turn_id, call_id, name, access, status,
        idempotency_key, arguments_json, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      toolCallId(turnId, callId),
      SESSION_ID,
      turnId,
      callId,
      name,
      access,
      idempotencyKey,
      canonicalAgentRuntimeJson(
        access === 'read'
          ? { node: 'node-1', prose: true }
          : writeRequest({
              receiptId: `agent-read:${READ_IDEMPOTENCY_KEY}`,
              observationId:
                `agent-observation:${READ_IDEMPOTENCY_KEY}:0`,
              revision: 'yjs:0',
            }).arguments,
      ),
      AT,
      AT,
    );
  }
}

function seedNodeStore(): void {
  useDataStore.setState({
    ...initialDataState,
    bookNodes: [
      {
        id: 'node-1',
        projectId: PROJECT_ID,
        kind: 'chapter',
        title: 'Restart chapter',
        summary: '',
        bookOrder: 1,
        narrativeOrder: null,
        driftGroupId: null,
        position: { x: 0, y: 0 },
        wordCount: 0,
        writingStatus: 'draft',
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  });
}

function writeRequest(
  expectedRevision: AgentRuntimeExpectedRevision,
): AgentToolExecutionRequest {
  return {
    sessionId: SESSION_ID,
    turnId: WRITE_TURN_ID,
    callId: WRITE_CALL_ID,
    idempotencyKey: WRITE_IDEMPOTENCY_KEY,
    name: 'edit_block',
    arguments: {
      entity: 'node-1',
      blockId: 'block-a',
      text: 'After restart',
      expectedRevision,
    },
    access: 'write',
    context: {
      route: {
        kind: 'chat',
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
      },
    },
    signal: new AbortController().signal,
  };
}

function toolContext(): AgentToolContext {
  return {
    projectId: PROJECT_ID,
    write: {} as AgentWriteApi,
  };
}

function toolCallId(turnId: string, callId: string): string {
  return `agent-tool:${SESSION_ID}:${turnId}:${callId}`;
}

function receiptCount(gateway: P3FileBackedSqliteGateway): number {
  const row = gateway.database.prepare(`
    SELECT count(*) AS count
    FROM yjs_prose_command_receipt
    WHERE command_id = ? AND direction = 'forward'
  `).get(`agent-prose:${WRITE_IDEMPOTENCY_KEY}`) as { count: number };
  return Number(row.count);
}

function resumeRepository(): AgentRuntimePersistenceRepository {
  const session: PersistedAgentRuntimeSession = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    routeKind: 'chat',
    conversationId: CONVERSATION_ID,
    goalRunId: null,
    chapterId: null,
    provider: 'restart-test',
    model: null,
    providerEpoch: 0,
    status: 'running',
    createdAt: AT,
    updatedAt: AT,
    endedAt: null,
  };
  return {
    getSession: async (id: string) => (id === SESSION_ID ? session : null),
    findSessionForRoute: async () => session,
    loadRecoverySnapshot: async () => null,
    acceptTurn: async () => 'inserted',
  } as unknown as AgentRuntimePersistenceRepository;
}
