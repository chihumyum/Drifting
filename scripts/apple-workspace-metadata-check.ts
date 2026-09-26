// Actual native project summary/facts/storyline-template and chapter/drift
// summary/status originals: rebuilt through the renderer use cases
// (useProject.updateProject, useBookNode.updateNodeSummary and the
// useEntityCellAction status path through useBookNode.updateNode) on the prior
// native database, then replayed by the production TS reducer on an
// independent copy and compared with the native databases. Run with
// `--import=./scripts/apple-workspace-element-kv-ids.mjs`, which replays native
// kv-entry IDs into the renderer KV authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { generateNKeysBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { CHAPTER_WRITING_STATUSES, DRIFT_STATUSES, isDrift, type BookNode, type WritingStatus } from '../src/renderer/domain/book-node';
import { defaultProjectKvList, parseKv, stringifyKv } from '../src/renderer/domain/kv';
import type { DbExecutor, DbTransaction } from '../src/renderer/lib/db';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createBookNodeSqliteRepository } from '../src/renderer/sqlite-repo/node-repo';
import { createProjectRepository } from '../src/renderer/sqlite-repo/project-repo';
import { createAuthoredTransactionRunner } from '../src/renderer/sync/journal/authored-transaction';
import type { SyncChangeBuilder } from '../src/renderer/sync/journal/change-builder';
import { appendAuthoredDomainMutation } from '../src/renderer/sync/journal/domain-mutation';
import { compareUtf8Bytewise, type SyncChangeSetV1 } from '../src/renderer/sync/protocol';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';
import { persistBookNodeUpdateWithSync } from '../src/renderer/usecase/book-node-write';
import { replaceEntityKvEntriesInTransaction } from '../src/renderer/usecase/normalized-kv-alias-authority';
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
  'project', 'book_node', 'node_content', 'entity_kv_entry', 'storylines', 'node_storyline_link', 'book_act', 'drift_group',
  'entity_relation', 'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_yjs_materialization_receipt',
  'sync_entity_lifecycle', 'sync_field_clock', 'sync_set_tag', 'sync_order_register', 'sync_conflict',
  'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
// Metadata commands touch no body, storyline, membership, act, group or relation.
const preservedTables = [
  'node_content', 'storylines', 'node_storyline_link', 'book_act', 'drift_group', 'entity_relation', 'sync_set_tag', 'sync_conflict',
  'sync_yjs_materialization_receipt', 'yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance',
];
// Authority rows the renderer's own local authored transactions write.
const rendererAuthorityTables = [
  'sync_change_set', 'sync_mutation', 'sync_apply_receipt', 'sync_entity_lifecycle', 'sync_field_clock',
  'sync_set_tag', 'sync_order_register', 'sync_generation_writer_state',
];
// Domain rows the renderer use cases write themselves.
const rendererDomainTables = ['project', 'book_node', 'entity_kv_entry'] as const;
type DomainTable = typeof rendererDomainTables[number];
// Live body owners; no metadata original or command may touch them.
const ownerTables = ['yjs_updates', 'yjs_snapshots', 'yjs_document_revision', 'yjs_document_revision_provenance', 'sync_yjs_materialization_receipt'];
const roleDifferences = [
  'New original origin local/remote',
  'Local sequence allocation versus remote HLC observation',
];
const exemptions = [
  'New kv-entry IDs: the renderer KV authority mints uuidv7 while native mints host IDs, so its uuid import is replaced (scripts/apple-workspace-element-kv-ids.mjs) by the created kv-entry IDs of the native original in mutation order; each renderer step must drain exactly that queue.',
  'The use-case clock (new Date() in updateProject and updateNodeSummary, Date.now() in nextNodeUpdatedAt) and the project owner (useProject userId, the stored project.user_id) are injected; the renderer computes every fact reconciliation, order key, stamp, projection and wire byte itself.',
];
const localOnlyEffects = [
  'A facts- or template-only updateProject carries no project owner field: the authoring side stamps project.updated_at (native and the renderer use case alike) while a receiving reducer keeps the time of the project\'s UTF-8-last field register (here the summary edit). Tracked per row with exact values until an owner field re-stamps it.',
  'A status edit (updateNode) within the millisecond of the node\'s previous stamp floors updated_at at that stamp + 1 ms on the authoring side (native and the renderer alike) while a receiver stamps the winning HLC; when it occurs it is tracked per row with exact values.',
];
// Native and renderer authoring agree on every compared row and byte.
const rendererDivergences: string[] = [];
const reducerDefects = [
  'TS remote node stamps follow field-register order, not time: every remote apply re-materializes each field register of the reduced state in effect-id (UTF-8) order and each write stamps updated_at with that register\'s winning HLC, so a node ends at the time of its UTF-8-last field register. After a drift\'s summary edit later than its status edit (field:summary sorts before field:writingStatus), a receiver keeps the older status time while native and the renderer keep the summary time. Pinned per row with exact values.',
];
type Operation = 'updateProject' | 'reorderFacts' | 'setNodeSummary' | 'setNodeStatus';
interface Fact { key: string; value: string }
/** The exported bridge command, exactly as sent. */
interface Command {
  action: 'updateProject' | 'setNodeSummary' | 'setNodeStatus';
  summary?: string;
  facts?: Fact[];
  storylineTemplate?: Fact[];
  nodeId?: string;
  status?: string;
}
const expectedOperations: Operation[] = ['updateProject', 'reorderFacts', 'setNodeSummary', 'setNodeStatus', 'setNodeStatus', 'setNodeSummary'];
const expectedActions: string[][][] = [
  [['entity.purge', 'field.set', 'entity.create', 'order.move', 'entity.create', 'entity.create', 'order.move', 'order.move', 'field.set']],
  [Array<string>(6).fill('order.rebalance')],
  [['field.set']], [['field.set']], [['field.set']], [['field.set']],
];
const expectedFaults = [true, false, false, true, false, false];
const TEMPLATE: Fact[] = [{ key: '主题', value: '' }, { key: '节奏', value: '慢' }];
/** The bridge-test commands, rebuilt from the renderer's default project facts. */
function expectedCommands(fixture: Case): Command[] {
  const edited = defaultProjectKvList().map(fact => ({ ...fact }));
  edited[0]!.value = '近未来的北方小城🙂';
  edited.splice(1, 1);
  edited.push({ key: '基调', value: '安静' });
  const reordered = [edited[edited.length - 1]!, ...edited.slice(0, -1)];
  const chapter = fixture.chapterIds[0]!;
  return [
    { action: 'updateProject', summary: '一座钟楼与它的守夜人。', facts: edited, storylineTemplate: TEMPLATE },
    { action: 'updateProject', facts: reordered },
    { action: 'setNodeSummary', nodeId: chapter, summary: '她在雨夜回到北塔。' },
    { action: 'setNodeStatus', nodeId: chapter, status: 'finished' },
    { action: 'setNodeStatus', nodeId: fixture.driftId, status: 'resting' },
    { action: 'setNodeSummary', nodeId: fixture.driftId, summary: '钟声从哪里来' },
  ];
}
interface ProjectResult {
  id: string; name: string; summary: string; userId: string; createdAt: string; updatedAt: string;
  projectSyncId: string; syncGenerationId: string; facts: Fact[]; storylineTemplate: Fact[];
}
interface NodeResult { id: string; kind: string; title: string; summary: string; writingStatus: string; updatedAt: string }
const projectKeys = ['createdAt', 'facts', 'id', 'name', 'projectSyncId', 'storylineTemplate', 'summary', 'syncGenerationId', 'updatedAt', 'userId'];
const nodeKeys = ['id', 'kind', 'summary', 'title', 'updatedAt', 'writingStatus'];
interface Original { encodedBase64: string; mutationCount: number; createdAt: string }
interface Step {
  operation: Operation;
  command: Command;
  originals: Original[];
  afterDatabase: string;
  faultBeforeApply: boolean;
  result: ProjectResult | NodeResult;
}
interface Case {
  name: string;
  beforeDatabase: string;
  projectId: string;
  chapterIds: string[];
  driftId: string;
  identity: { installationId: string; writerId: string; writerEpoch: string };
  steps: Step[];
}
type Row = Record<string, unknown>;
type Namespace = 'facts' | 'storyline-template';
const NAMESPACES: readonly Namespace[] = ['facts', 'storyline-template'];
const projectionColumn: Record<Namespace, string> = { facts: 'kv_json', 'storyline-template': 'storyline_template_kv_json' };
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
    if (error.message.includes('synthetic metadata receipt fault')) return true;
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
/** Renderer cleanedKv: rows with a non-blank key or value, untrimmed. */
const cleanedFacts = (facts: readonly Fact[]): Fact[] => parseKv(stringifyKv([...facts]));
const factScope = (projectId: string, namespace: Namespace) => JSON.stringify(['project', projectId, namespace]);
interface Entry extends Fact { id: string; position: string }
/** KV authority of one project namespace: rows in order-register order (position bytes, then id). */
function factEntries(db: DatabaseSync, generation: string, projectId: string, namespace: Namespace): Entry[] {
  const rows = db.prepare("SELECT id,key,value FROM entity_kv_entry WHERE project_id=? AND owner_kind='project' AND owner_id=? AND namespace=?")
    .all(projectId, projectId, namespace);
  const positions = new Map(db.prepare(`SELECT entity_id,position_key FROM sync_order_register
    WHERE sync_generation_id=? AND list_kind='kv-entry' AND owner_id=? AND incarnation=0`).all(generation, factScope(projectId, namespace))
    .map(row => [String(row.entity_id), String(row.position_key)]));
  for (const row of rows) {
    assert(positions.has(String(row.id)), 'Every fact has an order register');
    assert.deepEqual(lifecycle(db, generation, 'kv-entry', String(row.id)), { incarnation: 0, state: 'live' }, 'Every fact is a live kv-entry');
  }
  return rows.map(row => ({ id: String(row.id), key: String(row.key), value: String(row.value), position: positions.get(String(row.id))! }))
    .sort((a, b) => compareUtf8Bytewise(a.position, b.position) || compareUtf8Bytewise(a.id, b.id));
}
const factsOf = (db: DatabaseSync, generation: string, projectId: string, namespace: Namespace): Fact[] =>
  factEntries(db, generation, projectId, namespace).map(({ key, value }) => ({ key, value }));
/** kv_json / storyline_template_kv_json project the authority exactly (stringifyKv bytes). */
function verifyFactProjection(db: DatabaseSync, generation: string, projectId: string) {
  const row = db.prepare('SELECT kv_json,storyline_template_kv_json FROM project WHERE id=?').get(projectId)!;
  for (const namespace of NAMESPACES) {
    assert.equal(row[projectionColumn[namespace]], stringifyKv(factsOf(db, generation, projectId, namespace)),
      `${projectionColumn[namespace]} projects the ${namespace} authority`);
  }
}
/** The native project details, read independently of both authors from the authority. */
function projectDetails(db: DatabaseSync, generation: string, projectId: string): ProjectResult {
  const row = db.prepare('SELECT * FROM project WHERE id=?').get(projectId)!;
  const sync = db.prepare("SELECT project_sync_id,sync_generation_id FROM sync_generation WHERE project_id=? AND status='active'").get(projectId)!;
  assert.equal(sync.sync_generation_id, generation);
  return { id: projectId, name: String(row.name), summary: String(row.summary), userId: String(row.user_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), projectSyncId: String(sync.project_sync_id),
    syncGenerationId: generation, facts: factsOf(db, generation, projectId, 'facts'),
    storylineTemplate: factsOf(db, generation, projectId, 'storyline-template') };
}
function nodeMetadata(db: DatabaseSync, id: string): NodeResult {
  const row = db.prepare('SELECT * FROM book_node WHERE id=?').get(id)!;
  assert.equal(row.deleted_at, null, 'Metadata targets live nodes');
  return { id, kind: String(row.kind), title: String(row.title), summary: String(row.summary),
    writingStatus: String(row.writing_status), updatedAt: String(row.updated_at) };
}
/**
 * The project as the production project repository (useProject's store) reads
 * it back; the active generation's identity is the one the project was opened with.
 */
async function rendererProject(client: DbExecutor, projectId: string, userId: string,
  sync: { projectSyncId: string; syncGenerationId: string }): Promise<ProjectResult> {
  const project = await createProjectRepository(userId, client).findById(projectId);
  assert(project);
  return { id: project.id, name: project.name, summary: project.summary, userId: project.userId, createdAt: project.createdAt,
    updatedAt: project.updatedAt, ...sync, facts: parseKv(project.kvJson), storylineTemplate: parseKv(project.storylineTemplateKvJson) };
}
/** A chapter or drift as the production node repository (useBookNode's store) reads it back. */
async function rendererNode(client: DbExecutor, projectId: string, id: string): Promise<NodeResult> {
  const node = (await createBookNodeSqliteRepository(projectId, client).findAll()).find(item => item.id === id);
  assert(node, `The node repository reads ${id}`);
  return { id: node.id, kind: node.kind, title: node.title, summary: node.summary, writingStatus: node.writingStatus, updatedAt: node.updatedAt };
}
/** Read a result back through the production repositories from a database file. */
async function repositoryResult(file: string, scratch: string, fixture: Case, step: Step,
  sync: { projectSyncId: string; syncGenerationId: string }) {
  copyFileSync(file, scratch);
  const gateway = new ProductFileBackedSqliteGateway(scratch);
  try {
    if (step.command.action === 'updateProject') {
      return await rendererProject(gateway.client(), fixture.projectId, (step.result as ProjectResult).userId, sync);
    }
    return await rendererNode(gateway.client(), fixture.projectId, step.command.nodeId!);
  } finally { await gateway.close(); }
}
/** useBookNode nextNodeUpdatedAt with Date.now() pinned to the authored clock. */
function nextNodeUpdatedAt(previous: string, now: string): string {
  const previousMs = Date.parse(previous);
  const floor = Number.isFinite(previousMs) ? previousMs + 1 : 0;
  return new Date(Math.max(Date.parse(now), floor)).toISOString();
}
/**
 * The order originals planned independently of both authors: surviving keys
 * stay, inserted runs take keys inside their surviving neighbours' gap, and
 * any reorder of survivors rebalances the whole scope from scratch.
 */
function plannedOrder(prior: ReadonlyMap<string, string>, desired: readonly string[]): { kind: 'moves' | 'rebalance' | null; entries: [string, string][] } {
  const zip = (ids: readonly string[], keys: readonly string[]) => ids.map((id, index): [string, string] => [id, keys[index]!]);
  const rebalance = () => ({ kind: 'rebalance' as const, entries: zip(desired, generateNKeysBetween(null, null, desired.length)) });
  const survivors = desired.filter(id => prior.has(id));
  const sorted = [...survivors].sort((a, b) => compareUtf8Bytewise(prior.get(a)!, prior.get(b)!) || compareUtf8Bytewise(a, b));
  if (!isDeepStrictEqual(survivors, sorted)) return rebalance();
  const entries: [string, string][] = [];
  for (let cursor = 0; cursor < desired.length;) {
    if (prior.has(desired[cursor]!)) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < desired.length && !prior.has(desired[cursor]!)) cursor += 1;
    const left = start > 0 ? prior.get(desired[start - 1]!)! : null;
    const right = cursor < desired.length ? prior.get(desired[cursor]!)! : null;
    if (left !== null && right !== null && compareUtf8Bytewise(left, right) >= 0) return rebalance();
    entries.push(...zip(desired.slice(start, cursor), generateNKeysBetween(left, right, cursor - start)));
  }
  return { kind: entries.length > 0 ? 'moves' : null, entries };
}
interface Target { kind: 'project' | 'chapter' | 'drift'; nodeId: string | null }
function resolve(fixture: Case, prior: DatabaseSync, step: Step): Target {
  if (step.command.action === 'updateProject') return { kind: 'project', nodeId: null };
  const nodeId = step.command.nodeId!;
  const row = prior.prepare('SELECT kind FROM book_node WHERE id=? AND project_id=? AND deleted_at IS NULL').get(nodeId, fixture.projectId);
  assert(row, 'The commanded node is live in the project');
  assert.equal(row.kind, nodeId === fixture.driftId ? 'drift' : 'chapter');
  return { kind: row.kind as 'chapter' | 'drift', nodeId };
}

/**
 * Mirror each renderer use case's authored effect (through
 * withAtomicSyncTransaction and the production authored runner, whose
 * post-write observer validates with the production kernel) on a copy of the
 * prior native database. Store reads become the repository reads that hydrate them.
 */
async function rendererOriginals(fixture: Case, step: Step, target: Target, prior: string, scratch: string,
  kvEntryIds: readonly string[]) {
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
  // The use cases' `new Date()` / `Date.now()`, pinned to the authored clock.
  const now = current;
  kvEntryIdQueue.splice(0, kvEntryIdQueue.length, ...kvEntryIds);
  let skipped = false;
  try {
    switch (step.operation) {
      case 'updateProject':
      case 'reorderFacts': {
        // useProject.updateProject(id, input) with the command's fields as
        // UpdateProjectInput (facts/template as the KV editor's JSON); the
        // hook's userId owns the stored project.
        const command = step.command;
        const userId = String(gateway.database.prepare('SELECT user_id FROM project WHERE id=?').get(projectId)!.user_id);
        const updateInput: { name?: string; summary?: string; kvJson?: string; storylineTemplateKvJson?: string } = {
          ...(command.summary !== undefined ? { summary: command.summary } : {}),
          ...(command.facts !== undefined ? { kvJson: JSON.stringify(command.facts) } : {}),
          ...(command.storylineTemplate !== undefined ? { storylineTemplateKvJson: JSON.stringify(command.storylineTemplate) } : {}),
        };
        const id = projectId;
        await atomic(async (tx, sync, changes) => {
          if (updateInput.kvJson !== undefined) {
            await replaceEntityKvEntriesInTransaction(tx, changes, { projectId: id, ownerKind: 'project', ownerId: id,
              namespace: 'facts', nextJson: updateInput.kvJson });
          }
          if (updateInput.storylineTemplateKvJson !== undefined) {
            await replaceEntityKvEntriesInTransaction(tx, changes, { projectId: id, ownerKind: 'project', ownerId: id,
              namespace: 'storyline-template', nextJson: updateInput.storylineTemplateKvJson });
          }
          const updated = await createProjectRepository(userId, tx).update(id, { userId, name: updateInput.name,
            summary: updateInput.summary, updatedAt: now() });
          if (updated && (updateInput.name !== undefined || updateInput.summary !== undefined)) {
            await sync('project', 'update', id, id, { name: updateInput.name, summary: updateInput.summary });
          }
          return updated;
        });
        break;
      }
      case 'setNodeSummary': {
        // useBookNode.updateNodeSummary(id, summary): the store node, a
        // wall-clock stamp, the summary alone journaled.
        const id = target.nodeId!;
        const summary = step.command.summary!;
        const existing = (await createBookNodeSqliteRepository(projectId, client).findAll()).find(node => node.id === id);
        assert(existing, `Book node ${id} not found`);
        const updatedAt = now();
        await atomic(async (tx, sync) => {
          const result = await createBookNodeSqliteRepository(projectId, tx).update(id, { summary, updatedAt });
          await sync('node', 'update', id, projectId, { summary });
          return result;
        });
        break;
      }
      case 'setNodeStatus': {
        // useEntityCellAction set-status -> useBookNode.updateNode(id, { writingStatus }).
        const id = target.nodeId!;
        const next = step.command.status! as WritingStatus;
        const node: BookNode | undefined = (await createBookNodeSqliteRepository(projectId, client).findAll()).find(item => item.id === id);
        assert(node);
        const allowed: readonly WritingStatus[] = isDrift(node) ? DRIFT_STATUSES : CHAPTER_WRITING_STATUSES;
        if (!allowed.includes(next) || next === node.writingStatus) {
          skipped = true;
          break;
        }
        const updatedAt = nextNodeUpdatedAt(node.updatedAt, now());
        const nodeUpdates = { writingStatus: next };
        const serverUpdates: Record<string, unknown> = { ...nodeUpdates };
        await persistBookNodeUpdateWithSync({ projectId, nodeId: id, updates: { ...nodeUpdates, updatedAt }, syncPayload: serverUpdates },
          (runProjectId, work) => {
            assert.equal(runProjectId, projectId);
            return atomic(work);
          });
        break;
      }
    }
    assert(!skipped, 'The renderer status action accepts the exported status');
    assert.deepEqual(kvEntryIdQueue, [], 'The renderer KV authority mints exactly the native kv-entry IDs');
    assert.equal(committed, step.originals.length, 'The renderer commits one original per native original');
    const changeSets: SyncChangeSetV1[] = [];
    for (const row of gateway.database.prepare("SELECT encoded_bytes FROM sync_change_set WHERE origin='local' AND rowid>? ORDER BY rowid").all(startRowid)) {
      assert(row.encoded_bytes instanceof Uint8Array);
      const decoded = await decodeSyncChangeSetV1(row.encoded_bytes);
      assert(decoded.ok, 'Renderer original must decode');
      changeSets.push(decoded.value);
    }
    return { changeSets, authority: snapshot(gateway.database, rendererAuthorityTables),
      rows: Object.fromEntries(rendererDomainTables.map(table => [table, raw(gateway.database, table)])) as Record<DomainTable, Row[]> };
  } finally {
    kvEntryIdQueue.length = 0;
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}

type Mutation = SyncChangeSetV1['mutations'][number];
type Expected = Pick<Mutation, 'action' | 'target' | 'payload'>;
/**
 * Every mutation target, incarnation and payload against the native
 * after-state, rebuilt independently of both authors: per commanded project
 * namespace (facts, then the template) purges of dropped entries, creates and
 * field sets in desired order, the planned order originals, then the summary;
 * or the node's single field.set.
 */
function verifyMutations(prior: DatabaseSync, after: DatabaseSync, generation: string, fixture: Case, step: Step,
  changeSets: SyncChangeSetV1[], target: Target) {
  const projectId = fixture.projectId;
  const actual: Expected[] = changeSets.flatMap(changeSet => changeSet.mutations)
    .map(({ action, target: mutationTarget, payload }) => ({ action, target: mutationTarget, payload }));
  const command = step.command;
  if (target.nodeId) {
    const [field, column, value] = step.operation === 'setNodeSummary'
      ? ['summary', 'summary', command.summary] : ['writingStatus', 'writing_status', command.status];
    const row = after.prepare('SELECT * FROM book_node WHERE id=?').get(target.nodeId)!;
    assert.equal(row[column], value, 'The native after-state holds the commanded value');
    assert.deepEqual(actual, [{ action: 'field.set',
      target: { family: 'entity', kind: 'node', id: target.nodeId, incarnation: incarnationOf(after, generation, 'node', target.nodeId) },
      payload: { field, value: row[column] } }]);
    return { orderPlans: null, created: [] as string[] };
  }
  const expected: Expected[] = [];
  const created: string[] = [];
  const orderPlans: Partial<Record<Namespace, string | null>> = {};
  const commanded: [Namespace, Fact[] | undefined][] = [['facts', command.facts], ['storyline-template', command.storylineTemplate]];
  for (const [namespace, desired] of commanded) {
    if (desired === undefined) continue;
    const owner = { projectId, ownerKind: 'project', ownerId: projectId, namespace };
    const scope = factScope(projectId, namespace);
    const before = factEntries(prior, generation, projectId, namespace);
    const now = factEntries(after, generation, projectId, namespace);
    assert.deepEqual(now.map(({ key, value }) => ({ key, value })), cleanedFacts(desired), `The ${namespace} authority is the cleaned command`);
    const kvTarget = (id: string) => ({ family: 'entity' as const, kind: 'kv-entry', id, incarnation: 0 });
    const ids = now.map(entry => entry.id);
    for (const entry of before) {
      if (ids.includes(entry.id)) continue;
      assert.equal(after.prepare('SELECT 1 FROM entity_kv_entry WHERE id=?').get(entry.id), undefined, 'A purged fact row is removed');
      assert.equal(lifecycle(after, generation, 'kv-entry', entry.id)?.state, 'purged', 'A purged fact is purged in the lifecycle');
      expected.push({ action: 'entity.purge', target: kvTarget(entry.id), payload: {} });
    }
    for (const entry of now) {
      const previous = before.find(item => item.id === entry.id);
      if (!previous) {
        assert.equal(prior.prepare('SELECT 1 FROM sync_entity_lifecycle WHERE entity_id=?').get(entry.id), undefined, 'A created fact ID is fresh');
        created.push(entry.id);
        expected.push({ action: 'entity.create', target: kvTarget(entry.id), payload: { seed: { ...owner, key: entry.key, value: entry.value } } });
        continue;
      }
      // An exact prior row keeps its identity.
      if (before.some(item => item.key === entry.key && item.value === entry.value)) assert.equal(previous.key + previous.value, entry.key + entry.value);
      if (previous.key !== entry.key) expected.push({ action: 'field.set', target: kvTarget(entry.id), payload: { field: 'key', value: entry.key } });
      if (previous.value !== entry.value) expected.push({ action: 'field.set', target: kvTarget(entry.id), payload: { field: 'value', value: entry.value } });
    }
    const plan = plannedOrder(new Map(before.map(entry => [entry.id, entry.position])), ids);
    orderPlans[namespace] = plan.kind;
    for (const [entityId, positionKey] of plan.entries) {
      assert.equal(now.find(entry => entry.id === entityId)!.position, positionKey, 'The order register holds the planned key');
      expected.push(plan.kind === 'moves'
        ? { action: 'order.move', target: { family: 'order', kind: 'kv-entry', id: entityId, incarnation: 0 }, payload: { scope, positionKey } }
        : { action: 'order.rebalance', target: { family: 'order', kind: 'kv-entry', id: entityId, incarnation: 0 },
          payload: { scope, entries: [{ entityId, positionKey }] } });
    }
    for (const entry of now) {
      if (!plan.entries.some(([id]) => id === entry.id)) assert.equal(entry.position, before.find(item => item.id === entry.id)!.position, 'Unplanned keys survive');
    }
  }
  for (const namespace of NAMESPACES) {
    if (commanded.some(([name, desired]) => name === namespace && desired !== undefined)) continue;
    assert.deepEqual(factEntries(after, generation, projectId, namespace), factEntries(prior, generation, projectId, namespace), `Uncommanded ${namespace} is unchanged`);
  }
  const summary = String(after.prepare('SELECT summary FROM project WHERE id=?').get(projectId)!.summary);
  const priorSummary = String(prior.prepare('SELECT summary FROM project WHERE id=?').get(projectId)!.summary);
  assert.equal(summary, command.summary ?? priorSummary);
  if (command.summary !== undefined && command.summary !== priorSummary) {
    expected.push({ action: 'field.set', target: { family: 'entity', kind: 'project', id: projectId,
      incarnation: incarnationOf(after, generation, 'project', projectId) }, payload: { field: 'summary', value: summary } });
  }
  assert.deepEqual(actual, expected, 'Project originals are the independently planned facts, template and summary mutations');
  return { orderPlans, created };
}
/** Each command changes exactly its commanded fields and the authored stamp. */
function verifyCommand(prior: DatabaseSync, after: DatabaseSync, generation: string, fixture: Case, step: Step, target: Target) {
  const at = step.originals[0]!.createdAt;
  assert(step.originals.every(original => original.createdAt === at), 'One command authors every original at one time');
  const command = step.command;
  if (!target.nodeId) {
    assert.deepEqual(Object.keys(step.result).sort(), projectKeys);
    const before = projectDetails(prior, generation, fixture.projectId);
    const changed: ProjectResult = { ...before,
      ...(command.summary !== undefined ? { summary: command.summary } : {}),
      ...(command.facts !== undefined ? { facts: cleanedFacts(command.facts) } : {}),
      ...(command.storylineTemplate !== undefined ? { storylineTemplate: cleanedFacts(command.storylineTemplate) } : {}) };
    assert.notDeepEqual(changed, before, 'The exported update changes the project');
    assert.deepEqual(step.result, { ...changed, updatedAt: at });
    assert.deepEqual(projectDetails(after, generation, fixture.projectId), step.result);
    // Nodes are untouched.
    assert.deepEqual(canonicalRows(raw(after, 'book_node')), canonicalRows(raw(prior, 'book_node')));
    return;
  }
  assert.deepEqual(Object.keys(step.result).sort(), nodeKeys);
  const before = nodeMetadata(prior, target.nodeId);
  let changed: NodeResult;
  if (step.operation === 'setNodeSummary') {
    // updateNodeSummary stamps the wall clock without a floor.
    changed = { ...before, summary: command.summary!, updatedAt: at };
    assert.notEqual(command.summary, before.summary, 'The exported summary changes');
  } else {
    const allowed: readonly string[] = before.kind === 'drift' ? DRIFT_STATUSES : CHAPTER_WRITING_STATUSES;
    assert(allowed.includes(command.status!), 'The exported status is allowed for the node kind');
    assert.notEqual(command.status, before.writingStatus, 'The exported status changes');
    changed = { ...before, writingStatus: command.status!, updatedAt: nextNodeUpdatedAt(before.updatedAt, at) };
  }
  assert.deepEqual(step.result, changed);
  assert.deepEqual(nodeMetadata(after, target.nodeId), changed);
  // Every other node, the project and its facts are untouched.
  assert.deepEqual(canonicalRows(raw(after, 'book_node').filter(row => row.id !== target.nodeId)),
    canonicalRows(raw(prior, 'book_node').filter(row => row.id !== target.nodeId)));
  for (const table of ['project', 'entity_kv_entry']) assert.deepEqual(canonicalRows(raw(after, table)), canonicalRows(raw(prior, table)));
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
/** Field registers of one target at its current incarnation, in effect-id (UTF-8 field key) order. */
function fieldRegisters(db: DatabaseSync, generation: string, kind: string, id: string): { field: string; wallMs: number }[] {
  return db.prepare(`SELECT field_key,hlc_wall_ms FROM sync_field_clock WHERE sync_generation_id=?
    AND target_kind=? AND target_id=? AND incarnation=?`).all(generation, kind, id, incarnationOf(db, generation, kind, id))
    .map(row => ({ field: String(row.field_key), wallMs: Number(row.hlc_wall_ms) }))
    .sort((a, b) => compareUtf8Bytewise(a.field, b.field));
}

async function verify(fixture: Case, ordinal: number) {
  assert.deepEqual(fixture.steps.map(step => step.operation), expectedOperations);
  assert.equal(fixture.chapterIds.length, 2);
  assert.deepEqual(fixture.steps.map(step => step.command), expectedCommands(fixture), 'The exported commands are the pinned bridge commands');
  assert.deepEqual(fixture.steps.map(step => step.faultBeforeApply), expectedFaults);
  const temporary = mkdtempSync(path.join(path.dirname(output), `metadata-receiver-${ordinal}-`));
  const file = path.join(temporary, 'receiver.db');
  copyFileSync(database(fixture.beforeDatabase), file);
  const gateway = new ProductFileBackedSqliteGateway(file);
  const initial = new DatabaseSync(database(fixture.beforeDatabase), { readOnly: true });
  const originalIds = new Set<string>();
  const writerBefore = raw(initial, 'sync_generation_writer_state');
  assert.equal(writerBefore.length, 1);
  const generation = String(writerBefore[0]!.sync_generation_id);
  const baseline = snapshot(initial);
  // A new native project seeds the renderer's default facts and an empty template.
  assert.deepEqual(factsOf(initial, generation, fixture.projectId, 'facts'), defaultProjectKvList());
  assert.deepEqual(factsOf(initial, generation, fixture.projectId, 'storyline-template'), []);
  verifyFactProjection(initial, generation, fixture.projectId);
  const syncIdentity = { projectSyncId: String(initial.prepare('SELECT project_sync_id FROM sync_generation WHERE sync_generation_id=?')
    .get(generation)!.project_sync_id), syncGenerationId: generation };
  // Local-only domain cells: `${table}\0${key}\0${column}` -> exact native/receiver values.
  const divergent = new Map<string, { native: unknown; receiver: unknown }>();
  const cell = (table: string, key: string, column: string) => `${table}\0${key}\0${column}`;
  // Nodes whose authored stamp was floored at the previous stamp + 1 ms.
  const flooredNodes = new Set<string>();
  // The authored time of the latest KV-only project update (no project field).
  let kvOnlyStamp: string | null = null;
  assert.deepEqual(raw(initial, 'sync_conflict'), []);
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
        assert.deepEqual(changeSet.mutations.map(mutation => mutation.action), expectedActions[index]![position]);
        if (position > 0) assert.equal(changeSet.deviceSeq, originals[position - 1]!.changeSet.deviceSeq + 1, 'A command journals consecutive originals');
        originals.push({ bytes, changeSet });
      }
      const changeSets = originals.map(item => item.changeSet);
      const at = step.originals[0]!.createdAt;
      const priorName = index === 0 ? fixture.beforeDatabase : fixture.steps[index - 1]!.afterDatabase;
      const prior = new DatabaseSync(database(priorName), { readOnly: true });
      const expectedAfter = new DatabaseSync(database(step.afterDatabase), { readOnly: true });
      try {
        // 1. Targets, incarnations, payloads, order keys and the command's delta.
        const target = resolve(fixture, prior, step);
        const incarnation = target.nodeId ? incarnationOf(expectedAfter, generation, 'node', target.nodeId)
          : incarnationOf(expectedAfter, generation, 'project', fixture.projectId);
        const { orderPlans, created } = verifyMutations(prior, expectedAfter, generation, fixture, step, changeSets, target);
        verifyCommand(prior, expectedAfter, generation, fixture, step, target);
        verifyFactProjection(expectedAfter, generation, fixture.projectId);
        assert.deepEqual(snapshot(expectedAfter, ownerTables), snapshot(prior, ownerTables), 'Native metadata commands leave prose owners untouched');
        assert.deepEqual(raw(expectedAfter, 'sync_conflict'), [], 'Native records no conflict');

        // 2. The renderer use case, run on the same prior state through the
        // production authored runner, authors the same originals.
        const renderer = await rendererOriginals(fixture, step, target, database(priorName), path.join(temporary, `renderer-${index}.db`), created);
        assert.equal(renderer.changeSets.length, changeSets.length);
        for (const [position, { bytes }] of originals.entries()) {
          assert.deepEqual(encodeSyncChangeSetV1(renderer.changeSets[position]!), bytes, `Renderer use case authors the identical original ${position}`);
        }
        const nativeAuthority = snapshot(expectedAfter, rendererAuthorityTables);
        for (const table of rendererAuthorityTables) {
          equalRows(`renderer ${table}`, renderer.authority[table]!, nativeAuthority[table]!);
        }
        // The renderer's own project (projections and stamp), node and kv-entry rows.
        const rendererRow = (table: DomainTable, key: string): { renderer: Row; native: Row } => {
          const rendered = renderer.rows[table].find(row => String(row.id) === key);
          assert(rendered, `Renderer ${table} ${key}`);
          return { renderer: { ...rendered }, native: { ...raw(expectedAfter, table).find(row => String(row.id) === key)! } };
        };
        for (const table of rendererDomainTables) {
          const keys = raw(expectedAfter, table).map(row => String(row.id)).sort();
          assert.deepEqual(renderer.rows[table].map(row => String(row.id)).sort(), keys, `Renderer ${table} rows`);
          for (const key of keys) {
            const compared = rendererRow(table, key);
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
        let faults = 0;
        invalidateSqliteReducerStateCache();
        for (const [position, { changeSet }] of originals.entries()) {
          const context = contextOf(changeSet, step.originals[position]!.createdAt);
          if (step.faultBeforeApply) {
            const unchanged = snapshot(gateway.database);
            gateway.database.exec("CREATE TRIGGER fail_metadata_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic metadata receipt fault'); END");
            await assert.rejects(gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context)), causedByFault);
            assert.deepEqual(snapshot(gateway.database), unchanged);
            gateway.database.exec('DROP TRIGGER fail_metadata_receipt');
            faults += 1;
          }
          const applied = await gateway.client().transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, context));
          assert.equal(applied.status, 'applied');
          assert.deepEqual(applied.conflicts, []);
          originalIds.add(changeSet.changeSetId);
        }
        assert.deepEqual(snapshot(gateway.database, ownerTables), owner, 'Metadata originals leave prose owners untouched');
        verifyFactProjection(gateway.database, generation, fixture.projectId);

        // Stamps: a KV-only project update stamps project.updated_at only on
        // the authoring side; a status edit may floor its stamp; a receiver
        // ends each node at its UTF-8-last field register.
        const touchesKv = changeSets.some(changeSet => changeSet.mutations.some(mutation => mutation.target.kind === 'kv-entry'));
        const touchesProject = changeSets.some(changeSet => changeSet.mutations.some(mutation => mutation.target.kind === 'project'));
        if (touchesKv && !touchesProject) kvOnlyStamp = at;
        else if (touchesProject) kvOnlyStamp = null;
        let flooredStamp = false;
        if (step.operation === 'setNodeStatus') {
          const stamp = nextNodeUpdatedAt(String(prior.prepare('SELECT updated_at FROM book_node WHERE id=?').get(target.nodeId!)!.updated_at), at);
          flooredStamp = stamp !== at;
          if (flooredStamp) flooredNodes.add(target.nodeId!);
        } else if (target.nodeId) flooredNodes.delete(target.nodeId);
        const receiverStamps = { project: 0, registerOrder: 0, floor: 0 };
        const stampRows = [
          ...raw(expectedAfter, 'project').map(row => ({ table: 'project', kind: 'project', row })),
          ...raw(expectedAfter, 'book_node').map(row => ({ table: 'book_node', kind: 'node', row })),
        ];
        for (const { table, kind, row } of stampRows) {
          const id = String(row.id);
          const key = cell(table, id, 'updated_at');
          const received = String(gateway.database.prepare(`SELECT updated_at FROM ${table} WHERE id=?`).get(id)!.updated_at);
          if (row.updated_at === received) {
            divergent.delete(key);
            continue;
          }
          const registers = fieldRegisters(gateway.database, generation, kind, id);
          assert(registers.length > 0, `Only a field register can hold back ${table} ${id}`);
          const last = registers[registers.length - 1]!.wallMs;
          const newest = Math.max(...registers.map(register => register.wallMs));
          assert.equal(received, new Date(last).toISOString(), 'A receiver ends at the time of the UTF-8-last field register');
          assert(String(row.updated_at) > received, 'Native keeps the newest authored stamp');
          if (table === 'project') {
            assert.equal(last, newest);
            assert.equal(row.updated_at, kvOnlyStamp, 'Only a KV-only update stamps the project locally');
            receiverStamps.project += 1;
          } else if (last < newest) {
            // Native and the renderer keep the newest authored write (floored or not).
            if (flooredNodes.has(id)) assert(Date.parse(String(row.updated_at)) > newest);
            else assert.equal(row.updated_at, new Date(newest).toISOString(), 'Native keeps the newest register time');
            receiverStamps.registerOrder += 1;
          } else {
            assert(flooredNodes.has(id), 'Only a floored status stamp exceeds the newest register');
            assert.equal(Date.parse(String(row.updated_at)) > newest, true);
            receiverStamps.floor += 1;
          }
          divergent.set(key, { native: row.updated_at, receiver: received });
        }
        const adjusted = (db: DatabaseSync, native: boolean, table: string) => canonicalRows(raw(db, table).map(item => {
          const value = { ...item };
          if (table === 'sync_change_set' && originalIds.has(String(value.change_set_id))) {
            assert.equal(value.origin, native ? 'local' : 'remote');
            value.origin = 'compared-original';
          }
          if (table === 'project' || table === 'book_node') {
            for (const column of Object.keys(value)) {
              const expected = divergent.get(cell(table, String(value.id), column));
              if (!expected) continue;
              assert.deepEqual(native ? expected.native : expected.receiver, value[column],
                `Local-only ${table}.${column} of ${String(value.id)} (${native ? 'native' : 'receiver'}, step ${index})`);
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
        assert(Number(remoteWriter[0]!.hlc_wall_ms) >= changeSets[changeSets.length - 1]!.hlc.wallMs);

        // 4. The bridge result equals what the production repositories read
        // back from the native database and (with pinned local-only stamps) the receiver.
        const nativeResult = await repositoryResult(database(step.afterDatabase), path.join(temporary, `result-${index}.db`), fixture, step, syncIdentity);
        assert.deepEqual(nativeResult, step.result, 'Renderer repositories read the native result');
        const stamp = divergent.get(target.nodeId ? cell('book_node', target.nodeId, 'updated_at') : cell('project', fixture.projectId, 'updated_at'));
        const receivedResult = target.nodeId ? await rendererNode(gateway.client(), fixture.projectId, target.nodeId)
          : await rendererProject(gateway.client(), fixture.projectId, (step.result as ProjectResult).userId, syncIdentity);
        assert.deepEqual(receivedResult, stamp ? { ...step.result, updatedAt: stamp.receiver } : step.result,
          'Renderer repositories read the same result (with pinned local-only stamps) from the receiver');
        // 5. Authoritative prose is untouched on both roles.
        const documents = documentIds(expectedAfter).map(id => {
          const state = fullState(expectedAfter, id);
          assert.deepEqual(fullState(gateway.database, id), state);
          assert.deepEqual(fullState(prior, id), state, `${id} is untouched by metadata originals`);
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
        const commandedTable: DomainTable = target.nodeId ? 'book_node' : 'project';
        const commandedKey = target.nodeId ?? fixture.projectId;
        const nonVacuity = {
          original: rejects('a renderer original with a corrupted target', () => {
            const rendered = renderer.changeSets[renderer.changeSets.length - 1]!;
            const corrupted = { ...rendered, mutations: rendered.mutations.map((mutation, i) =>
              i === 0 ? { ...mutation, target: { ...mutation.target, id: `${mutation.target.id}-corrupted` } } : mutation) };
            assert.deepEqual(encodeSyncChangeSetV1(corrupted), originals[originals.length - 1]!.bytes);
          }),
          rendererRow: rejects('a corrupted renderer row', () => {
            const compared = rendererRow(commandedTable, commandedKey);
            assert.deepEqual(normalize({ ...compared.renderer, updated_at: 'corrupted' }), normalize(compared.native));
          }),
          table: rejects('a corrupted receiver table', () => {
            const rows = adjusted(gateway.database, false, commandedTable);
            equalRows(commandedTable, rows.map((row, i) => i === 0 ? { ...row, summary: 'corrupted' } : row), adjusted(expectedAfter, true, commandedTable));
          }),
          result: rejects('a corrupted result', () => {
            assert.deepEqual(nativeResult, { ...structuredClone(step.result), updatedAt: 'corrupted' });
          }),
          // Node steps leave the fact authority alone.
          factAuthority: target.nodeId ? null : rejects('a corrupted fact projection', () => {
            const copy = path.join(temporary, `facts-${index}.db`);
            copyFileSync(database(step.afterDatabase), copy);
            const corrupted = new DatabaseSync(copy);
            try {
              corrupted.prepare("UPDATE entity_kv_entry SET value=value||'corrupted' WHERE rowid=(SELECT MIN(rowid) FROM entity_kv_entry WHERE owner_kind='project')").run();
              verifyFactProjection(corrupted, generation, fixture.projectId);
            } finally { corrupted.close(); }
          }),
        };
        steps.push({ operation: step.operation, target: target.kind,
          originals: originals.map(({ bytes, changeSet }) => ({ sha256: sha(bytes), mutationCount: changeSet.mutations.length,
            actions: changeSet.mutations.map(mutation => mutation.action) })),
          incarnation, kvEntryIds: created.length, orderPlans, localDomainWire: 'passed', rendererAuthority: 'passed', rendererRow: 'passed',
          command: 'passed', result: 'passed', factAuthority: target.nodeId ? null : 'passed', proseOwners: 'unchanged',
          faultRollback: faults, duplicate: 'passed', flooredStamp, receiverStamps,
          pinnedCells: [...new Set([...divergent.keys()].map(key => {
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
  assert.deepEqual(fixture.cases.map(item => item.name), ['metadata-project-and-nodes']);
  mkdirSync(path.dirname(output), { recursive: true });
  const fractionalIndexing = verifyFractionalVectors();
  const cases = [];
  for (const [index, item] of fixture.cases.entries()) cases.push(await verify(item, index));
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', inputSha256: sha(readFileSync(input)), cases,
    roleDifferences, excludedColumns: [], exemptions, localOnlyEffects, rendererDivergences, reducerDefects, fractionalIndexing,
    scope: 'Native project summary/facts/storyline-template updates and chapter/drift summary and writing-status originals match the renderer use cases authored on the same prior state (byte-identical, with native kv-entry IDs replayed), production reducer SQLite effects, the production project and node repositories, the KV authority and its projections. No native remote receive, provider transport or UI acceptance.',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, metadataSteps: cases.reduce((sum, item) => sum + item.steps.length, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
