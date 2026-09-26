import { observeLocalAuthoredReducerInTransaction } from '../reducer/sqlite-materializer';
import { productionSyncDomainMaterializationKernel } from '../reducer/production-domain-kernel';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { appendAuthoredDomainMutation } from './domain-mutation';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import type { DbExecutor } from '../../lib/db';
import {
  ProjectTable,
  BookNodeTable,
  SyncYjsMaterializationReceiptTable,
} from '../../schema/drizzle';
import {
  createYjsRepository,
  readMaterializationAppend,
  type YjsMaterializationToken,
} from '../../sqlite-repo/yjs-repo';
import { insertYjsMaterializationReceiptInTransaction } from '../../sqlite-repo/yjs-materialization-receipt-repo';
import { createAuthoredTransactionRunner } from './authored-transaction';
import { SyncChangeBuilder } from './change-builder';
import { registerAuthoredYjsMaterialization } from './yjs-materialization';
import {
  appendAuthoredProseSeedInTransaction,
  appendAuthoredProseRestoreStateInTransaction,
  appendYjsUpdateMutation,
  createAuthoredYjsUpdateWriter,
} from './yjs-update';
const NOW = '2026-09-26T00:00:00.000Z',
  PROJECT = 'synthetic-admission',
  DOC = 'node-content:synthetic-node';
const resources: Array<{ directory: string; gateway: ProductFileBackedSqliteGateway }> = [];
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-positive-admission-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  resources.push({ directory, gateway });
  const db = gateway.client();
  await db.insert(ProjectTable).values({
    id: PROJECT,
    userId: 'local-user',
    name: 'Synthetic admission',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(BookNodeTable).values({
    id: 'synthetic-node',
    projectId: PROJECT,
    title: 'Synthetic',
    summary: '',
    kind: 'chapter',
    writingStatus: 'draft',
    positionX: 0,
    positionY: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const deps = {
    database: () => db,
    identity: async () => ({
      installationId: 'admission-install',
      createWriterIdentity: () => ({
        writerId: 'admission-writer',
        writerEpoch: 'admission-epoch',
      }),
    }),
    clock: () => ({ nowMs: Date.parse(NOW), nowIso: NOW }),
    syncGenerationIds: {
      createSyncGenerationId: () => 'admission-generation',
      createProjectSyncId: () => 'admission-project-sync',
    },
  };
  const runner = createAuthoredTransactionRunner(deps),
    writer = createAuthoredYjsUpdateWriter(runner);
  return { gateway, db, runner, writer, deps };
}
function state() {
  const doc = new Y.Doc();
  doc.clientID = 914;
  doc.getText('body').insert(0, '中文🙂');
  const value = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return value;
}
function allTables(g: ProductFileBackedSqliteGateway) {
  return (
    g.database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => ({ name, rows: g.database.prepare(`SELECT * FROM "${name}"`).all() }));
}
afterEach(async () => {
  for (const { gateway, directory } of resources.splice(0)) {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
describe('positive Yjs materialization admission', () => {
  it('records stable indices and historical revisions for two actual local appends in one normalized envelope', async () => {
    const { db, runner } = await setup();
    const update = state();
    await runner(PROJECT, 'yjs.update', async ({ tx, changes }) => {
      await appendAuthoredProseSeedInTransaction(tx, changes, {
        entityType: 'node',
        entityId: 'synthetic-node',
        stateUpdate: update,
      });
      await appendAuthoredProseRestoreStateInTransaction(tx, changes, {
        entityType: 'node',
        entityId: 'synthetic-node',
        stateUpdate: update,
      });
    });
    const rows = await db.select().from(SyncYjsMaterializationReceiptTable);
    expect(
      rows.map((r) => [r.mutationIndex, r.updateRowId, r.documentRevision, r.incarnation]),
    ).toEqual([
      [0, 1, 1, 0],
      [1, 2, 2, 0],
    ]);
    expect(rows[0]!.changeSetId).toBe(rows[1]!.changeSetId);
    expect(rows[0]!.eventSha256).toBe(rows[1]!.eventSha256);
  });
  it('does not backfill admission for an arbitrary journal mutation with existing identical raw bytes', async () => {
    const { db, runner } = await setup();
    const update = state();
    await createYjsRepository(db).appendUpdate(DOC, update, { kind: 'remote' });
    await runner(PROJECT, 'yjs.update', async ({ changes }) => {
      appendYjsUpdateMutation(changes, DOC, update);
    });
    expect(await db.select().from(SyncYjsMaterializationReceiptTable)).toEqual([]);
  });
  it('rejects forged old-row registration and cross-builder or wrong-index tokens', async () => {
    const { db } = await setup();
    const update = state();
    await db.transaction(async (tx) => {
      const builder = new SyncChangeBuilder();
      const index = appendYjsUpdateMutation(builder, DOC, update);
      const id = await createYjsRepository(tx).appendUpdate(DOC, update, { kind: 'user' });
      expect(() =>
        registerAuthoredYjsMaterialization(tx, builder, index, {
          docId: DOC,
          updateId: id,
          revision: 1,
        } as unknown as YjsMaterializationToken),
      ).toThrow(/token/);
      const result = await createYjsRepository(tx).appendMaterializedUpdate(
        DOC,
        update,
        { kind: 'authored', builder, mutationIndex: index },
        { kind: 'user' },
      );
      expect(() =>
        registerAuthoredYjsMaterialization(tx, new SyncChangeBuilder(), index, result.token),
      ).toThrow(/token/);
      expect(() =>
        registerAuthoredYjsMaterialization(tx, builder, index + 1, result.token),
      ).toThrow(/token/);
      await tx.transaction(async (nested) => {
        expect(() =>
          readMaterializationAppend(nested, result.token, {
            kind: 'authored',
            builder,
            mutationIndex: index,
          }),
        ).toThrow(/token/);
      });
      registerAuthoredYjsMaterialization(tx, builder, index, result.token);
      expect(() => registerAuthoredYjsMaterialization(tx, builder, index, result.token)).toThrow(
        /Duplicate/,
      );
    });
    expect(await db.select().from(SyncYjsMaterializationReceiptTable)).toEqual([]);
  });
  it('refuses tokens after commit and rollback even when the rolled-back row ID is reused', async () => {
    const { db } = await setup();
    const binding = { kind: 'remote' as const, changeSetId: 'bound-original', mutationIndex: 0 };
    let oldTx!: DbExecutor, token!: YjsMaterializationToken;
    await expect(
      db.transaction(async (tx) => {
        oldTx = tx;
        token = (
          await createYjsRepository(tx).appendMaterializedUpdate(DOC, state(), binding, {
            kind: 'remote',
          })
        ).token;
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(() => readMaterializationAppend(oldTx, token, binding)).toThrow(
      /active bound transaction/,
    );
    await db.transaction(async (tx) => {
      const fresh = await createYjsRepository(tx).appendMaterializedUpdate(DOC, state(), binding, {
        kind: 'remote',
      });
      expect(fresh.updateId).toBe(1);
      expect(() => readMaterializationAppend(tx, token, binding)).toThrow(/token/);
      oldTx = tx;
      token = fresh.token;
    });
    expect(() => readMaterializationAppend(oldTx, token, binding)).toThrow(
      /active bound transaction/,
    );
  });
  it('never rebinds a fresh state-carrier token to a same-bytes suppressed command', async () => {
    const { db } = await setup();
    await db.transaction(async (tx) => {
      const binding = {
        kind: 'remote' as const,
        changeSetId: 'actual-state-carrier',
        mutationIndex: 0,
      };
      const result = await createYjsRepository(tx).appendMaterializedUpdate(DOC, state(), binding, {
        kind: 'remote',
      });
      await expect(
        insertYjsMaterializationReceiptInTransaction(tx, {
          changeSetId: 'suppressed-command',
          mutationIndex: 0,
          token: result.token,
          binding: { ...binding, changeSetId: 'suppressed-command' },
          createdAt: NOW,
        }),
      ).rejects.toThrow(/token/);
      await expect(
        insertYjsMaterializationReceiptInTransaction(tx, {
          changeSetId: 'suppressed-command',
          mutationIndex: 0,
          token: result.token,
          binding,
          createdAt: NOW,
        }),
      ).rejects.toThrow(/original differs/);
    });
    expect(await db.select().from(SyncYjsMaterializationReceiptTable)).toEqual([]);
  });
  it('rolls all tables back on admission failure and retries at sequence and revision one', async () => {
    const { gateway, db, writer } = await setup();
    const before = allTables(gateway);
    let observed = false;
    gateway.failNextExecute((sql) => {
      if (!/insert into "sync_yjs_materialization_receipt"/iu.test(sql)) return false;
      observed = true;
      expect(gateway.database.prepare('SELECT count(*) n FROM yjs_updates').get()!.n).toBe(1);
      expect(gateway.database.prepare('SELECT count(*) n FROM sync_mutation').get()!.n).toBe(1);
      return true;
    }, 'synthetic admission insert failure');
    await expect(writer(PROJECT, DOC, state())).rejects.toThrow();
    expect(observed).toBe(true);
    expect(allTables(gateway)).toEqual(before);
    await writer(PROJECT, DOC, state());
    const [receipt] = await db.select().from(SyncYjsMaterializationReceiptTable);
    expect(receipt).toMatchObject({
      updateRowId: 1,
      documentRevision: 1,
      changeSetId: 'admission-writer:admission-epoch:1',
    });
  });
  it('rolls the complete batch back when its second receipt fails and retries both appends', async () => {
    const { gateway, db, runner } = await setup();
    const before = allTables(gateway);
    const update = state();
    const appendBoth = () =>
      runner(PROJECT, 'yjs.update', async ({ tx, changes }) => {
        await appendAuthoredProseSeedInTransaction(tx, changes, {
          entityType: 'node',
          entityId: 'synthetic-node',
          stateUpdate: update,
        });
        await appendAuthoredProseRestoreStateInTransaction(tx, changes, {
          entityType: 'node',
          entityId: 'synthetic-node',
          stateUpdate: update,
        });
      });
    let receiptInserts = 0;
    gateway.failNextExecute((sql) => {
      if (!/insert into "sync_yjs_materialization_receipt"/iu.test(sql)) return false;
      if (++receiptInserts !== 2) return false;
      expect(gateway.database.prepare('SELECT count(*) n FROM yjs_updates').get()!.n).toBe(2);
      expect(gateway.database.prepare('SELECT count(*) n FROM sync_change_set').get()!.n).toBe(1);
      expect(gateway.database.prepare('SELECT count(*) n FROM sync_mutation').get()!.n).toBe(2);
      expect(
        gateway.database.prepare('SELECT count(*) n FROM sync_yjs_materialization_receipt').get()!
          .n,
      ).toBe(1);
      return true;
    }, 'synthetic second admission insert failure');

    await expect(appendBoth()).rejects.toThrow();
    expect(receiptInserts).toBe(2);
    expect(allTables(gateway)).toEqual(before);
    await appendBoth();
    const receipts = await db.select().from(SyncYjsMaterializationReceiptTable);
    expect(receipts).toMatchObject([
      {
        changeSetId: 'admission-writer:admission-epoch:1',
        mutationIndex: 0,
        updateRowId: 1,
        documentRevision: 1,
      },
      {
        changeSetId: 'admission-writer:admission-epoch:1',
        mutationIndex: 1,
        updateRowId: 2,
        documentRevision: 2,
      },
    ]);
  });
  it('rolls admission back when post-journal authored observation fails', async () => {
    const { gateway, deps, writer } = await setup();
    const before = allTables(gateway);
    const failing = createAuthoredYjsUpdateWriter(
      createAuthoredTransactionRunner({
        ...deps,
        observeAuthored: async () => {
          expect(
            gateway.database
              .prepare('SELECT count(*) n FROM sync_yjs_materialization_receipt')
              .get()!.n,
          ).toBe(1);
          throw new Error('observe failed');
        },
      }),
    );
    await expect(failing(PROJECT, DOC, state())).rejects.toThrow('observe failed');
    expect(allTables(gateway)).toEqual(before);
    await writer(PROJECT, DOC, state());
  });
  it('retains immutable admission after actual snapshot and raw pruning', async () => {
    const { gateway, db, writer } = await setup();
    const update = state();
    const result = await writer(PROJECT, DOC, update);
    const before = await db.select().from(SyncYjsMaterializationReceiptTable);
    await db.transaction(async (tx) => {
      const repo = createYjsRepository(tx);
      await repo.upsertSnapshot(DOC, update, { advanceRevision: false });
      expect(await repo.deleteUpdatesUpTo(DOC, result.updateId)).toBe(1);
    });
    expect(await db.select().from(SyncYjsMaterializationReceiptTable)).toEqual(before);
    expect(() =>
      gateway.database.exec("UPDATE sync_yjs_materialization_receipt SET created_at='changed'"),
    ).toThrow();
    expect(() => gateway.database.exec('DELETE FROM sync_yjs_materialization_receipt')).toThrow();
  });
  it('gives identical bytes in independent authored originals independent row IDs and admissions', async () => {
    const { db, writer } = await setup();
    const update = state();
    await writer(PROJECT, DOC, update);
    await writer(PROJECT, DOC, update);
    const rows = await db.select().from(SyncYjsMaterializationReceiptTable);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.changeSetId).not.toBe(rows[1]!.changeSetId);
    expect(rows[0]!.updateRowId).not.toBe(rows[1]!.updateRowId);
    expect(rows[0]!.eventSha256).toBe(rows[1]!.eventSha256);
  });
  it('seals an authored append only to its newly inserted original and rejects an old identical unadmitted original', async () => {
    const { db, runner, deps } = await setup();
    const update = state();
    await runner(PROJECT, 'yjs.update', async ({ changes }) => {
      appendYjsUpdateMutation(changes, DOC, update);
    });
    const oldId = 'admission-writer:admission-epoch:1';
    let token!: YjsMaterializationToken, builder!: SyncChangeBuilder;
    const boundRunner = createAuthoredTransactionRunner({
      ...deps,
      observeAuthored: async (tx, input) => {
        await expect(
          insertYjsMaterializationReceiptInTransaction(tx, {
            changeSetId: oldId,
            mutationIndex: 0,
            token,
            binding: { kind: 'authored', builder, mutationIndex: 0 },
            createdAt: NOW,
          }),
        ).rejects.toThrow(/rebound/);
        await insertYjsMaterializationReceiptInTransaction(tx, {
          changeSetId: 'admission-writer:admission-epoch:2',
          mutationIndex: 0,
          token,
          binding: { kind: 'authored', builder, mutationIndex: 0 },
          createdAt: NOW,
        });
        return observeLocalAuthoredReducerInTransaction(tx, {
          ...input,
          validator: productionSyncDomainMaterializationKernel,
        });
      },
    });
    await boundRunner(PROJECT, 'yjs.update', async ({ tx, changes }) => {
      builder = changes;
      appendYjsUpdateMutation(changes, DOC, update);
      token = (
        await createYjsRepository(tx).appendMaterializedUpdate(
          DOC,
          update,
          { kind: 'authored', builder, mutationIndex: 0 },
          { kind: 'user' },
        )
      ).token;
      await expect(
        insertYjsMaterializationReceiptInTransaction(tx, {
          changeSetId: oldId,
          mutationIndex: 0,
          token,
          binding: { kind: 'authored', builder, mutationIndex: 0 },
          createdAt: NOW,
        }),
      ).rejects.toThrow(/newly inserted original/);
    });
    expect(await db.select().from(SyncYjsMaterializationReceiptTable)).toMatchObject([
      { changeSetId: 'admission-writer:admission-epoch:2', updateRowId: 1 },
    ]);
  });

  it('uses the final restored incarnation rather than the provisional prose target zero', async () => {
    const { db, runner } = await setup();
    const update = await createYjsProseSeedState(
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '复原🙂' }] }],
      }),
    );
    const domain = {
      entityType: 'node' as const,
      entityId: 'synthetic-node',
      projectId: PROJECT,
      payload: {
        title: 'Synthetic',
        kind: 'chapter',
        summary: '',
        writingStatus: 'draft',
        bookOrder: 0,
        driftGroupId: null,
        narrativeOrder: null,
      },
    };
    await runner(PROJECT, 'node.create', async ({ tx, changes }) => {
      appendAuthoredDomainMutation(changes, { ...domain, mutationType: 'create' });
      await appendAuthoredProseSeedInTransaction(tx, changes, {
        entityType: 'node',
        entityId: 'synthetic-node',
        stateUpdate: update,
      });
    });
    await runner(PROJECT, 'node.trash', async ({ changes }) => {
      appendAuthoredDomainMutation(changes, { ...domain, mutationType: 'softDelete' });
    });
    await runner(PROJECT, 'node.restore', async ({ tx, changes }) => {
      appendAuthoredDomainMutation(changes, { ...domain, mutationType: 'restore' });
      await appendAuthoredProseRestoreStateInTransaction(tx, changes, {
        entityType: 'node',
        entityId: 'synthetic-node',
        stateUpdate: update,
      });
    });
    expect(
      (await db.select().from(SyncYjsMaterializationReceiptTable)).map((r) => [
        r.mutationIndex,
        r.incarnation,
        r.documentRevision,
      ]),
    ).toEqual([
      [1, 0, 1],
      [1, 1, 2],
    ]);
  });
  it('preserves per-append revisions when the same restore transaction then advances a snapshot revision', async () => {
    const { db, runner } = await setup();
    const update = state();
    await runner(PROJECT, 'history.restore-prose', async ({ tx, changes }) => {
      for (let n = 0; n < 2; n++)
        await appendAuthoredProseRestoreStateInTransaction(tx, changes, {
          entityType: 'node',
          entityId: 'synthetic-node',
          stateUpdate: update,
        });
      await createYjsRepository(tx).upsertSnapshot(DOC, update, { source: { kind: 'user' } });
    });
    expect(await createYjsRepository(db).getRevision(DOC)).toBe(3);
    expect(
      (await db.select().from(SyncYjsMaterializationReceiptTable)).map((r) => r.documentRevision),
    ).toEqual([1, 2]);
  });

  it('rejects an outer-handle materialized append inside a savepoint before rollback can leave a reusable lease', async () => {
    const { db } = await setup();
    const binding = {
      kind: 'remote' as const,
      changeSetId: 'suppressed-original',
      mutationIndex: 0,
    };
    await db.transaction(async (outer) => {
      const repository = createYjsRepository(outer);
      await expect(
        outer.transaction(async () => {
          await repository.appendMaterializedUpdate(DOC, state(), binding, { kind: 'remote' });
        }),
      ).rejects.toThrow(/innermost active/);
      expect(await repository.listUpdates(DOC)).toEqual([]);
      const id = await repository.appendUpdate(DOC, state(), { kind: 'remote' });
      expect(id).toBe(1);
      await expect(
        insertYjsMaterializationReceiptInTransaction(outer, {
          changeSetId: binding.changeSetId,
          mutationIndex: 0,
          token: {} as YjsMaterializationToken,
          binding,
          createdAt: NOW,
        }),
      ).rejects.toThrow(/token/);
    });
    expect(await db.select().from(SyncYjsMaterializationReceiptTable)).toEqual([]);
  });
});
