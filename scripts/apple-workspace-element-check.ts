// Actual native element-library originals: rebuilt through the renderer use
// cases on the prior native database, then replayed by the production TS
// reducer on an independent copy and compared with the native databases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import {
  findElementNameConflict, makeUniqueElementName, type BookElement, type BookElementCategory,
} from '../src/renderer/domain/book-element';
import type { DbTransaction } from '../src/renderer/lib/db';
import { createYjsProseSeedState } from '../src/renderer/lib/agent/runtime/yjs-prose-command';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createElementCategoryRepository } from '../src/renderer/sqlite-repo/element-category-repo';
import { createBookElementSqliteRepository } from '../src/renderer/sqlite-repo/element-repo';
import { createAuthoredTransactionRunner } from '../src/renderer/sync/journal/authored-transaction';
import type { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
import { appendAuthoredProseSeedInTransaction } from '../src/renderer/sync/journal/yjs-update';
import {
  compareSyncTotalOrder, compareUtf8Bytewise, decodeCanonicalCbor, type SyncChangeSetV1, type SyncTotalOrderV1,
} from '../src/renderer/sync/protocol';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';
import { deleteEntityRelationsInTransaction } from '../src/renderer/usecase/entity-relation-cleanup';
import {
  cloneEntityKvEntriesInTransaction, normalizeAliasValue, replaceElementAliasesInTransaction,
  replaceEntityKvEntriesInTransaction,
} from '../src/renderer/usecase/normalized-kv-alias-authority';
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
  'project', 'book_node', 'node_content', 'entity_relation', 'entity_kv_entry', 'element_category', 'element',
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
const preservedTables = ['project', 'book_node', 'node_content', 'entity_relation', 'entity_kv_entry', 'sync_order_register'];
// Authority rows the renderer's own local authored transaction writes.
const rendererAuthorityTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_entity_lifecycle', 'sync_field_clock',
  'sync_set_tag', 'sync_order_register', 'entity_kv_entry', 'sync_generation_writer_state',
];
// Live body owners persist and re-stamp checkpoints outside element originals.
const ownerTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance', 'sync_yjs_materialization_receipt'];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
  'Materialized Yjs update, revision and provenance times: authored clock locally, receive wall clock remotely; provenance source system/remote',
];
const exemptions = [
  'Seed yjs.update payloads differ by design: native seeds one empty paragraph with a stable block id and caches it; the renderer seeds the category "{}" template as an empty fragment and caches "{}". Seeds are compared by decoded Yjs structure; every other byte of the original and every renderer authority row match.',
  'element/element_category content_json compares as parsed JSON (native key-sorted, reducer ProseMirror key order). A restore re-projects the reducer cache from authoritative Yjs while native, like the renderer restore, preserves the existing cache; each role is verified.',
  'The renderer repository softDelete/restore stamps its own row with the wall clock; native and the originals use the authored clock.',
  'An alias-only update carries no element field: the authoring side stamps element.updated_at (native and the renderer repository alike) while a receiving reducer keeps the previous value.',
];
const carriedOwnerState = [
  'A retired element body owner re-stamps its checkpoint (yjs_snapshots.updated_at, identical bytes) while trashing; for documents no mutation of the original targets, that row is carried from the native after-database, and every other owner row must be unchanged.',
];
const reducerDefects = [
  'TS remote alias projection (materializeSet) collects present members of every incarnation: after a restore the reducer writes element.aliases_json with the trashed incarnation\'s aliases repeated, where native and the renderer local path write the live incarnation only. Pinned to both restores; OR-set tags and every other column match.',
];
type Operation = 'createCategory' | 'createElement' | 'updateElement' | 'updateCategory' | 'trashElement' | 'restoreElement';
interface CommandInput {
  name?: string;
  summary?: string;
  groupName?: string | null;
  aliases?: string[];
  color?: string;
}
// The bridge-test commands, as the renderer use cases would receive them.
const expectedCases: Record<string, { operations: Operation[]; inputs: CommandInput[]; actions: string[][] }> = {
  'element-library-create-update-and-cold-reopen': {
    operations: ['createCategory', 'createElement', 'updateElement', 'updateCategory', 'updateElement'],
    inputs: [{ name: '人物' }, { groupName: '主角' },
      { name: '林凯🙂', summary: '雨夜来信的收件人', groupName: null, aliases: ['阿凯', ' Ｋａｉ '] },
      { name: '主要人物', color: '#112233' }, { aliases: ['阿凯', 'KAI'] }],
    actions: [['entity.create', 'yjs.update'], ['entity.create', 'yjs.update'],
      ['set.add', 'set.add', 'field.set', 'field.set', 'field.set'], ['field.set', 'field.set'],
      ['set.remove', 'set.add']],
  },
  'element-trash-retires-owner-and-restore-reopens-body': {
    operations: ['trashElement', 'restoreElement'], inputs: [{}, {}],
    actions: [['entity.trash'], ['entity.restore', 'set.add', 'yjs.update']],
  },
  'element-failures-roll-back-and-retry': {
    operations: ['createCategory', 'createElement', 'updateElement', 'trashElement', 'restoreElement'],
    inputs: [{ name: '势力' }, { name: '北塔守夜人' }, { summary: '值夜', aliases: ['守夜人'] }, {}, {}],
    actions: [['entity.create', 'yjs.update'], ['entity.create', 'yjs.update'], ['set.add', 'field.set'],
      ['entity.trash'], ['entity.restore', 'set.add', 'yjs.update']],
  },
};
interface ElementResult {
  id: string; projectId: string; categoryId: string | null; name: string; summary: string; aliases: string[];
  groupName: string | null; documentId: string; createdAt: string; updatedAt: string;
}
interface CategoryResult {
  id: string; projectId: string; name: string; color: string; documentId: string; createdAt: string; updatedAt: string;
}
interface Step {
  operation: Operation;
  encodedBase64: string;
  mutationCount: number;
  createdAt: string;
  afterDatabase: string;
  faultBeforeApply: boolean;
  result: ElementResult | CategoryResult;
}
interface Case {
  name: string;
  beforeDatabase: string;
  projectId: string;
  identity: { installationId: string; writerId: string; writerEpoch: string };
  steps: Step[];
}
type Row = Record<string, unknown>;
const isCategory = (operation: Operation) => operation === 'createCategory' || operation === 'updateCategory';
const elementKeys = ['aliases', 'categoryId', 'createdAt', 'documentId', 'groupName', 'id', 'name', 'projectId', 'summary', 'updatedAt'];
const categoryKeys = ['color', 'createdAt', 'documentId', 'id', 'name', 'projectId', 'updatedAt'];
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
const camel = (key: string) => key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());
/** Every column of one element/category row, camelCased like the bridge record. */
function record(db: DatabaseSync, table: 'element' | 'element_category', id: string): Row | undefined {
  const value = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  return value && Object.fromEntries(Object.entries(value).map(([key, item]) => [camel(key), item]));
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
    if (error.message.includes('synthetic element receipt fault')) return true;
    error = (error as Error & { cause?: unknown }).cause;
  }
  return false;
}
/** Renderer desiredAliases: trimmed NFKC display, last value per member, member order. */
function desiredAliases(values: readonly string[]): string[] {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const display = value.trim().normalize('NFKC');
    const member = normalizeAliasValue(display);
    if (member) aliases.set(member, display);
  }
  return [...aliases].sort(([a], [b]) => compareUtf8Bytewise(a, b)).map(([, display]) => display);
}
/** Present alias members per incarnation; the latest add wins each display. */
function aliasMembers(db: DatabaseSync, generation: string, elementId: string) {
  const rows = db.prepare(`SELECT t.incarnation,t.value_key,t.value_cbor,t.add_tag,t.add_mutation_index,c.hlc_wall_ms,
      c.hlc_counter,c.writer_id,c.writer_epoch,c.device_seq
    FROM sync_set_tag t JOIN sync_change_set c ON c.change_set_id=t.add_change_set_id
    WHERE t.sync_generation_id=? AND t.owner_kind='alias' AND t.owner_id=? AND t.set_key='aliases'
      AND t.removed_by_change_set_id IS NULL`).all(generation, elementId);
  const grouped = new Map<string, { incarnation: number; member: string; adds: { display: string; tag: string; order: SyncTotalOrderV1 }[] }>();
  for (const item of rows) {
    assert(item.value_cbor instanceof Uint8Array);
    const decoded = decodeCanonicalCbor(item.value_cbor);
    assert(decoded.ok && typeof decoded.value === 'string', 'Alias tags hold canonical text');
    const key = `${item.incarnation}\0${item.value_key}`;
    const group = grouped.get(key) ?? { incarnation: Number(item.incarnation), member: String(item.value_key), adds: [] };
    group.adds.push({ display: decoded.value, tag: String(item.add_tag), order: {
      hlc: { wallMs: Number(item.hlc_wall_ms), counter: Number(item.hlc_counter) }, writerId: String(item.writer_id),
      writerEpoch: String(item.writer_epoch), deviceSeq: Number(item.device_seq), mutationIndex: Number(item.add_mutation_index) } });
    grouped.set(key, group);
  }
  return [...grouped.values()].map(group => {
    group.adds.sort((a, b) => compareSyncTotalOrder(a.order, b.order) || compareUtf8Bytewise(a.tag, b.tag));
    return { incarnation: group.incarnation, member: group.member, display: group.adds[group.adds.length - 1]!.display,
      tags: group.adds.map(add => add.tag) };
  });
}
function lifecycle(db: DatabaseSync, generation: string, kind: string, id: string) {
  const value = db.prepare('SELECT incarnation,state FROM sync_entity_lifecycle WHERE sync_generation_id=? AND entity_kind=? AND entity_id=?')
    .get(generation, kind, id);
  return value ? { incarnation: Number(value.incarnation), state: String(value.state) } : null;
}
/** Renderer alias projection: the current incarnation's members in member order. */
function liveAliases(db: DatabaseSync, generation: string, elementId: string): string[] {
  const incarnation = lifecycle(db, generation, 'element', elementId)?.incarnation ?? 0;
  return aliasMembers(db, generation, elementId).filter(item => item.incarnation === incarnation)
    .sort((a, b) => compareUtf8Bytewise(a.member, b.member)).map(item => {
      assert.equal(normalizeAliasValue(item.display), item.member, 'Alias member id is the trimmed NFKC lowercase display');
      return item.display;
    });
}
/** The TS reducer's alias projection: present displays of every incarnation, display-sorted. */
function reducerAliases(db: DatabaseSync, generation: string, elementId: string): string[] {
  return aliasMembers(db, generation, elementId).map(item => item.display).sort(compareUtf8Bytewise);
}

/**
 * Mirror each renderer use case's authored effect (useElementCategory,
 * useBookElement and the withAtomicSyncTransaction writer) through the
 * production authored runner on a copy of the prior native database.
 */
async function rendererOriginal(fixture: Case, step: Step, commandInput: CommandInput, prior: string, scratch: string) {
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
  let seedState: Uint8Array | null = null;
  const result = step.result;
  try {
    switch (step.operation) {
      case 'createCategory': {
        // useElementCategory.createCategory; the colour is host-random in both.
        const category = result as CategoryResult;
        const created: BookElementCategory = {
          id: category.id, projectId, name: commandInput.name?.trim() || 'New Category', contentJson: '{}',
          elementTemplateJson: '{}', elementTemplateKvJson: '[]', color: category.color, layoutMode: 'auto',
          gridX: null, gridY: null, createdAt: step.createdAt, updatedAt: step.createdAt,
        };
        seedState = await createYjsProseSeedState(created.contentJson);
        const seed = seedState;
        await atomic(async (tx, sync, changes) => {
          const repository = createElementCategoryRepository(projectId, tx);
          await repository.create({ ...created, elementTemplateKvJson: '[]' });
          await replaceEntityKvEntriesInTransaction(tx, changes, { projectId, ownerKind: 'element-category',
            ownerId: created.id, namespace: 'element-template', nextJson: created.elementTemplateKvJson });
          const persisted = (await repository.findAll()).find(item => item.id === created.id)!;
          await sync('elementCategory', 'create', persisted.id, projectId, {
            id: persisted.id, name: persisted.name, elementTemplateJson: persisted.elementTemplateJson,
            color: persisted.color, layoutMode: persisted.layoutMode, gridX: persisted.gridX, gridY: persisted.gridY,
          });
          await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'category', entityId: persisted.id, stateUpdate: seed });
        });
        break;
      }
      case 'updateCategory': {
        // useElementCategory.updateCategory.
        const existing = (await createElementCategoryRepository(projectId, client).findAll()).find(item => item.id === result.id);
        assert(existing);
        const updates = commandInput;
        const updated: BookElementCategory = { ...existing, name: updates.name ?? existing.name,
          color: updates.color ?? existing.color, updatedAt: step.createdAt };
        await atomic(async (tx, sync) => {
          const repository = createElementCategoryRepository(projectId, tx);
          await repository.update(existing.id, { name: updated.name, contentJson: updated.contentJson,
            elementTemplateJson: updated.elementTemplateJson, color: updated.color, layoutMode: updated.layoutMode,
            gridX: updated.gridX, gridY: updated.gridY, updatedAt: updated.updatedAt });
          const persisted = (await repository.findAll()).find(item => item.id === existing.id)!;
          const payload: Record<string, unknown> = {};
          if (updates.name !== undefined) payload.name = persisted.name;
          if (updates.color !== undefined) payload.color = persisted.color;
          await sync('elementCategory', 'update', existing.id, projectId, payload);
        });
        break;
      }
      case 'createElement': {
        // useBookElement.createElement under the category's '{}' template.
        const element = result as ElementResult;
        const category = (await createElementCategoryRepository(projectId, client).findAll()).find(item => item.id === element.categoryId);
        const previous = await createBookElementSqliteRepository(projectId, client).findAll();
        assert(category);
        const seededContentJson = category.elementTemplateJson.trim() || '{}';
        seedState = await createYjsProseSeedState(seededContentJson);
        const seed = seedState;
        const name = commandInput.name?.trim() || makeUniqueElementName('New Element', previous, projectId);
        assert.equal(findElementNameConflict([name], previous, projectId), null);
        const created: BookElement = {
          id: element.id, projectId, categoryId: category.id, name, summary: commandInput.summary?.trim() || '',
          contentJson: seededContentJson, kvJson: category.elementTemplateKvJson.trim() || '[]', aliases: [],
          groupName: commandInput.groupName?.trim() || null, portraitAssetId: null,
          createdAt: step.createdAt, updatedAt: step.createdAt,
        };
        await atomic(async (tx, sync, changes) => {
          const repository = createBookElementSqliteRepository(projectId, tx);
          await repository.create({ ...created, kvJson: '[]', aliases: [] });
          await cloneEntityKvEntriesInTransaction(tx, changes, {
            source: { projectId, ownerKind: 'element-category', ownerId: category.id, namespace: 'element-template' },
            target: { projectId, ownerKind: 'element', ownerId: created.id, namespace: 'facts' },
          });
          await replaceElementAliasesInTransaction(tx, changes, { projectId, elementId: created.id, aliases: created.aliases });
          const persisted = (await repository.findById(created.id))!;
          await sync('element', 'create', persisted.id, projectId, { id: persisted.id, categoryId: persisted.categoryId,
            name: persisted.name, summary: persisted.summary, groupName: persisted.groupName });
          await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'element', entityId: persisted.id, stateUpdate: seed });
        });
        break;
      }
      case 'updateElement': {
        // useBookElement.updateElement: alias authority, then the named scalars.
        const elements = await createBookElementSqliteRepository(projectId, client).findAll();
        const existing = elements.find(item => item.id === result.id);
        assert(existing);
        const updates = commandInput;
        const nextName = (updates.name ?? existing.name).trim() || existing.name;
        const nextAliases = updates.aliases ? updates.aliases.map(alias => alias.trim()).filter(alias => alias.length > 0) : existing.aliases;
        if (updates.name !== undefined || updates.aliases !== undefined) {
          assert.equal(findElementNameConflict([nextName, ...nextAliases], elements, projectId, existing.id), null);
        }
        const updated: BookElement = { ...existing, name: nextName, summary: updates.summary ?? existing.summary,
          aliases: nextAliases, groupName: updates.groupName !== undefined ? updates.groupName : existing.groupName,
          updatedAt: step.createdAt };
        await atomic(async (tx, sync, changes) => {
          const repository = createBookElementSqliteRepository(projectId, tx);
          await repository.update(existing.id, { categoryId: updated.categoryId, name: updated.name, summary: updated.summary,
            contentJson: updated.contentJson, groupName: updated.groupName, portraitAssetId: updated.portraitAssetId,
            updatedAt: updated.updatedAt });
          if (updates.aliases !== undefined) {
            await replaceElementAliasesInTransaction(tx, changes, { projectId, elementId: existing.id, aliases: updates.aliases });
          }
          const persisted = (await repository.findById(existing.id))!;
          const payload: Record<string, unknown> = {};
          if (updates.name !== undefined) payload.name = persisted.name;
          if (updates.summary !== undefined) payload.summary = persisted.summary;
          if (updates.groupName !== undefined) payload.groupName = persisted.groupName;
          if (Object.keys(payload).length > 0) await sync('element', 'update', existing.id, projectId, payload);
        });
        break;
      }
      case 'trashElement':
        // useBookElement.removeElement with the trash feature.
        await atomic(async (tx, sync) => {
          await deleteEntityRelationsInTransaction(tx, sync, projectId, 'element', result.id);
          await createBookElementSqliteRepository(projectId, tx).softDelete(result.id);
          await sync('element', 'softDelete', result.id, projectId);
        });
        break;
      case 'restoreElement':
        // useBookElement.restoreElement -> sync-lifecycle-restore.
        await atomic(async (tx, sync) => {
          await createBookElementSqliteRepository(projectId, tx).restore(result.id);
          await sync('element', 'restore', result.id, projectId);
        });
        break;
    }
    const latest = gateway.database.prepare("SELECT encoded_bytes FROM sync_change_set WHERE origin='local' ORDER BY rowid DESC LIMIT 1").get();
    assert(latest && latest.encoded_bytes instanceof Uint8Array);
    const decoded = await decodeSyncChangeSetV1(latest.encoded_bytes);
    assert(decoded.ok, 'Renderer original must decode');
    const projection = gateway.database.prepare(`SELECT * FROM ${isCategory(step.operation) ? 'element_category' : 'element'} WHERE id=?`)
      .get(result.id);
    assert(projection);
    return { changeSet: decoded.value, seedState, authority: snapshot(gateway.database, rendererAuthorityTables), projection };
  } finally {
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

/** The bridge result equals the materialized row in every column. */
function verifyRow(db: DatabaseSync, step: Step, aliases: string[], expected: Step['result'] = step.result) {
  const deleted = step.operation === 'trashElement' ? step.createdAt : null;
  if (isCategory(step.operation)) {
    const result = step.result as CategoryResult;
    assert.deepEqual(Object.keys(result).sort(), categoryKeys);
    const value = record(db, 'element_category', result.id);
    assert(value);
    const { contentJson, elementTemplateJson, elementTemplateKvJson, layoutMode, gridX, gridY, deletedAt, ...columns } = value;
    assert.equal(typeof contentJson, 'string');
    assert.deepEqual([elementTemplateJson, elementTemplateKvJson, layoutMode, gridX, gridY, deletedAt], ['{}', '[]', 'auto', null, null, null]);
    assert.deepEqual({ ...columns, documentId: `category:${result.id}` }, result);
    return;
  }
  const result = expected as ElementResult;
  assert.deepEqual(Object.keys(result).sort(), elementKeys);
  const value = record(db, 'element', result.id);
  assert(value);
  const { contentJson, kvJson, aliasesJson, portraitAssetId, deletedAt, ...columns } = value;
  assert.equal(typeof contentJson, 'string');
  assert.deepEqual([kvJson, portraitAssetId, deletedAt], ['[]', null, deleted]);
  assert.deepEqual(JSON.parse(String(aliasesJson)), aliases);
  assert.deepEqual({ ...columns, aliases: result.aliases, documentId: `element:${result.id}` }, result);
}
/** Each command changes exactly its commanded fields and the authored timestamp. */
function verifyCommand(prior: DatabaseSync, step: Step, commandInput: CommandInput, categories: Map<number, string>) {
  const result = step.result;
  assert.equal(result.updatedAt, step.createdAt);
  if (step.operation === 'createCategory') {
    assert.equal(record(prior, 'element_category', result.id), undefined);
    assert.equal(result.name, commandInput.name!.trim());
    assert.match((result as CategoryResult).color, /^#[0-9A-F]{6}$/u, 'Host colour has the renderer randomColor shape');
    assert.equal(result.createdAt, step.createdAt);
    return;
  }
  if (step.operation === 'createElement') {
    assert.equal(record(prior, 'element', result.id), undefined);
    const element = result as ElementResult;
    assert.equal(element.createdAt, step.createdAt);
    assert(categories.size > 0 && [...categories.values()].includes(element.categoryId!));
    assert.deepEqual([element.name, element.summary, element.aliases, element.groupName],
      [commandInput.name?.trim() || 'New Element', '', [], commandInput.groupName?.trim() || null]);
    return;
  }
  const previous = isCategory(step.operation) ? record(prior, 'element_category', result.id) : record(prior, 'element', result.id);
  assert(previous);
  if (step.operation === 'updateCategory') {
    assert.deepEqual(result, { id: previous.id, projectId: previous.projectId, name: commandInput.name ?? previous.name,
      color: commandInput.color ?? previous.color, documentId: `category:${result.id}`, createdAt: previous.createdAt, updatedAt: step.createdAt });
    return;
  }
  const before = { id: previous.id, projectId: previous.projectId, categoryId: previous.categoryId, name: previous.name,
    summary: previous.summary, aliases: JSON.parse(String(previous.aliasesJson)) as string[], groupName: previous.groupName,
    documentId: `element:${result.id}`, createdAt: previous.createdAt, updatedAt: step.createdAt };
  assert.equal(previous.deletedAt === null, step.operation !== 'restoreElement');
  const changed = step.operation === 'updateElement' ? {
    ...(commandInput.name !== undefined ? { name: commandInput.name.trim() || previous.name } : {}),
    ...(commandInput.summary !== undefined ? { summary: commandInput.summary } : {}),
    ...(commandInput.groupName !== undefined ? { groupName: commandInput.groupName?.trim() || null } : {}),
    ...(commandInput.aliases !== undefined ? { aliases: desiredAliases(commandInput.aliases) } : {}),
  } : {};
  if (step.operation === 'updateElement') assert.notDeepEqual({ ...before, ...changed }, before, 'The command changes its fields');
  assert.deepEqual(result, { ...before, ...changed });
}
/** Alias set mutations: NFKC member ids, displays and observed tags from the prior authority. */
function verifyAliasMutations(prior: DatabaseSync, generation: string, changeSet: SyncChangeSetV1, elementId: string, incarnation: number) {
  const current = aliasMembers(prior, generation, elementId).filter(item => item.incarnation === incarnation);
  let removes = 0;
  for (const mutation of changeSet.mutations.filter(item => item.target.family === 'set')) {
    assert.deepEqual(mutation.target, { family: 'set', kind: 'alias', id: elementId, incarnation });
    const payload = mutation.payload as Record<string, unknown>;
    if (mutation.action === 'set.add') {
      assert.deepEqual(Object.keys(payload).sort(), ['memberId', 'value']);
      assert.equal(payload.value, String(payload.value).trim().normalize('NFKC'));
      assert.equal(payload.memberId, normalizeAliasValue(String(payload.value)));
    } else {
      assert.equal(mutation.action, 'set.remove');
      removes += 1;
      const member = current.find(item => item.member === payload.memberId);
      assert(member, 'A removal names a present member');
      assert.deepEqual(payload.observedAddTags, member.tags);
    }
  }
  return removes;
}

async function verify(fixture: Case, ordinal: number) {
  const expectedCase = expectedCases[fixture.name]!;
  assert.deepEqual(fixture.steps.map(step => step.operation), expectedCase.operations);
  const temporary = mkdtempSync(path.join(path.dirname(output), `element-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const elementRepository = createBookElementSqliteRepository(fixture.projectId, gateway.client());
  const categoryRepository = createElementCategoryRepository(fixture.projectId, gateway.client());
  const originalIds = new Set<string>();
  const originalTimes = new Map<string, string>();
  const createdCategories = new Map<number, string>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const generation = String(writerBefore[0]!.sync_generation_id);
  const baseline = snapshot(initial);
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
        // 1. Targets, lifecycle incarnations and alias payloads.
        const kind = isCategory(step.operation) ? 'element-category' : 'element';
        const before = lifecycle(prior, generation, kind, step.result.id);
        const incarnation = step.operation === 'restoreElement' ? before!.incarnation + 1 : before?.incarnation ?? 0;
        assert.deepEqual(before?.state ?? null, step.operation.startsWith('create') ? null
          : step.operation === 'restoreElement' ? 'trashed' : 'live');
        const documentId = `${isCategory(step.operation) ? 'category' : 'element'}:${step.result.id}`;
        assert.equal(step.result.documentId, documentId);
        for (const mutation of changeSet.mutations) {
          assert.equal(mutation.target.incarnation, incarnation);
          if (mutation.target.family === 'entity') assert.deepEqual(mutation.target, { family: 'entity', kind, id: step.result.id, incarnation });
          if (mutation.target.family === 'yjs') assert.deepEqual(mutation.target, { family: 'yjs', kind: 'prose-document', id: documentId, incarnation });
        }
        const aliasRemovals = isCategory(step.operation) ? 0 : verifyAliasMutations(prior, generation, changeSet, step.result.id, incarnation);
        verifyCommand(prior, step, commandInput, createdCategories);
        if (step.operation === 'createCategory') createdCategories.set(index, step.result.id);
        // 2. The renderer use case, run on the same prior state, authors the same original.
        const renderer = await rendererOriginal(fixture, step, commandInput, database(priorName), path.join(temporary, `renderer-${index}.db`));
        const seedIndexes = step.operation === 'createCategory' || step.operation === 'createElement' ? [1] : [];
        assert.equal(renderer.changeSet.mutations.length, changeSet.mutations.length);
        const substituted: SyncChangeSetV1 = { ...renderer.changeSet, mutations: renderer.changeSet.mutations.map((mutation, i) => {
          if (!seedIndexes.includes(i)) return mutation;
          const native = changeSet.mutations[i]!;
          assert.deepEqual({ ...mutation, payload: null, payloadSha256: null }, { ...native, payload: null, payloadSha256: null });
          return native;
        }) };
        assert.deepEqual(encodeSyncChangeSetV1(substituted), bytes, 'Renderer use case authors the identical original');
        let seed: { native: Block[]; renderer: Block[] } | null = null;
        if (seedIndexes.length > 0) {
          const nativeSeed = parseYjsUpdatePayload(changeSet.mutations[1]!.payload).update;
          const rendererSeed = parseYjsUpdatePayload(renderer.changeSet.mutations[1]!.payload).update;
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
            if (seedIndexes.length === 0 || item.change_set_id !== changeSet.changeSetId) return item;
            if (table === 'sync_change_set') return { ...item, encoded_bytes: 'seed-differs', payload_sha256: 'seed-differs' };
            if (table === 'sync_mutation' && seedIndexes.includes(Number(item.mutation_index))) {
              return { ...item, payload_cbor: 'seed-differs', payload_sha256: 'seed-differs' };
            }
            return item;
          }));
          equalRows(`renderer ${table}`, project(renderer.authority[table]!), project(nativeAuthority[table]!));
        }
        // The renderer's own row projection, aliases_json included.
        const nativeProjection = expectedAfter.prepare(`SELECT * FROM ${isCategory(step.operation) ? 'element_category' : 'element'} WHERE id=?`)
          .get(step.result.id);
        assert(nativeProjection);
        const rendererRow: Row = { ...renderer.projection };
        const nativeRow: Row = { ...nativeProjection };
        if (seedIndexes.length > 0) {
          assert.equal(rendererRow.content_json, '{}');
          assert.deepEqual(JSON.parse(String(nativeRow.content_json)), structure(parseYjsUpdatePayload(changeSet.mutations[1]!.payload).update).json);
          rendererRow.content_json = nativeRow.content_json = 'compared-seed-cache';
        }
        if (step.operation === 'trashElement' || step.operation === 'restoreElement') {
          for (const column of step.operation === 'trashElement' ? ['deleted_at', 'updated_at'] : ['updated_at']) {
            assert.equal(nativeRow[column], step.createdAt);
            assert(Date.parse(String(rendererRow[column])) >= Date.parse(step.createdAt));
            rendererRow[column] = nativeRow[column] = 'compared-authored/wall-clock';
          }
        }
        assert.deepEqual(normalize(rendererRow), normalize(nativeRow), 'Renderer use case projects the same row');

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
          gateway.database.exec("CREATE TRIGGER fail_element_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic element receipt fault'); END");
          await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
          assert.deepEqual(snapshot(gateway.database), unchanged);
          gateway.database.exec('DROP TRIGGER fail_element_receipt');
        }
        const owner = snapshot(gateway.database, ownerTables);
        const applied = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
        assert.equal(applied.status, 'applied');
        assert.deepEqual(applied.conflicts, []);
        if (targets.size === 0) assert.deepEqual(snapshot(gateway.database, ownerTables), owner, 'Scalar originals leave prose owners untouched');
        originalIds.add(changeSet.changeSetId);
        originalTimes.set(changeSet.changeSetId, step.createdAt);
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
        // Caches compare as parsed JSON; where the reducer re-projected a body
        // cache, native preserved it. Alias projections are checked per role.
        const projected = new Set<string>();
        const staleAliases = new Set<string>();
        for (const table of ['element', 'element_category'] as const) {
          for (const nativeItem of raw(expectedAfter, table)) {
            const id = String(nativeItem.id);
            const received = gateway.database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
            assert(received, `${table} ${id} is materialized`);
            const body = `${table === 'element' ? 'element' : 'category'}:${id}`;
            const nativeCache = JSON.parse(String(nativeItem.content_json)) as unknown;
            const receivedCache = JSON.parse(String(received.content_json)) as unknown;
            const priorCache = prior.prepare(`SELECT content_json FROM ${table} WHERE id=?`).get(id);
            if (priorCache) assert.deepEqual(nativeCache, JSON.parse(String(priorCache.content_json)), 'Native commands keep an existing body cache');
            if (targets.has(body)) assert.deepEqual(receivedCache, structure(fullState(gateway.database, body)).json, 'Reducer cache projects authoritative Yjs');
            if (!isDeepStrictEqual(nativeCache, receivedCache)) {
              assert(targets.has(body) && priorCache, 'Only a restore re-projects an existing cache');
              projected.add(`${table}\0${id}`);
            }
            if (table !== 'element') continue;
            const live = liveAliases(expectedAfter, generation, id);
            assert.deepEqual(JSON.parse(String(nativeItem.aliases_json)), live, 'Native aliases_json is the live display projection');
            assert.deepEqual(liveAliases(gateway.database, generation, id), live);
            const receivedAliases = JSON.parse(String(received.aliases_json)) as unknown;
            if (!isDeepStrictEqual(receivedAliases, live)) {
              assert.deepEqual(receivedAliases, reducerAliases(gateway.database, generation, id), 'Reducer alias projection spans incarnations');
              staleAliases.add(id);
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
            if (table === 'element' || table === 'element_category') {
              value.content_json = projected.has(`${table}\0${value.id}`)
                ? 'compared-preserved-cache/reducer-projection' : JSON.parse(String(value.content_json)) as unknown;
            }
            if (table === 'element' && staleAliases.has(String(value.id))) value.aliases_json = 'compared-live/reducer-all-incarnations';
            // Set mutations carry no row field: the authoring side stamps
            // updated_at like the renderer repository; a receiver keeps it.
            if (table === 'element' && value.id === step.result.id
              && changeSet.mutations.every(mutation => mutation.action.startsWith('set.'))) {
              if (native) assert.equal(value.updated_at, step.createdAt);
              value.updated_at = 'compared-authored/received-set-only';
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

        // 4. Rows equal the bridge result, raw and through the production repositories.
        const stale = staleAliases.has(step.result.id);
        // A set-only original leaves the receiver's updated_at as it was.
        const received = changeSet.mutations.every(mutation => mutation.action.startsWith('set.'))
          ? { ...step.result, updatedAt: String(record(prior, 'element', step.result.id)!.updatedAt) } : step.result;
        verifyRow(expectedAfter, step, (step.result as Partial<ElementResult>).aliases ?? []);
        verifyRow(gateway.database, step, stale ? reducerAliases(gateway.database, generation, step.result.id)
          : (step.result as Partial<ElementResult>).aliases ?? [], received);
        if (isCategory(step.operation)) {
          const persisted = (await categoryRepository.findAll()).find(item => item.id === step.result.id);
          assert(persisted);
          const { id, projectId, name, color, createdAt, updatedAt } = persisted;
          assert.deepEqual({ id, projectId, name, color, documentId: `category:${id}`, createdAt, updatedAt }, step.result);
        } else {
          const persisted = await elementRepository.findById(step.result.id);
          assert(persisted);
          const { contentJson: _content, kvJson, portraitAssetId, aliases, ...columns } = persisted;
          assert.deepEqual([kvJson, portraitAssetId], ['[]', null]);
          const result = received as ElementResult;
          assert.deepEqual(aliases, stale ? reducerAliases(gateway.database, generation, result.id) : result.aliases);
          assert.deepEqual({ ...columns, aliases: result.aliases, documentId: `element:${result.id}` }, result);
          const live = (await elementRepository.findAll()).some(item => item.id === result.id);
          const trashed = (await elementRepository.findTrashed()).some(item => item.id === result.id);
          assert.deepEqual([live, trashed], step.operation === 'trashElement' ? [false, true] : [true, false]);
        }
        // 5. Authoritative prose: targeted bodies change only through this original.
        const documents = documentIds(expectedAfter).map(id => {
          const state = fullState(expectedAfter, id);
          assert.deepEqual(fullState(gateway.database, id), state);
          const targeted = targets.has(id);
          if (!targeted) assert.deepEqual(fullState(prior, id), state, `${id} changes only through this original`);
          else if (step.operation === 'restoreElement') {
            // Restore carries the complete current state; the body is unchanged.
            const update = parseYjsUpdatePayload(changeSet.mutations[changeSet.mutations.length - 1]!.payload).update;
            assert.deepEqual(structure(update), structure(fullState(prior, id)));
            assert.deepEqual(fullState(prior, id), state);
          } else {
            // A created body is exactly the native seed.
            assert(!documentIds(prior).includes(id));
            const seedDoc = new Y.Doc();
            try {
              Y.applyUpdate(seedDoc, parseYjsUpdatePayload(changeSet.mutations[1]!.payload).update);
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
          incarnation, aliasRemovals, localDomainWire: 'passed', rendererAuthority: 'passed', rendererRow: 'passed', seed,
          faultRollback: step.faultBeforeApply, duplicate: 'passed', row: 'passed', aliases: 'passed', command: 'passed',
          carriedCheckpoints: carried.map(id => id.replace(/:.*/u, ':<id>')),
          cacheProjection: [...projected].map(key => key.split('\0')[0]!), staleIncarnationAliases: stale,
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
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences, excludedColumns: [], exemptions, carriedOwnerState, reducerDefects,
    scope: 'Native element category and element create/update/trash/restore originals match the renderer use cases authored on the same prior state (byte-identical except seed Yjs), production reducer SQLite effects, the production element/category repositories, alias OR-set projection and authoritative body Yjs. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, elementSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
