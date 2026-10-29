import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbClient } from '../../lib/db';
import { YjsDocumentRevisionTable, yjsSnapshots } from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { applyToStoredYjsDocument } from './yjs-validation-documents';

const DOC_ID = 'node-content:validation-cache-node';
const temporaryDirectories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDatabase(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-yjs-validation-'));
  temporaryDirectories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  return gateway.client();
}

/** A seed state plus a few later keystroke updates of one prose document. */
function proseHistory(): { seed: Uint8Array; updates: Uint8Array[] } {
  const doc = new Y.Doc();
  const text = new Y.XmlText();
  doc.getXmlFragment('default').insert(0, [text]);
  text.insert(0, 'The lighthouse');
  const seed = Y.encodeStateAsUpdate(doc);
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  for (const character of ' keeper wrote.') text.insert(text.length, character);
  return { seed, updates };
}

/** One authored keystroke: the row is appended before the reducer checks it. */
async function authoredCheck(db: DbClient, update: Uint8Array, abort = false): Promise<void> {
  await db.transaction(async (tx) => {
    await createYjsRepository(tx).appendUpdate(DOC_ID, update);
    await applyToStoredYjsDocument(tx, DOC_ID, update);
    if (abort) throw new Error('rolled back on purpose');
  });
}

/** Garbage of the same length; Yjs throws when it has to decode it. */
async function corruptSnapshotInPlace(db: DbClient): Promise<void> {
  const [row] = await db.select({ bytes: sql<number>`length(${yjsSnapshots.stateBlob})` }).from(yjsSnapshots);
  await db.update(yjsSnapshots)
    .set({ stateBlob: new Uint8Array(row!.bytes).fill(255) })
    .where(eq(yjsSnapshots.docId, DOC_ID));
}

describe('stored Yjs documents for update validation', () => {
  it('keeps a committed document and reads only the rows appended after it', async () => {
    const db = await createDatabase();
    const { seed, updates } = proseHistory();
    await createYjsRepository(db).upsertSnapshot(DOC_ID, seed);
    await authoredCheck(db, updates[0]!);
    await corruptSnapshotInPlace(db);

    // The kept document never rereads the snapshot.
    await expect(authoredCheck(db, updates[1]!)).resolves.toBeUndefined();
    await expect(authoredCheck(db, updates[2]!)).resolves.toBeUndefined();
    // Outside a transaction nothing is kept, so the corrupt snapshot is read.
    await expect(applyToStoredYjsDocument(db, DOC_ID, updates[3]!)).rejects.toThrow();
  });

  it('drops the document when its transaction rolls back', async () => {
    const db = await createDatabase();
    const { seed, updates } = proseHistory();
    await createYjsRepository(db).upsertSnapshot(DOC_ID, seed);
    await authoredCheck(db, updates[0]!);
    await expect(authoredCheck(db, updates[1]!, true)).rejects.toThrow('rolled back on purpose');
    await corruptSnapshotInPlace(db);

    await expect(authoredCheck(db, updates[2]!)).rejects.toThrow();
  });

  it('does not keep an update that is not a stored row yet', async () => {
    const db = await createDatabase();
    const { seed, updates } = proseHistory();
    await createYjsRepository(db).upsertSnapshot(DOC_ID, seed);
    await authoredCheck(db, updates[0]!);
    // A remote update is checked before the kernel appends its row.
    await db.transaction((tx) => applyToStoredYjsDocument(tx, DOC_ID, updates[1]!));
    await corruptSnapshotInPlace(db);

    await expect(authoredCheck(db, updates[2]!)).rejects.toThrow();
  });

  it('rebuilds when the snapshot or the revision moved without a new row', async () => {
    const replaced = await createDatabase();
    const first = proseHistory();
    await createYjsRepository(replaced).upsertSnapshot(DOC_ID, first.seed);
    await authoredCheck(replaced, first.updates[0]!);
    await createYjsRepository(replaced).upsertSnapshot(DOC_ID, Uint8Array.of(255, 255, 255));
    await expect(authoredCheck(replaced, first.updates[1]!)).rejects.toThrow();

    const advanced = await createDatabase();
    const second = proseHistory();
    await createYjsRepository(advanced).upsertSnapshot(DOC_ID, second.seed);
    await authoredCheck(advanced, second.updates[0]!);
    await corruptSnapshotInPlace(advanced);
    await advanced.update(YjsDocumentRevisionTable)
      .set({ revision: sql`${YjsDocumentRevisionTable.revision} + 1` })
      .where(eq(YjsDocumentRevisionTable.docId, DOC_ID));
    await expect(authoredCheck(advanced, second.updates[1]!)).rejects.toThrow();
  });

  it('never lends one database\'s document to another', async () => {
    const { seed, updates } = proseHistory();
    const original = await createDatabase();
    await createYjsRepository(original).upsertSnapshot(DOC_ID, seed);
    await authoredCheck(original, updates[0]!);

    // Same document id, snapshot timestamp, length, rows and revision.
    const [snapshot] = await original.select().from(yjsSnapshots);
    const copy = await createDatabase();
    await copy.insert(yjsSnapshots).values({
      docId: DOC_ID,
      stateBlob: new Uint8Array((snapshot!.stateBlob as Uint8Array).byteLength).fill(255),
      updatedAt: snapshot!.updatedAt,
    });
    await createYjsRepository(copy).appendUpdate(DOC_ID, updates[0]!);
    const [revision] = await original.select().from(YjsDocumentRevisionTable);
    await copy.update(YjsDocumentRevisionTable)
      .set({ revision: revision!.revision })
      .where(eq(YjsDocumentRevisionTable.docId, DOC_ID));
    await expect(authoredCheck(copy, updates[1]!)).rejects.toThrow();
  });
});
