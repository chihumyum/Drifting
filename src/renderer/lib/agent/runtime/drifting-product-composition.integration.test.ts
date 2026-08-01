import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeNodeWriteGuard } from '../../../domain/agent-runtime-freshness';
import type { BookNode } from '../../../domain/book-node';
import {
  createDatabaseClient,
  type DbClient,
} from '../../../lib/db';
import {
  AgentConversationTable,
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
} from '../../../schema/drizzle';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createProjectRepository } from '../../../sqlite-repo/project-repo';
import { createYjsRepository } from '../../../sqlite-repo/yjs-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useSettingsStore } from '../../../store/settings-store';
import { persistBookNodeUpdateWithSync } from '../../../usecase/book-node-write';
import type { AgentEventEnvelope } from '../protocol';
import {
  setAgentEditModeOverride,
} from '../agent-edit-mode';
import type {
  AgentToolContext,
  AgentWriteApi,
} from '../tool-handlers';
import { ProductFileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import {
  createDriftingAgentProductComposition,
  type DriftingAgentProductComposition,
} from './drifting-product-composition';
import {
  ScriptedFakeDriver,
  type ScriptedDriverRound,
  type ScriptedDriverStep,
} from './testing';
import { createYjsProseSeedState } from './yjs-prose-command';

const databaseSlot = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock('../../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/db')>();
  return {
    ...actual,
    getDb: () => {
      if (!databaseSlot.current) {
        throw new Error(
          'The deterministic product harness database is not installed.',
        );
      }
      return databaseSlot.current as ReturnType<typeof actual.getDb>;
    },
  };
});

const PROJECT_ID = 'product-agent-project';
const OTHER_PROJECT_ID = 'product-agent-foreign-project';
const USER_ID = 'product-agent-user';
const CONVERSATION_ID = 'product-agent-conversation';
const SESSION_ID = 'session-product-agent';
const NODE_ID = 'product-agent-node';
const OTHER_NODE_ID = 'product-agent-foreign-node';
const NODE_TITLE = 'Chapter One';
const INITIAL_SUMMARY = 'Original summary.';
const INITIAL_REVISION = '2026-07-31T00:00:00.000Z';
const DOC_ID = `node-content:${NODE_ID}`;
const CONTENT_JSON = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'opening-block' },
      content: [{ type: 'text', text: 'Before the Agent.' }],
    },
  ],
});
const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
} as const;

const initialDataState = useDataStore.getState();
const initialProjectState = useProjectStore.getState();
const initialSettingsState = useSettingsStore.getState();

function toolCallSteps(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ScriptedDriverStep[] {
  return [
    {
      op: 'emit',
      event: { type: 'tool_call_start', callId, name },
    },
    {
      op: 'emit',
      event: {
        type: 'tool_args_delta',
        callId,
        delta: JSON.stringify(args),
      },
    },
    {
      op: 'emit',
      event: { type: 'tool_call_end', callId },
    },
    { op: 'emit', event: { type: 'usage', usage: USAGE } },
    { op: 'emit', event: { type: 'finish', reason: 'tool_use' } },
  ];
}

function finalSteps(text: string): ScriptedDriverStep[] {
  return [
    { op: 'emit', event: { type: 'text_delta', text } },
    { op: 'emit', event: { type: 'usage', usage: USAGE } },
    { op: 'emit', event: { type: 'finish', reason: 'end_turn' } },
  ];
}

function expectedRevision(
  turnId: string,
  readCallId: string,
  observationOrdinal: number,
  revision: string,
) {
  const idempotencyKey = `${SESSION_ID}:${turnId}:${readCallId}`;
  return {
    receiptId: `agent-read:${idempotencyKey}`,
    observationId:
      `agent-observation:${idempotencyKey}:${observationOrdinal}`,
    revision,
  };
}

async function waitForDone(
  events: AgentEventEnvelope[],
  count: number,
): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (
      events.filter((event) => event.event.type === 'done').length >= count
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected ${count} completed product Agent turn(s).`);
}

class ProductAgentHarness {
  readonly events: AgentEventEnvelope[] = [];
  readonly nodeRepository;
  readonly contentRepository;
  readonly composition: DriftingAgentProductComposition;
  nodeWriteUsecaseCalls = 0;

  private constructor(
    readonly directory: string,
    readonly gateway: ProductFileBackedSqliteGateway,
    readonly database: DbClient,
    readonly driver: ScriptedFakeDriver,
    context: AgentToolContext,
  ) {
    this.nodeRepository = createBookNodeSqliteRepository(
      PROJECT_ID,
      database,
    );
    this.contentRepository = createBookContentRepository(database);
    this.composition = createDriftingAgentProductComposition({
      driver,
      database,
      getContext: () => context,
      createId: (kind) =>
        kind === 'session' ? SESSION_ID : `unexpected-${kind}`,
    });
    const subscription = this.composition.transport.subscribeEvents(
      (event) => this.events.push(event),
    );
    if (!subscription.ok) {
      throw new Error(subscription.error);
    }
  }

  static async create(
    rounds: readonly ScriptedDriverRound[],
  ): Promise<ProductAgentHarness> {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'drifting-agent-product-runtime-'),
    );
    const databasePath = path.join(directory, 'drifting.db');
    const gateway = new ProductFileBackedSqliteGateway(databasePath);
    const database = createDatabaseClient(gateway);
    databaseSlot.current = database;
    try {
      await gateway.open('drifting.db');
      await seedProductDatabase(database);
      await hydrateProductStores(database);
      const harnessRef: { current?: ProductAgentHarness } = {};
      const write = createRendererWriteApi(database, () => {
        if (!harnessRef.current) {
          throw new Error('Product Agent harness is not ready.');
        }
        harnessRef.current.nodeWriteUsecaseCalls += 1;
      });
      const context: AgentToolContext = {
        projectId: PROJECT_ID,
        write,
      };
      const harness = new ProductAgentHarness(
        directory,
        gateway,
        database,
        new ScriptedFakeDriver({
          id: 'deterministic-product-driver',
          rounds,
        }),
        context,
      );
      harnessRef.current = harness;
      return harness;
    } catch (error) {
      if (databaseSlot.current === database) {
        databaseSlot.current = null;
      }
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async runTurn(
    turnId: string,
    prompt: string,
    expectedDoneCount = 1,
    toolSearch: 'off' | 'auto' | 'on' = 'off',
  ): Promise<void> {
    const started = await this.composition.transport.start({
      prompt,
      turnId,
      route: {
        kind: 'chat',
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
      },
      toolSearch,
      thinking: 'off',
    });
    expect(started).toEqual({ ok: true, value: undefined });
    await waitForDone(this.events, expectedDoneCount);
    expect(
      this.events.filter(
        (event) => event.turnId === turnId && event.event.type === 'error',
      ),
    ).toEqual([]);
  }

  scalar(sql: string): number {
    const row = this.gateway.database.prepare(sql).get() as Record<
      string,
      unknown
    >;
    return Number(Object.values(row)[0] ?? 0);
  }

  rows(sql: string): Record<string, unknown>[] {
    return this.gateway.database.prepare(sql).all() as Record<
      string,
      unknown
    >[];
  }

  async close(): Promise<void> {
    await Promise.resolve();
    if (databaseSlot.current === this.database) {
      databaseSlot.current = null;
    }
    await this.gateway.close();
    const expectedPrefix = path.join(
      tmpdir(),
      'drifting-agent-product-runtime-',
    );
    if (!this.directory.startsWith(expectedPrefix)) {
      throw new Error(
        `Refusing to remove unexpected harness directory ${this.directory}.`,
      );
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function seedProductDatabase(database: DbClient): Promise<void> {
  await database.insert(ProjectTable).values([
    {
      id: PROJECT_ID,
      userId: USER_ID,
      name: 'Product Agent Book',
      summary: '',
      kvJson: '[]',
      storylineTemplateKvJson: '[]',
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
    },
    {
      id: OTHER_PROJECT_ID,
      userId: USER_ID,
      name: 'Foreign Book',
      summary: '',
      kvJson: '[]',
      storylineTemplateKvJson: '[]',
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
    },
  ]);
  await database.insert(BookNodeTable).values([
    {
      id: NODE_ID,
      projectId: PROJECT_ID,
      title: NODE_TITLE,
      summary: INITIAL_SUMMARY,
      bookOrder: 0,
      narrativeOrder: null,
      wordCount: 3,
      writingStatus: 'draft',
      kind: 'chapter',
      driftGroupId: null,
      deletedAt: null,
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
      positionX: 0,
      positionY: 0,
    },
    {
      id: OTHER_NODE_ID,
      projectId: OTHER_PROJECT_ID,
      title: NODE_TITLE,
      summary: 'Foreign summary.',
      bookOrder: 0,
      narrativeOrder: null,
      wordCount: 1,
      writingStatus: 'draft',
      kind: 'chapter',
      driftGroupId: null,
      deletedAt: null,
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
      positionX: 0,
      positionY: 0,
    },
  ]);
  await database.insert(NodeContentTable).values([
    {
      nodeId: NODE_ID,
      contentJson: CONTENT_JSON,
      outlineJson: '[]',
      plotGridJson: '{}',
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
    },
    {
      nodeId: OTHER_NODE_ID,
      contentJson: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'foreign-block' },
            content: [{ type: 'text', text: 'Foreign prose.' }],
          },
        ],
      }),
      outlineJson: '[]',
      plotGridJson: '{}',
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
    },
  ]);
  await database.insert(AgentConversationTable).values({
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: 'Product composition acceptance',
    sdkSessionId: null,
    runtimeSessionId: null,
    mode: 'byok',
    messagesJson: '[]',
    deletedAt: null,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  const seedState = await createYjsProseSeedState(CONTENT_JSON);
  await createYjsRepository(database).upsertSnapshot(
    DOC_ID,
    seedState,
    { advanceRevision: false },
  );
}

async function hydrateProductStores(database: DbClient): Promise<void> {
  const project = await createProjectRepository(
    USER_ID,
    database,
  ).findById(PROJECT_ID);
  if (!project) throw new Error('Product Agent fixture project is missing.');
  const nodes = await createBookNodeSqliteRepository(
    PROJECT_ID,
    database,
  ).findAll();
  useProjectStore.setState({
    currentProject: project,
    projects: [project],
  });
  useDataStore.getState().setBookNodes(nodes);
}

function createRendererWriteApi(
  database: DbClient,
  recordCall: () => void,
): AgentWriteApi {
  const nodeRepository = createBookNodeSqliteRepository(
    PROJECT_ID,
    database,
  );
  const persist = async (
    id: string,
    updates: Pick<BookNode, 'title'> | Pick<BookNode, 'summary'>,
    guard?: AgentRuntimeNodeWriteGuard,
  ) => {
    recordCall();
    const current = await nodeRepository.findById(id);
    if (!current) throw new Error(`Missing renderer node ${id}.`);
    const updatedAt = new Date(
      Date.parse(current.updatedAt) + 1,
    ).toISOString();
    const result = await persistBookNodeUpdateWithSync({
      projectId: PROJECT_ID,
      nodeId: id,
      updates: {
        ...updates,
        updatedAt,
      },
      syncPayload: updates,
      guard,
    });
    useDataStore.getState().updateBookNode(id, result);
    return result;
  };
  const api: Pick<AgentWriteApi, 'renameNode' | 'updateNode'> = {
    renameNode: (id, title, guard) =>
      persist(id, { title }, guard),
    updateNode: (id, updates, guard) => {
      if (updates.summary === undefined) {
        throw new Error(
          'The deterministic product harness only accepts summary updates.',
        );
      }
      return persist(id, { summary: updates.summary }, guard);
    },
  };
  return api as AgentWriteApi;
}

describe.sequential('Drifting Agent product composition', () => {
  let harness: ProductAgentHarness | undefined;

  beforeEach(() => {
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    useSettingsStore.setState(initialSettingsState, true);
    useAgentEditStore.getState().clearAll();
    useSettingsStore.getState().setAgentEditMode('approve');
    setAgentEditModeOverride(null);
  });

  afterEach(async () => {
    if (harness) await harness.close();
    harness = undefined;
    databaseSlot.current = null;
    useAgentEditStore.getState().clearAll();
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    useSettingsStore.setState(initialSettingsState, true);
    setAgentEditModeOverride(null);
  });

  it('runs a guarded node-summary write, exact reject inverse, and next-turn durable review context', async () => {
    const turnId = 'turn-summary';
    const readCallId = 'summary-read';
    const writeCallId = 'summary-write';
    const summary = 'Agent-authored summary.';
    const freshness = expectedRevision(
      turnId,
      readCallId,
      0,
      INITIAL_REVISION,
    );
    const effectId =
      `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    const rounds: ScriptedDriverRound[] = [
      {
        name: 'read current node summary',
        steps: toolCallSteps(readCallId, 'read_node', {
          node: NODE_TITLE,
          prose: false,
        }),
      },
      {
        name: 'write guarded node summary',
        steps: toolCallSteps(writeCallId, 'set_node_summary', {
          node: NODE_TITLE,
          summary,
          expectedRevision: freshness,
        }),
      },
      {
        name: 'finish summary turn',
        steps: finalSteps('Summary updated for review.'),
      },
      {
        name: 'observe reverted review on next turn',
        expectRequest: (request) => {
          expect(request.turnId).toBe('turn-review-context');
          const note = request.context.messages.find(
            (message) =>
              message.type === 'context_note' &&
              message.sourceId === `write-review:${reviewId}`,
          );
          expect(note).toMatchObject({
            type: 'context_note',
            noteKind: 'write_review',
            sourceId: `write-review:${reviewId}`,
            turnOrdinal: 0,
          });
          if (!note || note.type !== 'context_note') {
            throw new Error('Missing next-turn write review context.');
          }
          expect(JSON.parse(note.content)).toMatchObject({
            reviewId,
            effectId,
            toolName: 'set_node_summary',
            effectPhase: 'result_committed',
            reviewStatus: 'reverted',
            decisionNote: 'Keep the original summary.',
          });
        },
        steps: finalSteps('I will keep the original summary.'),
      },
    ];
    harness = await ProductAgentHarness.create(rounds);

    await harness.runTurn(
      turnId,
      'Read Chapter One and replace its summary.',
    );

    const plannedContexts = harness
      .rows(
        `SELECT payload_json FROM agent_runtime_event WHERE turn_id = '${turnId}' AND event_type = 'context_planned' ORDER BY seq`,
      )
      .map((row) => JSON.parse(String(row.payload_json)) as {
        event: { type: 'context_planned'; snapshot: { contextWindowTokens: number } };
      });
    expect(plannedContexts.length).toBeGreaterThan(0);
    expect(
      plannedContexts.every(
        (payload) => payload.event.snapshot.contextWindowTokens === 200_000,
      ),
    ).toBe(true);

    expect((await harness.nodeRepository.findById(NODE_ID))?.summary).toBe(
      summary,
    );
    expect(
      useDataStore.getState().bookNodes.find((node) => node.id === NODE_ID)
        ?.summary,
    ).toBe(summary);
    expect(
      (await harness.nodeRepository.findById(OTHER_NODE_ID))?.summary,
    ).toBe('Foreign summary.');
    expect(harness.nodeWriteUsecaseCalls).toBe(1);
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      1,
    );
    expect(
      await harness.composition.repositories.freshness.getReadReceipt(
        freshness.receiptId,
      ),
    ).toMatchObject({
      id: freshness.receiptId,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      turnId,
      toolName: 'read_node',
    });
    expect(
      await harness.composition.repositories.writeEffects.getEffect(
        effectId,
      ),
    ).toMatchObject({
      phase: 'result_committed',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      turnId,
      toolName: 'set_node_summary',
    });
    expect(
      await harness.composition.repositories.writeEffects.getReview(
        reviewId,
      ),
    ).toMatchObject({ status: 'pending' });
    const firstSnapshot =
      await harness.composition.repositories.runtime.loadRecoverySnapshot(
        SESSION_ID,
      );
    expect(firstSnapshot?.session).toMatchObject({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      status: 'idle',
    });
    expect(firstSnapshot?.turns).toEqual([
      expect.objectContaining({
        id: turnId,
        ordinal: 0,
        status: 'completed',
      }),
    ]);
    expect(
      firstSnapshot?.toolCalls.map((call) => ({
        callId: call.callId,
        name: call.name,
        access: call.access,
        status: call.status,
      })),
    ).toEqual([
      {
        callId: readCallId,
        name: 'read_node',
        access: 'read',
        status: 'completed',
      },
      {
        callId: writeCallId,
        name: 'set_node_summary',
        access: 'write',
        status: 'completed',
      },
    ]);

    const rejected = await harness.composition.tools.rejectReview(
      reviewId,
      'Keep the original summary.',
    );
    expect(rejected.review).toMatchObject({
      id: reviewId,
      status: 'reverted',
      decisionNote: 'Keep the original summary.',
    });
    expect((await harness.nodeRepository.findById(NODE_ID))?.summary).toBe(
      INITIAL_SUMMARY,
    );
    expect(
      useDataStore.getState().bookNodes.find((node) => node.id === NODE_ID)
        ?.summary,
    ).toBe(INITIAL_SUMMARY);
    expect(harness.nodeWriteUsecaseCalls).toBe(2);
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      1,
    );
    expect(
      harness.rows(
        "SELECT entity_type, payload_json FROM local_sync_mutation WHERE entity_id = '"
          + NODE_ID
          + "'",
      ),
    ).toEqual([
      {
        entity_type: 'node',
        payload_json: JSON.stringify({ summary: INITIAL_SUMMARY }),
      },
    ]);
    expect(
      harness.scalar(
        "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'uncertain'",
      ),
    ).toBe(0);

    await harness.runTurn(
      'turn-review-context',
      'Continue from the review decision.',
      2,
    );
    const completedSnapshot =
      await harness.composition.repositories.runtime.loadRecoverySnapshot(
        SESSION_ID,
      );
    expect(
      completedSnapshot?.turns.map((turn) => ({
        id: turn.id,
        ordinal: turn.ordinal,
        status: turn.status,
      })),
    ).toEqual([
      { id: turnId, ordinal: 0, status: 'completed' },
      {
        id: 'turn-review-context',
        ordinal: 1,
        status: 'completed',
      },
    ]);
    harness.driver.assertExhausted();
  });

  it('runs append_paragraph through persisted Yjs and restores the exact base on reject', async () => {
    const turnId = 'turn-prose';
    const readCallId = 'prose-read';
    const writeCallId = 'prose-append';
    const appendedText = 'A deterministic appended paragraph.';
    const freshness = expectedRevision(
      turnId,
      readCallId,
      1,
      'yjs:0',
    );
    const effectId =
      `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    const commandId =
      `agent-prose:${SESSION_ID}:${turnId}:${writeCallId}`;
    harness = await ProductAgentHarness.create([
      {
        name: 'read current Yjs prose',
        steps: toolCallSteps(readCallId, 'read_node', {
          node: NODE_TITLE,
          prose: true,
        }),
      },
      {
        name: 'append guarded paragraph',
        steps: toolCallSteps(writeCallId, 'append_paragraph', {
          entity: NODE_TITLE,
          text: appendedText,
          expectedRevision: freshness,
        }),
      },
      {
        name: 'finish prose turn',
        steps: finalSteps('Paragraph appended for review.'),
      },
    ]);
    const seedState = await createYjsProseSeedState(CONTENT_JSON);
    const initialBase =
      await harness.composition.proseCoordinator.readBase(
        DOC_ID,
        seedState,
      );
    expect(initialBase.revision).toBe(0);

    await harness.runTurn(
      turnId,
      'Read Chapter One and append one paragraph.',
    );

    const forwardBase =
      await harness.composition.proseCoordinator.readBase(
        DOC_ID,
        seedState,
      );
    expect(forwardBase.revision).toBe(1);
    expect(forwardBase.stateHash).not.toBe(initialBase.stateHash);
    expect(
      (await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson,
    ).toContain(appendedText);
    expect(
      await harness.composition.proseCoordinator.getReceipt(
        commandId,
        'forward',
      ),
    ).toMatchObject({
      docId: DOC_ID,
      baseRevision: 0,
      committedRevision: 1,
      resultStateHash: forwardBase.stateHash,
    });
    expect(
      await harness.composition.repositories.writeEffects.getEffect(
        effectId,
      ),
    ).toMatchObject({
      phase: 'result_committed',
      toolName: 'append_paragraph',
    });
    expect(
      await harness.composition.repositories.writeEffects.getReview(
        reviewId,
      ),
    ).toMatchObject({ status: 'pending' });
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      2,
    );
    expect(
      harness.scalar(
        "SELECT count(*) FROM yjs_prose_command_receipt WHERE direction = 'forward'",
      ),
    ).toBe(1);

    const rejected = await harness.composition.tools.rejectReview(
      reviewId,
      'Remove the appended paragraph.',
    );
    expect(rejected.review).toMatchObject({
      id: reviewId,
      status: 'reverted',
    });
    const revertedBase =
      await harness.composition.proseCoordinator.readBase(
        DOC_ID,
        seedState,
      );
    expect(revertedBase).toMatchObject({
      revision: 2,
      stateHash: initialBase.stateHash,
    });
    const revertedContent = await harness.contentRepository.findByNodeId(
      NODE_ID,
    );
    expect(JSON.parse(revertedContent?.contentJson ?? '{}')).toEqual(
      JSON.parse(CONTENT_JSON),
    );
    expect(
      await harness.composition.proseCoordinator.getReceipt(
        commandId,
        'inverse',
      ),
    ).toMatchObject({
      docId: DOC_ID,
      baseRevision: 1,
      committedRevision: 2,
      resultStateHash: initialBase.stateHash,
    });
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(
      2,
    );
    expect(
      harness.rows(
        "SELECT entity_type, payload_json FROM local_sync_mutation WHERE entity_id = '"
          + NODE_ID
          + "' ORDER BY entity_type",
      ),
    ).toEqual([
      {
        entity_type: 'node',
        payload_json: JSON.stringify({ wordCount: 3 }),
      },
      {
        entity_type: 'nodeContent',
        payload_json: JSON.stringify({ contentJson: CONTENT_JSON }),
      },
    ]);
    expect(
      harness.scalar(
        "SELECT count(*) FROM yjs_prose_command_receipt WHERE command_id = '"
          + commandId
          + "'",
      ),
    ).toBe(2);
    expect(
      harness.scalar(
        "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'uncertain'",
      ),
    ).toBe(0);
    expect(
      (await harness.nodeRepository.findById(OTHER_NODE_ID))?.summary,
    ).toBe('Foreign summary.');
    const snapshot =
      await harness.composition.repositories.runtime.loadRecoverySnapshot(
        SESSION_ID,
      );
    expect(snapshot?.turns).toEqual([
      expect.objectContaining({
        id: turnId,
        ordinal: 0,
        status: 'completed',
      }),
    ]);
    expect(snapshot?.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: readCallId,
          name: 'read_node',
          status: 'completed',
        }),
        expect.objectContaining({
          callId: writeCallId,
          name: 'append_paragraph',
          status: 'completed',
        }),
      ]),
    );
    harness.driver.assertExhausted();
  });

  it('edits a virtual prose file without model-visible reads or freshness and keeps exact review inverse', async () => {
    const turnId = 'turn-workspace-edit';
    const writeCallId = 'workspace-edit';
    const replacement = 'After the quiet Agent.\n\nA newly inserted paragraph.';
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    harness = await ProductAgentHarness.create([
      {
        name: 'read the virtual manuscript file',
        expectRequest: (request) => {
          expect(request.tools.map((tool) => tool.name)).toEqual([
            'list_files',
            'read_file',
            'grep',
            'edit_file',
            'ask_user',
          ]);
          expect(request.tools.map((tool) => tool.name)).not.toContain('read_node');
          expect(request.tools.map((tool) => tool.name)).not.toContain('edit_blocks');
        },
        steps: toolCallSteps('workspace-read', 'read_file', {
          path: `/chapters/${NODE_TITLE}`,
        }),
      },
      {
        name: 'edit the virtual manuscript file',
        expectRequest: (request) => {
          const visibleContext = JSON.stringify(request.context.messages);
          expect(visibleContext).toContain('Before the Agent.');
          expect(visibleContext).not.toContain('"writable":true');
          expect(visibleContext).not.toContain('read_node');
          expect(visibleContext).not.toContain('receiptId');
          expect(visibleContext).not.toContain('node_prose');
        },
        steps: toolCallSteps(writeCallId, 'edit_file', {
          path: `/chapters/${NODE_TITLE}`,
          replacements: [
            {
              oldText: 'Before the Agent.',
              newText: replacement,
            },
          ],
        }),
      },
      {
        name: 'finish virtual workspace edit',
        steps: finalSteps('I polished the opening line.'),
      },
    ]);
    const seedState = await createYjsProseSeedState(CONTENT_JSON);
    const initialBase = await harness.composition.proseCoordinator.readBase(
      DOC_ID,
      seedState,
    );

    await harness.runTurn(
      turnId,
      'Polish the opening line of Chapter One.',
      1,
      'auto',
    );

    const snapshot =
      await harness.composition.repositories.runtime.loadRecoverySnapshot(
        SESSION_ID,
      );
    expect(
      snapshot?.toolCalls.filter((call) => call.callId === writeCallId),
    ).toEqual([
      expect.objectContaining({
        callId: writeCallId,
        name: 'edit_file',
        status: 'completed',
        errorCode: null,
      }),
    ]);
    expect(
      snapshot?.toolCalls.find(
        (call) => call.callId === `${writeCallId}:workspace:edit-source`,
      ),
    ).toMatchObject({ name: 'read_node', access: 'read', status: 'completed' });
    expect(
      await harness.composition.repositories.writeEffects.getEffect(effectId),
    ).toMatchObject({
      phase: 'result_committed',
      toolName: 'edit_file',
      arguments: {
        path: `/chapters/${NODE_TITLE}/prose.md`,
        __workspaceCommand: {
          name: 'edit_prose_file',
        },
      },
    });
    const editedContent =
      (await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson ?? '';
    expect(editedContent).toContain('After the quiet Agent.');
    expect(editedContent).toContain('A newly inserted paragraph.');
    expect(
      await harness.composition.repositories.writeEffects.getReview(reviewId),
    ).toMatchObject({ status: 'pending' });
    expect(
      await harness.composition.repositories.freshness.getReadReceipt(
        `agent-read:${SESSION_ID}:${turnId}:${writeCallId}:workspace:edit-source`,
      ),
    ).toMatchObject({
      toolName: 'read_node',
      callId: `${writeCallId}:workspace:edit-source`,
    });
    const providerTranscript = snapshot?.messages
      .map((message) => JSON.stringify(message.content))
      .join('\n');
    expect(providerTranscript).toContain('read_file');
    expect(providerTranscript).toContain('edit_file');
    expect(providerTranscript).not.toContain('read_node');
    expect(providerTranscript).not.toContain('receiptId');
    expect(providerTranscript).not.toContain('expectedRevision');
    expect(providerTranscript).not.toContain('agent-review:');
    expect(providerTranscript).not.toContain('Yjs');

    const rejected = await harness.composition.tools.rejectReview(
      reviewId,
      'Keep the original line.',
    );
    expect(rejected.review.status).toBe('reverted');
    expect(
      JSON.parse(
        (await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson ?? '{}',
      ),
    ).toEqual(JSON.parse(CONTENT_JSON));
    expect(
      await harness.composition.proseCoordinator.readBase(DOC_ID, seedState),
    ).toMatchObject({
      revision: 2,
      stateHash: initialBase.stateHash,
    });
    harness.driver.assertExhausted();
  });

  it('persists a whole-book plan, resolves named targets, and pins it into the next turn', async () => {
    const objective = 'Polish the whole book without changing the narrator voice.';
    harness = await ProductAgentHarness.create([
      {
        name: 'create durable whole-book plan',
        steps: toolCallSteps('plan-create', 'update_task_plan', {
          operation: 'create',
          scopeKind: 'whole_book_chapters',
          objective,
          constraints: ['Keep the narrator voice unchanged.'],
        }),
      },
      {
        name: 'finish planning slice',
        steps: finalSteps('The durable plan is ready.'),
      },
      {
        name: 'observe pinned plan after resume',
        expectRequest: (request) => {
          const plan = request.context.messages.find(
            (message) =>
              message.type === 'context_note' &&
              message.noteKind === 'task_plan',
          );
          const constraints = request.context.messages.find(
            (message) =>
              message.type === 'context_note' &&
              message.noteKind === 'task_constraints',
          );
          expect(plan).toBeDefined();
          expect(constraints).toBeDefined();
          if (!plan || plan.type !== 'context_note') {
            throw new Error('Missing pinned long-task plan.');
          }
          const payload = JSON.parse(plan.content) as {
            task: { objective: string };
            stepWindow: {
              steps: Array<{
                target: Record<string, unknown> | null;
              }>;
            };
          };
          expect(payload.task.objective).toBe(objective);
          expect(payload.stepWindow.steps[0]?.target).toEqual({
            kind: 'chapter',
            name: NODE_TITLE,
          });
          expect(plan.content).not.toContain(NODE_ID);
        },
        steps: finalSteps('I will resume at the first unfinished chapter.'),
      },
    ]);

    await harness.runTurn(
      'turn-plan-create',
      'Polish the whole book and preserve the narrator voice.',
    );
    const persisted =
      await harness.composition.repositories.longTasks.getOpenPlan({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
      });
    expect(persisted).toMatchObject({
      task: {
        objective,
        scopeKind: 'whole_book_chapters',
        status: 'active',
      },
      chapterManifest: [
        {
          ordinal: 0,
          name: NODE_TITLE,
          resolvedChapterId: NODE_ID,
        },
      ],
      steps: [
        {
          title: '处理章节：Chapter One',
          target: {
            kind: 'chapter',
            name: NODE_TITLE,
            resolvedTargetId: NODE_ID,
          },
          status: 'pending',
        },
      ],
    });

    const dynamic = harness.composition.dynamicTools.registerSource({
      sourceId: 'product-research',
      sourceKind: 'mcp',
      projectId: PROJECT_ID,
      tools: [
        {
          remoteName: 'lookup',
          description: 'Lookup external references.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
          access: 'read',
          approval: 'ask',
          execute: async () => ({ hits: [] }),
        },
      ],
    });
    expect(
      harness.composition.toolRuntime
        .listDefinitions({
          route: { kind: 'chat', projectId: PROJECT_ID },
        })
        .map((definition) => definition.name),
    ).toEqual(
      expect.arrayContaining([
        'read_task_plan',
        'update_task_plan',
        dynamic.providerNames[0],
      ]),
    );

    await harness.runTurn(
      'turn-plan-resume',
      'Continue the same whole-book task.',
      2,
    );
    harness.driver.assertExhausted();
  });
});
