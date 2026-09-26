import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';

import { defaultProjectKvList } from '../src/renderer/domain/kv';
import { ProductFileBackedSqliteGateway } from '../src/renderer/lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  BookNodeTable, EntityKvEntryTable, EntityRelationTypeTable, NodeStorylineLinkTable, ProjectTable,
  SyncGenerationTable, yjsUpdates,
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
}

async function main() {
  const fixture = JSON.parse(readFileSync(input, 'utf8')) as WorkspaceWire;
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.chapters.length, 2);
  assert.equal(fixture.changes.length, 3);
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
  const gateway = new ProductFileBackedSqliteGateway(path.join(path.dirname(output), 'workspace-receiver.db'));
  const db = gateway.client();
  try {
    // The remote import establishes a local project/catalog identity before
    // domain replay. All domain facts below must come from the Rust originals.
    await db.insert(ProjectTable).values({ id: fixture.project.id, userId: 'workspace-wire-receiver', name: 'Import placeholder', createdAt: nowIso, updatedAt: nowIso });
    await db.insert(SyncGenerationTable).values({ syncGenerationId: first.syncGenerationId, projectId: first.projectId, projectSyncId: first.projectSyncId, createdAt: nowIso, updatedAt: nowIso });
    const cases = [];
    for (const changeSet of changes) {
      const result = await db.transaction(tx => applyVerifiedRemoteChangeSetInTransaction(tx, {
        changeSet,
        identity: { installationId: 'workspace-wire-receiver', createWriterIdentity: () => ({ writerId: 'workspace-wire-receiver', writerEpoch: 'epoch-1' }) },
        clock: { nowMs: 1_790_380_800_000, nowIso },
        kernel: productionSyncDomainMaterializationKernel,
      }));
      assert.equal(result.status, 'applied');
      assert.deepEqual(result.conflicts, [], 'Creation journal must materialize without suppressed facts');
      for (const mutation of changeSet.mutations.filter(mutation => mutation.action === 'yjs.update')) {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, parseYjsUpdatePayload(mutation.payload).update);
          assert(doc.getXmlFragment('default').length > 0, 'A new chapter needs an editable paragraph');
        } finally { doc.destroy(); }
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
    assert.equal(chapters.length, 2);
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
    writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, status: 'passed', cases, projectDefaults: facts.length, chapters: chapters.length, scope: 'Actual Rust creation journals decoded and materialized by production renderer on a fresh file-backed database; no live synchronization or UI claim' }, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', changes: cases.length, projectDefaults: facts.length, chapters: chapters.length }));
  } finally {
    invalidateSqliteReducerStateCache();
    await gateway.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
