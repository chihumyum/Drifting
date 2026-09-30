import { createSyncAppAuthorityRepository } from '../app-authority-repository';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../../lib/db';
import {
  SyncAppAuthorityTable,
  SyncGenerationTable,
  SyncConflictTable,
  SyncFrontierGapTable,
  SyncQuarantinedObjectTable,
  SyncConnectAttemptTable,
  SyncConnectGenerationAttemptTable,
} from '../../schema/drizzle';
import { assertNormalizedAuthoredAuthorityV1 } from '../checkpoint/domain-catalog';
import { captureReducerStateV1, materializeReducerStateV1 } from '../checkpoint/reducer-state';
import type { ReducerStatePayloadV1 } from '../checkpoint/types';
import {
  initializeRestoredWriterStateInTransaction,
  type SyncWriterIdentitySource,
} from '../journal/writer-state';
import {
  compareUtf8Bytewise,
  decodeSyncChangeSetV1,
  encodeSyncChangeSetV1,
  sha256Bytes,
  type CanonicalCborValue,
  type Hlc,
} from '../protocol';

type Row = Record<string, CanonicalCborValue>;

/** New ancestry identities preserve register ordering; no old provider receipt is inherited. */
async function rebase(state: ReducerStatePayloadV1, generation: string) {
  if (state.generationPurges.length) throw new Error('A purged project cannot enter Hosted');
  const prefix = `adopt-${crypto.randomUUID()}`;
  const writers = new Map(
    [...new Set(state.changeSets.map((row) => String(row.writer_id)))]
      .sort(compareUtf8Bytewise)
      .map((id, index) => [id, `${prefix}-${String(index).padStart(10, '0')}`]),
  );
  const ids = new Map(
    state.changeSets.map((row) => [
      String(row.change_set_id),
      `${writers.get(String(row.writer_id))}:${row.writer_epoch}:${row.device_seq}`,
    ]),
  );
  const remap = (source: Readonly<Row>): Row => {
    const row = { ...source };
    if ('sync_generation_id' in row) row.sync_generation_id = generation;
    if ('writer_id' in row) row.writer_id = writers.get(String(row.writer_id))!;
    for (const key of ['change_set_id', 'add_change_set_id', 'removed_by_change_set_id']) {
      if (row[key] != null) {
        const id = ids.get(String(row[key]));
        if (!id) throw new Error('Local reducer ancestry is incomplete');
        row[key] = id;
      }
    }
    return row;
  };
  let checkpointHlc: Hlc = { wallMs: 0, counter: 0 };
  const changeSets: Row[] = [];
  for (const source of state.changeSets) {
    const decoded = await decodeSyncChangeSetV1(source.encoded_bytes as Uint8Array);
    if (!decoded.ok) throw new Error('Local journal failed verification');
    if (
      (await sha256Bytes(source.encoded_bytes as Uint8Array)) !== `sha256:${source.payload_sha256}`
    )
      throw new Error('Local journal hash differs from its receipt');
    const row = remap(source);
    const value = {
      ...decoded.value,
      syncGenerationId: generation,
      writerId: String(row.writer_id),
      changeSetId: String(row.change_set_id),
    };
    const bytes = encodeSyncChangeSetV1(value);
    row.encoded_bytes = bytes;
    row.payload_sha256 = (await sha256Bytes(bytes)).slice(7);
    row.origin = 'remote'; // State-transfer ancestry, never a new outbound writer lane.
    changeSets.push(row);
    const hlc = value.hlc;
    if (
      hlc.wallMs > checkpointHlc.wallMs ||
      (hlc.wallMs === checkpointHlc.wallMs && hlc.counter > checkpointHlc.counter)
    )
      checkpointHlc = hlc;
  }
  const rebased: ReducerStatePayloadV1 = {
    ...state,
    changeSets,
    mutations: state.mutations.map(remap),
    applyReceipts: state.applyReceipts.map((row) => ({
      ...remap(row),
      source_object_id: null,
      state_sha256: null,
    })),
    fieldClocks: state.fieldClocks.map(remap),
    setTags: state.setTags.map(remap),
    orderRegisters: state.orderRegisters.map(remap),
    lifecycles: state.lifecycles.map(remap),
    // The new generation starts at a full-state genesis, with a fresh local writer.
    frontier: [],
    generationPurges: [],
  };
  return { rebased, checkpointHlc };
}

/**
 * Explicit local-replica takeover. The caller flushes editors and quiesces Drive first.
 * One SQLite transaction changes ownership and stages Hosted genesis publication.
 * Failure rolls back everything; subsequent upload failure leaves local writing usable.
 * Domain rows, Yjs bytes, assets and the retired generation are never rewritten.
 */
export async function adoptDriveReplicaForHosted(input: {
  db: DbClient;
  accountSubject: string;
  identity: SyncWriterIdentitySource;
  assertAccount: () => void;
  nowIso?: string;
}): Promise<{ attemptId: string; syncGenerationIds: readonly string[] }> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  return input.db.transaction(async (tx) => {
    input.assertAccount();
    const [authority] = await tx.select().from(SyncAppAuthorityTable).limit(1);
    if (authority?.mode !== 'google-drive' || authority.transitionState !== 'stable')
      throw new Error('Only a stable Google Drive library can adopt its local replica');
    const sources = await tx
      .select()
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.status, 'active'));
    // Record an explicit local-only disconnect in the same atomic transaction.
    // Its readiness means local durability, not convergence with unreachable Drive.
    const detachId = crypto.randomUUID();
    await tx
      .insert(SyncConnectAttemptTable)
      .values({
        attemptId: detachId,
        authorityGeneration: authority.generation,
        kind: 'disconnect',
        targetMode: 'local',
        state: 'preparing',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    for (const source of sources)
      await tx.insert(SyncConnectGenerationAttemptTable).values({
        attemptId: detachId,
        sourceSyncGenerationId: source.syncGenerationId,
        state: 'committed',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    await tx
      .update(SyncAppAuthorityTable)
      .set({
        transitionState: 'disconnecting',
        targetMode: 'local',
        attemptId: detachId,
        updatedAt: nowIso,
      })
      .where(eq(SyncAppAuthorityTable.id, 'app'));
    await createSyncAppAuthorityRepository(input.db).completeInTransaction(tx, {
      attemptId: detachId,
      nowIso,
    });
    const targets: string[] = [];
    for (const source of sources) {
      if (!source.projectId) {
        await tx
          .update(SyncGenerationTable)
          .set({ status: 'retired', retiredAt: nowIso, updatedAt: nowIso })
          .where(eq(SyncGenerationTable.syncGenerationId, source.syncGenerationId));
        continue;
      }
      const [conflicts, gaps, quarantine] = await Promise.all([
        tx
          .select()
          .from(SyncConflictTable)
          .where(
            and(
              eq(SyncConflictTable.syncGenerationId, source.syncGenerationId),
              eq(SyncConflictTable.state, 'open'),
            ),
          )
          .limit(1),
        tx
          .select()
          .from(SyncFrontierGapTable)
          .where(
            and(
              eq(SyncFrontierGapTable.syncGenerationId, source.syncGenerationId),
              eq(SyncFrontierGapTable.state, 'open'),
            ),
          )
          .limit(1),
        tx
          .select()
          .from(SyncQuarantinedObjectTable)
          .where(
            and(
              eq(SyncQuarantinedObjectTable.syncGenerationId, source.syncGenerationId),
              inArray(SyncQuarantinedObjectTable.state, ['blocked-update', 'blocked-corrupt']),
            ),
          )
          .limit(1),
      ]);
      if (conflicts.length || gaps.length || quarantine.length)
        throw new Error(
          'Resolve local sync conflicts or quarantined data before switching providers',
        );
      await assertNormalizedAuthoredAuthorityV1(tx, {
        projectId: source.projectId,
        syncGenerationId: source.syncGenerationId,
      });
      const [latest] = await tx
        .select()
        .from(SyncGenerationTable)
        .where(eq(SyncGenerationTable.projectSyncId, source.projectSyncId))
        .orderBy(desc(SyncGenerationTable.generationNumber))
        .limit(1);
      const target = crypto.randomUUID();
      const { rebased, checkpointHlc } = await rebase(
        await captureReducerStateV1(tx, source.syncGenerationId),
        target,
      );
      await tx
        .update(SyncGenerationTable)
        .set({ status: 'retired', retiredAt: nowIso, updatedAt: nowIso })
        .where(eq(SyncGenerationTable.syncGenerationId, source.syncGenerationId));
      await tx
        .insert(SyncGenerationTable)
        .values({
          ...source,
          syncGenerationId: target,
          generationNumber: latest!.generationNumber + 1,
          status: 'active',
          createdAt: nowIso,
          updatedAt: nowIso,
          retiredAt: null,
          purgedAt: null,
        });
      await materializeReducerStateV1(tx, rebased);
      await initializeRestoredWriterStateInTransaction(tx, {
        syncGenerationId: target,
        identity: input.identity,
        checkpointHlc,
        nowIso,
      });
      await assertNormalizedAuthoredAuthorityV1(tx, {
        projectId: source.projectId,
        syncGenerationId: target,
      });
      targets.push(target);
    }
    // Leave a resumable ordinary Hosted connect. Only a published genesis may
    // activate its binding; upload errors cannot send this library back to Drive.
    const attemptId = crypto.randomUUID();
    await tx
      .insert(SyncConnectAttemptTable)
      .values({
        attemptId,
        authorityGeneration: authority.generation + 1,
        kind: 'connect',
        targetMode: 'hosted',
        targetAccountSubjectId: input.accountSubject,
        targetCredentialSecretRef: 'hosted.session',
        state: 'preparing',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    for (const syncGenerationId of targets)
      await tx.insert(SyncConnectGenerationAttemptTable).values({
        attemptId,
        sourceSyncGenerationId: syncGenerationId,
        state: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    await tx
      .update(SyncAppAuthorityTable)
      .set({ transitionState: 'connecting', targetMode: 'hosted', attemptId, updatedAt: nowIso })
      .where(eq(SyncAppAuthorityTable.id, 'app'));
    input.assertAccount();
    return { attemptId, syncGenerationIds: targets };
  });
}
