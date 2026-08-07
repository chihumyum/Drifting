import { and, eq, isNull } from 'drizzle-orm';

import type {
  AgentRuntimeEntityWriteKind,
  AgentRuntimeEntityWriteSnapshot,
  AgentRuntimeEntityWriteTool,
  PersistedAgentRuntimeEntityWriteReceipt,
} from '../../../domain/agent-runtime-entity-write-receipt';
import { snapshotAgentRuntimeEntity } from '../../../domain/agent-runtime-entity-write-receipt';
import type { BookElement } from '../../../domain/book-element';
import {
  findElementNameConflict,
} from '../../../domain/book-element';
import {
  createPlainCommentDoc,
  type Comment,
  type CommentTargetKind,
} from '../../../domain/comment';
import type { PersistedAgentRuntimeWriteExpectation } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import { parseKv, stringifyKv, type KvEntry } from '../../../domain/kv';
import type { Project } from '../../../domain/project';
import {
  makeUniqueStorylineName,
  type Storyline,
} from '../../../domain/storyline';
import {
  getDb,
  type DbExecutor,
  type DbTransaction,
} from '../../../lib/db';
import {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
} from '../../../services/entity-sync.service';
import {
  createAgentRuntimeEntityWriteReceiptRepository,
  type AgentRuntimeEntityWriteReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-entity-write-receipt-repo';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { createBookElementSqliteRepository } from '../../../sqlite-repo/element-repo';
import { createCommentRepository } from '../../../sqlite-repo/comment-repo';
import { createProjectRepository } from '../../../sqlite-repo/project-repo';
import { createStorylineRepository } from '../../../sqlite-repo/storyline-repo';
import { canonicalAgentRuntimeJson } from '../../../sqlite-repo/agent-runtime-persistence-repo';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  ElementPatchTable,
  StorylineTable,
} from '../../../schema/drizzle';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import {
  createCommentWithSync,
  deleteCommentWithSync,
  updateElementWithSync,
  updateProjectWithSync,
  updateStorylineWithSync,
  type EntityAtomicTransactionRunner,
} from '../../../usecase/synced-entity-commands';
import { effectiveAgentEditMode } from '../agent-edit-mode';
import { throwIfAgentAborted } from './errors';
import {
  deterministicAgentEntityId,
  hashEntityWriteValue,
} from './entity-write-revision';
import type { DriftingWriteStrategy } from './drifting-write-strategies';
import type { AgentToolExecutionRequest } from './types';

type ExpectedEntityKind = 'element' | 'storyline' | 'project';

type EntityMutation =
  | {
      kind: 'update_element';
      updates: Partial<
        Pick<
          BookElement,
          | 'categoryId'
          | 'name'
          | 'summary'
          | 'kvJson'
          | 'aliases'
          | 'groupName'
        >
      >;
    }
  | {
      kind: 'update_storyline';
      updates: Partial<Pick<Storyline, 'name' | 'summary' | 'kvJson'>>;
    }
  | {
      kind: 'update_project_facts';
      updates: Pick<Project, 'kvJson'>;
    }
  | {
      kind: 'create_comment';
      comment: Comment;
    };

interface EntityWriteCommandPayload {
  kind: 'entity_write_command';
  commandId: string;
  effectId: string;
  toolName: AgentRuntimeEntityWriteTool;
  projectId: string;
  entityKind: AgentRuntimeEntityWriteKind;
  entityId: string;
  expectedEntityKind: ExpectedEntityKind;
  expectedEntityId: string;
  expectedRevision: string;
  preimage: AgentRuntimeEntityWriteSnapshot | null;
  mutation: EntityMutation;
  reviewSnapshot: {
    version: 1;
    effectId: string;
    reviewId: string;
    mode: 'auto' | 'approve';
  };
}

interface EntityWriteHandlerResult {
  ok: true;
  element?: string;
  storyline?: string;
  projectId?: string;
  commentId?: string;
}

export interface EntityWriteStrategyOptions {
  freshness: AgentRuntimeFreshnessRepository;
  db?: DbExecutor;
  receipts?: AgentRuntimeEntityWriteReceiptRepository;
  now?: () => string;
  persistSyncMutation?: typeof persistSyncMutationInTransaction;
  notifySyncCommitted?: typeof notifySyncMutationCommitted;
}

interface AtomicEntityWriteResult {
  receipt: PersistedAgentRuntimeEntityWriteReceipt;
  syncPersisted: boolean;
}

export function createDriftingEntityWriteStrategy(
  toolName: AgentRuntimeEntityWriteTool,
  options: EntityWriteStrategyOptions,
): DriftingWriteStrategy {
  const db = options.db ?? getDb();
  const receipts =
    options.receipts ??
    createAgentRuntimeEntityWriteReceiptRepository(db);
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
        now,
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
        readCurrentVersion: (tx, expectation) =>
          readCurrentVersion(tx, expectation, payload),
        mutate: (tx) =>
          applyForwardInTransaction(
            tx,
            payload,
            request.sessionId,
            now,
            persistSyncMutation,
          ),
      });
      runPostCommitEffects(
        payload,
        committed.receipt,
        committed.syncPersisted,
        notifySyncCommitted,
      );
      return handlerResult(payload);
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
      projectReceipt(payload, receipt);
      const result = handlerResult(payload);
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
      const forward = await receipts.get(payload.commandId, 'forward');
      assertReceiptMatchesPayload(forward, payload, 'forward');
      const existingInverse = await receipts.get(
        payload.commandId,
        'inverse',
      );
      if (existingInverse) {
        assertReceiptMatchesPayload(existingInverse, payload, 'inverse');
        projectReceipt(payload, existingInverse);
        return inverseEffect(existingInverse, true);
      }
      const committed = await db.transaction(
        (tx) =>
          applyInverseInTransaction(
            tx,
            payload,
            effect,
            forward,
            now,
            persistSyncMutation,
          ),
        { behavior: 'immediate' },
      );
      notifyCommittedSafely(
        committed.syncPersisted,
        notifySyncCommitted,
      );
      projectReceipt(payload, committed.receipt);
      return inverseEffect(committed.receipt, false);
    },
  };
}

async function preparePayload(
  toolName: AgentRuntimeEntityWriteTool,
  request: AgentToolExecutionRequest,
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  db: DbExecutor,
  now: () => string,
): Promise<EntityWriteCommandPayload> {
  const projectId = request.context.route.projectId;
  if (!projectId) throw new Error(`${toolName} requires a project route`);
  const effectId = `agent-write:${request.idempotencyKey}`;
  const base = {
    kind: 'entity_write_command' as const,
    commandId: `agent-entity-write:${request.idempotencyKey}`,
    effectId,
    toolName,
    projectId,
    reviewSnapshot: {
      version: 1 as const,
      effectId,
      reviewId: `agent-review:${effectId}`,
      mode: effectiveAgentEditMode(),
    },
  };

  if (toolName === 'update_element') {
    const element = resolveElement(projectId, request.arguments.element);
    requireExpectation(expectation, request, 'element', element.id);
    const before = await createBookElementSqliteRepository(
      projectId,
      db,
    ).findById(element.id);
    if (!before || before.projectId !== projectId) {
      throw new Error(`Element "${element.id}" no longer exists`);
    }
    assertExpectedRevision(expectation, before.updatedAt, 'read_element');
    const updates = prepareElementUpdates(
      request.arguments,
      before,
      projectId,
    );
    if (updates.name !== undefined || updates.aliases !== undefined) {
      const all = await createBookElementSqliteRepository(
        projectId,
        db,
      ).findAll();
      const nextName = (updates.name ?? before.name).trim() || before.name;
      const nextAliases = updates.aliases ?? before.aliases;
      const conflict = findElementNameConflict(
        [nextName, ...nextAliases],
        all,
        projectId,
        before.id,
      );
      if (conflict) {
        throw new Error(
          `Name "${conflict.conflictingName}" already belongs to element "${conflict.conflictingElement.name}"`,
        );
      }
      updates.name = nextName;
      updates.aliases = nextAliases;
    }
    return {
      ...base,
      entityKind: 'element',
      entityId: before.id,
      expectedEntityKind: 'element',
      expectedEntityId: before.id,
      expectedRevision: expectation!.expectedRevision,
      preimage: snapshotAgentRuntimeEntity(before, 'element'),
      mutation: { kind: 'update_element', updates },
    };
  }

  if (toolName === 'update_storyline') {
    const storyline = resolveStoryline(
      projectId,
      request.arguments.storyline,
    );
    requireExpectation(expectation, request, 'storyline', storyline.id);
    const repo = createStorylineRepository(projectId, db);
    const before = await repo.getStorylineById(storyline.id);
    if (!before || before.projectId !== projectId) {
      throw new Error(`Storyline "${storyline.id}" no longer exists`);
    }
    assertExpectedRevision(expectation, before.updatedAt, 'get_storyline');
    const updates = prepareStorylineUpdates(request.arguments, before);
    if (updates.name !== undefined) {
      updates.name = makeUniqueStorylineName(
        updates.name,
        await repo.getStorylinesByProject(),
        projectId,
        before.id,
      );
    }
    return {
      ...base,
      entityKind: 'storyline',
      entityId: before.id,
      expectedEntityKind: 'storyline',
      expectedEntityId: before.id,
      expectedRevision: expectation!.expectedRevision,
      preimage: snapshotAgentRuntimeEntity(before, 'storyline'),
      mutation: { kind: 'update_storyline', updates },
    };
  }

  const project = await createProjectRepository(undefined, db).findById(
    projectId,
  );
  if (!project) throw new Error(`Project "${projectId}" no longer exists`);
  requireExpectation(expectation, request, 'project', projectId);
  assertExpectedRevision(expectation, project.updatedAt, 'get_project_brief');

  if (toolName === 'update_project_facts') {
    const nextKvJson = mergeKv(
      project.kvJson,
      parseFacts(request.arguments.facts),
    );
    if (nextKvJson === project.kvJson) {
      throw new Error(
        'update_project_facts would not change the project',
      );
    }
    return {
      ...base,
      entityKind: 'project',
      entityId: projectId,
      expectedEntityKind: 'project',
      expectedEntityId: projectId,
      expectedRevision: expectation!.expectedRevision,
      preimage: snapshotAgentRuntimeEntity(project, 'project'),
      mutation: {
        kind: 'update_project_facts',
        updates: {
          kvJson: nextKvJson,
        },
      },
    };
  }

  const body = requiredString(
    request.arguments.body,
    'create_comment requires body',
  );
  const target = resolveCommentTarget(projectId, request.arguments);
  const timestamp = now();
  const comment: Comment = {
    id: await deterministicAgentEntityId(
      request.idempotencyKey,
      'comment',
    ),
    projectId,
    kind:
      request.arguments.kind === 'todo'
        ? 'todo'
        : request.arguments.kind === 'exception'
          ? 'exception'
          : 'note',
    targetKind: target.kind,
    targetId: target.id,
    targetBlockId:
      typeof request.arguments.targetBlockId === 'string' &&
      request.arguments.targetBlockId.trim()
        ? request.arguments.targetBlockId.trim()
        : null,
    anchorJson:
      typeof request.arguments.anchorJson === 'string' &&
      request.arguments.anchorJson.trim()
        ? request.arguments.anchorJson
        : '{}',
    authorKind: 'ai',
    authorId: null,
    authorName: 'General Agent',
    bodyJson: createPlainCommentDoc(body),
    status: 'open',
    priority: null,
    source: 'api',
    metadataJson: null,
    targetBlockIdsJson:
      typeof request.arguments.targetBlockId === 'string' &&
      request.arguments.targetBlockId.trim()
        ? JSON.stringify([request.arguments.targetBlockId.trim()])
        : '[]',
    resolvedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ...base,
    entityKind: 'comment',
    entityId: comment.id,
    expectedEntityKind: 'project',
    expectedEntityId: projectId,
    expectedRevision: expectation!.expectedRevision,
    preimage: null,
    mutation: { kind: 'create_comment', comment },
  };
}

function prepareElementUpdates(
  args: Record<string, unknown>,
  before: BookElement,
  projectId: string,
): Extract<EntityMutation, { kind: 'update_element' }>['updates'] {
  const updates: Extract<
    EntityMutation,
    { kind: 'update_element' }
  >['updates'] = {};
  if (typeof args.name === 'string') updates.name = args.name;
  if (typeof args.summary === 'string') updates.summary = args.summary;
  if (Array.isArray(args.aliases)) {
    updates.aliases = args.aliases
      .filter((alias): alias is string => typeof alias === 'string')
      .map((alias) => alias.trim())
      .filter(Boolean);
  }
  if (typeof args.groupName === 'string') {
    updates.groupName = args.groupName.trim() || null;
  }
  if (typeof args.category === 'string') {
    const category = resolveCategory(projectId, args.category);
    updates.categoryId = category.id;
  }
  if (args.facts !== undefined) {
    updates.kvJson = stringifyKv(parseFacts(args.facts, true));
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('update_element requires at least one changed field');
  }
  if (
    !Object.entries(updates).some(([key, value]) => {
      if (key === 'aliases') {
        return canonicalStringArray(value as string[]) !==
          canonicalStringArray(before.aliases);
      }
      return value !== before[key as keyof BookElement];
    })
  ) {
    throw new Error('update_element would not change the element');
  }
  return updates;
}

function prepareStorylineUpdates(
  args: Record<string, unknown>,
  before: Storyline,
): Extract<EntityMutation, { kind: 'update_storyline' }>['updates'] {
  const updates: Extract<
    EntityMutation,
    { kind: 'update_storyline' }
  >['updates'] = {};
  if (typeof args.name === 'string') updates.name = args.name.trim();
  if (typeof args.summary === 'string') updates.summary = args.summary;
  if (args.facts !== undefined) {
    updates.kvJson = mergeKv(before.kvJson, parseFacts(args.facts));
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('update_storyline requires name, summary, or facts');
  }
  if (
    !Object.entries(updates).some(
      ([key, value]) => value !== before[key as keyof Storyline],
    )
  ) {
    throw new Error('update_storyline would not change the storyline');
  }
  return updates;
}

async function readCurrentVersion(
  tx: DbExecutor,
  expectation: PersistedAgentRuntimeWriteExpectation,
  payload: EntityWriteCommandPayload,
): Promise<{ revision: string } | null> {
  if (
    expectation.projectId !== payload.projectId ||
    expectation.entityKind !== payload.expectedEntityKind ||
    expectation.entityId !== payload.expectedEntityId
  ) {
    return null;
  }
  if (payload.expectedEntityKind === 'element') {
    const value = await createBookElementSqliteRepository(
      payload.projectId,
      tx,
    ).findById(payload.expectedEntityId);
    return value?.projectId === payload.projectId
      ? { revision: value.updatedAt }
      : null;
  }
  if (payload.expectedEntityKind === 'storyline') {
    const value = await createStorylineRepository(
      payload.projectId,
      tx,
    ).getStorylineById(payload.expectedEntityId);
    return value?.projectId === payload.projectId
      ? { revision: value.updatedAt }
      : null;
  }
  const value = await createProjectRepository(undefined, tx).findById(
    payload.projectId,
  );
  return value ? { revision: value.updatedAt } : null;
}

async function applyForwardInTransaction(
  tx: DbExecutor,
  payload: EntityWriteCommandPayload,
  sessionId: string,
  now: () => string,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): Promise<AtomicEntityWriteResult> {
  const sync = transactionRunner(tx, persistSyncMutation);
  let postimage: AgentRuntimeEntityWriteSnapshot;
  switch (payload.mutation.kind) {
    case 'update_element': {
      const value = await updateElementWithSync(
        payload.projectId,
        payload.entityId,
        { ...payload.mutation.updates, updatedAt: now() },
        sync.runner,
      );
      postimage = snapshotAgentRuntimeEntity(value, 'element');
      break;
    }
    case 'update_storyline': {
      const value = await updateStorylineWithSync(
        payload.projectId,
        payload.entityId,
        {
          ...payload.mutation.updates,
          projectId: payload.projectId,
          updatedAt: now(),
        },
        sync.runner,
      );
      postimage = snapshotAgentRuntimeEntity(value, 'storyline');
      break;
    }
    case 'update_project_facts': {
      const value = await updateProjectWithSync(
        payload.projectId,
        { ...payload.mutation.updates, updatedAt: now() },
        sync.runner,
      );
      postimage = snapshotAgentRuntimeEntity(value, 'project');
      break;
    }
    case 'create_comment': {
      await assertCommentTargetExists(tx, payload.mutation.comment);
      const value = await createCommentWithSync(
        payload.mutation.comment,
        sync.runner,
      );
      postimage = snapshotAgentRuntimeEntity(value, 'comment');
      break;
    }
  }
  const receipt = await createAgentRuntimeEntityWriteReceiptRepository(
    tx,
  ).persist({
    id: receiptId(payload, 'forward'),
    effectId: payload.effectId,
    commandId: payload.commandId,
    direction: 'forward',
    projectId: payload.projectId,
    sessionId,
    toolName: payload.toolName,
    entityKind: payload.entityKind,
    entityId: payload.entityId,
    expectedRevision: payload.expectedRevision,
    resultRevision: postimage.value.updatedAt,
    preimage: payload.preimage,
    preimageHash: payload.preimage
      ? await hashEntityWriteValue(payload.preimage)
      : null,
    postimage,
    postimageHash: await hashEntityWriteValue(postimage),
    createdAt: now(),
  });
  return { receipt, syncPersisted: sync.persisted() };
}

async function applyInverseInTransaction(
  tx: DbExecutor,
  payload: EntityWriteCommandPayload,
  effect: PersistedAgentRuntimeWriteEffect,
  forward: PersistedAgentRuntimeEntityWriteReceipt,
  now: () => string,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): Promise<AtomicEntityWriteResult> {
  const receiptRepo =
    createAgentRuntimeEntityWriteReceiptRepository(tx);
  const raced = await receiptRepo.get(payload.commandId, 'inverse');
  if (raced) {
    assertReceiptMatchesPayload(raced, payload, 'inverse');
    return { receipt: raced, syncPersisted: false };
  }
  const sync = transactionRunner(tx, persistSyncMutation);
  let postimage: AgentRuntimeEntityWriteSnapshot | null = null;

  if (payload.toolName === 'create_comment') {
    const current = await createCommentRepository(
      payload.projectId,
      tx,
    ).findById(payload.entityId);
    if (current) {
      const currentSnapshot = snapshotAgentRuntimeEntity(
        current,
        'comment',
      );
      if (
        !forward.postimageHash ||
        (await hashEntityWriteValue(currentSnapshot)) !==
          forward.postimageHash
      ) {
        throw new Error(
          'The created comment changed after the Agent write; exact reject is unavailable',
        );
      }
      await deleteCommentWithSync(
        payload.projectId,
        payload.entityId,
        sync.runner,
      );
    }
  } else {
    const current = await loadTargetSnapshot(tx, payload);
    if (
      !current ||
      current.value.updatedAt !== forward.resultRevision ||
      !forward.postimageHash ||
      (await hashEntityWriteValue(current)) !==
        forward.postimageHash ||
      !payload.preimage
    ) {
      throw new Error(
        'The Agent target changed after the write; exact reject is unavailable',
      );
    }
    postimage = await restorePreimage(
      payload,
      payload.preimage,
      now(),
      sync.runner,
    );
    if (!sameSemanticState(postimage, payload.preimage)) {
      throw new Error('The entity write inverse did not restore its preimage');
    }
  }

  const receipt = await receiptRepo.persist({
    id: receiptId(payload, 'inverse'),
    effectId: payload.effectId,
    commandId: payload.commandId,
    direction: 'inverse',
    projectId: payload.projectId,
    sessionId: effect.sessionId,
    toolName: payload.toolName,
    entityKind: payload.entityKind,
    entityId: payload.entityId,
    expectedRevision: forward.resultRevision,
    resultRevision: postimage?.value.updatedAt ?? null,
    preimage: payload.preimage,
    preimageHash: payload.preimage
      ? await hashEntityWriteValue(payload.preimage)
      : null,
    postimage,
    postimageHash: postimage
      ? await hashEntityWriteValue(postimage)
      : null,
    createdAt: now(),
  });
  return { receipt, syncPersisted: sync.persisted() };
}

async function assertCommentTargetExists(
  tx: DbExecutor,
  comment: Comment,
): Promise<void> {
  if (!comment.targetKind || !comment.targetId) return;
  let rows: Array<{ id: string }>;
  switch (comment.targetKind) {
    case 'node':
      rows = await tx
        .select({ id: BookNodeTable.id })
        .from(BookNodeTable)
        .where(
          and(
            eq(BookNodeTable.id, comment.targetId),
            eq(BookNodeTable.projectId, comment.projectId),
            isNull(BookNodeTable.deletedAt),
          ),
        )
        .limit(1);
      break;
    case 'element':
      rows = await tx
        .select({ id: BookElementTable.id })
        .from(BookElementTable)
        .where(
          and(
            eq(BookElementTable.id, comment.targetId),
            eq(BookElementTable.projectId, comment.projectId),
            isNull(BookElementTable.deletedAt),
          ),
        )
        .limit(1);
      break;
    case 'storyline':
      rows = await tx
        .select({ id: StorylineTable.id })
        .from(StorylineTable)
        .where(
          and(
            eq(StorylineTable.id, comment.targetId),
            eq(StorylineTable.projectId, comment.projectId),
            isNull(StorylineTable.deletedAt),
          ),
        )
        .limit(1);
      break;
    case 'category':
      rows = await tx
        .select({ id: ElementCategoryTable.id })
        .from(ElementCategoryTable)
        .where(
          and(
            eq(ElementCategoryTable.id, comment.targetId),
            eq(ElementCategoryTable.projectId, comment.projectId),
            isNull(ElementCategoryTable.deletedAt),
          ),
        )
        .limit(1);
      break;
    case 'patch':
      rows = await tx
        .select({ id: ElementPatchTable.id })
        .from(ElementPatchTable)
        .where(
          and(
            eq(ElementPatchTable.id, comment.targetId),
            eq(ElementPatchTable.projectId, comment.projectId),
            isNull(ElementPatchTable.invalidatedAt),
          ),
        )
        .limit(1);
      break;
  }
  if (rows.length !== 1) {
    throw new Error(
      `The comment target ${comment.targetKind}:${comment.targetId} no longer exists in this project`,
    );
  }
}

async function loadTargetSnapshot(
  tx: DbExecutor,
  payload: EntityWriteCommandPayload,
): Promise<AgentRuntimeEntityWriteSnapshot | null> {
  if (payload.entityKind === 'element') {
    const value = await createBookElementSqliteRepository(
      payload.projectId,
      tx,
    ).findById(payload.entityId);
    return value ? snapshotAgentRuntimeEntity(value, 'element') : null;
  }
  if (payload.entityKind === 'storyline') {
    const value = await createStorylineRepository(
      payload.projectId,
      tx,
    ).getStorylineById(payload.entityId);
    return value ? snapshotAgentRuntimeEntity(value, 'storyline') : null;
  }
  if (payload.entityKind === 'project') {
    const value = await createProjectRepository(undefined, tx).findById(
      payload.projectId,
    );
    return value ? snapshotAgentRuntimeEntity(value, 'project') : null;
  }
  const value = await createCommentRepository(
    payload.projectId,
    tx,
  ).findById(payload.entityId);
  return value ? snapshotAgentRuntimeEntity(value, 'comment') : null;
}

async function restorePreimage(
  payload: EntityWriteCommandPayload,
  preimage: AgentRuntimeEntityWriteSnapshot,
  updatedAt: string,
  runAtomic: EntityAtomicTransactionRunner,
): Promise<AgentRuntimeEntityWriteSnapshot> {
  if (preimage.kind === 'element') {
    const value = await updateElementWithSync(
      payload.projectId,
      payload.entityId,
      {
        categoryId: preimage.value.categoryId,
        name: preimage.value.name,
        summary: preimage.value.summary,
        contentJson: preimage.value.contentJson,
        kvJson: preimage.value.kvJson,
        aliases: preimage.value.aliases,
        groupName: preimage.value.groupName,
        portraitAssetId: preimage.value.portraitAssetId,
        updatedAt,
      },
      runAtomic,
    );
    return snapshotAgentRuntimeEntity(value, 'element');
  }
  if (preimage.kind === 'storyline') {
    const value = await updateStorylineWithSync(
      payload.projectId,
      payload.entityId,
      {
        projectId: payload.projectId,
        name: preimage.value.name,
        color: preimage.value.color,
        summary: preimage.value.summary,
        orderKey: preimage.value.orderKey,
        contentJson: preimage.value.contentJson,
        kvJson: preimage.value.kvJson,
        nodeContentTemplateJson: preimage.value.nodeContentTemplateJson,
        updatedAt,
      },
      runAtomic,
    );
    return snapshotAgentRuntimeEntity(value, 'storyline');
  }
  if (preimage.kind === 'project') {
    const value = await updateProjectWithSync(
      payload.projectId,
      {
        name: preimage.value.name,
        summary: preimage.value.summary,
        kvJson: preimage.value.kvJson,
        storylineTemplateKvJson:
          preimage.value.storylineTemplateKvJson,
        updatedAt,
      },
      runAtomic,
    );
    return snapshotAgentRuntimeEntity(value, 'project');
  }
  throw new Error('Comment create has no update-style preimage');
}

function transactionRunner(
  tx: DbExecutor,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): {
  runner: EntityAtomicTransactionRunner;
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
              `Entity write transaction for ${projectId} cannot sync ${mutationProjectId}`,
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

function projectReceipt(
  payload: EntityWriteCommandPayload,
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
): void {
  const snapshot = receipt.postimage;
  const data = useDataStore.getState();
  if (!snapshot) {
    if (payload.entityKind === 'comment') {
      data.removeComment(payload.entityId);
    }
    return;
  }
  switch (snapshot.kind) {
    case 'element':
      data.updateBookElement(snapshot.value.id, snapshot.value);
      break;
    case 'storyline':
      data.updateStoryline(snapshot.value.id, snapshot.value);
      break;
    case 'project':
      useProjectStore
        .getState()
        .updateProjectInList(snapshot.value.id, snapshot.value);
      break;
    case 'comment': {
      const exists = data.comments.some(
        (comment) => comment.id === snapshot.value.id,
      );
      if (exists) data.updateComment(snapshot.value.id, snapshot.value);
      else data.addComment(snapshot.value);
      break;
    }
  }
}

function runPostCommitEffects(
  payload: EntityWriteCommandPayload,
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
  syncPersisted: boolean,
  notifySyncCommitted: typeof notifySyncMutationCommitted,
): void {
  notifyCommittedSafely(syncPersisted, notifySyncCommitted);
  try {
    projectReceipt(payload, receipt);
  } catch {
    // The immutable receipt is authoritative; restart reconciliation rebuilds
    // the renderer projection without re-execution.
  }
}

function notifyCommittedSafely(
  syncPersisted: boolean,
  notifySyncCommitted: typeof notifySyncMutationCommitted,
): void {
  if (!syncPersisted) return;
  try {
    notifySyncCommitted();
  } catch {
    // The outbox row is durable. Notification is only a wake-up hint.
  }
}

function committedEffect(
  payload: EntityWriteCommandPayload,
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
  result: EntityWriteHandlerResult,
) {
  return {
    kind: 'entity_write',
    commandId: payload.commandId,
    entityKind: payload.entityKind,
    entityId: payload.entityId,
    revision: receipt.resultRevision,
    postimage: receipt.postimage,
    receiptId: receipt.id,
    handlerResult: result,
  };
}

function inverseEffect(
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
  reconciled: boolean,
) {
  return {
    kind: 'entity_write_revert',
    commandId: receipt.commandId,
    entityKind: receipt.entityKind,
    entityId: receipt.entityId,
    revision: receipt.resultRevision,
    postimage: receipt.postimage,
    receiptId: receipt.id,
    reconciled,
  };
}

function handlerResult(
  payload: EntityWriteCommandPayload,
): EntityWriteHandlerResult {
  if (payload.entityKind === 'element') {
    const value = useDataStore
      .getState()
      .bookElements.find((item) => item.id === payload.entityId);
    return { ok: true, element: value?.name ?? payload.entityId };
  }
  if (payload.entityKind === 'storyline') {
    const value = useDataStore
      .getState()
      .storylines.find((item) => item.id === payload.entityId);
    return { ok: true, storyline: value?.name ?? payload.entityId };
  }
  if (payload.entityKind === 'project') {
    return { ok: true, projectId: payload.projectId };
  }
  return { ok: true, commentId: payload.entityId };
}

function parseHandlerResult(
  value: unknown,
  payload: EntityWriteCommandPayload,
): EntityWriteHandlerResult {
  if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
    throw new Error('The entity write handler result is invalid');
  }
  if (
    payload.entityKind === 'comment' &&
    (value as { commentId?: unknown }).commentId !== payload.entityId
  ) {
    throw new Error('The comment handler result lost its deterministic id');
  }
  return value as EntityWriteHandlerResult;
}

function assertReceiptMatchesPayload(
  receipt: PersistedAgentRuntimeEntityWriteReceipt | null,
  payload: EntityWriteCommandPayload,
  direction: 'forward' | 'inverse',
): asserts receipt is PersistedAgentRuntimeEntityWriteReceipt {
  if (
    !receipt ||
    receipt.effectId !== payload.effectId ||
    receipt.commandId !== payload.commandId ||
    receipt.direction !== direction ||
    receipt.projectId !== payload.projectId ||
    receipt.toolName !== payload.toolName ||
    receipt.entityKind !== payload.entityKind ||
    receipt.entityId !== payload.entityId ||
    (direction === 'forward' &&
      receipt.expectedRevision !== payload.expectedRevision)
  ) {
    throw new Error(
      `The ${direction} entity write receipt does not match its command provenance`,
    );
  }
}

function assertEffectMatchesPayload(
  effect: PersistedAgentRuntimeWriteEffect,
  payload: EntityWriteCommandPayload,
): void {
  if (
    effect.id !== payload.effectId ||
    effect.projectId !== payload.projectId ||
    effect.toolName !== payload.toolName ||
    effect.idempotencyKey !==
      payload.commandId.slice('agent-entity-write:'.length)
  ) {
    throw new Error(
      'The persisted entity write command does not match its effect',
    );
  }
}

function parsePayload(
  value: unknown,
  toolName: AgentRuntimeEntityWriteTool,
): EntityWriteCommandPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'entity_write_command' ||
    (value as { toolName?: unknown }).toolName !== toolName ||
    typeof (value as { commandId?: unknown }).commandId !== 'string' ||
    typeof (value as { effectId?: unknown }).effectId !== 'string' ||
    typeof (value as { projectId?: unknown }).projectId !== 'string' ||
    typeof (value as { entityId?: unknown }).entityId !== 'string' ||
    typeof (value as { expectedRevision?: unknown }).expectedRevision !==
      'string'
  ) {
    throw new Error('The persisted entity write command is invalid');
  }
  const payload = value as EntityWriteCommandPayload;
  if (
    payload.mutation.kind !== payload.toolName ||
    payload.entityId !==
      (payload.mutation.kind === 'create_comment'
        ? payload.mutation.comment.id
        : payload.entityId) ||
    payload.reviewSnapshot?.version !== 1 ||
    payload.reviewSnapshot.effectId !== payload.effectId ||
    payload.reviewSnapshot.reviewId !==
      `agent-review:${payload.effectId}` ||
    (payload.reviewSnapshot.mode !== 'auto' &&
      payload.reviewSnapshot.mode !== 'approve')
  ) {
    throw new Error('The persisted entity write payload is inconsistent');
  }
  return payload;
}

function requireExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  entityKind: ExpectedEntityKind,
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
      `${request.name} requires exact freshness for ${entityKind}:${entityId}`,
    );
  }
}

function assertExpectedRevision(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  current: string,
  readToolName: string,
): void {
  if (!expectation || expectation.expectedRevision !== current) {
    const error = new Error(
      `The target changed after ${readToolName}; read it again before writing`,
    ) as Error & { code: string };
    error.code = 'STALE_REVISION';
    throw error;
  }
}

function parseFacts(value: unknown, allowEmpty = false): KvEntry[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new Error('facts must contain at least one key/value row');
  }
  return value.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof (row as { key?: unknown }).key !== 'string' ||
      typeof (row as { value?: unknown }).value !== 'string'
    ) {
      throw new Error('facts rows require string key and value');
    }
    return {
      key: (row as { key: string }).key,
      value: (row as { value: string }).value,
    };
  });
}

function mergeKv(existingJson: string, updates: KvEntry[]): string {
  const values = new Map<string, string>();
  for (const row of parseKv(existingJson)) values.set(row.key, row.value);
  for (const row of updates) {
    if (row.key) values.set(row.key, row.value);
  }
  return stringifyKv(
    [...values].map(([key, value]) => ({ key, value })),
  );
}

function resolveElement(projectId: string, value: unknown): BookElement {
  const ref = requiredString(value, 'update_element requires element');
  return resolveNamed(
    useDataStore
      .getState()
      .bookElements.filter((item) => item.projectId === projectId),
    ref,
    (item) => item.name,
    'element',
  );
}

function resolveStoryline(projectId: string, value: unknown): Storyline {
  const ref = requiredString(
    value,
    'update_storyline requires storyline',
  );
  return resolveNamed(
    useDataStore
      .getState()
      .storylines.filter((item) => item.projectId === projectId),
    ref,
    (item) => item.name,
    'storyline',
  );
}

function resolveCategory(projectId: string, value: unknown) {
  const ref = requiredString(value, 'category must be a name');
  return resolveNamed(
    useDataStore
      .getState()
      .bookElementCategories.filter(
        (item) => item.projectId === projectId,
      ),
    ref,
    (item) => item.name,
    'category',
  );
}

function resolveCommentTarget(
  projectId: string,
  args: Record<string, unknown>,
): { kind: CommentTargetKind | null; id: string | null } {
  const rawRef =
    typeof args.target === 'string' ? args.target.trim() : '';
  const rawKind =
    typeof args.targetKind === 'string'
      ? args.targetKind.trim()
      : '';
  if (!rawKind && !rawRef) return { kind: null, id: null };
  if (!rawKind || !rawRef) {
    throw new Error(
      'create_comment targetKind and target must be supplied together',
    );
  }
  const state = useDataStore.getState();
  if (
    rawKind === 'node' ||
    rawKind === 'chapter' ||
    rawKind === 'drift'
  ) {
    const candidates = state.bookNodes.filter(
      (item) =>
        item.projectId === projectId &&
        (rawKind === 'chapter'
          ? item.kind === 'chapter'
          : rawKind === 'drift'
            ? item.kind === 'drift'
            : true),
    );
    const value = resolveNamed(
      candidates,
      rawRef,
      (item) => item.title,
      rawKind,
    );
    return { kind: 'node', id: value.id };
  }
  if (rawKind === 'element') {
    return { kind: 'element', id: resolveElement(projectId, rawRef).id };
  }
  if (rawKind === 'storyline') {
    return {
      kind: 'storyline',
      id: resolveStoryline(projectId, rawRef).id,
    };
  }
  if (rawKind === 'category') {
    return { kind: 'category', id: resolveCategory(projectId, rawRef).id };
  }
  if (rawKind === 'patch') {
    return { kind: 'patch', id: rawRef };
  }
  throw new Error(`Unsupported comment targetKind "${rawKind}"`);
}

function resolveNamed<T extends { id: string }>(
  values: readonly T[],
  ref: string,
  label: (value: T) => string,
  kind: string,
): T {
  const direct = values.find((value) => value.id === ref);
  if (direct) return direct;
  const lowered = ref.toLocaleLowerCase();
  const matches = values.filter(
    (value) => label(value).trim().toLocaleLowerCase() === lowered,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No ${kind} named "${ref}" exists in this project`
        : `${kind} reference "${ref}" is ambiguous`,
    );
  }
  return matches[0]!;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim();
}

function canonicalStringArray(value: string[] | undefined): string {
  return value === undefined ? '__undefined__' : JSON.stringify(value);
}

function sameSemanticState(
  left: AgentRuntimeEntityWriteSnapshot,
  right: AgentRuntimeEntityWriteSnapshot,
): boolean {
  if (left.kind !== right.kind) return false;
  const stripRevision = (value: Record<string, unknown>) => {
    const semantic = { ...value };
    delete semantic.updatedAt;
    return semantic;
  };
  return (
    canonicalAgentRuntimeJson(
      stripRevision(left.value as unknown as Record<string, unknown>),
    ) ===
    canonicalAgentRuntimeJson(
      stripRevision(right.value as unknown as Record<string, unknown>),
    )
  );
}

function receiptId(
  payload: EntityWriteCommandPayload,
  direction: 'forward' | 'inverse',
): string {
  return `agent-entity-write-receipt:${payload.effectId}:${direction}`;
}
