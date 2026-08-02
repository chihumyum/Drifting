import { and, eq, or } from 'drizzle-orm';

import type {
  AgentRuntimeElementPatchSnapshot,
  PersistedAgentRuntimeElementPatchReceipt,
} from '../../../domain/agent-runtime-element-patch-receipt';
import { snapshotElementPatch } from '../../../domain/agent-runtime-element-patch-receipt';
import type { PersistedAgentRuntimeWriteExpectation } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import { createPlainCommentDoc } from '../../../domain/comment';
import {
  getDb,
  type DbExecutor,
  type DbTransaction,
} from '../../../lib/db';
import {
  CommentTable,
  ElementPatchTable,
  EntityRelationTable,
} from '../../../schema/drizzle';
import {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
} from '../../../services/entity-sync.service';
import {
  createAgentRuntimeElementPatchReceiptRepository,
  type AgentRuntimeElementPatchReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-element-patch-receipt-repo';
import {
  createElementPatchRepository,
  type CreatePatchInput,
  type ElementPatch,
  type UpdatePatchInput,
} from '../../../sqlite-repo/element-patch-repo';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { useDataStore } from '../../../store/data-store';
import {
  createElementPatchWithSync,
  deleteElementPatchWithSync,
  updateElementPatchWithSync,
  type ElementPatchAtomicTransactionRunner,
} from '../../../usecase/synced-entity-commands';
import { effectiveAgentEditMode } from '../agent-edit-mode';
import { eventBus } from '../../events';
import { pendingDeletedPatchIds } from '../tool-handlers';
import { throwIfAgentAborted } from './errors';
import {
  deterministicElementPatchId,
  elementPatchRevision,
  elementPatchSetRevision,
  hashElementPatchValue,
} from './element-patch-revision';
import type {
  DriftingWriteStrategy,
} from './drifting-write-strategies';
import type { AgentToolExecutionRequest } from './types';

type CertifiedPatchTool =
  | 'create_element_patch'
  | 'update_element_patch'
  | 'delete_element_patch';

interface ElementPatchCommandPayload {
  kind: 'element_patch_command';
  commandId: string;
  effectId: string;
  toolName: CertifiedPatchTool;
  projectId: string;
  elementId: string;
  patchId: string;
  expectedEntityKind: 'element_patch_set' | 'element_patch';
  expectedRevision: string;
  create: CreatePatchInput | null;
  update: UpdatePatchInput | null;
  preimage: AgentRuntimeElementPatchSnapshot | null;
  reviewSnapshot: {
    version: 1;
    effectId: string;
    reviewId: string;
    mode: 'auto' | 'approve';
  };
}

interface ElementPatchHandlerResult {
  ok: true;
  patchId: string;
  element: string;
  title?: string | null;
}

export interface ElementPatchStrategyOptions {
  freshness: AgentRuntimeFreshnessRepository;
  db?: DbExecutor;
  receipts?: AgentRuntimeElementPatchReceiptRepository;
  now?: () => string;
  persistSyncMutation?: typeof persistSyncMutationInTransaction;
  notifySyncCommitted?: typeof notifySyncMutationCommitted;
}

interface AtomicPatchResult {
  receipt: PersistedAgentRuntimeElementPatchReceipt;
  syncPersisted: boolean;
}

export function createDriftingElementPatchWriteStrategy(
  toolName: CertifiedPatchTool,
  options: ElementPatchStrategyOptions,
): DriftingWriteStrategy {
  const db = options.db ?? getDb();
  const receipts =
    options.receipts ??
    createAgentRuntimeElementPatchReceiptRepository(db);
  const now = options.now ?? (() => new Date().toISOString());
  const persistSyncMutation =
    options.persistSyncMutation ?? persistSyncMutationInTransaction;
  const notifySyncCommitted =
    options.notifySyncCommitted ?? notifySyncMutationCommitted;

  return {
    async prepare(request, _context, expectation) {
      throwIfAgentAborted(request.signal);
      const payload = await preparePayload(
        toolName,
        request,
        expectation,
        db,
      );
      return {
        observedRevision: payload.expectedRevision,
        preimage: payload.preimage,
        forward: payload,
        inverse: payload,
        reversibility: 'exact',
      };
    },

    async applyForward(request, _context, prepared) {
      throwIfAgentAborted(request.signal);
      const payload = parsePayload(prepared.forward, toolName);
      const committed = await options.freshness.executeGuardedMutation({
        effectId: payload.effectId,
        projectId: payload.projectId,
        sessionId: request.sessionId,
        readCurrentVersion: async (tx, expectation) =>
          readCurrentVersion(tx, expectation, payload),
        mutate: async (tx) =>
          applyForwardInTransaction(
            tx,
            payload,
            request,
            now,
            persistSyncMutation,
          ),
      });
      runPostCommitEffects(
        payload,
        committed.syncPersisted,
        notifySyncCommitted,
      );
      return handlerResult(payload, committed.receipt);
    },

    async captureEffect(_request, _context, result, prepared) {
      const payload = parsePayload(prepared.forward, toolName);
      const handler = parseHandlerResult(result, payload);
      const receipt = await receipts.get(payload.commandId, 'forward');
      assertReceiptMatchesPayload(receipt, payload, 'forward');
      return committedEffect(payload, receipt, handler);
    },

    async reconcileEnteredEffect(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.forward, toolName);
      assertEffectMatchesPayload(effect, payload);
      const receipt = await receipts.get(payload.commandId, 'forward');
      if (!receipt) return null;
      assertReceiptMatchesPayload(receipt, payload, 'forward');
      eventBus.emit('element:patches-changed', {
        elementId: payload.elementId,
      });
      const result = handlerResult(payload, receipt);
      return {
        handlerResult: result,
        committedEffect: {
          ...committedEffect(payload, receipt, result),
          reconciled: true,
        },
      };
    },

    async applyInverse(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.inverse, toolName);
      assertEffectMatchesPayload(effect, payload);
      const forwardReceipt = await receipts.get(payload.commandId, 'forward');
      assertReceiptMatchesPayload(forwardReceipt, payload, 'forward');
      const existingInverse = await receipts.get(payload.commandId, 'inverse');
      if (existingInverse) {
        assertReceiptMatchesPayload(existingInverse, payload, 'inverse');
        emitPatchChanged(payload.elementId);
        return inverseEffect(existingInverse, true);
      }

      const committed = await db.transaction(
        async (tx) =>
          applyInverseInTransaction(
            tx,
            payload,
            effect,
            forwardReceipt,
            now,
            persistSyncMutation,
          ),
        { behavior: 'immediate' },
      );
      notifyCommittedSafely(committed.syncPersisted, notifySyncCommitted);
      emitPatchChanged(payload.elementId);
      return inverseEffect(committed.receipt, false);
    },
  };
}

async function preparePayload(
  toolName: CertifiedPatchTool,
  request: AgentToolExecutionRequest,
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  db: DbExecutor,
): Promise<ElementPatchCommandPayload> {
  const projectId = request.context.route.projectId;
  if (!projectId) throw new Error(`${toolName} requires a project route`);
  const commandId = `agent-element-patch:${request.idempotencyKey}`;
  const effectId = `agent-write:${request.idempotencyKey}`;
  const reviewSnapshot = {
    version: 1 as const,
    effectId,
    reviewId: `agent-review:${effectId}`,
    mode: effectiveAgentEditMode(),
  };

  if (toolName === 'create_element_patch') {
    const element = resolveProjectElement(projectId, request.arguments.element);
    requireExpectation(
      expectation,
      request,
      'element_patch_set',
      element.id,
    );
    const pendingDeletes = pendingDeletedPatchIds(element.id);
    const patches = (await createElementPatchRepository(db).listByElement(
      element.id,
    )).filter(
      (patch) =>
        patch.projectId === projectId &&
        !patch.invalidatedAt &&
        !pendingDeletes.has(patch.id),
    );
    const currentRevision = await elementPatchSetRevision(patches);
    assertExpectedRevision(expectation, currentRevision);
    const sourceNodeId = resolveOptionalSourceNode(
      projectId,
      request.arguments.sourceChapter,
    );
    const input: CreatePatchInput = {
      id: await deterministicElementPatchId(request.idempotencyKey),
      projectId,
      elementId: element.id,
      ...(typeof request.arguments.title === 'string'
        ? { title: request.arguments.title }
        : {}),
      ...(typeof request.arguments.body === 'string' &&
      request.arguments.body.trim()
        ? { contentJson: createPlainCommentDoc(request.arguments.body) }
        : {}),
      ...(sourceNodeId ? { sourceNodeId } : {}),
    };
    return {
      kind: 'element_patch_command',
      commandId,
      effectId,
      toolName,
      projectId,
      elementId: element.id,
      patchId: input.id!,
      expectedEntityKind: 'element_patch_set',
      expectedRevision: expectation!.expectedRevision,
      create: input,
      update: null,
      preimage: null,
      reviewSnapshot,
    };
  }

  const patchId = requiredString(
    request.arguments.patchId,
    `${toolName} requires patchId`,
  );
  const before = await createElementPatchRepository(db).findById(patchId);
  if (!before || before.projectId !== projectId) {
    throw new Error(`No element patch "${patchId}" exists in this project`);
  }
  if (before.invalidatedAt || pendingDeletedPatchIds(before.elementId).has(before.id)) {
    throw new Error(
      `Element patch "${patchId}" is not available for Agent changes`,
    );
  }
  requireExpectation(expectation, request, 'element_patch', patchId);
  assertExpectedRevision(expectation, await elementPatchRevision(before));
  if (toolName === 'delete_element_patch') {
    await assertPatchDeleteAllowed(db, projectId, patchId);
    return {
      kind: 'element_patch_command',
      commandId,
      effectId,
      toolName,
      projectId,
      elementId: before.elementId,
      patchId,
      expectedEntityKind: 'element_patch',
      expectedRevision: expectation!.expectedRevision,
      create: null,
      update: null,
      preimage: snapshotElementPatch(before),
      reviewSnapshot,
    };
  }
  const update: UpdatePatchInput = {};
  if (typeof request.arguments.title === 'string') {
    update.title = request.arguments.title;
  }
  if (typeof request.arguments.body === 'string') {
    update.contentJson = createPlainCommentDoc(request.arguments.body);
  }
  if (update.title === undefined && update.contentJson === undefined) {
    throw new Error('update_element_patch requires title or body');
  }
  return {
    kind: 'element_patch_command',
    commandId,
    effectId,
    toolName,
    projectId,
    elementId: before.elementId,
    patchId,
    expectedEntityKind: 'element_patch',
    expectedRevision: expectation!.expectedRevision,
    create: null,
    update,
    preimage: snapshotElementPatch(before),
    reviewSnapshot,
  };
}

function requireExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  entityKind: 'element_patch_set' | 'element_patch',
  entityId: string,
): asserts expectation is PersistedAgentRuntimeWriteExpectation {
  if (
    !expectation ||
    expectation.entityKind !== entityKind ||
    expectation.entityId !== entityId ||
    expectation.expectedRevision !==
      (request.arguments.expectedRevision as { revision?: unknown } | undefined)
        ?.revision
  ) {
    throw new Error(
      `${request.name} requires exact freshness copied from get_element_patches`,
    );
  }
}

function assertExpectedRevision(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  current: string,
): void {
  if (!expectation || expectation.expectedRevision !== current) {
    stalePatchError();
  }
}

async function readCurrentVersion(
  tx: DbExecutor,
  expectation: PersistedAgentRuntimeWriteExpectation,
  payload: ElementPatchCommandPayload,
): Promise<{ revision: string } | null> {
  if (
    expectation.projectId !== payload.projectId ||
    expectation.entityKind !== payload.expectedEntityKind
  ) {
    return null;
  }
  const repo = createElementPatchRepository(tx);
  if (payload.expectedEntityKind === 'element_patch_set') {
    if (expectation.entityId !== payload.elementId) return null;
    const pendingDeletes = pendingDeletedPatchIds(payload.elementId);
    const patches = (await repo.listByElement(payload.elementId)).filter(
      (patch) =>
        patch.projectId === payload.projectId &&
        !patch.invalidatedAt &&
        !pendingDeletes.has(patch.id),
    );
    return { revision: await elementPatchSetRevision(patches) };
  }
  if (expectation.entityId !== payload.patchId) return null;
  const patch = await repo.findById(payload.patchId);
  if (
    !patch ||
    patch.projectId !== payload.projectId ||
    patch.invalidatedAt ||
    pendingDeletedPatchIds(patch.elementId).has(patch.id)
  ) {
    return null;
  }
  return { revision: await elementPatchRevision(patch) };
}

async function applyForwardInTransaction(
  tx: DbExecutor,
  payload: ElementPatchCommandPayload,
  request: AgentToolExecutionRequest,
  now: () => string,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): Promise<AtomicPatchResult> {
  const sync = transactionRunner(tx, persistSyncMutation);
  let patch: ElementPatch | null;
  if (payload.toolName === 'create_element_patch') {
    patch = await createElementPatchWithSync(payload.create!, sync.runner);
  } else if (payload.toolName === 'update_element_patch') {
    patch = await updateElementPatchWithSync(
      payload.projectId,
      payload.patchId,
      payload.update!,
      sync.runner,
    );
  } else {
    await assertPatchDeleteAllowed(tx, payload.projectId, payload.patchId);
    await deleteElementPatchWithSync(
      payload.projectId,
      payload.patchId,
      sync.runner,
    );
    patch = null;
  }
  if (patch && patch.projectId !== payload.projectId) {
    throw new Error('The element patch command did not persist its target');
  }
  if (payload.toolName !== 'delete_element_patch' && !patch) {
    throw new Error('The element patch command did not persist its target');
  }
  const postimage = patch ? snapshotElementPatch(patch) : null;
  const receipt = await createAgentRuntimeElementPatchReceiptRepository(
    tx,
  ).persist({
    id: receiptId(payload, 'forward'),
    effectId: payload.effectId,
    commandId: payload.commandId,
    direction: 'forward',
    projectId: payload.projectId,
    sessionId: request.sessionId,
    toolName: payload.toolName,
    patchId: payload.patchId,
    expectedRevision: payload.expectedRevision,
    resultRevision: postimage ? await elementPatchRevision(postimage) : null,
    postimage,
    postimageHash: postimage ? await hashElementPatchValue(postimage) : null,
    createdAt: now(),
  });
  return { receipt, syncPersisted: sync.persisted() };
}

async function applyInverseInTransaction(
  tx: DbExecutor,
  payload: ElementPatchCommandPayload,
  effect: PersistedAgentRuntimeWriteEffect,
  forwardReceipt: PersistedAgentRuntimeElementPatchReceipt,
  now: () => string,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): Promise<AtomicPatchResult> {
  const receiptRepo = createAgentRuntimeElementPatchReceiptRepository(tx);
  const raced = await receiptRepo.get(payload.commandId, 'inverse');
  if (raced) {
    assertReceiptMatchesPayload(raced, payload, 'inverse');
    return { receipt: raced, syncPersisted: false };
  }
  const patchRepo = createElementPatchRepository(tx);
  const current = await patchRepo.findById(payload.patchId);
  const sync = transactionRunner(tx, persistSyncMutation);
  let postimage: AgentRuntimeElementPatchSnapshot | null = null;

  if (payload.toolName === 'create_element_patch') {
    if (current) {
      if (
        current.projectId !== payload.projectId ||
        (await elementPatchRevision(current)) !==
          forwardReceipt.resultRevision
      ) {
        throw new Error(
          'The created element patch changed after the Agent write; exact reject is unavailable',
        );
      }
      await deleteElementPatchWithSync(
        payload.projectId,
        payload.patchId,
        sync.runner,
      );
    }
  } else if (payload.toolName === 'update_element_patch') {
    if (!current || current.projectId !== payload.projectId) {
      throw new Error(
        'The updated element patch no longer exists; exact reject is unavailable',
      );
    }
    if (payload.preimage && samePatchState(current, payload.preimage)) {
      postimage = snapshotElementPatch(current);
    } else {
      if (
        (await elementPatchRevision(current)) !==
        forwardReceipt.resultRevision
      ) {
        throw new Error(
          'The element patch changed after the Agent write; exact reject is unavailable',
        );
      }
      const restored = await updateElementPatchWithSync(
        payload.projectId,
        payload.patchId,
        {
          title: payload.preimage!.title,
          contentJson: payload.preimage!.contentJson,
        },
        sync.runner,
      );
      if (!restored) {
        throw new Error('The element patch inverse did not persist');
      }
      postimage = snapshotElementPatch(restored);
      if (!samePatchState(restored, payload.preimage!)) {
        throw new Error('The element patch inverse did not restore its preimage');
      }
    }
  } else {
    if (current) {
      throw new Error(
        'The deleted element patch id is occupied again; exact restore is unavailable',
      );
    }
    if (!payload.preimage) {
      throw new Error('The deleted element patch inverse lost its preimage');
    }
    await tx.insert(ElementPatchTable).values(payload.preimage);
    await sync.runner(payload.projectId, (_inner, writeSync) =>
      writeSync(
        'elementPatch',
        'create',
        payload.patchId,
        payload.projectId,
        elementPatchSyncPayload(payload.preimage!),
      ),
    );
    postimage = payload.preimage;
  }

  const receipt = await receiptRepo.persist({
    id: receiptId(payload, 'inverse'),
    effectId: payload.effectId,
    commandId: payload.commandId,
    direction: 'inverse',
    projectId: payload.projectId,
    sessionId: effect.sessionId,
    toolName: payload.toolName,
    patchId: payload.patchId,
    expectedRevision: forwardReceipt.resultRevision,
    resultRevision: postimage
      ? await elementPatchRevision(postimage)
      : null,
    postimage,
    postimageHash: postimage
      ? await hashElementPatchValue(postimage)
      : null,
    createdAt: now(),
  });
  return { receipt, syncPersisted: sync.persisted() };
}

function transactionRunner(
  tx: DbExecutor,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): {
  runner: ElementPatchAtomicTransactionRunner;
  persisted: () => boolean;
} {
  let persisted = false;
  return {
    runner: async (projectId, work) =>
      work(
        tx,
        async (
          entityType,
          mutationType,
          entityId,
          mutationProjectId,
          payload,
          parentId,
        ) => {
          if (mutationProjectId !== projectId) {
            throw new Error(
              `Element patch transaction for ${projectId} cannot sync ${mutationProjectId}`,
            );
          }
          persisted =
            (await persistSyncMutation(tx as DbTransaction, {
              entityType,
              mutationType,
              entityId,
              projectId,
              payload,
              parentId,
              timestamp: Date.now(),
            })) || persisted;
        },
      ),
    persisted: () => persisted,
  };
}

function committedEffect(
  payload: ElementPatchCommandPayload,
  receipt: PersistedAgentRuntimeElementPatchReceipt,
  result: ElementPatchHandlerResult,
) {
  return {
    kind: 'element_patch',
    commandId: payload.commandId,
    patchId: payload.patchId,
    elementId: payload.elementId,
    revision: receipt.resultRevision,
    postimage: receipt.postimage,
    receiptId: receipt.id,
    handlerResult: result,
  };
}

function inverseEffect(
  receipt: PersistedAgentRuntimeElementPatchReceipt,
  reconciled: boolean,
) {
  return {
    kind: 'element_patch_revert',
    commandId: receipt.commandId,
    patchId: receipt.patchId,
    revision: receipt.resultRevision,
    postimage: receipt.postimage,
    receiptId: receipt.id,
    reconciled,
  };
}

function handlerResult(
  payload: ElementPatchCommandPayload,
  receipt: PersistedAgentRuntimeElementPatchReceipt,
): ElementPatchHandlerResult {
  const element = useDataStore
    .getState()
    .bookElements.find(
      (candidate) =>
        candidate.id === payload.elementId &&
        candidate.projectId === payload.projectId,
    );
  if (!element) {
    throw new Error('The element patch receipt targets an unavailable element');
  }
  return {
    ok: true,
    patchId: payload.patchId,
    element: element.name,
    ...(payload.toolName === 'create_element_patch'
      ? { title: receipt.postimage?.title ?? null }
      : {}),
  };
}

function parseHandlerResult(
  value: unknown,
  payload: ElementPatchCommandPayload,
): ElementPatchHandlerResult {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { ok?: unknown }).ok !== true ||
    (value as { patchId?: unknown }).patchId !== payload.patchId
  ) {
    throw new Error('The element patch handler result is invalid');
  }
  return value as ElementPatchHandlerResult;
}

function assertReceiptMatchesPayload(
  receipt: PersistedAgentRuntimeElementPatchReceipt | null,
  payload: ElementPatchCommandPayload,
  direction: 'forward' | 'inverse',
): asserts receipt is PersistedAgentRuntimeElementPatchReceipt {
  if (
    !receipt ||
    receipt.effectId !== payload.effectId ||
    receipt.commandId !== payload.commandId ||
    receipt.direction !== direction ||
    receipt.projectId !== payload.projectId ||
    receipt.toolName !== payload.toolName ||
    receipt.patchId !== payload.patchId ||
    (direction === 'forward' &&
      (receipt.expectedRevision !== payload.expectedRevision ||
        (payload.toolName === 'delete_element_patch'
          ? receipt.postimage !== null || receipt.resultRevision !== null
          : !receipt.postimage ||
            receipt.postimage.projectId !== payload.projectId ||
            receipt.postimage.elementId !== payload.elementId)))
  ) {
    throw new Error(
      `The ${direction} element patch receipt does not match its command provenance`,
    );
  }
}

function assertEffectMatchesPayload(
  effect: PersistedAgentRuntimeWriteEffect,
  payload: ElementPatchCommandPayload,
): void {
  if (
    effect.id !== payload.effectId ||
    effect.projectId !== payload.projectId ||
    effect.toolName !== payload.toolName ||
    effect.idempotencyKey !==
      payload.commandId.slice('agent-element-patch:'.length)
  ) {
    throw new Error(
      'The persisted element patch command does not match its write effect',
    );
  }
}

function parsePayload(
  value: unknown,
  toolName: CertifiedPatchTool,
): ElementPatchCommandPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'element_patch_command' ||
    (value as { toolName?: unknown }).toolName !== toolName ||
    typeof (value as { commandId?: unknown }).commandId !== 'string' ||
    typeof (value as { effectId?: unknown }).effectId !== 'string' ||
    typeof (value as { projectId?: unknown }).projectId !== 'string' ||
    typeof (value as { elementId?: unknown }).elementId !== 'string' ||
    typeof (value as { patchId?: unknown }).patchId !== 'string' ||
    typeof (value as { expectedRevision?: unknown }).expectedRevision !==
      'string'
  ) {
    throw new Error('The persisted element patch command is invalid');
  }
  const payload = value as ElementPatchCommandPayload;
  const review = payload.reviewSnapshot;
  if (
    !review ||
    review.version !== 1 ||
    review.effectId !== payload.effectId ||
    review.reviewId !== `agent-review:${payload.effectId}` ||
    (review.mode !== 'auto' && review.mode !== 'approve')
  ) {
    throw new Error(
      'The persisted element patch review snapshot is invalid',
    );
  }
  return payload;
}

function runPostCommitEffects(
  payload: ElementPatchCommandPayload,
  syncPersisted: boolean,
  notifySyncCommitted: typeof notifySyncMutationCommitted,
): void {
  notifyCommittedSafely(syncPersisted, notifySyncCommitted);
  emitPatchChanged(payload.elementId);
}

function notifyCommittedSafely(
  syncPersisted: boolean,
  notifySyncCommitted: typeof notifySyncMutationCommitted,
): void {
  if (!syncPersisted) return;
  try {
    notifySyncCommitted();
  } catch {
    // The outbox row is already durable. Notification is only a wake-up hint
    // and must never turn a committed mutation into revert_failed/uncertain.
  }
}

function emitPatchChanged(elementId: string): void {
  try {
    eventBus.emit('element:patches-changed', { elementId });
  } catch {
    // This projection hint is replayable from durable state.
  }
}

function resolveProjectElement(projectId: string, value: unknown) {
  const ref = requiredString(value, 'create_element_patch requires element');
  const elements = useDataStore
    .getState()
    .bookElements.filter((element) => element.projectId === projectId);
  const direct = elements.find((element) => element.id === ref);
  if (direct) return direct;
  const matches = elements.filter(
    (element) =>
      element.name.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No element named "${ref}" exists in this project`
        : `Element reference "${ref}" is ambiguous`,
    );
  }
  return matches[0]!;
}

function resolveOptionalSourceNode(
  projectId: string,
  value: unknown,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  const ref = requiredString(
    value,
    'create_element_patch sourceChapter must be a chapter name',
  );
  const nodes = useDataStore
    .getState()
    .bookNodes.filter(
      (node) => node.projectId === projectId && node.kind === 'chapter',
    );
  const direct = nodes.find((node) => node.id === ref);
  if (direct) return direct.id;
  const matches = nodes.filter(
    (node) =>
      node.title.trim().toLocaleLowerCase() === ref.toLocaleLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No chapter named "${ref}" exists in this project`
        : `Chapter reference "${ref}" is ambiguous`,
    );
  }
  return matches[0]!.id;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim();
}

async function assertPatchDeleteAllowed(
  db: DbExecutor,
  projectId: string,
  patchId: string,
): Promise<void> {
  const relation = await db
    .select({ id: EntityRelationTable.id })
    .from(EntityRelationTable)
    .where(
      and(
        eq(EntityRelationTable.projectId, projectId),
        or(
          and(
            eq(EntityRelationTable.fromKind, 'patch'),
            eq(EntityRelationTable.fromId, patchId),
          ),
          and(
            eq(EntityRelationTable.toKind, 'patch'),
            eq(EntityRelationTable.toId, patchId),
          ),
        ),
      ),
    )
    .limit(1);
  if (relation[0]) {
    throw new Error(
      'This element patch still has a curated relation. Remove its /relations/*.json file before deleting it.',
    );
  }
  const comment = await db
    .select({ id: CommentTable.id })
    .from(CommentTable)
    .where(
      and(
        eq(CommentTable.projectId, projectId),
        eq(CommentTable.targetKind, 'patch'),
        eq(CommentTable.targetId, patchId),
      ),
    )
    .limit(1);
  if (comment[0]) {
    throw new Error(
      'This element patch still has an attached comment or TODO. Delete or retarget it first.',
    );
  }
}

function elementPatchSyncPayload(
  patch: AgentRuntimeElementPatchSnapshot,
): Record<string, unknown> {
  return {
    id: patch.id,
    elementId: patch.elementId,
    sourceNodeId: patch.sourceNodeId,
    sourceBlockId: patch.sourceBlockId,
    sourceBlockText: patch.sourceBlockText,
    textAnchorJson: patch.textAnchorJson,
    invalidatedAt: patch.invalidatedAt,
    title: patch.title,
    contentJson: patch.contentJson,
    orderKey: patch.orderKey,
  };
}

function samePatchState(
  left: ElementPatch | AgentRuntimeElementPatchSnapshot,
  right: AgentRuntimeElementPatchSnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.elementId === right.elementId &&
    left.sourceNodeId === right.sourceNodeId &&
    left.sourceBlockId === right.sourceBlockId &&
    left.sourceBlockText === right.sourceBlockText &&
    left.textAnchorJson === right.textAnchorJson &&
    left.invalidatedAt === right.invalidatedAt &&
    left.title === right.title &&
    left.contentJson === right.contentJson &&
    left.orderKey === right.orderKey &&
    left.createdAt === right.createdAt
  );
}

function receiptId(
  payload: ElementPatchCommandPayload,
  direction: 'forward' | 'inverse',
): string {
  return `agent-element-patch-receipt:${payload.effectId}:${direction}`;
}

function stalePatchError(): never {
  const error = new Error(
    'The element patches changed after get_element_patches; read them again before writing',
  ) as Error & { code: string };
  error.code = 'STALE_REVISION';
  throw error;
}
