import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeNodeWriteGuard } from '../../../domain/agent-runtime-freshness';
import type { BookNode } from '../../../domain/book-node';
import { createDatabaseClient, type DbClient } from '../../../lib/db';
import {
  AgentConversationTable,
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  ElementPatchTable,
  LibraryItemTable,
  NodeContentTable,
  ProjectTable,
  StorylineTable,
} from '../../../schema/drizzle';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createBookElementSqliteRepository } from '../../../sqlite-repo/element-repo';
import { createElementCategoryRepository } from '../../../sqlite-repo/element-category-repo';
import { createLibraryItemSqliteRepository } from '../../../sqlite-repo/library-item-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createProjectRepository } from '../../../sqlite-repo/project-repo';
import { createStorylineRepository } from '../../../sqlite-repo/storyline-repo';
import { createYjsRepository } from '../../../sqlite-repo/yjs-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useSettingsStore } from '../../../store/settings-store';
import { persistBookNodeUpdateWithSync } from '../../../usecase/book-node-write';
import type { AgentEventEnvelope } from '../protocol';
import { setAgentEditModeOverride } from '../agent-edit-mode';
import type { AgentToolContext, AgentWriteApi } from '../tool-handlers';
import { ProductFileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import {
  createDriftingAgentProductComposition,
  type DriftingAgentProductComposition,
} from './drifting-product-composition';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import { ScriptedFakeDriver, type ScriptedDriverRound, type ScriptedDriverStep } from './testing';
import type { AgentToolExecutionRequest } from './types';
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
        throw new Error('The deterministic product harness database is not installed.');
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
const DRIFT_ID = 'product-agent-drift';
const OTHER_NODE_ID = 'product-agent-foreign-node';
const CATEGORY_ID = 'product-agent-category';
const ELEMENT_ID = 'product-agent-element';
const STORYLINE_ID = 'product-agent-storyline';
const PATCH_ID = 'product-agent-patch';
const LIBRARY_ITEM_ID = 'product-agent-library-item';
const NODE_TITLE = 'Chapter One';
const DRIFT_TITLE = '灵感碎片';
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
const proseJson = (id: string, text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id },
        content: [{ type: 'text', text }],
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
    observationId: `agent-observation:${idempotencyKey}:${observationOrdinal}`,
    revision,
  };
}

async function waitForDone(events: AgentEventEnvelope[], count: number): Promise<void> {
  for (let index = 0; index < 1_000; index += 1) {
    if (events.filter((event) => event.event.type === 'done').length >= count) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(
    `Expected ${count} completed product Agent turn(s); observed ${events
      .map((event) => event.event.type)
      .join(', ')}.`,
  );
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
    this.nodeRepository = createBookNodeSqliteRepository(PROJECT_ID, database);
    this.contentRepository = createBookContentRepository(database);
    this.composition = createDriftingAgentProductComposition({
      driver,
      database,
      getContext: () => context,
      // The scripted provider has no real model metadata. Declare the same
      // explicit window this acceptance fixture is exercising rather than
      // letting an unknown driver inherit the product provider profile.
      contextWindowTokens: 200_000,
      createId: (kind) => (kind === 'session' ? SESSION_ID : `unexpected-${kind}`),
    });
    const subscription = this.composition.transport.subscribeEvents((event) =>
      this.events.push(event),
    );
    if (!subscription.ok) {
      throw new Error(subscription.error);
    }
  }

  static async create(rounds: readonly ScriptedDriverRound[]): Promise<ProductAgentHarness> {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-agent-product-runtime-'));
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
      this.events.filter((event) => event.turnId === turnId && event.event.type === 'error'),
    ).toEqual([]);
  }

  scalar(sql: string): number {
    const row = this.gateway.database.prepare(sql).get() as Record<string, unknown>;
    return Number(Object.values(row)[0] ?? 0);
  }

  rows(sql: string): Record<string, unknown>[] {
    return this.gateway.database.prepare(sql).all() as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    await Promise.resolve();
    if (databaseSlot.current === this.database) {
      databaseSlot.current = null;
    }
    await this.gateway.close();
    const expectedPrefix = path.join(tmpdir(), 'drifting-agent-product-runtime-');
    if (!this.directory.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected harness directory ${this.directory}.`);
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
  await database.insert(ElementCategoryTable).values({
    id: CATEGORY_ID,
    projectId: PROJECT_ID,
    name: 'People',
    contentJson: proseJson('category-block', 'Before category prose.'),
    elementTemplateJson: '{}',
    elementTemplateKvJson: '[]',
    color: '#8B7355',
    layoutMode: 'auto',
    gridX: null,
    gridY: null,
    deletedAt: null,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  await database.insert(BookElementTable).values({
    id: ELEMENT_ID,
    projectId: PROJECT_ID,
    categoryId: CATEGORY_ID,
    name: 'Fixture Element',
    summary: '',
    contentJson: proseJson('element-block', 'Before element prose.'),
    kvJson: '[]',
    aliasesJson: '[]',
    groupName: null,
    portraitAssetId: null,
    deletedAt: null,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  await database.insert(StorylineTable).values({
    id: STORYLINE_ID,
    projectId: PROJECT_ID,
    name: 'Fixture Storyline',
    color: '#8B7355',
    summary: '',
    orderKey: 1,
    contentJson: proseJson('storyline-block', 'Before storyline prose.'),
    kvJson: '[]',
    nodeContentTemplateJson: '{}',
    deletedAt: null,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  await database.insert(ElementPatchTable).values({
    id: PATCH_ID,
    projectId: PROJECT_ID,
    elementId: ELEMENT_ID,
    sourceNodeId: NODE_ID,
    sourceBlockId: null,
    sourceBlockText: null,
    textAnchorJson: null,
    invalidatedAt: null,
    title: 'Fixture evolution',
    contentJson: proseJson('patch-block', 'Fixture patch body.'),
    orderKey: 0,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
  await database.insert(LibraryItemTable).values({
    id: LIBRARY_ITEM_ID,
    projectId: PROJECT_ID,
    title: 'Fixture source',
    kind: 'text',
    source: 'local',
    uri: '',
    localPath: null,
    assetId: null,
    mime: null,
    sizeBytes: null,
    bodyJson: proseJson('material-block', 'Fixture source body.'),
    notesJson: null,
    thumbnailUri: null,
    orderKey: 0,
    createdAt: INITIAL_REVISION,
    updatedAt: INITIAL_REVISION,
  });
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
  await createYjsRepository(database).upsertSnapshot(DOC_ID, seedState, { advanceRevision: false });
}

async function hydrateProductStores(database: DbClient): Promise<void> {
  const project = await createProjectRepository(USER_ID, database).findById(PROJECT_ID);
  if (!project) throw new Error('Product Agent fixture project is missing.');
  const nodes = await createBookNodeSqliteRepository(PROJECT_ID, database).findAll();
  const categories = await createElementCategoryRepository(PROJECT_ID, database).findAll();
  const elements = await createBookElementSqliteRepository(PROJECT_ID, database).findAll();
  const storylines = await createStorylineRepository(PROJECT_ID, database).getStorylinesByProject();
  const libraryItems = await createLibraryItemSqliteRepository(PROJECT_ID, database).findAll();
  useProjectStore.setState({
    currentProject: project,
    projects: [project],
  });
  useDataStore.getState().setBookNodes(nodes);
  useDataStore.getState().setBookElementCategories(categories);
  useDataStore.getState().setBookElements(elements);
  useDataStore.getState().setStorylines(storylines);
  useDataStore.getState().setLibraryItems(libraryItems);
}

function createRendererWriteApi(database: DbClient, recordCall: () => void): AgentWriteApi {
  const nodeRepository = createBookNodeSqliteRepository(PROJECT_ID, database);
  const persist = async (
    id: string,
    updates: Pick<BookNode, 'title'> | Pick<BookNode, 'summary'> | Pick<BookNode, 'wordCount'>,
    guard?: AgentRuntimeNodeWriteGuard,
  ) => {
    recordCall();
    const current = await nodeRepository.findById(id);
    if (!current) throw new Error(`Missing renderer node ${id}.`);
    const updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
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
  const api: Pick<AgentWriteApi, 'renameNode' | 'updateNode' | 'updateContentByNodeId'> = {
    renameNode: (id, title, guard) => persist(id, { title }, guard),
    updateNode: (id, updates, guard) => {
      if (updates.summary !== undefined) {
        return persist(id, { summary: updates.summary }, guard);
      }
      if (updates.wordCount !== undefined) {
        return persist(id, { wordCount: updates.wordCount }, guard);
      }
      throw new Error(
        'The deterministic product harness only accepts summary or word-count updates.',
      );
    },
    updateContentByNodeId: async (id, updates) => {
      recordCall();
      return createBookContentRepository(database).updateByNodeId(id, updates);
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
    useSettingsStore.getState().setAgentEditMode('auto');
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

  it('keeps safe metadata writes automatic when inline prose review is enabled', async () => {
    const turnId = 'turn-hard-approval';
    const readCallId = 'summary-read-approved';
    const writeCallId = 'summary-approved';
    const summary = 'Approved summary.';
    const freshness = expectedRevision(turnId, readCallId, 0, INITIAL_REVISION);
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    useSettingsStore.getState().setAgentEditMode('approve');
    setAgentEditModeOverride('approve');
    harness = await ProductAgentHarness.create([
      {
        name: 'read the current summary',
        steps: toolCallSteps(readCallId, 'read_node', {
          node: NODE_TITLE,
          prose: false,
        }),
      },
      {
        name: 'request a summary update',
        steps: toolCallSteps(writeCallId, 'set_node_summary', {
          node: NODE_TITLE,
          summary,
          expectedRevision: freshness,
        }),
      },
      {
        name: 'finish approved summary',
        steps: finalSteps('The summary was updated.'),
      },
    ]);

    await harness.runTurn(turnId, 'Update the summary of Chapter One.');

    expect((await harness.nodeRepository.findById(NODE_ID))?.summary).toBe(summary);
    expect(harness.nodeWriteUsecaseCalls).toBe(1);
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(1);
    expect(useAgentEditStore.getState().pending).toEqual({});
    expect(await harness.composition.repositories.writeEffects.getEffect(effectId)).toMatchObject({
      phase: 'result_committed',
      toolName: 'set_node_summary',
      authorization: {
        kind: 'automatic',
        requestId: null,
      },
    });
    expect(harness.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(0);
    expect(
      harness.events.filter(
        (event) => event.turnId === turnId && event.event.type === 'permission_request',
      ),
    ).toEqual([]);
    const journalTypes = harness
      .rows(`SELECT event_type FROM agent_runtime_event WHERE turn_id = '${turnId}' ORDER BY seq`)
      .map((row) => String(row.event_type));
    expect(journalTypes).not.toContain('permission_requested');
    const plannedContexts = harness
      .rows(
        `SELECT payload_json FROM agent_runtime_event WHERE turn_id = '${turnId}' AND event_type = 'context_planned' ORDER BY seq`,
      )
      .map(
        (row) =>
          JSON.parse(String(row.payload_json)) as {
            event: { type: 'context_planned'; snapshot: { contextWindowTokens: number } };
          },
      );
    expect(plannedContexts.length).toBeGreaterThan(0);
    expect(
      plannedContexts.every((payload) => payload.event.snapshot.contextWindowTokens === 200_000),
    ).toBe(true);
    harness.driver.assertExhausted();
  });

  it('writes prose immediately in approve mode and creates an inline editor review', async () => {
    const turnId = 'turn-inline-review';
    const readCallId = 'prose-read-reviewed';
    const writeCallId = 'prose-write-reviewed';
    const appendedText = 'A paragraph waiting for inline review.';
    const freshness = expectedRevision(turnId, readCallId, 1, 'yjs:0');
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    useSettingsStore.getState().setAgentEditMode('approve');
    setAgentEditModeOverride('approve');
    harness = await ProductAgentHarness.create([
      {
        name: 'read prose before reviewed edit',
        steps: toolCallSteps(readCallId, 'read_node', {
          node: NODE_TITLE,
          prose: true,
        }),
      },
      {
        name: 'append prose for inline review',
        steps: toolCallSteps(writeCallId, 'append_paragraph', {
          entity: NODE_TITLE,
          text: appendedText,
          expectedRevision: freshness,
        }),
      },
      {
        name: 'finish reviewed prose turn',
        steps: finalSteps('The paragraph is visible in the editor.'),
      },
    ]);
    const seedState = await createYjsProseSeedState(CONTENT_JSON);
    expect((await harness.composition.proseCoordinator.readBase(DOC_ID, seedState)).revision).toBe(
      0,
    );

    await harness.runTurn(turnId, 'Append one paragraph to Chapter One.');

    expect((await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson).toContain(
      appendedText,
    );
    expect(await harness.composition.repositories.writeEffects.getEffect(effectId)).toMatchObject({
      phase: 'result_committed',
      authorization: { kind: 'automatic', requestId: null },
    });
    expect(await harness.composition.repositories.writeEffects.getReview(reviewId)).toMatchObject({
      effectId,
      status: 'pending',
    });
    const editorState = useAgentEditStore.getState();
    expect(editorState.reviewBatches[reviewId]).toMatchObject({
      effectId,
      reviewId,
      entityType: 'node',
      id: NODE_ID,
    });
    expect(editorState.pending[`node:${NODE_ID}`]?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: 'approve',
          reviewId,
        }),
      ]),
    );
    expect(
      harness.events.filter(
        (event) => event.turnId === turnId && event.event.type === 'permission_request',
      ),
    ).toEqual([]);
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(2);

    const rejected = await harness.composition.tools.rejectReview(
      reviewId,
      'Reject from editor test',
    );
    expect(await harness.composition.repositories.writeEffects.listReviewBlocks(reviewId)).toEqual([
      expect.objectContaining({ status: 'reverted' }),
    ]);
    expect(rejected.review).toMatchObject({
      id: reviewId,
      status: 'reverted',
    });
    expect((await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson).not.toContain(
      appendedText,
    );
    harness.driver.assertExhausted();
  });

  it('rebuilds a lost inline review from file SQLite and settles mixed blocks against Yjs', async () => {
    const turnId = 'turn-inline-review-restart';
    const writeCallId = 'workspace-reviewed-edit';
    const replacement = 'Accepted rewrite.\n\nRejected extra paragraph.';
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    useSettingsStore.getState().setAgentEditMode('approve');
    setAgentEditModeOverride('approve');
    harness = await ProductAgentHarness.create([
      {
        name: 'read virtual prose before mixed review',
        steps: toolCallSteps('workspace-reviewed-read', 'read_file', {
          path: `/chapters/${NODE_TITLE}`,
        }),
      },
      {
        name: 'create two reviewable prose blocks',
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
        name: 'finish mixed review turn',
        steps: finalSteps('The two paragraph changes are ready in the editor.'),
      },
    ]);
    await harness.runTurn(turnId, 'Rewrite the opening and add one paragraph.', 1, 'auto');

    const blocks = await harness.composition.repositories.writeEffects.listReviewBlocks(reviewId);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      blockId: 'opening-block',
      ordinal: 0,
      status: 'pending',
    });

    // Simulate complete localStorage loss. SQLite + immutable effect evidence
    // must rebuild both editor diffs without replaying the write.
    useAgentEditStore.getState().clearAll();
    await expect(harness.composition.tools.reconcileProjectReviews(PROJECT_ID)).resolves.toEqual({
      projected: 1,
      unresolved: 0,
    });
    expect(
      useAgentEditStore
        .getState()
        .pending[`node:${NODE_ID}`]?.changes.map((change) => change.blockId),
    ).toEqual(blocks.map((block) => block.blockId));

    await expect(
      harness.composition.tools.acceptReviewBlock(
        reviewId,
        blocks[0]!.blockId,
        'Keep the rewritten opening',
      ),
    ).resolves.toMatchObject({
      review: { status: 'pending' },
      block: { status: 'accepted' },
    });

    // Lose the local projection again after a partial decision. Hydration must
    // hide the accepted block and keep exactly the undecided paragraph.
    useAgentEditStore.getState().clearAll();
    await harness.composition.tools.reconcileProjectReviews(PROJECT_ID);
    expect(
      useAgentEditStore
        .getState()
        .pending[`node:${NODE_ID}`]?.changes.map((change) => change.blockId),
    ).toEqual([blocks[1]!.blockId]);

    await expect(
      harness.composition.tools.rejectReviewBlock(
        reviewId,
        blocks[1]!.blockId,
        'Remove the extra paragraph',
      ),
    ).resolves.toMatchObject({
      review: { status: 'accepted_effect' },
      block: { status: 'reverted' },
    });
    expect(
      await harness.composition.repositories.writeEffects.listReviewBlocks(reviewId),
    ).toMatchObject([
      { blockId: blocks[0]!.blockId, status: 'accepted' },
      { blockId: blocks[1]!.blockId, status: 'reverted' },
    ]);
    expect(await harness.composition.repositories.writeEffects.getReview(reviewId)).toMatchObject({
      status: 'accepted_effect',
      decisionNote: {
        kind: 'block_review',
        decisions: [
          { blockId: blocks[0]!.blockId, decision: 'accepted' },
          { blockId: blocks[1]!.blockId, decision: 'reverted' },
        ],
      },
    });
    const content = (await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson ?? '';
    expect(content).toContain('Accepted rewrite.');
    expect(content).not.toContain('Rejected extra paragraph.');
    await expect(harness.composition.tools.reconcileProjectReviews(PROJECT_ID)).resolves.toEqual({
      projected: 0,
      unresolved: 0,
    });
    harness.driver.assertExhausted();
  });

  it('recovers when Yjs reverted but the durable block-settlement acknowledgement failed', async () => {
    const turnId = 'turn-inline-review-fault';
    const readCallId = 'fault-reviewed-read';
    const writeCallId = 'fault-reviewed-append';
    const appendedText = 'Paragraph removed across a settlement fault.';
    const freshness = expectedRevision(turnId, readCallId, 1, 'yjs:0');
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    useSettingsStore.getState().setAgentEditMode('approve');
    setAgentEditModeOverride('approve');
    harness = await ProductAgentHarness.create([
      {
        name: 'read before faulted review',
        steps: toolCallSteps(readCallId, 'read_node', {
          node: NODE_TITLE,
          prose: true,
        }),
      },
      {
        name: 'append before faulted review',
        steps: toolCallSteps(writeCallId, 'append_paragraph', {
          entity: NODE_TITLE,
          text: appendedText,
          expectedRevision: freshness,
        }),
      },
      {
        name: 'finish faulted review turn',
        steps: finalSteps('The paragraph is pending inline review.'),
      },
    ]);
    await harness.runTurn(turnId, 'Append a temporary paragraph.');
    const [block] = await harness.composition.repositories.writeEffects.listReviewBlocks(reviewId);
    expect(block).toMatchObject({ status: 'pending' });

    harness.gateway.failNextExecute(
      (sql, parameters) =>
        sql.includes('agent_runtime_write_review_block') && parameters[0] === 'reverted',
      'lost block settlement acknowledgement',
    );
    const first = await harness.composition.tools.rejectReviewBlock(
      reviewId,
      block!.blockId,
      'Reject across injected fault',
    );
    expect(first).toMatchObject({
      review: { status: 'pending' },
      block: {
        status: 'revert_failed',
        errorCode: 'WRITE_BLOCK_REVERT_FAILED',
      },
    });
    expect((await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson).not.toContain(
      appendedText,
    );

    // Restart/project hydration retries the guarded inverse. It observes that
    // the preimage is already present, repairs projection if needed, and only
    // then commits the terminal block/review rows.
    useAgentEditStore.getState().clearAll();
    await expect(harness.composition.tools.reconcileProjectReviews(PROJECT_ID)).resolves.toEqual({
      projected: 0,
      unresolved: 0,
    });
    expect(
      await harness.composition.repositories.writeEffects.listReviewBlocks(reviewId),
    ).toMatchObject([{ status: 'reverted' }]);
    expect(await harness.composition.repositories.writeEffects.getReview(reviewId)).toMatchObject({
      status: 'reverted',
    });
    expect((await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson).not.toContain(
      appendedText,
    );
    harness.driver.assertExhausted();
  });

  it('runs append_paragraph through Yjs and queues an automatic reveal', async () => {
    const turnId = 'turn-prose';
    const readCallId = 'prose-read';
    const writeCallId = 'prose-append';
    const appendedText = 'A deterministic appended paragraph.';
    const freshness = expectedRevision(turnId, readCallId, 1, 'yjs:0');
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    const commandId = `agent-prose:${SESSION_ID}:${turnId}:${writeCallId}`;
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
        steps: finalSteps('Paragraph appended.'),
      },
    ]);
    const seedState = await createYjsProseSeedState(CONTENT_JSON);
    const initialBase = await harness.composition.proseCoordinator.readBase(DOC_ID, seedState);
    expect(initialBase.revision).toBe(0);

    await harness.runTurn(turnId, 'Read Chapter One and append one paragraph.');

    const forwardBase = await harness.composition.proseCoordinator.readBase(DOC_ID, seedState);
    expect(forwardBase.revision).toBe(1);
    expect(forwardBase.stateHash).not.toBe(initialBase.stateHash);
    expect((await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson).toContain(
      appendedText,
    );
    expect(
      await harness.composition.proseCoordinator.getReceipt(commandId, 'forward'),
    ).toMatchObject({
      docId: DOC_ID,
      baseRevision: 0,
      committedRevision: 1,
      resultStateHash: forwardBase.stateHash,
    });
    expect(await harness.composition.repositories.writeEffects.getEffect(effectId)).toMatchObject({
      phase: 'result_committed',
      toolName: 'append_paragraph',
      authorization: { kind: 'automatic', requestId: null },
    });
    expect(await harness.composition.repositories.writeEffects.getReview(reviewId)).toMatchObject({
      status: 'accepted_effect',
      effectId,
    });
    expect(harness.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(1);
    expect(useAgentEditStore.getState().pending[`node:${NODE_ID}`]?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ mode: 'auto', reviewId })]),
    );
    expect(harness.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(2);
    expect(
      harness.scalar("SELECT count(*) FROM yjs_prose_command_receipt WHERE direction = 'forward'"),
    ).toBe(1);

    expect(
      harness.scalar(
        "SELECT count(*) FROM yjs_prose_command_receipt WHERE command_id = '" + commandId + "'",
      ),
    ).toBe(1);
    expect(
      harness.scalar("SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'uncertain'"),
    ).toBe(0);
    expect((await harness.nodeRepository.findById(OTHER_NODE_ID))?.summary).toBe(
      'Foreign summary.',
    );
    const snapshot =
      await harness.composition.repositories.runtime.loadRecoverySnapshot(SESSION_ID);
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

  it('edits a virtual prose file with semantic model output and an automatic reveal', async () => {
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
            'write_file',
            'delete_file',
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
    await harness.runTurn(turnId, 'Polish the opening line of Chapter One.', 1, 'auto');

    const snapshot =
      await harness.composition.repositories.runtime.loadRecoverySnapshot(SESSION_ID);
    expect(snapshot?.toolCalls.filter((call) => call.callId === writeCallId)).toEqual([
      expect.objectContaining({
        callId: writeCallId,
        name: 'edit_file',
        status: 'completed',
        errorCode: null,
      }),
    ]);
    expect(
      snapshot?.toolCalls.find((call) => call.callId === `${writeCallId}:workspace:edit-source`),
    ).toMatchObject({ name: 'read_node', access: 'read', status: 'completed' });
    expect(await harness.composition.repositories.writeEffects.getEffect(effectId)).toMatchObject({
      phase: 'result_committed',
      toolName: 'edit_file',
      authorization: { kind: 'automatic', requestId: null },
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
    expect(await harness.composition.repositories.writeEffects.getReview(reviewId)).toMatchObject({
      status: 'accepted_effect',
      effectId,
    });
    expect(harness.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(1);
    expect(useAgentEditStore.getState().pending[`node:${NODE_ID}`]?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ mode: 'auto', reviewId })]),
    );
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

    harness.driver.assertExhausted();
  });

  it('routes whole-file prose replacement through the inline editor review', async () => {
    const turnId = 'turn-workspace-whole-prose-review';
    const writeCallId = 'workspace-whole-prose-write';
    const replacement = 'Before the Agent, revised.\n\nA second reviewed paragraph.';
    const effectId = `agent-write:${SESSION_ID}:${turnId}:${writeCallId}`;
    const reviewId = `agent-review:${effectId}`;
    useSettingsStore.getState().setAgentEditMode('approve');
    setAgentEditModeOverride('approve');
    harness = await ProductAgentHarness.create([
      {
        name: 'read prose before whole-file replacement',
        steps: toolCallSteps('workspace-whole-prose-read', 'read_file', {
          path: `/chapters/${NODE_TITLE}/prose.md`,
        }),
      },
      {
        name: 'replace the complete prose file',
        steps: toolCallSteps(writeCallId, 'write_file', {
          path: `/chapters/${NODE_TITLE}/prose.md`,
          content: replacement,
        }),
      },
      {
        name: 'finish whole-file prose replacement',
        steps: finalSteps('The complete chapter replacement is ready for review.'),
      },
    ]);

    await harness.runTurn(turnId, 'Rewrite the complete prose of Chapter One.', 1, 'auto');

    expect((await harness.contentRepository.findByNodeId(NODE_ID))?.contentJson).toContain(
      'A second reviewed paragraph.',
    );
    expect(await harness.composition.repositories.writeEffects.getEffect(effectId)).toMatchObject({
      phase: 'result_committed',
      toolName: 'write_file',
      authorization: { kind: 'automatic', requestId: null },
    });
    expect(await harness.composition.repositories.writeEffects.getReview(reviewId)).toMatchObject({
      effectId,
      status: 'pending',
    });
    expect(useAgentEditStore.getState().reviewBatches[reviewId]).toMatchObject({
      effectId,
      reviewId,
      entityType: 'node',
      id: NODE_ID,
    });
    expect(harness.scalar('SELECT count(*) FROM agent_runtime_write_review')).toBe(1);
    harness.driver.assertExhausted();
  });

  it('lets workspace writes target any project entity without a content-scope gate', async () => {
    const turnId = 'turn-workspace-generic-prose';
    harness = await ProductAgentHarness.create([
      {
        name: 'edit element prose',
        steps: toolCallSteps('edit-element-prose', 'edit_file', {
          path: '/elements/People/Fixture Element/body.md',
          replacements: [
            {
              oldText: 'Before element prose.',
              newText: 'After element prose.',
            },
          ],
        }),
      },
      {
        name: 'edit storyline prose',
        steps: toolCallSteps('edit-storyline-prose', 'edit_file', {
          path: '/storylines/Fixture Storyline/body.md',
          replacements: [
            {
              oldText: 'Before storyline prose.',
              newText: 'After storyline prose.',
            },
          ],
        }),
      },
      {
        name: 'edit category prose',
        steps: toolCallSteps('edit-category-prose', 'edit_file', {
          path: '/categories/People/body.md',
          replacements: [
            {
              oldText: 'Before category prose.',
              newText: 'After category prose.',
            },
          ],
        }),
      },
      {
        name: 'finish generic prose edits',
        steps: finalSteps('Updated all three entity manuscripts.'),
      },
    ]);

    await harness.runTurn(
      turnId,
      'Update Fixture Element, Fixture Storyline, and the People category bodies.',
      1,
      'auto',
    );

    expect(
      String(
        harness.rows(`SELECT content_json FROM element WHERE id = '${ELEMENT_ID}'`)[0]
          ?.content_json ?? '',
      ),
    ).toContain('After element prose.');
    expect(
      String(
        harness.rows(`SELECT content_json FROM storylines WHERE id = '${STORYLINE_ID}'`)[0]
          ?.content_json ?? '',
      ),
    ).toContain('After storyline prose.');
    expect(
      String(
        harness.rows(`SELECT content_json FROM element_category WHERE id = '${CATEGORY_ID}'`)[0]
          ?.content_json ?? '',
      ),
    ).toContain('After category prose.');
    expect(
      harness.scalar(
        `SELECT count(*) FROM agent_runtime_write_effect
         WHERE turn_id = '${turnId}' AND phase = 'result_committed'`,
      ),
    ).toBe(3);
    expect(
      harness.scalar(
        `SELECT count(*) FROM agent_runtime_write_review
         WHERE turn_id = '${turnId}' AND status = 'accepted_effect'`,
      ),
    ).toBe(3);
    expect(
      harness.scalar(
        `SELECT count(*) FROM agent_runtime_write_effect
         WHERE turn_id = '${turnId}' AND phase IN ('failed', 'uncertain')`,
      ),
    ).toBe(0);
    harness.driver.assertExhausted();
  });

  it('appends to the requested drift without inheriting a stale chapter focus', async () => {
    const turnId = 'turn-unscoped-drift-append';
    const original = '（以上各片段为随抄群像，归线未定，暂存待用。）';
    const appended = '火盆边的老人抬起眼睛，听见远处传来潮水一样的钟声。';
    harness = await ProductAgentHarness.create([
      {
        name: 'read the requested drift',
        steps: toolCallSteps('read-drift', 'read_file', {
          path: `/drifts/${DRIFT_TITLE}/prose.md`,
        }),
      },
      {
        name: 'append to the requested drift',
        steps: toolCallSteps('edit-drift', 'edit_file', {
          path: `/drifts/${DRIFT_TITLE}/prose.md`,
          replacements: [{ oldText: original, newText: `${original}\n\n${appended}` }],
        }),
      },
      {
        name: 'finish drift append',
        steps: finalSteps('已追加到灵感碎片。'),
      },
    ]);
    const drift: BookNode = {
      id: DRIFT_ID,
      projectId: PROJECT_ID,
      kind: 'drift',
      title: DRIFT_TITLE,
      summary: '',
      bookOrder: null,
      narrativeOrder: null,
      driftGroupId: null,
      writingStatus: 'drifting',
      position: { x: 0, y: 0 },
      wordCount: 0,
      createdAt: INITIAL_REVISION,
      updatedAt: INITIAL_REVISION,
    };
    await harness.nodeRepository.create(drift);
    await harness.contentRepository.create({
      nodeId: DRIFT_ID,
      contentJson: proseJson('drift-opening', original),
    });
    useDataStore.setState((state) => ({ bookNodes: [...state.bookNodes, drift] }));

    await harness.runTurn(turnId, '写一段内容追加在这个灵感后面。', 1, 'auto');

    expect((await harness.contentRepository.findByNodeId(DRIFT_ID))?.contentJson).toContain(appended);
    expect(
      harness.events.filter(
        (event) => event.turnId === turnId && event.event.type === 'tool_result' && !event.event.ok,
      ),
    ).toEqual([]);
    harness.driver.assertExhausted();
  });

  it('resolves material and element-patch relation endpoints through the canonical entity vocabulary', async () => {
    harness = await ProductAgentHarness.create([]);
    const request: AgentToolExecutionRequest = {
      sessionId: SESSION_ID,
      turnId: 'turn-relation-endpoints',
      callId: 'add-material-patch-relation',
      idempotencyKey: `${SESSION_ID}:turn-relation-endpoints:add-material-patch-relation`,
      name: 'add_relation',
      arguments: {
        fromKind: 'material',
        from: 'Fixture source',
        toKind: 'element_patch',
        to: 'Fixture evolution',
        kind: 'evidence_for',
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
    const strategy = getDriftingWriteStrategy('add_relation', {
      freshness: harness.composition.repositories.freshness,
      elementPatchDb: harness.database,
    });
    if (!strategy) throw new Error('Missing structural relation strategy');

    const prepared = await strategy.prepare(
      request,
      { projectId: PROJECT_ID, write: {} as AgentWriteApi },
      {
        id: 'relation-endpoint-expectation',
        effectId: `agent-write:${request.idempotencyKey}`,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        writeTurnId: request.turnId,
        writeToolCallId: 'tool-call-relation-endpoints',
        observationId: 'project-observation',
        readReceiptId: 'project-read-receipt',
        readTurnId: request.turnId,
        readToolCallId: 'project-read-call',
        entityKind: 'project',
        entityId: PROJECT_ID,
        expectedRevision: INITIAL_REVISION,
        expectedStateVector: null,
        expectedStateHash: null,
        createdAt: INITIAL_REVISION,
      },
    );

    expect(prepared.forward).toMatchObject({
      toolName: 'add_relation',
      mutation: {
        kind: 'add_relation',
        value: {
          fromKind: 'library_item',
          fromId: LIBRARY_ITEM_ID,
          toKind: 'patch',
          toId: PATCH_ID,
          kind: 'evidence_for',
        },
      },
    });
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
            (message) => message.type === 'context_note' && message.noteKind === 'task_plan',
          );
          const constraints = request.context.messages.find(
            (message) => message.type === 'context_note' && message.noteKind === 'task_constraints',
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
    const persisted = await harness.composition.repositories.longTasks.getOpenPlan({
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
      expect.arrayContaining(['read_task_plan', 'update_task_plan', dynamic.providerNames[0]]),
    );

    await harness.runTurn('turn-plan-resume', 'Continue the same whole-book task.', 2);
    harness.driver.assertExhausted();
  });
});
