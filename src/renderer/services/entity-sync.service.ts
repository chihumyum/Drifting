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
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  ElementOccurrenceTable,
  ElementStageTable,
  ElementTagLinkTable,
  ElementTagTable,
  LocalSyncMutationTable,
  NodeContentTable,
  NodeEdgeTable,
  NodeElementBacklinkTable,
  NodeStorylineLinkTable,
  NodeTagLinkTable,
  NodeTagTable,
  ProjectTable,
  StorylineTable,
  StoryStageTable,
} from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import loglevel from 'loglevel';

const log = loglevel.getLogger('EntitySyncService');
log.setLevel(loglevel.levels.WARN);

// ==================== Types ====================

export type EntityType =
  | 'project'
  | 'node'
  | 'nodeContent'
  | 'nodeEdge'
  | 'storyline'
  | 'nodeStorylineLink'
  | 'element'
  | 'elementCategory'
  | 'elementStage'
  | 'elementTag'
  | 'elementTagLink'
  | 'nodeTag'
  | 'nodeTagLink'
  | 'storyStage';

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
  nodeEdges: Record<string, unknown>[];
  storylines: Record<string, unknown>[];
  nodeStorylineLinks: Record<string, unknown>[];
  elements: Record<string, unknown>[];
  elementCategories: Record<string, unknown>[];
  elementStages: Record<string, unknown>[];
  storyStages: Record<string, unknown>[];
  nodeTags: Record<string, unknown>[];
  nodeTagLinks: Record<string, unknown>[];
  elementTags: Record<string, unknown>[];
  elementTagLinks: Record<string, unknown>[];
  elementOccurrences: Record<string, unknown>[];
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

    // ---- Node Edge ----
    case 'nodeEdge':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/edges`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/edges/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/edges/${entityId}` };

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

    // ---- Element Stage ----
    case 'elementStage':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/elements/${parentId}/stages`,
          data: payload,
        };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/elements/${parentId}/stages/${entityId}`,
          data: payload,
        };
      }
      return {
        method: 'DELETE',
        endpoint: `/api/projects/${projectId}/elements/${parentId}/stages/${entityId}`,
      };

    // ---- Element Tag ----
    case 'elementTag':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/element-tags`,
          data: payload,
        };
      }
      if (mutationType === 'delete') {
        return {
          method: 'DELETE',
          endpoint: `/api/projects/${projectId}/element-tags/${entityId}`,
        };
      }
      return null;

    // ---- Element Tag Link ----
    case 'elementTagLink':
      if (mutationType === 'create') {
        // entityId = elementId, parentId = tagId
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/elements/${entityId}/tags/${parentId}`,
        };
      } else if (mutationType === 'delete') {
        return {
          method: 'DELETE',
          endpoint: `/api/projects/${projectId}/elements/${entityId}/tags/${parentId}`,
        };
      }
      // Bulk set
      return {
        method: 'PUT',
        endpoint: `/api/projects/${projectId}/elements/${entityId}/tags`,
        data: payload,
      };

    // ---- Node Tag ----
    case 'nodeTag':
      if (mutationType === 'create') {
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/node-tags`,
          data: payload,
        };
      }
      if (mutationType === 'delete') {
        return { method: 'DELETE', endpoint: `/api/projects/${projectId}/node-tags/${entityId}` };
      }
      return null;

    // ---- Node Tag Link ----
    case 'nodeTagLink':
      if (mutationType === 'create') {
        // entityId = nodeId, parentId = tagId
        return {
          method: 'POST',
          endpoint: `/api/projects/${projectId}/node-tags/${parentId}/nodes/${entityId}`,
        };
      } else if (mutationType === 'delete') {
        return {
          method: 'DELETE',
          endpoint: `/api/projects/${projectId}/node-tags/${parentId}/nodes/${entityId}`,
        };
      }
      // Bulk set
      return {
        method: 'PUT',
        endpoint: `/api/projects/${projectId}/node-tags/by-node/${entityId}`,
        data: payload,
      };

    // ---- Story Stage ----
    case 'storyStage':
      if (mutationType === 'create') {
        return { method: 'POST', endpoint: `/api/projects/${projectId}/stages`, data: payload };
      } else if (mutationType === 'update') {
        return {
          method: 'PATCH',
          endpoint: `/api/projects/${projectId}/stages/${entityId}`,
          data: payload,
        };
      }
      return { method: 'DELETE', endpoint: `/api/projects/${projectId}/stages/${entityId}` };

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
  nodeEdges?: unknown[];
  storylines?: unknown[];
  nodeStorylineLinks?: unknown[];
  elements?: unknown[];
  elementCategories?: unknown[];
  elementStages?: unknown[];
  categories?: unknown[];
  stages?: unknown[];
  nodeTags?: unknown[];
  nodeTagLinks?: unknown[];
  elementTags?: unknown[];
  elementTagLinks?: unknown[];
  elementOccurrences?: unknown[];
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
    nodeEdges: graph.nodeEdges,
    storylines: graph.storylines,
    nodeStorylineLinks: graph.nodeStorylineLinks,
    elements: graph.elements,
    elementCategories: graph.elementCategories,
    elementStages: graph.elementStages,
    categories: graph.elementCategories,
    stages: graph.storyStages,
    nodeTags: graph.nodeTags,
    nodeTagLinks: graph.nodeTagLinks,
    elementTags: graph.elementTags,
    elementTagLinks: graph.elementTagLinks,
    elementOccurrences: graph.elementOccurrences,
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

function booleanValue(row: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = row[key];
  return typeof value === 'boolean' ? value : fallback;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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

function groupLinkIds(
  rows: Record<string, unknown>[],
  ownerKey: 'nodeId' | 'elementId',
  childKey: 'tagId' | 'storylineId',
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  rows.forEach((row) => {
    const ownerId = stringValue(row, ownerKey);
    const childId = stringValue(row, childKey);
    if (!ownerId || !childId) return;
    const values = grouped[ownerId] ?? [];
    if (!values.includes(childId)) grouped[ownerId] = [...values, childId];
  });
  return grouped;
}

function groupRowIds(
  rows: Record<string, unknown>[],
  ownerKey: 'nodeId' | 'elementId',
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  rows.forEach((row) => {
    const ownerId = stringValue(row, ownerKey);
    const id = stringValue(row, 'id');
    if (!ownerId || !id) return;
    const values = grouped[ownerId] ?? [];
    if (!values.includes(id)) grouped[ownerId] = [...values, id];
  });
  return grouped;
}

function applyGraphToStores(graph: ProjectGraphPayload): void {
  const elementTagIds = groupLinkIds(graph.elementTagLinks, 'elementId', 'tagId');
  const elementStageIds = groupRowIds(graph.elementStages, 'elementId');
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
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setBookNodes(
    graph.nodes.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      title: stringValue(row, 'title'),
      summary: stringValue(row, 'summary'),
      start: numberValue(row, 'start'),
      end: numberValue(row, 'end'),
      storyStageId: nullableStringValue(row, 'storyStageId'),
      mainStorylineId: stringValue(row, 'mainStorylineId'),
      position: {
        x: numberValue(row, 'positionX'),
        y: numberValue(row, 'positionY'),
      },
      wordCount: numberValue(row, 'wordCount'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setNodeEdges(
    graph.nodeEdges.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      sourceNodeId: stringValue(row, 'sourceNodeId'),
      targetNodeId: stringValue(row, 'targetNodeId'),
      label: stringValue(row, 'label'),
      weight: numberValue(row, 'weight', 1),
      isDirected: booleanValue(row, 'isDirected', true),
      style: parseJsonObject(row.styleJson) as any,
      controlPointOffset: parseJsonObject(row.controlPointOffsetJson) as
        | { x: number; y: number }
        | undefined,
      sourceAnchor: parseJsonObject(row.sourceAnchorJson) as { x: number; y: number } | undefined,
      targetAnchor: parseJsonObject(row.targetAnchorJson) as { x: number; y: number } | undefined,
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setStorylineNodeMapping(buildStorylineNodeMapping(nodeStorylineLinks));
  dataStore.setBookElementCategories(
    graph.elementCategories.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
      color: stringValue(row, 'color'),
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
      tagIds: elementTagIds[stringValue(row, 'id')] ?? [],
      stageIds: elementStageIds[stringValue(row, 'id')] ?? [],
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setNodeTags(
    graph.nodeTags.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );
  dataStore.setElementTags(
    graph.elementTags.map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })),
  );

  const project = {
    id: stringValue(graph.project, 'id'),
    userId: stringValue(graph.project, 'userId'),
    name: stringValue(graph.project, 'name'),
    descriptionJson: stringValue(graph.project, 'descriptionJson', '{}'),
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

async function countPendingMutations(projectId?: string): Promise<number> {
  const base = getDb()
    .select({ id: LocalSyncMutationTable.id })
    .from(LocalSyncMutationTable);
  const rows = projectId
    ? await base.where(eq(LocalSyncMutationTable.projectId, projectId))
    : await base.where(eq(LocalSyncMutationTable.status, 'pending'));
  return rows.length;
}

export async function hydrateProjectGraph(graph: ProjectGraphPayload): Promise<void> {
  const projectId = stringValue(graph.project, 'id');
  if (!projectId) throw new Error('Cannot hydrate project graph without project.id');

  const db = getDb();

  await db.transaction(async (tx) => {
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
    const oldNodeTags = await tx
      .select({ id: NodeTagTable.id })
      .from(NodeTagTable)
      .where(eq(NodeTagTable.projectId, projectId));
    const oldElementTags = await tx
      .select({ id: ElementTagTable.id })
      .from(ElementTagTable)
      .where(eq(ElementTagTable.projectId, projectId));

    const oldNodeIds = oldNodes.map((row) => row.id);
    const oldElementIds = oldElements.map((row) => row.id);
    const oldStorylineIds = oldStorylines.map((row) => row.id);
    const oldNodeTagIds = oldNodeTags.map((row) => row.id);
    const oldElementTagIds = oldElementTags.map((row) => row.id);

    if (oldNodeIds.length > 0) {
      await tx.delete(NodeContentTable).where(inArray(NodeContentTable.nodeId, oldNodeIds));
      await tx.delete(NodeStorylineLinkTable).where(inArray(NodeStorylineLinkTable.nodeId, oldNodeIds));
      await tx.delete(NodeTagLinkTable).where(inArray(NodeTagLinkTable.nodeId, oldNodeIds));
      await tx.delete(ElementOccurrenceTable).where(inArray(ElementOccurrenceTable.nodeId, oldNodeIds));
      await tx.delete(NodeElementBacklinkTable).where(inArray(NodeElementBacklinkTable.nodeId, oldNodeIds));
    }
    if (oldElementIds.length > 0) {
      await tx.delete(ElementStageTable).where(inArray(ElementStageTable.elementId, oldElementIds));
      await tx.delete(ElementTagLinkTable).where(inArray(ElementTagLinkTable.elementId, oldElementIds));
      await tx
        .delete(NodeElementBacklinkTable)
        .where(inArray(NodeElementBacklinkTable.elementId, oldElementIds));
    }
    if (oldStorylineIds.length > 0) {
      await tx
        .delete(NodeStorylineLinkTable)
        .where(inArray(NodeStorylineLinkTable.storylineId, oldStorylineIds));
    }
    if (oldNodeTagIds.length > 0) {
      await tx.delete(NodeTagLinkTable).where(inArray(NodeTagLinkTable.tagId, oldNodeTagIds));
    }
    if (oldElementTagIds.length > 0) {
      await tx.delete(ElementTagLinkTable).where(inArray(ElementTagLinkTable.tagId, oldElementTagIds));
    }

    await tx.delete(NodeEdgeTable).where(eq(NodeEdgeTable.projectId, projectId));
    await tx.delete(BookNodeTable).where(eq(BookNodeTable.projectId, projectId));
    await tx.delete(BookElementTable).where(eq(BookElementTable.projectId, projectId));
    await tx.delete(NodeTagTable).where(eq(NodeTagTable.projectId, projectId));
    await tx.delete(ElementTagTable).where(eq(ElementTagTable.projectId, projectId));
    await tx.delete(StorylineTable).where(eq(StorylineTable.projectId, projectId));
    await tx.delete(StoryStageTable).where(eq(StoryStageTable.projectId, projectId));
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
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      });

    const elementCategories = normalizeRows(graph.elementCategories, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
      color: stringValue(row, 'color'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (elementCategories.length > 0) {
      await tx.insert(ElementCategoryTable).values(elementCategories as any[]);
    }

    const storyStages = normalizeRows(graph.storyStages, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
      orderKey: numberValue(row, 'orderKey'),
      color: stringValue(row, 'color'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (storyStages.length > 0) {
      await tx.insert(StoryStageTable).values(storyStages as any[]);
    }

    const storylines = normalizeRows(graph.storylines, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      color: stringValue(row, 'color'),
      summary: stringValue(row, 'summary'),
      orderKey: numberValue(row, 'orderKey'),
      descriptionJson: stringValue(row, 'descriptionJson', '{}'),
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
      start: numberValue(row, 'start'),
      end: numberValue(row, 'end'),
      storyStageId: nullableStringValue(row, 'storyStageId'),
      mainStorylineId: stringValue(row, 'mainStorylineId'),
      positionX: numberValue(row, 'positionX'),
      positionY: numberValue(row, 'positionY'),
      wordCount: numberValue(row, 'wordCount'),
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

    const nodeEdges = normalizeRows(graph.nodeEdges, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      sourceNodeId: stringValue(row, 'sourceNodeId'),
      targetNodeId: stringValue(row, 'targetNodeId'),
      label: stringValue(row, 'label'),
      weight: numberValue(row, 'weight', 1),
      isDirected: booleanValue(row, 'isDirected', true),
      styleJson: nullableStringValue(row, 'styleJson'),
      controlPointOffsetJson: nullableStringValue(row, 'controlPointOffsetJson'),
      sourceAnchorJson: nullableStringValue(row, 'sourceAnchorJson'),
      targetAnchorJson: nullableStringValue(row, 'targetAnchorJson'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (nodeEdges.length > 0) {
      await tx.insert(NodeEdgeTable).values(nodeEdges as any[]);
    }

    const elements = normalizeRows(graph.elements, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      categoryId: stringValue(row, 'categoryId'),
      name: stringValue(row, 'name'),
      summary: stringValue(row, 'summary'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (elements.length > 0) {
      await tx.insert(BookElementTable).values(elements as any[]);
    }

    const elementStages = normalizeRows(graph.elementStages, (row) => ({
      id: stringValue(row, 'id'),
      elementId: stringValue(row, 'elementId'),
      stageName: stringValue(row, 'stageName'),
      summary: stringValue(row, 'summary'),
      contentJson: stringValue(row, 'contentJson', '{}'),
      orderKey: numberValue(row, 'orderKey'),
      startNodeId: nullableStringValue(row, 'startNodeId'),
      endNodeId: nullableStringValue(row, 'endNodeId'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (elementStages.length > 0) {
      await tx.insert(ElementStageTable).values(elementStages as any[]);
    }

    const nodeTags = normalizeRows(graph.nodeTags, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (nodeTags.length > 0) {
      await tx.insert(NodeTagTable).values(nodeTags as any[]);
    }

    const elementTags = normalizeRows(graph.elementTags, (row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'projectId'),
      name: stringValue(row, 'name'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    }));
    if (elementTags.length > 0) {
      await tx.insert(ElementTagTable).values(elementTags as any[]);
    }

    const nodeStorylineLinks = normalizeRows(graph.nodeStorylineLinks, (row) => ({
      nodeId: stringValue(row, 'nodeId'),
      storylineId: stringValue(row, 'storylineId'),
    })).filter((row) => row.nodeId && row.storylineId);
    if (nodeStorylineLinks.length > 0) {
      await tx.insert(NodeStorylineLinkTable).values(nodeStorylineLinks as any[]);
    }

    const nodeTagLinks = normalizeRows(graph.nodeTagLinks, (row) => ({
      nodeId: stringValue(row, 'nodeId'),
      tagId: stringValue(row, 'tagId'),
    })).filter((row) => row.nodeId && row.tagId);
    if (nodeTagLinks.length > 0) {
      await tx.insert(NodeTagLinkTable).values(nodeTagLinks as any[]);
    }

    const elementTagLinks = normalizeRows(graph.elementTagLinks, (row) => ({
      elementId: stringValue(row, 'elementId'),
      tagId: stringValue(row, 'tagId'),
    })).filter((row) => row.elementId && row.tagId);
    if (elementTagLinks.length > 0) {
      await tx.insert(ElementTagLinkTable).values(elementTagLinks as any[]);
    }

    const elementOccurrences = normalizeRows(graph.elementOccurrences, (row) => ({
      id: stringValue(row, 'id'),
      elementId: stringValue(row, 'elementId'),
      nodeId: stringValue(row, 'nodeId'),
      blockId: stringValue(row, 'blockId'),
      spansJson: stringValue(row, 'spansJson', '[]'),
      createdAt: dateText(row.createdAt),
      updatedAt: dateText(row.updatedAt),
    })).filter((row) => row.id && row.elementId && row.nodeId);
    if (elementOccurrences.length > 0) {
      await tx.insert(ElementOccurrenceTable).values(elementOccurrences as any[]);
    }
  });

  applyGraphToStores(graph);
}

export async function pullAndHydrateProjectGraph(projectId: string): Promise<ProjectGraphPayload | null> {
  if (!isSyncEnabled()) return null;

  await forceFlush();

  const pendingForProject = await countPendingMutations(projectId);
  if (pendingForProject > 0) {
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
    const resourceCount =
      response.data.nodes.length +
      response.data.nodeContents.length +
      response.data.nodeEdges.length +
      response.data.storylines.length +
      response.data.nodeStorylineLinks.length +
      response.data.elements.length +
      response.data.elementCategories.length +
      response.data.elementStages.length +
      response.data.storyStages.length +
      response.data.nodeTags.length +
      response.data.nodeTagLinks.length +
      response.data.elementTags.length +
      response.data.elementTagLinks.length +
      response.data.elementOccurrences.length;

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
      stages: graph.storyStages,
      nodeTags: graph.nodeTags,
      elementTags: graph.elementTags,
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
        stages: graph.storyStages,
        nodeTags: graph.nodeTags,
        elementTags: graph.elementTags,
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
