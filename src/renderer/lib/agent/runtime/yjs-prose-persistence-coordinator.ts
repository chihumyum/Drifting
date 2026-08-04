/**
 * Provider-neutral durable integration for prepared Yjs prose commands.
 *
 * The coordinator never treats contentJson as prose truth. It captures a
 * stable live/closed/seed Yjs base, validates revision + state-vector +
 * semantic-hash expectations, then commits:
 *
 *   update log + monotonic revision + full snapshot
 *   + materialized projection + caller-owned outbox
 *   + idempotency/reconciliation receipt
 *
 * in one SQLite transaction. Only after that transaction commits is the update
 * merged into an open editor using an "already persisted" origin, preventing
 * the document session from appending it twice.
 */
import { and, eq } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import { getDb, type DbClient, type DbExecutor } from '../../../lib/db';
import { getLiveYDoc } from '../../../lib/yjs-doc-registry';
import { createPersistedYjsUpdateOrigin } from '../../../lib/yjs-persistence-origin';
import {
  YjsProseCommandReceiptTable,
} from '../../../schema/drizzle';
import { flushOpenYjsDocument } from '../../../services/yjs-sync.service';
import {
  createYjsRepository,
  YjsDocumentRevisionConflictError,
  type YjsRepository,
} from '../../../sqlite-repo/yjs-repo';
import {
  applyPreparedYjsProseInverseRebased,
  applyPreparedYjsProseUpdate,
  ensureYjsProseBlockIds,
  hashYjsProseState,
  prepareYjsProseCommand,
  snapshotYjsProseBlocks,
  type PreparedYjsProseCommand,
  type YjsProseBaseExpectation,
  type YjsProseCommandSource,
  type YjsProseOperation,
  type YjsProseProjectionPayload,
  type YjsProseSourceKind,
  type YjsProseUpdateDirection,
} from './yjs-prose-command';

export interface YjsProsePersistenceBase {
  docId: string;
  sourceKind: YjsProseSourceKind;
  revision: number;
  stateVector: Uint8Array;
  stateHash: string;
  /** Full Yjs state. Required to make the seed path independent of contentJson. */
  stateUpdate: Uint8Array;
}

export interface YjsProsePersistenceExpectation
  extends YjsProseBaseExpectation {
  stateHash: string;
}

export interface PreparedYjsProsePersistenceCommand {
  base: YjsProsePersistenceBase;
  prepared: PreparedYjsProseCommand;
}

export interface YjsProseCommandReceipt {
  id: string;
  commandId: string;
  direction: YjsProseUpdateDirection;
  docId: string;
  sourceKind: YjsProseSourceKind;
  baseRevision: number;
  committedRevision: number;
  baseStateVector: Uint8Array;
  baseStateHash: string;
  resultStateVector: Uint8Array;
  resultStateHash: string;
  updateHash: string;
  updateId: number;
  createdAt: string;
}

export interface YjsProseCommitHooks {
  /**
   * Persist contentJson/word-count or another read projection through the
   * entity usecase's transaction-bound repository.
   */
  persistProjection(
    tx: DbExecutor,
    projection: YjsProseProjectionPayload,
  ): Promise<void>;
  /** Persist the local sync/outbox mutation in the exact same transaction. */
  persistOutbox(
    tx: DbExecutor,
    projection: YjsProseProjectionPayload,
  ): Promise<void>;
  /**
   * Runs synchronously after the SQLite transaction commits but immediately
   * before its update enters an open live Y.Doc. The optional returned cleanup
   * runs only when that live merge fails.
   */
  beforeLiveMerge?: () => void | (() => void);
}

export interface PreparePersistedYjsProseCommandInput {
  docId: string;
  commandId: string;
  expectedBase: YjsProsePersistenceExpectation;
  operation: YjsProseOperation;
  /**
   * Full canonical Yjs seed state used only after SQLite and the live registry
   * both prove that the document has no Yjs state.
   */
  seedStateUpdate?: Uint8Array;
}

export interface CommitPreparedYjsProseCommandInput
  extends YjsProseCommitHooks {
  command: PreparedYjsProsePersistenceCommand;
  direction: YjsProseUpdateDirection;
  expectedRevision: number;
}

export interface YjsProseCommitResult {
  outcome: 'committed' | 'duplicate' | 'reconciled';
  receipt: YjsProseCommandReceipt;
  projection: YjsProseProjectionPayload;
  /**
   * True when an editor changed concurrently and Yjs merged both durable
   * updates. In that case the Y.Doc remains truth and its normal materializer
   * refreshes the projection again.
   */
  liveMerged: boolean;
}

export interface YjsProsePersistenceCoordinatorOptions {
  database?: DbClient;
  getLiveDocument?: (docId: string) => Y.Doc | undefined;
  flushLiveDocument?: (docId: string) => Promise<void>;
  now?: () => string;
}

export class YjsProsePersistenceError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code:
      | 'STALE_REVISION'
      | 'STALE_STATE_VECTOR'
      | 'STALE_STATE_HASH'
      | 'MISSING_SEED_STATE'
      | 'CORRUPT_EMPTY_STATE'
      | 'RECEIPT_CONFLICT'
      | 'POST_COMMIT_LIVE_APPLY_FAILED',
    message: string,
    readonly mutationMayHaveCommitted = false,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'YjsProsePersistenceError';
    this.cause = cause;
  }
}

interface CapturedDocument {
  base: YjsProsePersistenceBase;
  doc: Y.Doc;
}

interface TransactionCommit {
  outcome: 'committed' | 'duplicate';
  receipt: YjsProseCommandReceipt;
  projection: YjsProseProjectionPayload;
}

const MAX_LIVE_CAPTURE_ATTEMPTS = 4;

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeBlob(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return copyBytes(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (
    input &&
    typeof input === 'object' &&
    (input as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((input as { data?: unknown }).data)
  ) {
    return Uint8Array.from((input as { data: number[] }).data);
  }
  throw new Error('Unsupported Yjs receipt blob');
}

function assertRevision(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
}

function receiptId(
  commandId: string,
  direction: YjsProseUpdateDirection,
): string {
  return `yjs-prose:${commandId}:${direction}`;
}

function expectedSemanticBase(
  prepared: PreparedYjsProseCommand,
  direction: YjsProseUpdateDirection,
): { stateVector: Uint8Array; stateHash: string } {
  return direction === 'forward'
    ? {
        stateVector: prepared.durableWatermark.baseStateVector,
        stateHash: prepared.durableWatermark.baseStateHash,
      }
    : {
        stateVector: prepared.durableWatermark.forwardStateVector,
        stateHash: prepared.durableWatermark.forwardStateHash,
      };
}

function resultSemanticState(
  prepared: PreparedYjsProseCommand,
  direction: YjsProseUpdateDirection,
): { stateVector: Uint8Array; stateHash: string; updateHash: string } {
  return direction === 'forward'
    ? {
        stateVector: prepared.durableWatermark.forwardStateVector,
        stateHash: prepared.durableWatermark.forwardStateHash,
        updateHash: prepared.durableWatermark.forwardUpdateHash,
      }
    : {
        stateVector: prepared.durableWatermark.inverseStateVector,
        stateHash: prepared.durableWatermark.baseStateHash,
        updateHash: prepared.durableWatermark.inverseUpdateHash,
      };
}

function updateFor(
  prepared: PreparedYjsProseCommand,
  direction: YjsProseUpdateDirection,
): Uint8Array {
  return direction === 'forward'
    ? prepared.forwardUpdate
    : prepared.inverseUpdate;
}

function projectionFromDoc(
  doc: Y.Doc,
  prepared: PreparedYjsProseCommand,
  stateHash: string,
): YjsProseProjectionPayload {
  const blocks = snapshotYjsProseBlocks(doc);
  const document = yDocToProsemirrorJSON(doc, 'default');
  return {
    fragment: 'default',
    contentJson: JSON.stringify(document),
    document,
    blocks,
    allBlockIds: blocks.map((block) => block.id),
    affectedBlockIds: [...prepared.affectedBlockIds],
    stateHash,
    stateVector: Y.encodeStateVector(doc),
  };
}

function receiptFromRow(
  row: typeof YjsProseCommandReceiptTable.$inferSelect,
): YjsProseCommandReceipt {
  return {
    id: row.id,
    commandId: row.commandId,
    direction: row.direction as YjsProseUpdateDirection,
    docId: row.docId,
    sourceKind: row.sourceKind as YjsProseSourceKind,
    baseRevision: row.baseRevision,
    committedRevision: row.committedRevision,
    baseStateVector: normalizeBlob(row.baseStateVector),
    baseStateHash: row.baseStateHash,
    resultStateVector: normalizeBlob(row.resultStateVector),
    resultStateHash: row.resultStateHash,
    updateHash: row.updateHash,
    updateId: row.updateId,
    createdAt: row.createdAt,
  };
}

async function loadPersistedDoc(
  repo: YjsRepository,
  docId: string,
): Promise<{ doc: Y.Doc; hasState: boolean }> {
  const doc = new Y.Doc({ gc: false });
  const snapshot = await repo.getSnapshot(docId);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob, 'load');
  const updates = await repo.listUpdates(docId);
  for (const update of updates) {
    Y.applyUpdate(doc, update.updateBlob, 'load');
  }
  return { doc, hasState: Boolean(snapshot) || updates.length > 0 };
}

export class YjsProsePersistenceCoordinator {
  private readonly databaseOverride?: DbClient;
  private readonly getLiveDocument: (docId: string) => Y.Doc | undefined;
  private readonly flushLiveDocument: (docId: string) => Promise<void>;
  private readonly now: () => string;

  constructor(options: YjsProsePersistenceCoordinatorOptions = {}) {
    this.databaseOverride = options.database;
    this.getLiveDocument = options.getLiveDocument ?? getLiveYDoc;
    this.flushLiveDocument =
      options.flushLiveDocument ?? flushOpenYjsDocument;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async readBase(
    docId: string,
    seedStateUpdate?: Uint8Array,
  ): Promise<YjsProsePersistenceBase> {
    const captured = await this.captureDocument(docId, seedStateUpdate);
    try {
      return {
        ...captured.base,
        stateVector: copyBytes(captured.base.stateVector),
        stateUpdate: copyBytes(captured.base.stateUpdate),
      };
    } finally {
      captured.doc.destroy();
    }
  }

  async prepare(
    input: PreparePersistedYjsProseCommandInput,
  ): Promise<PreparedYjsProsePersistenceCommand> {
    const captured = await this.captureDocument(
      input.docId,
      input.seedStateUpdate,
    );
    try {
      this.assertExpectation(captured.base, input.expectedBase);
      const source: YjsProseCommandSource =
        captured.base.sourceKind === 'live'
          ? {
              kind: 'live',
              doc: captured.doc,
              revision: captured.base.revision,
            }
          : {
              kind: captured.base.sourceKind,
              stateUpdate: captured.base.stateUpdate,
              revision: captured.base.revision,
            };
      const prepared = await prepareYjsProseCommand({
        commandId: input.commandId,
        source,
        expectedBase: {
          revision: input.expectedBase.revision,
          stateVector: input.expectedBase.stateVector,
        },
        operation: input.operation,
      });
      return {
        base: {
          ...captured.base,
          stateVector: copyBytes(captured.base.stateVector),
          stateUpdate: copyBytes(captured.base.stateUpdate),
        },
        prepared,
      };
    } finally {
      captured.doc.destroy();
    }
  }

  async getReceipt(
    commandId: string,
    direction: YjsProseUpdateDirection,
  ): Promise<YjsProseCommandReceipt | null> {
    const rows = await this.database()
      .select()
      .from(YjsProseCommandReceiptTable)
      .where(
        and(
          eq(YjsProseCommandReceiptTable.commandId, commandId),
          eq(YjsProseCommandReceiptTable.direction, direction),
        ),
      )
      .limit(1);
    return rows[0] ? receiptFromRow(rows[0]) : null;
  }

  async commit(
    input: CommitPreparedYjsProseCommandInput,
  ): Promise<YjsProseCommitResult> {
    assertRevision(input.expectedRevision, 'expectedRevision');
    let transactionResult: TransactionCommit;
    let outcome: YjsProseCommitResult['outcome'];
    try {
      transactionResult = await this.database().transaction((tx) =>
        this.commitInTransaction(tx, input),
      );
      outcome = transactionResult.outcome;
    } catch (cause) {
      // A gateway can lose the response after COMMIT. Inspect the durable
      // receipt; never invoke the mutation again merely because the caller saw
      // an exception.
      const reconciled = await this.getReceipt(
        input.command.prepared.commandId,
        input.direction,
      ).catch(() => null);
      if (!reconciled) throw cause;
      this.assertReceiptMatches(reconciled, input);
      transactionResult = {
        outcome: 'duplicate',
        receipt: reconciled,
        projection: await this.projectionForReceipt(input, reconciled),
      };
      outcome = 'reconciled';
    }

    const liveMerged = await this.mergeIntoLiveDocument(
      input,
      transactionResult.receipt,
    );
    return {
      outcome,
      receipt: transactionResult.receipt,
      projection: transactionResult.projection,
      liveMerged,
    };
  }

  private database(): DbClient {
    return this.databaseOverride ?? getDb();
  }

  private async captureDocument(
    docId: string,
    seedStateUpdate?: Uint8Array,
  ): Promise<CapturedDocument> {
    if (!docId.trim()) throw new Error('docId must be non-empty');
    const live = this.getLiveDocument(docId);
    if (live) return this.captureLiveDocument(docId, live);

    return this.database().transaction(async (tx) => {
      const repo = createYjsRepository(tx);
      const { doc, hasState } = await loadPersistedDoc(repo, docId);
      try {
        let revision = await repo.getRevision(docId);
        if (!hasState) {
          if (revision !== 0) {
            throw new YjsProsePersistenceError(
              'CORRUPT_EMPTY_STATE',
              `Yjs document ${docId} has revision ${revision} but no durable state.`,
            );
          }
          if (!seedStateUpdate) {
            throw new YjsProsePersistenceError(
              'MISSING_SEED_STATE',
              `Yjs document ${docId} has no state; a full Yjs seed is required.`,
            );
          }
          Y.applyUpdate(doc, seedStateUpdate, 'seed');
        }
        const blockIdMigration = await ensureYjsProseBlockIds(doc);
        if (hasState && blockIdMigration.changed) {
          const appended = await repo.appendUpdateCas(
            docId,
            blockIdMigration.update,
            revision,
          );
          revision = appended.revision;
          await repo.upsertSnapshot(docId, Y.encodeStateAsUpdate(doc), {
            advanceRevision: false,
          });
        }
        const sourceKind: YjsProseSourceKind = hasState ? 'closed' : 'seed';
        const stateUpdate = Y.encodeStateAsUpdate(doc);
        return {
          doc,
          base: {
            docId,
            sourceKind,
            revision,
            stateVector: Y.encodeStateVector(doc),
            stateHash: await hashYjsProseState(doc),
            stateUpdate,
          },
        };
      } catch (error) {
        doc.destroy();
        throw error;
      }
    });
  }

  private async captureLiveDocument(
    docId: string,
    live: Y.Doc,
  ): Promise<CapturedDocument> {
    for (let attempt = 0; attempt < MAX_LIVE_CAPTURE_ATTEMPTS; attempt += 1) {
      await this.flushLiveDocument(docId);
      const blockIdMigration = await ensureYjsProseBlockIds(live);
      if (blockIdMigration.changed) await this.flushLiveDocument(docId);
      const repository = createYjsRepository(this.database());
      const revisionBefore = await repository.getRevision(docId);
      const stateUpdate = Y.encodeStateAsUpdate(live);
      const stateVector = Y.encodeStateVector(live);
      const clone = new Y.Doc({ gc: false });
      Y.applyUpdate(clone, stateUpdate, 'capture');
      const stateHash = await hashYjsProseState(clone);
      await this.flushLiveDocument(docId);
      const revisionAfter = await repository.getRevision(docId);
      if (
        revisionBefore === revisionAfter &&
        bytesEqual(stateVector, Y.encodeStateVector(live))
      ) {
        return {
          doc: clone,
          base: {
            docId,
            sourceKind: 'live',
            revision: revisionAfter,
            stateVector,
            stateHash,
            stateUpdate,
          },
        };
      }
      clone.destroy();
    }
    throw new YjsProsePersistenceError(
      'STALE_REVISION',
      `Yjs document ${docId} kept changing while preparing the command.`,
    );
  }

  private assertExpectation(
    actual: YjsProsePersistenceBase,
    expected: YjsProsePersistenceExpectation,
  ): void {
    assertRevision(expected.revision, 'expectedBase.revision');
    if (actual.revision !== expected.revision) {
      throw new YjsProsePersistenceError(
        'STALE_REVISION',
        `Expected revision ${expected.revision}, received ${actual.revision}.`,
      );
    }
    if (!bytesEqual(actual.stateVector, expected.stateVector)) {
      throw new YjsProsePersistenceError(
        'STALE_STATE_VECTOR',
        'The prose state vector changed before command preparation.',
      );
    }
    if (actual.stateHash !== expected.stateHash) {
      throw new YjsProsePersistenceError(
        'STALE_STATE_HASH',
        'The prose semantic state changed before command preparation.',
      );
    }
  }

  private async commitInTransaction(
    tx: DbExecutor,
    input: CommitPreparedYjsProseCommandInput,
  ): Promise<TransactionCommit> {
    const existing = await this.getReceiptFrom(
      tx,
      input.command.prepared.commandId,
      input.direction,
    );
    if (existing) {
      this.assertReceiptMatches(existing, input);
      return {
        outcome: 'duplicate',
        receipt: existing,
        projection: await this.projectionForReceipt(input, existing, tx),
      };
    }

    const repo = createYjsRepository(tx);
    const revision = await repo.getRevision(input.command.base.docId);
    const rebasedInverse =
      input.direction === 'inverse' && revision > input.expectedRevision;
    if (revision !== input.expectedRevision && !rebasedInverse) {
      throw new YjsDocumentRevisionConflictError(
        input.command.base.docId,
        input.expectedRevision,
        revision,
      );
    }
    const loaded = await loadPersistedDoc(repo, input.command.base.docId);
    const doc = loaded.doc;
    try {
      if (!loaded.hasState) {
        if (
          input.direction !== 'forward' ||
          input.command.base.sourceKind !== 'seed' ||
          input.expectedRevision !== 0
        ) {
          throw new YjsProsePersistenceError(
            'CORRUPT_EMPTY_STATE',
            `Yjs document ${input.command.base.docId} lost its durable state.`,
          );
        }
        Y.applyUpdate(doc, input.command.base.stateUpdate, 'seed');
      }

      const expected = expectedSemanticBase(
        input.command.prepared,
        input.direction,
      );
      const baseStateVector = Y.encodeStateVector(doc);
      const baseHash = await hashYjsProseState(doc);
      let resultHash: string;
      if (rebasedInverse) {
        resultHash = await applyPreparedYjsProseInverseRebased(
          doc,
          input.command.prepared,
        );
      } else {
        if (!bytesEqual(baseStateVector, expected.stateVector)) {
          throw new YjsProsePersistenceError(
            'STALE_STATE_VECTOR',
            'The durable prose state vector changed before commit.',
          );
        }
        if (baseHash !== expected.stateHash) {
          throw new YjsProsePersistenceError(
            'STALE_STATE_HASH',
            'The durable prose semantic state changed before commit.',
          );
        }
        resultHash = await applyPreparedYjsProseUpdate(
          doc,
          input.command.prepared,
          input.direction,
        );
      }
      const update = updateFor(input.command.prepared, input.direction);
      const appended = await repo.appendUpdateCas(
        input.command.base.docId,
        update,
        revision,
      );
      await repo.upsertSnapshot(
        input.command.base.docId,
        Y.encodeStateAsUpdate(doc),
        { advanceRevision: false },
      );
      const projection = projectionFromDoc(
        doc,
        input.command.prepared,
        resultHash,
      );
      await input.persistProjection(tx, projection);
      await input.persistOutbox(tx, projection);

      const preparedResult = resultSemanticState(
        input.command.prepared,
        input.direction,
      );
      const resultStateVector = Y.encodeStateVector(doc);
      const receipt: YjsProseCommandReceipt = {
        id: receiptId(
          input.command.prepared.commandId,
          input.direction,
        ),
        commandId: input.command.prepared.commandId,
        direction: input.direction,
        docId: input.command.base.docId,
        sourceKind: input.command.base.sourceKind,
        baseRevision: revision,
        committedRevision: appended.revision,
        baseStateVector: copyBytes(baseStateVector),
        baseStateHash: baseHash,
        resultStateVector: copyBytes(resultStateVector),
        resultStateHash: resultHash,
        updateHash: preparedResult.updateHash,
        updateId: appended.updateId,
        createdAt: this.now(),
      };
      await tx.insert(YjsProseCommandReceiptTable).values({
        ...receipt,
        baseStateVector: copyBytes(receipt.baseStateVector),
        resultStateVector: copyBytes(receipt.resultStateVector),
      });
      return { outcome: 'committed', receipt, projection };
    } finally {
      doc.destroy();
    }
  }

  private async getReceiptFrom(
    tx: DbExecutor,
    commandId: string,
    direction: YjsProseUpdateDirection,
  ): Promise<YjsProseCommandReceipt | null> {
    const rows = await tx
      .select()
      .from(YjsProseCommandReceiptTable)
      .where(
        and(
          eq(YjsProseCommandReceiptTable.commandId, commandId),
          eq(YjsProseCommandReceiptTable.direction, direction),
        ),
      )
      .limit(1);
    return rows[0] ? receiptFromRow(rows[0]) : null;
  }

  private assertReceiptMatches(
    receipt: YjsProseCommandReceipt,
    input: CommitPreparedYjsProseCommandInput,
  ): void {
    const expected = expectedSemanticBase(
      input.command.prepared,
      input.direction,
    );
    const result = resultSemanticState(
      input.command.prepared,
      input.direction,
    );
    const rebasedInverse =
      input.direction === 'inverse' &&
      receipt.baseRevision > input.expectedRevision;
    const exactSemanticReceipt = !rebasedInverse;
    if (
      receipt.docId !== input.command.base.docId ||
      receipt.commandId !== input.command.prepared.commandId ||
      receipt.direction !== input.direction ||
      receipt.sourceKind !== input.command.base.sourceKind ||
      (receipt.baseRevision !== input.expectedRevision && !rebasedInverse) ||
      receipt.committedRevision !== receipt.baseRevision + 1 ||
      receipt.updateHash !== result.updateHash ||
      (exactSemanticReceipt &&
        (receipt.baseStateHash !== expected.stateHash ||
          !bytesEqual(receipt.baseStateVector, expected.stateVector) ||
          receipt.resultStateHash !== result.stateHash ||
          !bytesEqual(receipt.resultStateVector, result.stateVector)))
    ) {
      throw new YjsProsePersistenceError(
        'RECEIPT_CONFLICT',
        `Yjs prose receipt ${receipt.id} does not match the prepared command.`,
        true,
      );
    }
  }

  private async projectionForReceipt(
    input: CommitPreparedYjsProseCommandInput,
    receipt: YjsProseCommandReceipt,
    tx?: DbExecutor,
  ): Promise<YjsProseProjectionPayload> {
    const executor = tx ?? this.database();
    const loaded = await loadPersistedDoc(
      createYjsRepository(executor),
      receipt.docId,
    );
    try {
      const stateHash = await hashYjsProseState(loaded.doc);
      if (stateHash !== receipt.resultStateHash) {
        // A later edit is valid. The duplicate command remains settled; return
        // the current Yjs projection rather than replaying its callbacks.
        return projectionFromDoc(
          loaded.doc,
          input.command.prepared,
          stateHash,
        );
      }
      return projectionFromDoc(
        loaded.doc,
        input.command.prepared,
        receipt.resultStateHash,
      );
    } finally {
      loaded.doc.destroy();
    }
  }

  private async mergeIntoLiveDocument(
    input: CommitPreparedYjsProseCommandInput,
    receipt: YjsProseCommandReceipt,
  ): Promise<boolean> {
    const live = this.getLiveDocument(receipt.docId);
    if (!live) return false;
    let rollbackPresentation: (() => void) | undefined;
    try {
      rollbackPresentation = input.beforeLiveMerge?.() ?? undefined;
      Y.applyUpdate(
        live,
        updateFor(input.command.prepared, input.direction),
        createPersistedYjsUpdateOrigin(receipt.updateId, receipt.id),
      );
      return (await hashYjsProseState(live)) !== receipt.resultStateHash;
    } catch (cause) {
      rollbackPresentation?.();
      throw new YjsProsePersistenceError(
        'POST_COMMIT_LIVE_APPLY_FAILED',
        `Yjs command ${receipt.commandId} committed but could not merge into the live editor.`,
        true,
        cause,
      );
    }
  }
}

export function createYjsProsePersistenceCoordinator(
  options?: YjsProsePersistenceCoordinatorOptions,
): YjsProsePersistenceCoordinator {
  return new YjsProsePersistenceCoordinator(options);
}
