// Actual native drift, drift-group and act-binding originals: rebuilt through
// the renderer use cases (useBookNode, useDriftGroup, useBookAct) on the prior
// native database, then replayed by the production TS reducer on an
// independent copy and compared with the native databases. One native command
// may journal several originals (a drift trash first unbinds its act in an
// original of its own); every original of a step is compared in order.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { deriveProseMetricFromJson } from '@drifting/prose-metrics';
import { generateNKeysBetween } from 'fractional-indexing';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import type { BookAct } from '../src/renderer/domain/book-act';
import { compareBookOrder, isDrift, makeUniqueNodeTitle, type BookNode } from '../src/renderer/domain/book-node';
import { compareDriftGroups, groupDepth, MAX_DRIFT_GROUP_DEPTH, type DriftGroup } from '../src/renderer/domain/drift-group';
import type { DbExecutor, DbTransaction } from '../src/renderer/lib/db';
import { createYjsProseSeedState } from '../src/renderer/lib/agent/runtime/yjs-prose-command';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createBookActRepository } from '../src/renderer/sqlite-repo/book-act-repo';
import { createBookContentRepository } from '../src/renderer/sqlite-repo/content-repo';
import { createDriftGroupRepository } from '../src/renderer/sqlite-repo/drift-group-repo';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { createTimelineMarkerRepository } from '../src/renderer/sqlite-repo/timeline-marker-repo';
import { createAuthoredTransactionRunner } from '../src/renderer/sync/journal/authored-transaction';
import type { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
import {
  appendAuthoredOrderRebalance, authoredOrderRebalanceEntries, driftGroupOrderScope, entityIdsByNumericPlacement,
} from '../src/renderer/sync/journal/order-authority';
import { appendPlannedAuthoredOrderInTransaction } from '../src/renderer/sync/journal/order-authority-repository';
import { appendAuthoredProseSeedInTransaction } from '../src/renderer/sync/journal/yjs-update';
import { compareUtf8Bytewise, type SyncChangeSetV1 } from '../src/renderer/sync/protocol';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';
import { persistBookNodeUpdateWithSync } from '../src/renderer/usecase/book-node-write';
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
  'project', 'book_node', 'node_content', 'book_act', 'drift_group', 'timeline_marker', 'storylines', 'node_storyline_link',
  'entity_relation', 'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
// Drifts carry no storyline membership, markers or relations in these commands.
const preservedTables = ['project', 'timeline_marker', 'storylines', 'node_storyline_link', 'entity_relation', 'sync_set_tag'];
// Authority rows the renderer's own local authored transactions write.
const rendererAuthorityTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_entity_lifecycle', 'sync_field_clock',
  'sync_set_tag', 'sync_order_register', 'sync_generation_writer_state',
];
// Domain rows the renderer use cases write themselves.
const rendererDomainTables = ['book_node', 'node_content', 'book_act', 'drift_group', 'timeline_marker'] as const;
// Live body owners persist and re-stamp checkpoints outside originals.
const ownerTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance', 'sync_yjs_materialization_receipt'];
// The renderer scatters a new drift at ((random - 0.5) * 600, (random - 0.5) * 600); pinned here.
const PINNED_RANDOM = [0.25, 0.75] as const;
const PINNED_POSITION = { x: (PINNED_RANDOM[0] - 0.5) * 600, y: (PINNED_RANDOM[1] - 0.5) * 600 };
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
  'Materialized Yjs update, revision and provenance times: authored clock locally, receive wall clock remotely; provenance source system/remote',
];
const exemptions = [
  'Seed yjs.update payloads differ by design: native seeds one empty paragraph with a stable block id and caches it; the renderer seeds DEFAULT_TIPTAP_DOC_JSON as an empty fragment and caches it. Seeds are compared by decoded Yjs structure; every other byte of the original and every renderer authority row match.',
  'A new drift\'s word_count_basis_hash is the prose metric of its own seed cache on each side (verified as deriveProseMetricFromJson of that cache); word count, basis kind and revision match.',
  'node_content.content_json compares as parsed JSON (native key-sorted, reducer ProseMirror key order). A restore re-projects the reducer cache (and node_content.updated_at from the winning HLC) from authoritative Yjs while native, like the renderer restore, preserves the existing cache; each role is verified.',
  'The renderer content repository create and node softDelete/restore stamp created_at/updated_at/deleted_at with the wall clock; native and the originals use the authored clock.',
  'Host-chosen drift and drift-group IDs (renderer uuidv7) and the use-case clock are injected from the native result; the renderer computes every title, name, sibling order, order key, act unbind and wire byte itself.',
];
const localOnlyEffects = [
  'A new drift\'s graph position is local-only: no create mutation carries it, native and a receiver hold 0,0, and the renderer keeps its random scatter (pinned: Math.random 0.25, 0.75 gives -150,150); a later restore authors the stored position.',
  'Prose metrics are local projections the remote materializer never writes: a created drift keeps its seed word-count basis (kind, hash, revision 1) on the authoring side while a receiver holds none. Tracked per row with exact values.',
  'A drift title edit (renameNode/updateNode) within the millisecond of the drift\'s previous stamp floors updated_at at that stamp + 1 ms on the authoring side (native and the renderer alike) while a receiver stamps the winning HLC; when it occurs it is tracked per row with exact values.',
];
assert.deepEqual(PINNED_POSITION, { x: -150, y: 150 });
const carriedOwnerState = [
  'A retired body owner re-stamps its checkpoint (yjs_snapshots.updated_at, identical bytes) while trashing; for documents no mutation of the step targets, that row is carried from the native after-database, and every other owner row must be unchanged.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences: string[] = [];
const reducerDefects = [
  'TS remote node stamps follow field-register order, not time: every remote apply re-materializes each field register of the reduced state in effect-id (UTF-8) order and each write stamps updated_at with that register\'s winning HLC, so a node ends at the time of its UTF-8-last field register. After a drift\'s group moves later than its title edit (moveDriftToGroup, a group delete lifting it), a receiver keeps the older title time while native and the renderer keep the move time. Pinned per row with exact values.',
];
type Operation = 'createGroup' | 'createDrift' | 'renameDrift' | 'updateDrift' | 'moveDrift' | 'deleteGroup' | 'bindAct'
  | 'trashDrift' | 'restoreDrift';
/** The bridge-test commands, with drifts, groups and acts named as the author sees them. */
interface CommandInput {
  name?: string;
  parent?: string;
  title?: string;
  group?: string;
  drift?: string;
  act?: string;
}
const expectedCases: Record<string, { operations: Operation[]; inputs: CommandInput[]; actions: string[][][] }> = {
  'drift-groups-bodies-links-and-cold-reopen': {
    operations: ['createGroup', 'createGroup', 'createDrift', 'createDrift', 'renameDrift', 'updateDrift', 'moveDrift', 'deleteGroup'],
    inputs: [{ name: '灵感' }, { name: '细节', parent: '灵感' }, { title: '雨夜钟声', group: '灵感' }, { title: '北塔', group: '灵感' },
      { drift: '雨夜钟声', title: '北塔' }, { drift: '北塔 2', title: '雨夜钟声🙂', group: '细节' }, { drift: '雨夜钟声🙂', group: '灵感' },
      { group: '灵感' }],
    actions: [[['entity.create', 'order.move']], [['entity.create', 'order.move']], [['entity.create', 'yjs.update']],
      [['entity.create', 'yjs.update']], [['field.set']], [['field.set', 'field.set']], [['field.set']],
      [['field.set', 'order.rebalance', 'field.set', 'field.set', 'entity.purge']]],
  },
  'drift-act-binding-trash-restore-and-failures': {
    operations: ['bindAct', 'trashDrift', 'restoreDrift'],
    inputs: [{ act: '第一幕', drift: '第一幕笔记' }, { drift: '第一幕笔记' }, { drift: '第一幕笔记' }],
    actions: [[['field.set']], [['field.set'], ['entity.trash']], [['entity.restore', 'tuple.set', 'yjs.update']]],
  },
};
interface DriftResult {
  id: string; projectId: string; title: string; summary: string; driftGroupId: string | null; actId: string | null;
  documentId: string; createdAt: string; updatedAt: string;
}
interface GroupResult { id: string; projectId: string; name: string; parentGroupId: string | null; sortOrder: number | null; createdAt: string; updatedAt: string }
type ActResult = BookAct;
interface Library { drifts: DriftResult[]; trashedDrifts: DriftResult[]; groups: GroupResult[] }
interface Original { encodedBase64: string; mutationCount: number; createdAt: string }
interface Step {
  operation: Operation;
  originals: Original[];
  afterDatabase: string;
  faultBeforeApply: boolean;
  result: DriftResult | GroupResult | ActResult | null;
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
const driftKeys = ['actId', 'createdAt', 'documentId', 'driftGroupId', 'id', 'projectId', 'summary', 'title', 'updatedAt'];
const DEFAULT_TIPTAP_DOC_JSON = JSON.stringify({ type: 'doc', content: [] });
// useDriftGroup DEFAULT_DRIFT_GROUP_NAME; drift UI callers pass 'New Drift'.
const DEFAULT_DRIFT_GROUP_NAME = '新分组';
const DEFAULT_DRIFT_TITLE = 'New Drift';
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
    if (error.message.includes('synthetic drift receipt fault')) return true;
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
function driftNamed(db: DatabaseSync, projectId: string, title: string, trashed = false): string {
  const matches = db.prepare(`SELECT id FROM book_node WHERE project_id=? AND kind='drift' AND title=? AND deleted_at IS ${trashed ? 'NOT ' : ''}NULL`)
    .all(projectId, title);
  assert.equal(matches.length, 1, `Exactly one ${trashed ? 'trashed' : 'live'} drift is titled ${title}`);
  return String(matches[0]!.id);
}
function groupNamed(db: DatabaseSync, projectId: string, name: string): string {
  const matches = db.prepare('SELECT id FROM drift_group WHERE project_id=? AND name=?').all(projectId, name);
  assert.equal(matches.length, 1, `Exactly one drift group is named ${name}`);
  return String(matches[0]!.id);
}
function actNamed(db: DatabaseSync, projectId: string, name: string): string {
  const matches = db.prepare('SELECT id FROM book_act WHERE project_id=? AND name=?').all(projectId, name);
  assert.equal(matches.length, 1, `Exactly one act is named ${name}`);
  return String(matches[0]!.id);
}
const groupScope = (projectId: string, parent: unknown) => JSON.stringify([projectId, parent ?? null]);
/**
 * Drift-group rank projection, as the local reducer projects it: per scope,
 * current-incarnation registers of existing live groups by (position key, id);
 * every group's sort_order is its rank in its parent's scope.
 */
function verifyRankProjection(db: DatabaseSync, generation: string, projectId: string): number {
  const groups = db.prepare('SELECT id,parent_group_id,sort_order FROM drift_group WHERE project_id=?').all(projectId);
  const existing = new Set(groups.map(row => String(row.id)));
  for (const scope of [...new Set(groups.map(row => groupScope(projectId, row.parent_group_id)))]) {
    const order = db.prepare("SELECT entity_id,incarnation,position_key FROM sync_order_register WHERE sync_generation_id=? AND list_kind='drift-group' AND owner_id=?")
      .all(generation, scope)
      .filter(row => {
        const id = String(row.entity_id);
        const owner = lifecycle(db, generation, 'drift-group', id);
        return existing.has(id) && (!owner || owner.state === 'live') && Number(row.incarnation) === (owner?.incarnation ?? 0);
      })
      .sort((a, b) => compareUtf8Bytewise(String(a.position_key), String(b.position_key)) || compareUtf8Bytewise(String(a.entity_id), String(b.entity_id)))
      .map(row => String(row.entity_id));
    for (const group of groups.filter(row => groupScope(projectId, row.parent_group_id) === scope)) {
      assert(order.includes(String(group.id)), `Drift group ${String(group.id)} has an order register in its parent scope`);
      assert.equal(Number(group.sort_order), order.indexOf(String(group.id)), `sort_order of ${String(group.id)} is its rank in ${scope}`);
    }
  }
  return groups.length;
}
/** Structural invariants: one nesting level, drifts point at existing groups, an act binds a live drift at most once. */
function verifyHierarchy(db: DatabaseSync, projectId: string) {
  const groups = db.prepare('SELECT * FROM drift_group WHERE project_id=?').all(projectId).map(row => ({
    id: String(row.id), projectId, name: String(row.name), parentGroupId: row.parent_group_id === null ? null : String(row.parent_group_id),
    color: row.color === null ? null : String(row.color), sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) } satisfies DriftGroup));
  for (const group of groups) {
    assert(groupDepth(groups, group.id) < MAX_DRIFT_GROUP_DEPTH, 'Drift groups nest at most one level');
    if (group.parentGroupId) assert(groups.some(item => item.id === group.parentGroupId), 'A group parent exists');
  }
  for (const node of db.prepare('SELECT kind,drift_group_id FROM book_node WHERE project_id=? AND drift_group_id IS NOT NULL').all(projectId)) {
    assert.equal(node.kind, 'drift', 'Only drifts are grouped');
    assert(groups.some(item => item.id === node.drift_group_id), 'A drift group membership names an existing group');
  }
  const bound = db.prepare(`SELECT a.drift_node_id AS id,n.kind,n.deleted_at FROM book_act a LEFT JOIN book_node n ON n.id=a.drift_node_id
    WHERE a.project_id=? AND a.drift_node_id IS NOT NULL`).all(projectId);
  for (const item of bound) assert.deepEqual([item.kind, item.deleted_at], ['drift', null], 'Acts bind live drifts only');
  assert.equal(new Set(bound.map(item => item.id)).size, bound.length, 'A drift is bound to at most one act');
}
/** The renderer library of one database, read back through the production repositories. */
async function rendererLibrary(client: DbExecutor, projectId: string): Promise<Library> {
  const nodes = createBookNodeSqliteRepository(projectId, client);
  const acts = await createBookActRepository(projectId, client).findAll();
  const drift = (node: BookNode): DriftResult => {
    const bound = acts.filter(act => act.driftNodeId === node.id);
    assert(bound.length <= 1);
    return { id: node.id, projectId: node.projectId, title: node.title, summary: node.summary, driftGroupId: node.driftGroupId ?? null,
      actId: bound[0]?.id ?? null, documentId: `node-content:${node.id}`, createdAt: node.createdAt, updatedAt: node.updatedAt };
  };
  const byCreation = (a: BookNode, b: BookNode) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : compareBookOrder(a, b));
  return {
    drifts: (await nodes.findAll()).filter(isDrift).sort(byCreation).map(drift),
    trashedDrifts: (await nodes.findTrashed()).filter(isDrift).sort(byCreation).map(({ deletedAt: _deletedAt, ...node }) => drift(node)),
    groups: (await createDriftGroupRepository(projectId, client).findAll()).sort(compareDriftGroups).map(({ color, ...group }) => {
      assert.equal(color, null, 'Drift groups carry no colour');
      return group;
    }),
  };
}
async function libraryOf(file: string, scratch: string, projectId: string): Promise<Library> {
  copyFileSync(file, scratch);
  const gateway = new ProductFileBackedSqliteGateway(scratch);
  try { return await rendererLibrary(gateway.client(), projectId); } finally { await gateway.close(); }
}
/** useDriftGroup nextSiblingSortOrder: one past the largest finite sibling order. */
function nextSiblingSortOrder(groups: readonly DriftGroup[], parentGroupId: string | null, excludedIds: ReadonlySet<string> = new Set()): number {
  const positions = groups
    .filter(group => !excludedIds.has(group.id) && group.parentGroupId === parentGroupId
      && typeof group.sortOrder === 'number' && Number.isFinite(group.sortOrder))
    .map(group => group.sortOrder as number);
  if (positions.length === 0) return 0;
  const maximum = Math.max(...positions);
  const next = maximum + 1;
  if (!Number.isFinite(next) || next === maximum) {
    throw new Error('Drift-group order space is exhausted; an explicit rebalance is required.');
  }
  return next;
}
/** useBookNode nextNodeUpdatedAt with Date.now() pinned to the authored clock. */
function nextNodeUpdatedAt(previous: string, now: string): string {
  const previousMs = Date.parse(previous);
  const floor = Number.isFinite(previousMs) ? previousMs + 1 : 0;
  return new Date(Math.max(Date.parse(now), floor)).toISOString();
}

interface Resolved { driftId: string | null; groupId: string | null; parentGroupId: string | null; actId: string | null }
function resolve(fixture: Case, prior: DatabaseSync, step: Step, commandInput: CommandInput): Resolved {
  const projectId = fixture.projectId;
  const created = step.result as { id: string } | null;
  return {
    driftId: step.operation === 'createDrift' ? created!.id
      : commandInput.drift === undefined ? null : driftNamed(prior, projectId, commandInput.drift, step.operation === 'restoreDrift'),
    groupId: step.operation === 'createGroup' ? created!.id
      : commandInput.group === undefined ? null : groupNamed(prior, projectId, commandInput.group),
    parentGroupId: commandInput.parent === undefined ? null : groupNamed(prior, projectId, commandInput.parent),
    actId: commandInput.act === undefined ? null : actNamed(prior, projectId, commandInput.act),
  };
}

/**
 * Mirror each renderer use case's authored effect (useDriftGroup, useBookNode
 * and useBookAct through withAtomicSyncTransaction) on a copy of the prior
 * native database. Store reads become the repository reads that hydrate them.
 */
async function rendererOriginals(fixture: Case, step: Step, commandInput: CommandInput, target: Resolved, prior: string, scratch: string) {
  copyFileSync(prior, scratch);
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
  let seedState: Uint8Array | null = null;
  let position: { x: number; y: number } | null = null;
  const unbinds = { markers: null as number | null, acts: null as number | null };
  try {
    switch (step.operation) {
      case 'createGroup': {
        // useDriftGroup.createGroup; the store's groups are loadDriftGroups.
        const native = step.result as GroupResult;
        const existingGroups = await createDriftGroupRepository(projectId, client).findAll();
        const parentGroupId = target.parentGroupId ?? null;
        const group: DriftGroup = { id: native.id, projectId, name: commandInput.name?.trim() || DEFAULT_DRIFT_GROUP_NAME,
          parentGroupId, color: null, sortOrder: nextSiblingSortOrder(existingGroups, parentGroupId), createdAt: now(), updatedAt: now() };
        await atomic(async (tx, sync, changes) => {
          await createDriftGroupRepository(projectId, tx).create(group);
          await sync('driftGroup', 'create', group.id, projectId, { id: group.id, name: group.name, parentGroupId: group.parentGroupId,
            color: group.color, createdAt: group.createdAt, updatedAt: group.updatedAt });
          await appendPlannedAuthoredOrderInTransaction(tx, changes, { projectId, listKind: 'drift-group',
            scope: driftGroupOrderScope(projectId, group.parentGroupId),
            desiredEntityIds: entityIdsByNumericPlacement([...existingGroups, group]
              .filter(entry => entry.parentGroupId === group.parentGroupId)
              .map(entry => ({ entityId: entry.id, projection: entry.sortOrder ?? 0 }))) });
        });
        break;
      }
      case 'createDrift': {
        // useBookNode.createNode({ kind: 'drift', title, bookOrder: null,
        // mainStorylineId: null, driftGroupId }) as the drift panel calls it.
        const native = step.result as DriftResult;
        const prevNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).sort(compareBookOrder);
        position = PINNED_POSITION;
        const newNode: BookNode = { id: native.id, title: makeUniqueNodeTitle(commandInput.title ?? DEFAULT_DRIFT_TITLE, prevNodes, projectId),
          projectId, narrativeOrder: null, driftGroupId: target.groupId ?? null, summary: '', position, wordCount: 0,
          createdAt: now(), updatedAt: now(), kind: 'drift', bookOrder: null, writingStatus: 'drifting' };
        // No initial content and no primary storyline template: an empty doc.
        const defaultDocJson = DEFAULT_TIPTAP_DOC_JSON;
        const [proseMetric, proseSeedState] = await Promise.all([deriveProseMetricFromJson(defaultDocJson),
          // createEntitySeedUpdate delegates to createYjsProseSeedState.
          createYjsProseSeedState(defaultDocJson)]);
        seedState = proseSeedState;
        newNode.wordCount = proseMetric.wordCount;
        newNode.wordCountBasisKind = 'yjs';
        newNode.wordCountBasisHash = proseMetric.basisHash;
        newNode.wordCountBasisRevision = 1;
        newNode.wordCountBasisServerSeq = null;
        const nodeSyncPayload = { id: newNode.id, title: newNode.title, summary: newNode.summary, bookOrder: newNode.bookOrder,
          narrativeOrder: newNode.narrativeOrder, kind: newNode.kind, driftGroupId: newNode.driftGroupId,
          positionX: newNode.position.x, positionY: newNode.position.y, writingStatus: newNode.writingStatus,
          wordCount: newNode.wordCount, wordCountBasisKind: newNode.wordCountBasisKind, wordCountBasisHash: newNode.wordCountBasisHash,
          wordCountBasisRevision: newNode.wordCountBasisRevision, wordCountBasisServerSeq: null };
        await atomic(async (tx, sync, changes) => {
          const created = await createBookNodeSqliteRepository(projectId, tx).create(newNode);
          await createBookContentRepository(tx).create({ nodeId: created.id, contentJson: defaultDocJson });
          await sync('node', 'create', created.id, projectId, nodeSyncPayload);
          await appendAuthoredProseSeedInTransaction(tx, changes, { entityType: 'node', entityId: created.id, stateUpdate: proseSeedState });
        });
        break;
      }
      case 'renameDrift': {
        // useBookNode.renameNode(id, title): a project-unique title, stamped
        // by nextNodeUpdatedAt, journaled as the title alone.
        const prevNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).sort(compareBookOrder);
        const existing = prevNodes.find(node => node.id === target.driftId);
        assert(existing && isDrift(existing));
        const uniqueTitle = makeUniqueNodeTitle(commandInput.title!, prevNodes, projectId, existing.id);
        const updatedAt = nextNodeUpdatedAt(existing.updatedAt, now());
        await persistBookNodeUpdateWithSync({ projectId, nodeId: existing.id, updates: { title: uniqueTitle, updatedAt },
          syncPayload: { title: uniqueTitle } }, (runProjectId, work) => {
          assert.equal(runProjectId, projectId);
          return atomic(work);
        });
        break;
      }
      case 'updateDrift': {
        // useBookNode.updateNode(id, { title, driftGroupId }) — the one renderer
        // path that authors a rename and a regroup in one original; the title
        // is kept as given.
        const prevNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).sort(compareBookOrder);
        const existing = prevNodes.find(node => node.id === target.driftId);
        assert(existing && isDrift(existing));
        const updatedAt = nextNodeUpdatedAt(existing.updatedAt, now());
        const nodeUpdates = { title: commandInput.title!, driftGroupId: target.groupId };
        await persistBookNodeUpdateWithSync({ projectId, nodeId: existing.id, updates: { ...nodeUpdates, updatedAt },
          syncPayload: { ...nodeUpdates } }, (runProjectId, work) => {
          assert.equal(runProjectId, projectId);
          return atomic(work);
        });
        break;
      }
      case 'moveDrift': {
        // useDriftGroup.moveDriftToGroup(driftId, groupId): the store node,
        // skipped when unchanged, stamped with the wall clock.
        const node = (await createBookNodeSqliteRepository(projectId, client).findAll()).find(item => item.id === target.driftId);
        assert(node && node.kind === 'drift');
        const groupId = target.groupId;
        assert.notEqual(node.driftGroupId ?? null, groupId, 'The exported move changes the group');
        const updatedAt = now();
        await atomic(async (tx, sync) => {
          await createBookNodeSqliteRepository(projectId, tx).update(node.id, { driftGroupId: groupId, updatedAt });
          await sync('node', 'update', node.id, projectId, { driftGroupId: groupId, updatedAt });
        });
        break;
      }
      case 'deleteGroup': {
        // useDriftGroup.deleteGroup; the store's groups and nodes are the
        // loadDriftGroups/loadNodes repository reads.
        const driftGroups = await createDriftGroupRepository(projectId, client).findAll();
        const bookNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).sort(compareBookOrder);
        const id = target.groupId!;
        const found = driftGroups.find(group => group.id === id);
        assert(found);
        const newParent = found.parentGroupId;
        const childGroups = driftGroups.filter(group => group.parentGroupId === id).sort(compareDriftGroups);
        const memberDrifts = bookNodes.filter(node => node.driftGroupId === id);
        const excluded = new Set([id, ...childGroups.map(group => group.id)]);
        const firstChildOrder = nextSiblingSortOrder(driftGroups, newParent, excluded);
        const stamp = now();
        await atomic(async (tx, sync, changes) => {
          const groupRepoTx = createDriftGroupRepository(projectId, tx);
          const nodeRepoTx = createBookNodeSqliteRepository(projectId, tx);
          for (const [index, child] of childGroups.entries()) {
            await groupRepoTx.update(child.id, { parentGroupId: newParent, sortOrder: firstChildOrder + index, updatedAt: stamp });
            await sync('driftGroup', 'update', child.id, projectId, { parentGroupId: newParent, updatedAt: stamp });
          }
          const desiredSiblings = driftGroups
            .filter(group => group.id !== id)
            .map(group => {
              const movedIndex = childGroups.findIndex(child => child.id === group.id);
              return movedIndex < 0 ? group : { ...group, parentGroupId: newParent, sortOrder: firstChildOrder + movedIndex };
            })
            .filter(group => group.parentGroupId === newParent)
            .sort(compareDriftGroups)
            .map(({ id: entityId }) => entityId);
          if (desiredSiblings.length > 0) {
            appendAuthoredOrderRebalance(changes, { listKind: 'drift-group', scope: driftGroupOrderScope(projectId, newParent),
              entries: authoredOrderRebalanceEntries(desiredSiblings) });
          }
          for (const node of memberDrifts) {
            await nodeRepoTx.update(node.id, { driftGroupId: newParent, updatedAt: stamp });
            await sync('node', 'update', node.id, projectId, { driftGroupId: newParent, updatedAt: stamp });
          }
          await groupRepoTx.delete(id);
          await sync('driftGroup', 'delete', id, projectId);
        });
        break;
      }
      case 'bindAct': {
        // useBookAct.bindDrift -> updateAct(id, { driftNodeId }).
        const updatedAt = now();
        const normalizedInput = { driftNodeId: target.driftId };
        await atomic(async (tx, sync) => {
          const result = await createBookActRepository(projectId, tx).update(target.actId!, { ...normalizedInput, updatedAt });
          assert(result);
          await sync('bookAct', 'update', target.actId!, projectId, { ...normalizedInput, updatedAt });
        });
        break;
      }
      case 'trashDrift': {
        // useBookNode.deleteNode for a drift with the trash feature: marker and
        // act unbinds run first as their own transactions (each is caught; an
        // empty one records no mutation and rolls back), then the trash.
        const prevNodes = (await createBookNodeSqliteRepository(projectId, client).findAll()).sort(compareBookOrder);
        const existing = prevNodes.find(node => node.id === target.driftId);
        assert(existing && isDrift(existing));
        const id = existing.id;
        const markerNow = now();
        unbinds.markers = await atomic(async (tx, sync) => {
          const rows = await createTimelineMarkerRepository(projectId, tx).unbindForDrift(id, existing.title.trim() || 'Marker', markerNow);
          for (const marker of rows) {
            await sync('timelineMarker', 'update', marker.id, projectId, { driftNodeId: null, label: marker.label, updatedAt: markerNow });
          }
          return rows.length;
        }).catch((error: unknown) => {
          assert(error instanceof Error && error.message === 'authored transaction must record at least one sync mutation', String(error));
          return 0;
        });
        const actNow = now();
        unbinds.acts = await atomic(async (tx, sync) => {
          const rows = await createBookActRepository(projectId, tx).unbindForDrift(id, actNow);
          for (const act of rows) await sync('bookAct', 'update', act.id, projectId, { driftNodeId: null, updatedAt: actNow });
          return rows.length;
        }).catch((error: unknown) => {
          assert(error instanceof Error && error.message === 'authored transaction must record at least one sync mutation', String(error));
          return 0;
        });
        await atomic(async (tx, sync) => {
          await deleteEntityRelationsInTransaction(tx, sync, projectId, 'node', id);
          await createBookNodeSqliteRepository(projectId, tx).softDelete(id);
          await sync('node', 'softDelete', id, projectId);
        });
        break;
      }
      case 'restoreDrift':
        // useBookNode.restoreNode -> sync-lifecycle-restore.
        await atomic(async (tx, sync) => {
          await createBookNodeSqliteRepository(projectId, tx).restore(target.driftId!);
          await sync('node', 'restore', target.driftId!, projectId);
        });
        break;
    }
    assert.equal(committed, step.originals.length, 'The renderer commits one original per native original');
    const changeSets: SyncChangeSetV1[] = [];
    for (const row of gateway.database.prepare("SELECT encoded_bytes FROM sync_change_set WHERE origin='local' AND rowid>? ORDER BY rowid").all(startRowid)) {
      assert(row.encoded_bytes instanceof Uint8Array);
      const decoded = await decodeSyncChangeSetV1(row.encoded_bytes);
      assert(decoded.ok, 'Renderer original must decode');
      changeSets.push(decoded.value);
    }
    return { changeSets, seedState, position, unbinds, authority: snapshot(gateway.database, rendererAuthorityTables),
      rows: Object.fromEntries(rendererDomainTables.map(table => [table, raw(gateway.database, table)])) as Record<typeof rendererDomainTables[number], Row[]> };
  } finally {
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}

/**
 * Carry native owner changes between the prior and after databases for
 * documents no mutation of this step targets. The only such change is a
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

/**
 * Every mutation target, incarnation and payload against the native
 * after-state, rebuilt independently of both authors.
 */
function verifyMutations(prior: DatabaseSync, after: DatabaseSync, generation: string, fixture: Case, step: Step,
  changeSets: SyncChangeSetV1[], target: Resolved) {
  const projectId = fixture.projectId;
  const nodeRow = (id: string) => after.prepare('SELECT * FROM book_node WHERE id=?').get(id)!;
  const nodeSeed = (row: Row) => ({ bookOrder: row.book_order, driftGroupId: row.drift_group_id, kind: row.kind,
    narrativeOrder: row.narrative_order, summary: row.summary, title: row.title, writingStatus: row.writing_status });
  // Drifts whose group a deleteGroup lifts to the parent (prior members of that group).
  // Live member drifts a deleteGroup lifts, in the store's compareBookOrder (UTF-8 id) order.
  const members = step.operation === 'deleteGroup'
    ? prior.prepare('SELECT id FROM book_node WHERE project_id=? AND drift_group_id=? AND deleted_at IS NULL').all(projectId, target.groupId!)
      .map(row => String(row.id)).sort(compareUtf8Bytewise) : [];
  const children = step.operation === 'deleteGroup'
    ? prior.prepare('SELECT id FROM drift_group WHERE project_id=? AND parent_group_id=?').all(projectId, target.groupId!).map(row => String(row.id)) : [];
  const priorActs = step.operation === 'trashDrift'
    ? prior.prepare('SELECT id FROM book_act WHERE project_id=? AND drift_node_id=? ORDER BY rowid').all(projectId, target.driftId!).map(row => String(row.id)) : [];
  if (step.operation === 'deleteGroup') {
    // Child groups, the scope rebalance, then every live member drift in order, then the purge.
    assert.deepEqual(changeSets.flatMap(changeSet => changeSet.mutations).filter(mutation => mutation.target.kind === 'node')
      .map(mutation => mutation.target.id), members, 'deleteGroup lifts every live member drift in UTF-8 id order');
  }
  if (step.operation === 'trashDrift') {
    // One act-unbind original (acts in row order) precedes the trash when any act is bound.
    assert.equal(changeSets.length, priorActs.length > 0 ? 2 : 1);
    if (priorActs.length > 0) assert.deepEqual(changeSets[0]!.mutations.map(mutation => mutation.target.id), priorActs);
  }
  for (const changeSet of changeSets) {
    for (const mutation of changeSet.mutations) {
      const { family, kind, id, incarnation } = mutation.target;
      const payload = mutation.payload as Record<string, unknown>;
      if (kind === 'drift-group') {
        assert.equal(incarnation, incarnationOf(after, generation, 'drift-group', id));
        const row = after.prepare('SELECT * FROM drift_group WHERE id=?').get(id);
        if (family === 'order') {
          assert(row, 'Only existing groups are ordered');
          assert.equal(payload.scope, groupScope(projectId, row.parent_group_id), 'Groups are ordered within their parent');
          if (mutation.action === 'order.move') assert.deepEqual(Object.keys(payload).sort(), ['positionKey', 'scope']);
          else {
            assert.equal(mutation.action, 'order.rebalance');
            assert.deepEqual(Object.keys(payload).sort(), ['entries', 'scope']);
            const entries = payload.entries as Record<string, unknown>[];
            assert.equal(entries.length, 1);
            assert.equal(entries[0]!.entityId, id);
          }
          continue;
        }
        assert.equal(family, 'entity');
        if (mutation.action === 'entity.create') {
          assert.equal(id, target.groupId);
          assert.equal(incarnation, 0);
          assert(row);
          assert.deepEqual(payload, { seed: { color: row.color, name: row.name, parentGroupId: row.parent_group_id } });
        } else if (mutation.action === 'entity.purge') {
          assert.equal(id, target.groupId);
          assert.equal(row, undefined, 'A purged group row is removed');
          assert(prior.prepare('SELECT 1 FROM drift_group WHERE id=?').get(id));
          assert.deepEqual(payload, {});
        } else {
          assert.equal(mutation.action, 'field.set');
          assert(row);
          assert(children.includes(id), 'Only lifted child groups change parent');
          assert.deepEqual(payload, { field: 'parentGroupId', value: row.parent_group_id });
        }
        continue;
      }
      if (kind === 'book-act') {
        assert.deepEqual([family, mutation.action], ['entity', 'field.set']);
        assert.equal(incarnation, incarnationOf(after, generation, 'book-act', id));
        const row = after.prepare('SELECT drift_node_id FROM book_act WHERE id=?').get(id)!;
        assert.deepEqual(payload, { field: 'driftNodeId', value: row.drift_node_id });
        if (step.operation === 'bindAct') assert.deepEqual([id, row.drift_node_id], [target.actId, target.driftId]);
        else assert(priorActs.includes(id) && row.drift_node_id === null);
        continue;
      }
      if (family === 'yjs') {
        assert.deepEqual(mutation.target, { family: 'yjs', kind: 'prose-document', id: `node-content:${target.driftId}`,
          incarnation: incarnationOf(after, generation, 'node', target.driftId!) });
        continue;
      }
      assert.equal(kind, 'node', `Unexpected target ${family}/${kind}`);
      assert(id === target.driftId || members.includes(id));
      assert.equal(incarnation, incarnationOf(after, generation, 'node', id));
      const row = nodeRow(id);
      assert.equal(row.kind, 'drift');
      if (mutation.action === 'entity.create') {
        assert.equal(incarnation, 0);
        assert.deepEqual(payload, { seed: nodeSeed(row) });
        assert.deepEqual(nodeSeed(row), { bookOrder: null, driftGroupId: target.groupId, kind: 'drift', narrativeOrder: null,
          summary: '', title: row.title, writingStatus: 'drifting' });
      } else if (mutation.action === 'entity.trash') {
        assert.deepEqual(payload, {});
      } else if (mutation.action === 'entity.restore') {
        assert.equal(incarnation, incarnationOf(prior, generation, 'node', id) + 1);
        assert.deepEqual(payload, { seed: nodeSeed(row) });
      } else if (mutation.action === 'tuple.set') {
        assert.deepEqual(payload, { tuple: 'graph.position', value: { x: row.position_x, y: row.position_y } });
      } else {
        assert.equal(mutation.action, 'field.set');
        const column = { title: 'title', driftGroupId: 'drift_group_id' }[String(payload.field)];
        assert(column, `Unexpected drift field ${String(payload.field)}`);
        assert.equal(payload.value, row[column]);
      }
    }
  }
}
const compareGroups = (a: GroupResult, b: GroupResult) => compareDriftGroups({ ...a, color: null }, { ...b, color: null });
/** Each command changes exactly its commanded rows, the authored timestamp and the rank projection, from the prior library. */
async function verifyCommand(prior: DatabaseSync, priorLibrary: Library, fixture: Case, step: Step, commandInput: CommandInput, target: Resolved) {
  const projectId = fixture.projectId;
  const at = step.originals[0]!.createdAt;
  assert(step.originals.every(original => original.createdAt === at), 'One command authors every original at one time');
  const library = step.library!;
  const live = prior.prepare('SELECT * FROM book_node WHERE project_id=? AND deleted_at IS NULL').all(projectId);
  const liveNodes = live.map(row => ({ id: String(row.id), projectId, title: String(row.title) }) as BookNode);
  switch (step.operation) {
    case 'createGroup': {
      const result = step.result as GroupResult;
      assert.equal(prior.prepare('SELECT 1 FROM drift_group WHERE id=?').get(result.id), undefined);
      const siblings = priorLibrary.groups.filter(group => group.parentGroupId === target.parentGroupId);
      assert.deepEqual(result, { id: result.id, projectId, name: commandInput.name!.trim() || DEFAULT_DRIFT_GROUP_NAME,
        parentGroupId: target.parentGroupId, sortOrder: siblings.length, createdAt: at, updatedAt: at });
      assert.deepEqual(library, { ...priorLibrary, groups: [...priorLibrary.groups, result].sort(compareGroups) });
      return;
    }
    case 'createDrift': {
      const result = step.result as DriftResult;
      assert.deepEqual(Object.keys(result).sort(), driftKeys);
      assert.equal(prior.prepare('SELECT 1 FROM book_node WHERE id=?').get(result.id), undefined);
      // Drift titles share the chapter title namespace.
      assert.deepEqual(result, { id: result.id, projectId, title: makeUniqueNodeTitle(commandInput.title ?? DEFAULT_DRIFT_TITLE, liveNodes, projectId),
        summary: '', driftGroupId: target.groupId, actId: null, documentId: `node-content:${result.id}`, createdAt: at, updatedAt: at });
      assert.deepEqual(library, { ...priorLibrary, drifts: [...priorLibrary.drifts, result] });
      return;
    }
    case 'renameDrift':
    case 'updateDrift':
    case 'moveDrift': {
      const result = step.result as DriftResult;
      const before = priorLibrary.drifts.find(item => item.id === target.driftId);
      assert(before);
      // renameNode suffixes a colliding title; updateNode keeps it as given;
      // title edits floor updated_at at the previous stamp + 1 ms.
      const changed = step.operation === 'renameDrift'
        ? { ...before, title: makeUniqueNodeTitle(commandInput.title!, liveNodes, projectId, before.id), updatedAt: nextNodeUpdatedAt(before.updatedAt, at) }
        : step.operation === 'updateDrift'
          ? { ...before, title: commandInput.title!, driftGroupId: target.groupId, updatedAt: nextNodeUpdatedAt(before.updatedAt, at) }
          : { ...before, driftGroupId: target.groupId, updatedAt: at };
      if (step.operation === 'renameDrift') {
        assert.notEqual(changed.title, commandInput.title, 'The exported rename collides and is suffixed');
        assert(liveNodes.some(node => node.title === commandInput.title && node.id !== before.id));
      }
      if (step.operation !== 'moveDrift') assert.notEqual(changed.title, before.title);
      if (step.operation !== 'renameDrift') assert.notEqual(changed.driftGroupId, before.driftGroupId);
      assert.deepEqual(result, changed);
      assert.deepEqual(library, { ...priorLibrary, drifts: priorLibrary.drifts.map(item => item.id === result.id ? result : item) });
      return;
    }
    case 'deleteGroup': {
      assert.equal(step.result, null);
      const deleted = priorLibrary.groups.find(group => group.id === target.groupId);
      assert(deleted);
      const parent = deleted.parentGroupId;
      const children = priorLibrary.groups.filter(group => group.parentGroupId === deleted.id);
      assert(children.length > 0, 'The exported delete lifts a child group');
      assert(priorLibrary.drifts.filter(item => item.driftGroupId === deleted.id).length >= 2, 'The exported delete lifts several member drifts');
      // Existing siblings keep their places; lifted children follow them in their order.
      const scope = [...priorLibrary.groups.filter(group => group.parentGroupId === parent && group.id !== deleted.id), ...children];
      const groups = priorLibrary.groups.filter(group => group.id !== deleted.id).map(group => {
        const rank = scope.findIndex(item => item.id === group.id);
        if (rank < 0) return group;
        const child = children.includes(group);
        return { ...group, parentGroupId: child ? parent : group.parentGroupId, sortOrder: rank, ...child ? { updatedAt: at } : {} };
      }).sort(compareGroups);
      const drifts = priorLibrary.drifts.map(item => item.driftGroupId === deleted.id ? { ...item, driftGroupId: parent, updatedAt: at } : item);
      assert.deepEqual(library, { ...priorLibrary, groups, drifts });
      return;
    }
    case 'bindAct': {
      const result = step.result as ActResult;
      const act = prior.prepare('SELECT * FROM book_act WHERE id=?').get(target.actId!)!;
      assert.equal(act.drift_node_id, null, 'The exported act was unbound');
      assert.deepEqual(result, { id: act.id, projectId, name: act.name, color: act.color, startOrder: act.start_order,
        driftNodeId: target.driftId, createdAt: act.created_at, updatedAt: at });
      assert.deepEqual(library, { ...priorLibrary, drifts: priorLibrary.drifts.map(item => item.id === target.driftId ? { ...item, actId: result.id } : item) });
      return;
    }
    case 'trashDrift': {
      const result = step.result as DriftResult;
      const before = priorLibrary.drifts.find(item => item.id === target.driftId);
      assert(before);
      assert.notEqual(before.actId, null, 'The exported trash unbinds an act');
      assert.deepEqual(result, { ...before, actId: null, updatedAt: at });
      assert.deepEqual(library, { ...priorLibrary, drifts: priorLibrary.drifts.filter(item => item.id !== result.id),
        trashedDrifts: [...priorLibrary.trashedDrifts, result] });
      return;
    }
    case 'restoreDrift': {
      const result = step.result as DriftResult;
      const before = priorLibrary.trashedDrifts.find(item => item.id === target.driftId);
      assert(before);
      assert.deepEqual(result, { ...before, updatedAt: at });
      assert.deepEqual(library, { ...priorLibrary, drifts: [...priorLibrary.drifts, result],
        trashedDrifts: priorLibrary.trashedDrifts.filter(item => item.id !== result.id) });
      return;
    }
  }
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
  const temporary = mkdtempSync(path.join(path.dirname(output), `drift-receiver-${ordinal}-`));
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
  verifyHierarchy(initial, fixture.projectId);
  verifyRankProjection(initial, generation, fixture.projectId);
  // Local-only domain cells: `${table}\0${key}\0${column}` -> exact native/receiver values.
  const divergent = new Map<string, { native: unknown; receiver: unknown }>();
  const cell = (table: string, key: string, column: string) => `${table}\0${key}\0${column}`;
  const steps = [];
  try {
    for (const [index, step] of fixture.steps.entries()) {
      const commandInput = expectedCase.inputs[index]!;
      assert.equal(step.originals.length, expectedCase.actions[index]!.length);
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
        assert.deepEqual(changeSet.mutations.map(mutation => mutation.action), expectedCase.actions[index]![position]);
        if (position > 0) assert.equal(changeSet.deviceSeq, originals[position - 1]!.changeSet.deviceSeq + 1, 'A command journals consecutive originals');
        originals.push({ bytes, changeSet });
      }
      const changeSets = originals.map(item => item.changeSet);
      const priorName = index === 0 ? fixture.beforeDatabase : fixture.steps[index - 1]!.afterDatabase;
      const prior = new DatabaseSync(database(priorName), { readOnly: true });
      const expectedAfter = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      try {
        // 1. Targets, incarnations, payloads and the command's library delta.
        const target = resolve(fixture, prior, step, commandInput);
        const incarnation = step.operation === 'bindAct' ? incarnationOf(expectedAfter, generation, 'book-act', target.actId!)
          : ['createGroup', 'deleteGroup'].includes(step.operation) ? incarnationOf(expectedAfter, generation, 'drift-group', target.groupId!)
            : incarnationOf(expectedAfter, generation, 'node', target.driftId!);
        verifyMutations(prior, expectedAfter, generation, fixture, step, changeSets, target);
        const priorLibrary = await libraryOf(database(priorName), path.join(temporary, `prior-library-${index}.db`), fixture.projectId);
        await verifyCommand(prior, priorLibrary, fixture, step, commandInput, target);
        verifyHierarchy(expectedAfter, fixture.projectId);
        const orderActions = changeSets.flatMap(changeSet => changeSet.mutations).filter(mutation => mutation.target.family === 'order')
          .map(mutation => mutation.action);
        const orderPlan = orderActions.includes('order.rebalance') ? 'rebalance' : orderActions.length > 0 ? 'moves' : null;

        // 2. The renderer use case, run on the same prior state, authors the same originals.
        const renderer = await rendererOriginals(fixture, step, commandInput, target, database(priorName), path.join(temporary, `renderer-${index}.db`));
        assert.equal(renderer.changeSets.length, changeSets.length);
        const seedIndex = step.operation === 'createDrift' ? changeSets[0]!.mutations.findIndex(mutation => mutation.action === 'yjs.update') : -1;
        const substitute = (rendered: SyncChangeSetV1, native: SyncChangeSetV1, seeded: boolean): SyncChangeSetV1 => ({
          ...rendered, mutations: rendered.mutations.map((mutation, i) => {
            if (!seeded || i !== seedIndex) return mutation;
            const nativeMutation = native.mutations[i]!;
            assert.deepEqual({ ...mutation, payload: null, payloadSha256: null }, { ...nativeMutation, payload: null, payloadSha256: null });
            return nativeMutation;
          }) });
        for (const [position, { bytes, changeSet }] of originals.entries()) {
          assert.deepEqual(encodeSyncChangeSetV1(substitute(renderer.changeSets[position]!, changeSet, position === 0)), bytes,
            `Renderer use case authors the identical original ${position}`);
        }
        let seed: { native: Block[]; renderer: Block[] } | null = null;
        if (seedIndex >= 0) {
          const nativeSeed = parseYjsUpdatePayload(changeSets[0]!.mutations[seedIndex]!.payload).update;
          const rendererSeed = parseYjsUpdatePayload(renderer.changeSets[0]!.mutations[seedIndex]!.payload).update;
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
        const seedChangeSetId = seedIndex >= 0 ? changeSets[0]!.changeSetId : null;
        // Only the seed yjs.update payload (and so the envelope) differs.
        const projectAuthority = (table: string, rows: Row[]) => canonicalRows(rows.map(item => {
          if (item.change_set_id !== seedChangeSetId) return item;
          if (table === 'sync_change_set') return { ...item, encoded_bytes: 'seed-differs', payload_sha256: 'seed-differs' };
          if (table === 'sync_mutation' && Number(item.mutation_index) === seedIndex) {
            return { ...item, payload_cbor: 'seed-differs', payload_sha256: 'seed-differs' };
          }
          return item;
        }));
        for (const table of rendererAuthorityTables) {
          equalRows(`renderer ${table}`, projectAuthority(table, renderer.authority[table]!), projectAuthority(table, nativeAuthority[table]!));
        }
        // The renderer's own node, body cache, act, group and marker rows.
        const rendererRow = (table: typeof rendererDomainTables[number], key: string, nativeProjection: Row): { renderer: Row; native: Row } => {
          const rendered: Row = { ...renderer.rows[table].find(row => rowKey(table, row) === key)! };
          const nativeRow: Row = { ...nativeProjection };
          const commanded = key === target.driftId;
          if (commanded && step.operation === 'createDrift' && table === 'book_node') {
            // Local-only graph position; seed-derived word-count basis.
            assert.deepEqual([rendered.position_x, rendered.position_y, nativeRow.position_x, nativeRow.position_y],
              [PINNED_POSITION.x, PINNED_POSITION.y, 0, 0]);
            rendered.position_x = rendered.position_y = nativeRow.position_x = nativeRow.position_y = 'compared-local-position';
            rendered.word_count_basis_hash = nativeRow.word_count_basis_hash = 'compared-seed-metric';
          }
          if (commanded && step.operation === 'createDrift' && table === 'node_content') {
            assert.equal(rendered.content_json, DEFAULT_TIPTAP_DOC_JSON);
            assert.deepEqual(JSON.parse(String(nativeRow.content_json)), structure(parseYjsUpdatePayload(changeSets[0]!.mutations[seedIndex]!.payload).update).json);
            rendered.content_json = nativeRow.content_json = 'compared-seed-cache';
          }
          const clockColumns = !commanded ? [] : table === 'node_content' && step.operation === 'createDrift' ? ['created_at', 'updated_at']
            : table !== 'book_node' ? [] : step.operation === 'trashDrift' ? ['deleted_at', 'updated_at']
              : step.operation === 'restoreDrift' ? ['updated_at'] : [];
          for (const column of clockColumns) {
            assert.equal(nativeRow[column], step.originals[0]!.createdAt);
            assert(Date.parse(String(rendered[column])) >= Date.parse(step.originals[0]!.createdAt));
            rendered[column] = nativeRow[column] = 'compared-authored/wall-clock';
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
        if (step.operation === 'createDrift') {
          // Each side's word-count basis is the prose metric of its own seed cache.
          const nativeNode = expectedAfter.prepare('SELECT * FROM book_node WHERE id=?').get(target.driftId!)!;
          const nativeCache = String(expectedAfter.prepare('SELECT content_json FROM node_content WHERE node_id=?').get(target.driftId!)!.content_json);
          const rendererNode = renderer.rows.book_node.find(row => row.id === target.driftId)!;
          assert.deepEqual([nativeNode.word_count, nativeNode.word_count_basis_hash],
            Object.values(await deriveProseMetricFromJson(nativeCache)).map(value => value));
          assert.deepEqual([rendererNode.word_count, rendererNode.word_count_basis_hash],
            Object.values(await deriveProseMetricFromJson(DEFAULT_TIPTAP_DOC_JSON)).map(value => value));
        }
        if (step.operation === 'trashDrift') {
          assert.deepEqual(renderer.unbinds, { markers: 0, acts: changeSets.length - 1 }, 'Renderer unbinds the same acts and no markers');
        }

        // 3. Replay every original of the step, in order, on the independent receiver.
        const known = new Set(raw(gateway.database, 'sync_change_set').map(item => String(item.change_set_id)));
        assert.deepEqual(raw(expectedAfter, 'sync_change_set').map(item => String(item.change_set_id)).filter(id => !known.has(id)),
          changeSets.map(changeSet => changeSet.changeSetId), 'Each step journals exactly its native originals');
        const targets = new Set(changeSets.flatMap(changeSet => changeSet.mutations).filter(mutation => mutation.action === 'yjs.update')
          .map(mutation => mutation.target.id));
        const carried = carryCheckpoints(gateway.database, prior, expectedAfter, targets);
        const contextOf = (changeSet: SyncChangeSetV1, createdAt: string) => ({
          changeSet,
          clock: { nowMs: Date.parse(createdAt), nowIso: createdAt },
          identity: { installationId: fixture.identity.installationId,
            createWriterIdentity: () => ({ writerId: fixture.identity.writerId, writerEpoch: fixture.identity.writerEpoch }) },
          kernel: productionSyncDomainMaterializationKernel,
        });
        const owner = snapshot(gateway.database, ownerTables);
        let faults = 0;
        for (const [position, { changeSet }] of originals.entries()) {
          const context = contextOf(changeSet, step.originals[position]!.createdAt);
          if (step.faultBeforeApply) {
            const unchanged = snapshot(gateway.database);
            gateway.database.exec("CREATE TRIGGER fail_drift_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic drift receipt fault'); END");
            await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
            assert.deepEqual(snapshot(gateway.database), unchanged);
            gateway.database.exec('DROP TRIGGER fail_drift_receipt');
            faults += 1;
          }
          const applied = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
          assert.equal(applied.status, 'applied');
          assert.deepEqual(applied.conflicts, []);
          originalIds.add(changeSet.changeSetId);
          originalTimes.set(changeSet.changeSetId, step.originals[position]!.createdAt);
        }
        if (targets.size === 0) assert.deepEqual(snapshot(gateway.database, ownerTables), owner, 'Scalar originals leave prose owners untouched');
        // Native and the receiver project every group's rank from the order authority.
        const groups = verifyRankProjection(expectedAfter, generation, fixture.projectId);
        verifyRankProjection(gateway.database, generation, fixture.projectId);
        verifyHierarchy(gateway.database, fixture.projectId);
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
        // Prose metrics are local projections the remote materializer never
        // writes: the authoring side keeps its seed basis, a receiver none.
        if (step.operation === 'createDrift') {
          const basis = ['word_count_basis_kind', 'word_count_basis_hash', 'word_count_basis_revision'];
          const select = (db: DatabaseSync) => db.prepare(`SELECT ${basis.join(',')} FROM book_node WHERE id=?`).get(target.driftId!)!;
          const [nativeBasis, receivedBasis] = [select(expectedAfter), select(gateway.database)];
          const nativeCache = String(expectedAfter.prepare('SELECT content_json FROM node_content WHERE node_id=?').get(target.driftId!)!.content_json);
          assert.deepEqual(Object.values(nativeBasis), ['yjs', (await deriveProseMetricFromJson(nativeCache)).basisHash, 1]);
          assert.deepEqual(Object.values(receivedBasis), [null, null, null]);
          for (const column of basis) divergent.set(cell('book_node', target.driftId!, column), { native: nativeBasis[column], receiver: receivedBasis[column] });
        }
        const lastHlc = changeSets[changeSets.length - 1]!.hlc.wallMs;
        // A title edit floors updated_at at the previous stamp + 1 ms on the
        // authoring side (native and renderer alike).
        const stampOf = (db: DatabaseSync, id: string) => String(db.prepare('SELECT updated_at FROM book_node WHERE id=?').get(id)!.updated_at);
        let flooredStamp = false;
        if (step.operation === 'renameDrift' || step.operation === 'updateDrift') {
          const stamp = nextNodeUpdatedAt(stampOf(prior, target.driftId!), step.originals[0]!.createdAt);
          assert.equal(stampOf(expectedAfter, target.driftId!), stamp, 'Native floors a title edit at the previous stamp + 1 ms');
          flooredStamp = stamp !== step.originals[0]!.createdAt;
        }
        // A receiver re-materializes every field register in effect-id (UTF-8)
        // order, so a node's updated_at ends at the time of its UTF-8-last
        // field register rather than its newest authored write. Pinned per row.
        let receiverNodeStamps = 0;
        for (const nativeRow of raw(expectedAfter, 'book_node')) {
          const id = String(nativeRow.id);
          const key = cell('book_node', id, 'updated_at');
          const received = stampOf(gateway.database, id);
          if (nativeRow.updated_at === received) {
            divergent.delete(key);
            continue;
          }
          const clocks = gateway.database.prepare(`SELECT field_key,hlc_wall_ms FROM sync_field_clock WHERE sync_generation_id=?
            AND target_kind='node' AND target_id=? AND incarnation=?`).all(generation, id, incarnationOf(gateway.database, generation, 'node', id))
            .sort((a, b) => compareUtf8Bytewise(String(a.field_key), String(b.field_key)));
          assert(clocks.length > 0, `Only a field register can hold back ${id}`);
          assert.equal(received, new Date(Number(clocks[clocks.length - 1]!.hlc_wall_ms)).toISOString(),
            'A receiver ends at the time of the UTF-8-last field register');
          assert(String(nativeRow.updated_at) > received, 'Native keeps the newest authored stamp');
          divergent.set(key, { native: nativeRow.updated_at, receiver: received });
          receiverNodeStamps += 1;
        }
        const projected: string[] = [];
        for (const nativeItem of raw(expectedAfter, 'node_content')) {
          const id = String(nativeItem.node_id);
          const body = `node-content:${id}`;
          const received = gateway.database.prepare('SELECT * FROM node_content WHERE node_id=?').get(id);
          assert(received, `node_content ${id} is materialized`);
          const nativeCache = JSON.parse(String(nativeItem.content_json)) as unknown;
          const receivedCache = JSON.parse(String(received.content_json)) as unknown;
          const priorCache = prior.prepare('SELECT content_json,updated_at FROM node_content WHERE node_id=?').get(id);
          if (priorCache) assert.deepEqual(nativeCache, JSON.parse(String(priorCache.content_json)), 'Native commands keep an existing body cache');
          if (targets.has(body)) assert.deepEqual(receivedCache, structure(fullState(gateway.database, body)).json, 'Reducer cache projects authoritative Yjs');
          if (isDeepStrictEqual(nativeCache, receivedCache) && nativeItem.updated_at === received.updated_at) {
            if (targets.has(body)) {
              divergent.delete(cell('node_content', id, 'content_json'));
              divergent.delete(cell('node_content', id, 'updated_at'));
            }
            continue;
          }
          if (targets.has(body)) {
            assert(priorCache, 'Only a restore re-projects an existing cache');
            divergent.set(cell('node_content', id, 'content_json'), { native: nativeItem.content_json, receiver: received.content_json });
            assert.equal(nativeItem.updated_at, priorCache.updated_at, 'Local restore preserves the existing prose cache timestamp');
            assert.equal(received.updated_at, new Date(lastHlc).toISOString(), 'A receiver stamps the winning HLC');
            divergent.set(cell('node_content', id, 'updated_at'), { native: nativeItem.updated_at, receiver: received.updated_at });
            projected.push('node_content');
          }
        }
        const adjusted = (db: DatabaseSync, native: boolean, table: string) => canonicalRows(raw(db, table).map(item => {
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
          if (table === 'node_content' || table === 'book_node') {
            if (table === 'node_content') value.content_json = JSON.parse(String(value.content_json)) as unknown;
            for (const column of Object.keys(value)) {
              const expected = divergent.get(cell(table, rowKey(table, value), column));
              if (!expected) continue;
              const actual = column === 'content_json' ? JSON.stringify(value[column]) : value[column];
              const pinned: unknown = native ? expected.native : expected.receiver;
              assert.deepEqual(column === 'content_json' ? JSON.stringify(JSON.parse(String(pinned))) : pinned, actual,
                `Local-only ${table}.${column} of ${rowKey(table, value)} (${native ? 'native' : 'receiver'}, step ${index})`);
              value[column] = 'compared-local-only';
            }
          }
          return value;
        }));
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
        assert(Number(remoteWriter[0]!.hlc_wall_ms) >= lastHlc);

        // 4. The bridge library equals what the production repositories read
        // back from the native database and from the receiver.
        const nativeLibrary = await libraryOf(database(step.afterDatabase), path.join(temporary, `library-${index}.db`), fixture.projectId);
        assert.deepEqual(nativeLibrary, step.library, 'Renderer repositories read the native library');
        const receivedDrift = (item: DriftResult): DriftResult => {
          const stamp = divergent.get(cell('book_node', item.id, 'updated_at'));
          return stamp ? { ...item, updatedAt: stamp.receiver as string } : item;
        };
        assert.deepEqual(await rendererLibrary(gateway.client(), fixture.projectId), { ...step.library!,
          drifts: step.library!.drifts.map(receivedDrift), trashedDrifts: step.library!.trashedDrifts.map(receivedDrift) },
        'Renderer repositories read the same library (with pinned local-only stamps) from the receiver');
        // 5. Authoritative prose: targeted bodies change only through these originals.
        const documents = documentIds(expectedAfter).map(id => {
          const state = fullState(expectedAfter, id);
          assert.deepEqual(fullState(gateway.database, id), state);
          const targeted = targets.has(id);
          if (!targeted) assert.deepEqual(fullState(prior, id), state, `${id} changes only through this step's originals`);
          else if (step.operation === 'restoreDrift') {
            // Restore carries the complete current state; the body is unchanged.
            const restore = changeSets[0]!.mutations[changeSets[0]!.mutations.length - 1]!;
            assert.deepEqual(structure(parseYjsUpdatePayload(restore.payload).update), structure(fullState(prior, id)));
            assert.deepEqual(fullState(prior, id), state);
          } else {
            // A created body is exactly the native seed.
            assert.equal(step.operation, 'createDrift');
            assert(!documentIds(prior).includes(id));
            const seedDoc = new Y.Doc();
            try {
              Y.applyUpdate(seedDoc, parseYjsUpdatePayload(changeSets[0]!.mutations[seedIndex]!.payload).update);
              assert.deepEqual(state, Y.encodeStateAsUpdate(seedDoc));
            } finally { seedDoc.destroy(); }
          }
          return { documentId: id.replace(/:.*/u, ':<id>'), targeted, stateSha256: sha(state) };
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
        const positionOf = (db: DatabaseSync) => {
          const row = db.prepare('SELECT position_x,position_y FROM book_node WHERE id=?').get(target.driftId!)!;
          return { x: Number(row.position_x), y: Number(row.position_y) };
        };
        // 7. Non-vacuity: each comparison rejects a one-cell corruption.
        const commandedTable = ['createGroup', 'deleteGroup'].includes(step.operation) ? 'drift_group'
          : step.operation === 'bindAct' ? 'book_act' : 'book_node';
        const commandedKey = commandedTable === 'drift_group' ? (step.operation === 'deleteGroup'
          ? String(raw(expectedAfter, 'drift_group')[0]!.id) : target.groupId!) : commandedTable === 'book_act' ? target.actId! : target.driftId!;
        const nonVacuity = {
          original: rejects('a renderer original with a corrupted target', () => {
            const rendered = renderer.changeSets[renderer.changeSets.length - 1]!;
            const corrupted = { ...rendered, mutations: rendered.mutations.map((mutation, i) =>
              i === 0 ? { ...mutation, target: { ...mutation.target, id: `${mutation.target.id}-corrupted` } } : mutation) };
            const last = originals.length - 1;
            assert.deepEqual(encodeSyncChangeSetV1(substitute(corrupted, originals[last]!.changeSet, last === 0)), originals[last]!.bytes);
          }),
          rendererRow: rejects('a corrupted renderer row', () => {
            const nativeProjection = raw(expectedAfter, commandedTable).find(row => rowKey(commandedTable, row) === commandedKey)!;
            const compared = rendererRow(commandedTable as typeof rendererDomainTables[number], commandedKey, nativeProjection);
            assert.deepEqual(normalize({ ...compared.renderer, id: `${commandedKey}-corrupted` }), normalize(compared.native));
          }),
          table: rejects('a corrupted receiver table', () => {
            const rows = adjusted(gateway.database, false, commandedTable);
            equalRows(commandedTable, rows.map((row, i) => i === 0 ? { ...row, updated_at: 'corrupted' } : row), adjusted(expectedAfter, true, commandedTable));
          }),
          library: rejects('a corrupted library', () => {
            const corrupted = structuredClone(step.library!);
            const first = corrupted.drifts[0] ?? corrupted.trashedDrifts[0] ?? corrupted.groups[0]!;
            first.updatedAt = 'corrupted';
            assert.deepEqual(nativeLibrary, corrupted);
          }),
          // Without groups there is no rank to corrupt.
          rankProjection: groups === 0 ? null : rejects('a corrupted rank projection', () => {
            const copy = path.join(temporary, `rank-${index}.db`);
            copyFileSync(database(step.afterDatabase), copy);
            const corrupted = new DatabaseSync(copy);
            try {
              corrupted.prepare('UPDATE drift_group SET sort_order=sort_order+1 WHERE project_id=?').run(fixture.projectId);
              verifyRankProjection(corrupted, generation, fixture.projectId);
            } finally { corrupted.close(); }
          }),
        };
        steps.push({ operation: step.operation,
          originals: originals.map(({ bytes, changeSet }) => ({ sha256: sha(bytes), mutationCount: changeSet.mutations.length,
            actions: changeSet.mutations.map(mutation => mutation.action) })),
          incarnation, orderPlan, groups, localDomainWire: 'passed', rendererAuthority: 'passed', rendererRow: 'passed', seed,
          position: step.operation === 'createDrift'
            ? { native: positionOf(expectedAfter), renderer: renderer.position, receiver: positionOf(gateway.database) } : null,
          actUnbinds: renderer.unbinds.acts, flooredStamp, receiverNodeStamps, faultRollback: step.faultBeforeApply ? faults : 0, duplicate: 'passed', rankProjection: 'passed',
          hierarchy: 'passed', library: 'passed', command: 'passed', carriedCheckpoints: carried.map(id => id.replace(/:.*/u, ':<id>')),
          cacheProjection: projected,
          localOnly: [...new Set([...divergent.keys()].map(key => {
            const [table, , column] = key.split('\0');
            return `${table}.${column}`;
          }))].sort(),
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
  assert.deepEqual(fixture.cases.map(item => item.name), Object.keys(expectedCases));
  mkdirSync(path.dirname(output), { recursive: true });
  const fractionalIndexing = verifyFractionalVectors();
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences, excludedColumns: [], exemptions, localOnlyEffects, carriedOwnerState, rendererDivergences, reducerDefects,
    fractionalIndexing,
    scope: 'Native drift create/rename/update/move/trash/restore, drift-group create/delete and act binding originals match the renderer use cases authored on the same prior state (byte-identical except seed Yjs, several originals per command in order), production reducer SQLite effects, the production node, act and drift-group repositories, the drift-group rank projection and authoritative body Yjs. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, driftSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
