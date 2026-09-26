import { registerAuthoredYjsMaterialization } from './yjs-materialization';
import {
  createYjsRepository,
  type YjsRevisionSource,
} from '../../sqlite-repo/yjs-repo';
import type { DbExecutor } from '../../lib/db';
import { proseDocId, type ProseEntityType } from '../../lib/yjs-doc-id';
import {
  runAuthoredTransaction,
  type AuthoredCommandKind,
  type AuthoredTransactionContext,
} from './authored-transaction';
import type { SyncChangeBuilder } from './change-builder';
import {
  parseYjsUpdatePayload,
  type YjsSourceRetentionProvenanceV1,
} from '../protocol/yjs-update-payload';
import type { CanonicalCborValue } from '../protocol/primitives';

export interface AuthoredYjsUpdateResult {
  readonly updateId: number;
}

export interface AuthoredProseStateResult extends AuthoredYjsUpdateResult {
  readonly docId: string;
  readonly revision: number;
}

export type AuthoredTransactionRunner = <T>(
  projectId: string,
  command: AuthoredCommandKind,
  work: (context: AuthoredTransactionContext) => Promise<T>,
) => Promise<T>;

export type AuthoredYjsUpdateWriter = (
  projectId: string,
  docId: string,
  update: Uint8Array,
  source?: YjsRevisionSource,
  sourceRetentionProvenance?: YjsSourceRetentionProvenanceV1,
) => Promise<AuthoredYjsUpdateResult>;

function assertYjsUpdateIdentity(docId: string, update: Uint8Array): void {
  if (!docId.trim()) throw new TypeError('Yjs document id is required');
  if (!(update instanceof Uint8Array) || update.byteLength === 0) {
    throw new TypeError('Yjs update must be a non-empty Uint8Array');
  }
}

/**
 * Append the wire mutation for an update already being persisted by the same
 * SQLite transaction. An explicit transaction/state-transfer supplement is
 * immutable evidence, not authorization to interpret its DeleteSet as author
 * intent. Local revision source labels remain device-local metadata.
 */
export function appendYjsUpdateMutation(
  changes: SyncChangeBuilder,
  docId: string,
  update: Uint8Array,
  sourceRetentionProvenance?: YjsSourceRetentionProvenanceV1,
): number {
  assertYjsUpdateIdentity(docId, update);
  const payload = copyYjsPayload(update, sourceRetentionProvenance);
  return changes.add({
    action: 'yjs.update',
    target: {
      family: 'yjs',
      kind: 'prose-document',
      id: docId,
      incarnation: 0,
    },
    payload,
  });
}

function copyYjsPayload(
  update: Uint8Array,
  sourceRetentionProvenance?: YjsSourceRetentionProvenanceV1,
): { update: Uint8Array; sourceRetentionProvenance?: YjsSourceRetentionProvenanceV1 } & CanonicalCborValue {
  const parsed = parseYjsUpdatePayload(sourceRetentionProvenance === undefined
    ? { update }
    : { update, sourceRetentionProvenance });
  // Construct CBOR records explicitly; optional undefined values must never
  // change the frozen legacy payload { update }.
  const evidence = parsed.sourceRetentionProvenance;
  if (!evidence) return { update: parsed.update };
  if (evidence.kind === 'state-transfer') {
    return { update: parsed.update, sourceRetentionProvenance: { ...evidence } };
  }
  return { update: parsed.update, sourceRetentionProvenance: {
    ...evidence, transactionDeletes: evidence.transactionDeletes.map(range => ({ ...range })),
  } };
}

/**
 * Persist the deterministic full Yjs seed for a newly created prose owner.
 *
 * The owner row, update row, revision/provenance and yjs.update mutation all
 * share the caller's authored SQLite transaction. A pre-existing document is
 * corruption for a new logical entity and is rejected instead of merged.
 */
export async function appendAuthoredProseSeedInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly entityType: ProseEntityType;
    readonly entityId: string;
    readonly stateUpdate: Uint8Array;
    readonly source?: YjsRevisionSource;
  },
): Promise<AuthoredProseStateResult> {
  const docId = proseDocId(input.entityType, input.entityId);
  assertYjsUpdateIdentity(docId, input.stateUpdate);
  const repository = createYjsRepository(tx);
  const [hasState, revision] = await Promise.all([
    repository.hasDocState(docId),
    repository.getRevision(docId),
  ]);
  if (hasState || revision !== 0) {
    throw new Error(`Cannot seed existing Yjs document ${docId}`);
  }
  const index = appendYjsUpdateMutation(changes, docId, input.stateUpdate);
  const appended = await repository.appendMaterializedUpdate(
    docId,
    input.stateUpdate,
    { kind: 'authored', builder: changes, mutationIndex: index },
    input.source ?? { kind: 'system' },
    0,
  );
  registerAuthoredYjsMaterialization(tx, changes, index, appended.token);
  return { docId, updateId: appended.updateId, revision: appended.revision };
}

/**
 * Persist a complete current Yjs state as the restore operation for a new
 * lifecycle incarnation. This intentionally advances local revision and
 * provenance even when the CRDT state is semantically identical: the row is
 * the durable local receipt for the authored restore generation.
 */
export async function appendAuthoredProseRestoreStateInTransaction(
  tx: DbExecutor,
  changes: SyncChangeBuilder,
  input: {
    readonly entityType: ProseEntityType;
    readonly entityId: string;
    readonly stateUpdate: Uint8Array;
    readonly source?: YjsRevisionSource;
  },
): Promise<AuthoredProseStateResult> {
  const docId = proseDocId(input.entityType, input.entityId);
  assertYjsUpdateIdentity(docId, input.stateUpdate);
  const repository = createYjsRepository(tx);
  const index = appendYjsUpdateMutation(changes, docId, input.stateUpdate);
  const appended = await repository.appendMaterializedUpdate(
    docId,
    input.stateUpdate,
    { kind: 'authored', builder: changes, mutationIndex: index },
    input.source ?? { kind: 'system' },
  );
  registerAuthoredYjsMaterialization(tx, changes, index, appended.token);
  return { docId, updateId: appended.updateId, revision: appended.revision };
}

/**
 * Build the ordinary editor/manual Yjs write path. The update-log row,
 * monotonic revision, local provenance, writer sequence, change-set and apply
 * receipt all commit or roll back together under one authored transaction.
 */
export function createAuthoredYjsUpdateWriter(
  runTransaction: AuthoredTransactionRunner = runAuthoredTransaction,
): AuthoredYjsUpdateWriter {
  return async function appendAuthoredYjsUpdate(
    projectId,
    docId,
    update,
    source = { kind: 'user' },
    sourceRetentionProvenance,
  ) {
    assertYjsUpdateIdentity(docId, update);
    // Snapshot explicit evidence before crossing the asynchronous SQLite
    // scheduler; a subsequent edit cannot alter the operation being queued.
    const payload = copyYjsPayload(update, sourceRetentionProvenance);
    return runTransaction(projectId, 'yjs.update', async ({ tx, changes }) => {
      const index = appendYjsUpdateMutation(
        changes,
        docId,
        payload.update,
        payload.sourceRetentionProvenance,
      );
      const appended = await createYjsRepository(tx).appendMaterializedUpdate(
        docId,
        payload.update,
        { kind: 'authored', builder: changes, mutationIndex: index },
        source,
      );
      registerAuthoredYjsMaterialization(tx, changes, index, appended.token);
      return { updateId: appended.updateId };
    });
  };
}

export const appendAuthoredYjsUpdate = createAuthoredYjsUpdateWriter();
