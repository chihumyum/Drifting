import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { diffPlotGrid, serializePlotGrid, type PlotGrid } from '../domain/plot-grid';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../lib/db';
import {
  BookNodeTable,
  NodeContentTable,
  PlotGridCellTable,
  PlotGridColumnTable,
  PlotGridDocumentTable,
  PlotGridRowTable,
  ProjectTable,
  SyncChangeSetTable,
  SyncFieldClockTable,
  SyncMutationTable,
  SyncOrderRegisterTable,
  SyncGenerationTable,
} from '../schema/drizzle';
import { createAuthoredTransactionRunner } from '../sync/journal';
import { applyPlotGridMutationsInTransaction } from './plot-grid-write';

const PROJECT_ID = 'project-plot-grid';
const NODE_ID = 'node-plot-grid';
const NOW = '2026-08-15T18:00:00.000Z';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

const GRID: PlotGrid = {
  rows: [
    { id: 'row-a', label: 'Character' },
    { id: 'row-b', label: '' },
  ],
  cols: [
    { id: 'column-a', label: 'Opening' },
    { id: 'column-b', label: '' },
  ],
  cells: { 'row-a:column-a': 'Arrives' },
  cellW: 210,
  cellH: 88,
};

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-plot-grid-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT_ID,
    userId: 'local-user',
    name: 'Plot Grid',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: NODE_ID,
    projectId: PROJECT_ID,
    title: 'Chapter',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(NodeContentTable).values({
    nodeId: NODE_ID,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return db;
}

function runner(db: DbClient) {
  return createAuthoredTransactionRunner({
    database: () => db,
    identity: async () => ({
      installationId: 'installation-plot-grid',
      createWriterIdentity: () => ({ writerId: 'writer-plot-grid', writerEpoch: 'epoch-1' }),
    }),
    clock: () => ({ nowMs: 100, nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => 'sync-generation-plot-grid',
      createProjectSyncId: () => 'project-sync-plot-grid',
    },
  });
}

async function apply(
  db: DbClient,
  mutations: ReturnType<typeof diffPlotGrid>,
): Promise<void> {
  await runner(db)(PROJECT_ID, 'plot-grid.mutate', ({ tx, changes }) =>
    applyPlotGridMutationsInTransaction(tx, changes, {
      projectId: PROJECT_ID,
      nodeId: NODE_ID,
      mutations,
    }),
  );
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('normalized Plot Grid authored writer', () => {
  it('commits normalized rows, deterministic projection, and named journal mutations', async () => {
    const db = await createDatabase();
    await apply(db, diffPlotGrid(null, GRID));

    expect(await db.select().from(PlotGridDocumentTable)).toMatchObject([
      { nodeId: NODE_ID, cellWidth: 210, cellHeight: 88 },
    ]);
    expect(
      (await db.select().from(PlotGridRowTable)).map(({ id, label, positionKey }) => ({
        id,
        label,
        positionKey,
      })),
    ).toEqual([
      { id: 'row-a', label: 'Character', positionKey: 'a0' },
      { id: 'row-b', label: '', positionKey: 'a1' },
    ]);
    expect(
      (await db.select().from(PlotGridColumnTable)).map(({ id, label }) => ({ id, label })),
    ).toEqual([
      { id: 'column-a', label: 'Opening' },
      { id: 'column-b', label: '' },
    ]);
    expect(await db.select().from(PlotGridCellTable)).toMatchObject([
      { rowId: 'row-a', columnId: 'column-a', value: 'Arrives' },
    ]);
    expect((await db.select().from(NodeContentTable))[0]?.plotGridJson).toBe(
      serializePlotGrid(GRID),
    );

    const mutations = await db.select().from(SyncMutationTable);
    expect(mutations).toHaveLength(15);
    expect(
      mutations.some(
        ({ action, targetKind }) => action === 'tuple.set' && targetKind === 'node-content',
      ),
    ).toBe(true);
    expect(
      mutations.some(
        ({ action, targetKind }) => action === 'field.set' && targetKind === 'node-content',
      ),
    ).toBe(false);
    expect(new Set(mutations.map(({ targetKind }) => targetKind))).toEqual(
      new Set(['node-content', 'plot-grid-row', 'plot-grid-column', 'plot-grid-cell']),
    );
    expect(await db.select().from(SyncOrderRegisterTable)).toHaveLength(4);
    expect(
      (await db.select().from(SyncFieldClockTable)).map(({ fieldKey }) => fieldKey).sort(),
    ).toEqual([
      'field:label',
      'field:label',
      'field:label',
      'field:label',
      'field:value',
      'tuple:plot-grid-size',
    ]);
  });

  it('purges an axis and its stable cells without serializing a whole-grid field', async () => {
    const db = await createDatabase();
    await apply(db, diffPlotGrid(null, GRID));
    const next: PlotGrid = {
      ...GRID,
      rows: [{ id: 'row-b', label: '' }],
      cells: {},
    };
    await apply(db, diffPlotGrid(GRID, next));

    expect((await db.select().from(PlotGridRowTable)).map(({ id }) => id)).toEqual(['row-b']);
    expect(await db.select().from(PlotGridCellTable)).toEqual([]);
    expect((await db.select().from(NodeContentTable))[0]?.plotGridJson).toBe(
      serializePlotGrid(next),
    );
    const changeSets = await db.select().from(SyncChangeSetTable);
    expect(changeSets).toHaveLength(2);
    const deletion = await db
      .select()
      .from(SyncMutationTable)
      .where(eq(SyncMutationTable.changeSetId, changeSets[1]!.changeSetId));
    expect(deletion.map(({ action, targetKind }) => ({ action, targetKind }))).toEqual([
      { action: 'entity.purge', targetKind: 'plot-grid-cell' },
      { action: 'entity.purge', targetKind: 'plot-grid-row' },
    ]);
  });

  it('re-keys a moved axis through one named order action and rebuilds the projection', async () => {
    const db = await createDatabase();
    await apply(db, diffPlotGrid(null, GRID));
    const next: PlotGrid = {
      ...GRID,
      rows: [...GRID.rows].reverse(),
      cols: [...GRID.cols].reverse(),
    };
    await apply(db, diffPlotGrid(GRID, next));

    const rows = await db.select().from(PlotGridRowTable);
    const orderedRows = [...rows].sort((a, b) =>
      a.positionKey === b.positionKey ? a.id.localeCompare(b.id) : a.positionKey < b.positionKey ? -1 : 1,
    );
    expect(orderedRows.map(({ id }) => id)).toEqual(['row-b', 'row-a']);
    const columns = await db.select().from(PlotGridColumnTable);
    const orderedColumns = [...columns].sort((a, b) =>
      a.positionKey === b.positionKey ? a.id.localeCompare(b.id) : a.positionKey < b.positionKey ? -1 : 1,
    );
    expect(orderedColumns.map(({ id }) => id)).toEqual(['column-b', 'column-a']);
    expect(await db.select().from(PlotGridCellTable)).toMatchObject([
      { rowId: 'row-a', columnId: 'column-a', value: 'Arrives' },
    ]);
    expect((await db.select().from(NodeContentTable))[0]?.plotGridJson).toBe(
      serializePlotGrid(next),
    );

    const changeSets = await db.select().from(SyncChangeSetTable);
    expect(changeSets).toHaveLength(2);
    const moves = await db
      .select()
      .from(SyncMutationTable)
      .where(eq(SyncMutationTable.changeSetId, changeSets[1]!.changeSetId));
    expect(moves.map(({ action, targetKind }) => ({ action, targetKind }))).toEqual([
      { action: 'order.move', targetKind: 'plot-grid-row' },
      { action: 'order.move', targetKind: 'plot-grid-column' },
    ]);
    expect(await db.select().from(SyncOrderRegisterTable)).toHaveLength(4);
  });

  it('keeps cell identity and LWW value authority when the sparse projection clears it', async () => {
    const db = await createDatabase();
    await apply(db, diffPlotGrid(null, GRID));
    const original = (await db.select().from(PlotGridCellTable))[0]!;
    const cleared: PlotGrid = { ...GRID, cells: {} };
    await apply(db, diffPlotGrid(GRID, cleared));

    expect(await db.select().from(PlotGridCellTable)).toMatchObject([
      { id: original.id, rowId: 'row-a', columnId: 'column-a', value: '' },
    ]);
    expect((await db.select().from(NodeContentTable))[0]?.plotGridJson).toBe(
      serializePlotGrid(cleared),
    );
    const changeSets = await db.select().from(SyncChangeSetTable);
    const clearMutations = await db
      .select()
      .from(SyncMutationTable)
      .where(eq(SyncMutationTable.changeSetId, changeSets[1]!.changeSetId));
    expect(clearMutations).toMatchObject([
      { action: 'field.set', targetKind: 'plot-grid-cell', targetId: original.id },
    ]);
  });

  it('rolls normalized rows, projection, SyncGeneration, and journal back together', async () => {
    const db = await createDatabase();
    const run = runner(db);
    await expect(
      run(PROJECT_ID, 'plot-grid.mutate', ({ tx, changes }) =>
        applyPlotGridMutationsInTransaction(tx, changes, {
          projectId: PROJECT_ID,
          nodeId: NODE_ID,
          mutations: [
            { type: 'size.set', cellW: 300, cellH: 100 },
            {
              type: 'cell.value.set',
              rowId: 'missing-row',
              columnId: 'missing-column',
              value: 'Must roll back',
            },
          ],
        }),
      ),
    ).rejects.toThrow('does not belong');

    expect(await db.select().from(PlotGridDocumentTable)).toEqual([]);
    expect((await db.select().from(NodeContentTable))[0]?.plotGridJson).toBe('{}');
    expect(await db.select().from(SyncGenerationTable)).toEqual([]);
    expect(await db.select().from(SyncChangeSetTable)).toEqual([]);
  });
});
