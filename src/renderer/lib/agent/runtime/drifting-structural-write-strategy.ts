import { and, eq, isNull, or } from 'drizzle-orm';

import type {
  AgentRuntimeEntityWriteKind,
  AgentRuntimeEntityWriteSnapshot,
  AgentRuntimeEntityWriteTool,
  AgentRuntimeEntityRelationSnapshotValue,
  PersistedAgentRuntimeEntityWriteReceipt,
} from '../../../domain/agent-runtime-entity-write-receipt';
import { snapshotAgentRuntimeEntity } from '../../../domain/agent-runtime-entity-write-receipt';
import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import {
  findElementNameConflict,
  makeUniqueElementName,
} from '../../../domain/book-element';
import type { BookNode } from '../../../domain/book-node';
import { makeUniqueNodeTitle } from '../../../domain/book-node';
import {
  createPlainCommentDoc,
  type Comment,
  type CommentKind,
  type CommentStatus,
  type CommentTargetKind,
} from '../../../domain/comment';
import {
  isStructuralEntityKind,
  type EntityKind,
} from '../../../domain/entity-kinds';
import type { PersistedAgentRuntimeWriteExpectation } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import { stringifyKv, type KvEntry } from '../../../domain/kv';
import type { Storyline } from '../../../domain/storyline';
import { makeUniqueStorylineName } from '../../../domain/storyline';
import { getDb, type DbExecutor, type DbTransaction } from '../../../lib/db';
import {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
} from '../../../services/entity-sync.service';
import {
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  CommentTable,
  ElementCategoryTable,
  ElementPatchTable,
  EntityRelationTable,
  LibraryItemTable,
  NodeStorylineLinkTable,
  StorylineTable,
} from '../../../schema/drizzle';
import {
  createAgentRuntimeEntityWriteReceiptRepository,
  type AgentRuntimeEntityWriteReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-entity-write-receipt-repo';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createBookElementSqliteRepository } from '../../../sqlite-repo/element-repo';
import { createElementCategoryRepository } from '../../../sqlite-repo/element-category-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createCommentRepository } from '../../../sqlite-repo/comment-repo';
import { createProjectRepository } from '../../../sqlite-repo/project-repo';
import { createStorylineRepository } from '../../../sqlite-repo/storyline-repo';
import { useDataStore, type EntityRelationLink } from '../../../store/data-store';
import type { EntityAtomicTransactionRunner } from '../../../usecase/synced-entity-commands';
import { effectiveAgentEditMode } from '../agent-edit-mode';
import { throwIfAgentAborted } from './errors';
import {
  deterministicAgentEntityId,
  hashEntityWriteValue,
} from './entity-write-revision';
import type { DriftingWriteStrategy } from './drifting-write-strategies';
import type { AgentToolExecutionRequest } from './types';

export const DRIFTING_STRUCTURAL_WRITE_TOOLS = [
  'create_node',
  'delete_node',
  'create_element',
  'delete_element',
  'create_storyline',
  'delete_storyline',
  'create_category',
  'update_category',
  'delete_category',
  'update_comment',
  'delete_comment',
  'set_comment_status',
  'set_comment_kind',
  'add_relation',
  'update_relation_kind',
  'remove_relation',
] as const satisfies readonly AgentRuntimeEntityWriteTool[];

export type DriftingStructuralWriteTool =
  (typeof DRIFTING_STRUCTURAL_WRITE_TOOLS)[number];

type ExpectedEntityKind =
  | 'project'
  | 'node'
  | 'element'
  | 'storyline'
  | 'category'
  | 'comment'
  | 'relation';

type StructuralEntityWriteKind = Exclude<
  AgentRuntimeEntityWriteKind,
  'project' | 'storyline_membership' | 'memory'
>;

type StructuralMutation =
  | { kind: 'create_node'; value: BookNode; contentJson: string }
  | { kind: 'create_element'; value: BookElement }
  | { kind: 'create_storyline'; value: Storyline }
  | { kind: 'create_category'; value: BookElementCategory }
  | { kind: 'delete_entity' }
  | { kind: 'update_category'; updates: Partial<BookElementCategory> }
  | { kind: 'update_comment'; updates: Partial<Comment> }
  | { kind: 'add_relation'; value: AgentRuntimeEntityRelationSnapshotValue }
  | { kind: 'update_relation'; kindValue: string | null };

interface StructuralWritePayload {
  kind: 'structural_write_command';
  commandId: string;
  effectId: string;
  toolName: DriftingStructuralWriteTool;
  projectId: string;
  entityKind: StructuralEntityWriteKind;
  entityId: string;
  expectedEntityKind: ExpectedEntityKind;
  expectedEntityId: string;
  expectedRevision: string;
  preimage: AgentRuntimeEntityWriteSnapshot | null;
  mutation: StructuralMutation;
  reviewSnapshot: {
    version: 1;
    effectId: string;
    reviewId: string;
    mode: 'auto' | 'approve';
  };
}

interface AtomicResult {
  receipt: PersistedAgentRuntimeEntityWriteReceipt;
  syncPersisted: boolean;
}

export interface DriftingStructuralWriteStrategyOptions {
  freshness: AgentRuntimeFreshnessRepository;
  db?: DbExecutor;
  receipts?: AgentRuntimeEntityWriteReceiptRepository;
  now?: () => string;
  persistSyncMutation?: typeof persistSyncMutationInTransaction;
  notifySyncCommitted?: typeof notifySyncMutationCommitted;
}

export function createDriftingStructuralWriteStrategy(
  toolName: DriftingStructuralWriteTool,
  options: DriftingStructuralWriteStrategyOptions,
): DriftingWriteStrategy {
  const db = options.db ?? getDb();
  const receipts =
    options.receipts ?? createAgentRuntimeEntityWriteReceiptRepository(db);
  const now = options.now ?? (() => new Date().toISOString());
  const persistSyncMutation =
    options.persistSyncMutation ?? persistSyncMutationInTransaction;
  const notifySyncCommitted =
    options.notifySyncCommitted ?? notifySyncMutationCommitted;

  return {
    async prepare(request, _context, expectation) {
      throwIfAgentAborted(request.signal);
      const payload = await preparePayload(toolName, request, expectation, db, now);
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
      notifyCommittedSafely(committed.syncPersisted, notifySyncCommitted);
      projectSnapshot(payload, committed.receipt.postimage);
      return handlerResult(payload, committed.receipt.postimage);
    },

    async captureEffect(_request, _context, result, prepared) {
      const payload = parsePayload(prepared.forward, toolName);
      assertHandlerResult(result, payload);
      const receipt = await receipts.get(payload.commandId, 'forward');
      assertReceipt(receipt, payload, 'forward');
      return committedEffect(payload, receipt);
    },

    async reconcileEnteredEffect(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.forward, toolName);
      assertEffect(effect, payload);
      const receipt = await receipts.get(payload.commandId, 'forward');
      if (!receipt) return null;
      assertReceipt(receipt, payload, 'forward');
      projectSnapshot(payload, receipt.postimage);
      return {
        handlerResult: handlerResult(payload, receipt.postimage),
        committedEffect: { ...committedEffect(payload, receipt), reconciled: true },
      };
    },

    async applyInverse(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.inverse, toolName);
      assertEffect(effect, payload);
      const forward = await receipts.get(payload.commandId, 'forward');
      assertReceipt(forward, payload, 'forward');
      const existing = await receipts.get(payload.commandId, 'inverse');
      if (existing) {
        assertReceipt(existing, payload, 'inverse');
        projectSnapshot(payload, existing.postimage);
        return inverseEffect(existing, true);
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
      notifyCommittedSafely(committed.syncPersisted, notifySyncCommitted);
      projectSnapshot(payload, committed.receipt.postimage);
      return inverseEffect(committed.receipt, false);
    },
  };
}

async function preparePayload(
  toolName: DriftingStructuralWriteTool,
  request: AgentToolExecutionRequest,
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  db: DbExecutor,
  now: () => string,
): Promise<StructuralWritePayload> {
  const projectId = request.context.route.projectId;
  if (!projectId) throw new Error(`${toolName} requires a project route`);
  const effectId = `agent-write:${request.idempotencyKey}`;
  const base = {
    kind: 'structural_write_command' as const,
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

  if (toolName.startsWith('create_') || toolName === 'add_relation') {
    const project = await createProjectRepository(undefined, db).findById(projectId);
    if (!project) throw new Error(`Project "${projectId}" no longer exists`);
    requireExpectation(expectation, request, 'project', projectId);
    assertExpectedRevision(expectation, project.updatedAt, 'get_project_brief');
    const common = {
      ...base,
      expectedEntityKind: 'project' as const,
      expectedEntityId: projectId,
      expectedRevision: expectation!.expectedRevision,
      preimage: null,
    };
    const timestamp = now();
    if (toolName === 'create_node') {
      const kind = request.arguments.kind === 'chapter' ? 'chapter' : 'drift';
      const nodes = await createBookNodeSqliteRepository(projectId, db).findAll();
      const title = makeUniqueNodeTitle(
        requiredString(request.arguments.title, 'create_node requires title'),
        nodes,
        projectId,
      );
      const id = await deterministicAgentEntityId(request.idempotencyKey, 'node');
      const maxOrder = nodes
        .filter((node) => node.kind === kind)
        .reduce(
          (maximum, node) =>
            Math.max(
              maximum,
              kind === 'chapter' ? (node.bookOrder ?? 0) : (node.narrativeOrder ?? 0),
            ),
          0,
        );
      const shared = {
        id,
        projectId,
        title,
        summary: '',
        narrativeOrder: kind === 'drift' ? maxOrder + 1 : null,
        driftGroupId: null,
        position: { x: 0, y: 0 },
        wordCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const value: BookNode =
        kind === 'chapter'
          ? {
              ...shared,
              kind: 'chapter',
              bookOrder: maxOrder + 1,
              writingStatus: 'draft',
            }
          : {
              ...shared,
              kind: 'drift',
              bookOrder: null,
              writingStatus: 'drifting',
            };
      return {
        ...common,
        entityKind: 'node',
        entityId: id,
        mutation: {
          kind: 'create_node',
          value,
          contentJson: createPlainCommentDoc(String(request.arguments.body ?? '')),
        },
      };
    }
    if (toolName === 'create_element') {
      const category = resolveCategory(projectId, request.arguments.category);
      const elements = await createBookElementSqliteRepository(projectId, db).findAll();
      const requestedName = requiredString(
        request.arguments.name,
        'create_element requires name',
      );
      const name = makeUniqueElementName(requestedName, elements, projectId);
      const aliases = stringArray(request.arguments.aliases);
      const conflict = findElementNameConflict([name, ...aliases], elements, projectId);
      if (conflict) throw new Error(`Element name "${conflict.conflictingName}" already exists`);
      const id = await deterministicAgentEntityId(request.idempotencyKey, 'element');
      const value: BookElement = {
        id,
        projectId,
        categoryId: category.id,
        name,
        summary: String(request.arguments.summary ?? ''),
        contentJson: createPlainCommentDoc(String(request.arguments.body ?? '')),
        kvJson: stringifyKv(parseFacts(request.arguments.facts)),
        aliases,
        groupName:
          typeof request.arguments.groupName === 'string'
            ? request.arguments.groupName.trim() || null
            : null,
        portraitAssetId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return {
        ...common,
        entityKind: 'element',
        entityId: id,
        mutation: { kind: 'create_element', value },
      };
    }
    if (toolName === 'create_storyline') {
      const storylines = await createStorylineRepository(
        projectId,
        db,
      ).getStorylinesByProject();
      const id = await deterministicAgentEntityId(request.idempotencyKey, 'storyline');
      const value: Storyline = {
        id,
        projectId,
        name: makeUniqueStorylineName(
          requiredString(request.arguments.name, 'create_storyline requires name'),
          storylines,
          projectId,
        ),
        color: '#8B7355',
        summary: String(request.arguments.summary ?? ''),
        orderKey: storylines.reduce((maximum, item) => Math.max(maximum, item.orderKey), 0) + 1,
        contentJson: createPlainCommentDoc(String(request.arguments.body ?? '')),
        kvJson: project.storylineTemplateKvJson || '[]',
        nodeContentTemplateJson: '{}',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return {
        ...common,
        entityKind: 'storyline',
        entityId: id,
        mutation: { kind: 'create_storyline', value },
      };
    }
    if (toolName === 'create_category') {
      const existing = await createElementCategoryRepository(projectId, db).findAll();
      const name = requiredString(request.arguments.name, 'create_category requires name');
      if (existing.some((item) => sameName(item.name, name))) {
        throw new Error(`Category "${name}" already exists`);
      }
      const id = await deterministicAgentEntityId(request.idempotencyKey, 'category');
      const value: BookElementCategory = {
        id,
        projectId,
        name,
        contentJson: createPlainCommentDoc(String(request.arguments.body ?? '')),
        elementTemplateJson: '{}',
        elementTemplateKvJson: '[]',
        color: '#8B7355',
        layoutMode: 'auto',
        gridX: null,
        gridY: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return {
        ...common,
        entityKind: 'category',
        entityId: id,
        mutation: { kind: 'create_category', value },
      };
    }
    const fromKind = normalizeEntityKind(
      requiredString(request.arguments.fromKind, 'add_relation requires fromKind'),
    );
    const toKind = normalizeEntityKind(
      requiredString(request.arguments.toKind, 'add_relation requires toKind'),
    );
    if (!isStructuralEntityKind(toKind)) {
      throw new Error(`Relation target kind "${toKind}" is not structural`);
    }
    const fromId = await resolveEntityId(
      db,
      projectId,
      fromKind,
      request.arguments.from,
    );
    const toId = await resolveEntityId(
      db,
      projectId,
      toKind,
      request.arguments.to,
    );
    const id = await deterministicAgentEntityId(request.idempotencyKey, 'relation');
    const value: AgentRuntimeEntityRelationSnapshotValue = {
      id,
      projectId,
      fromKind,
      fromId,
      toKind,
      toId,
      kind:
        typeof request.arguments.kind === 'string'
          ? request.arguments.kind.trim() || null
          : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return {
      ...common,
      entityKind: 'relation',
      entityId: id,
      mutation: { kind: 'add_relation', value },
    };
  }

  const resolved = await resolveExistingTarget(toolName, projectId, request.arguments, db);
  requireExpectation(
    expectation,
    request,
    resolved.entityKind,
    resolved.snapshot.value.id,
  );
  assertExpectedRevision(expectation, resolved.snapshot.value.updatedAt, resolved.readTool);
  const common = {
    ...base,
    entityKind: resolved.snapshot.kind as StructuralEntityWriteKind,
    entityId: resolved.snapshot.value.id,
    expectedEntityKind: resolved.entityKind,
    expectedEntityId: resolved.snapshot.value.id,
    expectedRevision: expectation!.expectedRevision,
    preimage: resolved.snapshot,
  };
  if (toolName.startsWith('delete_') || toolName === 'remove_relation') {
    await assertStructuralDeleteAllowed(
      db,
      projectId,
      common.entityKind,
      common.entityId,
    );
    return { ...common, mutation: { kind: 'delete_entity' } };
  }
  if (toolName === 'update_category') {
    const before = resolved.snapshot.value as BookElementCategory;
    const updates: Partial<BookElementCategory> = {};
    if (typeof request.arguments.name === 'string') {
      const name = request.arguments.name.trim();
      if (name && name !== before.name) updates.name = name;
    }
    if (request.arguments.templateFacts !== undefined) {
      updates.elementTemplateKvJson = stringifyKv(parseFacts(request.arguments.templateFacts));
    }
    if (Object.keys(updates).length === 0) {
      throw new Error('update_category requires a changed name or templateFacts; edit body.md for category prose');
    }
    return { ...common, mutation: { kind: 'update_category', updates } };
  }
  if (
    toolName === 'update_comment' ||
    toolName === 'set_comment_status' ||
    toolName === 'set_comment_kind'
  ) {
    const before = resolved.snapshot.value as Comment;
    const updates: Partial<Comment> = {};
    if (typeof request.arguments.body === 'string') {
      updates.bodyJson = createPlainCommentDoc(request.arguments.body);
    }
    const kind = parseCommentKind(request.arguments.kind);
    if (kind) updates.kind = kind;
    const status = parseCommentStatus(request.arguments.status);
    if (status) {
      updates.status = status;
      updates.resolvedAt = status === 'resolved' ? now() : null;
    }
    if (typeof request.arguments.targetKind === 'string') {
      const targetKind = normalizeEntityKind(request.arguments.targetKind);
      if (!isStructuralEntityKind(targetKind)) {
        throw new Error(
          'Comment targetKind must be node, element, patch, storyline, or category',
        );
      }
      updates.targetKind = targetKind as CommentTargetKind;
      updates.targetId = await resolveEntityId(
        db,
        projectId,
        targetKind,
        request.arguments.target,
      );
    }
    if (Object.keys(updates).length === 0) {
      throw new Error(`${toolName} requires a changed body, kind, status, or target`);
    }
    if (
      Object.entries(updates).every(
        ([key, value]) => value === before[key as keyof Comment],
      )
    ) {
      throw new Error(`${toolName} would not change the comment`);
    }
    return { ...common, mutation: { kind: 'update_comment', updates } };
  }
  const kindValue =
    typeof request.arguments.kind === 'string'
      ? request.arguments.kind.trim() || null
      : null;
  const before = resolved.snapshot.value as AgentRuntimeEntityRelationSnapshotValue;
  if (kindValue === before.kind) throw new Error('The relation kind is unchanged');
  return { ...common, mutation: { kind: 'update_relation', kindValue } };
}

async function resolveExistingTarget(
  toolName: DriftingStructuralWriteTool,
  projectId: string,
  args: Record<string, unknown>,
  db: DbExecutor,
): Promise<{
  entityKind: Exclude<ExpectedEntityKind, 'project'>;
  snapshot: AgentRuntimeEntityWriteSnapshot;
  readTool: string;
}> {
  if (toolName === 'delete_node') {
    const node = resolveNode(projectId, args.node);
    const value = await createBookNodeSqliteRepository(projectId, db).findById(node.id);
    if (!value) throw new Error('The node no longer exists');
    return { entityKind: 'node', snapshot: snapshotAgentRuntimeEntity(value, 'node'), readTool: 'read_node' };
  }
  if (toolName === 'delete_element') {
    const element = resolveElement(projectId, args.element);
    const value = await createBookElementSqliteRepository(projectId, db).findById(element.id);
    if (!value) throw new Error('The element no longer exists');
    return { entityKind: 'element', snapshot: snapshotAgentRuntimeEntity(value, 'element'), readTool: 'read_element' };
  }
  if (toolName === 'delete_storyline') {
    const storyline = resolveStoryline(projectId, args.storyline);
    const value = await createStorylineRepository(projectId, db).getStorylineById(storyline.id);
    if (!value) throw new Error('The storyline no longer exists');
    return { entityKind: 'storyline', snapshot: snapshotAgentRuntimeEntity(value, 'storyline'), readTool: 'get_storyline' };
  }
  if (toolName === 'delete_category' || toolName === 'update_category') {
    const category = resolveCategory(projectId, args.category);
    return {
      entityKind: 'category',
      snapshot: snapshotAgentRuntimeEntity(category, 'category'),
      readTool: 'read_node',
    };
  }
  if (
    toolName === 'delete_comment' ||
    toolName === 'update_comment' ||
    toolName === 'set_comment_status' ||
    toolName === 'set_comment_kind'
  ) {
    const id = requiredString(args.commentId, `${toolName} requires commentId`);
    const value = await createCommentRepository(projectId, db).findById(id);
    if (!value || value.projectId !== projectId) throw new Error(`Comment "${id}" no longer exists`);
    return { entityKind: 'comment', snapshot: snapshotAgentRuntimeEntity(value, 'comment'), readTool: 'list_comments' };
  }
  const id = requiredString(args.relationId, `${toolName} requires relationId`);
  const value = await loadRelation(db, projectId, id);
  if (!value) throw new Error(`Relation "${id}" no longer exists`);
  return { entityKind: 'relation', snapshot: snapshotAgentRuntimeEntity(value, 'relation'), readTool: 'get_entity_relations' };
}

async function readCurrentVersion(
  tx: DbExecutor,
  expectation: PersistedAgentRuntimeWriteExpectation,
  payload: StructuralWritePayload,
): Promise<{ revision: string } | null> {
  if (
    expectation.projectId !== payload.projectId ||
    expectation.entityKind !== payload.expectedEntityKind ||
    expectation.entityId !== payload.expectedEntityId
  ) {
    return null;
  }
  if (payload.expectedEntityKind === 'project') {
    const value = await createProjectRepository(undefined, tx).findById(payload.projectId);
    return value ? { revision: value.updatedAt } : null;
  }
  const snapshot = await loadActiveSnapshot(
    tx,
    payload.projectId,
    payload.expectedEntityKind,
    payload.expectedEntityId,
  );
  return snapshot ? { revision: snapshot.value.updatedAt } : null;
}

async function applyForwardInTransaction(
  tx: DbExecutor,
  payload: StructuralWritePayload,
  sessionId: string,
  now: () => string,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): Promise<AtomicResult> {
  const sync = transactionRunner(tx, persistSyncMutation);
  let postimage: AgentRuntimeEntityWriteSnapshot | null = null;
  switch (payload.mutation.kind) {
    case 'create_node': {
      const contentJson = payload.mutation.contentJson;
      const value = await createBookNodeSqliteRepository(payload.projectId, tx).create(
        payload.mutation.value,
      );
      await createBookContentRepository(tx).create({
        nodeId: value.id,
        contentJson,
      });
      await sync.runner(payload.projectId, async (_inner, writeSync) => {
        await writeSync('node', 'create', value.id, payload.projectId, nodePayload(value));
        await writeSync('nodeContent', 'update', value.id, payload.projectId, {
          contentJson,
        });
      });
      postimage = snapshotAgentRuntimeEntity(value, 'node');
      break;
    }
    case 'create_element': {
      const value = await createBookElementSqliteRepository(payload.projectId, tx).create(
        payload.mutation.value,
      );
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('element', 'create', value.id, payload.projectId, elementPayload(value)),
      );
      postimage = snapshotAgentRuntimeEntity(value, 'element');
      break;
    }
    case 'create_storyline': {
      const value = await createStorylineRepository(payload.projectId, tx).createStoryline(
        payload.mutation.value,
      );
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('storyline', 'create', value.id, payload.projectId, storylinePayload(value)),
      );
      postimage = snapshotAgentRuntimeEntity(value, 'storyline');
      break;
    }
    case 'create_category': {
      const value = await createElementCategoryRepository(payload.projectId, tx).create(
        payload.mutation.value,
      );
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('elementCategory', 'create', value.id, payload.projectId, categoryPayload(value)),
      );
      postimage = snapshotAgentRuntimeEntity(value, 'category');
      break;
    }
    case 'add_relation': {
      const relation = payload.mutation.value;
      await assertRelationEndpoints(tx, relation);
      await tx.insert(EntityRelationTable).values(relation);
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('entityRelation', 'create', payload.entityId, payload.projectId, relationPayload(relation)),
      );
      postimage = snapshotAgentRuntimeEntity(relation, 'relation');
      break;
    }
    case 'delete_entity': {
      await assertStructuralDeleteAllowed(
        tx,
        payload.projectId,
        payload.entityKind,
        payload.entityId,
      );
      await deleteEntity(tx, payload, now());
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync(syncEntityType(payload.entityKind), structuralDeleteMutation(payload.entityKind), payload.entityId, payload.projectId),
      );
      break;
    }
    case 'update_category': {
      const value = await createElementCategoryRepository(payload.projectId, tx).update(
        payload.entityId,
        { ...payload.mutation.updates, updatedAt: now() },
      );
      if (!value) throw new Error('The category disappeared during update');
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('elementCategory', 'update', value.id, payload.projectId, categoryPayload(value)),
      );
      postimage = snapshotAgentRuntimeEntity(value, 'category');
      break;
    }
    case 'update_comment': {
      const value = await createCommentRepository(payload.projectId, tx).update(
        payload.entityId,
        { ...payload.mutation.updates, updatedAt: now() },
      );
      if (!value) throw new Error('The comment disappeared during update');
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('comment', 'update', value.id, payload.projectId, commentPayload(value)),
      );
      postimage = snapshotAgentRuntimeEntity(value, 'comment');
      break;
    }
    case 'update_relation': {
      const timestamp = now();
      const rows = await tx
        .update(EntityRelationTable)
        .set({ kind: payload.mutation.kindValue, updatedAt: timestamp })
        .where(
          and(
            eq(EntityRelationTable.id, payload.entityId),
            eq(EntityRelationTable.projectId, payload.projectId),
          ),
        )
        .returning();
      if (!rows[0]) throw new Error('The relation disappeared during update');
      const value = relationFromRow(rows[0]);
      await sync.runner(payload.projectId, (_inner, writeSync) =>
        writeSync('entityRelation', 'update', value.id, payload.projectId, { kind: value.kind }),
      );
      postimage = snapshotAgentRuntimeEntity(value, 'relation');
      break;
    }
  }
  const receipt = await createAgentRuntimeEntityWriteReceiptRepository(tx).persist({
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
    resultRevision: postimage?.value.updatedAt ?? null,
    preimage: payload.preimage,
    preimageHash: payload.preimage ? await hashEntityWriteValue(payload.preimage) : null,
    postimage,
    postimageHash: postimage ? await hashEntityWriteValue(postimage) : null,
    createdAt: now(),
  });
  return { receipt, syncPersisted: sync.persisted() };
}

async function applyInverseInTransaction(
  tx: DbExecutor,
  payload: StructuralWritePayload,
  effect: PersistedAgentRuntimeWriteEffect,
  forward: PersistedAgentRuntimeEntityWriteReceipt,
  now: () => string,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): Promise<AtomicResult> {
  const receiptRepo = createAgentRuntimeEntityWriteReceiptRepository(tx);
  const raced = await receiptRepo.get(payload.commandId, 'inverse');
  if (raced) return { receipt: raced, syncPersisted: false };
  const sync = transactionRunner(tx, persistSyncMutation);
  let postimage: AgentRuntimeEntityWriteSnapshot | null = null;
  if (isCreateTool(payload.toolName)) {
    const current = await loadActiveSnapshot(tx, payload.projectId, payload.entityKind, payload.entityId);
    await assertUnchanged(current, forward, 'The created entity changed; exact reject is unavailable');
    await hardDeleteCreatedEntity(tx, payload);
    await sync.runner(payload.projectId, (_inner, writeSync) =>
      writeSync(syncEntityType(payload.entityKind), 'delete', payload.entityId, payload.projectId),
    );
  } else if (isDeleteTool(payload.toolName)) {
    if (!payload.preimage) throw new Error('The delete inverse lost its preimage');
    postimage = await restoreDeletedEntity(tx, payload, payload.preimage, now());
    await sync.runner(payload.projectId, (_inner, writeSync) =>
      writeSync(syncEntityType(payload.entityKind), structuralRestoreMutation(payload.entityKind), payload.entityId, payload.projectId, snapshotPayload(postimage!)),
    );
  } else {
    const current = await loadActiveSnapshot(tx, payload.projectId, payload.entityKind, payload.entityId);
    await assertUnchanged(current, forward, 'The updated entity changed; exact reject is unavailable');
    if (!payload.preimage) throw new Error('The update inverse lost its preimage');
    postimage = await restoreUpdatedEntity(tx, payload, payload.preimage, now());
    await sync.runner(payload.projectId, (_inner, writeSync) =>
      writeSync(syncEntityType(payload.entityKind), 'update', payload.entityId, payload.projectId, snapshotPayload(postimage!)),
    );
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
    preimageHash: payload.preimage ? await hashEntityWriteValue(payload.preimage) : null,
    postimage,
    postimageHash: postimage ? await hashEntityWriteValue(postimage) : null,
    createdAt: now(),
  });
  return { receipt, syncPersisted: sync.persisted() };
}

async function deleteEntity(
  tx: DbExecutor,
  payload: StructuralWritePayload,
  timestamp: string,
): Promise<void> {
  if (payload.entityKind === 'comment') {
    await createCommentRepository(payload.projectId, tx).delete(payload.entityId);
    return;
  }
  if (payload.entityKind === 'relation') {
    await tx.delete(EntityRelationTable).where(eq(EntityRelationTable.id, payload.entityId));
    return;
  }
  const table = structuralTable(payload.entityKind);
  await tx
    .update(table)
    .set({ deletedAt: timestamp, updatedAt: timestamp })
    .where(and(eq(table.id, payload.entityId), eq(table.projectId, payload.projectId)));
}

async function assertStructuralDeleteAllowed(
  db: DbExecutor,
  projectId: string,
  entityKind: StructuralEntityWriteKind,
  entityId: string,
): Promise<void> {
  if (entityKind !== 'relation') {
    const relation = await db
      .select({ id: EntityRelationTable.id })
      .from(EntityRelationTable)
      .where(
        and(
          eq(EntityRelationTable.projectId, projectId),
          or(
            and(
              eq(EntityRelationTable.fromKind, entityKind),
              eq(EntityRelationTable.fromId, entityId),
            ),
            and(
              eq(EntityRelationTable.toKind, entityKind),
              eq(EntityRelationTable.toId, entityId),
            ),
          ),
        ),
      )
      .limit(1);
    if (relation[0]) {
      throw new Error(
        'This entity still has a curated relation. Remove its /relations/*.json file before deleting the entity.',
      );
    }
  }

  if (
    entityKind === 'node' ||
    entityKind === 'element' ||
    entityKind === 'storyline' ||
    entityKind === 'category'
  ) {
    const comment = await db
      .select({ id: CommentTable.id })
      .from(CommentTable)
      .where(
        and(
          eq(CommentTable.projectId, projectId),
          eq(CommentTable.targetKind, entityKind),
          eq(CommentTable.targetId, entityId),
        ),
      )
      .limit(1);
    if (comment[0]) {
      throw new Error(
        'This entity still has an attached comment or TODO. Delete or retarget its /comments/*.json file first.',
      );
    }
  }

  if (entityKind === 'comment') {
    const action = await db
      .select({ id: CommentActionTable.id })
      .from(CommentActionTable)
      .where(
        and(
          eq(CommentActionTable.projectId, projectId),
          eq(CommentActionTable.commentId, entityId),
        ),
      )
      .limit(1);
    if (action[0]) {
      throw new Error(
        'This comment has an action history and cannot be exactly deleted by the Agent.',
      );
    }
  }

  if (entityKind === 'category') {
    const child = await db
      .select({ id: BookElementTable.id })
      .from(BookElementTable)
      .where(
        and(
          eq(BookElementTable.projectId, projectId),
          eq(BookElementTable.categoryId, entityId),
          isNull(BookElementTable.deletedAt),
        ),
      )
      .limit(1);
    if (child[0]) {
      throw new Error(
        'This category still contains elements. Move or delete those elements before deleting the category.',
      );
    }
  }

  if (entityKind === 'node' || entityKind === 'storyline') {
    const membership = await db
      .select({ nodeId: NodeStorylineLinkTable.nodeId })
      .from(NodeStorylineLinkTable)
      .where(
        entityKind === 'node'
          ? eq(NodeStorylineLinkTable.nodeId, entityId)
          : eq(NodeStorylineLinkTable.storylineId, entityId),
      )
      .limit(1);
    if (membership[0]) {
      throw new Error(
        'This entity still has a storyline membership. Unlink it before deleting the entity.',
      );
    }
  }
}

async function hardDeleteCreatedEntity(tx: DbExecutor, payload: StructuralWritePayload): Promise<void> {
  if (payload.entityKind === 'comment') {
    await createCommentRepository(payload.projectId, tx).delete(payload.entityId);
    return;
  }
  if (payload.entityKind === 'relation') {
    await tx.delete(EntityRelationTable).where(eq(EntityRelationTable.id, payload.entityId));
    return;
  }
  if (payload.entityKind === 'node') {
    await tx.delete(BookNodeTable).where(eq(BookNodeTable.id, payload.entityId));
    return;
  }
  const table = structuralTable(payload.entityKind);
  await tx.delete(table).where(eq(table.id, payload.entityId));
}

async function restoreDeletedEntity(
  tx: DbExecutor,
  payload: StructuralWritePayload,
  preimage: AgentRuntimeEntityWriteSnapshot,
  updatedAt: string,
): Promise<AgentRuntimeEntityWriteSnapshot> {
  if (preimage.kind === 'comment') {
    const value = await createCommentRepository(payload.projectId, tx).create({
      ...preimage.value,
      updatedAt,
    });
    return snapshotAgentRuntimeEntity(value, 'comment');
  }
  if (preimage.kind === 'relation') {
    const value = { ...preimage.value, updatedAt };
    await tx.insert(EntityRelationTable).values(value);
    return snapshotAgentRuntimeEntity(value, 'relation');
  }
  if (
    preimage.kind === 'project' ||
    preimage.kind === 'storyline_membership' ||
    preimage.kind === 'memory'
  ) {
    throw new Error(
      `${preimage.kind} cannot be restored through a structural entity delete`,
    );
  }
  const table = structuralTable(preimage.kind);
  await tx
    .update(table)
    .set({ deletedAt: null, updatedAt })
    .where(and(eq(table.id, payload.entityId), eq(table.projectId, payload.projectId)));
  const restored = await loadActiveSnapshot(tx, payload.projectId, preimage.kind, payload.entityId);
  if (!restored) throw new Error('The deleted entity could not be restored');
  return restored;
}

async function restoreUpdatedEntity(
  tx: DbExecutor,
  payload: StructuralWritePayload,
  preimage: AgentRuntimeEntityWriteSnapshot,
  updatedAt: string,
): Promise<AgentRuntimeEntityWriteSnapshot> {
  if (preimage.kind === 'category') {
    const value = await createElementCategoryRepository(payload.projectId, tx).update(
      payload.entityId,
      { ...preimage.value, updatedAt },
    );
    if (!value) throw new Error('The category inverse failed');
    return snapshotAgentRuntimeEntity(value, 'category');
  }
  if (preimage.kind === 'comment') {
    const value = await createCommentRepository(payload.projectId, tx).update(
      payload.entityId,
      { ...preimage.value, updatedAt },
    );
    if (!value) throw new Error('The comment inverse failed');
    return snapshotAgentRuntimeEntity(value, 'comment');
  }
  if (preimage.kind === 'relation') {
    const rows = await tx
      .update(EntityRelationTable)
      .set({ kind: preimage.value.kind, updatedAt })
      .where(eq(EntityRelationTable.id, payload.entityId))
      .returning();
    if (!rows[0]) throw new Error('The relation inverse failed');
    return snapshotAgentRuntimeEntity(relationFromRow(rows[0]), 'relation');
  }
  throw new Error(`Unsupported structural update inverse for ${preimage.kind}`);
}

async function loadActiveSnapshot(
  tx: DbExecutor,
  projectId: string,
  kind: ExpectedEntityKind,
  id: string,
): Promise<AgentRuntimeEntityWriteSnapshot | null> {
  if (kind === 'node') {
    const active = await tx.select({ id: BookNodeTable.id }).from(BookNodeTable).where(and(eq(BookNodeTable.id, id), eq(BookNodeTable.projectId, projectId), isNull(BookNodeTable.deletedAt))).limit(1);
    if (!active[0]) return null;
    const value = await createBookNodeSqliteRepository(projectId, tx).findById(id);
    return value ? snapshotAgentRuntimeEntity(value, 'node') : null;
  }
  if (kind === 'element') {
    const active = await tx.select({ id: BookElementTable.id }).from(BookElementTable).where(and(eq(BookElementTable.id, id), eq(BookElementTable.projectId, projectId), isNull(BookElementTable.deletedAt))).limit(1);
    if (!active[0]) return null;
    const value = await createBookElementSqliteRepository(projectId, tx).findById(id);
    return value ? snapshotAgentRuntimeEntity(value, 'element') : null;
  }
  if (kind === 'storyline') {
    const active = await tx.select({ id: StorylineTable.id }).from(StorylineTable).where(and(eq(StorylineTable.id, id), eq(StorylineTable.projectId, projectId), isNull(StorylineTable.deletedAt))).limit(1);
    if (!active[0]) return null;
    const value = await createStorylineRepository(projectId, tx).getStorylineById(id);
    return value ? snapshotAgentRuntimeEntity(value, 'storyline') : null;
  }
  if (kind === 'category') {
    const rows = await tx.select().from(ElementCategoryTable).where(and(eq(ElementCategoryTable.id, id), eq(ElementCategoryTable.projectId, projectId), isNull(ElementCategoryTable.deletedAt))).limit(1);
    return rows[0]
      ? snapshotAgentRuntimeEntity(rows[0] as BookElementCategory, 'category')
      : null;
  }
  if (kind === 'comment') {
    const value = await createCommentRepository(projectId, tx).findById(id);
    return value?.projectId === projectId
      ? snapshotAgentRuntimeEntity(value, 'comment')
      : null;
  }
  if (kind === 'relation') {
    const value = await loadRelation(tx, projectId, id);
    return value ? snapshotAgentRuntimeEntity(value, 'relation') : null;
  }
  return null;
}

async function loadRelation(
  db: DbExecutor,
  projectId: string,
  id: string,
): Promise<AgentRuntimeEntityRelationSnapshotValue | null> {
  const rows = await db
    .select()
    .from(EntityRelationTable)
    .where(and(eq(EntityRelationTable.id, id), eq(EntityRelationTable.projectId, projectId)))
    .limit(1);
  return rows[0] ? relationFromRow(rows[0]) : null;
}

function relationFromRow(
  row: typeof EntityRelationTable.$inferSelect,
): AgentRuntimeEntityRelationSnapshotValue {
  return {
    id: row.id,
    projectId: row.projectId,
    fromKind: row.fromKind,
    fromId: row.fromId,
    toKind: row.toKind,
    toId: row.toId,
    kind: row.kind ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function structuralTable(kind: 'node' | 'element' | 'storyline' | 'category') {
  if (kind === 'node') return BookNodeTable;
  if (kind === 'element') return BookElementTable;
  if (kind === 'storyline') return StorylineTable;
  return ElementCategoryTable;
}

function syncEntityType(kind: StructuralEntityWriteKind) {
  if (kind === 'category') return 'elementCategory' as const;
  if (kind === 'relation') return 'entityRelation' as const;
  return kind;
}

function structuralDeleteMutation(kind: StructuralEntityWriteKind) {
  return kind === 'comment' || kind === 'relation' ? ('delete' as const) : ('softDelete' as const);
}

function structuralRestoreMutation(kind: StructuralEntityWriteKind) {
  return kind === 'comment' || kind === 'relation' ? ('create' as const) : ('restore' as const);
}

function snapshotPayload(snapshot: AgentRuntimeEntityWriteSnapshot): Record<string, unknown> {
  if (snapshot.kind === 'node') return nodePayload(snapshot.value);
  if (snapshot.kind === 'element') return elementPayload(snapshot.value);
  if (snapshot.kind === 'storyline') return storylinePayload(snapshot.value);
  if (snapshot.kind === 'category') return categoryPayload(snapshot.value);
  if (snapshot.kind === 'comment') return commentPayload(snapshot.value);
  if (snapshot.kind === 'relation') return relationPayload(snapshot.value);
  return {};
}

function nodePayload(value: BookNode): Record<string, unknown> {
  return {
    id: value.id,
    title: value.title,
    summary: value.summary,
    bookOrder: value.bookOrder,
    narrativeOrder: value.narrativeOrder,
    kind: value.kind,
    driftGroupId: value.driftGroupId,
    positionX: value.position.x,
    positionY: value.position.y,
    wordCount: value.wordCount,
    writingStatus: value.writingStatus,
  };
}

function elementPayload(value: BookElement): Record<string, unknown> {
  return {
    id: value.id,
    categoryId: value.categoryId,
    name: value.name,
    summary: value.summary,
    contentJson: value.contentJson,
    kvJson: value.kvJson,
    aliasesJson: JSON.stringify(value.aliases),
    groupName: value.groupName,
    portraitAssetId: value.portraitAssetId,
  };
}

function storylinePayload(value: Storyline): Record<string, unknown> {
  return {
    id: value.id,
    name: value.name,
    color: value.color,
    summary: value.summary,
    orderKey: value.orderKey,
    contentJson: value.contentJson,
    kvJson: value.kvJson,
    nodeContentTemplateJson: value.nodeContentTemplateJson,
  };
}

function categoryPayload(value: BookElementCategory): Record<string, unknown> {
  return {
    id: value.id,
    name: value.name,
    contentJson: value.contentJson,
    elementTemplateJson: value.elementTemplateJson,
    elementTemplateKvJson: value.elementTemplateKvJson,
    color: value.color,
    layoutMode: value.layoutMode,
    gridX: value.gridX,
    gridY: value.gridY,
  };
}

function commentPayload(value: Comment): Record<string, unknown> {
  return {
    id: value.id,
    kind: value.kind,
    targetKind: value.targetKind,
    targetId: value.targetId,
    targetBlockId: value.targetBlockId,
    anchorJson: value.anchorJson,
    authorKind: value.authorKind,
    authorId: value.authorId,
    authorName: value.authorName,
    bodyJson: value.bodyJson,
    status: value.status,
    priority: value.priority,
    source: value.source,
    metadataJson: value.metadataJson,
    targetBlockIdsJson: value.targetBlockIdsJson,
    resolvedAt: value.resolvedAt,
  };
}

function relationPayload(value: AgentRuntimeEntityRelationSnapshotValue): Record<string, unknown> {
  return {
    id: value.id,
    fromKind: value.fromKind,
    fromId: value.fromId,
    toKind: value.toKind,
    toId: value.toId,
    kind: value.kind,
  };
}

async function assertRelationEndpoints(
  tx: DbExecutor,
  relation: AgentRuntimeEntityRelationSnapshotValue,
): Promise<void> {
  const from = await entityExists(tx, relation.projectId, relation.fromKind, relation.fromId);
  const to = await entityExists(tx, relation.projectId, relation.toKind, relation.toId);
  if (!from || !to) throw new Error('A relation endpoint no longer exists in this project');
}

async function entityExists(
  tx: DbExecutor,
  projectId: string,
  kind: string,
  id: string,
): Promise<boolean> {
  if (kind === 'comment') {
    return Boolean(await createCommentRepository(projectId, tx).findById(id));
  }
  if (kind === 'patch') {
    const rows = await tx
      .select({ id: ElementPatchTable.id })
      .from(ElementPatchTable)
      .where(
        and(
          eq(ElementPatchTable.id, id),
          eq(ElementPatchTable.projectId, projectId),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }
  if (kind === 'library_item') {
    const rows = await tx
      .select({ id: LibraryItemTable.id })
      .from(LibraryItemTable)
      .where(
        and(
          eq(LibraryItemTable.id, id),
          eq(LibraryItemTable.projectId, projectId),
        ),
      )
      .limit(1);
    return Boolean(rows[0]);
  }
  if (kind === 'node' || kind === 'element' || kind === 'storyline' || kind === 'category') {
    return Boolean(await loadActiveSnapshot(tx, projectId, kind, id));
  }
  return false;
}

function resolveNode(projectId: string, value: unknown) {
  return resolveNamed(
    useDataStore.getState().bookNodes.filter((item) => item.projectId === projectId),
    value,
    (item) => item.title,
    'node',
  );
}

function resolveElement(projectId: string, value: unknown) {
  return resolveNamed(
    useDataStore.getState().bookElements.filter((item) => item.projectId === projectId),
    value,
    (item) => item.name,
    'element',
  );
}

function resolveStoryline(projectId: string, value: unknown) {
  return resolveNamed(
    useDataStore.getState().storylines.filter((item) => item.projectId === projectId),
    value,
    (item) => item.name,
    'storyline',
  );
}

function resolveCategory(projectId: string, value: unknown) {
  try {
    return resolveNamed(
      useDataStore
        .getState()
        .bookElementCategories.filter((item) => item.projectId === projectId),
      value,
      (item) => item.name,
      'category',
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No category named')) {
      const reference = requiredString(value, 'category reference is required');
      throw new Error(
        `${error.message}. Create it first with write_file at ` +
          `"/categories/${reference}/body.md", then retry the same element path.`,
      );
    }
    throw error;
  }
}

function resolveNamed<T extends { id: string }>(
  values: readonly T[],
  raw: unknown,
  name: (value: T) => string,
  kind: string,
): T {
  const reference = requiredString(raw, `${kind} reference is required`);
  const direct = values.find((value) => value.id === reference);
  if (direct) return direct;
  const matches = values.filter((value) => sameName(name(value), reference));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No ${kind} named "${reference}" exists in this project`
        : `${kind} reference "${reference}" is ambiguous`,
    );
  }
  return matches[0]!;
}

async function resolveEntityId(
  db: DbExecutor,
  projectId: string,
  kind: EntityKind,
  value: unknown,
): Promise<string> {
  if (kind === 'node') return resolveNode(projectId, value).id;
  if (kind === 'element') return resolveElement(projectId, value).id;
  if (kind === 'storyline') return resolveStoryline(projectId, value).id;
  if (kind === 'category') return resolveCategory(projectId, value).id;
  if (kind === 'comment') {
    const id = requiredString(value, 'Comment id is required');
    const comment = useDataStore
      .getState()
      .comments.find((item) => item.projectId === projectId && item.id === id);
    if (!comment) throw new Error(`No comment "${id}" exists in this project`);
    return id;
  }
  if (kind === 'library_item') {
    return resolveNamed(
      useDataStore
        .getState()
        .libraryItems.filter((item) => item.projectId === projectId),
      value,
      (item) => item.title,
      'library item',
    ).id;
  }
  const reference = requiredString(value, 'Element patch id or title is required');
  const rows = await db
    .select({ id: ElementPatchTable.id, title: ElementPatchTable.title })
    .from(ElementPatchTable)
    .where(eq(ElementPatchTable.projectId, projectId));
  return resolveNamed(
    rows,
    reference,
    (patch) => patch.title ?? '',
    'element patch',
  ).id;
}

function normalizeEntityKind(value: string): EntityKind {
  if (value === 'chapter' || value === 'drift') return 'node';
  if (value === 'element_patch') return 'patch';
  if (value === 'material') return 'library_item';
  if (
    value === 'node' ||
    value === 'element' ||
    value === 'patch' ||
    value === 'storyline' ||
    value === 'category' ||
    value === 'comment' ||
    value === 'library_item'
  ) {
    return value;
  }
  throw new Error(`Unsupported entity kind "${value}"`);
}

function parseCommentKind(value: unknown): CommentKind | null {
  return value === 'note' || value === 'todo' || value === 'exception' ? value : null;
}

function parseCommentStatus(value: unknown): CommentStatus | null {
  return value === 'open' || value === 'resolved' ? value : null;
}

function parseFacts(value: unknown): KvEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const key = String((candidate as { key?: unknown }).key ?? '').trim();
    const factValue = String((candidate as { value?: unknown }).value ?? '');
    return key ? [{ key, value: factValue }] : [];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    : [];
}

function requireExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  entityKind: ExpectedEntityKind,
  entityId: string,
): asserts expectation is PersistedAgentRuntimeWriteExpectation {
  if (
    !expectation ||
    expectation.projectId !== request.context.route.projectId ||
    expectation.sessionId !== request.sessionId ||
    expectation.writeTurnId !== request.turnId ||
    expectation.entityKind !== entityKind ||
    expectation.entityId !== entityId
  ) {
    throw new Error(`${request.name} lost its exact dependent-read expectation`);
  }
}

function assertExpectedRevision(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  currentRevision: string,
  readTool: string,
): void {
  if (!expectation || expectation.expectedRevision !== currentRevision) {
    throw new Error(`The target changed after ${readTool}; read it again before writing`);
  }
}

function parsePayload(
  value: unknown,
  toolName: DriftingStructuralWriteTool,
): StructuralWritePayload {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { kind?: unknown }).kind !== 'structural_write_command' ||
    (value as { toolName?: unknown }).toolName !== toolName
  ) {
    throw new Error(`${toolName} lost its prepared structural payload`);
  }
  return value as StructuralWritePayload;
}

function receiptId(
  payload: StructuralWritePayload,
  direction: 'forward' | 'inverse',
): string {
  return `agent-entity-write-receipt:${payload.effectId}:${direction}`;
}

function assertReceipt(
  receipt: PersistedAgentRuntimeEntityWriteReceipt | null,
  payload: StructuralWritePayload,
  direction: 'forward' | 'inverse',
): asserts receipt is PersistedAgentRuntimeEntityWriteReceipt {
  if (
    !receipt ||
    receipt.id !== receiptId(payload, direction) ||
    receipt.commandId !== payload.commandId ||
    receipt.effectId !== payload.effectId ||
    receipt.direction !== direction ||
    receipt.projectId !== payload.projectId ||
    receipt.toolName !== payload.toolName ||
    receipt.entityKind !== payload.entityKind ||
    receipt.entityId !== payload.entityId
  ) {
    throw new Error(`${payload.toolName} has no matching immutable ${direction} receipt`);
  }
}

function assertEffect(
  effect: PersistedAgentRuntimeWriteEffect,
  payload: StructuralWritePayload,
): void {
  if (
    effect.id !== payload.effectId ||
    effect.projectId !== payload.projectId ||
    effect.idempotencyKey !== payload.commandId.replace(/^agent-entity-write:/, '')
  ) {
    throw new Error('The structural write effect conflicts with its prepared payload');
  }
}

async function assertUnchanged(
  current: AgentRuntimeEntityWriteSnapshot | null,
  forward: PersistedAgentRuntimeEntityWriteReceipt,
  message: string,
): Promise<void> {
  if (
    !current ||
    !forward.postimageHash ||
    current.value.updatedAt !== forward.resultRevision ||
    (await hashEntityWriteValue(current)) !== forward.postimageHash
  ) {
    throw new Error(message);
  }
}

function isCreateTool(tool: DriftingStructuralWriteTool): boolean {
  return tool.startsWith('create_') || tool === 'add_relation';
}

function isDeleteTool(tool: DriftingStructuralWriteTool): boolean {
  return tool.startsWith('delete_') || tool === 'remove_relation';
}

function committedEffect(
  payload: StructuralWritePayload,
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
) {
  return {
    kind: 'entity_write',
    commandId: payload.commandId,
    entityKind: payload.entityKind,
    entityId: payload.entityId,
    revision: receipt.resultRevision,
    postimage: receipt.postimage,
    receiptId: receipt.id,
    handlerResult: handlerResult(payload, receipt.postimage),
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
  payload: StructuralWritePayload,
  snapshot: AgentRuntimeEntityWriteSnapshot | null,
): Record<string, unknown> {
  return {
    ok: true,
    entityType: payload.entityKind,
    entityId: payload.entityId,
    name: snapshot ? snapshotName(snapshot) : snapshotName(payload.preimage),
    deleted: snapshot === null && payload.preimage !== null,
  };
}

function assertHandlerResult(value: unknown, payload: StructuralWritePayload): void {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { ok?: unknown }).ok !== true ||
    (value as { entityId?: unknown }).entityId !== payload.entityId
  ) {
    throw new Error('The structural write handler result is invalid');
  }
}

function snapshotName(snapshot: AgentRuntimeEntityWriteSnapshot | null): string | null {
  if (!snapshot) return null;
  if (snapshot.kind === 'node') return snapshot.value.title;
  if (
    snapshot.kind === 'element' ||
    snapshot.kind === 'storyline' ||
    snapshot.kind === 'category' ||
    snapshot.kind === 'project'
  ) {
    return snapshot.value.name;
  }
  return snapshot.value.id;
}

function projectSnapshot(
  payload: StructuralWritePayload,
  snapshot: AgentRuntimeEntityWriteSnapshot | null,
): void {
  const data = useDataStore.getState();
  if (!snapshot) {
    if (payload.entityKind === 'node') data.removeBookNode(payload.entityId);
    else if (payload.entityKind === 'element') data.removeBookElement(payload.entityId);
    else if (payload.entityKind === 'storyline') data.removeStoryline(payload.entityId);
    else if (payload.entityKind === 'category') data.removeBookElementCategory(payload.entityId);
    else if (payload.entityKind === 'comment') data.removeComment(payload.entityId);
    else if (payload.entityKind === 'relation') data.removeEntityRelation(payload.entityId);
    return;
  }
  if (snapshot.kind === 'node') {
    const exists = data.bookNodes.some((item) => item.id === snapshot.value.id);
    if (exists) data.updateBookNode(snapshot.value.id, snapshot.value);
    else data.addBookNode(snapshot.value);
  } else if (snapshot.kind === 'element') {
    const exists = data.bookElements.some((item) => item.id === snapshot.value.id);
    if (exists) data.updateBookElement(snapshot.value.id, snapshot.value);
    else data.addBookElement(snapshot.value);
  } else if (snapshot.kind === 'storyline') {
    const exists = data.storylines.some((item) => item.id === snapshot.value.id);
    if (exists) data.updateStoryline(snapshot.value.id, snapshot.value);
    else data.addStoryline(snapshot.value);
  } else if (snapshot.kind === 'category') {
    const exists = data.bookElementCategories.some((item) => item.id === snapshot.value.id);
    if (exists) data.updateBookElementCategory(snapshot.value.id, snapshot.value);
    else data.addBookElementCategory(snapshot.value);
  } else if (snapshot.kind === 'comment') {
    const exists = data.comments.some((item) => item.id === snapshot.value.id);
    if (exists) data.updateComment(snapshot.value.id, snapshot.value);
    else data.addComment(snapshot.value);
  } else if (snapshot.kind === 'relation') {
    data.removeEntityRelation(snapshot.value.id);
    data.addEntityRelation(snapshot.value as EntityRelationLink);
  }
}

function transactionRunner(
  tx: DbExecutor,
  persistSyncMutation: typeof persistSyncMutationInTransaction,
): { runner: EntityAtomicTransactionRunner; persisted: () => boolean } {
  let persisted = false;
  return {
    runner: async (projectId, work) =>
      work(
        tx,
        async (entityType, mutationType, entityId, mutationProjectId, payload, parentId) => {
          if (mutationProjectId !== projectId) {
            throw new Error(`Structural write for ${projectId} cannot sync ${mutationProjectId}`);
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

function notifyCommittedSafely(
  persisted: boolean,
  notify: typeof notifySyncMutationCommitted,
): void {
  if (!persisted) return;
  try {
    notify();
  } catch {
    // The outbox row is authoritative; notification is only a wake-up hint.
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim();
}

function sameName(left: string, right: string): boolean {
  return left.trim().normalize('NFKC').toLocaleLowerCase() === right.trim().normalize('NFKC').toLocaleLowerCase();
}
