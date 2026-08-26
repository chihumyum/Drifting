import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import {
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  yjsSnapshots,
  yjsUpdates,
} from '../schema/drizzle';

export interface YjsUpdateRow {
  id: number;
  docId: string;
  updateBlob: Uint8Array;
  createdAt: string;
}

export interface YjsSnapshotRow {
  docId: string;
  stateBlob: Uint8Array;
  updatedAt: string;
}

export interface YjsUpdateRevisionResult {
  updateId: number;
  previousRevision: number;
  revision: number;
}

export interface YjsRevisionAgentIdentity {
  sessionId: string;
  turnId: string;
  callId: string;
}

export type YjsRevisionSource =
  | { kind: 'agent'; collaborator?: YjsRevisionAgentIdentity }
  | { kind: 'user' }
  | { kind: 'remote' }
  | { kind: 'system' }
  | { kind: 'legacy' };

export interface YjsRevisionProvenanceRow {
  docId: string;
  revision: number;
  source: YjsRevisionSource;
  createdAt: string;
}

export class YjsDocumentRevisionConflictError extends Error {
  readonly code = 'STALE_REVISION';

  constructor(
    readonly docId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Yjs document ${docId} expected revision ${expectedRevision}, received ${actualRevision}.`,
    );
    this.name = 'YjsDocumentRevisionConflictError';
  }
}

export interface YjsRepository {
  listUpdates(docId: string, sinceId?: number): Promise<YjsUpdateRow[]>;
  listDocIds(): Promise<string[]>;
  /**
   * Low-level append used inside an already-authoritative persistence path.
   * Ordinary authored edits must call `appendAuthoredYjsUpdate`, which wraps
   * this row and its revision/provenance in the same transaction as the sync
   * change-set. Remote reducers use this method inside their remote apply
   * transaction and must never route through the authored helper.
   */
  appendUpdate(
    docId: string,
    updateBlob: Uint8Array,
    source?: YjsRevisionSource,
  ): Promise<number>;
  /**
   * Compare-and-increment the durable revision while appending an update.
   * Used by prepared Agent prose commands after their state vector/hash checks.
   */
  appendUpdateCas(
    docId: string,
    updateBlob: Uint8Array,
    expectedRevision: number,
    source?: YjsRevisionSource,
  ): Promise<YjsUpdateRevisionResult>;
  getSnapshot(docId: string): Promise<YjsSnapshotRow | null>;
  upsertSnapshot(
    docId: string,
    stateBlob: Uint8Array,
    options?: { advanceRevision?: boolean; source?: YjsRevisionSource },
  ): Promise<void>;
  hasDocState(docId: string): Promise<boolean>;
  /** Monotonic generation, independent from compactable update row ids. */
  getRevision(docId: string): Promise<number>;
  /**
   * Every doc's durable revision in one query. Cache validity checks over a
   * whole project (e.g. prose search) read this instead of N getRevision calls.
   */
  listRevisions(): Promise<Array<{ docId: string; revision: number }>>;
  /** Durable authors for revisions strictly newer than `afterRevision`. */
  listRevisionProvenance(
    docId: string,
    afterRevision: number,
  ): Promise<YjsRevisionProvenanceRow[]>;
  /** Highest update id currently stored for this doc, or 0 if none. */
  maxUpdateId(docId: string): Promise<number>;
  /**
   * Delete update rows with id <= maxId for this doc. Used by compaction
   * only after a snapshot has absorbed the rows and their immutable sync
   * journal records have committed. Returns the number of rows pruned.
   */
  deleteUpdatesUpTo(docId: string, maxId: number): Promise<number>;
}

function normalizeBlob(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) {
    return Uint8Array.from(input);
  }
  if (input && typeof input === 'object') {
    const maybeBuffer = input as { type?: string; data?: number[] };
    if (maybeBuffer.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
      return Uint8Array.from(maybeBuffer.data);
    }
  }
  throw new Error('Unsupported blob format when reading yjs data');
}

function blobsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function assertRevision(revision: number, path: string): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
}

function assertAgentIdentity(identity: YjsRevisionAgentIdentity): void {
  if (!identity.sessionId.trim() || !identity.turnId.trim() || !identity.callId.trim()) {
    throw new Error('Yjs Agent revision identity must be complete');
  }
}

function provenanceValues(
  docId: string,
  revision: number,
  source: YjsRevisionSource,
  createdAt: string,
): typeof YjsDocumentRevisionProvenanceTable.$inferInsert {
  if (source.kind === 'agent' && source.collaborator) {
    assertAgentIdentity(source.collaborator);
  }
  return {
    docId,
    revision,
    sourceKind: source.kind,
    agentSessionId:
      source.kind === 'agent' ? source.collaborator?.sessionId ?? null : null,
    agentTurnId:
      source.kind === 'agent' ? source.collaborator?.turnId ?? null : null,
    agentCallId:
      source.kind === 'agent' ? source.collaborator?.callId ?? null : null,
    createdAt,
  };
}

function provenanceFromRow(
  row: typeof YjsDocumentRevisionProvenanceTable.$inferSelect,
): YjsRevisionProvenanceRow {
  let source: YjsRevisionSource;
  if (row.sourceKind === 'agent') {
    source =
      row.agentSessionId && row.agentTurnId && row.agentCallId
        ? {
            kind: 'agent',
            collaborator: {
              sessionId: row.agentSessionId,
              turnId: row.agentTurnId,
              callId: row.agentCallId,
            },
          }
        : { kind: 'agent' };
  } else if (
    row.sourceKind === 'user' ||
    row.sourceKind === 'remote' ||
    row.sourceKind === 'system' ||
    row.sourceKind === 'legacy'
  ) {
    source = { kind: row.sourceKind };
  } else {
    source = { kind: 'legacy' };
  }
  return {
    docId: row.docId,
    revision: row.revision,
    source,
    createdAt: row.createdAt,
  };
}

export function createYjsRepository(dbOverride?: DbExecutor): YjsRepository {
  const dbProvider = (): DbExecutor => dbOverride ?? getDb();
  const runAtomic = <T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> =>
    dbProvider().transaction((tx) => work(tx));

  const getRevisionFrom = async (
    executor: DbExecutor,
    docId: string,
  ): Promise<number> => {
    const rows = await executor
      .select({ revision: YjsDocumentRevisionTable.revision })
      .from(YjsDocumentRevisionTable)
      .where(eq(YjsDocumentRevisionTable.docId, docId))
      .limit(1);
    return rows[0]?.revision ?? 0;
  };

  const ensureRevisionRow = async (
    executor: DbExecutor,
    docId: string,
    now: string,
  ): Promise<void> => {
    await executor
      .insert(YjsDocumentRevisionTable)
      .values({ docId, revision: 0, updatedAt: now })
      .onConflictDoNothing();
  };

  const advanceRevision = async (
    executor: DbExecutor,
    docId: string,
    now: string,
    source: YjsRevisionSource,
    expectedRevision?: number,
  ): Promise<{ previousRevision: number; revision: number }> => {
    if (expectedRevision !== undefined) {
      assertRevision(expectedRevision, 'expectedRevision');
    }
    await ensureRevisionRow(executor, docId, now);
    const where =
      expectedRevision === undefined
        ? eq(YjsDocumentRevisionTable.docId, docId)
        : and(
            eq(YjsDocumentRevisionTable.docId, docId),
            eq(YjsDocumentRevisionTable.revision, expectedRevision),
          );
    const rows = await executor
      .update(YjsDocumentRevisionTable)
      .set({
        revision: sql`${YjsDocumentRevisionTable.revision} + 1`,
        updatedAt: now,
      })
      .where(where)
      .returning({ revision: YjsDocumentRevisionTable.revision });
    const revision = rows[0]?.revision;
    if (revision === undefined) {
      const actualRevision = await getRevisionFrom(executor, docId);
      throw new YjsDocumentRevisionConflictError(
        docId,
        expectedRevision ?? actualRevision,
        actualRevision,
      );
    }
    await executor
      .insert(YjsDocumentRevisionProvenanceTable)
      .values(provenanceValues(docId, revision, source, now));
    return { previousRevision: revision - 1, revision };
  };

  const listUpdates = async (docId: string, sinceId?: number): Promise<YjsUpdateRow[]> => {
    const rows =
      sinceId === undefined
        ? await dbProvider()
            .select()
            .from(yjsUpdates)
            .where(eq(yjsUpdates.docId, docId))
            .orderBy(asc(yjsUpdates.id))
        : await dbProvider()
            .select()
            .from(yjsUpdates)
            .where(and(eq(yjsUpdates.docId, docId), gt(yjsUpdates.id, sinceId)))
            .orderBy(asc(yjsUpdates.id));

    return rows.map((row) => ({
      id: row.id,
      docId: row.docId,
      updateBlob: normalizeBlob(row.updateBlob),
      createdAt: row.createdAt,
    }));
  };

  const appendUpdate = async (
    docId: string,
    updateBlob: Uint8Array,
    source: YjsRevisionSource = { kind: 'user' },
  ): Promise<number> => {
    return runAtomic(async (executor) => {
      const now = new Date().toISOString();
      const inserted = await executor
        .insert(yjsUpdates)
        .values({
          docId,
          updateBlob: new Uint8Array(updateBlob),
          createdAt: now,
        })
        .returning({ id: yjsUpdates.id });

      if (!inserted[0]) {
        throw new Error(`Failed to append yjs update for doc ${docId}`);
      }
      await advanceRevision(executor, docId, now, source);
      return inserted[0].id;
    });
  };

  const appendUpdateCas = async (
    docId: string,
    updateBlob: Uint8Array,
    expectedRevision: number,
    source: YjsRevisionSource = { kind: 'system' },
  ): Promise<YjsUpdateRevisionResult> => {
    assertRevision(expectedRevision, 'expectedRevision');
    return runAtomic(async (executor) => {
      const now = new Date().toISOString();
      const advanced = await advanceRevision(
        executor,
        docId,
        now,
        source,
        expectedRevision,
      );
      const inserted = await executor
        .insert(yjsUpdates)
        .values({
          docId,
          updateBlob: new Uint8Array(updateBlob),
          createdAt: now,
        })
        .returning({ id: yjsUpdates.id });
      if (!inserted[0]) {
        throw new Error(`Failed to append yjs update for doc ${docId}`);
      }
      return {
        updateId: inserted[0].id,
        previousRevision: advanced.previousRevision,
        revision: advanced.revision,
      };
    });
  };

  const listDocIds = async (): Promise<string[]> => {
    const updateRows = await dbProvider()
      .selectDistinct({ docId: yjsUpdates.docId })
      .from(yjsUpdates);
    const snapshotRows = await dbProvider()
      .selectDistinct({ docId: yjsSnapshots.docId })
      .from(yjsSnapshots);
    return [
      ...new Set([
        ...updateRows.map((row) => row.docId),
        ...snapshotRows.map((row) => row.docId),
      ]),
    ];
  };

  const getSnapshot = async (docId: string): Promise<YjsSnapshotRow | null> => {
    const rows = await dbProvider()
      .select()
      .from(yjsSnapshots)
      .where(eq(yjsSnapshots.docId, docId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      docId: row.docId,
      stateBlob: normalizeBlob(row.stateBlob),
      updatedAt: row.updatedAt,
    };
  };

  const upsertSnapshot = async (
    docId: string,
    stateBlob: Uint8Array,
    options: { advanceRevision?: boolean; source?: YjsRevisionSource } = {},
  ): Promise<void> => {
    await runAtomic(async (executor) => {
      const now = new Date().toISOString();
      const existing = await executor
        .select({ stateBlob: yjsSnapshots.stateBlob })
        .from(yjsSnapshots)
        .where(eq(yjsSnapshots.docId, docId))
        .limit(1);
      const nextState = new Uint8Array(stateBlob);
      const stateChanged =
        !existing[0] ||
        !blobsEqual(normalizeBlob(existing[0].stateBlob), nextState);
      await executor
        .insert(yjsSnapshots)
        .values({
          docId,
          stateBlob: nextState,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: yjsSnapshots.docId,
          set: {
            stateBlob: nextState,
            updatedAt: now,
          },
        });
      if (options.advanceRevision !== false && stateChanged) {
        await advanceRevision(
          executor,
          docId,
          now,
          options.source ?? { kind: 'system' },
        );
      } else {
        await ensureRevisionRow(executor, docId, now);
      }
    });
  };

  const hasDocState = async (docId: string): Promise<boolean> => {
    const [snap, latestUpdate] = await Promise.all([
      getSnapshot(docId),
      dbProvider()
        .select({ id: yjsUpdates.id })
        .from(yjsUpdates)
        .where(eq(yjsUpdates.docId, docId))
        .limit(1),
    ]);

    return Boolean(snap || latestUpdate[0]);
  };

  const getRevision = async (docId: string): Promise<number> =>
    getRevisionFrom(dbProvider(), docId);

  const listRevisions = async (): Promise<Array<{ docId: string; revision: number }>> =>
    dbProvider()
      .select({
        docId: YjsDocumentRevisionTable.docId,
        revision: YjsDocumentRevisionTable.revision,
      })
      .from(YjsDocumentRevisionTable);

  const listRevisionProvenance = async (
    docId: string,
    afterRevision: number,
  ): Promise<YjsRevisionProvenanceRow[]> => {
    assertRevision(afterRevision, 'afterRevision');
    const rows = await dbProvider()
      .select()
      .from(YjsDocumentRevisionProvenanceTable)
      .where(
        and(
          eq(YjsDocumentRevisionProvenanceTable.docId, docId),
          gt(YjsDocumentRevisionProvenanceTable.revision, afterRevision),
        ),
      )
      .orderBy(asc(YjsDocumentRevisionProvenanceTable.revision));
    return rows.map(provenanceFromRow);
  };

  const maxUpdateId = async (docId: string): Promise<number> => {
    const rows = await dbProvider()
      .select({ id: yjsUpdates.id })
      .from(yjsUpdates)
      .where(eq(yjsUpdates.docId, docId))
      .orderBy(desc(yjsUpdates.id))
      .limit(1);
    return rows[0]?.id ?? 0;
  };

  const deleteUpdatesUpTo = async (docId: string, maxId: number): Promise<number> => {
    if (maxId <= 0) return 0;
    const deleted = await dbProvider()
      .delete(yjsUpdates)
      .where(and(eq(yjsUpdates.docId, docId), lte(yjsUpdates.id, maxId)))
      .returning({ id: yjsUpdates.id });
    return deleted.length;
  };

  return {
    listUpdates,
    listDocIds,
    appendUpdate,
    appendUpdateCas,
    getSnapshot,
    upsertSnapshot,
    hasDocState,
    getRevision,
    listRevisions,
    listRevisionProvenance,
    maxUpdateId,
    deleteUpdatesUpTo,
  };
}
