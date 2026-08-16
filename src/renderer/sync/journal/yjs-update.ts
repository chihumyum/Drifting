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
) => Promise<AuthoredYjsUpdateResult>;

function assertYjsUpdateIdentity(docId: string, update: Uint8Array): void {
  if (!docId.trim()) throw new TypeError('Yjs document id is required');
  if (!(update instanceof Uint8Array) || update.byteLength === 0) {
    throw new TypeError('Yjs update must be a non-empty Uint8Array');
  }
}

/**
 * Append the wire mutation for an update already being persisted by the same
 * SQLite transaction. The journal carries only the document identity and raw
 * Yjs bytes; local revision/provenance rows remain device-local metadata.
 */
export function appendYjsUpdateMutation(
  changes: SyncChangeBuilder,
  docId: string,
  update: Uint8Array,
): void {
  assertYjsUpdateIdentity(docId, update);
  changes.add({
    action: 'yjs.update',
    target: {
      family: 'yjs',
      kind: 'prose-document',
      id: docId,
      incarnation: 0,
    },
    payload: { update: new Uint8Array(update) },
  });
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
  const appended = await repository.appendUpdateCas(
    docId,
    new Uint8Array(input.stateUpdate),
    0,
    input.source ?? { kind: 'system' },
  );
  appendYjsUpdateMutation(changes, docId, input.stateUpdate);
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
  const updateId = await repository.appendUpdate(
    docId,
    new Uint8Array(input.stateUpdate),
    input.source ?? { kind: 'system' },
  );
  const revision = await repository.getRevision(docId);
  appendYjsUpdateMutation(changes, docId, input.stateUpdate);
  return { docId, updateId, revision };
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
  ) {
    assertYjsUpdateIdentity(docId, update);
    const updateCopy = new Uint8Array(update);
    return runTransaction(projectId, 'yjs.update', async ({ tx, changes }) => {
      const updateId = await createYjsRepository(tx).appendUpdate(
        docId,
        updateCopy,
        source,
      );
      appendYjsUpdateMutation(changes, docId, updateCopy);
      return { updateId };
    });
  };
}

export const appendAuthoredYjsUpdate = createAuthoredYjsUpdateWriter();
