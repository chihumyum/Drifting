import { and, asc, eq, isNull } from 'drizzle-orm';

import type { DbClient, DbTransaction } from '../../lib/db';
import {
  SyncCursorTable,
  SyncFrontierGapTable,
  SyncFrontierTable,
  SyncProviderBindingTable,
  SyncRemoteObjectTable,
} from '../../schema/drizzle';
import {
  createProviderCursor,
  createProviderPageToken,
  type Sha256,
} from '../protocol';
import type { DurableCursorState } from './cursor';
import {
  FRONTIER_LANES,
  assertWriterFrontierInvariants,
  createWriterFrontier,
  type FrontierLane,
  type SequenceRange,
  type WriterFrontierState,
} from './frontier';

interface CursorStorageRow {
  readonly providerEpoch: string;
  readonly committedCursor: string | null;
  readonly pendingBaseCursor: string | null;
  readonly pendingPageToken: string | null;
  readonly inventoryComplete: boolean;
}

/** Reserved locally; provider cursors are never interpreted by the engine. */
export const INVENTORY_UNCONFIRMED_CURSOR = 'drifting:inventory-unconfirmed:v1';

function sha256Hex(value: Sha256): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  if (!match) throw new TypeError('SHA-256 must use sha256:<lowercase hex>');
  return match[1];
}

function protocolSha256(value: string): Sha256 {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('stored SHA-256 is malformed');
  return `sha256:${value}` as Sha256;
}

function gapKey(lane: FrontierLane, range: SequenceRange): string {
  return `${lane}:${range.firstSeq}:${range.lastSeq}`;
}

function gapId(state: WriterFrontierState, lane: FrontierLane, range: SequenceRange): string {
  return JSON.stringify([
    'sync-frontier-gap',
    state.syncGenerationId,
    state.writerId,
    state.writerEpoch,
    lane,
    range.firstSeq,
    range.lastSeq,
  ]);
}

export function encodeCursorStorage(state: DurableCursorState): CursorStorageRow {
  const inventoryStart = state.inventory?.startCursor ?? null;
  const inventoryPage = state.inventory?.pageToken ?? null;
  const pendingChanges = state.pendingChanges;
  return {
    providerEpoch: state.providerEpoch,
    // Before inventory completes this column durably holds the captured start
    // cursor; inventoryComplete prevents it from being consumed as incremental.
    committedCursor: inventoryStart ?? state.committedCursor,
    pendingBaseCursor: inventoryPage
      ? inventoryStart
      : (pendingChanges?.baseCursor ?? null),
    pendingPageToken: inventoryPage ?? pendingChanges?.pageToken ?? null,
    inventoryComplete: state.inventoryComplete,
  };
}

export function decodeCursorStorage(row: CursorStorageRow): DurableCursorState {
  const committedCursor = row.committedCursor
    ? createProviderCursor(row.committedCursor)
    : null;
  if (!row.inventoryComplete) {
    if (!committedCursor) throw new Error('incomplete inventory is missing its captured start cursor');
    if (row.pendingBaseCursor && row.pendingBaseCursor !== committedCursor) {
      throw new Error('inventory pending page belongs to a different start cursor');
    }
    if (Boolean(row.pendingBaseCursor) !== Boolean(row.pendingPageToken)) {
      throw new Error('stored provider pending cursor pair is incomplete');
    }
    return Object.freeze({
      providerEpoch: row.providerEpoch,
      committedCursor: null,
      inventoryComplete: false,
      inventory: Object.freeze({
        startCursor: committedCursor,
        pageToken: row.pendingPageToken
          ? createProviderPageToken(row.pendingPageToken)
          : null,
      }),
      pendingChanges: null,
    });
  }
  if (Boolean(row.pendingBaseCursor) !== Boolean(row.pendingPageToken)) {
    throw new Error('stored provider pending cursor pair is incomplete');
  }
  return Object.freeze({
    providerEpoch: row.providerEpoch,
    committedCursor,
    inventoryComplete: true,
    inventory: null,
    pendingChanges:
      row.pendingBaseCursor && row.pendingPageToken
        ? Object.freeze({
            baseCursor: createProviderCursor(row.pendingBaseCursor),
            pageToken: createProviderPageToken(row.pendingPageToken),
          })
        : null,
  });
}

/** SQLite adapter for the pure frontier/cursor state machines; it owns no network API. */
export class SqliteSyncEngineStateRepository {
  constructor(private readonly db: DbClient) {}

  async loadWriterFrontier(input: {
    syncGenerationId: string;
    writerId: string;
    writerEpoch: string;
  }): Promise<WriterFrontierState> {
    const [frontierRows, gapRows] = await Promise.all([
      this.db
        .select()
        .from(SyncFrontierTable)
        .where(
          and(
            eq(SyncFrontierTable.syncGenerationId, input.syncGenerationId),
            eq(SyncFrontierTable.writerId, input.writerId),
            eq(SyncFrontierTable.writerEpoch, input.writerEpoch),
          ),
        )
        .limit(1),
      this.db
        .select()
        .from(SyncFrontierGapTable)
        .where(
          and(
            eq(SyncFrontierGapTable.syncGenerationId, input.syncGenerationId),
            eq(SyncFrontierGapTable.writerId, input.writerId),
            eq(SyncFrontierGapTable.writerEpoch, input.writerEpoch),
            eq(SyncFrontierGapTable.state, 'open'),
          ),
        )
        .orderBy(asc(SyncFrontierGapTable.lane), asc(SyncFrontierGapTable.firstSeq)),
    ]);
    const row = frontierRows[0];
    if (!row) return createWriterFrontier(input);
    const ranges = (lane: FrontierLane) =>
      gapRows
        .filter((gap) => gap.lane === lane)
        .map((gap) => Object.freeze({ firstSeq: gap.firstSeq, lastSeq: gap.lastSeq }));
    const state: WriterFrontierState = Object.freeze({
      ...input,
      received: Object.freeze({ maxSeq: row.receivedSeq, gaps: Object.freeze(ranges('received')) }),
      applied: Object.freeze({ maxSeq: row.appliedSeq, gaps: Object.freeze(ranges('applied')) }),
      published: Object.freeze({ maxSeq: row.publishedSeq, gaps: Object.freeze(ranges('published')) }),
      segmentHeadSha256: row.segmentHeadSha256
        ? protocolSha256(row.segmentHeadSha256)
        : null,
    });
    assertWriterFrontierInvariants(state);
    return state;
  }

  async persistWriterFrontier(state: WriterFrontierState, nowIso: string): Promise<void> {
    assertWriterFrontierInvariants(state);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(SyncFrontierTable)
        .values({
          syncGenerationId: state.syncGenerationId,
          writerId: state.writerId,
          writerEpoch: state.writerEpoch,
          receivedSeq: state.received.maxSeq,
          appliedSeq: state.applied.maxSeq,
          publishedSeq: state.published.maxSeq,
          segmentHeadSha256: state.segmentHeadSha256
            ? sha256Hex(state.segmentHeadSha256)
            : null,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: [
            SyncFrontierTable.syncGenerationId,
            SyncFrontierTable.writerId,
            SyncFrontierTable.writerEpoch,
          ],
          set: {
            receivedSeq: state.received.maxSeq,
            appliedSeq: state.applied.maxSeq,
            publishedSeq: state.published.maxSeq,
            segmentHeadSha256: state.segmentHeadSha256
              ? sha256Hex(state.segmentHeadSha256)
              : null,
            updatedAt: nowIso,
          },
        });

      const existing = await tx
        .select()
        .from(SyncFrontierGapTable)
        .where(
          and(
            eq(SyncFrontierGapTable.syncGenerationId, state.syncGenerationId),
            eq(SyncFrontierGapTable.writerId, state.writerId),
            eq(SyncFrontierGapTable.writerEpoch, state.writerEpoch),
          ),
        );
      const desired = new Map<string, { lane: FrontierLane; range: SequenceRange }>();
      for (const lane of FRONTIER_LANES) {
        for (const range of state[lane].gaps) desired.set(gapKey(lane, range), { lane, range });
      }

      for (const row of existing) {
        const key = gapKey(row.lane as FrontierLane, {
          firstSeq: row.firstSeq,
          lastSeq: row.lastSeq,
        });
        if (desired.delete(key)) {
          if (row.state !== 'open') {
            await tx
              .update(SyncFrontierGapTable)
              .set({ state: 'open', resolvedAt: null, observedAt: nowIso })
              .where(eq(SyncFrontierGapTable.id, row.id));
          }
        } else if (row.state === 'open') {
          await tx
            .update(SyncFrontierGapTable)
            .set({ state: 'resolved', resolvedAt: nowIso })
            .where(eq(SyncFrontierGapTable.id, row.id));
        }
      }

      for (const { lane, range } of desired.values()) {
        await tx.insert(SyncFrontierGapTable).values({
          id: gapId(state, lane, range),
          syncGenerationId: state.syncGenerationId,
          writerId: state.writerId,
          writerEpoch: state.writerEpoch,
          lane,
          firstSeq: range.firstSeq,
          lastSeq: range.lastSeq,
          state: 'open',
          observedAt: nowIso,
          resolvedAt: null,
        });
      }
    });
  }

  async loadCursor(syncGenerationId: string): Promise<DurableCursorState | null> {
    const rows = await this.db
      .select()
      .from(SyncCursorTable)
      .where(eq(SyncCursorTable.syncGenerationId, syncGenerationId))
      .limit(1);
    return rows[0] ? decodeCursorStorage(rows[0]) : null;
  }

  async persistCursor(syncGenerationId: string, state: DurableCursorState, nowIso: string): Promise<void> {
    const row = encodeCursorStorage(state);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(SyncCursorTable)
        .values({ syncGenerationId, ...row, updatedAt: nowIso })
        .onConflictDoUpdate({
          target: SyncCursorTable.syncGenerationId,
          set: { ...row, updatedAt: nowIso },
        });
    });
  }

  /**
   * Atomically forgets an invalid provider token and marks every active object
   * as needing full-inventory confirmation.
   */
  async resetCursorForFullInventory(syncGenerationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(SyncCursorTable).where(eq(SyncCursorTable.syncGenerationId, syncGenerationId));
      await tx
        .update(SyncRemoteObjectTable)
        .set({ observedCursor: INVENTORY_UNCONFIRMED_CURSOR })
        .where(
          and(
            eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
            isNull(SyncRemoteObjectTable.removedAt),
          ),
        );
    });
  }

  /**
   * The final inventory page and absence check share one commit boundary. A
   * missing immutable object blocks the binding without committing a cursor
   * that could otherwise allow changes/publish/checkpoint to continue.
   */
  async persistInventoryCursor(
    syncGenerationId: string,
    state: DurableCursorState,
    nowIso: string,
  ): Promise<{ readonly missingObjectCount: number }> {
    const row = encodeCursorStorage(state);
    return this.db.transaction(async (tx) => {
      if (state.inventoryComplete) {
        const missing = await tx
          .select({ id: SyncRemoteObjectTable.id })
          .from(SyncRemoteObjectTable)
          .where(
            and(
              eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
              eq(SyncRemoteObjectTable.observedCursor, INVENTORY_UNCONFIRMED_CURSOR),
              isNull(SyncRemoteObjectTable.removedAt),
            ),
          );
        if (missing.length > 0) {
          await tx
            .update(SyncRemoteObjectTable)
            .set({ removedAt: nowIso })
            .where(
              and(
                eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
                eq(SyncRemoteObjectTable.observedCursor, INVENTORY_UNCONFIRMED_CURSOR),
                isNull(SyncRemoteObjectTable.removedAt),
              ),
            );
          await tx
            .update(SyncProviderBindingTable)
            .set({ state: 'blocked-corrupt', updatedAt: nowIso })
            .where(eq(SyncProviderBindingTable.syncGenerationId, syncGenerationId));
          return { missingObjectCount: missing.length };
        }
      }
      await tx
        .insert(SyncCursorTable)
        .values({ syncGenerationId, ...row, updatedAt: nowIso })
        .onConflictDoUpdate({
          target: SyncCursorTable.syncGenerationId,
          set: { ...row, updatedAt: nowIso },
        });
      return { missingObjectCount: 0 };
    });
  }
}

/**
 * Persists frontier rows under an already-owned authored/apply transaction.
 * Drizzle implements this call as a savepoint, so the frontier cannot commit
 * independently from the reducer receipt/domain materialization.
 */
export function persistWriterFrontierInTransaction(
  tx: DbTransaction,
  state: WriterFrontierState,
  nowIso: string,
): Promise<void> {
  return new SqliteSyncEngineStateRepository(tx as unknown as DbClient)
    .persistWriterFrontier(state, nowIso);
}
