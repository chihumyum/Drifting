// Actual native storyline and chapter-membership originals: rebuilt through
// the renderer use cases on the prior native database, then replayed by the
// production TS reducer on an independent copy and compared with the native
// databases. Run with `--import=./scripts/apple-workspace-element-kv-ids.mjs`,
// which replays native kv-entry IDs into the renderer KV authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { eq, inArray } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { parseKv, stringifyKv } from '../src/renderer/domain/kv';
import { deriveNodeStorylineState } from '../src/renderer/domain/node-storyline-state';
import { makeUniqueStorylineName, type Storyline } from '../src/renderer/domain/storyline';
import type { DbExecutor, DbTransaction } from '../src/renderer/lib/db';
import { createYjsProseSeedState } from '../src/renderer/lib/agent/runtime/yjs-prose-command';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { NodeStorylineLinkTable } from '../src/renderer/schema/drizzle';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { createNodeStorylineLinkRepository } from '../src/renderer/sqlite-repo/node-storyline-link-repo';
import { createStorylineRepository } from '../src/renderer/sqlite-repo/storyline-repo';
import { createAuthoredTransactionRunner } from '../src/renderer/sync/journal/authored-transaction';
import type { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
import { entityIdsByNumericPlacement } from '../src/renderer/sync/journal/order-authority';
import { appendPlannedAuthoredOrderInTransaction } from '../src/renderer/sync/journal/order-authority-repository';
import { appendAuthoredNodeStorylineProjectionInTransaction } from '../src/renderer/sync/journal/storyline-membership';
import { appendAuthoredProseSeedInTransaction } from '../src/renderer/sync/journal/yjs-update';
import { compareUtf8Bytewise, decodeCanonicalCbor, type SyncChangeSetV1 } from '../src/renderer/sync/protocol';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';
import { deleteEntityRelationsInTransaction } from '../src/renderer/usecase/entity-relation-cleanup';
import { cloneEntityKvEntriesInTransaction, replaceEntityKvEntriesInTransaction } from '../src/renderer/usecase/normalized-kv-alias-authority';
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
  'project', 'book_node', 'node_content', 'entity_relation', 'entity_kv_entry', 'storylines', 'node_storyline_link',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
const preservedTables = ['project', 'entity_relation'];
// Fact authority: unchanged by every original that carries no kv-entry mutation.
const factTables = ['entity_kv_entry'];
// Authority rows the renderer's own local authored transaction writes.
const rendererAuthorityTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_entity_lifecycle', 'sync_field_clock',
  'sync_set_tag', 'sync_order_register', 'entity_kv_entry', 'sync_generation_writer_state',
];
// Domain rows the renderer use case writes itself.
const rendererDomainTables = ['storylines', 'node_storyline_link', 'book_node'] as const;
// Live body owners persist and re-stamp checkpoints outside originals.
const ownerTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance', 'sync_yjs_materialization_receipt'];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
  'Materialized Yjs update, revision and provenance times: authored clock locally, receive wall clock remotely; provenance source system/remote',
];
const exemptions = [
  'Seed yjs.update payloads differ by design: native seeds one empty paragraph with a stable block id and caches it; the renderer seeds DEFAULT_TIPTAP_DOC_JSON as an empty fragment and caches it. Seeds are compared by decoded Yjs structure; every other byte of the original and every renderer authority row match.',
  'storylines.content_json and node_content.content_json compare as parsed JSON (native key-sorted, reducer ProseMirror key order). A restore re-projects the reducer cache (and node_content.updated_at from the winning HLC) from authoritative Yjs while native, like the renderer restore, preserves the existing cache; each role is verified.',
  'The renderer repository softDeleteStoryline/restoreStoryline and node softDelete/restore stamp deleted_at/updated_at with the wall clock; native and the originals use the authored clock.',
  'New kv-entry IDs: the renderer KV authority mints uuidv7 while native mints host IDs, so its uuid import is replaced (scripts/apple-workspace-element-kv-ids.mjs) by the created kv-entry IDs of the native original in mutation order; each renderer step must drain exactly that queue.',
  'Host-chosen storyline IDs and colours (renderer uuidv7/randomColor) and the use-case clock are injected from the native result; the renderer computes every name, order key, membership, projection and wire byte itself.',
];
const localOnlyEffects = [
  'Facts-only updates and moves carry no storyline owner field: the authoring side stamps storylines.updated_at (native and the renderer use case alike) while a receiving reducer keeps its lifecycle/field time (after a move, from the next apply on). Tracked per row with exact values until an owner field re-stamps it.',
  'A remote order apply (materializeOrder) stamps storylines.updated_at with the winning HLC on every storyline an order mutation of the original targets, while native moves stamp nothing (create and restore stamp the same authored time on both roles). Pinned per step with exact values.',
];
const carriedOwnerState = [
  'A retired body owner re-stamps its checkpoint (yjs_snapshots.updated_at, identical bytes) while trashing; for documents no mutation of the original targets, that row is carried from the native after-database, and every other owner row must be unchanged.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences: string[] = [];
const reducerDefects = [
  'TS remote order stamps are transient: every remote apply re-materializes the reducer state and materializeOrder stamps updated_at only for the original being applied, so the next apply of any original rewrites a moved storyline back to its lifecycle/field time (updated_at moves backwards). Pinned: the stamp exists only at the ordering step; afterwards the receiver returns to that time (equal to native for unmoved siblings, the tracked local-only stamp for the moved row).',
];
type Operation = 'createStoryline' | 'updateStoryline' | 'setChapterStorylines' | 'moveStoryline' | 'setStorylineFacts'
  | 'trashStoryline' | 'restoreStoryline' | 'trashChapter' | 'restoreChapter';
interface Fact { key: string; value: string }
/** The bridge-test commands, with storylines named as the author sees them. */
interface CommandInput {
  name?: string;
  color?: string;
  summary?: string;
  storyline?: string;
  chapter?: number;
  storylines?: string[];
  /** Absent keeps the current primary; null clears it (setNodeStorylines options). */
  primary?: string | null;
  before?: string | null;
  facts?: Fact[];
}
const firstStoryline = ['entity.create', 'yjs.update', 'order.move', 'set.add', 'field.set', 'set.add', 'field.set'];
const expectedCases: Record<string, { operations: Operation[]; inputs: CommandInput[]; actions: string[][] }> = {
  'storyline-create-assign-order-and-cold-reopen': {
    operations: ['createStoryline', 'createStoryline', 'updateStoryline', 'setChapterStorylines', 'moveStoryline',
      'setChapterStorylines', 'setStorylineFacts'],
    inputs: [{ name: '主线' }, { name: '主线' }, { storyline: '主线 2', name: '支线🙂', summary: '雨夜' },
      { chapter: 1, storylines: ['支线🙂', '主线'], primary: '支线🙂' }, { storyline: '支线🙂', before: '主线' },
      { chapter: 1, storylines: ['主线'], primary: '主线' }, { storyline: '主线', facts: [{ key: '主题', value: '归乡' }] }],
    actions: [firstStoryline, ['entity.create', 'yjs.update', 'order.move'], ['field.set', 'field.set'],
      ['set.add', 'field.set'], ['order.rebalance', 'order.rebalance'], ['set.remove', 'field.set'],
      ['entity.create', 'order.move']],
  },
  'storyline-trash-restore-and-chapter-membership-restore': {
    operations: ['trashStoryline', 'restoreStoryline', 'trashChapter', 'restoreChapter'],
    inputs: [{ storyline: '主线' }, { storyline: '主线' }, { chapter: 1 }, { chapter: 1 }],
    actions: [['set.remove', 'field.set', 'set.remove', 'field.set', 'entity.trash'],
      ['entity.restore', 'order.move', 'yjs.update'], ['entity.trash'],
      ['entity.restore', 'tuple.set', 'set.remove', 'set.add', 'field.set', 'yjs.update']],
  },
  'storyline-failures-roll-back-and-retry': {
    operations: ['createStoryline', 'setChapterStorylines', 'updateStoryline', 'trashStoryline'],
    inputs: [{ name: '暗线' }, { chapter: 0, storylines: [], primary: null }, { storyline: '暗线', color: '#102030' }, { storyline: '暗线' }],
    actions: [firstStoryline, ['set.remove', 'field.set'], ['field.set'], ['set.remove', 'field.set', 'entity.trash']],
  },
};
interface StorylineResult {
  id: string; projectId: string; name: string; color: string; summary: string; orderKey: number; facts: Fact[];
  documentId: string; createdAt: string; updatedAt: string;
}
interface Membership { chapterId: string; storylineIds: string[]; primary: string | null }
interface Library { storylines: StorylineResult[]; trashedStorylines: StorylineResult[]; memberships: Membership[] }
interface Step {
  operation: Operation;
  encodedBase64: string;
  mutationCount: number;
  createdAt: string;
  afterDatabase: string;
  faultBeforeApply: boolean;
  result: StorylineResult | StorylineResult[] | Membership | null;
  library: Library | null;
}
interface Case {
  name: string;
  beforeDatabase: string;
  projectId: string;
  chapterIds: string[];
  identity: { installationId: string; writerId: string; writerEpoch: string };
  steps: Step[];
}
type Row = Record<string, unknown>;
type Mutation = SyncChangeSetV1['mutations'][number];
const storylineKeys = ['color', 'createdAt', 'documentId', 'facts', 'id', 'name', 'orderKey', 'projectId', 'summary', 'updatedAt'];
const DEFAULT_TIPTAP_DOC_JSON = JSON.stringify({ type: 'doc', content: [] });
const isStorylineOperation = (operation: Operation) => !['setChapterStorylines', 'trashChapter', 'restoreChapter'].includes(operation);
// The renderer KV authority's uuid import resolves to this queue (see the
// --import hook); each renderer step arms and must drain it exactly.
const kvEntryIdQueue: string[] = [];
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('drifting.acceptance.kvEntryIds')] = kvEntryIdQueue;
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
function insert(db: DatabaseSync, table: string, rows: Row[]) {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(column => row[column] as SQLInputValue));
  }
}
/** Primary key of a compared domain row. */
function rowKey(table: string, row: Row): string {
  if (table === 'node_storyline_link') return `${String(row.node_id)}\0${String(row.storyline_id)}`;
  if (table === 'node_content') return String(row.node_id);
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
interface Block { type: string; id: string; text: string; attributes: string[] }
function plain(node: unknown): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert?: unknown }[]).map(op => typeof op.insert === 'string' ? op.insert : '').join('');
  }
  return node instanceof Y.XmlElement ? node.toArray().map(plain).join('') : '';
}
/** Top-level blocks and the ProseMirror projection of one Yjs state. */
function structure(update: Uint8Array): { blocks: Block[]; json: unknown } {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    assert.equal(doc.store.pendingStructs, null);
    assert.equal(doc.store.pendingDs, null);
    const blocks = doc.getXmlFragment('default').toArray().map(node => {
      assert(node instanceof Y.XmlElement);
      return { type: node.nodeName, id: String(node.getAttribute('id') ?? ''), text: plain(node),
        attributes: Object.keys(node.getAttributes()).sort() };
    });
    return { blocks, json: yDocToProsemirrorJSON(doc, 'default') };
  } finally { doc.destroy(); }
}
function causedByFault(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error.message.includes('synthetic storyline receipt fault')) return true;
    error = (error as Error & { cause?: unknown }).cause;
  }
  return false;
}
/** Renderer cleanedKv: rows with a non-blank key or value, untrimmed. */
const cleanedFacts = (facts: readonly Fact[]): Fact[] => parseKv(stringifyKv([...facts]));
function lifecycle(db: DatabaseSync, generation: string, kind: string, id: string) {
  const value = db.prepare('SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?')
    .get(generation, kind, id);
  return value ? { incarnation: Number(value.incarnation), state: String(value.state) } : null;
}
const incarnationOf = (db: DatabaseSync, generation: string, kind: string, id: string) =>
  lifecycle(db, generation, kind, id)?.incarnation ?? 0;
/** Storyline rows: live by (order_key, rowid) like the native library, or trashed. */
function storylineRows(db: DatabaseSync, projectId: string, trashed = false): Row[] {
  return db.prepare(`SELECT * FROM storylines WHERE project_id=? AND deleted_at IS ${trashed ? 'NOT ' : ''}NULL ORDER BY order_key,rowid`)
    .all(projectId);
}
function storylineNamed(db: DatabaseSync, projectId: string, name: string, trashed = false): string {
  const matches = storylineRows(db, projectId, trashed).filter(row => row.name === name);
  assert.equal(matches.length, 1, `Exactly one ${trashed ? 'trashed' : 'live'} storyline is named ${name}`);
  return String(matches[0]!.id);
}
/** Live chapters in book order. */
function liveChapters(db: DatabaseSync, projectId: string): string[] {
  return db.prepare("SELECT id FROM book_node WHERE project_id=? AND kind='chapter' AND deleted_at IS NULL ORDER BY book_order,id")
    .all(projectId).map(row => String(row.id));
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
/** node_storyline_link equals the live OR-set tags and the primary register for every chapter. */
function verifyMembershipAuthority(db: DatabaseSync, generation: string, chapterIds: readonly string[]) {
  for (const chapterId of chapterIds) {
    const projected = links(db, chapterId);
    assert.deepEqual([...liveTags(db, generation, chapterId).keys()].sort(compareUtf8Bytewise), projected.storylineIds,
      `Links of ${chapterId} project its live membership tags`);
    assert.equal(primaryRegister(db, generation, chapterId), projected.primary, `Primary link of ${chapterId} projects its register`);
  }
}
const factScope = (storylineId: string) => JSON.stringify(['storyline', storylineId, 'facts']);
/** Fact authority: kv-entry rows in order-register order (position bytes, then id). */
function factEntries(db: DatabaseSync, generation: string, projectId: string, storylineId: string): (Fact & { id: string })[] {
  const rows = db.prepare("SELECT id,key,value FROM entity_kv_entry WHERE project_id=? AND owner_kind='storyline' AND owner_id=? AND namespace='facts'")
    .all(projectId, storylineId);
  const positions = new Map(db.prepare(`SELECT entity_id,position_key FROM sync_order_register
    WHERE sync_generation_id=? AND list_kind='kv-entry' AND owner_id=? AND incarnation=0`).all(generation, factScope(storylineId))
    .map(row => [String(row.entity_id), String(row.position_key)]));
  for (const row of rows) assert(positions.has(String(row.id)), 'Every fact has an order register');
  return rows.map(row => ({ id: String(row.id), key: String(row.key), value: String(row.value) }))
    .sort((a, b) => compareUtf8Bytewise(positions.get(a.id)!, positions.get(b.id)!) || compareUtf8Bytewise(a.id, b.id));
}
const factsOf = (db: DatabaseSync, generation: string, projectId: string, storylineId: string): Fact[] =>
  factEntries(db, generation, projectId, storylineId).map(({ key, value }) => ({ key, value }));
function projectTemplate(db: DatabaseSync, generation: string, projectId: string): Fact[] {
  const rows = db.prepare("SELECT id,key,value FROM entity_kv_entry WHERE project_id=? AND owner_kind='project' AND owner_id=? AND namespace='storyline-template'")
    .all(projectId, projectId);
  const scope = JSON.stringify(['project', projectId, 'storyline-template']);
  const positions = new Map(db.prepare(`SELECT entity_id,position_key FROM sync_order_register
    WHERE sync_generation_id=? AND list_kind='kv-entry' AND owner_id=?`).all(generation, scope)
    .map(row => [String(row.entity_id), String(row.position_key)]));
  return rows.sort((a, b) => compareUtf8Bytewise(positions.get(String(a.id))!, positions.get(String(b.id))!)
    || compareUtf8Bytewise(String(a.id), String(b.id))).map(row => ({ key: String(row.key), value: String(row.value) }));
}
/** Live storyline order authority: current-incarnation registers by (position key, id). */
function registerOrder(db: DatabaseSync, generation: string, projectId: string): string[] {
  const live = new Set(storylineRows(db, projectId).map(row => String(row.id)));
  return db.prepare("SELECT entity_id,incarnation,position_key FROM sync_order_register WHERE sync_generation_id=? AND list_kind='storyline' AND owner_id=?")
    .all(generation, projectId)
    .filter(row => live.has(String(row.entity_id)) && Number(row.incarnation) === incarnationOf(db, generation, 'storyline', String(row.entity_id)))
    .sort((a, b) => compareUtf8Bytewise(String(a.position_key), String(b.position_key)) || compareUtf8Bytewise(String(a.entity_id), String(b.entity_id)))
    .map(row => String(row.entity_id));
}
/** The renderer library of one database, read back through the production repositories. */
async function rendererLibrary(client: DbExecutor, projectId: string): Promise<Library> {
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
async function libraryOf(file: string, scratch: string, projectId: string): Promise<Library> {
  copyFileSync(file, scratch);
  const gateway = new ProductFileBackedSqliteGateway(scratch);
  try { return await rendererLibrary(gateway.client(), projectId); } finally { await gateway.close(); }
}
/** Numeric placement the renderer would pass as updateStoryline({ orderKey }) for a drag before `before` (or last). */
function dragOrderKey(live: readonly Storyline[], movedId: string, beforeId: string | null): { orderKey: number; desired: string[] } {
  const others = live.filter(item => item.id !== movedId);
  const at = beforeId === null ? others.length : others.findIndex(item => item.id === beforeId);
  assert(at >= 0, 'Drag target is a live storyline');
  const orderKey = others.length === 0 ? 0 : at === 0 ? others[0]!.orderKey - 1 : at === others.length
    ? others[others.length - 1]!.orderKey + 1 : (others[at - 1]!.orderKey + others[at]!.orderKey) / 2;
  const desired = others.map(item => item.id);
  desired.splice(at, 0, movedId);
  return { orderKey, desired };
}

interface Resolved { storylineId: string | null; chapterId: string | null; storylineIds: string[]; primary: string | null | undefined; before: string | null }
function resolve(fixture: Case, prior: DatabaseSync, step: Step, commandInput: CommandInput): Resolved {
  const projectId = fixture.projectId;
  const storylineId = step.operation === 'createStoryline' ? (step.result as StorylineResult).id
    : commandInput.storyline === undefined ? null
      : storylineNamed(prior, projectId, commandInput.storyline, step.operation === 'restoreStoryline');
  return {
    storylineId,
    chapterId: commandInput.chapter === undefined ? null : fixture.chapterIds[commandInput.chapter]!,
    storylineIds: (commandInput.storylines ?? []).map(name => storylineNamed(prior, projectId, name)),
    primary: commandInput.primary === undefined || commandInput.primary === null ? commandInput.primary
      : storylineNamed(prior, projectId, commandInput.primary),
    before: commandInput.before ? storylineNamed(prior, projectId, commandInput.before) : null,
  };
}

/**
 * Mirror each renderer use case's authored effect (useStoryline and
 * useBookNode through withAtomicSyncTransaction) on a copy of the prior
 * native database. Store reads become the repository reads that hydrate them.
 */
async function rendererOriginal(fixture: Case, step: Step, commandInput: CommandInput, target: Resolved, prior: string,
  scratch: string, kvEntryIds: readonly string[]) {
  copyFileSync(prior, scratch);
  const gateway = new ProductFileBackedSqliteGateway(scratch);
  const client = gateway.client();
  const clock = { nowMs: Date.parse(step.createdAt), nowIso: step.createdAt };
  const run = createAuthoredTransactionRunner({
    database: () => client,
    identity: async () => ({ installationId: fixture.identity.installationId,
      createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) }),
    clock: () => clock,
    syncGenerationIds: {
      createSyncGenerationId: () => assert.fail('Existing projects keep their sync generation'),
      createProjectSyncId: () => assert.fail('Existing projects keep their project sync id'),
    },
    onCommitted: () => undefined,
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
  // useStoryline's `new Date().toISOString()`, pinned to the authored clock.
  const now = step.createdAt;
  const repo = createStorylineRepository(projectId, client);
  let seedState: Uint8Array | null = null;
  let orderKey: number | null = null;
  kvEntryIdQueue.splice(0, kvEntryIdQueue.length, ...kvEntryIds);
  try {
    switch (step.operation) {
      case 'createStoryline': {
        // useStoryline.createStoryline; ID and colour are host-random in both.
        const native = step.result as StorylineResult;
        const existing = await repo.getStorylinesByProject();
        const maxOrder = existing.reduce((max, sl) => Math.max(max, sl.orderKey), 0);
        const newStoryline: Storyline = {
          id: native.id, projectId, name: makeUniqueStorylineName(commandInput.name ?? '', existing, projectId),
          color: native.color, summary: '', orderKey: maxOrder + 1, contentJson: DEFAULT_TIPTAP_DOC_JSON, kvJson: '[]',
          nodeContentTemplateJson: '{}', createdAt: now, updatedAt: now,
        };
        // createEntitySeedUpdate delegates to createYjsProseSeedState.
        seedState = await createYjsProseSeedState(newStoryline.contentJson);
        const proseSeedState = seedState;
        // The store's storylines and book nodes are the live repository rows.
        const isFirstStoryline = existing.length === 0;
        const orphanChapterIds = isFirstStoryline
          ? (await createBookNodeSqliteRepository(projectId, client).findAll()).filter(n => n.kind === 'chapter').map(n => n.id) : [];
        await atomic(async (tx, sync, changes) => {
          const storylineRepo = createStorylineRepository(projectId, tx);
          await storylineRepo.createStoryline({ ...newStoryline, kvJson: '[]' });
          await cloneEntityKvEntriesInTransaction(tx, changes, {
            source: { projectId, ownerKind: 'project', ownerId: projectId, namespace: 'storyline-template' },
            target: { projectId, ownerKind: 'storyline', ownerId: newStoryline.id, namespace: 'facts' },
          });
          const storyline = (await storylineRepo.getStorylineById(newStoryline.id))!;
          const linkRepoTx = createNodeStorylineLinkRepository(projectId, tx);
          for (const nodeId of orphanChapterIds) await linkRepoTx.setPrimaryStoryline(nodeId, newStoryline.id);
          await sync('storyline', 'create', storyline.id, projectId, { id: storyline.id, name: storyline.name,
            color: storyline.color, summary: storyline.summary, nodeContentTemplateJson: storyline.nodeContentTemplateJson });
          await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'storyline', entityId: storyline.id,
            stateUpdate: proseSeedState });
          const desiredEntityIds = entityIdsByNumericPlacement((await storylineRepo.getStorylinesByProject())
            .map(entry => ({ entityId: entry.id, projection: entry.orderKey })));
          await appendPlannedAuthoredOrderInTransaction(tx, changes, { projectId, listKind: 'storyline', scope: projectId, desiredEntityIds });
          for (const nodeId of [...orphanChapterIds].sort(compareUtf8Bytewise)) {
            await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, { projectId, nodeId });
          }
        });
        break;
      }
      case 'updateStoryline':
      case 'moveStoryline':
      case 'setStorylineFacts': {
        // useStoryline.updateStoryline: a rename/recolour/summary, a numeric
        // orderKey placement (the only renderer reorder path) or kvJson facts.
        const prevStorylines = await repo.getStorylinesByProject();
        const existing = prevStorylines.find(item => item.id === target.storylineId);
        assert(existing);
        if (step.operation === 'moveStoryline') {
          const drag = dragOrderKey(prevStorylines, existing.id, target.before);
          orderKey = drag.orderKey;
          assert.deepEqual(entityIdsByNumericPlacement(prevStorylines.map(item => ({ entityId: item.id,
            projection: item.id === existing.id ? drag.orderKey : item.orderKey }))), drag.desired);
        }
        const update = {
          id: existing.id,
          ...(commandInput.name !== undefined ? { name: commandInput.name } : {}),
          ...(commandInput.color !== undefined ? { color: commandInput.color } : {}),
          ...(commandInput.summary !== undefined ? { summary: commandInput.summary } : {}),
          ...(orderKey !== null ? { orderKey } : {}),
          ...(commandInput.facts !== undefined ? { kvJson: JSON.stringify(commandInput.facts) } : {}),
        };
        const updated: Storyline = {
          ...existing,
          name: update.name !== undefined ? makeUniqueStorylineName(update.name, prevStorylines, projectId, update.id) : existing.name,
          color: update.color ?? existing.color,
          summary: update.summary ?? existing.summary,
          orderKey: update.orderKey ?? existing.orderKey,
          kvJson: update.kvJson ?? existing.kvJson,
          updatedAt: now,
        };
        await atomic(async (tx, sync, changes) => {
          const storylineRepo = createStorylineRepository(projectId, tx);
          await storylineRepo.updateStoryline(update.id, { name: updated.name, color: updated.color, summary: updated.summary,
            orderKey: updated.orderKey, contentJson: updated.contentJson, nodeContentTemplateJson: updated.nodeContentTemplateJson,
            updatedAt: updated.updatedAt, projectId });
          if (update.kvJson !== undefined) {
            await replaceEntityKvEntriesInTransaction(tx, changes, { projectId, ownerKind: 'storyline', ownerId: update.id,
              namespace: 'facts', nextJson: update.kvJson });
          }
          const storyline = (await storylineRepo.getStorylineById(update.id))!;
          const scalarPayload: Record<string, unknown> = {};
          if (update.name !== undefined) scalarPayload.name = storyline.name;
          if (update.color !== undefined) scalarPayload.color = storyline.color;
          if (update.summary !== undefined) scalarPayload.summary = storyline.summary;
          if (Object.keys(scalarPayload).length > 0) await sync('storyline', 'update', storyline.id, projectId, scalarPayload);
          if (update.orderKey !== undefined) {
            const desiredEntityIds = entityIdsByNumericPlacement((await storylineRepo.getStorylinesByProject())
              .map(entry => ({ entityId: entry.id, projection: entry.orderKey })));
            await appendPlannedAuthoredOrderInTransaction(tx, changes, { projectId, listKind: 'storyline', scope: projectId, desiredEntityIds });
          }
        });
        break;
      }
      case 'setChapterStorylines': {
        // useStoryline.setNodeStorylines(nodeId, ids, options?); the store's
        // primary map is loadNodeStorylineMapping over live nodes.
        const nodeId = target.chapterId!;
        const storylineIds = target.storylineIds;
        const options = target.primary === undefined ? undefined : { primaryStorylineId: target.primary };
        const liveNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).map(node => node.id);
        const currentPrimary = deriveNodeStorylineState(await createNodeStorylineLinkRepository(projectId, client)
          .getStorylineLinksByNodeIds(liveNodes)).primaryStorylineByNode[nodeId] ?? null;
        let primaryStorylineId = options && 'primaryStorylineId' in options ? options.primaryStorylineId ?? null : currentPrimary;
        if (primaryStorylineId == null && storylineIds.length > 0) primaryStorylineId = storylineIds[0]!;
        const effectiveIds = primaryStorylineId && !storylineIds.includes(primaryStorylineId)
          ? [primaryStorylineId, ...storylineIds] : storylineIds;
        await atomic(async (tx, _sync, changes) => {
          await createNodeStorylineLinkRepository(projectId, tx).setNodeStorylines(nodeId, effectiveIds, { primaryStorylineId });
          await appendAuthoredNodeStorylineProjectionInTransaction(tx, changes, { projectId, nodeId });
        });
        break;
      }
      case 'trashStoryline': {
        // useStoryline.deleteStoryline with the trash feature; the store's
        // primary/forward maps are loadNodeStorylineMapping over live nodes.
        const id = target.storylineId!;
        const liveNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).map(node => node.id);
        const { storylineNodeMapping, primaryStorylineByNode } = deriveNodeStorylineState(
          await createNodeStorylineLinkRepository(projectId, client).getStorylineLinksByNodeIds(liveNodes));
        const nodesGoingUnaffiliated = Object.entries(primaryStorylineByNode).filter(([, slId]) => slId === id).map(([nid]) => nid);
        const nodesLosingSecondaryMembership = (storylineNodeMapping[id] ?? []).filter(nodeId => !nodesGoingUnaffiliated.includes(nodeId));
        await atomic(async (tx, sync, changes) => {
          await deleteEntityRelationsInTransaction(tx, sync, projectId, 'storyline', id);
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
      case 'restoreStoryline':
        // useStoryline.restoreStoryline -> sync-lifecycle-restore.
        await atomic(async (tx, sync) => {
          await createStorylineRepository(projectId, tx).restoreStoryline(target.storylineId!);
          await sync('storyline', 'restore', target.storylineId!, projectId);
        });
        break;
      case 'trashChapter':
        // useBookNode.deleteNode with the trash feature (a chapter: no drift unbinds).
        await atomic(async (tx, sync) => {
          await deleteEntityRelationsInTransaction(tx, sync, projectId, 'node', target.chapterId!);
          await createBookNodeSqliteRepository(projectId, tx).softDelete(target.chapterId!);
          await sync('node', 'softDelete', target.chapterId!, projectId);
        });
        break;
      case 'restoreChapter':
        // useBookNode.restoreNode -> sync-lifecycle-restore.
        await atomic(async (tx, sync) => {
          await createBookNodeSqliteRepository(projectId, tx).restore(target.chapterId!);
          await sync('node', 'restore', target.chapterId!, projectId);
        });
        break;
    }
    assert.deepEqual(kvEntryIdQueue, [], 'The renderer KV authority mints exactly the native kv-entry IDs');
    const latest = gateway.database.prepare("SELECT encoded_bytes FROM sync_change_set WHERE origin='local' ORDER BY rowid DESC LIMIT 1").get();
    assert(latest && latest.encoded_bytes instanceof Uint8Array);
    const decoded = await decodeSyncChangeSetV1(latest.encoded_bytes);
    assert(decoded.ok, 'Renderer original must decode');
    return { changeSet: decoded.value, seedState, orderKey, authority: snapshot(gateway.database, rendererAuthorityTables),
      rows: Object.fromEntries(rendererDomainTables.map(table => [table, raw(gateway.database, table)])) as Record<typeof rendererDomainTables[number], Row[]> };
  } finally {
    kvEntryIdQueue.length = 0;
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}

/**
 * Carry native owner changes between the prior and after databases for
 * documents no mutation of this original targets. The only such change is a
 * retired body owner's checkpoint re-stamp; its bytes and every other owner
 * row must be unchanged.
 */
function carryCheckpoints(receiver: DatabaseSync, prior: DatabaseSync, native: DatabaseSync, targets: Set<string>): string[] {
  const carried: string[] = [];
  const documents = new Set([...documentIds(prior), ...documentIds(native)]);
  receiver.exec('BEGIN IMMEDIATE');
  try {
    for (const documentId of [...documents].sort()) {
      if (targets.has(documentId)) continue;
      const select = (db: DatabaseSync, table: string) => canonicalRows(raw(db, table).filter(item => item.document_id === documentId));
      const changed = ownerTables.filter(table => !isDeepStrictEqual(select(prior, table), select(native, table)));
      if (changed.length === 0) continue;
      assert.deepEqual(changed, ['yjs_snapshots'], `Only a checkpoint re-stamp may change ${documentId} outside originals`);
      const [before, after] = [select(prior, 'yjs_snapshots'), select(native, 'yjs_snapshots')];
      assert.deepEqual(select(receiver, 'yjs_snapshots'), before, 'Receiver holds the prior checkpoint');
      assert.equal(before.length, 1);
      assert.equal(after.length, 1);
      assert.deepEqual({ ...before[0], updated_at: null }, { ...after[0], updated_at: null }, 'A re-stamp keeps the checkpoint bytes');
      assert(String(after[0]!.updated_at) > String(before[0]!.updated_at));
      receiver.prepare('DELETE FROM yjs_snapshots WHERE document_id=?').run(documentId);
      insert(receiver, 'yjs_snapshots', raw(native, 'yjs_snapshots').filter(item => item.document_id === documentId));
      carried.push(documentId);
    }
    receiver.exec('COMMIT');
  } catch (error) {
    receiver.exec('ROLLBACK');
    throw error;
  }
  invalidateSqliteReducerStateCache();
  return carried;
}

/** Storyline mutations, their incarnations, and every order/lifecycle target of the command. */
function verifyStorylineMutations(prior: DatabaseSync, after: DatabaseSync, generation: string, fixture: Case, step: Step,
  changeSet: SyncChangeSetV1, target: Resolved) {
  const projectId = fixture.projectId;
  for (const mutation of changeSet.mutations) {
    const { family, kind, id, incarnation } = mutation.target;
    const payload = mutation.payload as Record<string, unknown>;
    if (kind === 'membership' || kind === 'node-storyline-primary' || kind === 'kv-entry') continue;
    if (kind === 'storyline') {
      assert.equal(incarnation, incarnationOf(after, generation, 'storyline', id));
      const row = after.prepare('SELECT * FROM storylines WHERE id=?').get(id)!;
      const seed = { color: row.color, name: row.name, nodeContentTemplateJson: row.node_content_template_json, summary: row.summary };
      if (family === 'order') {
        assert.equal(row.deleted_at, null, 'Only live storylines are ordered');
        if (mutation.action === 'order.move') assert.deepEqual(Object.keys(payload).sort(), ['positionKey', 'scope']);
        else {
          assert.equal(mutation.action, 'order.rebalance');
          assert.deepEqual(Object.keys(payload).sort(), ['entries', 'scope']);
          const entries = payload.entries as Record<string, unknown>[];
          assert.equal(entries.length, 1);
          assert.equal(entries[0]!.entityId, id);
        }
        assert.equal(payload.scope, projectId);
        continue;
      }
      assert.equal(family, 'entity');
      assert.equal(id, target.storylineId, 'Only the commanded storyline is an entity target');
      if (mutation.action === 'entity.create') {
        assert.equal(incarnation, 0);
        assert.deepEqual(payload, { seed });
      } else if (mutation.action === 'entity.restore') {
        assert.equal(incarnation, incarnationOf(prior, generation, 'storyline', id) + 1);
        assert.deepEqual(payload, { seed });
      } else if (mutation.action === 'entity.trash') {
        assert.deepEqual(payload, {});
      } else {
        assert.equal(mutation.action, 'field.set');
        assert(['color', 'name', 'summary'].includes(String(payload.field)));
        assert.equal(payload.value, seed[payload.field as keyof typeof seed]);
      }
      continue;
    }
    if (family === 'yjs') {
      const owner = step.operation === 'restoreChapter' ? { kind: 'node', id: target.chapterId!, doc: `node-content:${target.chapterId}` }
        : { kind: 'storyline', id: target.storylineId!, doc: `storyline:${target.storylineId}` };
      assert.deepEqual(mutation.target, { family: 'yjs', kind: 'prose-document', id: owner.doc,
        incarnation: incarnationOf(after, generation, owner.kind, owner.id) });
      continue;
    }
    assert.equal(kind, 'node', `Unexpected target ${family}/${kind}`);
    assert.equal(id, target.chapterId);
    assert.equal(incarnation, incarnationOf(after, generation, 'node', id));
    if (mutation.action === 'entity.trash') assert.deepEqual(payload, {});
    else if (mutation.action === 'tuple.set') {
      const node = after.prepare('SELECT position_x,position_y FROM book_node WHERE id=?').get(id)!;
      assert.deepEqual(payload, { tuple: 'graph.position', value: { x: node.position_x, y: node.position_y } });
    } else {
      assert.equal(mutation.action, 'entity.restore');
      assert.equal(incarnation, incarnationOf(prior, generation, 'node', id) + 1);
      const node = after.prepare('SELECT * FROM book_node WHERE id=?').get(id)!;
      assert.deepEqual(payload, { seed: { bookOrder: node.book_order, driftGroupId: node.drift_group_id, kind: node.kind,
        narrativeOrder: node.narrative_order, summary: node.summary, title: node.title, writingStatus: node.writing_status } });
    }
  }
}
/**
 * The membership projection: per affected chapter (UTF-8 order), the OR-set
 * diff of its prior live tags against its final links, then its primary
 * register — rebuilt independently of both authors.
 */
function verifyMembershipMutations(prior: DatabaseSync, after: DatabaseSync, generation: string, fixture: Case, step: Step,
  changeSet: SyncChangeSetV1, target: Resolved) {
  let chapters: string[] = [];
  if (step.operation === 'createStoryline' && storylineRows(prior, fixture.projectId).length === 0) {
    chapters = liveChapters(prior, fixture.projectId);
  } else if (step.operation === 'setChapterStorylines' || step.operation === 'restoreChapter') {
    chapters = [target.chapterId!];
  } else if (step.operation === 'trashStoryline') {
    // Live chapters only, as the renderer's store holds them.
    chapters = prior.prepare(`SELECT DISTINCT l.node_id FROM node_storyline_link l JOIN book_node n ON n.id=l.node_id
      AND n.deleted_at IS NULL WHERE l.storyline_id=?`).all(target.storylineId!).map(row => String(row.node_id));
  }
  chapters.sort(compareUtf8Bytewise);
  const force = step.operation === 'restoreChapter';
  const expected: Pick<Mutation, 'action' | 'target' | 'payload'>[] = [];
  let adds = 0;
  let removes = 0;
  for (const chapterId of chapters) {
    const current = liveTags(prior, generation, chapterId);
    const desired = links(after, chapterId);
    for (const storylineId of [...new Set([...current.keys(), ...desired.storylineIds])].sort(compareUtf8Bytewise)) {
      const setTarget = { family: 'set' as const, kind: 'membership', id: storylineId,
        incarnation: incarnationOf(after, generation, 'storyline', storylineId) };
      const observedAddTags = current.get(storylineId) ?? [];
      const remove = () => {
        removes += 1;
        expected.push({ action: 'set.remove', target: setTarget, payload: { memberId: chapterId, observedAddTags } });
      };
      if (desired.storylineIds.includes(storylineId)) {
        if (force && observedAddTags.length > 0) remove();
        if (force || observedAddTags.length === 0) {
          adds += 1;
          expected.push({ action: 'set.add', target: setTarget, payload: { memberId: chapterId, value: null } });
        }
      } else if (observedAddTags.length > 0) remove();
    }
    expected.push({ action: 'field.set', target: { family: 'entity', kind: 'node-storyline-primary', id: chapterId,
      incarnation: incarnationOf(after, generation, 'node', chapterId) }, payload: { field: 'storylineId', value: desired.primary } });
  }
  const actual = changeSet.mutations.filter(mutation => mutation.target.kind === 'membership' || mutation.target.kind === 'node-storyline-primary')
    .map(({ action, target: mutationTarget, payload }) => ({ action, target: mutationTarget, payload }));
  assert.deepEqual(actual, expected, 'Membership mutations are the per-chapter OR-set diff and primary register');
  return { chapters: chapters.length, adds, removes };
}
/**
 * Fact mutations: kv-entry lifecycle, field and order targets at incarnation
 * 0, seeds naming the storyline, purges/field sets of prior entries and order
 * payloads in the owner scope. Returns the created kv-entry IDs in order.
 */
function verifyFactMutations(prior: DatabaseSync, generation: string, projectId: string, changeSet: SyncChangeSetV1, storylineId: string | null): string[] {
  const mutations = changeSet.mutations.filter(mutation => mutation.target.kind === 'kv-entry');
  if (!storylineId) {
    assert.deepEqual(mutations, []);
    return [];
  }
  const owner = { projectId, ownerKind: 'storyline', ownerId: storylineId, namespace: 'facts' };
  const existing = new Set(factEntries(prior, generation, projectId, storylineId).map(entry => entry.id));
  const created: string[] = [];
  for (const mutation of mutations) {
    const { family, id, incarnation } = mutation.target;
    assert.equal(incarnation, 0);
    const payload = mutation.payload as Record<string, unknown>;
    if (family === 'order') {
      const positions = mutation.action === 'order.move' ? [payload] : payload.entries as Record<string, unknown>[];
      assert.deepEqual(Object.keys(payload).sort(), mutation.action === 'order.move' ? ['positionKey', 'scope'] : ['entries', 'scope']);
      assert.equal(payload.scope, factScope(storylineId));
      assert.equal(positions.length, 1);
      if (mutation.action === 'order.rebalance') assert.equal(positions[0]!.entityId, id);
      assert.match(String(positions[0]!.positionKey), /^[0-9A-Za-z]+$/u);
      continue;
    }
    assert.equal(family, 'entity');
    if (mutation.action === 'entity.create') {
      assert(!existing.has(id) && !created.includes(id));
      const seed = (payload.seed ?? {}) as Record<string, unknown>;
      assert.deepEqual({ ...payload, seed: { ...seed, key: null, value: null } }, { seed: { ...owner, key: null, value: null } });
      assert(typeof seed.key === 'string' && typeof seed.value === 'string');
      created.push(id);
    } else if (mutation.action === 'entity.purge') {
      assert(existing.has(id));
      assert.deepEqual(payload, {});
    } else {
      assert.equal(mutation.action, 'field.set');
      assert(existing.has(id));
      assert(['key', 'value'].includes(String(payload.field)) && typeof payload.value === 'string');
    }
  }
  return created;
}
const recordOf = (row: Row, facts: Fact[]): StorylineResult => ({ id: String(row.id), projectId: String(row.project_id),
  name: String(row.name), color: String(row.color), summary: String(row.summary), orderKey: Number(row.order_key), facts,
  documentId: `storyline:${String(row.id)}`, createdAt: String(row.created_at), updatedAt: String(row.updated_at) });
/** Each command changes exactly its commanded fields, the authored timestamp and the rank projection. */
function verifyCommand(prior: DatabaseSync, generation: string, fixture: Case, step: Step, commandInput: CommandInput, target: Resolved) {
  const projectId = fixture.projectId;
  const live = storylineRows(prior, projectId);
  if (step.operation === 'trashChapter' || step.operation === 'restoreChapter') {
    assert.deepEqual([step.result, step.library], [null, null]);
    const node = prior.prepare('SELECT kind,deleted_at FROM book_node WHERE id=?').get(target.chapterId!)!;
    assert.deepEqual([node.kind, node.deleted_at === null], ['chapter', step.operation === 'trashChapter']);
    return;
  }
  const library = step.library!;
  if (step.operation === 'setChapterStorylines') {
    // setNodeStorylines: an absent primary keeps the current one, null clears
    // it, then the first listed storyline; the primary is prepended if missing.
    const primary = (target.primary === undefined ? links(prior, target.chapterId!).primary : target.primary)
      ?? target.storylineIds[0] ?? null;
    const unique = [...new Set([...primary && !target.storylineIds.includes(primary) ? [primary] : [], ...target.storylineIds])];
    const result = step.result as Membership;
    assert.deepEqual(result, { chapterId: target.chapterId, storylineIds: unique.sort(compareUtf8Bytewise), primary });
    assert.notDeepEqual(links(prior, target.chapterId!), result, 'The command changes the membership');
    assert.deepEqual(library.memberships.find(item => item.chapterId === target.chapterId), result);
    return;
  }
  if (step.operation === 'moveStoryline') {
    const ids = live.map(row => String(row.id)).filter(id => id !== target.storylineId);
    ids.splice(target.before === null ? ids.length : ids.indexOf(target.before), 0, target.storylineId!);
    assert.notDeepEqual(ids, live.map(row => String(row.id)), 'The command reorders');
    const expected = ids.map((id, index) => ({ ...recordOf(live.find(row => row.id === id)!, factsOf(prior, generation, projectId, id)),
      orderKey: index, ...id === target.storylineId ? { updatedAt: step.createdAt } : {} }));
    assert.deepEqual(step.result, expected, 'A move re-ranks the list and stamps only the moved storyline');
    assert.deepEqual(library.storylines, expected);
    return;
  }
  const result = step.result as StorylineResult;
  assert.deepEqual(Object.keys(result).sort(), storylineKeys);
  assert.equal(result.updatedAt, step.createdAt);
  const placed = [...library.storylines, ...library.trashedStorylines].filter(item => item.id === result.id);
  assert.deepEqual(placed, [result], 'The library holds the result exactly once');
  assert.equal(library.trashedStorylines.includes(placed[0]!), step.operation === 'trashStoryline');
  if (step.operation === 'createStoryline') {
    assert.equal(prior.prepare('SELECT 1 FROM storylines WHERE id=?').get(result.id), undefined);
    assert.match(result.color, /^#[0-9A-F]{6}$/u, 'Host colour has the renderer randomColor shape');
    const existing = live.map(row => ({ id: String(row.id), projectId, name: String(row.name) }) as Storyline);
    assert.deepEqual(result, { id: result.id, projectId, name: makeUniqueStorylineName(commandInput.name ?? '', existing, projectId),
      color: result.color, summary: '', orderKey: live.length, facts: projectTemplate(prior, generation, projectId),
      documentId: `storyline:${result.id}`, createdAt: step.createdAt, updatedAt: step.createdAt });
    // The first storyline becomes every live chapter's only (primary) storyline.
    const chapters = liveChapters(prior, projectId);
    assert.deepEqual(library.memberships.map(item => item.chapterId), chapters);
    if (live.length === 0) {
      assert(chapters.length > 0);
      for (const membership of library.memberships) assert.deepEqual(membership, { chapterId: membership.chapterId, storylineIds: [result.id], primary: result.id });
    }
    return;
  }
  const previous = prior.prepare('SELECT * FROM storylines WHERE id=?').get(result.id);
  assert(previous);
  assert.equal(previous.deleted_at === null, step.operation !== 'restoreStoryline');
  const before = { ...recordOf(previous, factsOf(prior, generation, projectId, result.id)), updatedAt: step.createdAt };
  const others = live.filter(row => row.id !== result.id);
  const changed = step.operation === 'updateStoryline' ? {
    ...(commandInput.name !== undefined ? { name: makeUniqueStorylineName(commandInput.name,
      others.map(row => ({ id: String(row.id), projectId, name: String(row.name) }) as Storyline), projectId) } : {}),
    ...(commandInput.color !== undefined ? { color: commandInput.color } : {}),
    ...(commandInput.summary !== undefined ? { summary: commandInput.summary } : {}),
  } : step.operation === 'setStorylineFacts' ? { facts: cleanedFacts(commandInput.facts!) }
    // A restore re-ranks the storyline by its (order_key, id) placement among the live rows.
    : step.operation === 'restoreStoryline' ? { orderKey: [...live, previous]
      .sort((a, b) => Number(a.order_key) - Number(b.order_key) || compareUtf8Bytewise(String(a.id), String(b.id)))
      .findIndex(row => row.id === result.id) } : {};
  if (step.operation === 'updateStoryline' || step.operation === 'setStorylineFacts') {
    assert.notDeepEqual({ ...before, ...changed }, before, 'The command changes its fields');
  }
  assert.deepEqual(result, { ...before, ...changed });
}
/** The committed fractional-indexing vectors are exactly the JS package's. */
function verifyFractionalVectors() {
  const file = path.resolve('crates/drifting-core/tests/fixtures/fractional-indexing.json');
  const bytes = readFileSync(file);
  const cases = JSON.parse(bytes.toString('utf8')) as [string | null, string | null, number, string[] | 'ERR'][];
  assert(cases.length > 0);
  let errors = 0;
  for (const [left, right, count, expected] of cases) {
    let actual: string[] | 'ERR';
    try { actual = generateNKeysBetween(left, right, count); } catch { actual = 'ERR'; }
    assert.deepEqual(actual, expected, `fractional-indexing ${JSON.stringify([left, right, count])}`);
    if (expected === 'ERR') errors += 1;
  }
  return { status: 'passed', cases: cases.length, errors, fixtureSha256: sha(bytes) };
}

async function verify(fixture: Case, ordinal: number) {
  const expectedCase = expectedCases[fixture.name]!;
  assert.deepEqual(fixture.steps.map(step => step.operation), expectedCase.operations);
  assert.equal(fixture.chapterIds.length, 2);
  const temporary = mkdtempSync(path.join(path.dirname(output), `storyline-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const originalIds = new Set<string>();
  const originalTimes = new Map<string, string>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const generation = String(writerBefore[0]!.sync_generation_id);
  const baseline = snapshot(initial);
  verifyMembershipAuthority(initial, generation, fixture.chapterIds);
  // Local-only domain cells: `${table}\0${key}\0${column}` -> exact native/receiver values.
  const divergent = new Map<string, { native: unknown; receiver: unknown }>();
  const cell = (table: string, key: string, column: string) => `${table}\0${key}\0${column}`;
  const steps = [];
  try {
    for (const [index, step] of fixture.steps.entries()) {
      const commandInput = expectedCase.inputs[index]!;
      const bytes = Uint8Array.from(Buffer.from(step.encodedBase64, 'base64'));
      const decoded = await decodeSyncChangeSetV1(bytes);
      assert(decoded.ok, 'Actual native original must decode through production protocol');
      const changeSet = decoded.value;
      assert.deepEqual(encodeSyncChangeSetV1(changeSet), bytes);
      assert.equal(changeSet.projectId, fixture.projectId);
      assert.equal(changeSet.syncGenerationId, generation);
      assert.equal(changeSet.mutations.length, step.mutationCount);
      const actions = changeSet.mutations.map(mutation => mutation.action);
      assert.deepEqual(actions, expectedCase.actions[index]);
      const priorName = index === 0 ? fixture.beforeDatabase : fixture.steps[index - 1]!.afterDatabase;
      const prior = new DatabaseSync(database(priorName), { readOnly: true });
      const expectedAfter = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      try {
        // 1. Targets, incarnations, membership, order and fact payloads.
        const target = resolve(fixture, prior, step, commandInput);
        const storylineOperation = isStorylineOperation(step.operation);
        const incarnation = storylineOperation ? incarnationOf(expectedAfter, generation, 'storyline', target.storylineId!)
          : step.operation === 'setChapterStorylines' ? null : incarnationOf(expectedAfter, generation, 'node', target.chapterId!);
        verifyStorylineMutations(prior, expectedAfter, generation, fixture, step, changeSet, target);
        const membership = verifyMembershipMutations(prior, expectedAfter, generation, fixture, step, changeSet, target);
        const createdFactIds = verifyFactMutations(prior, generation, fixture.projectId, changeSet,
          step.operation === 'createStoryline' || step.operation === 'setStorylineFacts' ? target.storylineId : null);
        verifyCommand(prior, generation, fixture, step, commandInput, target);
        const orderPlan = actions.includes('order.rebalance') ? 'rebalance' : changeSet.mutations
          .some(mutation => mutation.target.family === 'order' && mutation.target.kind === 'storyline') ? 'moves' : null;
        // 2. The renderer use case, run on the same prior state, authors the same original.
        const renderer = await rendererOriginal(fixture, step, commandInput, target, database(priorName),
          path.join(temporary, `renderer-${index}.db`), createdFactIds);
        const seedIndex = step.operation === 'createStoryline' ? actions.indexOf('yjs.update') : -1;
        assert.equal(renderer.changeSet.mutations.length, changeSet.mutations.length);
        const substituted: SyncChangeSetV1 = { ...renderer.changeSet, mutations: renderer.changeSet.mutations.map((mutation, i) => {
          if (i !== seedIndex) return mutation;
          const native = changeSet.mutations[i]!;
          assert.deepEqual({ ...mutation, payload: null, payloadSha256: null }, { ...native, payload: null, payloadSha256: null });
          return native;
        }) };
        assert.deepEqual(encodeSyncChangeSetV1(substituted), bytes, 'Renderer use case authors the identical original');
        let seed: { native: Block[]; renderer: Block[] } | null = null;
        if (seedIndex >= 0) {
          const nativeSeed = parseYjsUpdatePayload(changeSet.mutations[seedIndex]!.payload).update;
          const rendererSeed = parseYjsUpdatePayload(renderer.changeSet.mutations[seedIndex]!.payload).update;
          assert.deepEqual(rendererSeed, renderer.seedState);
          const nativeStructure = structure(nativeSeed);
          const rendererStructure = structure(rendererSeed);
          assert.equal(nativeStructure.blocks.length, 1);
          assert.deepEqual({ ...nativeStructure.blocks[0], id: null }, { type: 'paragraph', id: null, text: '', attributes: ['id'] });
          assert.match(nativeStructure.blocks[0]!.id, /^native-paragraph-/u);
          assert.deepEqual(rendererStructure.blocks, []);
          assert.deepEqual(rendererStructure.json, { type: 'doc', content: [] });
          seed = { native: nativeStructure.blocks.map(block => ({ ...block, id: 'native-paragraph-<id>' })), renderer: rendererStructure.blocks };
        }
        const nativeAuthority = snapshot(expectedAfter, rendererAuthorityTables);
        for (const table of rendererAuthorityTables) {
          // Only the seed yjs.update payload (and so the envelope) differs.
          const project = (rows: Row[]) => canonicalRows(rows.map(item => {
            if (seedIndex < 0 || item.change_set_id !== changeSet.changeSetId) return item;
            if (table === 'sync_change_set') return { ...item, encoded_bytes: 'seed-differs', payload_sha256: 'seed-differs' };
            if (table === 'sync_mutation' && Number(item.mutation_index) === seedIndex) {
              return { ...item, payload_cbor: 'seed-differs', payload_sha256: 'seed-differs' };
            }
            return item;
          }));
          equalRows(`renderer ${table}`, project(renderer.authority[table]!), project(nativeAuthority[table]!));
        }
        // The renderer's own storyline, link and chapter rows: rank projection,
        // kv_json, membership and lifecycle columns included.
        for (const table of rendererDomainTables) {
          const nativeRows = new Map(raw(expectedAfter, table).map(row => [rowKey(table, row), row]));
          const rendererRows = new Map(renderer.rows[table].map(row => [rowKey(table, row), row]));
          assert.deepEqual([...rendererRows.keys()].sort(), [...nativeRows.keys()].sort(), `Renderer ${table} rows`);
          for (const [key, nativeProjection] of nativeRows) {
            const rendererRow: Row = { ...rendererRows.get(key)! };
            const nativeRow: Row = { ...nativeProjection };
            const commanded = table === 'storylines' ? key === target.storylineId : table === 'book_node' && key === target.chapterId;
            const clockColumns = !commanded ? [] : ['trashStoryline', 'trashChapter'].includes(step.operation)
              ? ['deleted_at', 'updated_at'] : ['restoreStoryline', 'restoreChapter'].includes(step.operation) ? ['updated_at'] : [];
            if (table === 'storylines' && commanded && seedIndex >= 0) {
              assert.equal(rendererRow.content_json, DEFAULT_TIPTAP_DOC_JSON);
              assert.deepEqual(JSON.parse(String(nativeRow.content_json)), structure(parseYjsUpdatePayload(changeSet.mutations[seedIndex]!.payload).update).json);
              rendererRow.content_json = nativeRow.content_json = 'compared-seed-cache';
            }
            for (const column of clockColumns) {
              assert.equal(nativeRow[column], step.createdAt);
              assert(Date.parse(String(rendererRow[column])) >= Date.parse(step.createdAt));
              rendererRow[column] = nativeRow[column] = 'compared-authored/wall-clock';
            }
            assert.deepEqual(normalize(rendererRow), normalize(nativeRow), `Renderer use case projects the same ${table} ${key}`);
          }
        }

        // 3. Replay on the independent receiver: only this original is new.
        const known = new Set(raw(gateway.database, 'sync_change_set').map(item => String(item.change_set_id)));
        assert.deepEqual(raw(expectedAfter, 'sync_change_set').map(item => String(item.change_set_id)).filter(id => !known.has(id)),
          [changeSet.changeSetId], 'Each step journals exactly one native original');
        const targets = new Set(changeSet.mutations.filter(mutation => mutation.action === 'yjs.update').map(mutation => mutation.target.id));
        const carried = carryCheckpoints(gateway.database, prior, expectedAfter, targets);
        const context = {
          changeSet,
          clock: { nowMs: Date.parse(step.createdAt), nowIso: step.createdAt },
          identity: { installationId: fixture.identity.installationId,
            createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) },
          kernel: productionSyncDomainMaterializationKernel,
        };
        if (step.faultBeforeApply) {
          const unchanged = snapshot(gateway.database);
          gateway.database.exec("CREATE TRIGGER fail_line_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic storyline receipt fault'); END");
          await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
          assert.deepEqual(snapshot(gateway.database), unchanged);
          gateway.database.exec('DROP TRIGGER fail_line_receipt');
        }
        const owner = snapshot(gateway.database, ownerTables);
        const factsBefore = snapshot(gateway.database, factTables);
        const receiverStamps = new Map(raw(gateway.database, 'storylines').map(row => [String(row.id), row.updated_at]));
        const applied = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(applied.status, 'applied');
        assert.deepEqual(applied.conflicts, []);
        if (targets.size === 0) assert.deepEqual(snapshot(gateway.database, ownerTables), owner, 'Scalar originals leave prose owners untouched');
        if (!changeSet.mutations.some(mutation => mutation.target.kind === 'kv-entry')) {
          assert.deepEqual(snapshot(gateway.database, factTables), factsBefore, 'Originals without facts leave the fact authority untouched');
        }
        originalIds.add(changeSet.changeSetId);
        originalTimes.set(changeSet.changeSetId, step.createdAt);
        verifyMembershipAuthority(expectedAfter, generation, fixture.chapterIds);
        verifyMembershipAuthority(gateway.database, generation, fixture.chapterIds);
        // Native projects every live storyline's rank from the order authority.
        const nativeOrder = registerOrder(expectedAfter, generation, fixture.projectId);
        assert.deepEqual(storylineRows(expectedAfter, fixture.projectId).map(row => [String(row.id), Number(row.order_key)]),
          nativeOrder.map((id, rank) => [id, rank]), 'Native order_key is the rank of the order authority');
        assert.deepEqual(registerOrder(gateway.database, generation, fixture.projectId), nativeOrder);
        // Local-only storyline cells: a storyline entity mutation re-stamps its
        // row on both roles; a facts-only update stamps it only locally.
        for (const mutation of changeSet.mutations) {
          if (mutation.target.family === 'entity' && mutation.target.kind === 'storyline') {
            divergent.delete(cell('storylines', mutation.target.id, 'updated_at'));
          }
        }
        const stampOf = (db: DatabaseSync, id: string) => db.prepare('SELECT updated_at FROM storylines WHERE id=?').get(id)!.updated_at;
        if (step.operation === 'setStorylineFacts' || step.operation === 'moveStoryline') {
          const id = target.storylineId!;
          assert.equal(stampOf(expectedAfter, id), step.createdAt, 'Native stamps a facts update or move locally');
          assert.equal(receiverStamps.get(id), stampOf(prior, id), 'The receiver held the native stamp before the command');
          if (step.operation === 'setStorylineFacts') assert.equal(stampOf(gateway.database, id), receiverStamps.get(id), 'A receiver keeps updated_at');
          divergent.set(cell('storylines', id, 'updated_at'), { native: step.createdAt, receiver: receiverStamps.get(id) });
        }
        // This original's remote order apply stamps every storyline it orders
        // with the winning HLC; the next apply re-materializes the row and the
        // stamp reverts (pinned per step, never carried).
        const orderStamps = new Map<string, { native: unknown; receiver: unknown }>();
        const ordered = new Set(changeSet.mutations.filter(mutation => mutation.target.family === 'order' && mutation.target.kind === 'storyline')
          .map(mutation => mutation.target.id));
        const orderedCells = new Set([...ordered].map(id => cell('storylines', id, 'updated_at')));
        for (const id of ordered) {
          const nativeValue = stampOf(expectedAfter, id);
          const receivedValue = stampOf(gateway.database, id);
          assert.equal(receivedValue, new Date(changeSet.hlc.wallMs).toISOString(), 'A receiver stamps ordered storylines with the winning HLC');
          if (isDeepStrictEqual(nativeValue, receivedValue)) continue;
          assert.equal(nativeValue, stampOf(prior, id), 'Native order changes stamp nothing');
          orderStamps.set(cell('storylines', id, 'updated_at'), { native: nativeValue, receiver: receivedValue });
        }
        for (const [key, value] of divergent) {
          const [table, id, column] = key.split('\0') as [string, string, string];
          if (table !== 'storylines' || column !== 'updated_at' || orderedCells.has(key)) continue;
          assert.equal(stampOf(gateway.database, id), value.receiver, 'A reverted order stamp restores the kept receiver value');
        }
        // Owner rows the reducer materialized for compared yjs.update originals.
        const receivedUpdates = new Map<number, string>();
        const receivedRevisions = new Map<string, string>();
        for (const receipt of raw(gateway.database, 'sync_yjs_materialization_receipt')) {
          const time = originalTimes.get(String(receipt.change_set_id));
          if (!time) continue;
          receivedUpdates.set(Number(receipt.update_row_id), time);
          receivedRevisions.set(`${receipt.document_id}\0${receipt.document_revision}`, time);
        }
        const receiveTime = (value: Row, column: string, native: boolean, time: string) => {
          if (native) assert.equal(value[column], time, `Native ${column} is the original's authored time`);
          else assert(typeof value[column] === 'string' && Date.parse(value[column] as string) >= Date.parse(time));
          value[column] = 'compared-authored/receive-time';
        };
        // Body caches compare as parsed JSON; where the reducer re-projected a
        // cache from Yjs, native preserved it.
        const projected: string[] = [];
        for (const [table, keyColumn, prefix] of [['storylines', 'id', 'storyline'], ['node_content', 'node_id', 'node-content']] as const) {
          for (const nativeItem of raw(expectedAfter, table)) {
            const id = String(nativeItem[keyColumn]);
            const body = `${prefix}:${id}`;
            const received = gateway.database.prepare(`SELECT * FROM ${table} WHERE ${keyColumn}=?`).get(id);
            assert(received, `${table} ${id} is materialized`);
            const nativeCache = JSON.parse(String(nativeItem.content_json)) as unknown;
            const receivedCache = JSON.parse(String(received.content_json)) as unknown;
            const priorCache = prior.prepare(`SELECT content_json FROM ${table} WHERE ${keyColumn}=?`).get(id);
            if (priorCache) assert.deepEqual(nativeCache, JSON.parse(String(priorCache.content_json)), 'Native commands keep an existing body cache');
            if (targets.has(body)) assert.deepEqual(receivedCache, structure(fullState(gateway.database, body)).json, 'Reducer cache projects authoritative Yjs');
            if (isDeepStrictEqual(nativeCache, receivedCache) && (table !== 'node_content' || nativeItem.updated_at === received.updated_at)) {
              if (targets.has(body)) {
                divergent.delete(cell(table, id, 'content_json'));
                divergent.delete(cell(table, id, 'updated_at'));
              }
              continue;
            }
            if (targets.has(body)) {
              assert(priorCache, 'Only a restore re-projects an existing cache');
              divergent.set(cell(table, id, 'content_json'), { native: nativeItem.content_json, receiver: received.content_json });
              if (table === 'node_content') {
                assert.equal(nativeItem.updated_at, prior.prepare('SELECT updated_at FROM node_content WHERE node_id=?').get(id)!.updated_at,
                  'Local restore preserves the existing prose cache timestamp');
                assert.equal(received.updated_at, new Date(changeSet.hlc.wallMs).toISOString(), 'A receiver stamps the winning HLC');
                divergent.set(cell(table, id, 'updated_at'), { native: nativeItem.updated_at, receiver: received.updated_at });
              }
              projected.push(table);
            }
          }
        }
        const parity = tables.map(table => {
          const adjusted = (db: DatabaseSync, native: boolean) => canonicalRows(raw(db, table).map(item => {
            const value = { ...item };
            const revision = receivedRevisions.get(`${value.document_id}\0${value.revision}`);
            if (table === 'yjs_updates' && receivedUpdates.has(Number(value.id))) {
              receiveTime(value, 'created_at', native, receivedUpdates.get(Number(value.id))!);
            }
            if (table === 'yjs_document_revision' && revision) receiveTime(value, 'updated_at', native, revision);
            if (table === 'yjs_document_revision_provenance' && revision) {
              receiveTime(value, 'created_at', native, revision);
              assert.equal(value.source_kind, native ? 'system' : 'remote');
              value.source_kind = 'compared-system/remote';
            }
            if (table === 'sync_change_set' && originalIds.has(String(value.change_set_id))) {
              assert.equal(value.origin, native ? 'local' : 'remote');
              value.origin = 'compared-original';
            }
            if (table === 'storylines' || table === 'node_content') {
              value.content_json = JSON.parse(String(value.content_json)) as unknown;
              for (const column of Object.keys(value)) {
                const key = cell(table, rowKey(table, value), column);
                const expected: { native: unknown; receiver: unknown } | undefined = orderedCells.has(key) ? orderStamps.get(key) : divergent.get(key);
                if (!expected) continue;
                const actual = column === 'content_json' ? JSON.stringify(value[column]) : value[column];
                const pinned: unknown = native ? expected.native : expected.receiver;
                assert.deepEqual(column === 'content_json' ? JSON.stringify(JSON.parse(String(pinned))) : pinned, actual, `Local-only ${table}.${column} of ${rowKey(table, value)} (${native ? 'native' : 'receiver'}, step ${index})`);
                value[column] = 'compared-local-only';
              }
            }
            return value;
          }));
          const actualRows = adjusted(gateway.database, false);
          equalRows(table, actualRows, adjusted(expectedAfter, true));
          if (preservedTables.includes(table)) equalRows(`${table} unchanged from baseline`, actualRows, baseline[table]!);
          return { table, rows: actualRows.length, sha256: sha(JSON.stringify(actualRows)) };
        });
        const remoteWriter = raw(gateway.database, 'sync_generation_writer_state');
        const nativeWriter = raw(expectedAfter, 'sync_generation_writer_state');
        assert.equal(remoteWriter.length, 1);
        assert.equal(nativeWriter.length, 1);
        assert.equal(remoteWriter[0]!.next_device_seq, writerBefore[0]!.next_device_seq);
        assert.equal(nativeWriter[0]!.next_device_seq, changeSet.deviceSeq + 1);
        assert(Number(remoteWriter[0]!.hlc_wall_ms) >= changeSet.hlc.wallMs);

        // 4. The bridge library equals what the production repositories read
        // back from the native database and, with pinned local-only cells, the receiver.
        if (step.library) {
          assert.deepEqual(await libraryOf(database(step.afterDatabase), path.join(temporary, `library-${index}.db`), fixture.projectId),
            step.library, 'Renderer repositories read the native library');
          const receivedLibrary = (item: StorylineResult): StorylineResult => {
            const key = cell('storylines', item.id, 'updated_at');
            const stamp = orderedCells.has(key) ? orderStamps.get(key) : divergent.get(key);
            return stamp ? { ...item, updatedAt: stamp.receiver as string } : item;
          };
          assert.deepEqual(await rendererLibrary(gateway.client(), fixture.projectId), {
            storylines: step.library.storylines.map(receivedLibrary),
            trashedStorylines: step.library.trashedStorylines.map(receivedLibrary),
            memberships: step.library.memberships,
          }, 'Renderer repositories read the same library from the receiver');
          for (const item of [...step.library.storylines, ...step.library.trashedStorylines]) {
            const row = expectedAfter.prepare('SELECT * FROM storylines WHERE id=?').get(item.id)!;
            assert.equal(row.kv_json, stringifyKv(item.facts), 'kv_json projects the facts');
            assert.deepEqual(factsOf(expectedAfter, generation, fixture.projectId, item.id), item.facts, 'Facts authority');
            assert.deepEqual(factsOf(gateway.database, generation, fixture.projectId, item.id), item.facts);
            assert.equal(row.node_content_template_json, '{}');
            assert.equal(row.deleted_at === null, step.library.storylines.includes(item));
          }
        }
        // 5. Authoritative prose: targeted bodies change only through this original.
        const documents = documentIds(expectedAfter).map(id => {
          const state = fullState(expectedAfter, id);
          assert.deepEqual(fullState(gateway.database, id), state);
          const targeted = targets.has(id);
          if (!targeted) assert.deepEqual(fullState(prior, id), state, `${id} changes only through this original`);
          else if (step.operation === 'restoreStoryline' || step.operation === 'restoreChapter') {
            // Restore carries the complete current state; the body is unchanged.
            const update = parseYjsUpdatePayload(changeSet.mutations[changeSet.mutations.length - 1]!.payload).update;
            assert.deepEqual(structure(update), structure(fullState(prior, id)));
            assert.deepEqual(fullState(prior, id), state);
          } else {
            // A created body is exactly the native seed.
            assert(!documentIds(prior).includes(id));
            const seedDoc = new Y.Doc();
            try {
              Y.applyUpdate(seedDoc, parseYjsUpdatePayload(changeSet.mutations[seedIndex]!.payload).update);
              assert.deepEqual(state, Y.encodeStateAsUpdate(seedDoc));
            } finally { seedDoc.destroy(); }
          }
          return { documentId: id.replace(/:.*/u, ':<id>'), targeted, stateSha256: sha(state) };
        });
        // 6. Re-applying the original is a no-op duplicate.
        const unchanged = snapshot(gateway.database);
        const totalChanges = gateway.database.prepare('SELECT total_changes() AS count').get()!.count;
        const duplicate = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(duplicate.status, 'duplicate');
        assert.deepEqual(snapshot(gateway.database), unchanged);
        assert.equal(gateway.database.prepare('SELECT total_changes() AS count').get()!.count, totalChanges);
        steps.push({ operation: step.operation, originalSha256: sha(bytes), mutationCount: step.mutationCount, actions,
          incarnation, membership, kvEntryIds: createdFactIds.length, orderPlan, rendererOrderKey: renderer.orderKey,
          localDomainWire: 'passed', rendererAuthority: 'passed', rendererRow: 'passed', seed,
          faultRollback: step.faultBeforeApply, duplicate: 'passed', membershipAuthority: 'passed', rankProjection: 'passed',
          library: step.library ? 'passed' : null, command: 'passed', carriedCheckpoints: carried.map(id => id.replace(/:.*/u, ':<id>')),
          cacheProjection: projected, receiverOrderStamps: orderStamps.size,
          localOnly: [...new Set([...divergent.keys()].map(key => {
            const [table, , column] = key.split('\0');
            return `${table}.${column}`;
          }))].sort(),
          tables: parity, documents, afterDatabaseSha256: sha(readFileSync(database(step.afterDatabase))) });
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
  assert.deepEqual(fixture.cases.map(item => item.name), Object.keys(expectedCases));
  mkdirSync(path.dirname(output), { recursive: true });
  const fractionalIndexing = verifyFractionalVectors();
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences, excludedColumns: [], exemptions, localOnlyEffects, carriedOwnerState, rendererDivergences, reducerDefects,
    fractionalIndexing,
    scope: 'Native storyline create/update/move/facts/trash/restore, chapter membership and chapter trash/restore originals match the renderer use cases authored on the same prior state (byte-identical except seed Yjs, with native kv-entry IDs replayed), production reducer SQLite effects, the production storyline, link and node repositories, membership OR-set/primary-register and order-rank projections and authoritative body Yjs. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, storylineSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
