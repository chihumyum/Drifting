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

import { apiClient } from '../lib/axios-config';
import { isSyncEnabled } from '../lib/config';
import { getDeviceId } from '../lib/device-id';
import { events, type SyncOperationEvent } from '../lib/events';
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

let pushQueue: SyncMutation[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let currentStatus: SyncStatus = 'idle';
const statusListeners: Set<SyncStatusListener> = new Set();

const FLUSH_DELAY_MS = 800;
const PULL_INTERVAL_MS = 30_000;

type MutationRequest = {
  method: SyncOperationEvent['method'];
  endpoint: string;
  data?: Record<string, unknown>;
};

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
  if (!isSyncEnabled()) return;

  // Coalesce: if same entity+type already queued, replace payload
  const existing = pushQueue.findIndex(
    (m) =>
      m.entityType === mutation.entityType &&
      m.entityId === mutation.entityId &&
      m.mutationType === mutation.mutationType,
  );
  if (existing >= 0) {
    pushQueue[existing] = mutation;
  } else {
    pushQueue.push(mutation);
  }

  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPushQueue();
  }, FLUSH_DELAY_MS);
}

async function flushPushQueue(): Promise<void> {
  if (pushQueue.length === 0) return;
  if (!isSyncEnabled()) {
    pushQueue = [];
    return;
  }

  const batch = pushQueue.splice(0, pushQueue.length);
  setStatus('pushing');

  for (const mutation of batch) {
    try {
      await pushSingleMutation(mutation);
    } catch (err) {
      log.error(`[sync] push failed for ${mutation.entityType}/${mutation.entityId}:`, err);
      // Re-enqueue failed mutations for retry
      pushQueue.push(mutation);
    }
  }

  if (pushQueue.length > 0) {
    // Some failed — schedule retry
    setStatus('error', `${pushQueue.length} pending`);
    scheduleFlush();
  } else {
    setStatus('idle');
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
  projects?: unknown[];
  nodes?: unknown[];
  storylines?: unknown[];
  elements?: unknown[];
  categories?: unknown[];
  stages?: unknown[];
  nodeTags?: unknown[];
  elementTags?: unknown[];
}

/**
 * Pull all entities for a project from the server.
 * Returns the raw server responses — callers reconcile with local state.
 */
export async function pullProjectData(projectId: string): Promise<PullResult> {
  if (!isSyncEnabled()) return {};

  setStatus('pulling');
  const requestId = createRequestId(`crud:pull:${projectId}`);
  const deviceId = getDeviceId();
  const startedAt = nowMs();
  const eventBase = {
    requestId,
    kind: 'crud' as const,
    phase: 'pull' as const,
    operation: 'pull' as const,
    method: 'GET' as const,
    endpoint: `/api/projects/${projectId}/resources`,
    entityType: 'project',
    entityId: projectId,
    projectId,
    deviceId,
  };

  emitSyncOperation({
    ...eventBase,
    state: 'started',
  });

  try {
    const [nodes, storylines, elements, categories, stages, nodeTags, elementTags] =
      await Promise.all([
        apiClient
          .get(`/api/projects/${projectId}/nodes`)
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get(`/api/projects/${projectId}/storylines`)
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get(`/api/projects/${projectId}/elements`)
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get(`/api/projects/${projectId}/categories`)
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get(`/api/projects/${projectId}/stages`)
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get(`/api/projects/${projectId}/node-tags`)
          .then((r) => r.data)
          .catch(() => []),
        apiClient
          .get(`/api/projects/${projectId}/element-tags`)
          .then((r) => r.data)
          .catch(() => []),
      ]);

    setStatus('idle');
    emitSyncOperation({
      ...eventBase,
      state: 'succeeded',
      resourceCount:
        nodes.length +
        storylines.length +
        elements.length +
        categories.length +
        stages.length +
        nodeTags.length +
        elementTags.length,
      durationMs: nowMs() - startedAt,
    });
    return { nodes, storylines, elements, categories, stages, nodeTags, elementTags };
  } catch (err) {
    log.error('[sync] pull failed:', err);
    setStatus('error', 'pull failed');
    emitSyncOperation({
      ...eventBase,
      state: 'failed',
      durationMs: nowMs() - startedAt,
      error: getErrorMessage(err),
    });
    return {};
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
  void pullProjectData(projectId).then(onData);

  pullTimer = setInterval(() => {
    void pullProjectData(projectId).then(onData);
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
  return pushQueue.length;
}
