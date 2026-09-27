// Actual native relation-type, relation and relation-purging trash originals:
// rebuilt through the renderer use cases (useEntityRelationTypes,
// useEntityRelations and the trash paths of useBookElement, useBookNode and
// useStoryline with deleteEntityRelationsInTransaction) on the prior native
// database, then replayed by the production TS reducer on an independent copy
// and compared with the native databases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import * as Y from 'yjs';
import { ALL_ENTITY_KINDS, isStructuralEntityKind, STRUCTURAL_ENTITY_KINDS, type EntityKind, type EntityRefTargetKind } from '../src/renderer/domain/entity-kinds';
import {
  normalizeRelationTypeDefinition, validateRelationAgainstType, type EntityRelationType, type EntityRelationTypeDefinition,
} from '../src/renderer/domain/entity-relation-type';
import { parseKv } from '../src/renderer/domain/kv';
import { deriveNodeStorylineState } from '../src/renderer/domain/node-storyline-state';
import type { Storyline } from '../src/renderer/domain/storyline';
import type { DbExecutor, DbTransaction } from '../src/renderer/lib/db';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { EntityRelationTable, NodeStorylineLinkTable } from '../src/renderer/schema/drizzle';
import { createElementCategoryRepository } from '../src/renderer/sqlite-repo/element-category-repo';
import { createBookElementSqliteRepository } from '../src/renderer/sqlite-repo/element-repo';
import { createEntityRelationTypeRepository } from '../src/renderer/sqlite-repo/entity-relation-type-repo';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { createNodeStorylineLinkRepository } from '../src/renderer/sqlite-repo/node-storyline-link-repo';
import { createStorylineRepository } from '../src/renderer/sqlite-repo/storyline-repo';
import { createAuthoredTransactionRunner } from '../src/renderer/sync/journal/authored-transaction';
import type { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
import { appendAuthoredNodeStorylineProjectionInTransaction } from '../src/renderer/sync/journal/storyline-membership';
import { compareUtf8Bytewise, decodeCanonicalCbor, type CanonicalCborValue, type SyncChangeSetV1 } from '../src/renderer/sync/protocol';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';
import { deleteEntityRelationsInTransaction } from '../src/renderer/usecase/entity-relation-cleanup';
import type { AtomicSyncWriter } from '../src/renderer/usecase/sync-helpers';
import { appendAuthoredLifecycleRestoreInTransaction, isRestorableSyncEntityKind } from '../src/renderer/usecase/sync-lifecycle-restore';

const option = (name: string) => {
  const value = process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  assert(value, `${name} is required`);
  return path.resolve(value);
};
const input = option('--input');
const output = option('--output');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const tables = [
  'project', 'book_node', 'node_content', 'element_category', 'element', 'entity_kv_entry', 'storylines', 'node_storyline_link',
  'entity_relation', 'entity_relation_type', 'entity_relation_type_endpoint_kind',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
// Relation commands and trash touch no project, body, fact, category or order
// row; no body owner is open, so no checkpoint is re-stamped.
const preservedTables = [
  'project', 'node_content', 'element_category', 'entity_kv_entry', 'sync_order_register', 'sync_conflict',
  'sync_yjs_materialization_receipt', 'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
// Authority rows the renderer's own local authored transactions write.
const rendererAuthorityTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_entity_lifecycle', 'sync_field_clock',
  'sync_set_tag', 'sync_order_register', 'sync_generation_writer_state',
];
// Domain rows the renderer use cases write themselves.
const rendererDomainTables = [
  'entity_relation', 'entity_relation_type', 'entity_relation_type_endpoint_kind', 'element', 'book_node', 'storylines', 'node_storyline_link',
] as const;
type DomainTable = typeof rendererDomainTables[number];
// Body owner rows; no relation or trash original may touch them.
const ownerTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance', 'sync_yjs_materialization_receipt'];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
];
const exemptions = [
  'The renderer repository softDelete (element, node) and softDeleteStoryline stamp deleted_at/updated_at of the trashed row with the wall clock; native and the originals use the authored clock.',
  'Host-chosen relation-type and relation IDs (renderer uuidv7) and the use-case clock are injected from the native result; the renderer computes every normalization, canonical endpoint order, purge set and order, membership projection and wire byte itself.',
];
const localOnlyEffects = [
  'Storyline trash removes the link of a trashed chapter to the trashed storyline locally (native and the renderer alike, DELETE by storyline_id) without an original, since membership is projected for live chapters only; a receiving reducer keeps that node_storyline_link row. Tracked per row with exact values for every later step.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences: string[] = [];
const reducerDefects: string[] = [];
type Operation = 'createType' | 'addRelation' | 'retypeRelation' | 'updateType' | 'trashElement' | 'trashChapter' | 'trashStoryline'
  | 'deleteType';
const expectedOperations: Operation[] = ['createType', 'createType', 'createType', 'addRelation', 'addRelation', 'addRelation',
  'addRelation', 'retypeRelation', 'updateType', 'trashElement', 'trashChapter', 'trashStoryline', 'deleteType'];
// `${action} ${target kind}` of every original of a step, in journal order.
const expectedActions: string[][][] = [
  [['entity.create entity-relation-type']], [['entity.create entity-relation-type']], [['entity.create entity-relation-type']],
  [['entity.create entity-relation']], [['entity.create entity-relation']], [['entity.create entity-relation']], [['entity.create entity-relation']],
  [Array<string>(5).fill('field.set entity-relation')], [Array<string>(10).fill('field.set entity-relation-type')],
  [['entity.purge entity-relation', 'entity.purge entity-relation', 'entity.trash element']],
  [['entity.purge entity-relation', 'entity.trash node']],
  [['entity.purge entity-relation', 'set.remove membership', 'field.set node-storyline-primary', 'entity.trash storyline']],
  [['entity.purge entity-relation-type']],
];
const expectedFaults = [true, false, false, true, false, false, false, false, false, true, false, false, false];
const typeFields = ['description', 'locked', 'name', 'normalizedName', 'orientation', 'sourceKinds', 'sourceRole', 'systemKey', 'targetKinds', 'targetRole'];
const relationFields = ['fromId', 'fromKind', 'relationTypeId', 'toId', 'toKind'];
const typeKeys = ['createdAt', 'description', 'id', 'locked', 'name', 'normalizedName', 'orientation', 'projectId', 'sourceKinds', 'sourceRole',
  'systemKey', 'targetKinds', 'targetRole', 'updatedAt'];
const relationKeys = ['createdAt', 'fromId', 'fromKind', 'id', 'projectId', 'relationTypeId', 'toId', 'toKind', 'updatedAt'];
interface Definition {
  name: string;
  description?: string;
  orientation: 'directed' | 'symmetric';
  sourceRole?: string;
  targetRole?: string;
  sourceKinds: string[];
  targetKinds: string[];
}
type RelationTypeResult = EntityRelationType;
interface RelationResult {
  id: string; projectId: string; fromKind: string; fromId: string; toKind: string; toId: string; relationTypeId: string;
  createdAt: string; updatedAt: string;
}
interface RelationLibrary { types: RelationTypeResult[]; relations: RelationResult[] }
interface Fact { key: string; value: string }
interface ElementResult {
  id: string; projectId: string; categoryId: string | null; name: string; summary: string; aliases: string[]; groupName: string | null;
  facts: Fact[]; documentId: string; createdAt: string; updatedAt: string;
}
interface CategoryResult {
  id: string; projectId: string; name: string; color: string; templateFacts: Fact[]; documentId: string; createdAt: string; updatedAt: string;
}
interface ElementLibrary { categories: CategoryResult[]; elements: ElementResult[]; trashedElements: ElementResult[]; trashedCategories: CategoryResult[] }
interface StorylineResult {
  id: string; projectId: string; name: string; color: string; summary: string; orderKey: number; facts: Fact[]; documentId: string;
  createdAt: string; updatedAt: string;
}
interface Membership { chapterId: string; storylineIds: string[]; primary: string | null }
interface StorylineLibrary { storylines: StorylineResult[]; trashedStorylines: StorylineResult[]; memberships: Membership[] }
interface Original { encodedBase64: string; mutationCount: number; createdAt: string }
interface Command {
  action: string;
  definition?: Definition;
  relationTypeId?: string;
  relationId?: string;
  swap?: boolean;
  fromKind?: string;
  fromId?: string;
  toKind?: string;
  toId?: string;
  elementId?: string;
  storylineId?: string;
}
/** The bridge request, exactly as sent. */
interface Request { operation: string; handle: number; projectId: string; command?: Command; chapterId?: string }
interface Step {
  operation: Operation;
  request: Request;
  originals: Original[];
  afterDatabase: string;
  faultBeforeApply: boolean;
  result: RelationTypeResult | RelationResult | ElementResult | StorylineResult | null;
  library: RelationLibrary | ElementLibrary | StorylineLibrary | null;
}
interface Case {
  name: string;
  beforeDatabase: string;
  projectId: string;
  chapterIds: string[];
  entities: { category: string; elements: string[]; storyline: string };
  identity: { installationId: string; writerId: string; writerEpoch: string };
  steps: Step[];
}
type Row = Record<string, unknown>;
const isRelationStep = (operation: Operation) => !operation.startsWith('trash');
/** The bridge-test requests, rebuilt from the fixture's entities and the native IDs of created types and relations. */
function expectedRequests(fixture: Case): Request[] {
  const handle = fixture.steps[0]!.request.handle;
  assert(Number.isSafeInteger(handle) && handle > 0);
  const projectId = fixture.projectId;
  const [mira, oren, ash] = fixture.entities.elements as [string, string, string];
  const chapter = fixture.chapterIds[1]!;
  const storyline = fixture.entities.storyline;
  const typeId = (index: number) => (fixture.steps[index]!.result as RelationTypeResult).id;
  const [mentor, ally, cast] = [typeId(0), typeId(1), typeId(2)];
  const edge = (fixture.steps[3]!.result as RelationResult).id;
  const relations = (command: Command): Request => ({ operation: 'workspaceRelations', handle, projectId, command });
  const scoped = (operation: string, command: Command): Request => ({ operation, handle, projectId, command });
  const definition = (name: string, orientation: Definition['orientation'], roles: [string, string], source: string[], target: string[]): Definition =>
    ({ name, description: '', orientation, sourceRole: roles[0], targetRole: roles[1], sourceKinds: source, targetKinds: target });
  return [
    relations({ action: 'createType', definition: definition(' 师徒 ', 'directed', ['师父', '徒弟'], ['element'], ['element', 'node']) }),
    relations({ action: 'createType', definition: definition('同盟', 'symmetric', ['', ''], ['node', 'element'], ['element', 'node']) }),
    relations({ action: 'createType', definition: definition('出场', 'directed', ['故事线', '角色'], ['storyline', 'node'], ['element']) }),
    relations({ action: 'addRelation', fromKind: 'element', fromId: mira, toKind: 'element', toId: oren, relationTypeId: mentor }),
    relations({ action: 'addRelation', fromKind: 'node', fromId: chapter, toKind: 'element', toId: ash, relationTypeId: ally }),
    relations({ action: 'addRelation', fromKind: 'storyline', fromId: storyline, toKind: 'element', toId: mira, relationTypeId: cast }),
    relations({ action: 'addRelation', fromKind: 'storyline', fromId: storyline, toKind: 'element', toId: oren, relationTypeId: cast }),
    relations({ action: 'retypeRelation', relationId: edge, relationTypeId: mentor, swap: true }),
    relations({ action: 'updateType', relationTypeId: ally, definition: { name: '同盟', description: '并肩作战', orientation: 'symmetric',
      sourceKinds: ['node', 'element'], targetKinds: ['node', 'element'] } }),
    scoped('workspaceElements', { action: 'trashElement', elementId: mira }),
    { operation: 'workspaceTrashChapter', handle, projectId, chapterId: chapter },
    scoped('workspaceStorylines', { action: 'trashStoryline', storylineId: storyline }),
    relations({ action: 'deleteType', relationTypeId: cast }),
  ];
}
function database(name: string): string {
  assert.equal(path.basename(name), name);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/u);
  return path.join(path.dirname(input), name);
}
function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { hex: Buffer.from(value).toString('hex') };
  if (typeof value === 'bigint') {
    assert(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER));
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}
function raw(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}
function canonicalRows(values: Row[]): Row[] {
  return values.map(row => normalize(row) as Row)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function snapshot(db: DatabaseSync, names = [...tables, 'sync_generation_writer_state']) {
  return Object.fromEntries(names.map(table => [table, canonicalRows(raw(db, table))]));
}
function equalRows(table: string, actual: Row[], expected: Row[]) {
  if (isDeepStrictEqual(actual, expected)) return;
  const index = Math.max(0, actual.findIndex((row, i) => !isDeepStrictEqual(row, expected[i])));
  const summary = (value: unknown) => {
    const text = JSON.stringify(value) ?? 'undefined';
    return text.length > 1000 ? `${text.slice(0, 900)}… sha256:${sha(text)}` : text;
  };
  assert.fail(`${table} parity failed (${actual.length}/${expected.length} rows): `
    + `${summary(actual[index])} / ${summary(expected[index])}`);
}
/** Primary key of a compared domain row. */
function rowKey(table: string, row: Row): string {
  if (table === 'entity_relation_type_endpoint_kind') return `${String(row.relation_type_id)}\0${String(row.side)}\0${String(row.entity_kind)}`;
  if (table === 'node_storyline_link') return `${String(row.node_id)}\0${String(row.storyline_id)}`;
  return String(row.id);
}
function documentIds(db: DatabaseSync): string[] {
  return [...new Set([...raw(db, 'yjs_document_revision'), ...raw(db, 'yjs_snapshots'), ...raw(db, 'yjs_updates')]
    .map(item => String(item.document_id)))].sort();
}
function fullState(db: DatabaseSync, docId: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    const stored = db.prepare('SELECT state_blob FROM yjs_snapshots WHERE document_id=?').get(docId);
    if (stored) {
      assert(stored.state_blob instanceof Uint8Array);
      Y.applyUpdate(doc, stored.state_blob);
    }
    for (const item of db.prepare('SELECT update_blob FROM yjs_updates WHERE document_id=? ORDER BY id').all(docId)) {
      assert(item.update_blob instanceof Uint8Array);
      Y.applyUpdate(doc, item.update_blob);
    }
    assert.equal(doc.store.pendingStructs, null);
    assert.equal(doc.store.pendingDs, null);
    assert(doc.getXmlFragment('default').length > 0, 'Native bodies keep at least one block');
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}
function causedByFault(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error.message.includes('synthetic relation receipt fault')) return true;
    error = (error as Error & { cause?: unknown }).cause;
  }
  return false;
}
/** A check that must reject its corrupted input (non-vacuity). */
function rejects(label: string, check: () => void): string {
  assert.throws(check, (error: unknown) => error instanceof assert.AssertionError, `Non-vacuity: ${label} must be rejected`);
  return 'rejected';
}
function lifecycle(db: DatabaseSync, generation: string, kind: string, id: string) {
  const value = db.prepare('SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?')
    .get(generation, kind, id);
  return value ? { incarnation: Number(value.incarnation), state: String(value.state) } : null;
}
const incarnationOf = (db: DatabaseSync, generation: string, kind: string, id: string) =>
  lifecycle(db, generation, kind, id)?.incarnation ?? 0;
const endpointKey = (kind: string, id: string) => `${kind}:${id}`;

/** A relation type as stored: its row and endpoint rows, kinds in canonical order. */
function storedType(db: DatabaseSync, id: string): RelationTypeResult | null {
  const row = db.prepare('SELECT * FROM entity_relation_type WHERE id=?').get(id);
  if (!row) return null;
  const endpoints = db.prepare('SELECT side,entity_kind FROM entity_relation_type_endpoint_kind WHERE relation_type_id=?').all(id);
  const side = (name: string) => endpoints.filter(item => item.side === name).map(item => String(item.entity_kind));
  const source = side('source');
  const target = side('target');
  assert.equal(new Set(source).size, source.length, 'Endpoint kinds are unique');
  assert.equal(new Set(target).size, target.length, 'Endpoint kinds are unique');
  const sourceKinds = ALL_ENTITY_KINDS.filter(kind => source.includes(kind));
  const targetKinds = STRUCTURAL_ENTITY_KINDS.filter(kind => target.includes(kind));
  assert.equal(sourceKinds.length, source.length, 'Source kinds are entity kinds');
  assert.equal(targetKinds.length, target.length, 'Target kinds are structural kinds');
  return { id, projectId: String(row.project_id), name: String(row.name), normalizedName: String(row.normalized_name),
    description: String(row.description), orientation: row.orientation as RelationTypeResult['orientation'],
    systemKey: row.system_key === null ? null : String(row.system_key) as RelationTypeResult['systemKey'],
    locked: Number(row.locked) === 1, sourceRole: String(row.source_role), targetRole: String(row.target_role),
    sourceKinds, targetKinds, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
/** The ten authored fields of a type, as its create seed and field registers carry them. */
function typeSeed(type: RelationTypeResult): Record<string, CanonicalCborValue> {
  return Object.fromEntries(typeFields.map(field => [field, type[field as keyof RelationTypeResult] as CanonicalCborValue]));
}
function storedRelation(db: DatabaseSync, id: string): RelationResult | null {
  const row = db.prepare('SELECT * FROM entity_relation WHERE id=?').get(id);
  if (!row) return null;
  return { id, projectId: String(row.project_id), fromKind: String(row.from_kind), fromId: String(row.from_id), toKind: String(row.to_kind),
    toId: String(row.to_id), relationTypeId: String(row.relation_type_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
/** Relations touching one entity, independently of the renderer's query shape. */
function relationsTouching(db: DatabaseSync, projectId: string, kind: string, id: string): string[] {
  return db.prepare('SELECT id FROM entity_relation WHERE project_id=?').all(projectId).map(row => storedRelation(db, String(row.id))!)
    .filter(item => (item.fromKind === kind && item.fromId === id) || (item.toKind === kind && item.toId === id))
    .map(item => item.id).sort(compareUtf8Bytewise);
}
/** Stored relations satisfy their type: endpoints allowed, symmetric edges canonical, no self-edge, no semantic duplicate. */
function verifyRelationInvariants(db: DatabaseSync, projectId: string): number {
  const relations = db.prepare('SELECT id FROM entity_relation WHERE project_id=?').all(projectId).map(row => storedRelation(db, String(row.id))!);
  const edges = new Set<string>();
  for (const relation of relations) {
    const type = storedType(db, relation.relationTypeId);
    assert(type && type.projectId === projectId, `Relation ${relation.id} names a type of the project`);
    assert(type.sourceKinds.includes(relation.fromKind as EntityKind), `Relation ${relation.id} source kind is allowed`);
    assert(type.targetKinds.includes(relation.toKind as EntityRefTargetKind), `Relation ${relation.id} target kind is allowed`);
    if (type.orientation === 'symmetric') {
      assert(compareUtf8Bytewise(endpointKey(relation.fromKind, relation.fromId), endpointKey(relation.toKind, relation.toId)) <= 0,
        `Symmetric relation ${relation.id} is stored canonically`);
    }
    assert(endpointKey(relation.fromKind, relation.fromId) !== endpointKey(relation.toKind, relation.toId), 'No self-edge');
    const edge = JSON.stringify([relation.fromKind, relation.fromId, relation.toKind, relation.toId, relation.relationTypeId]);
    assert(!edges.has(edge), 'No semantic duplicate');
    edges.add(edge);
  }
  return relations.length;
}

/** useEntityRelations.loadInitial: the store's relation rows. */
async function storeRelations(client: DbExecutor, projectId: string): Promise<RelationResult[]> {
  const rows = await client.select().from(EntityRelationTable).where(eq(EntityRelationTable.projectId, projectId));
  return rows.map(row => ({ id: row.id, projectId: row.projectId, fromKind: row.fromKind, fromId: row.fromId, toKind: row.toKind,
    toId: row.toId, relationTypeId: row.relationTypeId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
}
/** The relation library as the production repositories (useEntityRelations.loadInitial) read it back. */
async function relationLibrary(client: DbExecutor, projectId: string): Promise<RelationLibrary> {
  return { types: await createEntityRelationTypeRepository(projectId, client).list(), relations: await storeRelations(client, projectId) };
}
async function elementLibrary(client: DbExecutor, projectId: string): Promise<ElementLibrary> {
  const elements = createBookElementSqliteRepository(projectId, client);
  const categories = createElementCategoryRepository(projectId, client);
  const element = (item: Awaited<ReturnType<typeof elements.findAll>>[number]): ElementResult => {
    assert.equal(item.portraitAssetId, null);
    return { id: item.id, projectId: item.projectId, categoryId: item.categoryId, name: item.name, summary: item.summary,
      aliases: item.aliases, groupName: item.groupName, facts: parseKv(item.kvJson), documentId: `element:${item.id}`,
      createdAt: item.createdAt, updatedAt: item.updatedAt };
  };
  const category = (item: Awaited<ReturnType<typeof categories.findAll>>[number]): CategoryResult => ({ id: item.id, projectId: item.projectId,
    name: item.name, color: item.color, templateFacts: parseKv(item.elementTemplateKvJson), documentId: `category:${item.id}`,
    createdAt: item.createdAt, updatedAt: item.updatedAt });
  const newestFirst = <T extends { deletedAt: string }>(items: T[]) =>
    items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  return {
    categories: (await categories.findAll()).map(category),
    elements: (await elements.findAll()).map(element),
    trashedElements: newestFirst(await elements.findTrashed()).map(({ deletedAt: _deletedAt, ...item }) => element(item)),
    trashedCategories: newestFirst(await categories.findTrashed()).map(({ deletedAt: _deletedAt, ...item }) => category(item)),
  };
}
async function storylineLibrary(client: DbExecutor, projectId: string): Promise<StorylineLibrary> {
  const repository = createStorylineRepository(projectId, client);
  const result = (item: Storyline): StorylineResult => ({ id: item.id, projectId: item.projectId, name: item.name, color: item.color,
    summary: item.summary, orderKey: item.orderKey, facts: parseKv(item.kvJson), documentId: `storyline:${item.id}`,
    createdAt: item.createdAt, updatedAt: item.updatedAt });
  const trashed = (await repository.getTrashedStorylines())
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  const chapters = (await createBookNodeSqliteRepository(projectId, client).findAll()).filter(node => node.kind === 'chapter');
  const { storylineNodeMapping, primaryStorylineByNode } = deriveNodeStorylineState(
    await createNodeStorylineLinkRepository(projectId, client).getStorylineLinksByNodeIds(chapters.map(node => node.id)));
  return {
    storylines: (await repository.getStorylinesByProject()).map(result),
    trashedStorylines: trashed.map(({ deletedAt: _deletedAt, ...item }) => result(item)),
    memberships: chapters.map(node => ({ chapterId: node.id,
      storylineIds: Object.keys(storylineNodeMapping).filter(id => storylineNodeMapping[id]!.includes(node.id)).sort(compareUtf8Bytewise),
      primary: primaryStorylineByNode[node.id] ?? null })),
  };
}
async function readBack<T>(file: string, scratch: string, read: (client: DbExecutor) => Promise<T>): Promise<T> {
  copyFileSync(file, scratch);
  const gateway = new ProductFileBackedSqliteGateway(scratch);
  try { return await read(gateway.client()); } finally { await gateway.close(); }
}
const byName = (a: RelationTypeResult, b: RelationTypeResult) => compareUtf8Bytewise(a.name, b.name) || compareUtf8Bytewise(a.id, b.id);

interface Target { kind: 'element' | 'node' | 'storyline' | null; id: string | null }
function resolve(step: Step): Target {
  switch (step.operation) {
    case 'trashElement': return { kind: 'element', id: step.request.command!.elementId! };
    case 'trashChapter': return { kind: 'node', id: step.request.chapterId! };
    case 'trashStoryline': return { kind: 'storyline', id: step.request.command!.storylineId! };
    default: return { kind: null, id: null };
  }
}

/**
 * Mirror each renderer use case's authored effect (through
 * withAtomicSyncTransaction and the production authored runner, whose
 * post-write observer validates with the production kernel) on a copy of the
 * prior native database. Store reads become the repository reads that hydrate them.
 */
async function rendererOriginals(fixture: Case, step: Step, target: Target, prior: string, scratch: string) {
  copyFileSync(prior, scratch);
  invalidateSqliteReducerStateCache();
  const gateway = new ProductFileBackedSqliteGateway(scratch);
  const client = gateway.client();
  const times = step.originals.map(original => original.createdAt);
  let committed = 0;
  const current = () => times[Math.min(committed, times.length - 1)]!;
  const run = createAuthoredTransactionRunner({
    database: () => client,
    identity: async () => ({ installationId: fixture.identity.installationId,
      createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) }),
    clock: () => ({ nowMs: Date.parse(current()), nowIso: current() }),
    syncGenerationIds: {
      createSyncGenerationId: () => assert.fail('Existing projects keep their sync generation'),
      createProjectSyncId: () => assert.fail('Existing projects keep their project sync id'),
    },
    onCommitted: () => { committed += 1; },
  });
  const projectId = fixture.projectId;
  // sync-helpers withAtomicSyncTransaction, bound to this runner.
  const atomic = <T>(work: (tx: DbTransaction, sync: AtomicSyncWriter, changes: SyncChangeBuilder) => Promise<T>) =>
    run(projectId, 'domain.authored-write', async ({ tx, changes }) => {
      const sync: AtomicSyncWriter = async (entityType, mutationType, entityId, mutationProjectId, payload, parentId) => {
        assert.equal(mutationProjectId, projectId);
        if (mutationType === 'restore' && isRestorableSyncEntityKind(entityType)) {
          assert.equal(parentId, undefined);
          await appendAuthoredLifecycleRestoreInTransaction(tx, changes, { projectId, entityType, entityId });
          return;
        }
        appendAuthoredDomainMutation(changes, { entityType, mutationType, entityId, projectId, payload, parentId });
      };
      return work(tx, sync, changes);
    });
  const startRowid = Number(gateway.database.prepare('SELECT COALESCE(MAX(rowid),0) AS id FROM sync_change_set').get()!.id);
  // The use cases' `new Date().toISOString()`, pinned to the authored clock.
  const now = current;
  const command = step.request.command;
  // The store's relation types and relations are the loadInitial repository reads.
  const storeTypes = await createEntityRelationTypeRepository(projectId, client).list();
  const relations = await storeRelations(client, projectId);
  let purged: string[] | null = null;
  try {
    switch (step.operation) {
      case 'createType': {
        // useEntityRelationTypes.createRelationType(definition); the ID is host-chosen.
        const normalized = normalizeRelationTypeDefinition(command!.definition as EntityRelationTypeDefinition);
        assert(!storeTypes.some(type => type.projectId === projectId && type.normalizedName === normalized.normalizedName),
          `关系类型「${normalized.name}」已存在`);
        const at = now();
        const value: EntityRelationType = { id: (step.result as RelationTypeResult).id, projectId, ...normalized, systemKey: null,
          locked: false, createdAt: at, updatedAt: at };
        await atomic(async (tx, sync) => {
          await createEntityRelationTypeRepository(projectId, tx).create(value);
          await sync('entityRelationType', 'create', value.id, projectId, { ...value });
          return value;
        });
        break;
      }
      case 'updateType': {
        // useEntityRelationTypes.updateRelationType(id, definition).
        const id = command!.relationTypeId!;
        const previousType = storeTypes.find(type => type.id === id && type.projectId === projectId);
        assert(previousType, '关系类型不存在或不属于当前项目');
        assert(!previousType.locked, '内建关系类型不能修改');
        const normalized = normalizeRelationTypeDefinition(command!.definition as EntityRelationTypeDefinition);
        assert(!storeTypes.some(type => type.id !== id && type.projectId === projectId && type.normalizedName === normalized.normalizedName));
        const nextType: EntityRelationType = { ...previousType, ...normalized, updatedAt: now() };
        for (const relation of relations.filter(item => item.projectId === projectId && item.relationTypeId === id)) {
          const checked = validateRelationAgainstType(nextType, relation as Parameters<typeof validateRelationAgainstType>[1]);
          assert(checked.ok, `关系「${relation.id}」不符合新约束`);
          assert.deepEqual([checked.relation.fromKind, checked.relation.fromId, checked.relation.toKind, checked.relation.toId],
            [relation.fromKind, relation.fromId, relation.toKind, relation.toId], `关系「${relation.id}」需要先交换两端`);
        }
        await atomic(async (tx, sync) => {
          await createEntityRelationTypeRepository(projectId, tx).update(nextType);
          await sync('entityRelationType', 'update', nextType.id, projectId, { ...nextType });
          return nextType;
        });
        break;
      }
      case 'deleteType': {
        // useEntityRelationTypes.deleteRelationType(id).
        const id = command!.relationTypeId!;
        const value = storeTypes.find(type => type.id === id && type.projectId === projectId);
        assert(value && !value.locked);
        await atomic(async (tx, sync) => {
          await createEntityRelationTypeRepository(projectId, tx).remove(id);
          await sync('entityRelationType', 'delete', id, projectId);
        });
        break;
      }
      case 'addRelation': {
        // useEntityRelations.addRelation -> addTypedRelation(..., createRelationType=false); the ID is host-chosen.
        let { fromKind, fromId, toKind, toId } = command! as Required<Pick<Command, 'fromKind' | 'fromId' | 'toKind' | 'toId'>>;
        const relationTypeId = command!.relationTypeId!;
        const relationType = storeTypes.find(candidate => candidate.id === relationTypeId && candidate.projectId === projectId)
          ?? await createEntityRelationTypeRepository(projectId, client).findById(relationTypeId);
        assert(relationType, '关系类型不存在或不属于当前项目');
        assert(isStructuralEntityKind(toKind), 'toKind is structural');
        assert.equal(relationType.projectId, projectId);
        const checked = validateRelationAgainstType(relationType, { fromKind, fromId, toKind, toId } as Parameters<typeof validateRelationAgainstType>[1]);
        assert(checked.ok, 'The exported relation satisfies its type');
        ({ fromKind, fromId, toKind, toId } = checked.relation);
        assert(!relations.some(relation => relation.projectId === projectId && relation.fromKind === fromKind && relation.fromId === fromId
          && relation.toKind === toKind && relation.toId === toId && relation.relationTypeId === relationType.id), 'The exported edge is new');
        const at = now();
        const newRow = { id: (step.result as RelationResult).id, projectId, fromKind, fromId, toKind, toId, relationTypeId: relationType.id,
          createdAt: at, updatedAt: at };
        await atomic(async (tx, sync) => {
          await tx.insert(EntityRelationTable).values(newRow);
          await sync('entityRelation', 'create', newRow.id, projectId, { id: newRow.id, fromKind: newRow.fromKind, fromId: newRow.fromId,
            toKind: newRow.toKind, toId: newRow.toId, relationTypeId: newRow.relationTypeId });
          return newRow;
        });
        break;
      }
      case 'retypeRelation': {
        // useEntityRelations.updateRelationType(id, relationTypeId, { swapEndpoints }).
        const id = command!.relationId!;
        const relationTypeId = command!.relationTypeId!;
        const existing = relations.find(relation => relation.id === id && relation.projectId === projectId);
        assert(existing);
        const relationType = storeTypes.find(candidate => candidate.id === relationTypeId && candidate.projectId === projectId)
          ?? await createEntityRelationTypeRepository(projectId, client).findById(relationTypeId);
        assert(relationType);
        const candidate = command!.swap
          ? { fromKind: existing.toKind, fromId: existing.toId, toKind: existing.fromKind, toId: existing.fromId }
          : { fromKind: existing.fromKind, fromId: existing.fromId, toKind: existing.toKind, toId: existing.toId };
        assert(isStructuralEntityKind(candidate.toKind), '交换后目标端不是结构实体');
        const checked = validateRelationAgainstType(relationType, candidate as Parameters<typeof validateRelationAgainstType>[1]);
        assert(checked.ok, 'The exported retype satisfies its type');
        const at = now();
        const nextRow = { ...existing, ...checked.relation, relationTypeId, updatedAt: at };
        assert(!relations.some(relation => relation.id !== id && relation.projectId === projectId && relation.fromKind === nextRow.fromKind
          && relation.fromId === nextRow.fromId && relation.toKind === nextRow.toKind && relation.toId === nextRow.toId
          && relation.relationTypeId === relationTypeId), '相同类型的关系已存在');
        await atomic(async (tx, sync) => {
          await tx.update(EntityRelationTable).set({ fromKind: nextRow.fromKind, fromId: nextRow.fromId, toKind: nextRow.toKind,
            toId: nextRow.toId, relationTypeId, updatedAt: at })
            .where(and(eq(EntityRelationTable.id, id), eq(EntityRelationTable.projectId, projectId)));
          await sync('entityRelation', 'update', id, projectId, { fromKind: nextRow.fromKind, fromId: nextRow.fromId, toKind: nextRow.toKind,
            toId: nextRow.toId, relationTypeId });
          return nextRow;
        });
        break;
      }
      case 'trashElement':
        // useBookElement.removeElement with the trash feature.
        await atomic(async (tx, sync) => {
          purged = await deleteEntityRelationsInTransaction(tx, sync, projectId, 'element', target.id!);
          const result = await createBookElementSqliteRepository(projectId, tx).softDelete(target.id!);
          await sync('element', 'softDelete', target.id!, projectId);
          return result;
        });
        break;
      case 'trashChapter':
        // useBookNode.deleteNode with the trash feature (a chapter: no drift unbinds).
        await atomic(async (tx, sync) => {
          purged = await deleteEntityRelationsInTransaction(tx, sync, projectId, 'node', target.id!);
          const result = await createBookNodeSqliteRepository(projectId, tx).softDelete(target.id!);
          await sync('node', 'softDelete', target.id!, projectId);
          return result;
        });
        break;
      case 'trashStoryline': {
        // useStoryline.deleteStoryline with the trash feature; the store's
        // primary/forward maps are loadNodeStorylineMapping over live nodes.
        const id = target.id!;
        const liveNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).map(node => node.id);
        const { storylineNodeMapping, primaryStorylineByNode } = deriveNodeStorylineState(
          await createNodeStorylineLinkRepository(projectId, client).getStorylineLinksByNodeIds(liveNodes));
        const nodesGoingUnaffiliated = Object.entries(primaryStorylineByNode).filter(([, slId]) => slId === id).map(([nid]) => nid);
        const nodesLosingSecondaryMembership = (storylineNodeMapping[id] ?? []).filter(nodeId => !nodesGoingUnaffiliated.includes(nodeId));
        await atomic(async (tx, sync, changes) => {
          purged = await deleteEntityRelationsInTransaction(tx, sync, projectId, 'storyline', id);
          if (nodesGoingUnaffiliated.length > 0) {
            await tx.delete(NodeStorylineLinkTable).where(inArray(NodeStorylineLinkTable.nodeId, nodesGoingUnaffiliated));
          }
          await tx.delete(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.storylineId, id));
          const affectedNodeIds = [...new Set([...nodesGoingUnaffiliated, ...nodesLosingSecondaryMembership])].sort(compareUtf8Bytewise);
          for (const nodeId of affectedNodeIds) {
            await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, { projectId, nodeId });
          }
          await createStorylineRepository(projectId, tx).softDeleteStoryline(id);
          await sync('storyline', 'softDelete', id, projectId);
        });
        break;
      }
    }
    assert.equal(committed, step.originals.length, 'The renderer commits one original per native original');
    const changeSets: SyncChangeSetV1[] = [];
    for (const row of gateway.database.prepare("SELECT encoded_bytes FROM sync_change_set WHERE origin='local' AND rowid>? ORDER BY rowid").all(startRowid)) {
      assert(row.encoded_bytes instanceof Uint8Array);
      const decoded = await decodeSyncChangeSetV1(row.encoded_bytes);
      assert(decoded.ok, 'Renderer original must decode');
      changeSets.push(decoded.value);
    }
    return { changeSets, purged: purged as string[] | null, authority: snapshot(gateway.database, rendererAuthorityTables),
      rows: Object.fromEntries(rendererDomainTables.map(table => [table, raw(gateway.database, table)])) as Record<DomainTable, Row[]> };
  } finally {
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}

/** A chapter's link projection: storylines in UTF-8 order and its primary. */
function links(db: DatabaseSync, chapterId: string): Membership {
  const rows = db.prepare('SELECT storyline_id,is_primary FROM node_storyline_link WHERE node_id=?').all(chapterId);
  const primaries = rows.filter(row => Number(row.is_primary) === 1).map(row => String(row.storyline_id));
  assert(primaries.length <= 1, 'At most one primary per chapter');
  return { chapterId, storylineIds: rows.map(row => String(row.storyline_id)).sort(compareUtf8Bytewise), primary: primaries[0] ?? null };
}
/** Live membership OR-set tags of one chapter: removed_by NULL at the storyline's live incarnation (0 without lifecycle). */
function liveTags(db: DatabaseSync, generation: string, chapterId: string): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT owner_id,incarnation,add_tag,value_cbor FROM sync_set_tag WHERE sync_generation_id=?
      AND owner_kind='membership' AND set_key='membership' AND value_key=? AND removed_by_change_set_id IS NULL`).all(generation, chapterId)) {
    const owner = lifecycle(db, generation, 'storyline', String(row.owner_id));
    const live = owner ? owner.state === 'live' ? owner.incarnation : -1 : 0;
    if (live !== Number(row.incarnation)) continue;
    assert(row.value_cbor instanceof Uint8Array);
    const decoded = decodeCanonicalCbor(row.value_cbor);
    assert(decoded.ok && decoded.value === null, 'Membership tags carry a null value');
    tags.set(String(row.owner_id), [...tags.get(String(row.owner_id)) ?? [], String(row.add_tag)].sort(compareUtf8Bytewise));
  }
  return tags;
}
/** The chapter's primary-storyline register at its current node incarnation. */
function primaryRegister(db: DatabaseSync, generation: string, chapterId: string): string | null | undefined {
  const clock = db.prepare(`SELECT change_set_id,mutation_index FROM sync_field_clock WHERE sync_generation_id=?
    AND target_kind='node-storyline-primary' AND target_id=? AND incarnation=? AND field_key='field:storylineId'`)
    .get(generation, chapterId, incarnationOf(db, generation, 'node', chapterId));
  if (!clock) return undefined;
  const mutation = db.prepare('SELECT payload_cbor FROM sync_mutation WHERE change_set_id=? AND mutation_index=?')
    .get(clock.change_set_id as string, clock.mutation_index as number);
  assert(mutation && mutation.payload_cbor instanceof Uint8Array);
  const decoded = decodeCanonicalCbor(mutation.payload_cbor);
  assert(decoded.ok);
  const payload = decoded.value as { field: string; value: string | null };
  assert.equal(payload.field, 'storylineId');
  return payload.value;
}
/** node_storyline_link of every live chapter equals its live OR-set tags and primary register. */
function verifyMembershipAuthority(db: DatabaseSync, generation: string, projectId: string): number {
  const chapters = db.prepare("SELECT id FROM book_node WHERE project_id=? AND kind='chapter' AND deleted_at IS NULL").all(projectId)
    .map(row => String(row.id));
  for (const chapterId of chapters) {
    const projected = links(db, chapterId);
    assert.deepEqual([...liveTags(db, generation, chapterId).keys()].sort(compareUtf8Bytewise), projected.storylineIds,
      `Links of ${chapterId} project its live membership tags`);
    assert.equal(primaryRegister(db, generation, chapterId) ?? null, projected.primary, `Primary link of ${chapterId} projects its register`);
  }
  return chapters.length;
}

type Mutation = SyncChangeSetV1['mutations'][number];
type Expected = Pick<Mutation, 'action' | 'target' | 'payload'>;
/**
 * Every mutation target, incarnation and payload against the native
 * after-state, rebuilt independently of both authors.
 */
function verifyMutations(prior: DatabaseSync, after: DatabaseSync, generation: string, fixture: Case, step: Step,
  changeSets: SyncChangeSetV1[], target: Target): string[] {
  const projectId = fixture.projectId;
  const command = step.request.command;
  const actual: Expected[] = changeSets.flatMap(changeSet => changeSet.mutations)
    .map(({ action, target: mutationTarget, payload }) => ({ action, target: mutationTarget, payload }));
  const entity = (kind: string, id: string, incarnation: number) => ({ family: 'entity' as const, kind, id, incarnation });
  const expected: Expected[] = [];
  const purgedRelations: string[] = [];
  switch (step.operation) {
    case 'createType': {
      const id = (step.result as RelationTypeResult).id;
      assert.equal(storedType(prior, id), null, 'A created type ID is fresh');
      assert.equal(lifecycle(prior, generation, 'entity-relation-type', id), null);
      assert.deepEqual(lifecycle(after, generation, 'entity-relation-type', id), { incarnation: 0, state: 'live' });
      const type = storedType(after, id)!;
      // The stored definition is the normalized command.
      assert.deepEqual(typeSeed(type), { ...normalizeRelationTypeDefinition(command!.definition as EntityRelationTypeDefinition),
        systemKey: null, locked: false });
      expected.push({ action: 'entity.create', target: entity('entity-relation-type', id, 0), payload: { seed: typeSeed(type) } });
      break;
    }
    case 'updateType': {
      const id = command!.relationTypeId!;
      const [before, type] = [storedType(prior, id)!, storedType(after, id)!];
      assert.deepEqual(typeSeed(type), { ...normalizeRelationTypeDefinition(command!.definition as EntityRelationTypeDefinition),
        systemKey: before.systemKey, locked: before.locked });
      assert.notDeepEqual(typeSeed(type), typeSeed(before), 'The exported update changes the type');
      const incarnation = incarnationOf(after, generation, 'entity-relation-type', id);
      assert.deepEqual(lifecycle(after, generation, 'entity-relation-type', id), { incarnation, state: 'live' });
      // Every authored field, in UTF-8 field order.
      for (const field of [...typeFields].sort(compareUtf8Bytewise)) {
        expected.push({ action: 'field.set', target: entity('entity-relation-type', id, incarnation), payload: { field, value: typeSeed(type)[field] } });
      }
      break;
    }
    case 'deleteType': {
      const id = command!.relationTypeId!;
      assert(storedType(prior, id), 'The deleted type existed');
      assert.equal(storedType(after, id), null, 'A purged type row is removed');
      assert.deepEqual(after.prepare('SELECT * FROM entity_relation_type_endpoint_kind WHERE relation_type_id=?').all(id), [], 'Endpoint rows cascade');
      assert.equal(prior.prepare('SELECT 1 FROM entity_relation WHERE relation_type_id=?').get(id), undefined, 'Only an unused type is deleted');
      const before = lifecycle(prior, generation, 'entity-relation-type', id)!;
      assert.equal(before.state, 'live');
      assert.deepEqual(lifecycle(after, generation, 'entity-relation-type', id), { incarnation: before.incarnation, state: 'purged' });
      expected.push({ action: 'entity.purge', target: entity('entity-relation-type', id, before.incarnation), payload: {} });
      break;
    }
    case 'addRelation': {
      const id = (step.result as RelationResult).id;
      assert.equal(storedRelation(prior, id), null, 'A created relation ID is fresh');
      assert.equal(lifecycle(prior, generation, 'entity-relation', id), null);
      assert.deepEqual(lifecycle(after, generation, 'entity-relation', id), { incarnation: 0, state: 'live' });
      const relation = storedRelation(after, id)!;
      const type = storedType(after, relation.relationTypeId)!;
      const requested = [command!.fromKind, command!.fromId, command!.toKind, command!.toId];
      const stored = [relation.fromKind, relation.fromId, relation.toKind, relation.toId];
      if (type.orientation === 'symmetric') {
        // Symmetric edges keep the bytewise-smaller `kind:id` first.
        const [left, right] = [endpointKey(command!.fromKind!, command!.fromId!), endpointKey(command!.toKind!, command!.toId!)];
        assert.deepEqual(stored, compareUtf8Bytewise(left, right) <= 0 ? requested
          : [command!.toKind, command!.toId, command!.fromKind, command!.fromId]);
      } else assert.deepEqual(stored, requested, 'A directed edge keeps its direction');
      assert.equal(relation.relationTypeId, command!.relationTypeId);
      expected.push({ action: 'entity.create', target: entity('entity-relation', id, 0), payload: { seed: Object.fromEntries(
        relationFields.map(field => [field, relation[field as keyof RelationResult]])) } });
      break;
    }
    case 'retypeRelation': {
      const id = command!.relationId!;
      const [before, relation] = [storedRelation(prior, id)!, storedRelation(after, id)!];
      assert.deepEqual([relation.fromKind, relation.fromId, relation.toKind, relation.toId, relation.relationTypeId],
        command!.swap ? [before.toKind, before.toId, before.fromKind, before.fromId, command!.relationTypeId]
          : [before.fromKind, before.fromId, before.toKind, before.toId, command!.relationTypeId]);
      const incarnation = incarnationOf(after, generation, 'entity-relation', id);
      assert.deepEqual(lifecycle(after, generation, 'entity-relation', id), { incarnation, state: 'live' });
      for (const field of [...relationFields].sort(compareUtf8Bytewise)) {
        expected.push({ action: 'field.set', target: entity('entity-relation', id, incarnation), payload: { field, value: relation[field as keyof RelationResult] } });
      }
      break;
    }
    case 'trashElement':
    case 'trashChapter':
    case 'trashStoryline': {
      const { kind, id } = target as { kind: 'element' | 'node' | 'storyline'; id: string };
      const touching = relationsTouching(prior, projectId, kind, id);
      assert(touching.length > 0, 'The exported trash purges relations');
      // Every relation touching the entity is purged first, in the query's order.
      const purges = actual.slice(0, touching.length);
      for (const mutation of purges) {
        assert.equal(mutation.action, 'entity.purge');
        purgedRelations.push(mutation.target.id);
      }
      assert.deepEqual([...purgedRelations].sort(compareUtf8Bytewise), touching, 'Every relation touching the entity is purged');
      for (const relation of purgedRelations) {
        const before = lifecycle(prior, generation, 'entity-relation', relation)!;
        assert.equal(before.state, 'live');
        assert.equal(storedRelation(after, relation), null, 'A purged relation row is removed');
        assert.deepEqual(lifecycle(after, generation, 'entity-relation', relation), { incarnation: before.incarnation, state: 'purged' });
        expected.push({ action: 'entity.purge', target: entity('entity-relation', relation, before.incarnation), payload: {} });
      }
      assert.deepEqual(relationsTouching(after, projectId, kind, id), []);
      if (step.operation === 'trashStoryline') {
        // The membership projection of every live chapter linked to the storyline (UTF-8 order).
        const chapters = prior.prepare(`SELECT DISTINCT l.node_id FROM node_storyline_link l JOIN book_node n ON n.id=l.node_id
          AND n.deleted_at IS NULL WHERE l.storyline_id=?`).all(id).map(row => String(row.node_id)).sort(compareUtf8Bytewise);
        assert(chapters.length > 0, 'The exported storyline trash projects a live chapter');
        for (const chapterId of chapters) {
          const current = liveTags(prior, generation, chapterId);
          const desired = links(after, chapterId);
          assert(!desired.storylineIds.includes(id));
          for (const storylineId of [...new Set([...current.keys(), ...desired.storylineIds])].sort(compareUtf8Bytewise)) {
            const setTarget = { family: 'set' as const, kind: 'membership', id: storylineId, incarnation: incarnationOf(after, generation, 'storyline', storylineId) };
            const observedAddTags = current.get(storylineId) ?? [];
            if (desired.storylineIds.includes(storylineId)) {
              if (observedAddTags.length === 0) expected.push({ action: 'set.add', target: setTarget, payload: { memberId: chapterId, value: null } });
            } else if (observedAddTags.length > 0) {
              expected.push({ action: 'set.remove', target: setTarget, payload: { memberId: chapterId, observedAddTags } });
            }
          }
          expected.push({ action: 'field.set', target: entity('node-storyline-primary', chapterId, incarnationOf(after, generation, 'node', chapterId)),
            payload: { field: 'storylineId', value: desired.primary } });
        }
      }
      const wire = kind === 'node' ? 'node' : kind;
      const table = { element: 'element', node: 'book_node', storyline: 'storylines' }[kind];
      const before = lifecycle(prior, generation, wire, id)!;
      assert.equal(before.state, 'live');
      assert.deepEqual(lifecycle(after, generation, wire, id), { incarnation: before.incarnation, state: 'trashed' });
      const row = after.prepare(`SELECT deleted_at,updated_at FROM ${table} WHERE id=?`).get(id)!;
      assert.deepEqual([row.deleted_at, row.updated_at], [step.originals[0]!.createdAt, step.originals[0]!.createdAt]);
      expected.push({ action: 'entity.trash', target: entity(wire, id, before.incarnation), payload: {} });
      break;
    }
  }
  assert.deepEqual(actual, expected, 'Originals are the independently planned relation, type, purge, membership and trash mutations');
  return purgedRelations;
}

/** Each command changes exactly its commanded library rows and the authored stamp, from the prior library. */
function verifyCommand(fixture: Case, step: Step, priorLibrary: RelationLibrary, afterLibrary: RelationLibrary, purged: string[]) {
  const projectId = fixture.projectId;
  const at = step.originals[0]!.createdAt;
  assert(step.originals.every(original => original.createdAt === at), 'One command authors every original at one time');
  const command = step.request.command;
  let expected: RelationLibrary;
  switch (step.operation) {
    case 'createType': {
      const result = step.result as RelationTypeResult;
      assert.deepEqual(Object.keys(result).sort(), typeKeys);
      assert.deepEqual(result, { id: result.id, projectId, ...normalizeRelationTypeDefinition(command!.definition as EntityRelationTypeDefinition),
        systemKey: null, locked: false, createdAt: at, updatedAt: at });
      expected = { ...priorLibrary, types: [...priorLibrary.types, result].sort(byName) };
      break;
    }
    case 'updateType': {
      const result = step.result as RelationTypeResult;
      const before = priorLibrary.types.find(type => type.id === command!.relationTypeId)!;
      assert.deepEqual(result, { ...before, ...normalizeRelationTypeDefinition(command!.definition as EntityRelationTypeDefinition), updatedAt: at });
      expected = { ...priorLibrary, types: priorLibrary.types.map(type => type.id === result.id ? result : type).sort(byName) };
      break;
    }
    case 'deleteType':
      assert.equal(step.result, null);
      assert(priorLibrary.types.some(type => type.id === command!.relationTypeId));
      expected = { ...priorLibrary, types: priorLibrary.types.filter(type => type.id !== command!.relationTypeId) };
      break;
    case 'addRelation': {
      const result = step.result as RelationResult;
      assert.deepEqual(Object.keys(result).sort(), relationKeys);
      const type = priorLibrary.types.find(item => item.id === command!.relationTypeId)!;
      const checked = validateRelationAgainstType(type, { fromKind: command!.fromKind, fromId: command!.fromId, toKind: command!.toKind,
        toId: command!.toId } as Parameters<typeof validateRelationAgainstType>[1]);
      assert(checked.ok);
      assert.deepEqual(result, { id: result.id, projectId, ...checked.relation, relationTypeId: type.id, createdAt: at, updatedAt: at });
      expected = { ...priorLibrary, relations: [...priorLibrary.relations, result] };
      break;
    }
    case 'retypeRelation': {
      const result = step.result as RelationResult;
      const before = priorLibrary.relations.find(relation => relation.id === command!.relationId)!;
      const swapped = command!.swap ? { fromKind: before.toKind, fromId: before.toId, toKind: before.fromKind, toId: before.fromId } : {};
      assert.deepEqual(result, { ...before, ...swapped, relationTypeId: command!.relationTypeId, updatedAt: at });
      expected = { ...priorLibrary, relations: priorLibrary.relations.map(relation => relation.id === result.id ? result : relation) };
      break;
    }
    default:
      // Trash purges exactly the relations touching the entity; types stay.
      expected = { ...priorLibrary, relations: priorLibrary.relations.filter(relation => !purged.includes(relation.id)) };
      assert.equal(expected.relations.length, priorLibrary.relations.length - purged.length);
  }
  assert.deepEqual(afterLibrary, expected, 'The library delta follows the command');
  if (isRelationStep(step.operation)) assert.deepEqual(step.library, afterLibrary, 'The bridge library is the relation library');
}

/**
 * Each command changes exactly its own rows: relation commands leave every
 * entity row alone; a trash stamps its entity's deleted_at/updated_at with the
 * authored time and a storyline trash also removes every link to it.
 */
function verifyUntouched(prior: DatabaseSync, after: DatabaseSync, step: Step, target: Target) {
  const at = step.originals[0]!.createdAt;
  const trashTable = target.kind ? { element: 'element', node: 'book_node', storyline: 'storylines' }[target.kind] : null;
  for (const table of ['book_node', 'element', 'element_category', 'storylines', 'node_storyline_link']) {
    const expected = raw(prior, table).filter(row => !(table === 'node_storyline_link' && step.operation === 'trashStoryline'
      && row.storyline_id === target.id)).map(row => table === trashTable && row.id === target.id
      ? { ...row, deleted_at: at, updated_at: at } : row);
    equalRows(`${table} delta`, canonicalRows(raw(after, table)), canonicalRows(expected));
  }
}
async function verify(fixture: Case, ordinal: number) {
  assert.deepEqual(fixture.steps.map(step => step.operation), expectedOperations);
  assert.equal(fixture.chapterIds.length, 2);
  assert.equal(fixture.entities.elements.length, 3);
  assert.deepEqual(fixture.steps.map(step => step.request), expectedRequests(fixture), 'The exported requests are the pinned bridge requests');
  assert.deepEqual(fixture.steps.map(step => step.faultBeforeApply), expectedFaults);
  const temporary = mkdtempSync(path.join(path.dirname(output), `relation-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const originalIds = new Set<string>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const generation = String(writerBefore[0]!.sync_generation_id);
  const baseline = snapshot(initial);
  assert.deepEqual(raw(initial, 'entity_relation'), [], 'The fixture starts without relations');
  assert.deepEqual(raw(initial, 'sync_conflict'), []);
  // Rows only a receiver keeps: `${table}\0${key}` -> the kept receiver row.
  const keptRows = new Map<string, Row>();
  const steps = [];
  try {
    for (const [index, step] of fixture.steps.entries()) {
      assert.equal(step.originals.length, expectedActions[index]!.length);
      const originals: { bytes: Uint8Array; changeSet: SyncChangeSetV1 }[] = [];
      for (const [position, original] of step.originals.entries()) {
        const bytes = Uint8Array.from(Buffer.from(original.encodedBase64, 'base64'));
        const decoded = await decodeSyncChangeSetV1(bytes);
        assert(decoded.ok, 'Actual native original must decode through production protocol');
        const changeSet = decoded.value;
        assert.deepEqual(encodeSyncChangeSetV1(changeSet), bytes);
        assert.equal(changeSet.projectId, fixture.projectId);
        assert.equal(changeSet.syncGenerationId, generation);
        assert.equal(changeSet.mutations.length, original.mutationCount);
        assert.equal(new Date(changeSet.hlc.wallMs).toISOString(), original.createdAt, 'The original HLC is the authored clock');
        assert.deepEqual(changeSet.mutations.map(mutation => `${mutation.action} ${mutation.target.kind}`), expectedActions[index]![position]);
        if (position > 0) assert.equal(changeSet.deviceSeq, originals[position - 1]!.changeSet.deviceSeq + 1, 'A command journals consecutive originals');
        originals.push({ bytes, changeSet });
      }
      const changeSets = originals.map(item => item.changeSet);
      const priorName = index === 0 ? fixture.beforeDatabase : fixture.steps[index - 1]!.afterDatabase;
      const prior = new DatabaseSync(database(priorName), { readOnly: true });
      const expectedAfter = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      try {
        // 1. Targets, incarnations, payloads and the command's library delta.
        const target = resolve(step);
        const purged = verifyMutations(prior, expectedAfter, generation, fixture, step, changeSets, target);
        const priorLibrary = await readBack(database(priorName), path.join(temporary, `prior-library-${index}.db`),
          client => relationLibrary(client, fixture.projectId));
        const nativeLibrary = await readBack(database(step.afterDatabase), path.join(temporary, `library-${index}.db`),
          client => relationLibrary(client, fixture.projectId));
        verifyCommand(fixture, step, priorLibrary, nativeLibrary, purged);
        verifyUntouched(prior, expectedAfter, step, target);
        assert.deepEqual(snapshot(expectedAfter, ownerTables), snapshot(prior, ownerTables), 'Native relation and trash commands leave prose owners untouched');
        const relationCount = verifyRelationInvariants(expectedAfter, fixture.projectId);
        verifyMembershipAuthority(expectedAfter, generation, fixture.projectId);
        assert.deepEqual(raw(expectedAfter, 'sync_conflict'), [], 'Native records no conflict');

        // 2. The renderer use case, run on the same prior state through the
        // production authored runner, authors the same originals.
        const renderer = await rendererOriginals(fixture, step, target, database(priorName), path.join(temporary, `renderer-${index}.db`));
        assert.equal(renderer.changeSets.length, changeSets.length);
        for (const [position, { bytes }] of originals.entries()) {
          assert.deepEqual(encodeSyncChangeSetV1(renderer.changeSets[position]!), bytes, `Renderer use case authors the identical original ${position}`);
        }
        if (target.kind) assert.deepEqual(renderer.purged, purged, 'deleteEntityRelationsInTransaction purges the same relations in the same order');
        const nativeAuthority = snapshot(expectedAfter, rendererAuthorityTables);
        for (const table of rendererAuthorityTables) {
          equalRows(`renderer ${table}`, renderer.authority[table]!, nativeAuthority[table]!);
        }
        // The renderer's own relation, type, endpoint, element, node, storyline and link rows.
        const trashTable = target.kind ? { element: 'element', node: 'book_node', storyline: 'storylines' }[target.kind] : null;
        const rendererRow = (table: DomainTable, key: string, nativeProjection: Row): { renderer: Row; native: Row } => {
          const rendered: Row = { ...renderer.rows[table].find(row => rowKey(table, row) === key)! };
          const nativeRow: Row = { ...nativeProjection };
          if (table === trashTable && key === target.id) {
            for (const column of ['deleted_at', 'updated_at']) {
              assert.equal(nativeRow[column], step.originals[0]!.createdAt);
              assert(Date.parse(String(rendered[column])) >= Date.parse(step.originals[0]!.createdAt));
              rendered[column] = nativeRow[column] = 'compared-authored/wall-clock';
            }
          }
          return { renderer: rendered, native: nativeRow };
        };
        for (const table of rendererDomainTables) {
          const nativeRows = new Map(raw(expectedAfter, table).map(row => [rowKey(table, row), row]));
          assert.deepEqual(renderer.rows[table].map(row => rowKey(table, row)).sort(), [...nativeRows.keys()].sort(), `Renderer ${table} rows`);
          for (const [key, nativeProjection] of nativeRows) {
            const compared = rendererRow(table, key, nativeProjection);
            assert.deepEqual(normalize(compared.renderer), normalize(compared.native), `Renderer use case projects the same ${table} ${key}`);
          }
        }

        // 3. Replay every original of the step, in order, on the independent receiver.
        const known = new Set(raw(gateway.database, 'sync_change_set').map(item => String(item.change_set_id)));
        assert.deepEqual(raw(expectedAfter, 'sync_change_set').map(item => String(item.change_set_id)).filter(id => !known.has(id)),
          changeSets.map(changeSet => changeSet.changeSetId), 'Each step journals exactly its native originals');
        const contextOf = (changeSet: SyncChangeSetV1, createdAt: string) => ({
          changeSet,
          clock: { nowMs: Date.parse(createdAt), nowIso: createdAt },
          identity: { installationId: fixture.identity.installationId,
            createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) },
          kernel: productionSyncDomainMaterializationKernel,
        });
        const owner = snapshot(gateway.database, ownerTables);
        const receivedLinks = new Map(raw(gateway.database, 'node_storyline_link').map(row => [rowKey('node_storyline_link', row), row]));
        let faults = 0;
        invalidateSqliteReducerStateCache();
        for (const [position, { changeSet }] of originals.entries()) {
          const context = contextOf(changeSet, step.originals[position]!.createdAt);
          if (step.faultBeforeApply) {
            const unchanged = snapshot(gateway.database);
            gateway.database.exec("CREATE TRIGGER fail_relation_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic relation receipt fault'); END");
            await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
            assert.deepEqual(snapshot(gateway.database), unchanged);
            gateway.database.exec('DROP TRIGGER fail_relation_receipt');
            faults += 1;
          }
          const applied = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
          assert.equal(applied.status, 'applied');
          assert.deepEqual(applied.conflicts, []);
          originalIds.add(changeSet.changeSetId);
        }
        assert.deepEqual(snapshot(gateway.database, ownerTables), owner, 'Relation and trash originals leave prose owners untouched');
        verifyRelationInvariants(gateway.database, fixture.projectId);
        verifyMembershipAuthority(gateway.database, generation, fixture.projectId);
        // Local-only link removals: a storyline trash removes the links of
        // trashed chapters by storyline without an original; a receiver keeps them.
        if (step.operation === 'trashStoryline') {
          for (const [key, row] of receivedLinks) {
            if (row.storyline_id !== target.id) continue;
            const chapter = expectedAfter.prepare('SELECT deleted_at FROM book_node WHERE id=?').get(String(row.node_id))!;
            if (chapter.deleted_at === null) continue;
            assert.equal(expectedAfter.prepare('SELECT 1 FROM node_storyline_link WHERE node_id=? AND storyline_id=?').get(String(row.node_id), target.id!),
              undefined, 'Native removes a trashed chapter\'s link to the trashed storyline');
            const kept = gateway.database.prepare('SELECT * FROM node_storyline_link WHERE node_id=? AND storyline_id=?').get(String(row.node_id), target.id!);
            assert.deepEqual(kept, row, 'A receiver keeps the trashed chapter\'s link');
            keptRows.set(`node_storyline_link\0${key}`, row);
          }
        }
        const adjusted = (db: DatabaseSync, native: boolean, table: string) => canonicalRows(raw(db, table).filter(item => {
          if (native || table !== 'node_storyline_link') return true;
          return !keptRows.has(`${table}\0${rowKey(table, item)}`);
        }).map(item => {
          const value = { ...item };
          if (table === 'sync_change_set' && originalIds.has(String(value.change_set_id))) {
            assert.equal(value.origin, native ? 'local' : 'remote');
            value.origin = 'compared-original';
          }
          return value;
        }));
        for (const [key, row] of keptRows) {
          const [table, ...rest] = key.split('\0');
          assert.deepEqual(gateway.database.prepare('SELECT * FROM node_storyline_link WHERE node_id=? AND storyline_id=?').get(rest[0]!, rest[1]!), row,
            `The receiver still keeps ${table} ${rest.join('/')}`);
        }
        const parity = tables.map(table => {
          const actualRows = adjusted(gateway.database, false, table);
          equalRows(table, actualRows, adjusted(expectedAfter, true, table));
          if (preservedTables.includes(table)) equalRows(`${table} unchanged from baseline`, actualRows, baseline[table]!);
          return { table, rows: actualRows.length, sha256: sha(JSON.stringify(actualRows)) };
        });
        const remoteWriter = raw(gateway.database, 'sync_generation_writer_state');
        const nativeWriter = raw(expectedAfter, 'sync_generation_writer_state');
        assert.equal(remoteWriter.length, 1);
        assert.equal(nativeWriter.length, 1);
        assert.equal(remoteWriter[0]!.next_device_seq, writerBefore[0]!.next_device_seq);
        assert.equal(nativeWriter[0]!.next_device_seq, changeSets[changeSets.length - 1]!.deviceSeq + 1);
        assert(Number(remoteWriter[0]!.hlc_wall_ms) >= changeSets[changeSets.length - 1]!.hlc.wallMs);

        // 4. The bridge library and result equal what the production
        // repositories read back from the native database and the receiver.
        const receivedLibrary = await relationLibrary(gateway.client(), fixture.projectId);
        assert.deepEqual(receivedLibrary, nativeLibrary, 'Renderer repositories read the same relation library from the receiver');
        let entityLibrary: 'passed' | null = null;
        if (step.operation === 'trashElement') {
          const read = await readBack(database(step.afterDatabase), path.join(temporary, `elements-${index}.db`),
            client => elementLibrary(client, fixture.projectId));
          assert.deepEqual(read, step.library, 'Renderer repositories read the native element library');
          const result = step.result as ElementResult;
          assert.deepEqual([read.trashedElements[0], read.elements.some(item => item.id === target.id)], [result, false]);
          assert.equal(result.updatedAt, step.originals[0]!.createdAt);
          const received = await elementLibrary(gateway.client(), fixture.projectId);
          assert.deepEqual(received, step.library, 'Renderer repositories read the same element library from the receiver');
          entityLibrary = 'passed';
        } else if (step.operation === 'trashStoryline') {
          const read = await readBack(database(step.afterDatabase), path.join(temporary, `storylines-${index}.db`),
            client => storylineLibrary(client, fixture.projectId));
          assert.deepEqual(read, step.library, 'Renderer repositories read the native storyline library');
          const result = step.result as StorylineResult;
          assert.deepEqual([read.trashedStorylines[0], read.storylines.some(item => item.id === target.id)], [result, false]);
          assert.equal(result.updatedAt, step.originals[0]!.createdAt);
          const received = await storylineLibrary(gateway.client(), fixture.projectId);
          assert.deepEqual(received, step.library, 'Renderer repositories read the same storyline library from the receiver');
          entityLibrary = 'passed';
        } else if (step.operation === 'trashChapter') {
          assert.deepEqual([step.result, step.library], [null, null]);
          const nodes = async (client: DbExecutor) => {
            const repository = createBookNodeSqliteRepository(fixture.projectId, client);
            const [live, trashed] = [await repository.findAll(), await repository.findTrashed()];
            return [live.some(node => node.id === target.id), trashed.some(node => node.id === target.id)];
          };
          assert.deepEqual(await readBack(database(step.afterDatabase), path.join(temporary, `nodes-${index}.db`), nodes), [false, true]);
          assert.deepEqual(await nodes(gateway.client()), [false, true]);
          entityLibrary = 'passed';
        }
        // 5. Authoritative prose is untouched on both roles.
        const documents = documentIds(expectedAfter).map(id => {
          const state = fullState(expectedAfter, id);
          assert.deepEqual(fullState(gateway.database, id), state);
          assert.deepEqual(fullState(prior, id), state, `${id} is untouched by relation and trash originals`);
          return { documentId: id.replace(/:.*/u, ':<id>'), stateSha256: sha(state) };
        });
        // 6. Re-applying every original is a no-op duplicate.
        const unchanged = snapshot(gateway.database);
        const totalChanges = gateway.database.prepare('SELECT total_changes() AS count').get()!.count;
        for (const [position, { changeSet }] of originals.entries()) {
          const duplicate = await gateway.client().transaction(tx =>
            applyVerifiedRemoteChangeSetInTransaction(tx, contextOf(changeSet, step.originals[position]!.createdAt)));
          assert.equal(duplicate.status, 'duplicate');
        }
        assert.deepEqual(snapshot(gateway.database), unchanged);
        assert.equal(gateway.database.prepare('SELECT total_changes() AS count').get()!.count, totalChanges);
        // 7. Non-vacuity: each comparison rejects a one-cell corruption.
        const commandedTable: DomainTable = trashTable as DomainTable | null
          ?? (['createType', 'updateType', 'deleteType'].includes(step.operation) ? 'entity_relation_type' : 'entity_relation');
        const corruptible = raw(expectedAfter, commandedTable);
        const commandedKey = target.id ?? (step.result as { id: string } | null)?.id ?? rowKey(commandedTable, corruptible[0]!);
        const nonVacuity = {
          original: rejects('a renderer original with a corrupted target', () => {
            const rendered = renderer.changeSets[renderer.changeSets.length - 1]!;
            const corrupted = { ...rendered, mutations: rendered.mutations.map((mutation, i) =>
              i === 0 ? { ...mutation, target: { ...mutation.target, id: `${mutation.target.id}-corrupted` } } : mutation) };
            assert.deepEqual(encodeSyncChangeSetV1(corrupted), originals[originals.length - 1]!.bytes);
          }),
          mutations: rejects('a corrupted mutation payload', () => {
            const corrupted = changeSets.map((changeSet, i) => i > 0 ? changeSet : { ...changeSet, mutations: changeSet.mutations.map((mutation, j) =>
              j === changeSet.mutations.length - 1 ? { ...mutation, payload: { corrupted: true } } : mutation) });
            verifyMutations(prior, expectedAfter, generation, fixture, step, corrupted, target);
          }),
          rendererRow: rejects('a corrupted renderer row', () => {
            const nativeProjection = corruptible.find(row => rowKey(commandedTable, row) === commandedKey)!;
            const compared = rendererRow(commandedTable, commandedKey, nativeProjection);
            assert.deepEqual(normalize({ ...compared.renderer, updated_at: 'corrupted' }), normalize(compared.native));
          }),
          table: rejects('a corrupted receiver table', () => {
            const rows = adjusted(gateway.database, false, 'entity_relation_type');
            equalRows('entity_relation_type', rows.map((row, i) => i === 0 ? { ...row, description: 'corrupted' } : row),
              adjusted(expectedAfter, true, 'entity_relation_type'));
          }),
          library: rejects('a corrupted library', () => {
            const corrupted = structuredClone(nativeLibrary);
            corrupted.types[0]!.updatedAt = 'corrupted';
            assert.deepEqual(receivedLibrary, corrupted);
          }),
          invariants: rejects('a stored edge its type does not allow', () => {
            const copy = path.join(temporary, `invariants-${index}.db`);
            copyFileSync(database(step.afterDatabase), copy);
            const corrupted = new DatabaseSync(copy);
            try {
              // The built-in type links comments and library items only.
              corrupted.prepare(`INSERT INTO entity_relation(id,project_id,from_kind,from_id,to_kind,to_id,relation_type_id,created_at,updated_at)
                VALUES ('corrupted',?,'element',?,'element',?,?,'t','t')`).run(fixture.projectId, fixture.entities.elements[0]!,
                fixture.entities.elements[1]!, `system:generic-association:${fixture.projectId}`);
              verifyRelationInvariants(corrupted, fixture.projectId);
            } finally { corrupted.close(); }
          }),
        };
        steps.push({ operation: step.operation,
          originals: originals.map(({ bytes, changeSet }) => ({ sha256: sha(bytes), mutationCount: changeSet.mutations.length,
            actions: changeSet.mutations.map(mutation => `${mutation.action} ${mutation.target.kind}`) })),
          purgedRelations: purged.length, relations: relationCount, types: nativeLibrary.types.length,
          localDomainWire: 'passed', rendererAuthority: 'passed', rendererRow: 'passed', mutations: 'passed', command: 'passed',
          library: 'passed', entityLibrary, invariants: 'passed', proseOwners: 'unchanged', faultRollback: faults, duplicate: 'passed',
          keptRows: [...keptRows.values()].map(row => ({ table: 'node_storyline_link', chapter: fixture.chapterIds.indexOf(String(row.node_id)),
            storyline: row.storyline_id === fixture.entities.storyline ? 'entities.storyline' : 'other', isPrimary: Number(row.is_primary) })),
          nonVacuity, tables: parity, documents, afterDatabaseSha256: sha(readFileSync(database(step.afterDatabase))) });
      } finally {
        prior.close();
        expectedAfter.close();
      }
    }
    return { name: fixture.name, status: 'passed', beforeDatabaseSha256: sha(readFileSync(database(fixture.beforeDatabase))), steps };
  } finally {
    initial.close();
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}
async function main() {
  const fixture = JSON.parse(readFileSync(input, 'utf8')) as { schemaVersion: number; cases: Case[] };
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.cases.map(item => item.name), ['relations-types-edges-and-trash']);
  mkdirSync(path.dirname(output), { recursive: true });
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences, excludedColumns: [], exemptions, localOnlyEffects, rendererDivergences, reducerDefects,
    scope: 'Native relation-type create/update/delete, relation add/retype and relation-purging element, chapter and storyline trash originals match the renderer use cases authored on the same prior state (byte-identical), production reducer SQLite effects, the production relation-type, relation, element, node and storyline repositories, relation invariants and the membership authority. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, relationSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
