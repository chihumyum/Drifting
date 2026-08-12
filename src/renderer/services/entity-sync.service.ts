/**
 * Entity Sync Service
 *
 * Local-first sync engine: usecase hooks write to SQLite first,
 * then this service pushes changes to the server in the background.
 *
 * The service also periodically pulls remote changes and merges
 * them into the local SQLite database.
 *
 * Strategy:
 * - Push: Each local write persists its mutation in the same SQLite
 *   transaction. A debounced flush sends committed mutations to the server.
 * - Pull: On project load and periodically, fetch all entities
 *   from the server and reconcile with local state (server wins on conflict).
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { apiClient } from '../lib/axios-config';
import { APP_CONFIG, isSyncEnabled } from '../lib/config';
import { getDb, type DbExecutor, type DbTransaction } from '../lib/db';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import {
  AgentMemoryTable,
  AgentWorkingMemoryTable,
  BlockSectionTable,
  BookActTable,
  DriftGroupTable,
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  ElementCategoryTable,
  ElementPatchTable,
  EntityRelationTable,
  EntityRelationTypeEndpointKindTable,
  EntityRelationTypeTable,
  InlineMentionTable,
  LocalSyncMutationTable,
  CommentTable,
  LibraryItemTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectTable,
  ProjectAssetTable,
  StorylineTable,
  TimelineMarkerTable,
} from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import type { BookNode, ChapterWritingStatus, DriftStatus } from '../domain/book-node';
import { decodeAliases } from '../domain/book-element';
import type { ProjectAsset } from '../domain/project-asset';
import { ALL_ENTITY_KINDS, STRUCTURAL_ENTITY_KINDS } from '../domain/entity-kinds';
import { decodeBlockHashes, decodeBlockIds } from '../domain/block-section';
import type { BlockSectionSource } from '../domain/block-section';
import {
  LEGACY_RELATION_SOURCE_KINDS,
  LEGACY_RELATION_TARGET_KINDS,
  legacyRelationType,
  legacyRelationTypeId,
  type EntityRelationType,
} from '../domain/entity-relation-type';
import { createElementPatchRepository } from '../sqlite-repo/element-patch-repo';
import { createBlockSectionRepository } from '../sqlite-repo/block-section-repo';
import { rebuildProjectInlineReferenceIndex } from './reference-index.service';
import {
  coalescePendingMutation,
  isCreatePayloadConflict,
  isTerminalPayloadValidationFailure,
} from './entity-sync-coalescing';
import {
  isRearmableTrashEntitlementConflict,
  isTrashEntitlementRejection,
  trashEntitlementBlockedMessage,
  trashEntitlementConflictMessage,
} from './entity-sync-entitlement';
import { flushPendingAtomicSyncTransactions } from './atomic-sync-transaction-tracker';
import { localMutationGeneration, runGuardedProjectHydration } from './local-mutation-generation';
import loglevel from 'loglevel';
import {
  overlayLibraryItemDeviceFields,
  stripLibraryItemDeviceFields,
} from './library-item-sync-boundary';
import { normalizeNodeCreateSyncPayload } from './node-create-sync-contract';

const log = loglevel.getLogger('EntitySyncService');
log.setLevel(loglevel.levels.WARN);

// ==================== Types ====================

export type EntityType =
  | 'project'
  | 'node'
  | 'nodeContent'
  | 'storyline'
  | 'nodeStorylineLink'
  | 'element'
  | 'elementCategory'
  | 'elementPatch'
  | 'blockSection'
  | 'libraryItem'
  | 'entityRelation'
  | 'entityRelationType'
  | 'comment'
  | 'commentAction'
  | 'agentMemory'
  | 'agentWorkingMemory'
  | 'bookAct'
  | 'driftGroup'
  | 'timelineMarker';

// 'softDelete' moves the entity to trash (deletedAt = now); restore clears
// it back to NULL; 'delete' is still hard-DELETE (used by the Free tier and
// by the trash-purge job).
export type MutationType = 'create' | 'update' | 'delete' | 'softDelete' | 'restore';

export interface SyncMutation {
  entityType: EntityType;
  mutationType: MutationType;
  entityId: string;
  projectId: string;
  /** The full entity payload for create/update; undefined for delete */
  payload?: Record<string, unknown>;
  /** Extra context: parentId for nested resources */
  parentId?: string;
  timestamp: number;
}

export type SyncStatus = 'idle' | 'pushing' | 'pulling' | 'error';

type SyncStatusListener = (status: SyncStatus, detail?: string) => void;

// ==================== Singleton State ====================

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let currentStatus: SyncStatus = 'idle';
const statusListeners: Set<SyncStatusListener> = new Set();
let flushInProgress = false;
let pendingCountCache = 0;
let onlineFlushRegistered = false;
let entitlementRearmPromise: Promise<number> | null = null;

const FLUSH_DELAY_MS = 800;
const PULL_INTERVAL_MS = 30_000;
const OUTBOX_BATCH_SIZE = 50;
const SQLITE_MAX_INSERT_PARAMS = 800;

type MutationRequest = {
  method: SyncOperationEvent['method'];
  endpoint: string;
  data?: Record<string, unknown>;
};

type LocalSyncMutationRow = typeof LocalSyncMutationTable.$inferSelect;

function relationTypeRequestPayload(
  payload: Record<string, unknown>,
  mutationType: 'create' | 'update',
): Record<string, unknown> {
  const shared = {
    name: payload.name,
    description: payload.description,
    orientation: payload.orientation,
    sourceRole: payload.sourceRole,
    targetRole: payload.targetRole,
    sourceKinds: payload.sourceKinds,
    targetKinds: payload.targetKinds,
    updatedAt: payload.updatedAt,
  };
  return mutationType === 'create'
    ? {
        id: payload.id,
        normalizedName: payload.normalizedName,
        createdAt: payload.createdAt,
        ...shared,
      }
    : shared;
}

export function entityRelationRequestPayload(
  payload: Record<string, unknown>,
  mutationType: 'create' | 'update',
): Record<string, unknown> {
  const shared = {
    fromKind: payload.fromKind,
    fromId: payload.fromId,
    toKind: payload.toKind,
    toId: payload.toId,
    kind: payload.kind,
    relationTypeId: payload.relationTypeId,
  };
  return mutationType === 'create' ? { id: payload.id, ...shared } : shared;
}

export interface ProjectGraphPayload {
  project: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  nodeContents: Record<string, unknown>[];
  storylines: Record<string, unknown>[];
  nodeStorylineLinks: Record<string, unknown>[];
  elements: Record<string, unknown>[];
  elementCategories: Record<string, unknown>[];
  projectAssets?: Record<string, unknown>[];
  entityRelations: Record<string, unknown>[];
  entityRelationTypes?: Record<string, unknown>[];
  entityRelationTypeEndpointKinds?: Record<string, unknown>[];
  inlineMentions: Record<string, unknown>[];
  entityPatches: Record<string, unknown>[];
  blockSections: Record<string, unknown>[];
  libraryItems: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  commentActions: Record<string, unknown>[];
  // Optional: absent from older-server graph responses (partial rollout). Hydrate
  // treats `?? []` and the unflushed-mutation guard keeps local memories safe.
  agentMemories?: Record<string, unknown>[];
  // Optional during partial rollout; singleton object rather than an array.
  agentWorkingMemory?: Record<string, unknown> | null;
  // Optional for the same partial-rollout reason as agentMemories.
  bookActs?: Record<string, unknown>[];
  driftGroups?: Record<string, unknown>[];
  timelineMarkers?: Record<string, unknown>[];
}

function shouldPersistOutbox(): boolean {
  return APP_CONFIG.ENABLE_SYNC && !APP_CONFIG.LOCAL_ONLY_MODE;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createRequestId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(error: unknown): string {
  const responseData = (error as { response?: { data?: unknown } } | null | undefined)?.response
    ?.data;
  if (typeof responseData === 'string' && responseData.trim()) {
    return responseData.trim();
  }
  if (
    responseData &&
    typeof responseData === 'object' &&
    'message' in responseData &&
    typeof responseData.message === 'string' &&
    responseData.message.trim()
  ) {
    return responseData.message.trim();
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function getPayloadName(payload?: Record<string, unknown>): string | undefined {
  if (!payload) return undefined;
  const candidate = payload.name ?? payload.title ?? payload.stageName;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function emitSyncOperation(event: Omit<SyncOperationEvent, 'at'>): void {
  events.emit('sync:operation', { ...event, at: Date.now() });
}

function serializePayload(payload?: Record<string, unknown>): string | null {
  return payload === undefined ? null : JSON.stringify(payload);
}

function deserializePayload(payloadJson: string | null): Record<string, unknown> | undefined {
  if (!payloadJson) return undefined;
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mutationFromRow(row: LocalSyncMutationRow): SyncMutation {
  return {
    entityType: row.entityType as EntityType,
    mutationType: row.mutationType as MutationType,
    entityId: row.entityId,
    projectId: row.projectId,
    payload: deserializePayload(row.payloadJson),
    parentId: row.parentId ?? undefined,
    timestamp: row.mutationTs,
  };
}

async function refreshPendingCount(): Promise<void> {
  const rows = await getDb().select({ id: LocalSyncMutationTable.id }).from(LocalSyncMutationTable);
  pendingCountCache = rows.length;
}

async function countRetryablePendingMutations(): Promise<number> {
  const rows = await getDb()
    .select({ id: LocalSyncMutationTable.id })
    .from(LocalSyncMutationTable)
    .where(eq(LocalSyncMutationTable.status, 'pending'));
  return rows.length;
}

function registerOnlineFlush(): void {
  if (onlineFlushRegistered || typeof window === 'undefined') return;
  onlineFlushRegistered = true;
  window.addEventListener('online', () => {
    scheduleFlush();
  });
}

const CREATE_DELETE_CANCELLATION_SAFE_TYPES: ReadonlySet<EntityType> = new Set([
  'blockSection',
  'nodeStorylineLink',
  'entityRelation',
  'commentAction',
  'agentMemory',
  'agentWorkingMemory',
  'bookAct',
  'timelineMarker',
]);

// ==================== Status ====================

function setStatus(s: SyncStatus, detail?: string) {
  currentStatus = s;
  for (const listener of statusListeners) {
    try {
      listener(s, detail);
    } catch {
      /* ignore */
    }
  }
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function onSyncStatusChange(listener: SyncStatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

// ==================== Push ====================

/**
 * Persist a mutation using the caller's SQLite executor.
 *
 * Passing the transaction used for the domain write is the only crash-safe
 * way to guarantee that the local entity and its outbox entry become durable
 * together. This deliberately does not schedule a network flush: callers must
 * invoke `notifySyncMutationCommitted` only after their outer transaction has
 * committed successfully.
 *
 * Returns false when entity sync is disabled and no outbox row was written.
 */
export async function persistSyncMutationInTransaction(
  executor: DbTransaction,
  mutation: SyncMutation,
): Promise<boolean> {
  if (!shouldPersistOutbox()) return false;

  await writeSyncMutation(executor, mutation);
  return true;
}

/** Notify the sync runtime after a caller-owned entity/outbox transaction commits. */
export function notifySyncMutationCommitted(): void {
  if (!shouldPersistOutbox()) return;
  registerOnlineFlush();
  scheduleFlush();
  void refreshPendingCount().catch((error) => {
    log.warn('[sync] failed to refresh pending count after atomic commit:', error);
  });
}

/**
 * Wait until every started domain-write + outbox transaction has settled.
 * Pull and lifecycle paths need this barrier so they cannot observe an entity
 * write before its transaction-bound outbox row becomes visible.
 */
export function flushPendingEntityPersistence(): Promise<void> {
  return flushPendingAtomicSyncTransactions();
}

function scheduleFlush() {
  if (flushTimer || !isSyncEnabled()) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPushQueue();
  }, FLUSH_DELAY_MS);
}

async function writeSyncMutation(executor: DbExecutor, mutation: SyncMutation): Promise<void> {
  const now = new Date().toISOString();
  const candidates = await executor
    .select()
    .from(LocalSyncMutationTable)
    .where(
      and(
        inArray(LocalSyncMutationTable.status, ['pending', 'conflict']),
        eq(LocalSyncMutationTable.entityType, mutation.entityType),
        eq(LocalSyncMutationTable.entityId, mutation.entityId),
        eq(LocalSyncMutationTable.projectId, mutation.projectId),
        mutation.parentId === undefined
          ? isNull(LocalSyncMutationTable.parentId)
          : eq(LocalSyncMutationTable.parentId, mutation.parentId),
      ),
    )
    .orderBy(desc(LocalSyncMutationTable.id));

  // A same-id CREATE 409 means the remote row belongs to a different payload.
  // Keep that conflict explicit: applying later local PATCHes could overwrite
  // the remote entity that exposed the collision.
  if (candidates.some((candidate) => candidate.status === 'conflict')) {
    throw new Error(
      `Sync conflict for ${mutation.entityType}/${mutation.entityId}; resolve the existing create conflict before editing this entity`,
    );
  }

  // Only the newest adjacent operation may be rewritten. Folding into an
  // older row across a delete/restore boundary changes observable ordering.
  // Retried rows are also immutable: their request may already have committed
  // remotely even though the client never received the response.
  const existing = candidates[0];
  const decision = coalescePendingMutation(
    existing
      ? {
          mutationType: existing.mutationType as MutationType,
          payload: deserializePayload(existing.payloadJson),
        }
      : undefined,
    { mutationType: mutation.mutationType, payload: mutation.payload },
    {
      cancelCreateDelete: CREATE_DELETE_CANCELLATION_SAFE_TYPES.has(mutation.entityType),
      existingMayHaveReachedServer: Boolean(existing && existing.retryCount > 0),
    },
  );

  if (existing && decision.kind === 'cancel') {
    await executor.delete(LocalSyncMutationTable).where(eq(LocalSyncMutationTable.id, existing.id));
    return;
  }

  if (existing && decision.kind === 'replace') {
    await executor
      .update(LocalSyncMutationTable)
      .set({
        mutationType: decision.mutationType,
        projectId: mutation.projectId,
        parentId: mutation.parentId ?? null,
        payloadJson: serializePayload(decision.payload),
        mutationTs: mutation.timestamp,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(LocalSyncMutationTable.id, existing.id));
    return;
  }

  await executor.insert(LocalSyncMutationTable).values({
    entityType: mutation.entityType,
    mutationType: mutation.mutationType,
    entityId: mutation.entityId,
    projectId: mutation.projectId,
    parentId: mutation.parentId ?? null,
    payloadJson: serializePayload(mutation.payload),
    mutationTs: mutation.timestamp,
    status: 'pending',
    retryCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function markLogicalMutationConflict(
  executor: DbExecutor,
  row: LocalSyncMutationRow,
  message: string,
): Promise<void> {
  const now = new Date().toISOString();
  const logicalEntity = and(
    eq(LocalSyncMutationTable.entityType, row.entityType),
    eq(LocalSyncMutationTable.entityId, row.entityId),
    eq(LocalSyncMutationTable.projectId, row.projectId),
    row.parentId === null
      ? isNull(LocalSyncMutationTable.parentId)
      : eq(LocalSyncMutationTable.parentId, row.parentId),
    inArray(LocalSyncMutationTable.status, ['pending', 'in_flight']),
  );

  // Quarantine this operation and every already-queued later operation for
  // the same logical entity. Sending a causal follower after a rejected
  // payload would reorder durable local intent against unknown remote state.
  await executor
    .update(LocalSyncMutationTable)
    .set({ status: 'conflict', lastError: message, updatedAt: now })
    .where(logicalEntity);
  await executor
    .update(LocalSyncMutationTable)
    .set({ retryCount: row.retryCount + 1, updatedAt: now })
    .where(eq(LocalSyncMutationTable.id, row.id));
}

async function markLogicalCreateConflict(
  executor: DbExecutor,
  row: LocalSyncMutationRow,
  error: unknown,
): Promise<void> {
  return markLogicalMutationConflict(
    executor,
    row,
    `CREATE_PAYLOAD_CONFLICT: ${getErrorMessage(error)}`,
  );
}

async function markLogicalPayloadValidationConflict(
  executor: DbExecutor,
  row: LocalSyncMutationRow,
  error: unknown,
): Promise<void> {
  return markLogicalMutationConflict(
    executor,
    row,
    `PAYLOAD_VALIDATION_CONFLICT: ${getErrorMessage(error)}`,
  );
}

async function markLogicalTrashEntitlementConflict(
  executor: DbExecutor,
  row: LocalSyncMutationRow,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const logicalEntity = and(
    eq(LocalSyncMutationTable.entityType, row.entityType),
    eq(LocalSyncMutationTable.entityId, row.entityId),
    eq(LocalSyncMutationTable.projectId, row.projectId),
    row.parentId === null
      ? isNull(LocalSyncMutationTable.parentId)
      : eq(LocalSyncMutationTable.parentId, row.parentId),
    inArray(LocalSyncMutationTable.status, ['pending', 'in_flight']),
  );

  // Quarantine the rejected transition and operations already queued behind
  // it for this entity. Sending later rows would reorder durable local intent.
  await executor
    .update(LocalSyncMutationTable)
    .set({
      status: 'conflict',
      lastError: trashEntitlementBlockedMessage(row.id),
      updatedAt: now,
    })
    .where(logicalEntity);
  await executor
    .update(LocalSyncMutationTable)
    .set({
      retryCount: row.retryCount + 1,
      lastError: trashEntitlementConflictMessage(getErrorMessage(error)),
      updatedAt: now,
    })
    .where(eq(LocalSyncMutationTable.id, row.id));
}

/** Resume only paid-trash conflicts after a fresh server entitlement check. */
export async function rearmTrashEntitlementConflicts(): Promise<number> {
  if (!shouldPersistOutbox()) return 0;
  if (entitlementRearmPromise) return entitlementRearmPromise;

  const operation = (async () => {
    // A flush that received the decisive 402 owns the row until it has
    // finished quarantining that row and its causal followers.
    while (flushInProgress) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    const db = getDb();
    const conflicts = await db
      .select({
        id: LocalSyncMutationTable.id,
        status: LocalSyncMutationTable.status,
        lastError: LocalSyncMutationTable.lastError,
      })
      .from(LocalSyncMutationTable)
      .where(eq(LocalSyncMutationTable.status, 'conflict'));
    const ids = conflicts.filter(isRearmableTrashEntitlementConflict).map((row) => row.id);
    if (ids.length === 0) return 0;

    await db
      .update(LocalSyncMutationTable)
      .set({ status: 'pending', lastError: null, updatedAt: new Date().toISOString() })
      .where(inArray(LocalSyncMutationTable.id, ids));
    await refreshPendingCount();
    return ids.length;
  })();

  // A flush starting after this assignment waits for the selective update,
  // closing the opposite side of the 402-vs-rearm race.
  entitlementRearmPromise = operation;
  try {
    const count = await operation;
    if (count > 0) {
      registerOnlineFlush();
      scheduleFlush();
    }
    return count;
  } finally {
    if (entitlementRearmPromise === operation) entitlementRearmPromise = null;
  }
}

async function flushPushQueue(): Promise<void> {
  if (entitlementRearmPromise) {
    try {
      await entitlementRearmPromise;
    } catch {
      // The entitlement caller reports recovery failure. Avoid racing a
      // partially completed selective update.
      return;
    }
  }
  if (!isSyncEnabled() || flushInProgress) return;
  flushInProgress = true;

  try {
    const db = getDb();
    await db
      .update(LocalSyncMutationTable)
      .set({
        status: 'pending',
        // A previous process died after marking these rows in-flight. The
        // request may have committed remotely, so recovered rows must never be
        // treated like pristine, rewriteable mutations.
        retryCount: sql`${LocalSyncMutationTable.retryCount} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(LocalSyncMutationTable.status, 'in_flight'));

    while (isSyncEnabled()) {
      const batch = await db
        .select()
        .from(LocalSyncMutationTable)
        .where(eq(LocalSyncMutationTable.status, 'pending'))
        .orderBy(asc(LocalSyncMutationTable.id))
        .limit(OUTBOX_BATCH_SIZE);

      if (batch.length === 0) break;

      setStatus('pushing');
      let failed = false;

      for (const row of batch) {
        const mutation = mutationFromRow(row);
        try {
          await db
            .update(LocalSyncMutationTable)
            .set({ status: 'in_flight', updatedAt: new Date().toISOString() })
            .where(eq(LocalSyncMutationTable.id, row.id));
          await pushSingleMutation(mutation);
          await db.delete(LocalSyncMutationTable).where(eq(LocalSyncMutationTable.id, row.id));
        } catch (err) {
          log.error(`[sync] push failed for ${mutation.entityType}/${mutation.entityId}:`, err);
          if (isCreatePayloadConflict(mutation.mutationType, getRemoteStatus(err))) {
            await markLogicalCreateConflict(db, row, err);
            // Reload the batch. Rows quarantined above are still present in the
            // in-memory batch and must never fall through to PATCH.
            break;
          }
          if (isTerminalPayloadValidationFailure(getRemoteStatus(err))) {
            await markLogicalPayloadValidationConflict(db, row, err);
            // The payload is immutable after a network attempt. Quarantine
            // this entity's causal chain and let unrelated rows continue.
            break;
          }
          if (isTrashEntitlementRejection(mutation.mutationType, getRemoteStatus(err))) {
            await markLogicalTrashEntitlementConflict(db, row, err);
            // Reload so the causal followers quarantined above cannot fall
            // through from this in-memory batch.
            break;
          }
          await db
            .update(LocalSyncMutationTable)
            .set({
              status: 'pending',
              retryCount: row.retryCount + 1,
              lastError: getErrorMessage(err),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(LocalSyncMutationTable.id, row.id));
          failed = true;
          break;
        }
      }

      if (failed) break;
    }

    await refreshPendingCount();
    const retryablePendingCount = await countRetryablePendingMutations();
    if (pendingCountCache > 0) {
      const conflictCount = pendingCountCache - retryablePendingCount;
      setStatus(
        'error',
        conflictCount > 0
          ? `${conflictCount} conflict, ${retryablePendingCount} pending`
          : `${retryablePendingCount} pending`,
      );
      // Conflicts require user-visible resolution; repeatedly waking the queue
      // cannot make progress. Unrelated retryable rows continue normally.
      if (retryablePendingCount > 0) scheduleFlush();
    } else {
      setStatus('idle');
    }
  } finally {
    flushInProgress = false;
  }
}

/**
 * Route a single mutation to the correct API endpoint.
 */
function resolveMutationRequest(m: SyncMutation): MutationRequest | null {
  const { entityType, mutationType, entityId, projectId, payload, parentId } = m;

  switch (entityType) {
    // ---- Project ----
    case 'project':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: '/api/projects', data: payload };
      } else if (mutationType === 'update') {
        return { method: 'PATCH', endpoint: `/api/projects/${entityId}`, data: payload };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${entityId}` };

    // ---- Node ----
    case 'node':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/nodes`,
          data: normalizeNodeCreateSyncPayload(payload),
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/nodes/${entityId}`,
          data: payload,
        };
      } else if (mutationType === 'softDelete') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/nodes/${entityId}/trash`,
        };
      } else if (mutationType === 'restore') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/nodes/${entityId}/restore`,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/nodes/${entityId}` };

    // ---- Node Content ----
    case 'nodeContent':
      if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/nodes/${entityId}/content`,
          data: payload,
        };
      }
      return null;

    // ---- Storyline ----
    case 'storyline':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/storylines`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/storylines/${entityId}`,
          data: payload,
        };
      } else if (mutationType === 'softDelete') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/storylines/${entityId}/trash`,
        };
      } else if (mutationType === 'restore') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/storylines/${entityId}/restore`,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/storylines/${entityId}` };

    // ---- Node-Storyline Link ----
    case 'nodeStorylineLink':
      if (mutationType === 'create') {
        // parentId = storylineId, entityId = nodeId
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/storylines/${parentId}/nodes/${entityId}`,
          data: payload,
        };
      } else if (mutationType === 'delete') {
        return {
          method: 'DELETE',
          endpoint: `/api/projects/${projectId}/storylines/${parentId}/nodes/${entityId}`,
        };
      }
      // "update" = set node storylines (bulk replace)
      return {
        method: 'PUT',
        endpoint: `/api/projects/${projectId}/nodes/${entityId}/storylines`,
        data: payload,
      };

    // ---- Element ----
    case 'element':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/elements`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/elements/${entityId}`,
          data: payload,
        };
      } else if (mutationType === 'softDelete') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/elements/${entityId}/trash`,
        };
      } else if (mutationType === 'restore') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/elements/${entityId}/restore`,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/elements/${entityId}` };

    // ---- Element Category ----
    case 'elementCategory':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/categories`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/categories/${entityId}`,
          data: payload,
        };
      } else if (mutationType === 'softDelete') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/categories/${entityId}/trash`,
        };
      } else if (mutationType === 'restore') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/categories/${entityId}/restore`,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/categories/${entityId}` };

    // ---- Element Patch ----
    case 'elementPatch':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/patches`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/patches/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/patches/${entityId}` };

    // ---- Block Section ----
    case 'blockSection':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/block-sections`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/block-sections/${entityId}`,
          data: payload,
        };
      }
      return {
        method: 'DELETE',
        endpoint: `/api/projects/${projectId}/block-sections/${entityId}`,
      };

    // ---- Library Item (formerly material; now also hosts free-form text notes) ----
    case 'libraryItem':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/library`,
          data: stripLibraryItemDeviceFields(payload),
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/library/${entityId}`,
          data: stripLibraryItemDeviceFields(payload),
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/library/${entityId}` };

    // ---- Entity Relation (user-curated cross-entity link) ----
    case 'entityRelation':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/relations`,
          data: payload ? entityRelationRequestPayload(payload, 'create') : payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/relations/${entityId}`,
          data: payload ? entityRelationRequestPayload(payload, 'update') : payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/relations/${entityId}` };

    case 'entityRelationType':
      if (mutationType === 'create') {
        if (!payload) return null;
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/relation-types`,
          data: relationTypeRequestPayload(payload, 'create'),
        };
      } else if (mutationType === 'update') {
        if (!payload) return null;
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/relation-types/${entityId}`,
          data: relationTypeRequestPayload(payload, 'update'),
        };
      }
      return {
        method: 'DELETE',
        endpoint: `/api/projects/${projectId}/relation-types/${entityId}`,
      };

    // ---- Comment (notes + TODOs; see drizzle.ts for the anchor matrix) ----
    case 'comment':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/comments`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/comments/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/comments/${entityId}` };

    // ---- Comment Action ----
    case 'commentAction':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/comment-actions`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/comment-actions/${entityId}`,
          data: payload,
        };
      }
      return {
        method: 'DELETE',
        endpoint: `/api/projects/${projectId}/comment-actions/${entityId}`,
      };

    // ---- Agent Memory (author-level standing guidance) ----
    case 'agentMemory':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/agent-memories`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/agent-memories/${entityId}`,
          data: payload,
        };
      }
      return {
        method: 'DELETE',
        endpoint: `/api/projects/${projectId}/agent-memories/${entityId}`,
      };

    // ---- Agent Working Memory (one rolling Markdown singleton per project) ----
    case 'agentWorkingMemory':
      return {
        method: 'PUT',
        endpoint: `/api/projects/${projectId}/agent-working-memory`,
        data: payload,
      };

    // ---- Book Act (幕) ----
    case 'bookAct':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/acts`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/acts/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/acts/${entityId}` };

    // ---- Drift Group (左栏分组) ----
    case 'driftGroup':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/drift-groups`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/drift-groups/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/drift-groups/${entityId}` };

    // ---- Timeline Marker ----
    case 'timelineMarker':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/timeline-markers`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/timeline-markers/${entityId}`,
          data: payload,
        };
      }
      return {
        method: 'DELETE',
        endpoint: `/api/projects/${projectId}/timeline-markers/${entityId}`,
      };

    default:
      log.warn(`[sync] unknown entity type: ${entityType}`);
      return null;
  }
}

async function pushSingleMutation(m: SyncMutation): Promise<void> {
  const request = resolveMutationRequest(m);
  if (!request) return;

  const requestId = createRequestId(`crud:${m.entityType}:${m.entityId}`);
  const deviceId = getDeviceId();
  const startedAt = nowMs();
  const eventBase = {
    requestId,
    kind: 'crud' as const,
    phase: 'push' as const,
    operation: m.mutationType,
    method: request.method,
    endpoint: request.endpoint,
    entityType: m.entityType,
    entityId: m.entityId,
    entityName: getPayloadName(m.payload),
    projectId: m.projectId,
    deviceId,
  };

  emitSyncOperation({
    ...eventBase,
    state: 'started',
  });

  try {
    await apiClient.request({
      method: request.method,
      url: request.endpoint,
      data: request.data,
    });
    emitSyncOperation({
      ...eventBase,
      state: 'succeeded',
      durationMs: nowMs() - startedAt,
    });
  } catch (error) {
    // DELETE is naturally idempotent once the request has passed the
    // project-scoped route guard. A lost success response followed by a retry
    // must not leave the head outbox row blocking every later mutation.
    if (isMissingRemoteError(error) && m.mutationType === 'delete') {
      emitSyncOperation({
        ...eventBase,
        state: 'succeeded',
        durationMs: nowMs() - startedAt,
      });
      return;
    }

    // Self-heal "orphan local row" case: a PATCH on a row the server
    // doesn't know about (404) usually means the matching CREATE never
    // shipped — typically a row created before the entity got its single-
    // row sync helpers wired up. Look up the local row and POST it; the
    // current mutation can then be treated as succeeded because the
    // freshly-POSTed CREATE already carries the latest snapshot.
    if (isMissingRemoteError(error) && m.mutationType === 'update') {
      const recovered = await tryRecoverMissingRemote(m);
      if (recovered) {
        emitSyncOperation({
          ...eventBase,
          state: 'succeeded',
          durationMs: nowMs() - startedAt,
        });
        return;
      }
    }
    emitSyncOperation({
      ...eventBase,
      state: 'failed',
      durationMs: nowMs() - startedAt,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

function getRemoteStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null | undefined)?.response?.status;
}

function isMissingRemoteError(error: unknown): boolean {
  return getRemoteStatus(error) === 404;
}

/**
 * Best-effort recovery for a local row whose remote counterpart returned
 * 404. Loads the row from the local repo and POSTs it as a fresh CREATE.
 * Returns true if recovery succeeded (caller treats original mutation as
 * done); false if the row can't be recovered (caller propagates the 404).
 *
 * Entity-type-specific because the local-row → create-payload shape is
 * known per entity. Add new branches here as more entities adopt the
 * single-row sync model.
 */
async function tryRecoverMissingRemote(m: SyncMutation): Promise<boolean> {
  if (m.entityType === 'elementPatch') {
    try {
      const repo = createElementPatchRepository();
      const row = await repo.findById(m.entityId);
      if (!row) return false; // gone locally too; nothing to recover
      const createReq = resolveMutationRequest({
        ...m,
        mutationType: 'create',
        payload: {
          id: row.id,
          elementId: row.elementId,
          sourceNodeId: row.sourceNodeId,
          sourceBlockId: row.sourceBlockId,
          sourceBlockText: row.sourceBlockText,
          textAnchorJson: row.textAnchorJson,
          invalidatedAt: row.invalidatedAt,
          title: row.title,
          contentJson: row.contentJson,
          orderKey: row.orderKey,
        },
      });
      if (!createReq) return false;
      await apiClient.request({
        method: createReq.method,
        url: createReq.endpoint,
        data: createReq.data,
      });
      log.info(`[sync] recovered orphan elementPatch ${m.entityId} via POST (was 404 on PATCH)`);
      return true;
    } catch (err) {
      log.warn(`[sync] elementPatch recovery POST failed for ${m.entityId}:`, err);
      return false;
    }
  }
  if (m.entityType === 'blockSection') {
    try {
      const repo = createBlockSectionRepository();
      const row = await repo.findById(m.entityId);
      if (!row) return false;
      const createReq = resolveMutationRequest({
        ...m,
        mutationType: 'create',
        payload: {
          id: row.id,
          chapterId: row.chapterId,
          blockIdsJson: JSON.stringify(row.blockIds),
          blockHashesJson: JSON.stringify(row.blockHashes),
          summary: row.summary,
          source: row.source,
        },
      });
      if (!createReq) return false;
      await apiClient.request({
        method: createReq.method,
        url: createReq.endpoint,
        data: createReq.data,
      });
      log.info(`[sync] recovered orphan blockSection ${m.entityId} via POST (was 404 on PATCH)`);
      return true;
    } catch (err) {
      log.warn(`[sync] blockSection recovery POST failed for ${m.entityId}:`, err);
      return false;
    }
  }
  return false;
}

// ==================== Pull ====================

export interface PullResult {
  project?: unknown;
  projects?: unknown[];
  nodes?: unknown[];
  nodeContents?: unknown[];
  storylines?: unknown[];
  nodeStorylineLinks?: unknown[];
  elements?: unknown[];
  elementCategories?: unknown[];
  categories?: unknown[];
  entityRelations?: unknown[];
  entityRelationTypes?: unknown[];
  entityRelationTypeEndpointKinds?: unknown[];
  inlineMentions?: unknown[];
  entityPatches?: unknown[];
  blockSections?: unknown[];
  libraryItems?: unknown[];
  comments?: unknown[];
  commentActions?: unknown[];
  agentMemories?: unknown[];
  agentWorkingMemory?: unknown;
}

/**
 * Pull all entities for a project from the server.
 * Returns the raw server responses — callers reconcile with local state.
 */
export async function pullProjectData(projectId: string): Promise<PullResult> {
  const graph = await pullAndHydrateProjectGraph(projectId);
  if (!graph) return {};
  return {
    project: graph.project,
    nodes: graph.nodes,
    nodeContents: graph.nodeContents,
    storylines: graph.storylines,
    nodeStorylineLinks: graph.nodeStorylineLinks,
    elements: graph.elements,
    elementCategories: graph.elementCategories,
    categories: graph.elementCategories,
    entityRelations: graph.entityRelations,
    entityRelationTypes: graph.entityRelationTypes,
    entityRelationTypeEndpointKinds: graph.entityRelationTypeEndpointKinds,
    inlineMentions: graph.inlineMentions,
    entityPatches: graph.entityPatches,
    blockSections: graph.blockSections,
    libraryItems: graph.libraryItems,
    comments: graph.comments,
    commentActions: graph.commentActions,
    agentMemories: graph.agentMemories,
    agentWorkingMemory: graph.agentWorkingMemory,
  };
}

function dateText(value: unknown): string {
  if (typeof value === 'string' && value) return value;
  if (value instanceof Date) return value.toISOString();
  return new Date().toISOString();
}

function stringValue(row: Record<string, unknown>, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function nullableStringValue(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function numberValue(row: Record<string, unknown>, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumberValue(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function projectAssetKind(value: string): ProjectAsset['kind'] {
  return value === 'pdf' ? 'pdf' : 'image';
}

function projectAssetRole(value: string): ProjectAsset['role'] {
  return value === 'library_material' ? 'library_material' : 'element_portrait';
}

function projectAssetOwnerKind(value: string): ProjectAsset['ownerKind'] {
  return value === 'library_item' ? 'library_item' : 'element';
}

function projectAssetStatus(value: string): ProjectAsset['status'] {
  if (value === 'ready' || value === 'failed') return value;
  return 'pending';
}

// deletedAt arrives as an ISO string over JSON (or a Date in-process). Preserve
// null — a non-deleted row must stay null, unlike dateText() which defaults to
// now(). Soft-deleted rows keep their timestamp so the trash view can find them.
function nullableDateText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value || null;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function isDeleted(row: Record<string, unknown>): boolean {
  return nullableDateText(row.deletedAt) != null;
}

function buildStorylineNodeMapping(
  links: Array<{ nodeId: string; storylineId: string }>,
): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};
  links.forEach((link) => {
    const nodes = mapping[link.storylineId] ?? [];
    if (!nodes.includes(link.nodeId)) mapping[link.storylineId] = [...nodes, link.nodeId];
  });
  return mapping;
}

export function projectRelationTypeProjection(graph: ProjectGraphPayload): {
  types: EntityRelationType[];
  endpointRows: Array<{ relationTypeId: string; side: 'source' | 'target'; entityKind: string }>;
  relationTypeIdFor: (row: Record<string, unknown>) => string | null;
} {
  const endpointRows = (graph.entityRelationTypeEndpointKinds ?? [])
    .map((row) => ({
      relationTypeId: stringValue(row, 'relationTypeId'),
      side: stringValue(row, 'side') as 'source' | 'target',
      entityKind: stringValue(row, 'entityKind'),
    }))
    .filter(
      (row) =>
        row.relationTypeId && (row.side === 'source' || row.side === 'target') && row.entityKind,
    );
  const byId = new Map<string, EntityRelationType>();
  const arrayStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  for (const row of graph.entityRelationTypes ?? []) {
    const id = stringValue(row, 'id');
    if (!id) continue;
    const sourceKinds = [
      ...endpointRows
        .filter((endpoint) => endpoint.relationTypeId === id && endpoint.side === 'source')
        .map((endpoint) => endpoint.entityKind),
      ...arrayStrings(row.sourceKinds),
    ];
    const targetKinds = [
      ...endpointRows
        .filter((endpoint) => endpoint.relationTypeId === id && endpoint.side === 'target')
        .map((endpoint) => endpoint.entityKind),
      ...arrayStrings(row.targetKinds),
    ];
    const sourceKindSet = new Set(sourceKinds);
    const targetKindSet = new Set(targetKinds);
    const uniqueSourceKinds = ALL_ENTITY_KINDS.filter((kind) =>
      sourceKindSet.has(kind),
    ) as EntityRelationType['sourceKinds'];
    const uniqueTargetKinds = STRUCTURAL_ENTITY_KINDS.filter((kind) =>
      targetKindSet.has(kind),
    ) as EntityRelationType['targetKinds'];
    byId.set(id, {
      id,
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      normalizedName: stringValue(row, 'normalizedName'),
      description: stringValue(row, 'description'),
      orientation: stringValue(
        row,
        'orientation',
        'unconfigured',
      ) as EntityRelationType['orientation'],
      sourceRole: stringValue(row, 'sourceRole'),
      targetRole: stringValue(row, 'targetRole'),
      sourceKinds:
        uniqueSourceKinds.length > 0 ? uniqueSourceKinds : [...LEGACY_RELATION_SOURCE_KINDS],
      targetKinds:
        uniqueTargetKinds.length > 0 ? uniqueTargetKinds : [...LEGACY_RELATION_TARGET_KINDS],
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    });
  }

  const relationTypeIdFor = (row: Record<string, unknown>): string | null => {
    const explicit = nullableStringValue(row, 'relationTypeId');
    if (explicit) return explicit;
    const kind = nullableStringValue(row, 'kind')?.trim();
    return kind ? legacyRelationTypeId(stringValue(row, 'projectId'), kind) : null;
  };

  for (const relation of graph.entityRelations) {
    const kind = nullableStringValue(relation, 'kind')?.trim();
    const relationTypeId = relationTypeIdFor(relation);
    if (!kind || !relationTypeId || byId.has(relationTypeId)) continue;
    const legacy = legacyRelationType(
      stringValue(relation, 'projectId'),
      kind,
      dateText(relation.createdAt),
      dateText(relation.updatedAt),
    );
    byId.set(relationTypeId, { ...legacy, id: relationTypeId });
  }

  const types = [...byId.values()];
  const endpointKeys = new Set(
    endpointRows.map((row) => `${row.relationTypeId}:${row.side}:${row.entityKind}`),
  );
  for (const type of types) {
    for (const entityKind of type.sourceKinds) {
      const key = `${type.id}:source:${entityKind}`;
      if (!endpointKeys.has(key)) {
        endpointRows.push({ relationTypeId: type.id, side: 'source', entityKind });
        endpointKeys.add(key);
      }
    }
    for (const entityKind of type.targetKinds) {
      const key = `${type.id}:target:${entityKind}`;
      if (!endpointKeys.has(key)) {
        endpointRows.push({ relationTypeId: type.id, side: 'target', entityKind });
        endpointKeys.add(key);
      }
    }
  }
  return { types, endpointRows, relationTypeIdFor };
}

function applyGraphToStores(graph: ProjectGraphPayload): void {
  // Soft-deleted rows still ride along in the pulled graph — the server returns
  // them so the trash view + restore can work. The live in-memory stores must
  // only ever hold non-deleted entities; otherwise a just-trashed storyline /
  // chapter / element reappears on the next pull. Filter them out here. SQLite
  // keeps the rows (with deletedAt) for the trash panel — see the hydrate below.
  const liveStorylines = graph.storylines.filter((row) => !isDeleted(row));
  const liveNodes = graph.nodes.filter((row) => !isDeleted(row));
  // Surviving node ids — act/marker drift bindings to a trashed node render
  // as plain (unbound) rather than dangling.
  const liveNodeIds = new Set(liveNodes.map((row) => stringValue(row, 'id')));
  const liveCategories = graph.elementCategories.filter((row) => !isDeleted(row));
  const liveElements = graph.elements.filter((row) => !isDeleted(row));
  const deletedNodeIds = new Set(
    graph.nodes.filter((row) => isDeleted(row)).map((row) => stringValue(row, 'id')),
  );
  const deletedStorylineIds = new Set(
    graph.storylines.filter((row) => isDeleted(row)).map((row) => stringValue(row, 'id')),
  );

  // Trashed (soft-deleted, recoverable) ids by kind — lets inline mentions
  // render a "dimmed" state distinct from hard-deleted ("gone") targets. The
  // live arrays drop these rows; this set is the only place their ids survive
  // in memory. Keyed exactly like trashedKey(kind, id).
  const trashedEntityIds = new Set<string>();
  for (const id of deletedNodeIds) if (id) trashedEntityIds.add(`node:${id}`);
  for (const id of deletedStorylineIds) if (id) trashedEntityIds.add(`storyline:${id}`);
  for (const row of graph.elements) {
    if (isDeleted(row)) trashedEntityIds.add(`element:${stringValue(row, 'id')}`);
  }
  for (const row of graph.elementCategories) {
    if (isDeleted(row)) trashedEntityIds.add(`category:${stringValue(row, 'id')}`);
  }

  const nodeStorylineLinks = graph.nodeStorylineLinks
    .map((row) => ({
      nodeId: stringValue(row, 'nodeId'),
      storylineId: stringValue(row, 'storylineId'),
      isPrimary: Boolean((row as Record<string, unknown>).isPrimary),
    }))
    .filter(
      (row) =>
        row.nodeId &&
        row.storylineId &&
        !deletedNodeIds.has(row.nodeId) &&
        !deletedStorylineIds.has(row.storylineId),
    );

  // Derived: which storyline is primary for each node. Replaces the role of
  // book_node.mainStorylineId — the column is gone, the link table is truth.
  const primaryStorylineByNode: Record<string, string | null> = {};
  for (const link of nodeStorylineLinks) {
    if (link.isPrimary) primaryStorylineByNode[link.nodeId] = link.storylineId;
  }

  const dataStore = useDataStore.getState();
  dataStore.setTrashedEntityIds(trashedEntityIds);
  dataStore.setPrimaryStorylineByNode(primaryStorylineByNode);
  dataStore.setStorylines(
    liveStorylines.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      color: stringValue(row, 'color'),
      summary: stringValue(row, 'summary'),
      orderKey: numberValue(row, 'orderKey'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      kvJson: stringValue(row, 'kvJson', '[]'),
      nodeContentTemplateJson: stringValue(row, 'nodeContentTemplateJson', '{}'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setBookNodes(
    liveNodes.map((row): BookNode => {
      const base = {
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        title: stringValue(row, 'title'),
        summary: stringValue(row, 'summary'),
        narrativeOrder: row.narrativeOrder == null ? null : numberValue(row, 'narrativeOrder'),
        driftGroupId: row.driftGroupId == null ? null : stringValue(row, 'driftGroupId'),
        position: {
          x: numberValue(row, 'positionX'),
          y: numberValue(row, 'positionY'),
        },
        wordCount: numberValue(row, 'wordCount'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      };
      const rowKind = stringValue(row, 'kind', '');
      const kind: 'chapter' | 'drift' = rowKind === 'chapter' ? 'chapter' : 'drift';
      if (kind === 'drift') {
        return {
          ...base,
          kind: 'drift',
          bookOrder: null,
          writingStatus: stringValue(row, 'writingStatus', 'drifting') as DriftStatus,
        };
      }
      return {
        ...base,
        kind: 'chapter',
        bookOrder: row.bookOrder == null ? 0 : numberValue(row, 'bookOrder'),
        writingStatus: stringValue(row, 'writingStatus', 'draft') as ChapterWritingStatus,
      };
    }),
  );
  dataStore.setStorylineNodeMapping(buildStorylineNodeMapping(nodeStorylineLinks));
  dataStore.setBookElementCategories(
    liveCategories.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      elementTemplateJson: stringValue(row, 'elementTemplateJson', '{}'),
      elementTemplateKvJson: stringValue(row, 'elementTemplateKvJson', '[]'),
      color: stringValue(row, 'color'),
      layoutMode: (stringValue(row, 'layoutMode', 'auto') === 'pinned' ? 'pinned' : 'auto') as
        | 'auto'
        | 'pinned',
      gridX: nullableNumberValue(row, 'gridX'),
      gridY: nullableNumberValue(row, 'gridY'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setProjectAssets(
    (graph.projectAssets ?? []).map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      kind: projectAssetKind(stringValue(row, 'kind', 'image')),
      role: projectAssetRole(stringValue(row, 'role', 'element_portrait')),
      ownerKind: projectAssetOwnerKind(stringValue(row, 'ownerKind', 'element')),
      ownerId: stringValue(row, 'ownerId'),
      status: projectAssetStatus(stringValue(row, 'status', 'pending')),
      sourceObjectKey: nullableStringValue(row, 'sourceObjectKey'),
      displayObjectKey: nullableStringValue(row, 'displayObjectKey'),
      thumbnailObjectKey: nullableStringValue(row, 'thumbnailObjectKey'),
      sourceMime: nullableStringValue(row, 'sourceMime'),
      displayMime: nullableStringValue(row, 'displayMime'),
      thumbnailMime: nullableStringValue(row, 'thumbnailMime'),
      sourceSizeBytes: nullableNumberValue(row, 'sourceSizeBytes'),
      displaySizeBytes: nullableNumberValue(row, 'displaySizeBytes'),
      thumbnailSizeBytes: nullableNumberValue(row, 'thumbnailSizeBytes'),
      sourceSha256: nullableStringValue(row, 'sourceSha256'),
      width: nullableNumberValue(row, 'width'),
      height: nullableNumberValue(row, 'height'),
      completedAt: nullableDateText(row.completedAt),
      deletedAt: nullableDateText(row.deletedAt),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  // Same orphan-detach guard as the SQLite hydrate below — elements whose
  // categoryId doesn't appear in the returned categories list fall into the
  // "未分类" bucket instead of leaving a dangling reference.
  const knownCategoryIdsForStore = new Set<string>();
  for (const row of liveCategories) {
    const id = stringValue(row, 'id');
    if (id) knownCategoryIdsForStore.add(id);
  }
  dataStore.setBookElements(
    liveElements.map((row) => {
      const rawCategoryId = nullableStringValue(row, 'categoryId');
      const categoryId =
        rawCategoryId && knownCategoryIdsForStore.has(rawCategoryId) ? rawCategoryId : null;
      return {
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        categoryId,
        name: stringValue(row, 'name'),
        summary: stringValue(row, 'summary'),
        contentJson: stringValue(row, 'contentJson', '{}'),
        kvJson: stringValue(row, 'kvJson', '[]'),
        aliases: decodeAliases(stringValue(row, 'aliasesJson', '[]')),
        groupName: nullableStringValue(row, 'groupName'),
        portraitAssetId: nullableStringValue(row, 'portraitAssetId'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      };
    }),
  );
  dataStore.setLibraryItems(
    graph.libraryItems.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      title: stringValue(row, 'title'),
      kind:
        stringValue(row, 'kind') === 'markdown'
          ? 'text'
          : (stringValue(row, 'kind') as 'image' | 'pdf' | 'url' | 'text'),
      source: (stringValue(row, 'source', 'local') || 'local') as 'local' | 'url' | 'r2',
      uri: stringValue(row, 'uri'),
      localPath: nullableStringValue(row, 'localPath'),
      assetId: nullableStringValue(row, 'assetId'),
      mime: nullableStringValue(row, 'mime'),
      sizeBytes:
        typeof row.sizeBytes === 'number' && Number.isFinite(row.sizeBytes)
          ? (row.sizeBytes as number)
          : null,
      bodyJson: nullableStringValue(row, 'bodyJson'),
      notesJson: nullableStringValue(row, 'notesJson'),
      thumbnailUri: nullableStringValue(row, 'thumbnailUri'),
      orderKey: numberValue(row, 'orderKey'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setComments(
    graph.comments.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      kind: (stringValue(row, 'kind', 'note') || 'note') as 'note' | 'todo',
      targetKind: nullableStringValue(row, 'targetKind') as any,
      targetId: nullableStringValue(row, 'targetId'),
      targetBlockId: nullableStringValue(row, 'targetBlockId'),
      anchorJson: stringValue(row, 'anchorJson', '{}'),
      authorKind: (stringValue(row, 'authorKind', 'user') || 'user') as any,
      authorId: nullableStringValue(row, 'authorId'),
      authorName: nullableStringValue(row, 'authorName'),
      bodyJson: stringValue(row, 'bodyJson', '{}'),
      status: (stringValue(row, 'status', 'open') || 'open') as any,
      priority: nullableStringValue(row, 'priority') as any,
      source: (stringValue(row, 'source', 'manual') || 'manual') as any,
      metadataJson: nullableStringValue(row, 'metadataJson'),
      targetBlockIdsJson: stringValue(row, 'targetBlockIdsJson', '[]'),
      resolvedAt: nullableStringValue(row, 'resolvedAt'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setBookActs(
    (graph.bookActs ?? []).map((row) => {
      const driftNodeId = nullableStringValue(row, 'driftNodeId');
      return {
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        name: stringValue(row, 'name'),
        color: nullableStringValue(row, 'color'),
        startOrder: nullableNumberValue(row, 'startOrder'),
        // A binding to a trashed/vanished drift renders as a plain act.
        driftNodeId: driftNodeId && liveNodeIds.has(driftNodeId) ? driftNodeId : null,
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      };
    }),
  );
  dataStore.setDriftGroups(
    (graph.driftGroups ?? []).map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      parentGroupId: nullableStringValue(row, 'parentGroupId'),
      color: nullableStringValue(row, 'color'),
      sortOrder: nullableNumberValue(row, 'sortOrder'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setTimelineMarkers(
    (graph.timelineMarkers ?? [])
      .map((row) => {
        const driftNodeId = nullableStringValue(row, 'driftNodeId');
        return {
          id: stringValue(row, 'id'),
          projectId: stringValue(row, 'projectId'),
          narrativeOrder: numberValue(row, 'narrativeOrder'),
          label: stringValue(row, 'label'),
          // Bindings to trashed/vanished drifts render as plain pins.
          driftNodeId: driftNodeId && liveNodeIds.has(driftNodeId) ? driftNodeId : null,
          createdAt: dateText(row.createdAt),
          updatedAt: dateText(row.updatedAt),
        };
      })
      .filter((row) => row.id),
  );
  dataStore.setBlockSections(
    (graph.blockSections ?? []).map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      chapterId: stringValue(row, 'chapterId'),
      blockIds: decodeBlockIds(stringValue(row, 'blockIdsJson', '[]')),
      blockHashes: decodeBlockHashes(stringValue(row, 'blockHashesJson', '{}')),
      summary: stringValue(row, 'summary'),
      source: (stringValue(row, 'source', 'copilot-rolling') ||
        'copilot-rolling') as BlockSectionSource,
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setCommentActions(
    graph.commentActions.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      commentId: stringValue(row, 'commentId'),
      kind: stringValue(row, 'kind') as any,
      label: nullableStringValue(row, 'label'),
      payloadJson: stringValue(row, 'payloadJson', '{}'),
      status: (stringValue(row, 'status', 'pending') || 'pending') as any,
      resultJson: nullableStringValue(row, 'resultJson'),
      createdByKind: (stringValue(row, 'createdByKind', 'user') || 'user') as any,
      createdById: nullableStringValue(row, 'createdById'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
      appliedAt: nullableStringValue(row, 'appliedAt'),
    })),
  );
  // Surface user-curated cross-entity relations so the right sidebar relation
  // picker can render attached chapters / elements / etc. without hitting
  // SQLite. Inline mentions are NOT mirrored to the store — ReferencesPanel
  // queries them directly from the inline_mention table on demand.
  const relationTypes = projectRelationTypeProjection(graph);
  dataStore.setEntityRelationTypes(relationTypes.types);
  dataStore.setEntityRelations(
    graph.entityRelations.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      fromKind: stringValue(row, 'fromKind') as any,
      fromId: stringValue(row, 'fromId'),
      toKind: stringValue(row, 'toKind') as any,
      toId: stringValue(row, 'toId'),
      relationTypeId: relationTypes.relationTypeIdFor(row),
      kind: nullableStringValue(row, 'kind'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );

  const project = {
    id: stringValue(graph.project, 'id'),
    userId: stringValue(graph.project, 'userId'),
    name: stringValue(graph.project, 'name'),
    summary: stringValue(graph.project, 'summary'),
    kvJson: stringValue(graph.project, 'kvJson', '[]'),
    storylineTemplateKvJson: stringValue(graph.project, 'storylineTemplateKvJson', '[]'),
    createdAt: dateText(graph.project.createdAt),
    updatedAt: dateText(graph.project.updatedAt),
  };
  const projectStore = useProjectStore.getState();
  projectStore.setCurrentProject(project);
  projectStore.setProjects([
    project,
    ...projectStore.projects.filter((item) => item.id !== project.id),
  ]);
}

function normalizeProjectRow(row: Record<string, unknown>) {
  return {
    id: stringValue(row, 'id'),
    userId: stringValue(row, 'userId'),
    name: stringValue(row, 'name'),
    summary: stringValue(row, 'summary'),
    kvJson: stringValue(row, 'kvJson', '[]'),
    storylineTemplateKvJson: stringValue(row, 'storylineTemplateKvJson', '[]'),
    createdAt: dateText(row.createdAt),
    updatedAt: dateText(row.updatedAt),
  };
}

function normalizeRows(
  rows: Record<string, unknown>[],
  mapper: (row: Record<string, unknown>) => Record<string, unknown>,
) {
  return rows.map(mapper);
}

async function insertRowsBatched(
  tx: unknown,
  table: unknown,
  rows: Record<string, unknown>[],
  options: { onConflictDoNothing?: boolean } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const columnCount = Math.max(Object.keys(rows[0] ?? {}).length, 1);
  const batchSize = Math.max(1, Math.floor(SQLITE_MAX_INSERT_PARAMS / columnCount));
  const inserter = tx as {
    insert: (target: unknown) => {
      values: (values: Record<string, unknown>[]) => unknown;
    };
  };
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const query = inserter.insert(table).values(batch);
    if (options.onConflictDoNothing && hasOnConflictDoNothing(query)) {
      await query.onConflictDoNothing();
    } else {
      await query;
    }
  }
}

function hasOnConflictDoNothing(
  query: unknown,
): query is { onConflictDoNothing: () => Promise<unknown> } {
  return (
    query !== null &&
    typeof query === 'object' &&
    'onConflictDoNothing' in query &&
    typeof (query as { onConflictDoNothing?: unknown }).onConflictDoNothing === 'function'
  );
}

interface EntityRelationKeyInput {
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  kind: string | null;
  relationTypeId?: string | null;
}

function entityRelationKey(row: EntityRelationKeyInput): string {
  // The semantic type id is authoritative. The mirrored label is only the
  // compatibility identity for uncategorized/old-client rows.
  return `${row.fromKind}:${row.fromId}->${row.toKind}:${row.toId}:${row.relationTypeId ?? `legacy:${row.kind ?? ''}`}`;
}

async function countPendingMutations(projectId?: string): Promise<number> {
  // Successful mutations are deleted from the outbox, so anything still here
  // is unfinished (pending, in_flight, or last attempt failed). Treat all of
  // them as "would be lost by a destructive hydrate".
  const conditions = projectId ? [eq(LocalSyncMutationTable.projectId, projectId)] : [];
  const rows = await getDb()
    .select({ id: LocalSyncMutationTable.id })
    .from(LocalSyncMutationTable)
    .where(conditions.length ? and(...conditions) : undefined);
  return rows.length;
}

export async function hydrateProjectGraph(
  graph: ProjectGraphPayload,
  expectedGeneration?: number,
): Promise<boolean> {
  const projectId = stringValue(graph.project, 'id');
  if (!projectId) throw new Error('Cannot hydrate project graph without project.id');
  const db = getDb();
  let deviceSafeGraph = graph;
  const projectedRelationTypes = projectRelationTypeProjection(graph);

  return runGuardedProjectHydration<DbTransaction>({
    projectId,
    expectedGeneration,
    transaction: (work) => db.transaction(work),
    hydrate: async (tx) => {
      // Successful mutations are deleted from the outbox. Only rows still
      // referenced by unfinished mutations may survive a server-canonical
      // hydrate; preserving every local row resurrects remote deletions.
      const unfinishedMutations = await tx
        .select({
          entityType: LocalSyncMutationTable.entityType,
          entityId: LocalSyncMutationTable.entityId,
        })
        .from(LocalSyncMutationTable)
        .where(eq(LocalSyncMutationTable.projectId, projectId));
      const unfinishedIds = (entityType: EntityType) =>
        new Set(
          unfinishedMutations
            .filter((mutation) => mutation.entityType === entityType)
            .map((mutation) => mutation.entityId),
        );
      const unfinishedRelationIds = unfinishedIds('entityRelation');
      const unfinishedRelationTypeIds = unfinishedIds('entityRelationType');
      const unfinishedPatchIds = unfinishedIds('elementPatch');
      const unfinishedSectionIds = unfinishedIds('blockSection');

      // Inline mentions aren't preserved — they're a pure projection of doc
      // content and will be rebuilt after hydrate.
      const allLocalEntityRelations = await tx
        .select()
        .from(EntityRelationTable)
        .where(eq(EntityRelationTable.projectId, projectId));
      const localEntityRelations = allLocalEntityRelations.filter((row) =>
        unfinishedRelationIds.has(row.id),
      );
      for (const relation of localEntityRelations) {
        if (relation.relationTypeId) unfinishedRelationTypeIds.add(relation.relationTypeId);
      }
      const allLocalRelationTypes = await tx
        .select()
        .from(EntityRelationTypeTable)
        .where(eq(EntityRelationTypeTable.projectId, projectId));
      const localRelationTypes = allLocalRelationTypes.filter((row) =>
        unfinishedRelationTypeIds.has(row.id),
      );
      const allLocalEndpointKinds =
        allLocalRelationTypes.length > 0
          ? await tx
              .select()
              .from(EntityRelationTypeEndpointKindTable)
              .where(
                inArray(
                  EntityRelationTypeEndpointKindTable.relationTypeId,
                  allLocalRelationTypes.map((row) => row.id),
                ),
              )
          : [];
      const localEndpointKinds = allLocalEndpointKinds.filter((row) =>
        unfinishedRelationTypeIds.has(row.relationTypeId),
      );

      const allLocalPatches = await tx
        .select()
        .from(ElementPatchTable)
        .where(eq(ElementPatchTable.projectId, projectId));
      const localPatches = allLocalPatches.filter((row) => unfinishedPatchIds.has(row.id));

      const allLocalBlockSections = await tx
        .select()
        .from(BlockSectionTable)
        .where(eq(BlockSectionTable.projectId, projectId));
      const localBlockSections = allLocalBlockSections.filter((row) =>
        unfinishedSectionIds.has(row.id),
      );

      // Unlike server-canonical content, localPath is an overlay owned by this
      // device. Capture it before the destructive hydrate so a remote response
      // cannot replace it with another machine's absolute path. Cross-device
      // rows absent from this local snapshot are normalized to null.
      const localLibraryItemDeviceFields = await tx
        .select({ id: LibraryItemTable.id, localPath: LibraryItemTable.localPath })
        .from(LibraryItemTable)
        .where(eq(LibraryItemTable.projectId, projectId));
      deviceSafeGraph = {
        ...graph,
        libraryItems: overlayLibraryItemDeviceFields(
          graph.libraryItems,
          localLibraryItemDeviceFields,
        ),
      };

      const oldNodes = await tx
        .select({ id: BookNodeTable.id })
        .from(BookNodeTable)
        .where(eq(BookNodeTable.projectId, projectId));
      const oldElements = await tx
        .select({ id: BookElementTable.id })
        .from(BookElementTable)
        .where(eq(BookElementTable.projectId, projectId));
      const oldStorylines = await tx
        .select({ id: StorylineTable.id })
        .from(StorylineTable)
        .where(eq(StorylineTable.projectId, projectId));
      const oldCategories = await tx
        .select({ id: ElementCategoryTable.id })
        .from(ElementCategoryTable)
        .where(eq(ElementCategoryTable.projectId, projectId));

      const oldNodeIds = oldNodes.map((row) => row.id);
      const oldElementIds = oldElements.map((row) => row.id);
      const oldStorylineIds = oldStorylines.map((row) => row.id);
      const oldCategoryIds = oldCategories.map((row) => row.id);

      // Polymorphic cleanup helper: both tables carry (kind, id) on each end
      // without FK enforcement, so we run explicit deletes when an endpoint is
      // about to be wiped.
      const deletePolymorphicForIds = async (
        kind: 'node' | 'element' | 'storyline' | 'category',
        ids: string[],
      ) => {
        if (ids.length === 0) return;
        await tx
          .delete(EntityRelationTable)
          .where(
            and(eq(EntityRelationTable.fromKind, kind), inArray(EntityRelationTable.fromId, ids)),
          );
        await tx
          .delete(EntityRelationTable)
          .where(and(eq(EntityRelationTable.toKind, kind), inArray(EntityRelationTable.toId, ids)));
        await tx
          .delete(InlineMentionTable)
          .where(
            and(eq(InlineMentionTable.fromKind, kind), inArray(InlineMentionTable.fromId, ids)),
          );
        await tx
          .delete(InlineMentionTable)
          .where(and(eq(InlineMentionTable.toKind, kind), inArray(InlineMentionTable.toId, ids)));
      };

      if (oldNodeIds.length > 0) {
        await tx.delete(NodeContentTable).where(inArray(NodeContentTable.nodeId, oldNodeIds));
        await tx
          .delete(NodeStorylineLinkTable)
          .where(inArray(NodeStorylineLinkTable.nodeId, oldNodeIds));
        await deletePolymorphicForIds('node', oldNodeIds);
        // ElementPatch.sourceNodeId is ON DELETE SET NULL — letting the BookNode
        // deletion below cascade is enough; rows themselves are owned by elements
        // and will be cleared when those cascade.
      }
      await deletePolymorphicForIds('element', oldElementIds);
      if (oldStorylineIds.length > 0) {
        await tx
          .delete(NodeStorylineLinkTable)
          .where(inArray(NodeStorylineLinkTable.storylineId, oldStorylineIds));
        await deletePolymorphicForIds('storyline', oldStorylineIds);
      }
      await deletePolymorphicForIds('category', oldCategoryIds);

      // Library items and comments are project-scoped; wipe and reinsert from
      // the payload. Their entity_relation rows are dropped here too — server is
      // the source of truth for annotative-side relations. (Inline mentions
      // never target an annotative entity, so only relation cleanup is needed.)
      await tx
        .delete(EntityRelationTable)
        .where(
          and(
            eq(EntityRelationTable.projectId, projectId),
            eq(EntityRelationTable.fromKind, 'comment'),
          ),
        );
      // Relations are restored after their semantic type parents. Explicitly
      // clear any rows that survived polymorphic endpoint cleanup before the
      // relation-type tables are replaced.
      await tx.delete(EntityRelationTable).where(eq(EntityRelationTable.projectId, projectId));
      if (allLocalRelationTypes.length > 0) {
        await tx.delete(EntityRelationTypeEndpointKindTable).where(
          inArray(
            EntityRelationTypeEndpointKindTable.relationTypeId,
            allLocalRelationTypes.map((row) => row.id),
          ),
        );
      }
      await tx
        .delete(EntityRelationTypeTable)
        .where(eq(EntityRelationTypeTable.projectId, projectId));
      await tx
        .delete(EntityRelationTable)
        .where(
          and(
            eq(EntityRelationTable.projectId, projectId),
            eq(EntityRelationTable.fromKind, 'library_item'),
          ),
        );
      // Inline mentions originating from comment / library_item bodies (if the
      // user happens to @-mention an element from a TODO body) — wipe alongside.
      await tx
        .delete(InlineMentionTable)
        .where(
          and(
            eq(InlineMentionTable.projectId, projectId),
            eq(InlineMentionTable.fromKind, 'comment'),
          ),
        );
      await tx
        .delete(InlineMentionTable)
        .where(
          and(
            eq(InlineMentionTable.projectId, projectId),
            eq(InlineMentionTable.fromKind, 'library_item'),
          ),
        );
      await tx.delete(LibraryItemTable).where(eq(LibraryItemTable.projectId, projectId));
      await tx.delete(CommentActionTable).where(eq(CommentActionTable.projectId, projectId));
      await tx.delete(CommentTable).where(eq(CommentTable.projectId, projectId));
      await tx.delete(AgentMemoryTable).where(eq(AgentMemoryTable.projectId, projectId));
      await tx
        .delete(AgentWorkingMemoryTable)
        .where(eq(AgentWorkingMemoryTable.projectId, projectId));
      await tx.delete(BookActTable).where(eq(BookActTable.projectId, projectId));
      await tx.delete(DriftGroupTable).where(eq(DriftGroupTable.projectId, projectId));
      await tx.delete(TimelineMarkerTable).where(eq(TimelineMarkerTable.projectId, projectId));
      await tx.delete(BookNodeTable).where(eq(BookNodeTable.projectId, projectId));
      await tx.delete(BookElementTable).where(eq(BookElementTable.projectId, projectId));
      await tx.delete(ProjectAssetTable).where(eq(ProjectAssetTable.projectId, projectId));
      await tx.delete(StorylineTable).where(eq(StorylineTable.projectId, projectId));
      await tx.delete(ElementCategoryTable).where(eq(ElementCategoryTable.projectId, projectId));

      const project = normalizeProjectRow(graph.project);
      await tx
        .insert(ProjectTable)
        .values(project)
        .onConflictDoUpdate({
          target: ProjectTable.id,
          set: {
            userId: project.userId,
            name: project.name,
            summary: project.summary,
            kvJson: project.kvJson,
            storylineTemplateKvJson: project.storylineTemplateKvJson,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        });

      const relationTypeRows = new Map(
        projectedRelationTypes.types.map((type) => [
          type.id,
          {
            id: type.id,
            projectId: type.projectId,
            name: type.name,
            normalizedName: type.normalizedName,
            description: type.description,
            orientation: type.orientation,
            sourceRole: type.sourceRole,
            targetRole: type.targetRole,
            createdAt: type.createdAt,
            updatedAt: type.updatedAt,
          },
        ]),
      );
      for (const row of localRelationTypes) {
        relationTypeRows.set(row.id, {
          ...row,
          orientation: row.orientation as EntityRelationType['orientation'],
        });
      }
      if (relationTypeRows.size > 0) {
        await insertRowsBatched(tx, EntityRelationTypeTable, [...relationTypeRows.values()]);
      }
      const relationTypeEndpointRows = new Map(
        [...projectedRelationTypes.endpointRows, ...localEndpointKinds].map((row) => [
          `${row.relationTypeId}:${row.side}:${row.entityKind}`,
          row,
        ]),
      );
      if (relationTypeEndpointRows.size > 0) {
        await insertRowsBatched(tx, EntityRelationTypeEndpointKindTable, [
          ...relationTypeEndpointRows.values(),
        ]);
      }

      const elementCategories = normalizeRows(graph.elementCategories, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        name: stringValue(row, 'name'),
        contentJson: stringValue(row, 'contentJson', '{}'),
        elementTemplateJson: stringValue(row, 'elementTemplateJson', '{}'),
        elementTemplateKvJson: stringValue(row, 'elementTemplateKvJson', '[]'),
        color: stringValue(row, 'color'),
        layoutMode: stringValue(row, 'layoutMode', 'auto') || 'auto',
        gridX: nullableNumberValue(row, 'gridX'),
        gridY: nullableNumberValue(row, 'gridY'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
        deletedAt: nullableDateText(row.deletedAt),
      }));
      if (elementCategories.length > 0) {
        await insertRowsBatched(tx, ElementCategoryTable, elementCategories);
      }

      const projectAssets = normalizeRows(graph.projectAssets ?? [], (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        kind: stringValue(row, 'kind', 'image') || 'image',
        role: stringValue(row, 'role', 'element_portrait') || 'element_portrait',
        ownerKind: stringValue(row, 'ownerKind', 'element') || 'element',
        ownerId: stringValue(row, 'ownerId'),
        status: stringValue(row, 'status', 'pending') || 'pending',
        sourceObjectKey: nullableStringValue(row, 'sourceObjectKey'),
        displayObjectKey: nullableStringValue(row, 'displayObjectKey'),
        thumbnailObjectKey: nullableStringValue(row, 'thumbnailObjectKey'),
        sourceMime: nullableStringValue(row, 'sourceMime'),
        displayMime: nullableStringValue(row, 'displayMime'),
        thumbnailMime: nullableStringValue(row, 'thumbnailMime'),
        sourceSizeBytes: nullableNumberValue(row, 'sourceSizeBytes'),
        displaySizeBytes: nullableNumberValue(row, 'displaySizeBytes'),
        thumbnailSizeBytes: nullableNumberValue(row, 'thumbnailSizeBytes'),
        sourceSha256: nullableStringValue(row, 'sourceSha256'),
        width: nullableNumberValue(row, 'width'),
        height: nullableNumberValue(row, 'height'),
        completedAt: nullableDateText(row.completedAt),
        deletedAt: nullableDateText(row.deletedAt),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.projectId);
      if (projectAssets.length > 0) {
        await insertRowsBatched(tx, ProjectAssetTable, projectAssets);
      }

      const storylines = normalizeRows(graph.storylines, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        name: stringValue(row, 'name'),
        color: stringValue(row, 'color'),
        summary: stringValue(row, 'summary'),
        orderKey: numberValue(row, 'orderKey'),
        contentJson: stringValue(row, 'contentJson', '{}'),
        kvJson: stringValue(row, 'kvJson', '[]'),
        nodeContentTemplateJson: stringValue(row, 'nodeContentTemplateJson', '{}'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
        deletedAt: nullableDateText(row.deletedAt),
      }));
      if (storylines.length > 0) {
        await insertRowsBatched(tx, StorylineTable, storylines);
      }

      const nodes = normalizeRows(graph.nodes, (row) => {
        const rowKind = stringValue(row, 'kind', '');
        const kind = rowKind === 'chapter' ? 'chapter' : 'drift';
        return {
          id: stringValue(row, 'id'),
          projectId: stringValue(row, 'projectId'),
          title: stringValue(row, 'title'),
          summary: stringValue(row, 'summary'),
          bookOrder: row.bookOrder == null ? null : numberValue(row, 'bookOrder'),
          narrativeOrder: row.narrativeOrder == null ? null : numberValue(row, 'narrativeOrder'),
          kind,
          driftGroupId: nullableStringValue(row, 'driftGroupId'),
          positionX: numberValue(row, 'positionX'),
          positionY: numberValue(row, 'positionY'),
          wordCount: numberValue(row, 'wordCount'),
          writingStatus: stringValue(row, 'writingStatus', 'draft'),
          createdAt: dateText(row.createdAt),
          updatedAt: dateText(row.updatedAt),
          deletedAt: nullableDateText(row.deletedAt),
        };
      });
      if (nodes.length > 0) {
        await insertRowsBatched(tx, BookNodeTable, nodes);
      }

      const nodeContents = normalizeRows(graph.nodeContents, (row) => ({
        nodeId: stringValue(row, 'nodeId'),
        contentJson: stringValue(row, 'contentJson', '{}'),
        outlineJson: stringValue(row, 'outlineJson', '[]'),
        plotGridJson: stringValue(row, 'plotGridJson', '{}'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      }));
      if (nodeContents.length > 0) {
        await insertRowsBatched(tx, NodeContentTable, nodeContents);
      }

      // Build a set of category ids that actually live in this hydrate batch.
      // Any element whose categoryId doesn't appear here is an orphan — either
      // because the parent was soft-deleted before the server-side detach
      // landed, or because the row is just stale. Detach to NULL ("未分类")
      // rather than blowing up the whole pull with a FK constraint error.
      const knownCategoryIds = new Set<string>();
      for (const row of graph.elementCategories) {
        const id = stringValue(row, 'id');
        if (id) knownCategoryIds.add(id);
      }
      const elements = normalizeRows(graph.elements, (row) => {
        const rawCategoryId = nullableStringValue(row, 'categoryId');
        const categoryId =
          rawCategoryId && knownCategoryIds.has(rawCategoryId) ? rawCategoryId : null;
        return {
          id: stringValue(row, 'id'),
          projectId: stringValue(row, 'projectId'),
          categoryId,
          name: stringValue(row, 'name'),
          summary: stringValue(row, 'summary'),
          contentJson: stringValue(row, 'contentJson', '{}'),
          kvJson: stringValue(row, 'kvJson', '[]'),
          // Server may not yet send aliasesJson — default to '[]' so the
          // not-null column constraint is satisfied. Server-side migration
          // will follow this client one; pre-migration server omits the field.
          aliasesJson: stringValue(row, 'aliasesJson', '[]'),
          groupName: nullableStringValue(row, 'groupName'),
          portraitAssetId: nullableStringValue(row, 'portraitAssetId'),
          createdAt: dateText(row.createdAt),
          updatedAt: dateText(row.updatedAt),
          deletedAt: nullableDateText(row.deletedAt),
        };
      });
      if (elements.length > 0) {
        await insertRowsBatched(tx, BookElementTable, elements);
      }

      const nodeStorylineLinks = normalizeRows(graph.nodeStorylineLinks, (row) => ({
        nodeId: stringValue(row, 'nodeId'),
        storylineId: stringValue(row, 'storylineId'),
        isPrimary: Boolean((row as Record<string, unknown>).isPrimary),
      })).filter((row) => row.nodeId && row.storylineId);
      if (nodeStorylineLinks.length > 0) {
        await insertRowsBatched(tx, NodeStorylineLinkTable, nodeStorylineLinks);
      }

      const entityRelations = normalizeRows(graph.entityRelations, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        fromKind: stringValue(row, 'fromKind'),
        fromId: stringValue(row, 'fromId'),
        toKind: stringValue(row, 'toKind'),
        toId: stringValue(row, 'toId'),
        relationTypeId: projectedRelationTypes.relationTypeIdFor(row),
        kind: nullableStringValue(row, 'kind'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.fromId && row.toId);
      if (entityRelations.length > 0) {
        await insertRowsBatched(tx, EntityRelationTable, entityRelations);
      }

      // Restore any local relations the server didn't return — typically created
      // offline and not yet flushed. Identity is (from, to, kind).
      if (localEntityRelations.length > 0) {
        const currentRelations = await tx
          .select({
            fromKind: EntityRelationTable.fromKind,
            fromId: EntityRelationTable.fromId,
            toKind: EntityRelationTable.toKind,
            toId: EntityRelationTable.toId,
            kind: EntityRelationTable.kind,
            relationTypeId: EntityRelationTable.relationTypeId,
          })
          .from(EntityRelationTable)
          .where(eq(EntityRelationTable.projectId, projectId));
        const currentKeys = new Set(currentRelations.map(entityRelationKey));
        const relationsToRestore = localEntityRelations.filter(
          (row) => !currentKeys.has(entityRelationKey(row)),
        );
        if (relationsToRestore.length > 0) {
          await insertRowsBatched(tx, EntityRelationTable, relationsToRestore, {
            onConflictDoNothing: true,
          });
        }
      }

      // Inline mentions are a derived index; insert what the server has, but
      // they'll be rebuilt locally from doc content by
      // rebuildProjectInlineReferenceIndex right after this transaction.
      const inlineMentions = normalizeRows(graph.inlineMentions, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        fromKind: stringValue(row, 'fromKind'),
        fromId: stringValue(row, 'fromId'),
        fromBlockId: stringValue(row, 'fromBlockId'),
        fromSpansJson: stringValue(row, 'fromSpansJson'),
        toKind: stringValue(row, 'toKind'),
        toId: stringValue(row, 'toId'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.fromId && row.toId && row.fromBlockId && row.fromSpansJson);
      if (inlineMentions.length > 0) {
        await insertRowsBatched(tx, InlineMentionTable, inlineMentions);
      }

      // ElementPatch rows are owned by their element; they were cascade-deleted
      // by the BookElement wipe above, so a fresh insert from the payload is safe.
      const entityPatches = normalizeRows(graph.entityPatches, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        elementId: stringValue(row, 'elementId'),
        sourceNodeId: nullableStringValue(row, 'sourceNodeId'),
        sourceBlockId: nullableStringValue(row, 'sourceBlockId'),
        sourceBlockText: nullableStringValue(row, 'sourceBlockText'),
        textAnchorJson: nullableStringValue(row, 'textAnchorJson'),
        invalidatedAt: nullableStringValue(row, 'invalidatedAt'),
        title: nullableStringValue(row, 'title'),
        contentJson: stringValue(row, 'contentJson', '{}'),
        orderKey: numberValue(row, 'orderKey', 0),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.elementId);
      if (entityPatches.length > 0) {
        await insertRowsBatched(tx, ElementPatchTable, entityPatches);
      }

      // Restore only patches protected by an unfinished durable mutation, gated
      // on (a) the patch's elementId still existing post-hydrate (FK validity)
      // and (b) the patch id not already inserted from the server payload
      // (server is canonical when there's a collision). Same defensive pattern
      // as localEntityRelations above. Once patches get a complete sync helper,
      // the server can simply win and a remote deletion remains deleted.
      if (localPatches.length > 0) {
        const survivingElementIds = new Set(elements.map((e) => e.id));
        const serverPatchIds = new Set(entityPatches.map((p) => p.id));
        const patchesToRestore = localPatches.filter(
          (p) => survivingElementIds.has(p.elementId) && !serverPatchIds.has(p.id),
        );
        if (patchesToRestore.length > 0) {
          await insertRowsBatched(tx, ElementPatchTable, patchesToRestore, {
            onConflictDoNothing: true,
          });
        }
      }

      // Block sections — cascade-deleted when BookNode was wiped above.
      // Insert server-canonical rows first, then restore any local-only ones
      // pinned to surviving chapters (same defensive pattern as patches).
      const serverBlockSections = normalizeRows(graph.blockSections ?? [], (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        chapterId: stringValue(row, 'chapterId'),
        blockIdsJson: stringValue(row, 'blockIdsJson', '[]'),
        blockHashesJson: stringValue(row, 'blockHashesJson', '{}'),
        summary: stringValue(row, 'summary'),
        source: stringValue(row, 'source', 'copilot-rolling') || 'copilot-rolling',
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.chapterId);
      if (serverBlockSections.length > 0) {
        await insertRowsBatched(tx, BlockSectionTable, serverBlockSections);
      }
      if (localBlockSections.length > 0) {
        const survivingChapterIds = new Set(nodes.map((n) => n.id));
        const serverSectionIds = new Set(serverBlockSections.map((s) => s.id));
        const sectionsToRestore = localBlockSections.filter(
          (s) => survivingChapterIds.has(s.chapterId) && !serverSectionIds.has(s.id),
        );
        if (sectionsToRestore.length > 0) {
          await insertRowsBatched(tx, BlockSectionTable, sectionsToRestore, {
            onConflictDoNothing: true,
          });
        }
      }

      const libraryItems = normalizeRows(deviceSafeGraph.libraryItems, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        title: stringValue(row, 'title'),
        kind: stringValue(row, 'kind'),
        source: stringValue(row, 'source', 'local') || 'local',
        uri: stringValue(row, 'uri'),
        localPath: nullableStringValue(row, 'localPath'),
        assetId: nullableStringValue(row, 'assetId'),
        mime: nullableStringValue(row, 'mime'),
        sizeBytes:
          typeof row.sizeBytes === 'number' && Number.isFinite(row.sizeBytes)
            ? (row.sizeBytes as number)
            : null,
        bodyJson: nullableStringValue(row, 'bodyJson'),
        notesJson: nullableStringValue(row, 'notesJson'),
        thumbnailUri: nullableStringValue(row, 'thumbnailUri'),
        orderKey: numberValue(row, 'orderKey'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.kind);
      if (libraryItems.length > 0) {
        await insertRowsBatched(tx, LibraryItemTable, libraryItems);
      }

      const comments = normalizeRows(graph.comments, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        kind: stringValue(row, 'kind', 'note') || 'note',
        targetKind: nullableStringValue(row, 'targetKind'),
        targetId: nullableStringValue(row, 'targetId'),
        targetBlockId: nullableStringValue(row, 'targetBlockId'),
        anchorJson: stringValue(row, 'anchorJson', '{}'),
        authorKind: stringValue(row, 'authorKind', 'user') || 'user',
        authorId: nullableStringValue(row, 'authorId'),
        authorName: nullableStringValue(row, 'authorName'),
        bodyJson: stringValue(row, 'bodyJson', '{}'),
        status: stringValue(row, 'status', 'open') || 'open',
        priority: nullableStringValue(row, 'priority'),
        source: stringValue(row, 'source', 'manual') || 'manual',
        metadataJson: nullableStringValue(row, 'metadataJson'),
        targetBlockIdsJson: stringValue(row, 'targetBlockIdsJson', '[]'),
        resolvedAt: nullableStringValue(row, 'resolvedAt'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id);
      if (comments.length > 0) {
        await insertRowsBatched(tx, CommentTable, comments);
      }

      const commentActions = normalizeRows(graph.commentActions, (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        commentId: stringValue(row, 'commentId'),
        kind: stringValue(row, 'kind'),
        label: nullableStringValue(row, 'label'),
        payloadJson: stringValue(row, 'payloadJson', '{}'),
        status: stringValue(row, 'status', 'pending') || 'pending',
        resultJson: nullableStringValue(row, 'resultJson'),
        createdByKind: stringValue(row, 'createdByKind', 'user') || 'user',
        createdById: nullableStringValue(row, 'createdById'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
        appliedAt: nullableStringValue(row, 'appliedAt'),
      })).filter((row) => row.id && row.commentId && row.kind);
      if (commentActions.length > 0) {
        await insertRowsBatched(tx, CommentActionTable, commentActions);
      }

      // Agent memories — author-level standing guidance. Simple delete+insert like
      // comments; rollout-safe because a push to a server lacking the route 404s
      // and stays unflushed, and the unflushed-mutation guard skips hydrate entirely.
      const agentMemories = normalizeRows(graph.agentMemories ?? [], (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        kind: stringValue(row, 'kind', 'preference') || 'preference',
        body: stringValue(row, 'body'),
        targetKind: nullableStringValue(row, 'targetKind'),
        targetId: nullableStringValue(row, 'targetId'),
        targetBlockId: nullableStringValue(row, 'targetBlockId'),
        source: stringValue(row, 'source', 'agent') || 'agent',
        originRef: nullableStringValue(row, 'originRef'),
        status: stringValue(row, 'status', 'pending') || 'pending',
        supersedesId: nullableStringValue(row, 'supersedesId'),
        deletedAt: nullableStringValue(row, 'deletedAt'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.projectId);
      if (agentMemories.length > 0) {
        await insertRowsBatched(tx, AgentMemoryTable, agentMemories);
      }

      const workingMemorySource =
        graph.agentWorkingMemory && typeof graph.agentWorkingMemory === 'object'
          ? (graph.agentWorkingMemory as Record<string, unknown>)
          : null;
      if (workingMemorySource) {
        const workingMemory = {
          projectId: stringValue(workingMemorySource, 'projectId'),
          contentMd: stringValue(workingMemorySource, 'contentMd'),
          revision: numberValue(workingMemorySource, 'revision'),
          approxTokens: numberValue(workingMemorySource, 'approxTokens'),
          updatedBy: stringValue(workingMemorySource, 'updatedBy', 'agent') || 'agent',
          lastCompactedAt: nullableStringValue(workingMemorySource, 'lastCompactedAt'),
          deletedAt: nullableStringValue(workingMemorySource, 'deletedAt'),
          createdAt: dateText(workingMemorySource.createdAt),
          updatedAt: dateText(workingMemorySource.updatedAt),
        };
        if (workingMemory.projectId) {
          await tx.insert(AgentWorkingMemoryTable).values(workingMemory);
        }
      }

      // Acts + timeline markers — wipe-and-reinsert like agentMemory; both have
      // sync helpers from day one, and the unflushed-mutation guard skips
      // hydrate when local writes haven't shipped, so no preserve pass needed.
      // Markers go after the BookNode insert above (drift_node_id reference).
      const survivingNodeIds = new Set(nodes.map((n) => n.id));
      const bookActs = normalizeRows(graph.bookActs ?? [], (row) => {
        const driftNodeId = nullableStringValue(row, 'driftNodeId');
        return {
          id: stringValue(row, 'id'),
          projectId: stringValue(row, 'projectId'),
          name: stringValue(row, 'name'),
          color: nullableStringValue(row, 'color'),
          startOrder: nullableNumberValue(row, 'startOrder'),
          driftNodeId: driftNodeId && survivingNodeIds.has(driftNodeId) ? driftNodeId : null,
          createdAt: dateText(row.createdAt),
          updatedAt: dateText(row.updatedAt),
        };
      }).filter((row) => row.id && row.projectId);
      if (bookActs.length > 0) {
        await insertRowsBatched(tx, BookActTable, bookActs);
      }

      // Drift groups — wipe-and-reinsert like acts. Plain nested folders; the
      // book_node.drift_group_id pointer is a plain column (no enforced FK), so
      // insert order vs nodes doesn't matter.
      const driftGroups = normalizeRows(graph.driftGroups ?? [], (row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        name: stringValue(row, 'name'),
        parentGroupId: nullableStringValue(row, 'parentGroupId'),
        color: nullableStringValue(row, 'color'),
        sortOrder: nullableNumberValue(row, 'sortOrder'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      })).filter((row) => row.id && row.projectId);
      if (driftGroups.length > 0) {
        await insertRowsBatched(tx, DriftGroupTable, driftGroups);
      }

      const timelineMarkers = normalizeRows(graph.timelineMarkers ?? [], (row) => {
        const driftNodeId = nullableStringValue(row, 'driftNodeId');
        return {
          id: stringValue(row, 'id'),
          projectId: stringValue(row, 'projectId'),
          narrativeOrder: numberValue(row, 'narrativeOrder'),
          label: stringValue(row, 'label'),
          // Detach bindings whose drift didn't survive the hydrate (stale row).
          driftNodeId: driftNodeId && survivingNodeIds.has(driftNodeId) ? driftNodeId : null,
          createdAt: dateText(row.createdAt),
          updatedAt: dateText(row.updatedAt),
        };
      }).filter((row) => row.id && row.projectId);
      if (timelineMarkers.length > 0) {
        await insertRowsBatched(tx, TimelineMarkerTable, timelineMarkers);
      }
    },
    apply: () => applyGraphToStores(deviceSafeGraph),
  });
}

export async function pullAndHydrateProjectGraph(
  projectId: string,
): Promise<ProjectGraphPayload | null> {
  if (!isSyncEnabled()) return null;

  // Capture before the first await. Every local write that starts while this
  // pull is draining the outbox, checking it, or fetching the graph must make
  // the eventual response ineligible for destructive hydration.
  const pullGeneration = localMutationGeneration.current(projectId);

  // Try to drain the outbox first. If anything is still queued after the
  // flush attempt, hydrate would destructively overwrite that work, so we
  // refuse and let the flush retry on its own schedule.
  await forceFlush();

  const pendingForProject = await countPendingMutations(projectId);
  if (pendingForProject > 0) {
    log.warn(
      `[sync] skipping hydrate of ${projectId}: ${pendingForProject} unflushed local mutations`,
    );
    setStatus('error', `${pendingForProject} pending local mutations`);
    return null;
  }

  setStatus('pulling');
  const requestId = createRequestId(`crud:hydrate:${projectId}`);
  const deviceId = getDeviceId();
  const startedAt = nowMs();

  emitSyncOperation({
    requestId,
    kind: 'crud',
    phase: 'pull',
    state: 'started',
    operation: 'pull',
    method: 'GET',
    endpoint: `/api/projects/${projectId}/graph`,
    entityType: 'project',
    entityId: projectId,
    projectId,
    deviceId,
  });

  try {
    const response = await apiClient.get<ProjectGraphPayload>(`/api/projects/${projectId}/graph`);
    const hydrated = await hydrateProjectGraph(response.data, pullGeneration);
    if (!hydrated) {
      log.info(`[sync] skipped stale graph response for ${projectId}: local mutation raced pull`);
      setStatus('idle');
      return null;
    }
    await rebuildProjectInlineReferenceIndex(projectId).catch((error) => {
      log.warn('[sync] reference index rebuild after hydrate failed:', error);
    });
    const resourceCount =
      response.data.nodes.length +
      response.data.nodeContents.length +
      response.data.storylines.length +
      response.data.nodeStorylineLinks.length +
      response.data.elements.length +
      response.data.elementCategories.length +
      (response.data.projectAssets?.length ?? 0) +
      response.data.entityRelations.length +
      (response.data.entityRelationTypes?.length ?? 0) +
      response.data.inlineMentions.length +
      response.data.entityPatches.length +
      (response.data.blockSections?.length ?? 0) +
      response.data.libraryItems.length +
      response.data.comments.length +
      response.data.commentActions.length;

    setStatus('idle');
    emitSyncOperation({
      requestId,
      kind: 'crud',
      phase: 'pull',
      state: 'succeeded',
      operation: 'pull',
      method: 'GET',
      endpoint: `/api/projects/${projectId}/graph`,
      entityType: 'project',
      entityId: projectId,
      projectId,
      deviceId,
      resourceCount,
      durationMs: nowMs() - startedAt,
    });
    // hydrateProjectGraph applied the device-local overlay to SQLite/store.
    // Do the same for the raw pull result so callers cannot accidentally
    // consume a localPath supplied by the server.
    const localLibraryItems = useDataStore.getState().libraryItems;
    return {
      ...response.data,
      libraryItems: overlayLibraryItemDeviceFields(response.data.libraryItems, localLibraryItems),
    };
  } catch (error) {
    setStatus('error', 'hydrate failed');
    emitSyncOperation({
      requestId,
      kind: 'crud',
      phase: 'pull',
      state: 'failed',
      operation: 'pull',
      method: 'GET',
      endpoint: `/api/projects/${projectId}/graph`,
      entityType: 'project',
      entityId: projectId,
      projectId,
      deviceId,
      durationMs: nowMs() - startedAt,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

// ==================== Lifecycle ====================

/**
 * Start periodic pull for a project.
 */
export function startPeriodicPull(projectId: string, onData: (data: PullResult) => void): void {
  stopPeriodicPull();
  if (!isSyncEnabled()) return;

  // Initial pull
  void pullAndHydrateProjectGraph(projectId).then((graph) => {
    if (!graph) return;
    onData({
      nodes: graph.nodes,
      storylines: graph.storylines,
      elements: graph.elements,
      categories: graph.elementCategories,
    });
  });

  pullTimer = setInterval(() => {
    void pullAndHydrateProjectGraph(projectId).then((graph) => {
      if (!graph) return;
      onData({
        nodes: graph.nodes,
        storylines: graph.storylines,
        elements: graph.elements,
        categories: graph.elementCategories,
      });
    });
  }, PULL_INTERVAL_MS);
}

export function stopPeriodicPull(): void {
  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
}

/**
 * Force flush any pending mutations.
 */
export async function forceFlush(): Promise<void> {
  await flushPendingEntityPersistence();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // A scheduled/background flush may already own the singleton queue. Wait for
  // it, then run once more so mutations enqueued during that cycle are included
  // in the force-flush contract used by quit and account-wide export.
  while (flushInProgress) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  await flushPushQueue();
  while (flushInProgress) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Get count of pending mutations.
 */
export function getPendingCount(): number {
  void refreshPendingCount().catch(() => {});
  return pendingCountCache;
}
