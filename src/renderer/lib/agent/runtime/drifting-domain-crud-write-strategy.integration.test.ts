import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import migrationJournal from '../../../../../drizzle/meta/_journal.json';

import type { DbClient } from '../../../lib/db';
import { createDatabaseClient } from '../../../lib/db';
import type { CommentAction } from '../../../domain/comment';
import { countWords } from '../../word-count';
import {
  AgentConversationTable,
  BookNodeTable,
  CommentActionTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
} from '../../../schema/drizzle';
import { createAgentMemoryRepository } from '../../../sqlite-repo/agent-memory-repo';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createYjsRepository } from '../../../sqlite-repo/yjs-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useSettingsStore } from '../../../store/settings-store';
import { proseDocId } from '../../yjs-doc-id';
import { setAgentEditModeOverride } from '../agent-edit-mode';
import type { AgentToolContext } from '../tool-handlers';
import { ProductFileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import {
  createDriftingAgentProductComposition,
  type DriftingAgentProductComposition,
} from './drifting-product-composition';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import type {
  DriftingDomainReadToolName,
  DriftingDomainWriteToolName,
} from './drifting-workspace-tool-contract';
import { createYjsProseSeedState } from './yjs-prose-command';
import type {
  AgentModelDriver,
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
} from './types';

const databaseSlot = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/db')>();
  return {
    ...actual,
    getDb: () => {
      if (!databaseSlot.current) throw new Error('Domain CRUD test database is not installed');
      return databaseSlot.current as ReturnType<typeof actual.getDb>;
    },
  };
});

const PROJECT_ID = 'domain-crud-project';
const USER_ID = 'domain-crud-user';
const CONVERSATION_ID = 'domain-crud-conversation';
const SESSION_ID = 'domain-crud-session';
const MAIN_STORYLINE_ID = 'storyline-main';
const SECONDARY_STORYLINE_ID = 'storyline-secondary';
const CHAPTER_ONE_ID = 'chapter-one';
const CHAPTER_TWO_ID = 'chapter-two';
const AT = '2026-08-02T00:00:00.000Z';
const LATEST_MIGRATION_TIMESTAMP =
  migrationJournal.entries[migrationJournal.entries.length - 1]?.when;

const initialDataState = useDataStore.getState();
const initialProjectState = useProjectStore.getState();
const initialAgentEditMode = useSettingsStore.getState().agentEditMode;

const unusedDriver: AgentModelDriver = {
  id: 'domain-crud-unused-driver',
  stream() {
    throw new Error('Domain CRUD integration invokes the tool runtime directly');
  },
};

describe('workspace domain CRUD transactions', () => {
  let fixture: DomainCrudFixture;

  beforeEach(async () => {
    setAgentEditModeOverride(null);
    useSettingsStore.getState().setAgentEditMode(initialAgentEditMode);
    useAgentEditStore.getState().clearAll();
    fixture = await DomainCrudFixture.create();
  });

  afterEach(async () => {
    setAgentEditModeOverride(null);
    useSettingsStore.getState().setAgentEditMode(initialAgentEditMode);
    useAgentEditStore.getState().clearAll();
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    await fixture.close();
  });

  it('materializes the prose word count when a new chapter or drift is created', async () => {
    const prose = '# 灰港\n\n潮声越过旧码头。The tide turns twice.';
    // The leading H1 repeats the semantic object title and is normalized out
    // before Yjs becomes canonical, so the persisted count is body-only.
    const persistedProse = '潮声越过旧码头。The tide turns twice.';
    const created = await fixture.write('node-create-with-prose', 'create_inspiration', {
      title: '灰港',
      body: prose,
    });

    expect(created).toMatchObject({
      ok: true,
      data: {
        result: {
          path: '/drifts/灰港/prose.md',
          operation: 'created',
          wordCount: countWords(persistedProse),
        },
      },
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.modelData).toContain(`当前 ${countWords(persistedProse)} 字`);
    expect(
      fixture.scalar(
        "SELECT word_count FROM book_node WHERE title = '灰港' AND deleted_at IS NULL",
      ),
    ).toBe(countWords(persistedProse));
    expect(
      fixture.text(
        "SELECT word_count_basis_kind FROM book_node WHERE title = '灰港' AND deleted_at IS NULL",
      ),
    ).toBe('seed');
    expect(
      fixture.text(
        "SELECT word_count_basis_hash FROM book_node WHERE title = '灰港' AND deleted_at IS NULL",
      ),
    ).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(
      JSON.parse(
        fixture.text(
          "SELECT payload_json FROM local_sync_mutation WHERE entity_type = 'node' AND mutation_type = 'create' AND entity_id = (SELECT id FROM book_node WHERE title = '灰港' AND deleted_at IS NULL)",
        ),
      ),
    ).toMatchObject({
      title: '灰港',
      kind: 'drift',
      mainStorylineId: null,
    });
  });

  it('rejects a second Agent create with an existing node title instead of suffixing it', async () => {
    const before = fixture.scalar(
      `SELECT count(*) FROM book_node WHERE project_id = '${PROJECT_ID}' AND deleted_at IS NULL`,
    );

    await expect(
      fixture.write('duplicate-chapter-title', 'create_chapter', {
        title: 'Chapter One',
        body: 'This retry must not become Chapter One 2.',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('already exists'),
    });
    expect(
      fixture.scalar(
        `SELECT count(*) FROM book_node WHERE project_id = '${PROJECT_ID}' AND deleted_at IS NULL`,
      ),
    ).toBe(before);
    expect(
      fixture.scalar(
        `SELECT count(*) FROM book_node WHERE project_id = '${PROJECT_ID}' AND title = 'Chapter One 2' AND deleted_at IS NULL`,
      ),
    ).toBe(0);
  });

  it('rejects a relation whose two endpoints are the same authored object', async () => {
    await expect(
      fixture.write('self-relation', 'create_relation', {
        fromType: 'chapter',
        fromName: 'Chapter One',
        toType: 'chapter',
        toName: 'Chapter One',
        relationType: 'self',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('two different authored objects'),
    });
    expect(fixture.scalar('SELECT count(*) FROM entity_relation')).toBe(0);
  });

  it('keeps every textual block of a newly created object pending in approve mode', async () => {
    const callId = 'reviewed-created-drift';
    const effectId = `agent-write:${SESSION_ID}:turn:${callId}:${callId}`;
    const reviewId = `agent-review:${effectId}`;
    const body = '# 待审标题\n\n第一段。\n\n第二段。';
    useSettingsStore.getState().setAgentEditMode('approve');

    const created = await fixture.write(callId, 'create_inspiration', {
      title: '待审潮痕',
      body,
    });

    expect(created).toMatchObject({
      ok: true,
      data: {
        result: { operation: 'created' },
        review: { id: reviewId, status: 'pending' },
      },
    });
    const blocks = await fixture.composition.repositories.writeEffects.listReviewBlocks(
      reviewId,
    );
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.ordinal)).toEqual([0, 1, 2]);

    const editorState = useAgentEditStore.getState();
    const reviewBatch = editorState.reviewBatches[reviewId];
    expect(reviewBatch).toMatchObject({
      effectId,
      reviewId,
      entityType: 'node',
    });
    expect(
      reviewBatch?.changes.map((change) => ({
        op: change.op,
        newText: change.newText,
        mode: change.mode,
        reviewId: change.reviewId,
      })),
    ).toEqual([
      { op: 'new', newText: '待审标题', mode: 'approve', reviewId },
      { op: 'new', newText: '第一段。', mode: 'approve', reviewId },
      { op: 'new', newText: '第二段。', mode: 'approve', reviewId },
    ]);

    const node = useDataStore
      .getState()
      .bookNodes.find((candidate) => candidate.title === '待审潮痕');
    if (!node || !reviewBatch) throw new Error('The reviewed created drift is missing');
    const contentRepository = createBookContentRepository(fixture.database);
    const nodeRepository = createBookNodeSqliteRepository(PROJECT_ID, fixture.database);
    const initialContent = await contentRepository.findByNodeId(node.id);
    if (!initialContent) throw new Error('The reviewed created prose is missing');
    await createYjsRepository(fixture.database).upsertSnapshot(
      proseDocId('node', node.id),
      await createYjsProseSeedState(initialContent.contentJson),
      { advanceRevision: false },
    );
    fixture.context.write = {
      updateContentByNodeId: async (
        id: string,
        updates: { contentJson?: string },
      ) => contentRepository.updateByNodeId(id, updates),
      updateNode: async (id: string, updates: { wordCount?: number }) => {
        const updated = await nodeRepository.update(id, {
          ...updates,
          updatedAt: '2026-08-02T00:10:00.000Z',
        });
        if (!updated) throw new Error('The reviewed node projection could not be updated');
        useDataStore.setState((state) => ({
          bookNodes: state.bookNodes.map((candidate) =>
            candidate.id === id ? updated : candidate,
          ),
        }));
        return updated;
      },
    } as unknown as AgentToolContext['write'];

    const rejectedChange = reviewBatch.changes.find(
      (change) => change.newText === '第二段。',
    );
    if (!rejectedChange) throw new Error('The rejectable created block is missing');
    await expect(
      fixture.composition.tools.rejectReviewBlock(
        reviewId,
        rejectedChange.blockId,
        'Reject one block from newly created prose',
      ),
    ).resolves.toMatchObject({
      review: { status: 'pending' },
      block: { status: 'reverted' },
    });
    for (const change of reviewBatch.changes) {
      if (change.blockId === rejectedChange.blockId) continue;
      await fixture.composition.tools.acceptReviewBlock(
        reviewId,
        change.blockId,
        'Accept remaining newly created prose',
      );
    }

    expect(
      await fixture.composition.repositories.writeEffects.getReview(reviewId),
    ).toMatchObject({ status: 'accepted_effect' });
    const settledContent = await contentRepository.findByNodeId(node.id);
    expect(settledContent?.contentJson).toContain('第一段。');
    expect(settledContent?.contentJson).not.toContain('第二段。');
    expect(await nodeRepository.findById(node.id)).not.toBeNull();
  });

  it('uses the schema-safe Markdown adapter for every newly created authored prose object', async () => {
    const body = '## 初始档案\n\n这是**粗体**与<u>下划线</u>。\n\n> 引用';
    useSettingsStore.getState().setAgentEditMode('approve');

    const creations = [
      ['formatted-category-create', 'create_element_category', { name: '信件', body }],
      [
        'formatted-element-create',
        'create_element',
        { category: '信件', name: '远方来函', body },
      ],
      ['formatted-storyline-create', 'create_storyline', { name: '格式故事线', body }],
      ['formatted-drift-create', 'create_inspiration', { title: '格式灵感', body }],
      ['formatted-chapter-create', 'create_chapter', { title: '格式章节', body }],
    ] as const;

    for (const [callId, toolName, args] of creations) {
      const result = await fixture.write(callId, toolName, args);
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        data: { review: { status: 'pending' } },
      });
      if (!result.ok) throw new Error(result.error);
      const reviewId = (result.data as { review?: { id?: unknown } }).review?.id;
      if (typeof reviewId !== 'string') {
        throw new Error(`The ${callId} create did not expose its durable review`);
      }
      const blocks = await fixture.composition.repositories.writeEffects.listReviewBlocks(
        reviewId,
      );
      expect(blocks.map((block) => block.ordinal)).toEqual([0, 1, 2]);
    }

    const createdBodies = [
      fixture.text(
        "SELECT content_json FROM element_category WHERE name = '信件' AND deleted_at IS NULL",
      ),
      fixture.text(
        "SELECT content_json FROM element WHERE name = '远方来函' AND deleted_at IS NULL",
      ),
      fixture.text(
        "SELECT content_json FROM storylines WHERE name = '格式故事线' AND deleted_at IS NULL",
      ),
      fixture.text(
        "SELECT nc.content_json FROM node_content nc JOIN book_node n ON n.id = nc.node_id WHERE n.title = '格式灵感' AND n.deleted_at IS NULL",
      ),
      fixture.text(
        "SELECT nc.content_json FROM node_content nc JOIN book_node n ON n.id = nc.node_id WHERE n.title = '格式章节' AND n.deleted_at IS NULL",
      ),
    ];

    for (const contentJson of createdBodies) {
      expect(JSON.parse(contentJson)).toMatchObject({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { id: expect.any(String), level: 2 },
            content: [{ type: 'text', text: '初始档案' }],
          },
          {
            type: 'paragraph',
            attrs: { id: expect.any(String) },
            content: expect.arrayContaining([
              {
                type: 'text',
                text: '粗体',
                marks: [{ type: 'bold', attrs: {} }],
              },
              {
                type: 'text',
                text: '下划线',
                marks: [{ type: 'underline', attrs: {} }],
              },
            ]),
          },
          { type: 'blockquote', attrs: { id: expect.any(String) } },
        ],
      });
    }
  });

  it('keeps entity receipts owned by the public domain tool', async () => {
    const result = await fixture.write('authored-project-facts', 'update_project_facts', {
      facts: [{ key: '气候', value: '终年多雨' }],
    });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fixture.text(`SELECT kv_json FROM project WHERE id = '${PROJECT_ID}'`)).toContain(
      '终年多雨',
    );
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE tool_name = 'update_project_facts'",
      ),
    ).toBe(1);
  });

  it('places a newly created numbered chapter into an available reading-order gap', async () => {
    fixture.gateway.database.exec(`
      UPDATE book_node
      SET book_order = CASE title
        WHEN 'Chapter One' THEN 6
        WHEN 'Chapter Two' THEN 11
        ELSE book_order
      END,
      title = CASE title
        WHEN 'Chapter One' THEN '01'
        WHEN 'Chapter Two' THEN '03'
        ELSE title
      END
      WHERE project_id = '${PROJECT_ID}'
    `);
    useDataStore.setState((state) => ({
      bookNodes: state.bookNodes.map((node) =>
        node.id === CHAPTER_ONE_ID && node.kind === 'chapter'
          ? { ...node, title: '01', bookOrder: 6 }
          : node.id === CHAPTER_TWO_ID && node.kind === 'chapter'
            ? { ...node, title: '03', bookOrder: 11 }
            : node,
      ),
    }));

    const created = await fixture.write('create-missing-chapter-02', 'create_chapter', {
      title: '02',
      body: '二章补齐。',
      summary: '奥伦与凯尔在茶镇遭遇异变。',
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });

    expect(
      fixture.scalar(
        "SELECT book_order FROM book_node WHERE title = '02' AND deleted_at IS NULL",
      ),
    ).toBe(8);
    expect(
      fixture.text(
        "SELECT summary FROM book_node WHERE title = '02' AND deleted_at IS NULL",
      ),
    ).toBe('奥伦与凯尔在茶镇遭遇异变。');
  });

  it('normalizes a unique contained category and seeds a separate summary from initial body', async () => {
    await fixture.write('create-organization-category', 'create_element_category', {
      name: '势力与组织',
      body: '组织与势力。',
    });

    const created = await fixture.write('create-organization-with-summary', 'create_element', {
      category: '势力',
      name: '灰潮档案局',
      body: '## 摘要\n\n负责灰港旧档。\n\n## 详细资料\n\n保管船籍与潮汐记录。',
    });

    expect(created).toMatchObject({
      ok: true,
      data: {
        result: {
          path: '/elements/势力与组织/灰潮档案局/body.md',
          requestedPath: '/elements/势力/灰潮档案局/body.md',
          canonicalPath: '/elements/势力与组织/灰潮档案局/body.md',
          operation: 'created',
          summaryInitialized: true,
        },
      },
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.modelData).toContain('要素「灰潮档案局」设定已创建');
    expect(created.modelData).toContain('摘要已同时建立');
    const category = useDataStore
      .getState()
      .bookElementCategories.find((item) => item.name === '势力与组织');
    expect(category).toBeDefined();
    expect(useDataStore.getState().bookElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '灰潮档案局',
          categoryId: category?.id,
          summary: '负责灰港旧档。',
        }),
      ]),
    );
  });

  it('atomically replaces the complete storyline graph and restores the exact preimage', async () => {
    const write = await fixture.write(
      'membership-forward',
      'replace_storyline_chapters',
      {
        storyline: 'Main',
        chapters: ['Chapter One', 'Chapter Two'],
      },
      'author_approved',
    );
    expect(write).toMatchObject({
      ok: true,
      data: {
        result: {
          path: '/storylines/Main/chapters.json',
          operation: 'updated',
        },
      },
    });
    expect(fixture.memberships()).toEqual([
      { node_id: CHAPTER_ONE_ID, storyline_id: MAIN_STORYLINE_ID, is_primary: 1 },
      { node_id: CHAPTER_TWO_ID, storyline_id: MAIN_STORYLINE_ID, is_primary: 0 },
      { node_id: CHAPTER_TWO_ID, storyline_id: SECONDARY_STORYLINE_ID, is_primary: 1 },
    ]);
    expect(useDataStore.getState().primaryStorylineByNode).toMatchObject({
      [CHAPTER_ONE_ID]: MAIN_STORYLINE_ID,
      [CHAPTER_TWO_ID]: SECONDARY_STORYLINE_ID,
    });
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE entity_kind = 'storyline_membership' AND direction = 'forward'",
      ),
    ).toBe(1);

    await fixture.revert('membership-forward');
    expect(fixture.memberships()).toEqual([
      { node_id: CHAPTER_ONE_ID, storyline_id: MAIN_STORYLINE_ID, is_primary: 1 },
      { node_id: CHAPTER_TWO_ID, storyline_id: SECONDARY_STORYLINE_ID, is_primary: 1 },
    ]);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE entity_kind = 'storyline_membership' AND direction = 'inverse'",
      ),
    ).toBe(1);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM local_sync_mutation WHERE entity_type = 'nodeStorylineLink'",
      ),
    ).toBe(2);
  });

  it('rolls back every graph row and outbox mutation when a transaction write fails', async () => {
    fixture.gateway.failNextExecute(
      (sql) => sql.includes('insert into "node_storyline_link"'),
      'injected membership insert failure',
    );
    const result = await fixture.write(
      'membership-fault',
      'replace_storyline_chapters',
      {
        storyline: 'Main',
        chapters: ['Chapter One', 'Chapter Two'],
      },
      'author_approved',
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('insert into "node_storyline_link"'),
    });
    expect(fixture.memberships()).toEqual([
      { node_id: CHAPTER_ONE_ID, storyline_id: MAIN_STORYLINE_ID, is_primary: 1 },
      { node_id: CHAPTER_TWO_ID, storyline_id: SECONDARY_STORYLINE_ID, is_primary: 1 },
    ]);
    expect(fixture.scalar('SELECT count(*) FROM local_sync_mutation')).toBe(0);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_entity_write_receipt')).toBe(0);
  });

  it('creates, addresses, updates, soft-deletes, and exactly reverts pending Agent memory', async () => {
    const created = await fixture.write('memory-create', 'create_author_rule', {
      kind: 'preference',
      body: 'Keep dialogue terse.',
    });
    expect(created).toMatchObject({
      ok: true,
      data: {
        result: {
          operation: 'created',
          canonicalPath: expect.stringMatching(/^\/memory\/.+\.json$/u),
        },
      },
    });
    const createdData = (created as { data: { result: { canonicalPath: string } } }).data.result;
    const canonicalPath = createdData.canonicalPath;
    const memoryId = canonicalPath.slice('/memory/'.length, -'.json'.length);
    expect(await fixture.memory(memoryId)).toMatchObject({
      body: 'Keep dialogue terse.',
      status: 'pending',
      source: 'agent',
    });

    const directory = await fixture.read('memory-list', 'list_author_rules', {});
    expect(directory).toMatchObject({
      ok: true,
      data: {
        files: [
          expect.objectContaining({
            path: canonicalPath,
            writable: true,
          }),
        ],
      },
    });
    await expect(
      fixture.write('memory-update', 'update_author_rule', {
        ruleId: memoryId,
        body: 'Keep dialogue terse and character-specific.',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect((await fixture.memory(memoryId))?.body).toBe(
      'Keep dialogue terse and character-specific.',
    );

    await fixture.revert('memory-update');
    expect((await fixture.memory(memoryId))?.body).toBe('Keep dialogue terse.');

    await expect(
      fixture.write('memory-delete', 'delete_author_rule', { ruleId: memoryId }, 'author_approved'),
    ).resolves.toMatchObject({ ok: true });
    expect((await fixture.memory(memoryId))?.deletedAt).not.toBeNull();

    await fixture.revert('memory-delete');
    expect(await fixture.memory(memoryId)).toMatchObject({
      body: 'Keep dialogue terse.',
      deletedAt: null,
    });

    await expect(fixture.revert('memory-create')).rejects.toThrow(
      'The authored domain state changed; exact reject is unavailable',
    );
    expect(await fixture.memory(memoryId)).not.toBeNull();

    const disposable = await fixture.write('memory-create-disposable', 'create_author_rule', {
      kind: 'directive',
      body: 'Temporary guidance.',
    });
    const disposablePath = (disposable as { data: { result: { canonicalPath: string } } }).data
      .result.canonicalPath;
    const disposableId = disposablePath.slice('/memory/'.length, -'.json'.length);
    await fixture.revert('memory-create-disposable');
    expect(await fixture.memory(disposableId)).toBeNull();
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE entity_kind = 'memory'",
      ),
    ).toBe(7);
    // The sync service intentionally coalesces repeated mutations for the same
    // entity while the local immutable Agent receipt ledger keeps every step.
    expect(
      fixture.scalar("SELECT count(*) FROM local_sync_mutation WHERE entity_type = 'agentMemory'"),
    ).toBe(1);
  });

  it('reconciles a lost outer acknowledgement once and survives a file reopen', async () => {
    fixture.gateway.failNextExecute(
      (sql, parameters) =>
        sql.includes('update "agent_runtime_write_effect"') &&
        parameters.includes('effect_committed'),
      'lost outer effect acknowledgement',
    );
    const arguments_ = {
      kind: 'directive',
      body: 'Preserve the unresolved ending.',
    };
    const interrupted = await fixture.write('memory-reconcile', 'create_author_rule', arguments_);
    expect(interrupted).toMatchObject({ ok: false });
    expect(fixture.scalar('SELECT count(*) FROM agent_memory')).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_entity_write_receipt')).toBe(1);

    const recovered = await fixture.replayWrite(
      'memory-reconcile',
      'create_author_rule',
      arguments_,
    );
    expect(recovered).toMatchObject({
      ok: true,
      data: {
        result: {
          operation: 'created',
          canonicalPath: expect.stringMatching(/^\/memory\/.+\.json$/u),
        },
      },
    });
    expect(fixture.scalar('SELECT count(*) FROM agent_memory')).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_entity_write_receipt')).toBe(1);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'result_committed'",
      ),
    ).toBe(1);

    await expect(fixture.restartEvidence()).resolves.toEqual({
      memories: 1,
      receipts: 1,
      committedEffects: 1,
      latestMigration: LATEST_MIGRATION_TIMESTAMP,
    });
  });

  it('keeps approved guidance read-only and allows a separate pending proposal', async () => {
    const created = await fixture.write('memory-approved-create', 'create_author_rule', {
      kind: 'preference',
      body: 'Use restrained imagery.',
    });
    const canonicalPath = (created as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    const memoryId = canonicalPath.slice('/memory/'.length, -'.json'.length);
    await createAgentMemoryRepository(PROJECT_ID, fixture.database).update(memoryId, {
      status: 'active',
      updatedAt: '2026-08-02T00:10:00.000Z',
    });

    const directory = await fixture.read('memory-approved-list', 'list_author_rules', {});
    expect(directory).toMatchObject({
      ok: true,
      data: {
        files: [expect.objectContaining({ path: canonicalPath, writable: false })],
      },
    });
    await expect(
      fixture.write('memory-approved-overwrite', 'update_author_rule', {
        ruleId: memoryId,
        kind: 'preference',
        body: 'Overwrite approved guidance.',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Only a pending Agent proposal can be edited in place'),
    });

    const proposal = await fixture.write('memory-supersede', 'create_author_rule', {
      kind: 'preference',
      body: 'Use restrained imagery except in dream sequences.',
    });
    const proposalPath = (proposal as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    const proposalId = proposalPath.slice('/memory/'.length, -'.json'.length);
    expect(await fixture.memory(proposalId)).toMatchObject({
      status: 'pending',
      source: 'agent',
    });
    expect(await fixture.memory(memoryId)).toMatchObject({
      status: 'active',
      deletedAt: null,
    });
  });

  it('creates and exactly removes every structural resource class', async () => {
    await expect(
      fixture.write('create-category-disposable', 'create_element_category', {
        name: 'Disposable',
        body: 'Disposable category body.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.write('create-element-disposable', 'create_element', {
        category: 'Disposable',
        name: 'Temporary Person',
        body: 'Disposable element body.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.write('create-storyline-disposable', 'create_storyline', {
        name: 'Disposable Arc',
        body: 'Disposable storyline body.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.write('create-node-disposable', 'create_inspiration', {
        title: 'Disposable Idea',
        body: 'Disposable drift body.',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(useDataStore.getState().bookElementCategories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Disposable' })]),
    );
    expect(useDataStore.getState().bookElements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Temporary Person' })]),
    );
    expect(useDataStore.getState().storylines).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Disposable Arc' })]),
    );
    expect(useDataStore.getState().bookNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Disposable Idea' })]),
    );

    await fixture.revert('create-element-disposable');
    await fixture.revert('create-category-disposable');
    await fixture.revert('create-node-disposable');
    await fixture.revert('create-storyline-disposable');
    expect(useDataStore.getState().bookElementCategories).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Disposable' })]),
    );
    expect(useDataStore.getState().bookElements).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Temporary Person' })]),
    );
    expect(useDataStore.getState().storylines).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Disposable Arc' })]),
    );
    expect(useDataStore.getState().bookNodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Disposable Idea' })]),
    );
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE direction = 'forward'",
      ),
    ).toBe(4);
    expect(
      fixture.scalar(
        "SELECT count(*) FROM agent_runtime_entity_write_receipt WHERE direction = 'inverse'",
      ),
    ).toBe(4);
  });

  it('updates, guards field deletion, and restores structural resource deletes', async () => {
    await fixture.write('create-category-lifecycle', 'create_element_category', {
      name: 'People',
      body: 'People category body.',
    });
    await fixture.write('create-element-lifecycle', 'create_element', {
      category: 'People',
      name: 'Ada',
      body: 'Ada body.',
    });
    await fixture.write('create-storyline-lifecycle', 'create_storyline', {
      name: 'Side Arc',
      body: 'Side arc body.',
    });
    await fixture.write('create-node-lifecycle', 'create_inspiration', {
      title: 'Idea',
      body: 'Idea body.',
    });

    await expect(
      fixture.write('update-category-lifecycle', 'update_element_category', {
        category: 'People',
        name: 'Cast',
        templateFacts: [{ key: 'Role', value: 'Unknown' }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(useDataStore.getState().bookElementCategories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Cast' })]),
    );
    await fixture.revert('update-category-lifecycle');
    expect(useDataStore.getState().bookElementCategories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'People' })]),
    );

    await expect(
      fixture.write('update-element-lifecycle', 'update_element', {
        element: 'Ada',
        summary: 'A precise investigator.',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(useDataStore.getState().bookElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Ada', summary: 'A precise investigator.' }),
      ]),
    );
    await fixture.revert('update-element-lifecycle');
    expect(useDataStore.getState().bookElements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Ada', summary: '' })]),
    );

    await expect(
      fixture.write('update-storyline-lifecycle', 'update_storyline', {
        storyline: 'Side Arc',
        summary: 'A secondary investigation.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await fixture.revert('update-storyline-lifecycle');
    expect(useDataStore.getState().storylines).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Side Arc', summary: '' })]),
    );

    await fixture.write(
      'delete-element-lifecycle',
      'delete_element',
      { element: 'Ada' },
      'author_approved',
    );
    expect(useDataStore.getState().bookElements).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Ada' })]),
    );
    await fixture.revert('delete-element-lifecycle');
    expect(useDataStore.getState().bookElements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Ada' })]),
    );

    await fixture.write(
      'delete-node-lifecycle',
      'delete_inspiration',
      { inspiration: 'Idea' },
      'author_approved',
    );
    await fixture.revert('delete-node-lifecycle');
    expect(useDataStore.getState().bookNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Idea' })]),
    );

    await fixture.write(
      'delete-storyline-lifecycle',
      'delete_storyline',
      { storyline: 'Side Arc' },
      'author_approved',
    );
    await fixture.revert('delete-storyline-lifecycle');
    expect(useDataStore.getState().storylines).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Side Arc' })]),
    );

    await fixture.write(
      'delete-element-before-category',
      'delete_element',
      { element: 'Ada' },
      'author_approved',
    );
    await fixture.write(
      'delete-category-lifecycle',
      'delete_element_category',
      { category: 'People' },
      'author_approved',
    );
    await fixture.revert('delete-category-lifecycle');
    expect(useDataStore.getState().bookElementCategories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'People' })]),
    );
  });

  it('provides natural JSON CRUD and guarded inverses for TODOs and relations', async () => {
    const disposableComment = await fixture.write('comment-create-disposable', 'create_comment', {
      kind: 'todo',
      body: 'Disposable TODO.',
      targetType: 'chapter',
      targetName: 'Chapter One',
    });
    expect(disposableComment).toMatchObject({
      ok: true,
      data: {
        result: {
          path: expect.stringMatching(/^\/comments\/.+\.json$/u),
          requestedPath: expect.stringMatching(/^\/comments\/new-.+\.json$/u),
          canonicalPath: expect.stringMatching(/^\/comments\/.+\.json$/u),
        },
      },
    });
    await fixture.revert('comment-create-disposable');
    expect(useDataStore.getState().comments).toHaveLength(0);

    const comment = await fixture.write('comment-create-lifecycle', 'create_comment', {
      kind: 'todo',
      body: 'Check the clue.',
      targetType: 'chapter',
      targetName: 'Chapter One',
    });
    const commentPath = (comment as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    await expect(
      fixture.write('comment-body-lifecycle', 'update_comment', {
        commentId: commentPath.slice('/comments/'.length, -'.json'.length),
        body: 'Check the clue in Chapter One.',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(useDataStore.getState().comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: CHAPTER_ONE_ID,
          bodyJson: expect.stringContaining('Check the clue in Chapter One.'),
        }),
      ]),
    );
    await fixture.revert('comment-body-lifecycle');
    expect(useDataStore.getState().comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: CHAPTER_ONE_ID,
          bodyJson: expect.stringContaining('Check the clue.'),
        }),
      ]),
    );
    await expect(
      fixture.write('comment-update-lifecycle', 'update_comment', {
        commentId: commentPath.slice('/comments/'.length, -'.json'.length),
        kind: 'note',
        status: 'resolved',
        body: 'The clue is consistent.',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(useDataStore.getState().comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'note', status: 'resolved' })]),
    );
    await fixture.revert('comment-update-lifecycle');
    expect(useDataStore.getState().comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'todo', status: 'open' })]),
    );
    const commentId = commentPath.slice('/comments/'.length, -'.json'.length);
    const action: CommentAction = {
      id: 'comment-action-history',
      projectId: PROJECT_ID,
      commentId,
      kind: 'accept_suggestion',
      label: 'Accepted earlier suggestion',
      payloadJson: '{}',
      status: 'applied',
      resultJson: '{"ok":true}',
      createdByKind: 'user',
      createdById: USER_ID,
      createdAt: AT,
      updatedAt: AT,
      appliedAt: AT,
    };
    await fixture.database.insert(CommentActionTable).values(action);
    useDataStore.getState().addCommentAction(action);
    await fixture.write(
      'comment-delete-lifecycle',
      'delete_comment',
      { commentId },
      'author_approved',
    );
    expect(useDataStore.getState().comments).toHaveLength(0);
    expect(useDataStore.getState().commentActions).toHaveLength(0);
    expect(fixture.scalar('SELECT count(*) FROM comment_action')).toBe(0);
    await fixture.revert('comment-delete-lifecycle');
    expect(useDataStore.getState().comments).toHaveLength(1);
    expect(useDataStore.getState().commentActions).toEqual([action]);
    expect(fixture.scalar('SELECT count(*) FROM comment_action')).toBe(1);

    for (const name of ['foreshadows', 'contrasts']) {
      const createdType = await fixture.write(`relation-type-create-${name}`, 'create_relation_type', {
        name,
        description: '',
        orientation: 'directed',
        sourceRole: 'chapter',
        targetRole: 'storyline',
        sourceKinds: ['chapter'],
        targetKinds: ['storyline'],
      });
      expect(createdType, JSON.stringify(createdType)).toMatchObject({ ok: true });
    }

    const relationPayload = {
      fromType: 'chapter',
      fromName: 'Chapter One',
      toType: 'storyline',
      toName: 'Main',
      relationType: 'foreshadows',
    };
    const disposableRelation = await fixture.write(
      'relation-create-disposable',
      'create_relation',
      relationPayload,
    );
    expect(disposableRelation).toMatchObject({
      ok: true,
      data: {
        result: {
          path: expect.stringMatching(/^\/relations\/.+\.json$/u),
          requestedPath: expect.stringMatching(/^\/relations\/new-.+\.json$/u),
          canonicalPath: expect.stringMatching(/^\/relations\/.+\.json$/u),
        },
      },
    });
    await fixture.revert('relation-create-disposable');
    expect(useDataStore.getState().entityRelations).toHaveLength(0);

    const relation = await fixture.write(
      'relation-create-lifecycle',
      'create_relation',
      relationPayload,
    );
    const relationPath = (relation as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    await fixture.write(
      'relation-update-lifecycle',
      'update_relation',
      {
        relationId: relationPath.slice('/relations/'.length, -'.json'.length),
        relationType: 'contrasts',
      },
    );
    expect(useDataStore.getState().entityRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: CHAPTER_ONE_ID,
          toId: MAIN_STORYLINE_ID,
          kind: 'contrasts',
        }),
      ]),
    );
    await fixture.revert('relation-update-lifecycle');
    expect(useDataStore.getState().entityRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromId: CHAPTER_ONE_ID,
          toId: MAIN_STORYLINE_ID,
          kind: 'foreshadows',
        }),
      ]),
    );
    await fixture.write(
      'relation-delete-lifecycle',
      'delete_relation',
      { relationId: relationPath.slice('/relations/'.length, -'.json'.length) },
      'author_approved',
    );
    expect(useDataStore.getState().entityRelations).toHaveLength(0);
    await fixture.revert('relation-delete-lifecycle');
    expect(useDataStore.getState().entityRelations).toHaveLength(1);

    const typeUpdate = await fixture.write(
      'relation-type-update-lifecycle',
      'update_relation_type',
      {
        relationType: 'foreshadows',
        name: 'sets-up',
        description: 'A setup that resolves on a storyline.',
        orientation: 'directed',
        sourceRole: 'setup',
        targetRole: 'payoff',
        sourceKinds: ['chapter'],
        targetKinds: ['storyline'],
      },
    );
    expect(typeUpdate).toMatchObject({ ok: true });
    expect(useDataStore.getState().entityRelationTypes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'sets-up' })]),
    );
    expect(useDataStore.getState().entityRelations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'sets-up' })]),
    );
    await fixture.revert('relation-type-update-lifecycle');
    expect(useDataStore.getState().entityRelations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'foreshadows' })]),
    );

    await expect(
      fixture.write(
        'relation-type-delete-used',
        'delete_relation_type',
        { relationType: 'foreshadows' },
        'author_approved',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('used by 1 relations'),
    });

    await fixture.write(
      'relation-type-delete-unused',
      'delete_relation_type',
      { relationType: 'contrasts' },
      'author_approved',
    );
    expect(useDataStore.getState().entityRelationTypes.some((type) => type.name === 'contrasts')).toBe(false);
    await fixture.revert('relation-type-delete-unused');
    expect(useDataStore.getState().entityRelationTypes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'contrasts' })]),
    );
  });

  it('names every blocking workspace resource when an entity delete is unsafe', async () => {
    const blockerType = await fixture.write('delete-blocker-relation-type-create', 'create_relation_type', {
      name: 'belongs-to',
      description: '',
      orientation: 'directed',
      sourceRole: 'chapter',
      targetRole: 'storyline',
      sourceKinds: ['chapter'],
      targetKinds: ['storyline'],
    });
    expect(blockerType, JSON.stringify(blockerType)).toMatchObject({ ok: true });
    const relation = await fixture.write(
      'delete-blocker-relation-create',
      'create_relation',
      {
        fromType: 'chapter',
        fromName: 'Chapter One',
        toType: 'storyline',
        toName: 'Main',
        relationType: 'belongs-to',
      },
    );
    const relationPath = (relation as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    const relationId = relationPath.slice('/relations/'.length, -'.json'.length);
    await expect(
      fixture.write(
        'delete-blocked-by-relation',
        'delete_chapter',
        { chapter: 'Chapter One' },
        'author_approved',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(`实体关系「${relationId}」`),
    });
    await fixture.write(
      'delete-blocker-relation-remove',
      'delete_relation',
      { relationId },
      'author_approved',
    );

    const comment = await fixture.write('delete-blocker-comment-create', 'create_comment', {
      kind: 'todo',
      body: 'Keep this evidence.',
      targetType: 'chapter',
      targetName: 'Chapter One',
    });
    const commentPath = (comment as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    const commentId = commentPath.slice('/comments/'.length, -'.json'.length);
    await expect(
      fixture.write(
        'delete-blocked-by-comment',
        'delete_chapter',
        { chapter: 'Chapter One' },
        'author_approved',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(`批注或待办「${commentId}」`),
    });
    await fixture.write(
      'delete-blocker-comment-remove',
      'delete_comment',
      { commentId },
      'author_approved',
    );

    await expect(
      fixture.write(
        'delete-blocked-by-membership',
        'delete_chapter',
        { chapter: 'Chapter One' },
        'author_approved',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('故事线「Main」章节关系'),
    });
  });
});

class DomainCrudFixture {
  readonly composition: DriftingAgentProductComposition;
  readonly context: AgentToolContext;
  private tick = 0;
  private closed = false;

  private constructor(
    readonly directory: string,
    readonly gateway: ProductFileBackedSqliteGateway,
    readonly database: DbClient,
  ) {
    this.context = {
      projectId: PROJECT_ID,
      write: {} as AgentToolContext['write'],
    };
    this.composition = createDriftingAgentProductComposition({
      driver: unusedDriver,
      database,
      getContext: () => this.context,
    });
  }

  static async create(): Promise<DomainCrudFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'drifting-domain-crud-'));
    const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
    const database = createDatabaseClient(gateway);
    databaseSlot.current = database;
    try {
      await gateway.open('drifting.db');
      await seed(database);
      hydrateStores();
      const fixture = new DomainCrudFixture(directory, gateway, database);
      await fixture.composition.repositories.runtime.createSession({
        id: SESSION_ID,
        projectId: PROJECT_ID,
        routeKind: 'chat',
        conversationId: CONVERSATION_ID,
        goalRunId: null,
        chapterId: null,
        provider: 'test',
        model: 'test',
        providerEpoch: 0,
        status: 'running',
        createdAt: AT,
        updatedAt: AT,
        endedAt: null,
      });
      return fixture;
    } catch (error) {
      databaseSlot.current = null;
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async write(
    callId: string,
    name: DriftingDomainWriteToolName,
    arguments_: Record<string, unknown>,
    authorization: 'automatic' | 'author_approved' = 'automatic',
  ): Promise<AgentToolExecutionResult> {
    const request = await this.request(callId, name, 'write', arguments_);
    request.authorization = this.authorization(callId, arguments_, authorization);
    return this.composition.tools.execute(request);
  }

  async read(
    callId: string,
    name: DriftingDomainReadToolName,
    arguments_: Record<string, unknown>,
  ): Promise<AgentToolExecutionResult> {
    const request = await this.request(callId, name, 'read', arguments_);
    return this.composition.workspaceTools.execute(request);
  }

  async replayWrite(
    callId: string,
    name: DriftingDomainWriteToolName,
    arguments_: Record<string, unknown>,
    authorization: 'automatic' | 'author_approved' = 'automatic',
  ): Promise<AgentToolExecutionResult> {
    const request: AgentToolExecutionRequest = {
      sessionId: SESSION_ID,
      turnId: `turn:${callId}`,
      callId,
      idempotencyKey: this.idempotencyKey(callId),
      name,
      arguments: arguments_,
      access: 'write',
      authorization: this.authorization(callId, arguments_, authorization),
      context: runtimeContext(),
      control: {
        requestUserInput: async () => {
          throw new Error('No interactive prompt is expected in the direct CRUD harness');
        },
      },
      signal: new AbortController().signal,
    };
    return this.composition.tools.execute(request);
  }

  async revert(callId: string): Promise<void> {
    const idempotencyKey = this.idempotencyKey(callId);
    const effect = await this.composition.repositories.writeEffects.getEffect(
      `agent-write:${idempotencyKey}`,
    );
    if (!effect) throw new Error(`Missing effect for ${callId}`);
    const strategy = getDriftingWriteStrategy(effect.toolName, {
      freshness: this.composition.repositories.freshness,
      elementPatchDb: this.database,
      elementPatchNotifySyncCommitted: () => {},
    });
    if (!strategy) throw new Error(`Missing strategy for ${effect.toolName}`);
    await strategy.applyInverse(effect, this.context, new AbortController().signal);
  }

  memberships(): Array<Record<string, unknown>> {
    return this.gateway.database
      .prepare(
        'SELECT node_id, storyline_id, is_primary FROM node_storyline_link ORDER BY node_id, storyline_id',
      )
      .all() as Array<Record<string, unknown>>;
  }

  memory(memoryId: string) {
    return createAgentMemoryRepository(PROJECT_ID, this.database).findById(memoryId);
  }

  scalar(sql: string): number {
    const row = this.gateway.database.prepare(sql).get() as Record<string, unknown>;
    return Number(Object.values(row)[0] ?? 0);
  }

  text(sql: string): string {
    const row = this.gateway.database.prepare(sql).get() as Record<string, unknown>;
    return String(Object.values(row)[0] ?? '');
  }

  async restartEvidence(): Promise<{
    memories: number;
    receipts: number;
    committedEffects: number;
    latestMigration: number;
  }> {
    if (this.closed) throw new Error('The fixture is already closed');
    if (databaseSlot.current === this.database) databaseSlot.current = null;
    await this.gateway.close();
    const reopened = new ProductFileBackedSqliteGateway(
      path.join(this.directory, 'drifting.db'),
      false,
    );
    try {
      await reopened.open('drifting.db');
      const scalar = (sql: string) => {
        const row = reopened.database.prepare(sql).get() as Record<string, unknown>;
        return Number(Object.values(row)[0] ?? 0);
      };
      return {
        memories: scalar('SELECT count(*) FROM agent_memory'),
        receipts: scalar('SELECT count(*) FROM agent_runtime_entity_write_receipt'),
        committedEffects: scalar(
          "SELECT count(*) FROM agent_runtime_write_effect WHERE phase = 'result_committed'",
        ),
        latestMigration: scalar('SELECT max(created_at) FROM __drizzle_migrations'),
      };
    } finally {
      await reopened.close();
      this.closed = true;
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (databaseSlot.current === this.database) databaseSlot.current = null;
    await this.gateway.close();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async request(
    callId: string,
    name: DriftingDomainReadToolName | DriftingDomainWriteToolName,
    access: 'read' | 'write',
    arguments_: Record<string, unknown>,
  ): Promise<AgentToolExecutionRequest> {
    const turnId = `turn:${callId}`;
    const at = this.now();
    const persistence = this.composition.repositories.runtime;
    await persistence.createTurn({
      id: turnId,
      sessionId: SESSION_ID,
      ordinal: ++this.tick,
      status: 'running',
      promptMessageId: null,
      acceptedAt: at,
      startedAt: at,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: at,
    });
    const request: AgentToolExecutionRequest = {
      sessionId: SESSION_ID,
      turnId,
      callId,
      idempotencyKey: this.idempotencyKey(callId),
      name,
      arguments: arguments_,
      access,
      context: runtimeContext(),
      control: {
        requestUserInput: async () => {
          throw new Error('No interactive prompt is expected in the direct CRUD harness');
        },
      },
      signal: new AbortController().signal,
    };
    await persistence.createToolCall({
      id: `agent-tool:${SESSION_ID}:${turnId}:${callId}`,
      sessionId: SESSION_ID,
      turnId,
      callId,
      name,
      access,
      status: 'running',
      idempotencyKey: request.idempotencyKey,
      arguments: arguments_,
      result: null,
      errorCode: null,
      createdAt: at,
      startedAt: at,
      completedAt: null,
    });
    return request;
  }

  private idempotencyKey(callId: string): string {
    return `${SESSION_ID}:turn:${callId}:${callId}`;
  }

  private authorization(
    callId: string,
    arguments_: Record<string, unknown>,
    kind: 'automatic' | 'author_approved',
  ) {
    return {
      kind,
      requestId: kind === 'author_approved' ? `permission:${callId}` : null,
      argumentsHash: `sha256:${createHash('sha256')
        .update(JSON.stringify(sortJson(arguments_)))
        .digest('hex')}`,
    };
  }

  private now(): string {
    return new Date(Date.parse(AT) + ++this.tick).toISOString();
  }
}

async function seed(database: DbClient): Promise<void> {
  await database.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: USER_ID,
    name: 'Domain CRUD Book',
    summary: '',
    kvJson: '[]',
    storylineTemplateKvJson: '[]',
    createdAt: AT,
    updatedAt: AT,
  });
  await database
    .insert(BookNodeTable)
    .values([chapter(CHAPTER_ONE_ID, 'Chapter One', 0), chapter(CHAPTER_TWO_ID, 'Chapter Two', 1)]);
  await database
    .insert(StorylineTable)
    .values([
      storyline(MAIN_STORYLINE_ID, 'Main', 0),
      storyline(SECONDARY_STORYLINE_ID, 'Secondary', 1),
    ]);
  await database.insert(NodeStorylineLinkTable).values([
    { nodeId: CHAPTER_ONE_ID, storylineId: MAIN_STORYLINE_ID, isPrimary: true },
    { nodeId: CHAPTER_TWO_ID, storylineId: SECONDARY_STORYLINE_ID, isPrimary: true },
  ]);
  await database.insert(AgentConversationTable).values({
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: 'Domain CRUD acceptance',
    sdkSessionId: null,
    runtimeSessionId: null,
    mode: 'byok',
    messagesJson: '[]',
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
  });
}

function chapter(id: string, title: string, bookOrder: number) {
  return {
    id,
    projectId: PROJECT_ID,
    title,
    summary: '',
    bookOrder,
    narrativeOrder: null,
    wordCount: 0,
    writingStatus: 'draft' as const,
    kind: 'chapter' as const,
    driftGroupId: null,
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
    positionX: 0,
    positionY: 0,
  };
}

function storyline(id: string, name: string, orderKey: number) {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    color: '#8B7355',
    summary: '',
    orderKey,
    contentJson: '{}',
    kvJson: '[]',
    nodeContentTemplateJson: '{}',
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function hydrateStores(): void {
  const nodes = [
    chapterDomain(CHAPTER_ONE_ID, 'Chapter One', 0),
    chapterDomain(CHAPTER_TWO_ID, 'Chapter Two', 1),
  ];
  const storylines = [
    storyline(MAIN_STORYLINE_ID, 'Main', 0),
    storyline(SECONDARY_STORYLINE_ID, 'Secondary', 1),
  ];
  useProjectStore.setState({
    ...initialProjectState,
    currentProject: {
      id: PROJECT_ID,
      userId: USER_ID,
      name: 'Domain CRUD Book',
      summary: '',
      kvJson: '[]',
      storylineTemplateKvJson: '[]',
      createdAt: AT,
      updatedAt: AT,
    },
    projects: [],
  });
  useDataStore.setState({
    ...initialDataState,
    bookNodes: nodes,
    storylines,
    bookElements: [],
    bookElementCategories: [],
    comments: [],
    entityRelations: [],
    storylineNodeMapping: {
      [MAIN_STORYLINE_ID]: [CHAPTER_ONE_ID],
      [SECONDARY_STORYLINE_ID]: [CHAPTER_TWO_ID],
    },
    primaryStorylineByNode: {
      [CHAPTER_ONE_ID]: MAIN_STORYLINE_ID,
      [CHAPTER_TWO_ID]: SECONDARY_STORYLINE_ID,
    },
  });
}

function chapterDomain(id: string, title: string, bookOrder: number) {
  const row = chapter(id, title, bookOrder);
  const { positionX, positionY, ...value } = row;
  return {
    ...value,
    position: { x: positionX, y: positionY },
  };
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
