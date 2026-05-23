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

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { apiClient } from '../lib/axios-config';
import { APP_CONFIG, isSyncEnabled } from '../lib/config';
import { getDb } from '../lib/db';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
import {
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  ElementCategoryTable,
  ElementPatchTable,
  EntityReferenceTable,
  LocalSyncMutationTable,
  ManuscriptCommentTable,
  MaterialTable,
  MemoTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  ProjectTable,
  StorylineTable,
} from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import type { BookNode, ChapterWritingStatus, DriftStatus } from '../domain/book-node';
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
  | 'memo'
  | 'material'
  | 'entityReference'
  | 'manuscriptComment'
  | 'commentAction';

export type MutationType = 'create' | 'update' | 'delete';

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
  entityReferences: Record<string, unknown>[];
  entityPatches: Record<string, unknown>[];
  memos: Record<string, unknown>[];
  materials: Record<string, unknown>[];
  manuscriptComments: Record<string, unknown>[];
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
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/categories/${entityId}` };

    // ---- Memo ----
    case 'memo':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/memos`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/memos/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/memos/${entityId}` };

    // ---- Material ----
    case 'material':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/materials`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/materials/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/materials/${entityId}` };

    // ---- Entity Reference (polymorphic link) ----
    case 'entityReference':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/references`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/references/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/references/${entityId}` };

    // ---- Manuscript Comment ----
    case 'manuscriptComment':
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
    emitSyncOperation({
      ...eventBase,
      state: 'failed',
      durationMs: nowMs() - startedAt,
      error: getErrorMessage(error),
    });
    throw error;
  }
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
  entityReferences?: unknown[];
  entityPatches?: unknown[];
  memos?: unknown[];
  materials?: unknown[];
  manuscriptComments?: unknown[];
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
    entityReferences: graph.entityReferences,
    entityPatches: graph.entityPatches,
    memos: graph.memos,
    materials: graph.materials,
    manuscriptComments: graph.manuscriptComments,
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
  const nodeStorylineLinks = graph.nodeStorylineLinks
    .map((row) => ({
      nodeId: stringValue(row, 'nodeId'),
      storylineId: stringValue(row, 'storylineId'),
    }))
    .filter((row) => row.nodeId && row.storylineId);

  const dataStore = useDataStore.getState();
  dataStore.setStorylines(
    graph.storylines.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      color: stringValue(row, 'color'),
      summary: stringValue(row, 'summary'),
      orderKey: numberValue(row, 'orderKey'),
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
      kvJson: stringValue(row, 'kvJson', '[]'),
      nodeContentTemplateJson: stringValue(row, 'nodeContentTemplateJson', '{}'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setBookNodes(
    graph.nodes.map((row): BookNode => {
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
      const mainStorylineId = nullableStringValue(row, 'mainStorylineId');
      if (mainStorylineId == null) {
        return {
          ...base,
          mainStorylineId: null,
          bookOrder: null,
          writingStatus: stringValue(row, 'writingStatus', 'drifting') as DriftStatus,
        };
      }
      return {
        ...base,
        mainStorylineId,
        bookOrder: row.bookOrder == null ? 0 : numberValue(row, 'bookOrder'),
        writingStatus: stringValue(row, 'writingStatus', 'draft') as ChapterWritingStatus,
      };
    }),
  );
  dataStore.setStorylineNodeMapping(buildStorylineNodeMapping(nodeStorylineLinks));
  dataStore.setBookElementCategories(
    graph.elementCategories.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
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
  dataStore.setBookElements(
    graph.elements.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      categoryId: stringValue(row, 'categoryId'),
      name: stringValue(row, 'name'),
      summary: stringValue(row, 'summary'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      kvJson: stringValue(row, 'kvJson', '[]'),
      groupName: nullableStringValue(row, 'groupName'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setMemos(
    graph.memos.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      title: stringValue(row, 'title'),
      bodyJson: stringValue(row, 'bodyJson', '{}'),
      resolution: (stringValue(row, 'resolution', 'no_action') || 'no_action') as
        | 'no_action'
        | 'unresolved'
        | 'resolved',
      priority: (nullableStringValue(row, 'priority') as 'low' | 'med' | 'high' | null) ?? null,
      dueAt: nullableStringValue(row, 'dueAt'),
      orderKey: numberValue(row, 'orderKey'),
      resolvedAt: nullableStringValue(row, 'resolvedAt'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setMaterials(
    graph.materials.map((row) => ({
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
  dataStore.setManuscriptComments(
    graph.manuscriptComments.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      targetKind: stringValue(row, 'targetKind') as any,
      targetId: stringValue(row, 'targetId'),
      targetBlockId: stringValue(row, 'targetBlockId'),
      anchorJson: stringValue(row, 'anchorJson', '{}'),
      authorKind: (stringValue(row, 'authorKind', 'user') || 'user') as any,
      authorId: nullableStringValue(row, 'authorId'),
      authorName: nullableStringValue(row, 'authorName'),
      bodyJson: stringValue(row, 'bodyJson', '{}'),
      status: (stringValue(row, 'status', 'open') || 'open') as any,
      priority: nullableStringValue(row, 'priority') as any,
      source: (stringValue(row, 'source', 'manual') || 'manual') as any,
      metadataJson: nullableStringValue(row, 'metadataJson'),
      resolvedAt: nullableStringValue(row, 'resolvedAt'),
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
  // Surface manual (whole-to-whole) entity-reference rows so the right sidebar
  // relation picker can render attached chapters / elements / etc. without
  // hitting SQLite. Inline (block-anchored) refs are still indexed separately
  // by the reference-index service.
  dataStore.setManualReferences(
    graph.entityReferences
      .map((row) => ({
        id: stringValue(row, 'id'),
        projectId: stringValue(row, 'projectId'),
        fromKind: stringValue(row, 'fromKind') as any,
        fromId: stringValue(row, 'fromId'),
        fromBlockId: nullableStringValue(row, 'fromBlockId'),
        fromSpansJson: nullableStringValue(row, 'fromSpansJson'),
        toKind: stringValue(row, 'toKind') as any,
        toId: stringValue(row, 'toId'),
        toBlockId: nullableStringValue(row, 'toBlockId'),
        kind: nullableStringValue(row, 'kind'),
        createdAt: dateText(row.createdAt),
        updatedAt: dateText(row.updatedAt),
      }))
      .filter((row) => row.fromBlockId == null),
  );

  const project = {
    id: stringValue(graph.project, 'id'),
    userId: stringValue(graph.project, 'userId'),
    name: stringValue(graph.project, 'name'),
    descriptionJson: stringValue(graph.project, 'descriptionJson', '{}'),
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
    descriptionJson: stringValue(row, 'descriptionJson', '{}'),
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

interface ManualReferenceKeyInput {
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  toBlockId: string | null;
}

function manualReferenceKey(row: ManualReferenceKeyInput): string {
  return `${row.fromKind}:${row.fromId}->${row.toKind}:${row.toId}:${row.toBlockId ?? ''}`;
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
    const localManualReferences = await tx
      .select()
      .from(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.projectId, projectId),
          isNull(EntityReferenceTable.fromBlockId),
        ),
      );

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

    if (oldNodeIds.length > 0) {
      await tx.delete(NodeContentTable).where(inArray(NodeContentTable.nodeId, oldNodeIds));
      await tx.delete(NodeStorylineLinkTable).where(inArray(NodeStorylineLinkTable.nodeId, oldNodeIds));
      // Polymorphic refs: drop any reference whose `from` or `to` was an
      // about-to-be-deleted node. We can't express the from/to OR via inArray
      // in a single delete, so issue two deletes.
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.fromKind, 'node'),
            inArray(EntityReferenceTable.fromId, oldNodeIds),
          ),
        );
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.toKind, 'node'),
            inArray(EntityReferenceTable.toId, oldNodeIds),
          ),
        );
      // ElementPatch.sourceNodeId is ON DELETE SET NULL — letting the BookNode
      // deletion below cascade is enough; rows themselves are owned by elements
      // and will be cleared when those cascade.
    }
    if (oldElementIds.length > 0) {
      // Polymorphic refs touching the elements being deleted (either side).
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.fromKind, 'element'),
            inArray(EntityReferenceTable.fromId, oldElementIds),
          ),
        );
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.toKind, 'element'),
            inArray(EntityReferenceTable.toId, oldElementIds),
          ),
        );
    }
    if (oldStorylineIds.length > 0) {
      await tx
        .delete(NodeStorylineLinkTable)
        .where(inArray(NodeStorylineLinkTable.storylineId, oldStorylineIds));
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.fromKind, 'storyline'),
            inArray(EntityReferenceTable.fromId, oldStorylineIds),
          ),
        );
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.toKind, 'storyline'),
            inArray(EntityReferenceTable.toId, oldStorylineIds),
          ),
        );
    }
    if (oldCategoryIds.length > 0) {
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.fromKind, 'category'),
            inArray(EntityReferenceTable.fromId, oldCategoryIds),
          ),
        );
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.toKind, 'category'),
            inArray(EntityReferenceTable.toId, oldCategoryIds),
          ),
        );
    }

    // Memos and materials are project-scoped; wipe and reinsert from the payload.
    // Their polymorphic entity_reference rows are dropped here too — server is
    // the source of truth for memo/material relations.
    await tx
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.projectId, projectId),
          eq(EntityReferenceTable.fromKind, 'memo'),
        ),
      );
    await tx
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.projectId, projectId),
          eq(EntityReferenceTable.toKind, 'memo'),
        ),
      );
    await tx
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.projectId, projectId),
          eq(EntityReferenceTable.fromKind, 'material'),
        ),
      );
    await tx
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.projectId, projectId),
          eq(EntityReferenceTable.toKind, 'material'),
        ),
      );
    await tx.delete(MemoTable).where(eq(MemoTable.projectId, projectId));
    await tx.delete(MaterialTable).where(eq(MaterialTable.projectId, projectId));
    await tx.delete(CommentActionTable).where(eq(CommentActionTable.projectId, projectId));
    await tx.delete(ManuscriptCommentTable).where(eq(ManuscriptCommentTable.projectId, projectId));
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
          descriptionJson: project.descriptionJson,
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
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
      elementTemplateJson: stringValue(row, 'elementTemplateJson', '{}'),
      elementTemplateKvJson: stringValue(row, 'elementTemplateKvJson', '[]'),
      color: stringValue(row, 'color'),
      layoutMode: stringValue(row, 'layoutMode', 'auto') || 'auto',
      gridX: nullableNumberValue(row, 'gridX'),
      gridY: nullableNumberValue(row, 'gridY'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
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
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
      kvJson: stringValue(row, 'kvJson', '[]'),
      nodeContentTemplateJson: stringValue(row, 'nodeContentTemplateJson', '{}'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (storylines.length > 0) {
      await tx.insert(StorylineTable).values(storylines as any[]);
    }

    const nodes = normalizeRows(graph.nodes, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      title: stringValue(row, 'title'),
      summary: stringValue(row, 'summary'),
      bookOrder: row.bookOrder == null ? null : numberValue(row, 'bookOrder'),
      narrativeOrder: row.narrativeOrder == null ? null : numberValue(row, 'narrativeOrder'),
      mainStorylineId: nullableStringValue(row, 'mainStorylineId'),
      positionX: numberValue(row, 'positionX'),
      positionY: numberValue(row, 'positionY'),
      wordCount: numberValue(row, 'wordCount'),
      writingStatus: stringValue(row, 'writingStatus', 'draft'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
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

    const elements = normalizeRows(graph.elements, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      categoryId: stringValue(row, 'categoryId'),
      name: stringValue(row, 'name'),
      summary: stringValue(row, 'summary'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      kvJson: stringValue(row, 'kvJson', '[]'),
      groupName: nullableStringValue(row, 'groupName'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (elements.length > 0) {
      await tx.insert(BookElementTable).values(elements as any[]);
    }

    const nodeStorylineLinks = normalizeRows(graph.nodeStorylineLinks, (row) => ({
      nodeId: stringValue(row, 'nodeId'),
      storylineId: stringValue(row, 'storylineId'),
    })).filter((row) => row.nodeId && row.storylineId);
    if (nodeStorylineLinks.length > 0) {
      await tx.insert(NodeStorylineLinkTable).values(nodeStorylineLinks as any[]);
    }

    const entityReferences = normalizeRows(graph.entityReferences, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      fromKind: stringValue(row, 'fromKind'),
      fromId: stringValue(row, 'fromId'),
      fromBlockId: nullableStringValue(row, 'fromBlockId'),
      fromSpansJson: nullableStringValue(row, 'fromSpansJson'),
      toKind: stringValue(row, 'toKind'),
      toId: stringValue(row, 'toId'),
      toBlockId: nullableStringValue(row, 'toBlockId'),
      kind: nullableStringValue(row, 'kind'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id && row.fromId && row.toId);
    if (entityReferences.length > 0) {
      await tx.insert(EntityReferenceTable).values(entityReferences as any[]);
    }

    if (localManualReferences.length > 0) {
      const currentManualReferences = await tx
        .select({
          fromKind: EntityReferenceTable.fromKind,
          fromId: EntityReferenceTable.fromId,
          toKind: EntityReferenceTable.toKind,
          toId: EntityReferenceTable.toId,
          toBlockId: EntityReferenceTable.toBlockId,
        })
        .from(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.projectId, projectId),
            isNull(EntityReferenceTable.fromBlockId),
          ),
        );
      const currentManualKeys = new Set(currentManualReferences.map(manualReferenceKey));
      const manualReferencesToRestore = localManualReferences.filter(
        (row) => !currentManualKeys.has(manualReferenceKey(row)),
      );
      if (manualReferencesToRestore.length > 0) {
        await tx
          .insert(EntityReferenceTable)
          .values(manualReferencesToRestore as any[])
          .onConflictDoNothing();
      }
    }

    // ElementPatch rows are owned by their element; they were cascade-deleted
    // by the BookElement wipe above, so a fresh insert from the payload is safe.
    const entityPatches = normalizeRows(graph.entityPatches, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      elementId: stringValue(row, 'elementId'),
      sourceNodeId: nullableStringValue(row, 'sourceNodeId'),
      sourceBlockId: nullableStringValue(row, 'sourceBlockId'),
      title: nullableStringValue(row, 'title'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      orderKey: numberValue(row, 'orderKey', 0),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id && row.elementId);
    if (entityPatches.length > 0) {
      await tx.insert(ElementPatchTable).values(entityPatches as any[]);
    }

    const memos = normalizeRows(graph.memos, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      title: stringValue(row, 'title'),
      bodyJson: stringValue(row, 'bodyJson', '{}'),
      resolution: stringValue(row, 'resolution', 'no_action') || 'no_action',
      priority: nullableStringValue(row, 'priority'),
      dueAt: nullableStringValue(row, 'dueAt'),
      orderKey: numberValue(row, 'orderKey'),
      resolvedAt: nullableStringValue(row, 'resolvedAt'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id);
    if (memos.length > 0) {
      await tx.insert(MemoTable).values(memos as any[]);
    }

    const materials = normalizeRows(graph.materials, (row) => ({
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
    if (materials.length > 0) {
      await tx.insert(MaterialTable).values(materials as any[]);
    }

    const manuscriptComments = normalizeRows(graph.manuscriptComments, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      targetKind: stringValue(row, 'targetKind'),
      targetId: stringValue(row, 'targetId'),
      targetBlockId: stringValue(row, 'targetBlockId'),
      anchorJson: stringValue(row, 'anchorJson', '{}'),
      authorKind: stringValue(row, 'authorKind', 'user') || 'user',
      authorId: nullableStringValue(row, 'authorId'),
      authorName: nullableStringValue(row, 'authorName'),
      bodyJson: stringValue(row, 'bodyJson', '{}'),
      status: stringValue(row, 'status', 'open') || 'open',
      priority: nullableStringValue(row, 'priority'),
      source: stringValue(row, 'source', 'manual') || 'manual',
      metadataJson: nullableStringValue(row, 'metadataJson'),
      resolvedAt: nullableStringValue(row, 'resolvedAt'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id && row.targetId && row.targetBlockId);
    if (manuscriptComments.length > 0) {
      await tx.insert(ManuscriptCommentTable).values(manuscriptComments as any[]);
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
      response.data.entityReferences.length +
      response.data.entityPatches.length +
      response.data.memos.length +
      response.data.materials.length +
      response.data.manuscriptComments.length +
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
