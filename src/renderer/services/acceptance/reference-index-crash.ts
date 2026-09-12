import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';

import { installHeadlessDatabaseClient } from '../../lib/db';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { BookNodeTable, NodeContentTable, BookElementTable, ElementCategoryTable, StorylineTable, ProjectTable, InlineMentionTable } from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { appendAuthoredYjsUpdate } from '../../sync/journal/yjs-update';
import { createElementPatchWithSync, updateElementPatchWithSync, deleteElementPatchWithSync } from '../../usecase/synced-entity-commands';
import { createReferenceIndexRepository } from '../reference-index-repository';
import { getProjectReferenceIndexSnapshot, retainProjectReferenceIndex, subscribeProjectReferenceIndex } from '../reference-index.service';

type Scenario = 'yjs-edit' | 'yjs-scoped' | 'json-patch' | 'delete-patch';
const NOW = '2026-09-12T00:00:00.000Z';
const PROJECT = 'synthetic-project';
const kinds = ['node', 'element', 'category', 'storyline', 'patch'] as const;
type Gateway = ProductFileBackedSqliteGateway;
type Db = ReturnType<Gateway['client']>;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    item instanceof Uint8Array ? { bytes: Buffer.from(item).toString('hex') } : item)).digest('hex');
}

function json(target: string, seed: number) {
  return { type: 'doc', content: [0, 1].map((index) => ({
    type: 'paragraph', attrs: { id: `block-${index}` }, content: [{
      type: 'text', text: `Synthetic ${seed}-${index}`, marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: `${target}-${index}` } }],
    }],
  })) };
}

function document(target: string, seed: number) {
  const doc = new Y.Doc({ gc: false });
  for (const [index, block] of json(target, seed).content.entries()) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.setAttribute('id', block.attrs.id);
    const text = new Y.XmlText();
    text.insert(0, block.content[0]!.text, { entityLink: block.content[0]!.marks[0]!.attrs });
    paragraph.insert(0, [text]);
    doc.getXmlFragment('default').insert(index, [paragraph]);
  }
  return doc;
}

async function emit(value: unknown): Promise<void> {
  assert(process.send, 'The crash worker requires its parent IPC channel.');
  await new Promise<void>((resolve, reject) => process.send!(value, (error) => error ? reject(error) : resolve()));
}

/** Freeze JS at the exact boundary after writing the small IPC marker. Merely
 * awaiting a never-settled promise lets the queue's timers race the parent's
 * SIGKILL, especially the zero-delay startup timer. The parent enforces a
 * timeout and kills this owned process; no finally/close/checkpoint can run. */
async function hold(value: unknown): Promise<never> {
  assert(process.send);
  process.send(value);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Crash boundary unexpectedly resumed.');
}

function authorHash(gateway: Gateway): string {
  const tables = gateway.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'inline_mention' ORDER BY name")
    .all() as Array<{ name: string }>;
  return digest(tables.map(({ name }) => [name,
    gateway.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map((row) => JSON.stringify(row, (_key, item) => item instanceof Uint8Array ? Array.from(item) : item)).sort(),
  ]));
}

async function semanticRows(db: Db, projectId = PROJECT) {
  const rows = await db.select().from(InlineMentionTable).where(eq(InlineMentionTable.projectId, projectId));
  return rows.map(({ fromKind, fromId, fromBlockId, fromSpansJson, toKind, toId }) => ({
    fromKind, fromId, fromBlockId, fromSpansJson, toKind, toId,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// Independent fixture oracle: compare full span positions/text as well as targets.
function expectedRows(scenario: Scenario, seed: number, authored: boolean) {
  const changedKind = scenario.startsWith('yjs-') ? 'node' : 'patch';
  return kinds.flatMap((kind) => {
    if (authored && scenario === 'delete-patch' && kind === changedKind) return [];
    const target = authored && kind === changedKind ? 'changed' : 'old';
    const fromId = kind === 'patch' ? 'elementPatch' : kind === 'category' ? 'elementCategory' : kind;
    return [0, 1].map((index) => ({ fromKind: kind, fromId, fromBlockId: `block-${index}`,
      fromSpansJson: JSON.stringify([{ from: 0, to: `Synthetic ${seed}-${index}`.length, text: `Synthetic ${seed}-${index}` }]),
      toKind: 'element', toId: `${target}-${index}`,
    }));
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function seedDatabase(db: Db, seed: number): Promise<Y.Doc> {
  const common = { projectId: PROJECT, createdAt: NOW, updatedAt: NOW };
  const body = JSON.stringify(json('old', seed));
  await db.insert(ProjectTable).values({ id: PROJECT, userId: 'synthetic-user', name: 'Synthetic', createdAt: NOW, updatedAt: NOW });
  await db.insert(ProjectTable).values({ id: 'other-project', userId: 'synthetic-user', name: 'Synthetic other', createdAt: NOW, updatedAt: NOW });
  await db.insert(BookNodeTable).values({ ...common, id: 'node', title: 'Synthetic', positionX: 0, positionY: 0 });
  await db.insert(NodeContentTable).values({ nodeId: 'node', contentJson: JSON.stringify(json('stale-cache', seed)), outlineJson: '[]', plotGridJson: '{}', createdAt: NOW, updatedAt: NOW });
  await db.insert(BookElementTable).values({ ...common, id: 'element', name: 'Synthetic', contentJson: body });
  await db.insert(ElementCategoryTable).values({ ...common, id: 'elementCategory', name: 'Synthetic', color: '#000000', contentJson: body });
  await db.insert(StorylineTable).values({ ...common, id: 'storyline', name: 'Synthetic', color: '#000000', orderKey: 0, contentJson: body });
  // Lifecycle deletion requires the same durable incarnation created by the
  // real author command. A bare fixture INSERT would bypass that contract.
  await createElementPatchWithSync({ projectId: PROJECT, id: 'elementPatch', elementId: 'element', contentJson: body });
  const doc = document('old', seed);
  await appendAuthoredYjsUpdate(PROJECT, 'node-content:node', Y.encodeStateAsUpdate(doc));
  await db.insert(InlineMentionTable).values({ id: 'foreign-sentinel', projectId: 'other-project', fromKind: 'node', fromId: 'foreign-node', fromBlockId: 'foreign-block', fromSpansJson: '[]', toKind: 'element', toId: 'foreign-target', createdAt: NOW, updatedAt: NOW });
  await completeRebuild(db);
  assert.deepEqual(await semanticRows(db), expectedRows('yjs-edit', seed, false));
  return doc;
}

async function completeRebuild(db: Db): Promise<void> {
  const repository = createReferenceIndexRepository({ database: db, projectId: PROJECT, isCurrent: () => true });
  const catalog = await repository.captureCatalog();
  assert(catalog);
  assert.notEqual(await repository.pruneOrphanSources(catalog.scope), null);
  for (const source of catalog.sources) {
    const prepared = await repository.prepareSource(catalog.scope, source);
    assert(prepared);
    assert.equal(await repository.replaceSource(prepared), true);
  }
}

async function startRuntime(): Promise<() => void> {
  let release: () => void = () => {};
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); release(); reject(new Error('Project reference startup did not settle.')); }, 10_000);
    const stop = subscribeProjectReferenceIndex(PROJECT, () => {
      const snapshot = getProjectReferenceIndexSnapshot(PROJECT);
      if (snapshot.hasError || snapshot.phase === 'idle') {
        clearTimeout(timeout); stop();
        if (snapshot.hasError) { release(); reject(new Error('Project reference recovery failed.')); }
        else resolve();
      }
    });
    release = retainProjectReferenceIndex(PROJECT);
  });
  return release;
}

export async function runReferenceCrashWorker(args: string[]): Promise<void> {
  const [mode, databasePath, boundary, scenarioText, seedText, restart] = args;
  assert(databasePath && boundary && ['write', 'recover'].includes(mode ?? ''));
  assert(['yjs-edit', 'yjs-scoped', 'json-patch', 'delete-patch'].includes(scenarioText ?? ''));
  const scenario = scenarioText as Scenario;
  const seed = Number(seedText);
  assert(Number.isSafeInteger(seed) && seed > 0);
  const gateway = new ProductFileBackedSqliteGateway(databasePath);
  const db = gateway.client();
  const uninstall = installHeadlessDatabaseClient(db, 'synthetic-reference-crash.db');
  try {
    if (mode === 'write') {
      const doc = await seedDatabase(db, seed);
      if (scenario === 'yjs-scoped') await startRuntime();
      const baselineAuthorHash = authorHash(gateway);
      let stage: 'authored' | 'index' = 'authored';
      let indexedTransaction: string | undefined;
      let observedScopedCatalog = false;
      const ready = () => ({ ready: true, boundary, scenario, seed, baselineAuthorHash, authorHash: authorHash(gateway), observedScopedCatalog });
      const query = gateway.query.bind(gateway);
      gateway.query = async (sql, parameters, transactionId) => {
        const result = await query(sql, parameters, transactionId);
        if (stage === 'index' && sql.includes('count(*)') && sql.includes('"inline_mention"')) {
          observedScopedCatalog = parameters?.includes('node') ?? false;
          if (boundary === 'catalog-captured') await hold(ready());
        }
        return result;
      };
      const execute = gateway.execute.bind(gateway);
      gateway.execute = async (sql, parameters, transactionId) => {
        const result = await execute(sql, parameters, transactionId);
        const sourceId = scenario.startsWith('yjs-') ? 'node' : 'elementPatch';
        if (stage === 'index' && /^(delete from|insert into) "inline_mention"/.test(sql) && parameters?.includes(sourceId)) {
          indexedTransaction = transactionId;
          if (boundary === 'index-after-delete' && sql.startsWith('delete')) await hold(ready());
          if (boundary === 'index-after-insert' && sql.startsWith('insert')) await hold(ready());
        }
        return result;
      };
      const commit = gateway.commit.bind(gateway);
      gateway.commit = async (transactionId) => {
        if (stage === 'authored' && boundary === 'authored-before-commit') await hold(ready());
        await commit(transactionId);
        if (stage === 'authored' && boundary === 'authored-after-commit') await hold(ready());
        if (stage === 'index' && indexedTransaction === transactionId && boundary === 'index-after-commit') await hold(ready());
      };
      if (scenario.startsWith('yjs-')) {
        const vector = Y.encodeStateVector(doc);
        doc.getXmlFragment('default').toArray().forEach((block, index) => {
          const text = (block as Y.XmlElement).get(0) as Y.XmlText;
          text.format(0, text.length, { entityLink: { targetKind: 'element', targetId: `changed-${index}` } });
        });
        await appendAuthoredYjsUpdate(PROJECT, 'node-content:node', Y.encodeStateAsUpdate(doc, vector));
      } else if (scenario === 'json-patch') {
        assert(await updateElementPatchWithSync(PROJECT, 'elementPatch', { contentJson: JSON.stringify(json('changed', seed)) }));
      } else {
        await deleteElementPatchWithSync(PROJECT, 'elementPatch');
      }
      doc.destroy();
      stage = 'index';
      if (boundary === 'queue-waiting') {
        if (scenario !== 'yjs-scoped') retainProjectReferenceIndex(PROJECT);
        assert.equal(getProjectReferenceIndexSnapshot(PROJECT).phase, 'waiting');
        await hold(ready());
      }
      const release = await startRuntime();
      if (boundary === 'queue-acknowledged') await hold(ready());
      release();
      throw new Error(`Crash boundary was not reached: ${boundary}`);
    }

    const beforeAuthorHash = authorHash(gateway);
    const beforeRows = await semanticRows(db);
    const foreignRows = await db.select().from(InlineMentionTable).where(eq(InlineMentionTable.projectId, 'other-project'));
    assert.equal(foreignRows.length, 1);
    const authored = boundary !== 'authored-before-commit';
    // Prior uncommitted deletes/inserts must be invisible after opening the WAL.
    if (restart === '1' && !['index-after-commit', 'queue-acknowledged'].includes(boundary)) {
      assert.deepEqual(beforeRows, expectedRows(scenario, seed, false));
    }
    const release = await startRuntime();
    const recovered = await semanticRows(db);
    assert.deepEqual(recovered, expectedRows(scenario, seed, authored));
    assert.equal(authorHash(gateway), beforeAuthorHash);
    release();
    // Compare the runtime restart to a separate uncached full rebuild.
    await completeRebuild(db);
    assert.deepEqual(await semanticRows(db), recovered);
    assert.equal(authorHash(gateway), beforeAuthorHash);
    assert.deepEqual(await db.select().from(InlineMentionTable).where(eq(InlineMentionTable.projectId, 'other-project')), foreignRows);
    assert.deepEqual(gateway.database.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok']);
    assert.deepEqual(gateway.database.prepare('PRAGMA foreign_key_check').all(), []);
    const nodeRevision = await createYjsRepository(db).getRevision('node-content:node');
    assert.equal(nodeRevision, scenario.startsWith('yjs-') && authored ? 2 : 1);
    await emit({ recovered: true, boundary, scenario, seed, authorHash: beforeAuthorHash,
      projectionHash: digest(recovered), referenceRows: recovered.length, nodeRevision,
      checks: ['fixture-span-oracle', 'uncached-full-rebuild', 'author-state-unchanged', 'project-isolation', 'integrity', 'foreign-keys', 'revision'],
    });
  } finally {
    uninstall();
    await gateway.close();
  }
}
