import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../lib/db';
import {
  BookElementTable,
  ElementCategoryTable,
  EntityKvEntryTable,
  ProjectTable,
  StorylineTable,
  SyncEntityLifecycleTable,
  SyncMutationTable,
  SyncOrderRegisterTable,
  SyncSetTagTable,
} from '../schema/drizzle';
import { createAuthoredTransactionRunner } from '../sync/journal';
import { compareUtf8Bytewise } from '../sync/protocol';
import {
  cloneEntityKvEntriesInTransaction,
  materializeElementAliasesProjectionInTransaction,
  replaceElementAliasesInTransaction,
  replaceEntityKvEntriesInTransaction,
} from './normalized-kv-alias-authority';

const PROJECT_ID = 'project-normalized-authority';
const ELEMENT_ID = 'element-normalized-authority';
const NOW = '2026-08-15T12:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-normalized-authority-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Normalized authority',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookElementTable).values({
    id: ELEMENT_ID,
    projectId: PROJECT_ID,
    categoryId: null,
    name: 'Mira',
    summary: '',
    contentJson: '{}',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

function runner(db: DbClient) {
  let writerGeneration = 0;
  let nowMs = 100;
  return createAuthoredTransactionRunner({
    database: () => db,
    identity: async () => ({
      installationId: 'installation-normalized-authority',
      createWriterIdentity: () => ({
        writerId: `writer-normalized-${++writerGeneration}`,
        writerEpoch: `epoch-normalized-${writerGeneration}`,
      }),
    }),
    clock: () => ({ nowMs: ++nowMs, nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => 'sync-generation-normalized-authority',
      createProjectSyncId: () => 'project-sync-normalized-authority',
    },
  });
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('normalized KV and alias authored authority', () => {
  it('preserves KV entry IDs while journaling lifecycle, LWW and order mutations', async () => {
    const db = await createDatabase();
    const run = runner(db);
    const owner = {
      projectId: PROJECT_ID,
      ownerKind: 'project' as const,
      ownerId: PROJECT_ID,
      namespace: 'facts' as const,
    };

    await run(PROJECT_ID, 'project.facts-create', ({ tx, changes }) =>
      replaceEntityKvEntriesInTransaction(tx, changes, {
        ...owner,
        nextJson: JSON.stringify([
          { key: 'goal', value: 'finish' },
          { key: 'voice', value: 'quiet' },
          { key: 'genre', value: 'fantasy' },
        ]),
      }),
    );

    const initial = await db.select().from(EntityKvEntryTable);
    const initialIds = new Map(initial.map((entry) => [entry.key, entry.id]));
    expect(initial).toHaveLength(3);
    expect((await db.select().from(ProjectTable))[0]?.kvJson).toBe(
      '[{"key":"goal","value":"finish"},{"key":"voice","value":"quiet"},{"key":"genre","value":"fantasy"}]',
    );
    expect(
      (await db.select().from(SyncOrderRegisterTable)).filter(
        (row) => row.listKind === 'kv-entry',
      ),
    ).toHaveLength(3);

    await run(PROJECT_ID, 'project.facts-update', ({ tx, changes }) =>
      replaceEntityKvEntriesInTransaction(tx, changes, {
        ...owner,
        nextJson: JSON.stringify([
          { key: 'voice', value: 'quiet' },
          { key: 'goal', value: 'publish' },
        ]),
      }),
    );

    await run(PROJECT_ID, 'project.facts-add', ({ tx, changes }) =>
      replaceEntityKvEntriesInTransaction(tx, changes, {
        ...owner,
        nextJson: JSON.stringify([
          { key: 'voice', value: 'quiet' },
          { key: 'goal', value: 'publish' },
          { key: 'audience', value: 'adult' },
        ]),
      }),
    );

    const next = await db.select().from(EntityKvEntryTable);
    expect(next.find((entry) => entry.key === 'voice')?.id).toBe(initialIds.get('voice'));
    expect(next.find((entry) => entry.key === 'goal')?.id).toBe(initialIds.get('goal'));
    expect(next.find((entry) => entry.key === 'genre')).toBeUndefined();
    expect(next.find((entry) => entry.key === 'audience')?.id).not.toBe(
      initialIds.get('genre'),
    );
    expect((await db.select().from(ProjectTable))[0]?.kvJson).toBe(
      '[{"key":"voice","value":"quiet"},{"key":"goal","value":"publish"},{"key":"audience","value":"adult"}]',
    );

    const lifecycle = await db
      .select()
      .from(SyncEntityLifecycleTable)
      .where(eq(SyncEntityLifecycleTable.entityKind, 'kv-entry'));
    expect(lifecycle.find((row) => row.entityId === initialIds.get('genre'))?.state).toBe(
      'purged',
    );
    expect(lifecycle.filter((row) => row.state === 'live')).toHaveLength(3);
    const actions = (await db.select().from(SyncMutationTable)).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['entity.create', 'field.set', 'entity.purge', 'order.move']),
    );
  });

  it('does not swap stable IDs for moved edits or shift them after a head insertion', async () => {
    const db = await createDatabase();
    const run = runner(db);
    const owner = {
      projectId: PROJECT_ID,
      ownerKind: 'project' as const,
      ownerId: PROJECT_ID,
      namespace: 'facts' as const,
    };
    await run(PROJECT_ID, 'project.identity-seed', ({ tx, changes }) =>
      replaceEntityKvEntriesInTransaction(tx, changes, {
        ...owner,
        nextJson: '[{"key":"A","value":"1"},{"key":"B","value":"2"}]',
      }),
    );
    const seeded = await db.select().from(EntityKvEntryTable);
    const aId = seeded.find((entry) => entry.key === 'A')!.id;
    const bId = seeded.find((entry) => entry.key === 'B')!.id;

    await run(PROJECT_ID, 'project.identity-move-edit', ({ tx, changes }) =>
      replaceEntityKvEntriesInTransaction(tx, changes, {
        ...owner,
        nextJson: '[{"key":"B","value":"3"},{"key":"A","value":"1"}]',
      }),
    );
    const moved = await db.select().from(EntityKvEntryTable);
    expect(moved.find((entry) => entry.key === 'A')?.id).toBe(aId);
    expect(moved.find((entry) => entry.key === 'B')?.id).toBe(bId);

    await run(PROJECT_ID, 'project.identity-head-insert', ({ tx, changes }) =>
      replaceEntityKvEntriesInTransaction(tx, changes, {
        ...owner,
        nextJson:
          '[{"key":"X","value":"new"},{"key":"B","value":"3"},{"key":"A","value":"1"}]',
      }),
    );
    const inserted = await db.select().from(EntityKvEntryTable);
    expect(inserted.find((entry) => entry.key === 'A')?.id).toBe(aId);
    expect(inserted.find((entry) => entry.key === 'B')?.id).toBe(bId);
    expect(inserted.find((entry) => entry.key === 'X')?.id).not.toBe(aId);
    expect(inserted.find((entry) => entry.key === 'X')?.id).not.toBe(bId);
  });

  it('owns every KV projection explicitly and clones templates with fresh entry IDs', async () => {
    const db = await createDatabase();
    const run = runner(db);
    const categoryId = 'category-normalized-authority';
    const storylineId = 'storyline-normalized-authority';
    await db.insert(ElementCategoryTable).values({
      id: categoryId,
      projectId: PROJECT_ID,
      name: 'People',
      color: '#445566',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(StorylineTable).values({
      id: storylineId,
      projectId: PROJECT_ID,
      name: 'Main',
      color: '#112233',
      orderKey: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const projectTemplate = {
      projectId: PROJECT_ID,
      ownerKind: 'project' as const,
      ownerId: PROJECT_ID,
      namespace: 'storyline-template' as const,
    };
    const storylineFacts = {
      projectId: PROJECT_ID,
      ownerKind: 'storyline' as const,
      ownerId: storylineId,
      namespace: 'facts' as const,
    };
    const categoryTemplate = {
      projectId: PROJECT_ID,
      ownerKind: 'element-category' as const,
      ownerId: categoryId,
      namespace: 'element-template' as const,
    };
    const elementFacts = {
      projectId: PROJECT_ID,
      ownerKind: 'element' as const,
      ownerId: ELEMENT_ID,
      namespace: 'facts' as const,
    };

    await run(PROJECT_ID, 'project.template-create', async ({ tx, changes }) => {
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        ...projectTemplate,
        nextJson: '[{"key":"theme","value":"home"},{"key":"tone","value":"quiet"}]',
      });
    });
    await run(PROJECT_ID, 'storyline.template-clone', async ({ tx, changes }) => {
      await cloneEntityKvEntriesInTransaction(tx, changes, {
        source: projectTemplate,
        target: storylineFacts,
      });
    });
    await run(PROJECT_ID, 'category.template-create', async ({ tx, changes }) => {
      await replaceEntityKvEntriesInTransaction(tx, changes, {
        ...categoryTemplate,
        nextJson: '[{"key":"role","value":"witness"}]',
      });
    });
    await run(PROJECT_ID, 'element.template-clone', async ({ tx, changes }) => {
      await cloneEntityKvEntriesInTransaction(tx, changes, {
        source: categoryTemplate,
        target: elementFacts,
      });
    });

    const rows = await db.select().from(EntityKvEntryTable);
    const idsFor = (ownerKind: string, ownerId: string, namespace: string) =>
      rows
        .filter(
          (row) =>
            row.ownerKind === ownerKind &&
            row.ownerId === ownerId &&
            row.namespace === namespace,
        )
        .map((row) => row.id);
    const projectTemplateIds = idsFor('project', PROJECT_ID, 'storyline-template');
    const storylineIds = idsFor('storyline', storylineId, 'facts');
    const categoryTemplateIds = idsFor('element-category', categoryId, 'element-template');
    const elementIds = idsFor('element', ELEMENT_ID, 'facts');
    expect(projectTemplateIds).toHaveLength(2);
    expect(storylineIds).toHaveLength(2);
    expect(new Set([...projectTemplateIds, ...storylineIds]).size).toBe(4);
    expect(categoryTemplateIds).toHaveLength(1);
    expect(elementIds).toHaveLength(1);
    expect(elementIds[0]).not.toBe(categoryTemplateIds[0]);

    const project = (await db.select().from(ProjectTable))[0]!;
    const storyline = (await db.select().from(StorylineTable))[0]!;
    const category = (await db.select().from(ElementCategoryTable))[0]!;
    const element = (await db.select().from(BookElementTable))[0]!;
    expect(project.storylineTemplateKvJson).toBe(
      '[{"key":"theme","value":"home"},{"key":"tone","value":"quiet"}]',
    );
    expect(storyline.kvJson).toBe(project.storylineTemplateKvJson);
    expect(category.elementTemplateKvJson).toBe('[{"key":"role","value":"witness"}]');
    expect(element.kvJson).toBe(category.elementTemplateKvJson);
  });

  it('stores aliases as the named normalized OR-set and rebuilds aliases_json from live tags', async () => {
    const db = await createDatabase();
    const run = runner(db);

    await run(PROJECT_ID, 'element.aliases-create', ({ tx, changes }) =>
      replaceElementAliasesInTransaction(tx, changes, {
        projectId: PROJECT_ID,
        elementId: ELEMENT_ID,
        aliases: ['Lady Mira', 'M.'],
      }),
    );
    expect((await db.select().from(BookElementTable))[0]?.aliasesJson).toBe(
      '["Lady Mira","M."]',
    );
    expect(
      (await db
        .select({ valueKey: SyncSetTagTable.valueKey, setKey: SyncSetTagTable.setKey })
        .from(SyncSetTagTable)
        .where(isNull(SyncSetTagTable.removedByChangeSetId)))
        .sort((left, right) => compareUtf8Bytewise(left.valueKey, right.valueKey)),
    ).toEqual([
      { valueKey: 'lady mira', setKey: 'aliases' },
      { valueKey: 'm.', setKey: 'aliases' },
    ]);

    await run(PROJECT_ID, 'element.aliases-update', ({ tx, changes }) =>
      replaceElementAliasesInTransaction(tx, changes, {
        projectId: PROJECT_ID,
        elementId: ELEMENT_ID,
        aliases: ['LADY MIRA', 'The Heir'],
      }),
    );
    const live = await db
      .select({ valueKey: SyncSetTagTable.valueKey })
      .from(SyncSetTagTable)
      .where(
        and(
          eq(SyncSetTagTable.setKey, 'aliases'),
          isNull(SyncSetTagTable.removedByChangeSetId),
        ),
      );
    expect(live.sort((left, right) => compareUtf8Bytewise(left.valueKey, right.valueKey))).toEqual([
      { valueKey: 'lady mira' },
      { valueKey: 'the heir' },
    ]);

    await db
      .update(BookElementTable)
      .set({ aliasesJson: '["corrupt projection"]' })
      .where(eq(BookElementTable.id, ELEMENT_ID));
    await db.transaction((tx) =>
      materializeElementAliasesProjectionInTransaction(tx, PROJECT_ID, ELEMENT_ID),
    );
    expect((await db.select().from(BookElementTable))[0]?.aliasesJson).toBe(
      '["LADY MIRA","The Heir"]',
    );
  });
});
