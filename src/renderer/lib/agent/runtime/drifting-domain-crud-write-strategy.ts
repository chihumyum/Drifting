import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { AgentMemory, AgentMemoryKind } from '../../../domain/agent-memory';
import {
  snapshotAgentRuntimeEntity,
  type AgentRuntimeEntityWriteSnapshot,
  type AgentRuntimeStorylineMembershipLinkSnapshot,
  type AgentRuntimeStorylineMembershipSnapshotValue,
  type PersistedAgentRuntimeEntityWriteReceipt,
} from '../../../domain/agent-runtime-entity-write-receipt';
import type { PersistedAgentRuntimeWriteExpectation } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import type { StructuralEntityKind } from '../../../domain/entity-kinds';
import type { DbExecutor, DbTransaction } from '../../../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  NodeStorylineLinkTable,
  StorylineTable,
} from '../../../schema/drizzle';
import {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
} from '../../../services/entity-sync.service';
import { createAgentMemoryRepository } from '../../../sqlite-repo/agent-memory-repo';
import {
  createAgentRuntimeEntityWriteReceiptRepository,
  type AgentRuntimeEntityWriteReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-entity-write-receipt-repo';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { useDataStore } from '../../../store/data-store';
import {
  agentMemorySetRevision,
  loadStorylineMembershipSnapshot,
  storylineMembershipRevision,
} from './domain-crud-revision';
import {
  deterministicAgentEntityId,
  hashEntityWriteValue,
} from './entity-write-revision';
import { throwIfAgentAborted } from './errors';
import type { DriftingWriteStrategy } from './drifting-write-strategies';
import type { AgentToolExecutionRequest } from './types';

export const DRIFTING_DOMAIN_CRUD_WRITE_TOOLS = [
  'set_storyline_membership',
  'remember',
  'update_memory',
  'forget',
] as const;

export type DriftingDomainCrudWriteTool =
  (typeof DRIFTING_DOMAIN_CRUD_WRITE_TOOLS)[number];

type DomainCrudMutation =
  | {
      kind: 'set_storyline_membership';
      value: AgentRuntimeStorylineMembershipSnapshotValue;
    }
  | { kind: 'remember'; value: AgentMemory }
  | { kind: 'update_memory'; value: AgentMemory }
  | { kind: 'forget'; value: AgentMemory };

interface DomainCrudPayload {
  kind: 'domain_crud_command';
  commandId: string;
  effectId: string;
  toolName: DriftingDomainCrudWriteTool;
  projectId: string;
  entityKind: 'storyline_membership' | 'memory';
  entityId: string;
  expectedEntityKind: 'storyline_membership' | 'memory_set' | 'memory';
  expectedEntityId: string;
  expectedRevision: string;
  preimage: AgentRuntimeEntityWriteSnapshot | null;
  mutation: DomainCrudMutation;
}

interface DomainCrudCommit {
  receipt: PersistedAgentRuntimeEntityWriteReceipt;
  syncPersisted: boolean;
}

export interface DriftingDomainCrudWriteStrategyOptions {
  freshness: AgentRuntimeFreshnessRepository;
  db: DbExecutor;
  receipts?: AgentRuntimeEntityWriteReceiptRepository;
  now?: () => string;
  persistSyncMutation?: typeof persistSyncMutationInTransaction;
  notifySyncCommitted?: typeof notifySyncMutationCommitted;
}

export function createDriftingDomainCrudWriteStrategy(
  toolName: DriftingDomainCrudWriteTool,
  options: DriftingDomainCrudWriteStrategyOptions,
): DriftingWriteStrategy {
  const receipts =
    options.receipts ?? createAgentRuntimeEntityWriteReceiptRepository(options.db);
  const now = options.now ?? (() => new Date().toISOString());
  const persistSyncMutation =
    options.persistSyncMutation ?? persistSyncMutationInTransaction;
  const notifySyncCommitted =
    options.notifySyncCommitted ?? notifySyncMutationCommitted;

  return {
    async prepare(request, _context, expectation) {
      throwIfAgentAborted(request.signal);
      const payload = await prepareDomainCrudPayload(
        toolName,
        request,
        expectation,
        options.db,
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
          applyForward(
            tx,
            payload,
            request.sessionId,
            now,
            persistSyncMutation,
          ),
      });
      notifyCommittedSafely(committed.syncPersisted, notifySyncCommitted);
      projectMembershipSnapshot(committed.receipt.postimage);
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
      projectMembershipSnapshot(receipt.postimage);
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
        projectMembershipSnapshot(existing.postimage);
        return inverseEffect(existing, true);
      }
      const committed = await options.db.transaction(
        (tx) =>
          applyInverse(
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
      projectMembershipSnapshot(committed.receipt.postimage);
      return inverseEffect(committed.receipt, false);
    },
  };
}

async function prepareDomainCrudPayload(
  toolName: DriftingDomainCrudWriteTool,
  request: AgentToolExecutionRequest,
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  db: DbExecutor,
  now: () => string,
): Promise<DomainCrudPayload> {
  const projectId = request.context.route.projectId;
  if (!projectId) throw new Error(`${toolName} requires a project route`);
  const effectId = `agent-write:${request.idempotencyKey}`;
  const base = {
    kind: 'domain_crud_command' as const,
    commandId: `agent-entity-write:${request.idempotencyKey}`,
    effectId,
    toolName,
    projectId,
  };

  if (toolName === 'set_storyline_membership') {
    const storyline = await resolveStoryline(db, projectId, request.arguments.storyline);
    requireExpectation(expectation, request, 'storyline_membership', storyline.id);
    const before = await loadStorylineMembershipSnapshot(db, projectId, storyline.id);
    assertExpectedRevision(expectation, before.updatedAt, 'get_storyline');
    const members = await resolveMembershipMembers(
      db,
      projectId,
      request.arguments.chapters,
    );
    const nextLinks = await planStorylineMembership(
      db,
      projectId,
      storyline.id,
      before.links,
      members,
    );
    const after: AgentRuntimeStorylineMembershipSnapshotValue = {
      id: storyline.id,
      projectId,
      links: nextLinks,
      updatedAt: await storylineMembershipRevision(nextLinks),
    };
    if (after.updatedAt === before.updatedAt) {
      throw new Error('The requested storyline membership is already current');
    }
    return {
      ...base,
      entityKind: 'storyline_membership',
      entityId: storyline.id,
      expectedEntityKind: 'storyline_membership',
      expectedEntityId: storyline.id,
      expectedRevision: expectation!.expectedRevision,
      preimage: snapshotAgentRuntimeEntity(before, 'storyline_membership'),
      mutation: { kind: 'set_storyline_membership', value: after },
    };
  }

  const memoryRepo = createAgentMemoryRepository(projectId, db);
  if (toolName === 'remember') {
    requireExpectation(expectation, request, 'memory_set', projectId);
    const all = await memoryRepo.findAll();
    assertExpectedRevision(
      expectation,
      await agentMemorySetRevision(all),
      'list_memory',
    );
    const timestamp = now();
    const id = await deterministicAgentEntityId(request.idempotencyKey, 'memory');
    const value = await memoryFromArguments({
      id,
      projectId,
      arguments_: request.arguments,
      db,
      timestamp,
      originRef: [
        'agent',
        request.sessionId,
        request.turnId,
        request.callId,
      ].join(':'),
    });
    return {
      ...base,
      entityKind: 'memory',
      entityId: id,
      expectedEntityKind: 'memory_set',
      expectedEntityId: projectId,
      expectedRevision: expectation!.expectedRevision,
      preimage: null,
      mutation: { kind: 'remember', value },
    };
  }

  const memoryId = requiredString(
    request.arguments.memoryId,
    `${toolName} requires memoryId`,
  );
  const before = await memoryRepo.findById(memoryId);
  if (!before || before.deletedAt) {
    throw new Error(`Memory "${memoryId}" is not live in this project`);
  }
  requireExpectation(expectation, request, 'memory', memoryId);
  assertExpectedRevision(expectation, before.updatedAt, 'list_memory');
  let after: AgentMemory;
  if (toolName === 'update_memory') {
    if (before.source !== 'agent' || before.status !== 'pending') {
      throw new Error(
        'Only a pending Agent proposal can be edited in place. Create a new memory with supersedesId to evolve approved guidance.',
      );
    }
    after = await memoryFromArguments({
      id: before.id,
      projectId,
      arguments_: request.arguments,
      db,
      timestamp: now(),
      originRef: before.originRef,
      createdAt: before.createdAt,
    });
  } else {
    const timestamp = now();
    after = { ...before, deletedAt: timestamp, updatedAt: timestamp };
  }
  if ((await hashEntityWriteValue(before)) === (await hashEntityWriteValue(after))) {
    throw new Error(`${toolName} would not change the memory`);
  }
  return {
    ...base,
    entityKind: 'memory',
    entityId: memoryId,
    expectedEntityKind: 'memory',
    expectedEntityId: memoryId,
    expectedRevision: expectation!.expectedRevision,
    preimage: snapshotAgentRuntimeEntity(before, 'memory'),
    mutation: { kind: toolName, value: after },
  };
}

async function readCurrentVersion(
  tx: DbExecutor,
  expectation: PersistedAgentRuntimeWriteExpectation,
  payload: DomainCrudPayload,
): Promise<{ revision: string } | null> {
  if (
    expectation.projectId !== payload.projectId ||
    expectation.entityKind !== payload.expectedEntityKind ||
    expectation.entityId !== payload.expectedEntityId
  ) {
    return null;
  }
  if (payload.expectedEntityKind === 'storyline_membership') {
    const current = await loadStorylineMembershipSnapshot(
      tx,
      payload.projectId,
      payload.entityId,
    );
    return { revision: current.updatedAt };
  }
  const repo = createAgentMemoryRepository(payload.projectId, tx);
  if (payload.expectedEntityKind === 'memory_set') {
    return { revision: await agentMemorySetRevision(await repo.findAll()) };
  }
  const current = await repo.findById(payload.entityId);
  return current ? { revision: current.updatedAt } : null;
}

async function applyForward(
  tx: DbExecutor,
  payload: DomainCrudPayload,
  sessionId: string,
  now: () => string,
  persistSync: typeof persistSyncMutationInTransaction,
): Promise<DomainCrudCommit> {
  let postimage: AgentRuntimeEntityWriteSnapshot;
  let syncPersisted = false;
  if (payload.mutation.kind === 'set_storyline_membership') {
    const current = await loadStorylineMembershipSnapshot(
      tx,
      payload.projectId,
      payload.entityId,
    );
    syncPersisted = await replaceMembershipGraph(
      tx,
      payload.projectId,
      current.links,
      payload.mutation.value.links,
      persistSync,
    );
    postimage = snapshotAgentRuntimeEntity(
      payload.mutation.value,
      'storyline_membership',
    );
  } else {
    const repo = createAgentMemoryRepository(payload.projectId, tx);
    let value: AgentMemory | null;
    if (payload.mutation.kind === 'remember') {
      value = await repo.create(payload.mutation.value);
      syncPersisted = await persistMemorySync(
        tx,
        'create',
        value,
        persistSync,
      );
    } else {
      value = await repo.update(payload.entityId, payload.mutation.value);
      if (!value) throw new Error('The memory disappeared during mutation');
      syncPersisted = await persistMemorySync(
        tx,
        'update',
        value,
        persistSync,
      );
    }
    postimage = snapshotAgentRuntimeEntity(value, 'memory');
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
    resultRevision: postimage.value.updatedAt,
    preimage: payload.preimage,
    preimageHash: payload.preimage
      ? await hashEntityWriteValue(payload.preimage)
      : null,
    postimage,
    postimageHash: await hashEntityWriteValue(postimage),
    createdAt: now(),
  });
  return { receipt, syncPersisted };
}

async function applyInverse(
  tx: DbExecutor,
  payload: DomainCrudPayload,
  effect: PersistedAgentRuntimeWriteEffect,
  forward: PersistedAgentRuntimeEntityWriteReceipt,
  now: () => string,
  persistSync: typeof persistSyncMutationInTransaction,
): Promise<DomainCrudCommit> {
  const receiptRepo = createAgentRuntimeEntityWriteReceiptRepository(tx);
  const existing = await receiptRepo.get(payload.commandId, 'inverse');
  if (existing) return { receipt: existing, syncPersisted: false };
  let postimage: AgentRuntimeEntityWriteSnapshot | null = null;
  let syncPersisted = false;

  if (payload.entityKind === 'storyline_membership') {
    const current = snapshotAgentRuntimeEntity(
      await loadStorylineMembershipSnapshot(
        tx,
        payload.projectId,
        payload.entityId,
      ),
      'storyline_membership',
    );
    if (current.kind !== 'storyline_membership') {
      throw new Error('The storyline membership inverse loaded an invalid snapshot');
    }
    await assertUnchanged(current, forward);
    if (!payload.preimage || payload.preimage.kind !== 'storyline_membership') {
      throw new Error('The storyline membership inverse lost its preimage');
    }
    syncPersisted = await replaceMembershipGraph(
      tx,
      payload.projectId,
      current.value.links,
      payload.preimage.value.links,
      persistSync,
    );
    postimage = payload.preimage;
  } else {
    const repo = createAgentMemoryRepository(payload.projectId, tx);
    const currentMemory = await repo.findById(payload.entityId);
    const current = currentMemory
      ? snapshotAgentRuntimeEntity(currentMemory, 'memory')
      : null;
    await assertUnchanged(current, forward);
    if (payload.toolName === 'remember') {
      await repo.delete(payload.entityId);
      syncPersisted = await persistSync(tx as DbTransaction, {
        entityType: 'agentMemory',
        mutationType: 'delete',
        entityId: payload.entityId,
        projectId: payload.projectId,
        timestamp: Date.now(),
      });
    } else {
      if (!payload.preimage || payload.preimage.kind !== 'memory') {
        throw new Error('The memory inverse lost its preimage');
      }
      const restored = await repo.update(payload.entityId, {
        ...payload.preimage.value,
        updatedAt: now(),
      });
      if (!restored) throw new Error('The memory inverse did not persist');
      postimage = snapshotAgentRuntimeEntity(restored, 'memory');
      syncPersisted = await persistMemorySync(
        tx,
        'update',
        restored,
        persistSync,
      );
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
    postimageHash: postimage ? await hashEntityWriteValue(postimage) : null,
    createdAt: now(),
  });
  return { receipt, syncPersisted };
}

interface MembershipMember {
  nodeId: string;
  isPrimary: boolean;
}

async function resolveMembershipMembers(
  db: DbExecutor,
  projectId: string,
  raw: unknown,
): Promise<MembershipMember[]> {
  if (!Array.isArray(raw)) {
    throw new Error('chapters.json must be an array of chapter objects');
  }
  const chapters = await db
    .select({ id: BookNodeTable.id, title: BookNodeTable.title })
    .from(BookNodeTable)
    .where(
      and(
        eq(BookNodeTable.projectId, projectId),
        eq(BookNodeTable.kind, 'chapter'),
        isNull(BookNodeTable.deletedAt),
      ),
    );
  const resolved: MembershipMember[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of raw.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`chapters.json[${index}] must be an object`);
    }
    const row = candidate as Record<string, unknown>;
    const title = requiredString(
      row.chapter ?? row.title,
      `chapters.json[${index}] requires chapter`,
    );
    const direct = chapters.find((chapter) => chapter.id === title);
    const matches = direct
      ? [direct]
      : chapters.filter((chapter) => sameName(chapter.title, title));
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No chapter named "${title}" exists in this project`
          : `Chapter reference "${title}" is ambiguous`,
      );
    }
    const nodeId = matches[0]!.id;
    if (seen.has(nodeId)) {
      throw new Error(`chapters.json contains chapter "${title}" more than once`);
    }
    seen.add(nodeId);
    resolved.push({
      nodeId,
      isPrimary: row.isPrimary === true || row.primary === true,
    });
  }
  return resolved;
}

async function planStorylineMembership(
  db: DbExecutor,
  projectId: string,
  storylineId: string,
  current: readonly AgentRuntimeStorylineMembershipLinkSnapshot[],
  desired: readonly MembershipMember[],
): Promise<AgentRuntimeStorylineMembershipLinkSnapshot[]> {
  const desiredByNode = new Map(desired.map((member) => [member.nodeId, member]));
  const next = current
    .filter(
      (link) =>
        link.storylineId !== storylineId || desiredByNode.has(link.nodeId),
    )
    .map((link) => ({ ...link }));

  for (const member of desired) {
    const existing = next.find(
      (link) =>
        link.nodeId === member.nodeId && link.storylineId === storylineId,
    );
    if (existing) existing.isPrimary = member.isPrimary;
    else {
      next.push({
        nodeId: member.nodeId,
        storylineId,
        isPrimary: member.isPrimary,
      });
    }
    if (member.isPrimary) {
      for (const link of next) {
        if (link.nodeId === member.nodeId && link.storylineId !== storylineId) {
          link.isPrimary = false;
        }
      }
    }
  }

  const storylineRows = await db
    .select({ id: StorylineTable.id, orderKey: StorylineTable.orderKey })
    .from(StorylineTable)
    .where(
      and(
        eq(StorylineTable.projectId, projectId),
        isNull(StorylineTable.deletedAt),
      ),
    )
    .orderBy(asc(StorylineTable.orderKey), asc(StorylineTable.id));
  const order = new Map(
    storylineRows.map((storyline, index) => [storyline.id, index]),
  );
  const nodeIds = [...new Set(next.map((link) => link.nodeId))];
  for (const nodeId of nodeIds) {
    const links = next.filter((link) => link.nodeId === nodeId);
    const primary = links.filter((link) => link.isPrimary);
    if (primary.length > 1) {
      throw new Error('A chapter cannot have more than one primary storyline');
    }
    if (primary.length === 0 && links.length > 0) {
      links.sort(
        (left, right) =>
          (order.get(left.storylineId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.storylineId) ?? Number.MAX_SAFE_INTEGER) ||
          left.storylineId.localeCompare(right.storylineId, 'en'),
      )[0]!.isPrimary = true;
    }
  }
  return next.sort(
    (left, right) =>
      left.nodeId.localeCompare(right.nodeId, 'en') ||
      left.storylineId.localeCompare(right.storylineId, 'en'),
  );
}

async function replaceMembershipGraph(
  tx: DbExecutor,
  projectId: string,
  before: readonly AgentRuntimeStorylineMembershipLinkSnapshot[],
  after: readonly AgentRuntimeStorylineMembershipLinkSnapshot[],
  persistSync: typeof persistSyncMutationInTransaction,
): Promise<boolean> {
  const beforeByNode = groupMemberships(before);
  const afterByNode = groupMemberships(after);
  const changedNodes = [...new Set([...beforeByNode.keys(), ...afterByNode.keys()])]
    .filter(
      (nodeId) =>
        JSON.stringify(beforeByNode.get(nodeId) ?? []) !==
        JSON.stringify(afterByNode.get(nodeId) ?? []),
    )
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (changedNodes.length === 0) return false;
  await tx
    .delete(NodeStorylineLinkTable)
    .where(inArray(NodeStorylineLinkTable.nodeId, changedNodes));
  const inserts = changedNodes.flatMap((nodeId) => afterByNode.get(nodeId) ?? []);
  if (inserts.length > 0) {
    await tx.insert(NodeStorylineLinkTable).values(inserts);
  }
  let persisted = false;
  for (const nodeId of changedNodes) {
    const links = afterByNode.get(nodeId) ?? [];
    const primary = links.find((link) => link.isPrimary)?.storylineId ?? null;
    persisted =
      (await persistSync(tx as DbTransaction, {
        entityType: 'nodeStorylineLink',
        mutationType: 'update',
        entityId: nodeId,
        projectId,
        payload: {
          storylineIds: links.map((link) => link.storylineId),
          primaryStorylineId: primary,
        },
        timestamp: Date.now(),
      })) || persisted;
  }
  return persisted;
}

function groupMemberships(
  links: readonly AgentRuntimeStorylineMembershipLinkSnapshot[],
): Map<string, AgentRuntimeStorylineMembershipLinkSnapshot[]> {
  const grouped = new Map<string, AgentRuntimeStorylineMembershipLinkSnapshot[]>();
  for (const link of links) {
    const current = grouped.get(link.nodeId) ?? [];
    current.push({ ...link });
    grouped.set(link.nodeId, current);
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.storylineId.localeCompare(right.storylineId, 'en'));
  }
  return grouped;
}

async function memoryFromArguments(input: {
  id: string;
  projectId: string;
  arguments_: Record<string, unknown>;
  db: DbExecutor;
  timestamp: string;
  originRef: string | null;
  createdAt?: string;
}): Promise<AgentMemory> {
  const kind = parseMemoryKind(input.arguments_.kind);
  const body = requiredString(input.arguments_.body, 'Memory body is required');
  const target = await resolveMemoryTarget(
    input.db,
    input.projectId,
    input.arguments_.targetKind,
    input.arguments_.target,
  );
  const supersedesId = optionalString(
    input.arguments_.supersedesId ?? input.arguments_.supersedes,
  );
  if (supersedesId) {
    const superseded = await createAgentMemoryRepository(
      input.projectId,
      input.db,
    ).findById(supersedesId);
    if (!superseded || superseded.deletedAt || superseded.status === 'dismissed') {
      throw new Error('The superseded memory is not live in this project');
    }
    if (supersedesId === input.id) {
      throw new Error('A memory cannot supersede itself');
    }
  }
  return {
    id: input.id,
    projectId: input.projectId,
    kind,
    body,
    targetKind: target.kind,
    targetId: target.id,
    targetBlockId: optionalString(input.arguments_.targetBlockId),
    source: 'agent',
    originRef: input.originRef,
    status: 'pending',
    supersedesId,
    createdAt: input.createdAt ?? input.timestamp,
    updatedAt: input.timestamp,
    deletedAt: null,
  };
}

async function resolveMemoryTarget(
  db: DbExecutor,
  projectId: string,
  rawKind: unknown,
  rawTarget: unknown,
): Promise<{ kind: StructuralEntityKind | null; id: string | null }> {
  const kind = optionalString(rawKind);
  const target = optionalString(rawTarget);
  if (!kind && !target) return { kind: null, id: null };
  if (!kind || !target) {
    throw new Error('Memory targetKind and target must be provided together');
  }
  const normalized =
    kind === 'chapter' || kind === 'drift' ? 'node' : kind;
  if (
    normalized !== 'node' &&
    normalized !== 'element' &&
    normalized !== 'storyline' &&
    normalized !== 'category'
  ) {
    throw new Error('Memory targetKind must be node, element, storyline, or category');
  }
  const values =
    normalized === 'node'
      ? await db
          .select({ id: BookNodeTable.id, name: BookNodeTable.title })
          .from(BookNodeTable)
          .where(
            and(
              eq(BookNodeTable.projectId, projectId),
              isNull(BookNodeTable.deletedAt),
            ),
          )
      : normalized === 'element'
        ? await db
            .select({ id: BookElementTable.id, name: BookElementTable.name })
            .from(BookElementTable)
            .where(
              and(
                eq(BookElementTable.projectId, projectId),
                isNull(BookElementTable.deletedAt),
              ),
            )
        : normalized === 'storyline'
          ? await db
              .select({ id: StorylineTable.id, name: StorylineTable.name })
              .from(StorylineTable)
              .where(
                and(
                  eq(StorylineTable.projectId, projectId),
                  isNull(StorylineTable.deletedAt),
                ),
              )
          : await db
              .select({ id: ElementCategoryTable.id, name: ElementCategoryTable.name })
              .from(ElementCategoryTable)
              .where(
                and(
                  eq(ElementCategoryTable.projectId, projectId),
                  isNull(ElementCategoryTable.deletedAt),
                ),
              );
  const direct = values.find((value) => value.id === target);
  const matches = direct
    ? [direct]
    : values.filter((value) => sameName(value.name, target));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No ${normalized} named "${target}" exists in this project`
        : `${normalized} reference "${target}" is ambiguous`,
    );
  }
  return { kind: normalized, id: matches[0]!.id };
}

async function resolveStoryline(
  db: DbExecutor,
  projectId: string,
  raw: unknown,
): Promise<{ id: string; name: string }> {
  const reference = requiredString(raw, 'A storyline reference is required');
  const rows = await db
    .select({ id: StorylineTable.id, name: StorylineTable.name })
    .from(StorylineTable)
    .where(
      and(
        eq(StorylineTable.projectId, projectId),
        isNull(StorylineTable.deletedAt),
      ),
    );
  const direct = rows.find((row) => row.id === reference);
  const matches = direct
    ? [direct]
    : rows.filter((row) => sameName(row.name, reference));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No storyline named "${reference}" exists in this project`
        : `Storyline reference "${reference}" is ambiguous`,
    );
  }
  return matches[0]!;
}

async function persistMemorySync(
  tx: DbExecutor,
  mutationType: 'create' | 'update',
  memory: AgentMemory,
  persistSync: typeof persistSyncMutationInTransaction,
): Promise<boolean> {
  return persistSync(tx as DbTransaction, {
    entityType: 'agentMemory',
    mutationType,
    entityId: memory.id,
    projectId: memory.projectId,
    payload: memoryPayload(memory),
    timestamp: Date.now(),
  });
}

function memoryPayload(memory: AgentMemory): Record<string, unknown> {
  return {
    id: memory.id,
    kind: memory.kind,
    body: memory.body,
    targetKind: memory.targetKind,
    targetId: memory.targetId,
    targetBlockId: memory.targetBlockId,
    source: memory.source,
    originRef: memory.originRef,
    status: memory.status,
    supersedesId: memory.supersedesId,
    deletedAt: memory.deletedAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function projectMembershipSnapshot(snapshot: AgentRuntimeEntityWriteSnapshot | null): void {
  if (!snapshot || snapshot.kind !== 'storyline_membership') return;
  const storylineNodeMapping: Record<string, string[]> = {};
  const primaryStorylineByNode: Record<string, string | null> = {};
  for (const storyline of useDataStore
    .getState()
    .storylines.filter((value) => value.projectId === snapshot.value.projectId)) {
    storylineNodeMapping[storyline.id] = [];
  }
  for (const link of snapshot.value.links) {
    (storylineNodeMapping[link.storylineId] ??= []).push(link.nodeId);
    if (link.isPrimary) primaryStorylineByNode[link.nodeId] = link.storylineId;
  }
  const state = useDataStore.getState();
  state.setStorylineNodeMapping(storylineNodeMapping);
  state.setPrimaryStorylineByNode(primaryStorylineByNode);
}

function requireExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  entityKind: string,
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

async function assertUnchanged(
  current: AgentRuntimeEntityWriteSnapshot | null,
  forward: PersistedAgentRuntimeEntityWriteReceipt,
): Promise<void> {
  if (
    !current ||
    !forward.postimageHash ||
    current.value.updatedAt !== forward.resultRevision ||
    (await hashEntityWriteValue(current)) !== forward.postimageHash
  ) {
    throw new Error('The authored domain state changed; exact reject is unavailable');
  }
}

function parsePayload(
  value: unknown,
  toolName: DriftingDomainCrudWriteTool,
): DomainCrudPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { kind?: unknown }).kind !== 'domain_crud_command' ||
    (value as { toolName?: unknown }).toolName !== toolName
  ) {
    throw new Error(`${toolName} lost its prepared domain CRUD payload`);
  }
  return value as DomainCrudPayload;
}

function receiptId(
  payload: DomainCrudPayload,
  direction: 'forward' | 'inverse',
): string {
  return `agent-entity-write-receipt:${payload.effectId}:${direction}`;
}

function assertReceipt(
  receipt: PersistedAgentRuntimeEntityWriteReceipt | null,
  payload: DomainCrudPayload,
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
  payload: DomainCrudPayload,
): void {
  if (
    effect.id !== payload.effectId ||
    effect.projectId !== payload.projectId ||
    effect.idempotencyKey !== payload.commandId.replace(/^agent-entity-write:/, '')
  ) {
    throw new Error('The domain CRUD effect conflicts with its prepared payload');
  }
}

function handlerResult(
  payload: DomainCrudPayload,
  snapshot: AgentRuntimeEntityWriteSnapshot | null,
): Record<string, unknown> {
  return {
    ok: true,
    entityType: payload.entityKind,
    entityId: payload.entityId,
    deleted:
      snapshot?.kind === 'memory' ? Boolean(snapshot.value.deletedAt) : false,
  };
}

function assertHandlerResult(value: unknown, payload: DomainCrudPayload): void {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { ok?: unknown }).ok !== true ||
    (value as { entityId?: unknown }).entityId !== payload.entityId
  ) {
    throw new Error('The domain CRUD handler result is invalid');
  }
}

function committedEffect(
  payload: DomainCrudPayload,
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
) {
  return {
    kind: 'domain_crud_write',
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
    kind: 'domain_crud_write_revert',
    commandId: receipt.commandId,
    entityKind: receipt.entityKind,
    entityId: receipt.entityId,
    revision: receipt.resultRevision,
    postimage: receipt.postimage,
    receiptId: receipt.id,
    reconciled,
  };
}

function parseMemoryKind(value: unknown): AgentMemoryKind {
  if (value === 'preference' || value === 'veto' || value === 'directive') {
    return value;
  }
  throw new Error('Memory kind must be preference, veto, or directive');
}

function requiredString(value: unknown, message: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(message);
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameName(left: string, right: string): boolean {
  return (
    left.trim().normalize('NFKC').toLocaleLowerCase('en-US') ===
    right.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  );
}

function notifyCommittedSafely(
  persisted: boolean,
  notify: typeof notifySyncMutationCommitted,
): void {
  if (!persisted) return;
  try {
    notify();
  } catch {
    // The durable outbox is authoritative; this is only a wake-up hint.
  }
}
