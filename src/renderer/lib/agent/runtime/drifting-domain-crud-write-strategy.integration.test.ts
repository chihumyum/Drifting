import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import migrationJournal from '../../../../../drizzle/meta/_journal.json';

import type { DbClient } from '../../../lib/db';
import { createDatabaseClient } from '../../../lib/db';
import { countWords } from '../../word-count';
import {
  AgentConversationTable,
  BookNodeTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
} from '../../../schema/drizzle';
import { createAgentMemoryRepository } from '../../../sqlite-repo/agent-memory-repo';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import type { AgentToolContext } from '../tool-handlers';
import { ProductFileBackedSqliteGateway } from './acceptance/p3-file-backed-sqlite';
import {
  createDriftingAgentProductComposition,
  type DriftingAgentProductComposition,
} from './drifting-product-composition';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
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

const unusedDriver: AgentModelDriver = {
  id: 'domain-crud-unused-driver',
  stream() {
    throw new Error('Domain CRUD integration invokes the tool runtime directly');
  },
};

describe('workspace domain CRUD transactions', () => {
  let fixture: DomainCrudFixture;

  beforeEach(async () => {
    fixture = await DomainCrudFixture.create();
  });

  afterEach(async () => {
    useDataStore.setState(initialDataState, true);
    useProjectStore.setState(initialProjectState, true);
    await fixture.close();
  });

  it('materializes the prose word count when a new chapter or drift is created', async () => {
    const prose = '# 灰港\n\n潮声越过旧码头。The tide turns twice.';
    const created = await fixture.write('node-create-with-prose', 'write_file', {
      path: '/drifts/灰港/prose.md',
      content: prose,
    });

    expect(created).toMatchObject({
      ok: true,
      data: {
        result: {
          path: '/drifts/灰港/prose.md',
          operation: 'created',
          wordCount: countWords(prose),
        },
      },
      modelData: { wordCount: countWords(prose) },
    });
    expect(
      fixture.scalar("SELECT word_count FROM book_node WHERE title = '灰港' AND deleted_at IS NULL"),
    ).toBe(countWords(prose));
  });

  it('normalizes a unique contained category and seeds a separate summary from initial body', async () => {
    await fixture.write('create-organization-category', 'write_file', {
      path: '/categories/势力与组织/body.md',
      content: '组织与势力。',
    });

    const created = await fixture.write('create-organization-with-summary', 'write_file', {
      path: '/elements/势力/灰潮档案局/body.md',
      content: '## 摘要\n\n负责灰港旧档。\n\n## 详细资料\n\n保管船籍与潮汐记录。',
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
      modelData: {
        path: '/elements/势力与组织/灰潮档案局/body.md',
        summaryInitialized: true,
      },
    });
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
      'write_file',
      {
        path: '/storylines/Main/chapters.json',
        content: JSON.stringify([
          { title: 'Chapter One', isPrimary: true },
          { title: 'Chapter Two', isPrimary: true },
        ]),
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
      { node_id: CHAPTER_TWO_ID, storyline_id: MAIN_STORYLINE_ID, is_primary: 1 },
      { node_id: CHAPTER_TWO_ID, storyline_id: SECONDARY_STORYLINE_ID, is_primary: 0 },
    ]);
    expect(useDataStore.getState().primaryStorylineByNode).toMatchObject({
      [CHAPTER_ONE_ID]: MAIN_STORYLINE_ID,
      [CHAPTER_TWO_ID]: MAIN_STORYLINE_ID,
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
      'write_file',
      {
        path: '/storylines/Main/chapters.json',
        content: JSON.stringify([
          { title: 'Chapter One', isPrimary: true },
          { title: 'Chapter Two', isPrimary: true },
        ]),
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
    const created = await fixture.write('memory-create', 'write_file', {
      path: '/memory/new.json',
      content: JSON.stringify({
        kind: 'preference',
        body: 'Keep dialogue terse.',
        targetKind: 'node',
        target: 'Chapter One',
      }),
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
      targetKind: 'node',
      targetId: CHAPTER_ONE_ID,
    });

    const directory = await fixture.read('memory-list', 'list_files', { path: '/memory' });
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
    const file = await fixture.read('memory-read', 'read_file', { path: canonicalPath });
    expect(file).toMatchObject({ ok: true });
    const fileContent = JSON.parse(
      String((file as { data: { content: string } }).data.content),
    ) as Record<string, unknown>;
    expect(fileContent).toEqual({
      kind: 'preference',
      body: 'Keep dialogue terse.',
      targetKind: 'node',
      target: 'Chapter One',
      targetBlockId: null,
      supersedesId: null,
    });

    await expect(
      fixture.write('memory-update', 'write_file', {
        path: canonicalPath,
        content: JSON.stringify({
          ...fileContent,
          body: 'Keep dialogue terse and character-specific.',
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect((await fixture.memory(memoryId))?.body).toBe(
      'Keep dialogue terse and character-specific.',
    );

    await fixture.revert('memory-update');
    expect((await fixture.memory(memoryId))?.body).toBe('Keep dialogue terse.');

    await expect(
      fixture.write('memory-delete', 'delete_file', { path: canonicalPath }, 'author_approved'),
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

    const disposable = await fixture.write('memory-create-disposable', 'write_file', {
      path: '/memory/disposable.json',
      content: JSON.stringify({
        kind: 'directive',
        body: 'Temporary guidance.',
      }),
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
      path: '/memory/recoverable.json',
      content: JSON.stringify({
        kind: 'directive',
        body: 'Preserve the unresolved ending.',
      }),
    };
    const interrupted = await fixture.write('memory-reconcile', 'write_file', arguments_);
    expect(interrupted).toMatchObject({ ok: false });
    expect(fixture.scalar('SELECT count(*) FROM agent_memory')).toBe(1);
    expect(fixture.scalar('SELECT count(*) FROM agent_runtime_entity_write_receipt')).toBe(1);

    const recovered = await fixture.replayWrite('memory-reconcile', 'write_file', arguments_);
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

  it('keeps approved guidance read-only and evolves it through a pending superseding proposal', async () => {
    const created = await fixture.write('memory-approved-create', 'write_file', {
      path: '/memory/voice.json',
      content: JSON.stringify({
        kind: 'preference',
        body: 'Use restrained imagery.',
      }),
    });
    const canonicalPath = (created as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    const memoryId = canonicalPath.slice('/memory/'.length, -'.json'.length);
    await createAgentMemoryRepository(PROJECT_ID, fixture.database).update(memoryId, {
      status: 'active',
      updatedAt: '2026-08-02T00:10:00.000Z',
    });

    const directory = await fixture.read('memory-approved-list', 'list_files', {
      path: '/memory',
    });
    expect(directory).toMatchObject({
      ok: true,
      data: {
        files: [expect.objectContaining({ path: canonicalPath, writable: false })],
      },
    });
    await expect(
      fixture.write('memory-approved-overwrite', 'write_file', {
        path: canonicalPath,
        content: JSON.stringify({
          kind: 'preference',
          body: 'Overwrite approved guidance.',
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('read-only'),
    });

    const proposal = await fixture.write('memory-supersede', 'write_file', {
      path: '/memory/revised-voice.json',
      content: JSON.stringify({
        kind: 'preference',
        body: 'Use restrained imagery except in dream sequences.',
        supersedesId: memoryId,
      }),
    });
    const proposalPath = (proposal as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    const proposalId = proposalPath.slice('/memory/'.length, -'.json'.length);
    expect(await fixture.memory(proposalId)).toMatchObject({
      status: 'pending',
      source: 'agent',
      supersedesId: memoryId,
    });
    expect(await fixture.memory(memoryId)).toMatchObject({
      status: 'active',
      deletedAt: null,
    });
  });

  it('creates and exactly removes every structural resource class', async () => {
    await expect(
      fixture.write('create-category-disposable', 'write_file', {
        path: '/categories/Disposable/body.md',
        content: 'Disposable category body.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.write('create-element-disposable', 'write_file', {
        path: '/elements/Disposable/Temporary Person/body.md',
        content: 'Disposable element body.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.write('create-storyline-disposable', 'write_file', {
        path: '/storylines/Disposable Arc/body.md',
        content: 'Disposable storyline body.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.write('create-node-disposable', 'write_file', {
        path: '/drifts/Disposable Idea/prose.md',
        content: 'Disposable drift body.',
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
    await fixture.write('create-category-lifecycle', 'write_file', {
      path: '/categories/People/body.md',
      content: 'People category body.',
    });
    await fixture.write('create-element-lifecycle', 'write_file', {
      path: '/elements/People/Ada/body.md',
      content: 'Ada body.',
    });
    await fixture.write('create-storyline-lifecycle', 'write_file', {
      path: '/storylines/Side Arc/body.md',
      content: 'Side arc body.',
    });
    await fixture.write('create-node-lifecycle', 'write_file', {
      path: '/drifts/Idea/prose.md',
      content: 'Idea body.',
    });

    await expect(
      fixture.write('update-category-lifecycle', 'write_file', {
        path: '/categories/People/meta.json',
        content: JSON.stringify({
          name: 'Cast',
          templateFacts: [{ key: 'Role', value: 'Unknown' }],
        }),
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
      fixture.write('update-element-lifecycle', 'write_file', {
        path: '/elements/People/Ada/summary.md',
        content: 'A precise investigator.',
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
      fixture.write('update-storyline-lifecycle', 'write_file', {
        path: '/storylines/Side Arc/summary.md',
        content: 'A secondary investigation.',
      }),
    ).resolves.toMatchObject({ ok: true });
    await fixture.revert('update-storyline-lifecycle');
    expect(useDataStore.getState().storylines).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Side Arc', summary: '' })]),
    );

    await expect(
      fixture.write(
        'delete-node-field-lifecycle',
        'delete_file',
        { path: '/drifts/Idea/summary.md' },
        'author_approved',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('complete resource'),
    });
    expect(useDataStore.getState().bookNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Idea' })]),
    );

    await fixture.write(
      'delete-element-lifecycle',
      'delete_file',
      { path: '/elements/People/Ada' },
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
      'delete_file',
      { path: '/drifts/Idea' },
      'author_approved',
    );
    await fixture.revert('delete-node-lifecycle');
    expect(useDataStore.getState().bookNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Idea' })]),
    );

    await fixture.write(
      'delete-storyline-lifecycle',
      'delete_file',
      { path: '/storylines/Side Arc' },
      'author_approved',
    );
    await fixture.revert('delete-storyline-lifecycle');
    expect(useDataStore.getState().storylines).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Side Arc' })]),
    );

    await fixture.write(
      'delete-element-before-category',
      'delete_file',
      { path: '/elements/People/Ada' },
      'author_approved',
    );
    await fixture.write(
      'delete-category-lifecycle',
      'delete_file',
      { path: '/categories/People' },
      'author_approved',
    );
    await fixture.revert('delete-category-lifecycle');
    expect(useDataStore.getState().bookElementCategories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'People' })]),
    );
  });

  it('provides natural JSON CRUD and guarded inverses for TODOs and relations', async () => {
    const disposableComment = await fixture.write('comment-create-disposable', 'write_file', {
      path: '/comments/new.json',
      content: JSON.stringify({
        kind: 'todo',
        body: 'Disposable TODO.',
        targetKind: 'node',
        target: 'Chapter One',
      }),
    });
    expect(disposableComment).toMatchObject({
      ok: true,
      data: {
        result: {
          path: expect.stringMatching(/^\/comments\/.+\.json$/u),
          requestedPath: '/comments/new.json',
          canonicalPath: expect.stringMatching(/^\/comments\/.+\.json$/u),
        },
      },
    });
    await fixture.revert('comment-create-disposable');
    expect(useDataStore.getState().comments).toHaveLength(0);

    const comment = await fixture.write('comment-create-lifecycle', 'write_file', {
      path: '/comments/todo.json',
      content: JSON.stringify({
        kind: 'todo',
        body: 'Check the clue.',
        targetKind: 'node',
        target: 'Chapter One',
      }),
    });
    const commentPath = (comment as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    await expect(
      fixture.write('comment-update-lifecycle', 'write_file', {
        path: commentPath,
        content: JSON.stringify({
          kind: 'note',
          status: 'resolved',
          body: 'The clue is consistent.',
          targetKind: 'node',
          target: 'Chapter One',
        }),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(useDataStore.getState().comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'note', status: 'resolved' })]),
    );
    await fixture.revert('comment-update-lifecycle');
    expect(useDataStore.getState().comments).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'todo', status: 'open' })]),
    );
    await fixture.write(
      'comment-delete-lifecycle',
      'delete_file',
      { path: commentPath },
      'author_approved',
    );
    expect(useDataStore.getState().comments).toHaveLength(0);
    await fixture.revert('comment-delete-lifecycle');
    expect(useDataStore.getState().comments).toHaveLength(1);

    const relationPayload = {
      fromKind: 'node',
      from: 'Chapter One',
      toKind: 'storyline',
      to: 'Main',
      kind: 'foreshadows',
    };
    const disposableRelation = await fixture.write(
      'relation-create-disposable',
      'write_file',
      { path: '/relations/new.json', content: JSON.stringify(relationPayload) },
      'author_approved',
    );
    expect(disposableRelation).toMatchObject({
      ok: true,
      data: {
        result: {
          path: expect.stringMatching(/^\/relations\/.+\.json$/u),
          requestedPath: '/relations/new.json',
          canonicalPath: expect.stringMatching(/^\/relations\/.+\.json$/u),
        },
      },
    });
    await fixture.revert('relation-create-disposable');
    expect(useDataStore.getState().entityRelations).toHaveLength(0);

    const relation = await fixture.write(
      'relation-create-lifecycle',
      'write_file',
      { path: '/relations/relation.json', content: JSON.stringify(relationPayload) },
      'author_approved',
    );
    const relationPath = (relation as { data: { result: { canonicalPath: string } } }).data.result
      .canonicalPath;
    await fixture.write(
      'relation-update-lifecycle',
      'write_file',
      {
        path: relationPath,
        content: JSON.stringify({ ...relationPayload, kind: 'contrasts' }),
      },
      'author_approved',
    );
    expect(useDataStore.getState().entityRelations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'contrasts' })]),
    );
    await fixture.revert('relation-update-lifecycle');
    expect(useDataStore.getState().entityRelations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'foreshadows' })]),
    );
    await fixture.write(
      'relation-delete-lifecycle',
      'delete_file',
      { path: relationPath },
      'author_approved',
    );
    expect(useDataStore.getState().entityRelations).toHaveLength(0);
    await fixture.revert('relation-delete-lifecycle');
    expect(useDataStore.getState().entityRelations).toHaveLength(1);
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
    name: 'write_file' | 'delete_file',
    arguments_: Record<string, unknown>,
    authorization: 'automatic' | 'author_approved' = 'automatic',
  ): Promise<AgentToolExecutionResult> {
    const request = await this.request(callId, name, 'write', arguments_);
    request.authorization = this.authorization(callId, arguments_, authorization);
    return this.composition.tools.execute(request);
  }

  async read(
    callId: string,
    name: 'list_files' | 'read_file',
    arguments_: Record<string, unknown>,
  ): Promise<AgentToolExecutionResult> {
    const request = await this.request(callId, name, 'read', arguments_);
    return this.composition.workspaceTools.execute(request);
  }

  async replayWrite(
    callId: string,
    name: 'write_file' | 'delete_file',
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
    name: 'write_file' | 'delete_file' | 'list_files' | 'read_file',
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
