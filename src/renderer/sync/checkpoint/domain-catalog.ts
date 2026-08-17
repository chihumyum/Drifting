import { and, eq, getTableColumns, inArray } from 'drizzle-orm';

import type { DbExecutor } from '../../lib/db';
import {
  AgentMemoryTable,
  BookActTable,
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  CommentTable,
  DriftGroupTable,
  EntityKvEntryTable,
  ElementCategoryTable,
  ElementPatchTable,
  EntityRelationTable,
  EntityRelationTypeEndpointKindTable,
  EntityRelationTypeTable,
  LibraryItemTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  PlotGridCellTable,
  PlotGridColumnTable,
  PlotGridDocumentTable,
  PlotGridRowTable,
  ProjectAssetTable,
  ProjectTable,
  StorylineTable,
  SyncEntityLifecycleTable,
  SyncOrderRegisterTable,
  TimelineMarkerTable,
} from '../../schema/drizzle';
import {
  entityKvOrderScope,
  type EntityKvOwner,
} from '../../domain/entity-kv-entry';
import { createPlotGridRepository } from '../../sqlite-repo/plot-grid-repo';
import {
  materializeElementAliasesProjectionInTransaction,
  materializeEntityKvProjectionInTransaction,
} from '../../usecase/normalized-kv-alias-authority';
import {
  assertFractionalPositionKey,
  driftGroupOrderScope,
} from '../journal/order-authority';
import {
  SYNC_DOMAIN_MANIFEST_V1,
  compareUtf8Bytewise,
  type CanonicalCborValue,
} from '../protocol';
import type { SnapshotTableRowsV1 } from './types';

type PersistedRow = Readonly<Record<string, unknown>>;
type SnapshotRow = Readonly<Record<string, CanonicalCborValue>>;

export const SNAPSHOT_DOMAIN_TABLE_NAMES_V1 = Object.freeze(
  SYNC_DOMAIN_MANIFEST_V1.tables
    .filter(
      (entry) =>
        entry.disposition === 'include' &&
        entry.table !== 'yjs_snapshots' &&
        entry.table !== 'yjs_updates',
    )
    .map((entry) => entry.table)
    .sort(compareUtf8Bytewise),
);

const TABLES_BY_NAME = Object.freeze({
  agent_memory: AgentMemoryTable,
  book_act: BookActTable,
  book_node: BookNodeTable,
  comment: CommentTable,
  comment_action: CommentActionTable,
  drift_group: DriftGroupTable,
  entity_kv_entry: EntityKvEntryTable,
  element: BookElementTable,
  element_category: ElementCategoryTable,
  element_patch: ElementPatchTable,
  entity_relation: EntityRelationTable,
  entity_relation_type: EntityRelationTypeTable,
  entity_relation_type_endpoint_kind: EntityRelationTypeEndpointKindTable,
  library_item: LibraryItemTable,
  node_content: NodeContentTable,
  node_storyline_link: NodeStorylineLinkTable,
  plot_grid_cell: PlotGridCellTable,
  plot_grid_column: PlotGridColumnTable,
  plot_grid_document: PlotGridDocumentTable,
  plot_grid_row: PlotGridRowTable,
  project: ProjectTable,
  project_asset: ProjectAssetTable,
  storylines: StorylineTable,
  timeline_marker: TimelineMarkerTable,
});

export type SnapshotDomainTableNameV1 = keyof typeof TABLES_BY_NAME;

const INSERT_ORDER: readonly SnapshotDomainTableNameV1[] = Object.freeze([
  'project',
  'project_asset',
  'entity_kv_entry',
  'element_category',
  'storylines',
  'drift_group',
  'book_node',
  'node_content',
  'plot_grid_document',
  'plot_grid_row',
  'plot_grid_column',
  'plot_grid_cell',
  'element',
  'node_storyline_link',
  'element_patch',
  'entity_relation_type',
  'entity_relation_type_endpoint_kind',
  'entity_relation',
  'comment',
  'comment_action',
  'library_item',
  'book_act',
  'timeline_marker',
  'agent_memory',
]);

function policyFor(tableName: SnapshotDomainTableNameV1) {
  const policy = SYNC_DOMAIN_MANIFEST_V1.tables.find((entry) => entry.table === tableName);
  if (!policy || policy.disposition !== 'include') {
    throw new Error(`Sync domain table ${tableName} is not included in manifest v1`);
  }
  return policy;
}

function serializedRow(
  tableName: SnapshotDomainTableNameV1,
  row: PersistedRow,
): SnapshotRow {
  const table = TABLES_BY_NAME[tableName];
  const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
  const allowed = policyFor(tableName).fields;
  const output: Record<string, CanonicalCborValue> = {};
  for (const [property, column] of Object.entries(columns)) {
    if (allowed[column.name]?.disposition !== 'include') continue;
    const value = row[property];
    if (value === undefined) {
      throw new Error(`${tableName}.${column.name} is missing from a captured row`);
    }
    output[column.name] = value as CanonicalCborValue;
  }
  return output;
}

function serializeTable(
  tableName: SnapshotDomainTableNameV1,
  rows: readonly PersistedRow[],
): SnapshotTableRowsV1 {
  const serialized = rows.map((row) => serializedRow(tableName, row));
  serialized.sort((left, right) =>
    compareUtf8Bytewise(JSON.stringify(left), JSON.stringify(right)),
  );
  return { table: tableName, rows: serialized };
}

/** Capture only rows provably reachable from one project, inside the caller's read transaction. */
export async function captureAuthoredTablesV1(
  tx: DbExecutor,
  projectId: string,
): Promise<readonly SnapshotTableRowsV1[]> {
  const [projects, assets, kvEntries, categories, storylines, groups, nodes, elements, patches, relationTypes,
    relations, comments, commentActions, libraryItems, acts, markers, memories] = await Promise.all([
    tx.select().from(ProjectTable).where(eq(ProjectTable.id, projectId)),
    tx.select().from(ProjectAssetTable).where(eq(ProjectAssetTable.projectId, projectId)),
    tx.select().from(EntityKvEntryTable).where(eq(EntityKvEntryTable.projectId, projectId)),
    tx.select().from(ElementCategoryTable).where(eq(ElementCategoryTable.projectId, projectId)),
    tx.select().from(StorylineTable).where(eq(StorylineTable.projectId, projectId)),
    tx.select().from(DriftGroupTable).where(eq(DriftGroupTable.projectId, projectId)),
    tx.select().from(BookNodeTable).where(eq(BookNodeTable.projectId, projectId)),
    tx.select().from(BookElementTable).where(eq(BookElementTable.projectId, projectId)),
    tx.select().from(ElementPatchTable).where(eq(ElementPatchTable.projectId, projectId)),
    tx.select().from(EntityRelationTypeTable).where(eq(EntityRelationTypeTable.projectId, projectId)),
    tx.select().from(EntityRelationTable).where(eq(EntityRelationTable.projectId, projectId)),
    tx.select().from(CommentTable).where(eq(CommentTable.projectId, projectId)),
    tx.select().from(CommentActionTable).where(eq(CommentActionTable.projectId, projectId)),
    tx.select().from(LibraryItemTable).where(eq(LibraryItemTable.projectId, projectId)),
    tx.select().from(BookActTable).where(eq(BookActTable.projectId, projectId)),
    tx.select().from(TimelineMarkerTable).where(eq(TimelineMarkerTable.projectId, projectId)),
    tx.select().from(AgentMemoryTable).where(eq(AgentMemoryTable.projectId, projectId)),
  ]);
  if (projects.length !== 1) throw new Error(`Project ${projectId} does not exist exactly once`);

  const nodeIds = nodes.map((row) => row.id);
  const storylineIds = storylines.map((row) => row.id);
  const relationTypeIds = relationTypes.map((row) => row.id);
  const [nodeContents, storylineLinks, endpointKinds, plotDocuments] = await Promise.all([
    nodeIds.length === 0
      ? Promise.resolve([])
      : tx.select().from(NodeContentTable).where(inArray(NodeContentTable.nodeId, nodeIds)),
    nodeIds.length === 0 || storylineIds.length === 0
      ? Promise.resolve([])
      : tx
          .select()
          .from(NodeStorylineLinkTable)
          .where(
            and(
              inArray(NodeStorylineLinkTable.nodeId, nodeIds),
              inArray(NodeStorylineLinkTable.storylineId, storylineIds),
            ),
          ),
    relationTypeIds.length === 0
      ? Promise.resolve([])
      : tx
          .select()
          .from(EntityRelationTypeEndpointKindTable)
          .where(inArray(EntityRelationTypeEndpointKindTable.relationTypeId, relationTypeIds)),
    nodeIds.length === 0
      ? Promise.resolve([])
      : tx
          .select()
          .from(PlotGridDocumentTable)
          .where(inArray(PlotGridDocumentTable.nodeId, nodeIds)),
  ]);
  const plotDocumentIds = plotDocuments.map((document) => document.id);
  const [plotRows, plotColumns, plotCells] = await Promise.all([
    plotDocumentIds.length === 0
      ? Promise.resolve([])
      : tx.select().from(PlotGridRowTable).where(inArray(PlotGridRowTable.documentId, plotDocumentIds)),
    plotDocumentIds.length === 0
      ? Promise.resolve([])
      : tx.select().from(PlotGridColumnTable).where(inArray(PlotGridColumnTable.documentId, plotDocumentIds)),
    plotDocumentIds.length === 0
      ? Promise.resolve([])
      : tx.select().from(PlotGridCellTable).where(inArray(PlotGridCellTable.documentId, plotDocumentIds)),
  ]);

  const values: Record<SnapshotDomainTableNameV1, readonly PersistedRow[]> = {
    agent_memory: memories,
    book_act: acts,
    book_node: nodes,
    comment: comments,
    comment_action: commentActions,
    drift_group: groups,
    entity_kv_entry: kvEntries,
    element: elements,
    element_category: categories,
    element_patch: patches,
    entity_relation: relations,
    entity_relation_type: relationTypes,
    entity_relation_type_endpoint_kind: endpointKinds,
    library_item: libraryItems,
    node_content: nodeContents,
    node_storyline_link: storylineLinks,
    plot_grid_cell: plotCells,
    plot_grid_column: plotColumns,
    plot_grid_document: plotDocuments,
    plot_grid_row: plotRows,
    project: projects,
    project_asset: assets,
    storylines,
    timeline_marker: markers,
  };
  return SNAPSHOT_DOMAIN_TABLE_NAMES_V1.map((tableName) =>
    serializeTable(tableName as SnapshotDomainTableNameV1, values[tableName as SnapshotDomainTableNameV1]),
  );
}

function inflateRows<TName extends SnapshotDomainTableNameV1>(
  tableName: TName,
  rows: readonly SnapshotRow[],
  input: { nowIso: string; localUserId: string },
): Readonly<Record<string, unknown>>[] {
  const table = TABLES_BY_NAME[tableName];
  const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
  const bySqlName = new Map(Object.entries(columns).map(([property, column]) => [column.name, property]));
  return rows.map((row, ordinal) => {
    const inflated: Record<string, unknown> = {};
    for (const [columnName, value] of Object.entries(row)) {
      const property = bySqlName.get(columnName);
      if (!property) throw new Error(`${tableName}.${columnName} is not a current schema field`);
      inflated[property] = value;
    }
    if ('createdAt' in columns && inflated.createdAt === undefined) inflated.createdAt = input.nowIso;
    if ('updatedAt' in columns && inflated.updatedAt === undefined) inflated.updatedAt = input.nowIso;
    if (tableName === 'project') inflated.userId = input.localUserId;
    if (tableName === 'storylines') {
      inflated.orderKey ??= ordinal;
      inflated.kvJson ??= '[]';
    }
    return inflated;
  });
}

export function tableMapFromAuthoredState(
  tables: readonly SnapshotTableRowsV1[],
): ReadonlyMap<SnapshotDomainTableNameV1, readonly SnapshotRow[]> {
  return new Map(
    tables.map((entry) => [entry.table as SnapshotDomainTableNameV1, entry.rows] as const),
  );
}

/** Insert a prevalidated authored snapshot in FK-safe order. */
export async function materializeAuthoredTablesV1(
  tx: DbExecutor,
  tables: readonly SnapshotTableRowsV1[],
  input: { nowIso: string; localUserId: string },
): Promise<void> {
  const rowsByTable = tableMapFromAuthoredState(tables);
  for (const tableName of INSERT_ORDER) {
    const rows = inflateRows(tableName, rowsByTable.get(tableName) ?? [], input);
    if (rows.length === 0) continue;
    switch (tableName) {
      case 'project': await tx.insert(ProjectTable).values(rows as (typeof ProjectTable.$inferInsert)[]); break;
      case 'project_asset': await tx.insert(ProjectAssetTable).values(rows as (typeof ProjectAssetTable.$inferInsert)[]); break;
      case 'entity_kv_entry': await tx.insert(EntityKvEntryTable).values(rows as (typeof EntityKvEntryTable.$inferInsert)[]); break;
      case 'element_category': await tx.insert(ElementCategoryTable).values(rows as (typeof ElementCategoryTable.$inferInsert)[]); break;
      case 'storylines': await tx.insert(StorylineTable).values(rows as (typeof StorylineTable.$inferInsert)[]); break;
      case 'drift_group': await tx.insert(DriftGroupTable).values(rows as (typeof DriftGroupTable.$inferInsert)[]); break;
      case 'book_node': await tx.insert(BookNodeTable).values(rows as (typeof BookNodeTable.$inferInsert)[]); break;
      case 'node_content': await tx.insert(NodeContentTable).values(rows as (typeof NodeContentTable.$inferInsert)[]); break;
      case 'plot_grid_document': await tx.insert(PlotGridDocumentTable).values(rows as (typeof PlotGridDocumentTable.$inferInsert)[]); break;
      case 'plot_grid_row': await tx.insert(PlotGridRowTable).values(rows as (typeof PlotGridRowTable.$inferInsert)[]); break;
      case 'plot_grid_column': await tx.insert(PlotGridColumnTable).values(rows as (typeof PlotGridColumnTable.$inferInsert)[]); break;
      case 'plot_grid_cell': await tx.insert(PlotGridCellTable).values(rows as (typeof PlotGridCellTable.$inferInsert)[]); break;
      case 'element': await tx.insert(BookElementTable).values(rows as (typeof BookElementTable.$inferInsert)[]); break;
      case 'node_storyline_link': await tx.insert(NodeStorylineLinkTable).values(rows as (typeof NodeStorylineLinkTable.$inferInsert)[]); break;
      case 'element_patch': await tx.insert(ElementPatchTable).values(rows as (typeof ElementPatchTable.$inferInsert)[]); break;
      case 'entity_relation_type': await tx.insert(EntityRelationTypeTable).values(rows as (typeof EntityRelationTypeTable.$inferInsert)[]); break;
      case 'entity_relation_type_endpoint_kind': await tx.insert(EntityRelationTypeEndpointKindTable).values(rows as (typeof EntityRelationTypeEndpointKindTable.$inferInsert)[]); break;
      case 'entity_relation': await tx.insert(EntityRelationTable).values(rows as (typeof EntityRelationTable.$inferInsert)[]); break;
      case 'comment': await tx.insert(CommentTable).values(rows as (typeof CommentTable.$inferInsert)[]); break;
      case 'comment_action': await tx.insert(CommentActionTable).values(rows as (typeof CommentActionTable.$inferInsert)[]); break;
      case 'library_item': await tx.insert(LibraryItemTable).values(rows as (typeof LibraryItemTable.$inferInsert)[]); break;
      case 'book_act': await tx.insert(BookActTable).values(rows as (typeof BookActTable.$inferInsert)[]); break;
      case 'timeline_marker': await tx.insert(TimelineMarkerTable).values(rows as (typeof TimelineMarkerTable.$inferInsert)[]); break;
      case 'agent_memory': await tx.insert(AgentMemoryTable).values(rows as (typeof AgentMemoryTable.$inferInsert)[]); break;
    }
  }
}

interface RestoredOrderRegister {
  readonly listKind: string;
  readonly ownerId: string;
  readonly entityId: string;
  readonly incarnation: number;
  readonly positionKey: string;
}

function restoredOrderKey(listKind: string, entityId: string): string {
  return JSON.stringify([listKind, entityId]);
}

async function restoredOrders(
  tx: DbExecutor,
  syncGenerationId: string,
): Promise<ReadonlyMap<string, RestoredOrderRegister>> {
  const [rows, lifecycles] = await Promise.all([
    tx
      .select({
        listKind: SyncOrderRegisterTable.listKind,
        ownerId: SyncOrderRegisterTable.ownerId,
        entityId: SyncOrderRegisterTable.entityId,
        incarnation: SyncOrderRegisterTable.incarnation,
        positionKey: SyncOrderRegisterTable.positionKey,
      })
      .from(SyncOrderRegisterTable)
      .where(eq(SyncOrderRegisterTable.syncGenerationId, syncGenerationId)),
    tx
      .select({
        entityKind: SyncEntityLifecycleTable.entityKind,
        entityId: SyncEntityLifecycleTable.entityId,
        incarnation: SyncEntityLifecycleTable.incarnation,
      })
      .from(SyncEntityLifecycleTable)
      .where(eq(SyncEntityLifecycleTable.syncGenerationId, syncGenerationId)),
  ]);
  const lifecycleByEntity = new Map(
    lifecycles.map((row) => [
      JSON.stringify([row.entityKind, row.entityId]),
      row.incarnation,
    ] as const),
  );
  const selected = new Map<string, RestoredOrderRegister>();
  for (const row of rows.sort(
    (left, right) =>
      compareUtf8Bytewise(left.listKind, right.listKind) ||
      compareUtf8Bytewise(left.entityId, right.entityId) ||
      left.incarnation - right.incarnation,
  )) {
    const lifecycleKind = row.listKind;
    const currentIncarnation = lifecycleByEntity.get(
      JSON.stringify([lifecycleKind, row.entityId]),
    );
    if (currentIncarnation !== undefined && row.incarnation !== currentIncarnation) continue;
    const key = restoredOrderKey(row.listKind, row.entityId);
    if (selected.has(key)) {
      throw new Error(
        `Normalized order authority has multiple current incarnations for ${row.listKind}:${row.entityId}`,
      );
    }
    assertFractionalPositionKey(row.positionKey);
    selected.set(key, row);
  }
  return selected;
}

function requireRestoredOrder(
  orders: ReadonlyMap<string, RestoredOrderRegister>,
  listKind: string,
  entityId: string,
  ownerId: string,
): RestoredOrderRegister {
  const row = orders.get(restoredOrderKey(listKind, entityId));
  if (!row || row.ownerId !== ownerId) {
    throw new Error(
      `Normalized order authority is missing for ${listKind}:${entityId} in ${ownerId}`,
    );
  }
  return row;
}

/** Fail capture before publishing a checkpoint that cannot be reconstructed. */
export async function assertNormalizedAuthoredAuthorityV1(
  tx: DbExecutor,
  input: { readonly projectId: string; readonly syncGenerationId: string },
): Promise<void> {
  const [orders, kvEntries, storylines, groups, patches, libraryItems, plotRows, plotColumns] =
    await Promise.all([
      restoredOrders(tx, input.syncGenerationId),
      tx.select().from(EntityKvEntryTable).where(eq(EntityKvEntryTable.projectId, input.projectId)),
      tx.select().from(StorylineTable).where(eq(StorylineTable.projectId, input.projectId)),
      tx.select().from(DriftGroupTable).where(eq(DriftGroupTable.projectId, input.projectId)),
      tx.select().from(ElementPatchTable).where(eq(ElementPatchTable.projectId, input.projectId)),
      tx.select().from(LibraryItemTable).where(eq(LibraryItemTable.projectId, input.projectId)),
      tx
        .select({
          id: PlotGridRowTable.id,
          documentId: PlotGridRowTable.documentId,
          positionKey: PlotGridRowTable.positionKey,
        })
        .from(PlotGridRowTable)
        .innerJoin(PlotGridDocumentTable, eq(PlotGridDocumentTable.id, PlotGridRowTable.documentId))
        .innerJoin(BookNodeTable, eq(BookNodeTable.id, PlotGridDocumentTable.nodeId))
        .where(eq(BookNodeTable.projectId, input.projectId)),
      tx
        .select({
          id: PlotGridColumnTable.id,
          documentId: PlotGridColumnTable.documentId,
          positionKey: PlotGridColumnTable.positionKey,
        })
        .from(PlotGridColumnTable)
        .innerJoin(PlotGridDocumentTable, eq(PlotGridDocumentTable.id, PlotGridColumnTable.documentId))
        .innerJoin(BookNodeTable, eq(BookNodeTable.id, PlotGridDocumentTable.nodeId))
        .where(eq(BookNodeTable.projectId, input.projectId)),
    ]);

  for (const entry of kvEntries) {
    const scope = entityKvOrderScope({
      projectId: entry.projectId,
      ownerKind: entry.ownerKind as EntityKvOwner['ownerKind'],
      ownerId: entry.ownerId,
      namespace: entry.namespace as EntityKvOwner['namespace'],
    });
    requireRestoredOrder(orders, 'kv-entry', entry.id, scope);
  }
  for (const storyline of storylines) {
    assertFractionalPositionKey(
      requireRestoredOrder(orders, 'storyline', storyline.id, input.projectId).positionKey,
    );
  }
  for (const group of groups) {
    const scope = driftGroupOrderScope(input.projectId, group.parentGroupId);
    assertFractionalPositionKey(
      requireRestoredOrder(orders, 'drift-group', group.id, scope).positionKey,
    );
  }
  for (const patch of patches) {
    assertFractionalPositionKey(
      requireRestoredOrder(orders, 'element-patch', patch.id, patch.elementId).positionKey,
    );
  }
  for (const item of libraryItems) {
    assertFractionalPositionKey(
      requireRestoredOrder(orders, 'library-item', item.id, input.projectId).positionKey,
    );
  }
  for (const row of plotRows) {
    const order = requireRestoredOrder(orders, 'plot-grid-row', row.id, row.documentId);
    if (order.positionKey !== row.positionKey) {
      throw new Error(`Plot Grid row ${row.id} disagrees with its order register`);
    }
  }
  for (const column of plotColumns) {
    const order = requireRestoredOrder(
      orders,
      'plot-grid-column',
      column.id,
      column.documentId,
    );
    if (order.positionKey !== column.positionKey) {
      throw new Error(`Plot Grid column ${column.id} disagrees with its order register`);
    }
  }
}

/**
 * Rebuild every excluded JSON/numeric query projection from normalized v1
 * authority. The staged SyncGeneration must already be attached inside the caller's
 * activation transaction so KV/alias readers resolve its reducer metadata.
 */
export async function materializeNormalizedAuthoredProjectionsV1(
  tx: DbExecutor,
  input: { readonly projectId: string; readonly syncGenerationId: string },
): Promise<void> {
  await assertNormalizedAuthoredAuthorityV1(tx, input);
  const orders = await restoredOrders(tx, input.syncGenerationId);
  const requireOrder = (
    listKind: string,
    entityId: string,
    ownerId: string,
  ): RestoredOrderRegister => {
    return requireRestoredOrder(orders, listKind, entityId, ownerId);
  };
  const orderRanks = (
    listKind: string,
    ownerId: string,
    liveEntityIds: ReadonlySet<string>,
  ): ReadonlyMap<string, number> =>
    new Map(
      [...orders.values()]
        .filter(
          (order) =>
            order.listKind === listKind &&
            order.ownerId === ownerId &&
            liveEntityIds.has(order.entityId),
        )
        .sort(
          (left, right) =>
            compareUtf8Bytewise(left.positionKey, right.positionKey) ||
            compareUtf8Bytewise(left.entityId, right.entityId),
        )
        .map((order, index) => [order.entityId, index] as const),
    );

  const [projects, categories, storylines, groups, nodes, elements, patches, libraryItems] =
    await Promise.all([
      tx.select().from(ProjectTable).where(eq(ProjectTable.id, input.projectId)),
      tx.select().from(ElementCategoryTable).where(eq(ElementCategoryTable.projectId, input.projectId)),
      tx.select().from(StorylineTable).where(eq(StorylineTable.projectId, input.projectId)),
      tx.select().from(DriftGroupTable).where(eq(DriftGroupTable.projectId, input.projectId)),
      tx.select().from(BookNodeTable).where(eq(BookNodeTable.projectId, input.projectId)),
      tx.select().from(BookElementTable).where(eq(BookElementTable.projectId, input.projectId)),
      tx.select().from(ElementPatchTable).where(eq(ElementPatchTable.projectId, input.projectId)),
      tx.select().from(LibraryItemTable).where(eq(LibraryItemTable.projectId, input.projectId)),
    ]);

  const kvOwners: EntityKvOwner[] = [
    {
      projectId: input.projectId,
      ownerKind: 'project',
      ownerId: input.projectId,
      namespace: 'facts',
    },
    {
      projectId: input.projectId,
      ownerKind: 'project',
      ownerId: input.projectId,
      namespace: 'storyline-template',
    },
    ...categories.map((category): EntityKvOwner => ({
      projectId: input.projectId,
      ownerKind: 'element-category',
      ownerId: category.id,
      namespace: 'element-template',
    })),
    ...storylines.map((storyline): EntityKvOwner => ({
      projectId: input.projectId,
      ownerKind: 'storyline',
      ownerId: storyline.id,
      namespace: 'facts',
    })),
    ...elements.map((element): EntityKvOwner => ({
      projectId: input.projectId,
      ownerKind: 'element',
      ownerId: element.id,
      namespace: 'facts',
    })),
  ];
  if (projects.length !== 1) throw new Error(`Restored project ${input.projectId} is missing`);
  for (const owner of kvOwners) {
    await materializeEntityKvProjectionInTransaction(tx, owner, {
      syncGenerationId: input.syncGenerationId,
    });
  }
  for (const element of elements) {
    await materializeElementAliasesProjectionInTransaction(
      tx,
      input.projectId,
      element.id,
      { syncGenerationId: input.syncGenerationId },
    );
  }

  const storylineRanks = orderRanks(
    'storyline',
    input.projectId,
    new Set(storylines.filter(({ deletedAt }) => deletedAt === null).map(({ id }) => id)),
  );
  const allStorylineRanks = orderRanks(
    'storyline',
    input.projectId,
    new Set(storylines.map(({ id }) => id)),
  );
  for (const storyline of storylines) {
    requireOrder('storyline', storyline.id, input.projectId);
    await tx
      .update(StorylineTable)
      .set({
        orderKey: (storyline.deletedAt === null ? storylineRanks : allStorylineRanks)
          .get(storyline.id)!,
      })
      .where(eq(StorylineTable.id, storyline.id));
  }
  const groupIdsByScope = new Map<string, Set<string>>();
  for (const group of groups) {
    const scope = driftGroupOrderScope(input.projectId, group.parentGroupId);
    const ids = groupIdsByScope.get(scope) ?? new Set<string>();
    ids.add(group.id);
    groupIdsByScope.set(scope, ids);
  }
  const groupRanksByScope = new Map(
    [...groupIdsByScope].map(([scope, ids]) => [
      scope,
      orderRanks('drift-group', scope, ids),
    ] as const),
  );
  for (const group of groups) {
    const scope = driftGroupOrderScope(input.projectId, group.parentGroupId);
    requireOrder('drift-group', group.id, scope);
    await tx
      .update(DriftGroupTable)
      .set({ sortOrder: groupRanksByScope.get(scope)!.get(group.id)! })
      .where(eq(DriftGroupTable.id, group.id));
  }
  const patchIdsByElement = new Map<string, Set<string>>();
  for (const patch of patches) {
    const ids = patchIdsByElement.get(patch.elementId) ?? new Set<string>();
    ids.add(patch.id);
    patchIdsByElement.set(patch.elementId, ids);
  }
  const patchRanksByElement = new Map(
    [...patchIdsByElement].map(([elementId, ids]) => [
      elementId,
      orderRanks('element-patch', elementId, ids),
    ] as const),
  );
  for (const patch of patches) {
    requireOrder('element-patch', patch.id, patch.elementId);
    await tx
      .update(ElementPatchTable)
      .set({ orderKey: patchRanksByElement.get(patch.elementId)!.get(patch.id)! })
      .where(eq(ElementPatchTable.id, patch.id));
  }
  const libraryRanks = orderRanks(
    'library-item',
    input.projectId,
    new Set(libraryItems.map(({ id }) => id)),
  );
  for (const item of libraryItems) {
    requireOrder('library-item', item.id, input.projectId);
    await tx
      .update(LibraryItemTable)
      .set({ orderKey: libraryRanks.get(item.id)! })
      .where(eq(LibraryItemTable.id, item.id));
  }
  const plotNodeIds = nodes.map((node) => node.id);
  const plotDocuments = plotNodeIds.length === 0
    ? []
    : await tx
        .select()
        .from(PlotGridDocumentTable)
        .where(inArray(PlotGridDocumentTable.nodeId, plotNodeIds));
  const plotRepo = createPlotGridRepository(tx);
  for (const document of plotDocuments) {
    const projection = await plotRepo.materializeProjection(document.nodeId);
    if (projection === null) throw new Error(`Plot Grid ${document.id} did not materialize`);
    await tx
      .update(NodeContentTable)
      .set({ plotGridJson: projection })
      .where(eq(NodeContentTable.nodeId, document.nodeId));
  }
}

export function proseSeedRows(
  tables: readonly SnapshotTableRowsV1[],
): ReadonlyMap<string, CanonicalCborValue> {
  const map = tableMapFromAuthoredState(tables);
  const seeds = new Map<string, CanonicalCborValue>();
  const add = (documentId: string, raw: CanonicalCborValue | undefined) => {
    const source = typeof raw === 'string' ? raw : '{}';
    let seed: unknown;
    try {
      seed = JSON.parse(source);
    } catch (error) {
      throw new Error(
        `Invalid prose seed JSON for ${documentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    seeds.set(documentId, seed as CanonicalCborValue);
  };
  for (const row of map.get('node_content') ?? []) add(`node-content:${String(row.node_id)}`, row.content_json);
  for (const row of map.get('storylines') ?? []) add(`storyline:${String(row.id)}`, row.content_json);
  for (const row of map.get('element') ?? []) add(`element:${String(row.id)}`, row.content_json);
  for (const row of map.get('element_category') ?? []) add(`category:${String(row.id)}`, row.content_json);
  return seeds;
}
