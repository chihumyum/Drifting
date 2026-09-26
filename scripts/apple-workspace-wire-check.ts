import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import * as Y from 'yjs';

import { defaultProjectKvList } from '../src/renderer/domain/kv';
import { deriveActSegments, type BookAct } from '../src/renderer/domain/book-act';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  BookNodeTable, EntityKvEntryTable, EntityRelationTypeTable, NodeStorylineLinkTable, ProjectTable,
  SyncFieldClockTable, SyncGenerationTable, yjsUpdates,
} from '../src/renderer/schema/drizzle';
import { decodeSyncChangeSetV1, encodeSyncChangeSetV1 } from '../src/renderer/sync/protocol/change-set';
import { parseYjsUpdatePayload } from '../src/renderer/sync/protocol/yjs-update-payload';
import { productionSyncDomainMaterializationKernel } from '../src/renderer/sync/reducer/production-domain-kernel';
import { applyVerifiedRemoteChangeSetInTransaction, invalidateSqliteReducerStateCache } from '../src/renderer/sync/reducer/sqlite-materializer';

const option = (name: string) => {
  const value = process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  assert(value, `${name} is required`);
  return value;
};
const input = option('--input');
const output = option('--output');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Chapter { id: string; projectId: string; title: string; bookOrder: number; documentId: string }
interface WorkspaceWire {
  schemaVersion: number;
  project: { id: string; name: string };
  chapters: Chapter[];
  changes: { encodedBase64: string; mutationCount: number }[];
  fieldClocks?: Record<string, string | number>[];
  moves?: { changeSetIndex: number; chapterId: string; beforeChapterId: string | null; chapters: { id: string; bookOrder: number }[] }[];
}

async function verify(fixturePath: string, scenario: 'creation' | 'rename' | 'reorder') {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as WorkspaceWire;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.chapters.length, scenario === 'reorder' ? 3 : 2);
  assert.equal(fixture.changes.length, scenario === 'creation' ? 3 : 7);
  const changes = await Promise.all(fixture.changes.map(async row => {
    const bytes = new Uint8Array(Buffer.from(row.encodedBase64, 'base64'));
    const decoded = await decodeSyncChangeSetV1(bytes);
    assert(decoded.ok, JSON.stringify(decoded));
    assert.deepEqual(encodeSyncChangeSetV1(decoded.value), bytes, 'Rust journal is not canonical production CBOR');
    assert.equal(decoded.value.mutations.length, row.mutationCount);
    assert.equal(decoded.value.projectId, fixture.project.id);
    return decoded.value;
  }));
  const first = changes[0]!;
  const nowIso = '2026-09-26T00:00:00.000Z';
  const gateway = new ProductFileBackedSqliteGateway(path.join(path.dirname(output), `workspace-${scenario}-receiver.db`));
  const db = gateway.client();
  try {
    // The remote import establishes a local project/catalog identity before
    // domain replay. All domain facts below must come from the Rust originals.
    await db.insert(ProjectTable).values({ id: fixture.project.id, userId: 'workspace-wire-receiver', name: 'Import placeholder', createdAt: nowIso, updatedAt: nowIso });
    await db.insert(SyncGenerationTable).values({ syncGenerationId: first.syncGenerationId, projectId: first.projectId, projectSyncId: first.projectSyncId, createdAt: nowIso, updatedAt: nowIso });
    const cases = [];
    let orderTransitions = 0;
    for (const [index, changeSet] of changes.entries()) {
      const result = await db.transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet,
        identity: { installationId: 'workspace-wire-receiver', createWriterIdentity: () => ({ writerId: 'workspace-wire-receiver', writerEpoch: 'epoch-1' }) },
        clock: { nowMs: 1_790_380_800_000, nowIso },
        kernel: productionSyncDomainMaterializationKernel,
      }));
      assert.equal(result.status, 'applied');
      assert.deepEqual(result.conflicts, [], 'Workspace journal must materialize without suppressed facts');
      for (const mutation of changeSet.mutations.filter(mutation => mutation.action === 'yjs.update')) {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, parseYjsUpdatePayload(mutation.payload).update);
          assert(doc.getXmlFragment('default').length > 0, 'A new chapter needs an editable paragraph');
        } finally { doc.destroy(); }
      }
      const move = fixture.moves?.find(step => step.changeSetIndex === index);
      if (move) {
        assert.equal(changeSet.mutations.length, 1, 'Reorder must only author the moved chapter coordinate');
        const [mutation] = changeSet.mutations;
        assert.equal(mutation?.action, 'field.set');
        assert.equal(mutation?.target.id, move.chapterId);
        const order = await db.select({ id: BookNodeTable.id, bookOrder: BookNodeTable.bookOrder })
          .from(BookNodeTable).where(eq(BookNodeTable.projectId, fixture.project.id))
          .orderBy(asc(BookNodeTable.bookOrder), asc(BookNodeTable.id));
        assert.deepEqual(order, move.chapters, 'Production replay must match each committed native order');
        const position = order.findIndex(chapter => chapter.id === move.chapterId);
        assert(position >= 0);
        assert.equal(order[position + 1]?.id ?? null, move.beforeChapterId);
        orderTransitions += 1;
      }
      cases.push({ changeSetId: changeSet.changeSetId, mutationCount: changeSet.mutations.length, envelopeSha256: sha256(encodeSyncChangeSetV1(changeSet)), status: 'passed' });
    }
    const [project] = await db.select().from(ProjectTable).where(eq(ProjectTable.id, fixture.project.id));
    assert.equal(project?.name, fixture.project.name);
    const facts = await db.select().from(EntityKvEntryTable).where(eq(EntityKvEntryTable.projectId, fixture.project.id));
    assert.deepEqual(facts.map(({ key, value }) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)), defaultProjectKvList().sort((a, b) => a.key.localeCompare(b.key)));
    assert(facts.every(fact => fact.ownerKind === 'project' && fact.ownerId === fixture.project.id && fact.namespace === 'facts'));
    const relations = await db.select().from(EntityRelationTypeTable).where(eq(EntityRelationTypeTable.projectId, fixture.project.id));
    assert.equal(relations.length, 1);
    assert.equal(relations[0]?.systemKey, 'generic-association');
    assert.equal(relations[0]?.locked, true);
    const chapters = await db.select().from(BookNodeTable).where(eq(BookNodeTable.projectId, fixture.project.id));
    assert.equal(chapters.length, fixture.chapters.length);
    for (const expected of fixture.chapters) {
      const actual = chapters.find(chapter => chapter.id === expected.id);
      assert(actual);
      assert.equal(actual.title, expected.title);
      assert.equal(actual.bookOrder, expected.bookOrder);
      assert.equal(actual.kind, 'chapter');
      assert.equal(actual.writingStatus, 'draft');
      const memberships = await db.select().from(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.nodeId, expected.id));
      assert.equal(memberships.length, 0);
      assert.equal(actual.narrativeOrder, null);
      assert.equal(actual.driftGroupId, null);
      const updates = await db.select().from(yjsUpdates).where(eq(yjsUpdates.docId, expected.documentId));
      assert.equal(updates.length, 1);
    }
    let fieldClocks = 0;
    if (scenario !== 'creation') {
      assert(fixture.fieldClocks, 'Metadata fixture must export actual SQLite field clocks');
      const actual = (await db.select().from(SyncFieldClockTable)).map(row => ({
        sync_generation_id: row.syncGenerationId, target_kind: row.targetKind, target_id: row.targetId,
        incarnation: row.incarnation, field_key: row.fieldKey, hlc_wall_ms: row.hlcWallMs,
        hlc_counter: row.hlcCounter, writer_id: row.writerId, writer_epoch: row.writerEpoch,
        device_seq: row.deviceSeq, change_set_id: row.changeSetId, mutation_index: row.mutationIndex,
      }));
      const key = (row: Record<string, string | number>) => JSON.stringify([row.target_kind, row.target_id, row.incarnation, row.field_key]);
      const order = (a: Record<string, string | number>, b: Record<string, string | number>) => key(a).localeCompare(key(b));
      assert.deepEqual(actual.sort(order), fixture.fieldClocks.sort(order), 'Rust and production renderer field clocks differ');
      fieldClocks = actual.length;
      assert.equal(fieldClocks, scenario === 'rename' ? 4 : 5);
    }
    assert.equal(orderTransitions, scenario === 'reorder' ? 3 : 0);
    return { status: 'passed', cases, projectDefaults: facts.length, chapters: chapters.length, fieldClocks, orderTransitions };
  } finally {
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}
async function main() {
  const creation = await verify(input, 'creation');
  const rename = await verify(path.join(path.dirname(input), 'workspace-rename-wire.json'), 'rename');
  const reorder = await verify(path.join(path.dirname(input), 'workspace-reorder-wire.json'), 'reorder');
  const outline = verifyOutline();
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, ...creation, rename, reorder, outline,
    scope: 'Actual Rust creation, rename and reorder journals decoded and materialized by production renderer on fresh file-backed databases, including exact field clocks and each ordered chapter list; no live synchronization or UI claim',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', creationChanges: creation.cases.length, renameChanges: rename.cases.length, reorderChanges: reorder.cases.length, orderTransitions: reorder.orderTransitions }));
}

function verifyOutline() {
  const fixture = JSON.parse(readFileSync(path.join(path.dirname(input), 'workspace-outline.json'), 'utf8')) as {
    schemaVersion: number;
    scenarios: { name: string; acts: BookAct[]; chapters: { id: string; title: string; bookOrder: number }[];
      rows: { kind: string; id: string; title: string; actId: string | null }[] }[];
  };
  assert.equal(fixture.schemaVersion, 1);
  assert(fixture.scenarios.length >= 2);
  const cases = fixture.scenarios.map(({ name, acts, chapters, rows }) => {
    const ordered = [...chapters].sort((a, b) => a.bookOrder - b.bookOrder || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
    const segments = deriveActSegments(acts, ordered);
    const assigned = new Set(segments.flatMap(segment => segment.chapters.map(chapter => chapter.id)));
    const chapterRow = (chapter: typeof chapters[number], actId: string | null) => ({ kind: 'chapter', id: chapter.id, title: chapter.title, actId });
    const expected = ordered.filter(chapter => !assigned.has(chapter.id)).map(chapter => chapterRow(chapter, null));
    for (const segment of segments) {
      expected.push({ kind: 'act', id: segment.act.id, title: segment.act.name, actId: null });
      expected.push(...segment.chapters.map(chapter => chapterRow(chapter, segment.act.id)));
    }
    assert.deepEqual(rows, expected, `Native outline differs from production act boundaries: ${name}`);
    return { name, status: 'passed', acts: acts.length, chapters: chapters.length };
  });
  return { status: 'passed', cases };
}
main().catch(error => { console.error(error); process.exitCode = 1; });
