import { readNewAuthoredMaterializationOriginal } from '../sync/journal/repository';
import {
  readMaterializationAppend,
  consumeMaterializationAppend,
  type YjsMaterializationBinding,
  type YjsMaterializationToken,
} from './yjs-repo';
import { and, asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../lib/db';
import {
  SyncChangeSetTable,
  SyncMutationTable,
  SyncYjsMaterializationReceiptTable,
  YjsDocumentRevisionProvenanceTable,
  YjsDocumentRevisionTable,
  yjsUpdates,
} from '../schema/drizzle';
import { decodeSyncChangeSetV1 } from '../sync/protocol/change-set';
import { encodeCanonicalCbor, sha256Bytes } from '../sync/protocol/canonical-cbor';
import { parseYjsUpdatePayload } from '../sync/protocol/yjs-update-payload';

function identical(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${field} must be a positive safe integer`);
}
export interface YjsMaterializationReceiptInput {
  readonly changeSetId: string;
  readonly mutationIndex: number;
  readonly token: YjsMaterializationToken;
  readonly binding: YjsMaterializationBinding;
  readonly createdAt: string;
}

function prepareReceipt(tx: DbExecutor, value: YjsMaterializationReceiptInput) {
  // Own the binding before asynchronous journal reads; preserve opaque identities.
  const input = { ...value, binding: { ...value.binding } };
  const appended = readMaterializationAppend(tx, input.token, input.binding);
  if (
    input.binding.mutationIndex !== input.mutationIndex ||
    (input.binding.kind === 'remote' && input.binding.changeSetId !== input.changeSetId)
  )
    throw new Error('Materialization original differs from append binding');
  positive(appended.updateId, 'updateId');
  positive(appended.revision, 'revision');
  if (!Number.isSafeInteger(input.mutationIndex) || input.mutationIndex < 0)
    throw new TypeError('mutationIndex must be a nonnegative safe integer');
  const authored =
    input.binding.kind === 'authored'
      ? readNewAuthoredMaterializationOriginal(tx, input.binding.builder)
      : null;
  if (authored && authored.changeSetId !== input.changeSetId)
    throw new Error('Authored materialization cannot be rebound to another original');
  return { input, appended, authored };
}

async function verifyOriginal(tx: DbExecutor, changeSetId: string) {
  const [stored] = await tx
    .select()
    .from(SyncChangeSetTable)
    .where(eq(SyncChangeSetTable.changeSetId, changeSetId));
  if (!stored) throw new Error('Materialized original is unavailable');
  const encoded = new Uint8Array(stored.encodedBytes as Uint8Array);
  const decoded = await decodeSyncChangeSetV1(encoded);
  if (!decoded.ok) throw new Error(`Materialized original is invalid: ${decoded.reason}`);
  const original = decoded.value;
  const envelopeHash = (await sha256Bytes(encoded)).slice(7);
  if (
    stored.writerId !== original.writerId ||
    stored.writerEpoch !== original.writerEpoch ||
    stored.deviceSeq !== original.deviceSeq ||
    stored.hlcWallMs !== original.hlc.wallMs ||
    stored.hlcCounter !== original.hlc.counter ||
    stored.protocolVersion !== original.protocolVersion ||
    stored.payloadVersion !== original.payloadVersion
  )
    throw new Error('Materialized original protocol columns do not match canonical bytes');
  if (
    stored.payloadSha256 !== envelopeHash ||
    stored.changeSetId !== original.changeSetId ||
    stored.projectId !== original.projectId ||
    stored.projectSyncId !== original.projectSyncId ||
    stored.syncGenerationId !== original.syncGenerationId ||
    stored.mutationCount !== original.mutations.length
  )
    throw new Error('Materialized original header does not match canonical bytes');
  const mutations = await tx
    .select()
    .from(SyncMutationTable)
    .where(eq(SyncMutationTable.changeSetId, changeSetId))
    .orderBy(asc(SyncMutationTable.mutationIndex));
  if (mutations.length !== original.mutations.length)
    throw new Error('Materialized original mutations are incomplete');
  original.mutations.forEach((mutation, index) => {
    const row = mutations[index]!;
    if (
      row.mutationIndex !== mutation.index ||
      row.action !== mutation.action ||
      row.targetFamily !== mutation.target.family ||
      row.targetKind !== mutation.target.kind ||
      row.targetId !== mutation.target.id ||
      row.incarnation !== mutation.target.incarnation ||
      row.payloadVersion !== mutation.payloadVersion ||
      row.payloadSha256 !== mutation.payloadSha256.slice(7) ||
      !identical(
        new Uint8Array(row.payloadCbor as Uint8Array),
        encodeCanonicalCbor(mutation.payload),
      )
    )
      throw new Error('Materialized mutation differs from its canonical original');
  });
  return { original, envelopeHash };
}

async function insertPreparedReceipt(
  tx: DbExecutor,
  prepared: ReturnType<typeof prepareReceipt>,
  verified: Awaited<ReturnType<typeof verifyOriginal>>,
): Promise<void> {
  const { input, appended, authored } = prepared;
  const { original, envelopeHash } = verified;
  if (authored && authored.envelopeSha256 !== envelopeHash) {
    throw new Error('Authored materialization envelope differs from newly inserted original');
  }
  const mutation = original.mutations[input.mutationIndex];
  if (
    !mutation ||
    mutation.index !== input.mutationIndex ||
    mutation.action !== 'yjs.update' ||
    mutation.target.family !== 'yjs' ||
    mutation.target.kind !== 'prose-document' ||
    mutation.target.id !== appended.docId
  )
    throw new Error('Materialization does not select its exact prose mutation');
  const event = parseYjsUpdatePayload(mutation.payload).update;
  if (!identical(event, appended.event))
    throw new Error('Materialization event differs from actual appended event');
  const [raw] = await tx
    .select()
    .from(yjsUpdates)
    .where(and(eq(yjsUpdates.id, appended.updateId), eq(yjsUpdates.docId, appended.docId)));
  const [revision] = await tx
    .select()
    .from(YjsDocumentRevisionTable)
    .where(eq(YjsDocumentRevisionTable.docId, appended.docId));
  const [provenance] = await tx
    .select()
    .from(YjsDocumentRevisionProvenanceTable)
    .where(
      and(
        eq(YjsDocumentRevisionProvenanceTable.docId, appended.docId),
        eq(YjsDocumentRevisionProvenanceTable.revision, appended.revision),
      ),
    );
  if (
    !raw ||
    !identical(new Uint8Array(raw.updateBlob as Uint8Array), event) ||
    !revision ||
    revision.revision < appended.revision ||
    !provenance
  )
    throw new Error('Materialization lacks its actual prose row and historical revision');
  readMaterializationAppend(tx, input.token, input.binding);
  await tx.insert(SyncYjsMaterializationReceiptTable).values({
    changeSetId: original.changeSetId,
    mutationIndex: mutation.index,
    admissionVersion: 1,
    originalEnvelopeSha256: envelopeHash,
    documentId: appended.docId,
    incarnation: mutation.target.incarnation,
    eventSha256: (await sha256Bytes(event)).slice(7),
    updateRowId: appended.updateId,
    documentRevision: appended.revision,
    createdAt: input.createdAt,
  });
  consumeMaterializationAppend(tx, input.token, input.binding);
}

/** Verify a single immutable envelope once for this batch. Each append still
 * supplies its own transaction-bound token, exact raw row and historical revision.
 * The caller's transaction owns rollback if any receipt fails to insert. */
export async function insertYjsMaterializationReceiptsInTransaction(
  tx: DbExecutor,
  inputs: readonly YjsMaterializationReceiptInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const prepared = inputs.map((input) => prepareReceipt(tx, input));
  const changeSetId = prepared[0]!.input.changeSetId;
  const indices = new Set<number>();
  const tokens = new Set<YjsMaterializationToken>();
  for (const { input } of prepared) {
    if (input.changeSetId !== changeSetId) {
      throw new Error('Materialization batch must belong to one original');
    }
    if (indices.has(input.mutationIndex) || tokens.has(input.token)) {
      throw new Error('Materialization batch repeats a mutation or append token');
    }
    indices.add(input.mutationIndex);
    tokens.add(input.token);
  }
  const verified = await verifyOriginal(tx, changeSetId);
  for (const receipt of prepared) {
    await insertPreparedReceipt(tx, receipt, verified);
  }
}

/** Single-append adapter for the remote reducer and callers without a batch. */
export async function insertYjsMaterializationReceiptInTransaction(
  tx: DbExecutor,
  input: YjsMaterializationReceiptInput,
): Promise<void> {
  await insertYjsMaterializationReceiptsInTransaction(tx, [input]);
}
