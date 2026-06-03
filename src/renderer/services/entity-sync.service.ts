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
 * - Push: After each local write, enqueue an entity mutation.
 *   A debounced flush sends batched mutations to the server.
 * - Pull: On project load and periodically, fetch all entities
 *   from the server and reconcile with local state (server wins on conflict).
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { apiClient } from '../lib/axios-config';
import { APP_CONFIG, isSyncEnabled } from '../lib/config';
import { getDb } from '../lib/db';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import {
  BlockSectionTable,
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  ElementCategoryTable,
  ElementPatchTable,
  EntityRelationTable,
  InlineMentionTable,
  LocalSyncMutationTable,
  CommentTable,
  LibraryItemTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
} from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import type { BookNode, ChapterWritingStatus, DriftStatus } from '../domain/book-node';
import { decodeAliases } from '../domain/book-element';
import { decodeBlockHashes, decodeBlockIds } from '../domain/block-section';
import type { BlockSectionSource } from '../domain/block-section';
import { createElementPatchRepository } from '../sqlite-repo/element-patch-repo';
import { createBlockSectionRepository } from '../sqlite-repo/block-section-repo';
import { rebuildProjectInlineReferenceIndex } from './reference-index.service';
import loglevel from 'loglevel';

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
  | 'comment'
  | 'commentAction';

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

const FLUSH_DELAY_MS = 800;
const PULL_INTERVAL_MS = 30_000;
const OUTBOX_BATCH_SIZE = 50;

type MutationRequest = {
  method: SyncOperationEvent['method'];
  endpoint: string;
  data?: Record<string, unknown>;
};

type LocalSyncMutationRow = typeof LocalSyncMutationTable.$inferSelect;

export interface ProjectGraphPayload {
  project: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  nodeContents: Record<string, unknown>[];
  storylines: Record<string, unknown>[];
  nodeStorylineLinks: Record<string, unknown>[];
  elements: Record<string, unknown>[];
  elementCategories: Record<string, unknown>[];
  entityRelations: Record<string, unknown>[];
  inlineMentions: Record<string, unknown>[];
  entityPatches: Record<string, unknown>[];
  blockSections: Record<string, unknown>[];
  libraryItems: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  commentActions: Record<string, unknown>[];
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
  const rows = await getDb()
    .select({ id: LocalSyncMutationTable.id })
    .from(LocalSyncMutationTable)
    .where(eq(LocalSyncMutationTable.status, 'pending'));
  pendingCountCache = rows.length;
}

function registerOnlineFlush(): void {
  if (onlineFlushRegistered || typeof window === 'undefined') return;
  onlineFlushRegistered = true;
  window.addEventListener('online', () => {
    scheduleFlush();
  });
}

function sameOptionalId(a: string | null, b?: string): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

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
 * Enqueue a local mutation for background push to server.
 * Call this from usecase hooks after writing to local SQLite.
 */
export function enqueueSyncMutation(mutation: SyncMutation): void {
  if (!shouldPersistOutbox()) return;
  registerOnlineFlush();

  void persistSyncMutation(mutation)
    .then(() => {
      scheduleFlush();
    })
    .catch((error) => {
      log.error('[sync] failed to persist mutation:', error);
    });
}

function scheduleFlush() {
  if (flushTimer || !isSyncEnabled()) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPushQueue();
  }, FLUSH_DELAY_MS);
}

async function persistSyncMutation(mutation: SyncMutation): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const candidates = await db
    .select()
    .from(LocalSyncMutationTable)
    .where(
      and(
        eq(LocalSyncMutationTable.status, 'pending'),
        eq(LocalSyncMutationTable.entityType, mutation.entityType),
        eq(LocalSyncMutationTable.entityId, mutation.entityId),
        eq(LocalSyncMutationTable.mutationType, mutation.mutationType),
      ),
    )
    .orderBy(desc(LocalSyncMutationTable.id))
    .limit(20);

  const existing = candidates.find((row) => sameOptionalId(row.parentId, mutation.parentId));
  if (existing) {
    await db
      .update(LocalSyncMutationTable)
      .set({
        projectId: mutation.projectId,
        parentId: mutation.parentId ?? null,
        payloadJson: serializePayload(mutation.payload),
        mutationTs: mutation.timestamp,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(LocalSyncMutationTable.id, existing.id));
  } else {
    await db.insert(LocalSyncMutationTable).values({
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

  await refreshPendingCount();
}

async function flushPushQueue(): Promise<void> {
  if (!isSyncEnabled() || flushInProgress) return;
  flushInProgress = true;

  try {
    const db = getDb();
    await db
      .update(LocalSyncMutationTable)
      .set({ status: 'pending', updatedAt: new Date().toISOString() })
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
    if (pendingCountCache > 0) {
      setStatus('error', `${pendingCountCache} pending`);
      scheduleFlush();
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
        return { method: 'POST', endpoint: `/api/projects/${projectId}/nodes`, data: payload };
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
        return { method: 'POST', endpoint: `/api/projects/${projectId}/library`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/library/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/library/${entityId}` };

    // ---- Entity Relation (user-curated cross-entity link) ----
    case 'entityRelation':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/relations`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/relations/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/relations/${entityId}` };

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
    // Self-heal "orphan local row" case: a PATCH/DELETE on a row the server
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

function isMissingRemoteError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null | undefined)?.response?.status;
  return status === 404;
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
      log.info(
        `[sync] recovered orphan elementPatch ${m.entityId} via POST (was 404 on PATCH)`,
      );
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
      log.info(
        `[sync] recovered orphan blockSection ${m.entityId} via POST (was 404 on PATCH)`,
      );
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
  inlineMentions?: unknown[];
  entityPatches?: unknown[];
  blockSections?: unknown[];
  libraryItems?: unknown[];
  comments?: unknown[];
  commentActions?: unknown[];
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
    inlineMentions: graph.inlineMentions,
    entityPatches: graph.entityPatches,
    blockSections: graph.blockSections,
    libraryItems: graph.libraryItems,
    comments: graph.comments,
    commentActions: graph.commentActions,
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

function applyGraphToStores(graph: ProjectGraphPayload): void {
  // Soft-deleted rows still ride along in the pulled graph — the server returns
  // them so the trash view + restore can work. The live in-memory stores must
  // only ever hold non-deleted entities; otherwise a just-trashed storyline /
  // chapter / element reappears on the next pull. Filter them out here. SQLite
  // keeps the rows (with deletedAt) for the trash panel — see the hydrate below.
  const liveStorylines = graph.storylines.filter((row) => !isDeleted(row));
  const liveNodes = graph.nodes.filter((row) => !isDeleted(row));
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
      layoutMode: (stringValue(row, 'layoutMode', 'auto') === 'pinned'
        ? 'pinned'
        : 'auto') as 'auto' | 'pinned',
      gridX: nullableNumberValue(row, 'gridX'),
      gridY: nullableNumberValue(row, 'gridY'),
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
      kind: (stringValue(row, 'kind') === 'markdown'
        ? 'text'
        : (stringValue(row, 'kind') as 'image' | 'pdf' | 'url' | 'text')),
      source: (stringValue(row, 'source', 'local') || 'local') as 'local' | 'url',
      uri: stringValue(row, 'uri'),
      localPath: nullableStringValue(row, 'localPath'),
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
  dataStore.setEntityRelations(
    graph.entityRelations.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      fromKind: stringValue(row, 'fromKind') as any,
      fromId: stringValue(row, 'fromId'),
      toKind: stringValue(row, 'toKind') as any,
      toId: stringValue(row, 'toId'),
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

interface EntityRelationKeyInput {
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  kind: string | null;
}

function entityRelationKey(row: EntityRelationKeyInput): string {
  // Distinct (from, to, kind) is the user-meaningful relation identity — same
  // pair can carry multiple `kind` values as distinct rows.
  return `${row.fromKind}:${row.fromId}->${row.toKind}:${row.toId}:${row.kind ?? ''}`;
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

export async function hydrateProjectGraph(graph: ProjectGraphPayload): Promise<void> {
  const projectId = stringValue(graph.project, 'id');
  if (!projectId) throw new Error('Cannot hydrate project graph without project.id');

  const db = getDb();

  await db.transaction(async (tx) => {
    // Stash all local entity_relation rows so we can re-insert any that the
    // server-side payload missed. Inline mentions aren't preserved — they're
    // a pure projection of doc content and will be rebuilt after hydrate.
    const localEntityRelations = await tx
      .select()
      .from(EntityRelationTable)
      .where(eq(EntityRelationTable.projectId, projectId));

    // Same treatment for element_patch rows. Patches don't have a single-row
    // sync helper yet (see usecase/sync-helpers.ts — no syncElementPatch*),
    // so any patch created locally exists ONLY on this device. Without this
    // snapshot, the BookElement wipe below would cascade-delete every
    // local-only patch and the post-wipe entityPatches insert (sourced from
    // the server graph) would not bring them back — they'd vanish silently.
    // We restore them after the canonical insert, gated on elementId still
    // existing (so the FK is valid).
    const localPatches = await tx
      .select()
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.projectId, projectId));

    // BlockSection follows the same preserve-on-hydrate pattern as
    // ElementPatch. Server is rolling out the table progressively, and
    // signature-invalidation logic lives on the client — losing a local row
    // costs a re-summarize call but the section itself shouldn't disappear
    // just because the server hasn't shipped this entity yet.
    const localBlockSections = await tx
      .select()
      .from(BlockSectionTable)
      .where(eq(BlockSectionTable.projectId, projectId));

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
        .where(
          and(eq(EntityRelationTable.toKind, kind), inArray(EntityRelationTable.toId, ids)),
        );
      await tx
        .delete(InlineMentionTable)
        .where(
          and(eq(InlineMentionTable.fromKind, kind), inArray(InlineMentionTable.fromId, ids)),
        );
      await tx
        .delete(InlineMentionTable)
        .where(
          and(eq(InlineMentionTable.toKind, kind), inArray(InlineMentionTable.toId, ids)),
        );
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
    await tx.delete(BookNodeTable).where(eq(BookNodeTable.projectId, projectId));
    await tx.delete(BookElementTable).where(eq(BookElementTable.projectId, projectId));
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
      await tx.insert(ElementCategoryTable).values(elementCategories as any[]);
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
      await tx.insert(StorylineTable).values(storylines as any[]);
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
      await tx.insert(BookNodeTable).values(nodes as any[]);
    }

    const nodeContents = normalizeRows(graph.nodeContents, (row) => ({
      nodeId: stringValue(row, 'nodeId'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      outlineJson: stringValue(row, 'outlineJson', '[]'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (nodeContents.length > 0) {
      await tx.insert(NodeContentTable).values(nodeContents as any[]);
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
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
        deletedAt: nullableDateText(row.deletedAt),
      };
    });
    if (elements.length > 0) {
      await tx.insert(BookElementTable).values(elements as any[]);
    }

    const nodeStorylineLinks = normalizeRows(graph.nodeStorylineLinks, (row) => ({
      nodeId: stringValue(row, 'nodeId'),
      storylineId: stringValue(row, 'storylineId'),
      isPrimary: Boolean((row as Record<string, unknown>).isPrimary),
    })).filter((row) => row.nodeId && row.storylineId);
    if (nodeStorylineLinks.length > 0) {
      await tx.insert(NodeStorylineLinkTable).values(nodeStorylineLinks as any[]);
    }

    const entityRelations = normalizeRows(graph.entityRelations, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      fromKind: stringValue(row, 'fromKind'),
      fromId: stringValue(row, 'fromId'),
      toKind: stringValue(row, 'toKind'),
      toId: stringValue(row, 'toId'),
      kind: nullableStringValue(row, 'kind'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id && row.fromId && row.toId);
    if (entityRelations.length > 0) {
      await tx.insert(EntityRelationTable).values(entityRelations as any[]);
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
        })
        .from(EntityRelationTable)
        .where(eq(EntityRelationTable.projectId, projectId));
      const currentKeys = new Set(currentRelations.map(entityRelationKey));
      const relationsToRestore = localEntityRelations.filter(
        (row) => !currentKeys.has(entityRelationKey(row)),
      );
      if (relationsToRestore.length > 0) {
        await tx
          .insert(EntityRelationTable)
          .values(relationsToRestore as any[])
          .onConflictDoNothing();
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
    })).filter(
      (row) => row.id && row.fromId && row.toId && row.fromBlockId && row.fromSpansJson,
    );
    if (inlineMentions.length > 0) {
      await tx.insert(InlineMentionTable).values(inlineMentions as any[]);
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
      title: nullableStringValue(row, 'title'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      orderKey: numberValue(row, 'orderKey', 0),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id && row.elementId);
    if (entityPatches.length > 0) {
      await tx.insert(ElementPatchTable).values(entityPatches as any[]);
    }

    // Restore local-only patches that the server didn't send back. Gated on
    // (a) the patch's elementId still existing post-hydrate (FK validity)
    // and (b) the patch id not already inserted from the server payload
    // (server is canonical when there's a collision). Same defensive pattern
    // as localEntityRelations above. Goes away once patches get a real sync
    // helper — see TODO in elementPatchCapability.accept().
    if (localPatches.length > 0) {
      const survivingElementIds = new Set(elements.map((e) => e.id));
      const serverPatchIds = new Set(entityPatches.map((p) => p.id));
      const patchesToRestore = localPatches.filter(
        (p) => survivingElementIds.has(p.elementId) && !serverPatchIds.has(p.id),
      );
      if (patchesToRestore.length > 0) {
        await tx
          .insert(ElementPatchTable)
          .values(patchesToRestore as any[])
          .onConflictDoNothing();
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
      await tx.insert(BlockSectionTable).values(serverBlockSections as any[]);
    }
    if (localBlockSections.length > 0) {
      const survivingChapterIds = new Set(nodes.map((n) => n.id));
      const serverSectionIds = new Set(serverBlockSections.map((s) => s.id));
      const sectionsToRestore = localBlockSections.filter(
        (s) => survivingChapterIds.has(s.chapterId) && !serverSectionIds.has(s.id),
      );
      if (sectionsToRestore.length > 0) {
        await tx
          .insert(BlockSectionTable)
          .values(sectionsToRestore as any[])
          .onConflictDoNothing();
      }
    }

    const libraryItems = normalizeRows(graph.libraryItems, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      title: stringValue(row, 'title'),
      kind: stringValue(row, 'kind'),
      source: stringValue(row, 'source', 'local') || 'local',
      uri: stringValue(row, 'uri'),
      localPath: nullableStringValue(row, 'localPath'),
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
      await tx.insert(LibraryItemTable).values(libraryItems as any[]);
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
      await tx.insert(CommentTable).values(comments as any[]);
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
      await tx.insert(CommentActionTable).values(commentActions as any[]);
    }
  });

  applyGraphToStores(graph);
}

export async function pullAndHydrateProjectGraph(projectId: string): Promise<ProjectGraphPayload | null> {
  if (!isSyncEnabled()) return null;

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
    await hydrateProjectGraph(response.data);
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
      response.data.entityRelations.length +
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
    return response.data;
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
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushPushQueue();
}

/**
 * Get count of pending mutations.
 */
export function getPendingCount(): number {
  void refreshPendingCount().catch(() => {});
  return pendingCountCache;
}
