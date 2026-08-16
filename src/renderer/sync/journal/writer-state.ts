import { and, desc, eq, isNull } from 'drizzle-orm';

import type { DbTransaction } from '../../lib/db';
import {
  SyncChangeSetTable,
  SyncGenerationWriterStateTable,
} from '../../schema/drizzle';
import {
  nextLocalHlc,
  observeRemoteHlc,
  type Hlc,
} from '../protocol';

export interface NewSyncWriterIdentity {
  writerId: string;
  writerEpoch: string;
}

export interface SyncWriterIdentitySource {
  readonly installationId: string;
  createWriterIdentity(): NewSyncWriterIdentity;
}

export interface SyncJournalClock {
  readonly nowMs: number;
  readonly nowIso: string;
}

export interface ReservedSyncWriterState extends NewSyncWriterIdentity {
  installationId: string;
  deviceSeq: number;
  hlc: Hlc;
}

export interface ObservedSyncWriterState extends NewSyncWriterIdentity {
  installationId: string;
  nextDeviceSeq: number;
  hlc: Hlc;
}

export interface InitializedRestoredWriterState extends NewSyncWriterIdentity {
  installationId: string;
  nextDeviceSeq: 1;
  hlc: Hlc;
}

type WriterStateRow = typeof SyncGenerationWriterStateTable.$inferSelect;

const PROTOCOL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function assertClock(clock: SyncJournalClock): void {
  if (!Number.isSafeInteger(clock.nowMs) || clock.nowMs < 0) {
    throw new RangeError('journal clock nowMs must be a non-negative safe integer');
  }
  if (clock.nowIso.length === 0) throw new TypeError('journal clock nowIso is required');
}

function assertHlc(hlc: Hlc, label: string): void {
  if (
    !Number.isSafeInteger(hlc.wallMs) ||
    hlc.wallMs < 0 ||
    !Number.isSafeInteger(hlc.counter) ||
    hlc.counter < 0
  ) {
    throw new RangeError(`${label} HLC must contain non-negative safe integers`);
  }
}

function assertIdentitySource(identity: SyncWriterIdentitySource): void {
  if (identity.installationId.length === 0) {
    throw new TypeError('installationId is required');
  }
}

function createIdentity(identity: SyncWriterIdentitySource): NewSyncWriterIdentity {
  const created = identity.createWriterIdentity();
  for (const [name, value] of [
    ['writerId', created.writerId],
    ['writerEpoch', created.writerEpoch],
  ] as const) {
    if (value.length > 128 || !PROTOCOL_TOKEN.test(value)) {
      throw new TypeError(`${name} must be a valid sync protocol token`);
    }
  }
  return created;
}

async function findActiveWriter(
  tx: DbTransaction,
  syncGenerationId: string,
): Promise<WriterStateRow | null> {
  const rows = await tx
    .select()
    .from(SyncGenerationWriterStateTable)
    .where(
      and(
        eq(SyncGenerationWriterStateTable.syncGenerationId, syncGenerationId),
        isNull(SyncGenerationWriterStateTable.retiredAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function findLatestWriterClock(
  tx: DbTransaction,
  syncGenerationId: string,
): Promise<Hlc> {
  const rows = await tx
    .select({
      wallMs: SyncGenerationWriterStateTable.hlcWallMs,
      counter: SyncGenerationWriterStateTable.hlcCounter,
    })
    .from(SyncGenerationWriterStateTable)
    .where(eq(SyncGenerationWriterStateTable.syncGenerationId, syncGenerationId))
    .orderBy(
      desc(SyncGenerationWriterStateTable.hlcWallMs),
      desc(SyncGenerationWriterStateTable.hlcCounter),
    )
    .limit(1);
  return rows[0] ?? { wallMs: 0, counter: 0 };
}

async function rotateWriterIfNeeded(
  tx: DbTransaction,
  syncGenerationId: string,
  identity: SyncWriterIdentitySource,
  clock: SyncJournalClock,
): Promise<{ row: WriterStateRow | null; previousHlc: Hlc }> {
  const active = await findActiveWriter(tx, syncGenerationId);
  if (!active || active.installationId === identity.installationId) {
    return {
      row: active,
      previousHlc: active
        ? { wallMs: active.hlcWallMs, counter: active.hlcCounter }
        : await findLatestWriterClock(tx, syncGenerationId),
    };
  }

  await tx
    .update(SyncGenerationWriterStateTable)
    .set({ retiredAt: clock.nowIso, updatedAt: clock.nowIso })
    .where(
      and(
        eq(SyncGenerationWriterStateTable.syncGenerationId, active.syncGenerationId),
        eq(SyncGenerationWriterStateTable.writerId, active.writerId),
        eq(SyncGenerationWriterStateTable.writerEpoch, active.writerEpoch),
        isNull(SyncGenerationWriterStateTable.retiredAt),
      ),
    );
  return {
    row: null,
    previousHlc: { wallMs: active.hlcWallMs, counter: active.hlcCounter },
  };
}

export async function reserveLocalWriterStateInTransaction(
  tx: DbTransaction,
  input: {
    syncGenerationId: string;
    identity: SyncWriterIdentitySource;
    clock: SyncJournalClock;
  },
): Promise<ReservedSyncWriterState> {
  assertClock(input.clock);
  assertIdentitySource(input.identity);
  const current = await rotateWriterIfNeeded(
    tx,
    input.syncGenerationId,
    input.identity,
    input.clock,
  );
  assertHlc(current.previousHlc, 'persisted writer');
  const hlc = nextLocalHlc(current.previousHlc, input.clock.nowMs);

  if (current.row) {
    const deviceSeq = current.row.nextDeviceSeq;
    if (!Number.isSafeInteger(deviceSeq) || deviceSeq < 1) {
      throw new RangeError('persisted writer sequence is invalid');
    }
    if (deviceSeq === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('writer sequence cannot be incremented safely');
    }
    await tx
      .update(SyncGenerationWriterStateTable)
      .set({
        nextDeviceSeq: deviceSeq + 1,
        hlcWallMs: hlc.wallMs,
        hlcCounter: hlc.counter,
        updatedAt: input.clock.nowIso,
      })
      .where(
        and(
          eq(SyncGenerationWriterStateTable.syncGenerationId, current.row.syncGenerationId),
          eq(SyncGenerationWriterStateTable.writerId, current.row.writerId),
          eq(SyncGenerationWriterStateTable.writerEpoch, current.row.writerEpoch),
          isNull(SyncGenerationWriterStateTable.retiredAt),
        ),
      );
    return {
      writerId: current.row.writerId,
      writerEpoch: current.row.writerEpoch,
      installationId: current.row.installationId,
      deviceSeq,
      hlc,
    };
  }

  const created = createIdentity(input.identity);
  await tx.insert(SyncGenerationWriterStateTable).values({
    syncGenerationId: input.syncGenerationId,
    writerId: created.writerId,
    writerEpoch: created.writerEpoch,
    installationId: input.identity.installationId,
    nextDeviceSeq: 2,
    hlcWallMs: hlc.wallMs,
    hlcCounter: hlc.counter,
    createdAt: input.clock.nowIso,
    updatedAt: input.clock.nowIso,
  });
  return {
    ...created,
    installationId: input.identity.installationId,
    deviceSeq: 1,
    hlc,
  };
}

/**
 * Install a fresh local writer identity after checkpoint restore without
 * consuming sequence 1. The persisted clock is the checkpoint-wide HLC
 * anchor, so the first authored write is strictly newer even when this
 * installation's wall clock is behind the source device.
 */
export async function initializeRestoredWriterStateInTransaction(
  tx: DbTransaction,
  input: {
    syncGenerationId: string;
    identity: SyncWriterIdentitySource;
    checkpointHlc: Hlc;
    nowIso: string;
  },
): Promise<InitializedRestoredWriterState> {
  assertIdentitySource(input.identity);
  assertHlc(input.checkpointHlc, 'checkpoint');
  if (!input.nowIso) throw new TypeError('restore writer nowIso is required');
  if (await findActiveWriter(tx, input.syncGenerationId)) {
    throw new Error('checkpoint restore cannot replace an active local writer');
  }

  const created = createIdentity(input.identity);
  const reusedSourceIdentity = await tx
    .select({ changeSetId: SyncChangeSetTable.changeSetId })
    .from(SyncChangeSetTable)
    .where(
      and(
        eq(SyncChangeSetTable.syncGenerationId, input.syncGenerationId),
        eq(SyncChangeSetTable.writerId, created.writerId),
        eq(SyncChangeSetTable.writerEpoch, created.writerEpoch),
      ),
    )
    .limit(1);
  if (reusedSourceIdentity.length > 0) {
    throw new Error('checkpoint restore must create a writer identity absent from source history');
  }

  await tx.insert(SyncGenerationWriterStateTable).values({
    syncGenerationId: input.syncGenerationId,
    writerId: created.writerId,
    writerEpoch: created.writerEpoch,
    installationId: input.identity.installationId,
    nextDeviceSeq: 1,
    hlcWallMs: input.checkpointHlc.wallMs,
    hlcCounter: input.checkpointHlc.counter,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  });
  return {
    ...created,
    installationId: input.identity.installationId,
    nextDeviceSeq: 1,
    hlc: input.checkpointHlc,
  };
}

/** Advance the active local writer clock after a remote change is materialized. */
export async function observeRemoteHlcInTransaction(
  tx: DbTransaction,
  input: {
    syncGenerationId: string;
    remoteHlc: Hlc;
    identity: SyncWriterIdentitySource;
    clock: SyncJournalClock;
  },
): Promise<ObservedSyncWriterState> {
  assertClock(input.clock);
  assertIdentitySource(input.identity);
  const current = await rotateWriterIfNeeded(
    tx,
    input.syncGenerationId,
    input.identity,
    input.clock,
  );
  assertHlc(current.previousHlc, 'persisted writer');
  assertHlc(input.remoteHlc, 'remote');
  const hlc = observeRemoteHlc(current.previousHlc, input.remoteHlc, input.clock.nowMs);

  if (current.row) {
    await tx
      .update(SyncGenerationWriterStateTable)
      .set({
        hlcWallMs: hlc.wallMs,
        hlcCounter: hlc.counter,
        updatedAt: input.clock.nowIso,
      })
      .where(
        and(
          eq(SyncGenerationWriterStateTable.syncGenerationId, current.row.syncGenerationId),
          eq(SyncGenerationWriterStateTable.writerId, current.row.writerId),
          eq(SyncGenerationWriterStateTable.writerEpoch, current.row.writerEpoch),
          isNull(SyncGenerationWriterStateTable.retiredAt),
        ),
      );
    return {
      writerId: current.row.writerId,
      writerEpoch: current.row.writerEpoch,
      installationId: current.row.installationId,
      nextDeviceSeq: current.row.nextDeviceSeq,
      hlc,
    };
  }

  const created = createIdentity(input.identity);
  await tx.insert(SyncGenerationWriterStateTable).values({
    syncGenerationId: input.syncGenerationId,
    writerId: created.writerId,
    writerEpoch: created.writerEpoch,
    installationId: input.identity.installationId,
    nextDeviceSeq: 1,
    hlcWallMs: hlc.wallMs,
    hlcCounter: hlc.counter,
    createdAt: input.clock.nowIso,
    updatedAt: input.clock.nowIso,
  });
  return {
    ...created,
    installationId: input.identity.installationId,
    nextDeviceSeq: 1,
    hlc,
  };
}
