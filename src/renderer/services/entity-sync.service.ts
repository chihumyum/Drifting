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

// ==================== Status ====================

function setStatus(s: SyncStatus, detail?: string) {
  currentStatus = s;
  for (const listener of statusListeners) {
    try { listener(s, detail); } catch { /* ignore */ }
  }
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function onSyncStatusChange(listener: SyncStatusListener): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
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
    (m) => m.entityType === mutation.entityType
      && m.entityId === mutation.entityId
      && m.mutationType === mutation.mutationType,
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
async function pushSingleMutation(m: SyncMutation): Promise<void> {
  const { entityType, mutationType, entityId, projectId, payload, parentId } = m;

  switch (entityType) {
    // ---- Project ----
    case 'project':
      if (mutationType === 'create') {
        await apiClient.post('/api/projects', payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${entityId}`);
      }
      break;

    // ---- Node ----
    case 'node':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/nodes`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/nodes/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/nodes/${entityId}`);
      }
      break;

    // ---- Node Content ----
    case 'nodeContent':
      if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/nodes/${entityId}/content`, payload);
      }
      break;

    // ---- Node Edge ----
    case 'nodeEdge':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/edges`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/edges/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/edges/${entityId}`);
      }
      break;

    // ---- Storyline ----
    case 'storyline':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/storylines`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/storylines/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/storylines/${entityId}`);
      }
      break;

    // ---- Node-Storyline Link ----
    case 'nodeStorylineLink':
      if (mutationType === 'create') {
        // parentId = storylineId, entityId = nodeId
        await apiClient.post(`/api/projects/${projectId}/storylines/${parentId}/nodes/${entityId}`);
      } else if (mutationType === 'delete') {
        await apiClient.delete(`/api/projects/${projectId}/storylines/${parentId}/nodes/${entityId}`);
      } else if (mutationType === 'update') {
        // "update" = set node storylines (bulk replace)
        await apiClient.put(`/api/projects/${projectId}/nodes/${entityId}/storylines`, payload);
      }
      break;

    // ---- Element ----
    case 'element':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/elements`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/elements/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/elements/${entityId}`);
      }
      break;

    // ---- Element Category ----
    case 'elementCategory':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/categories`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/categories/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/categories/${entityId}`);
      }
      break;

    // ---- Element Stage ----
    case 'elementStage':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/elements/${parentId}/stages`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/elements/${parentId}/stages/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/elements/${parentId}/stages/${entityId}`);
      }
      break;

    // ---- Element Tag ----
    case 'elementTag':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/element-tags`, payload);
      } else if (mutationType === 'delete') {
        await apiClient.delete(`/api/projects/${projectId}/element-tags/${entityId}`);
      }
      break;

    // ---- Element Tag Link ----
    case 'elementTagLink':
      if (mutationType === 'create') {
        // entityId = elementId, parentId = tagId
        await apiClient.post(`/api/projects/${projectId}/elements/${entityId}/tags/${parentId}`);
      } else if (mutationType === 'delete') {
        await apiClient.delete(`/api/projects/${projectId}/elements/${entityId}/tags/${parentId}`);
      } else if (mutationType === 'update') {
        // Bulk set
        await apiClient.put(`/api/projects/${projectId}/elements/${entityId}/tags`, payload);
      }
      break;

    // ---- Node Tag ----
    case 'nodeTag':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/node-tags`, payload);
      } else if (mutationType === 'delete') {
        await apiClient.delete(`/api/projects/${projectId}/node-tags/${entityId}`);
      }
      break;

    // ---- Node Tag Link ----
    case 'nodeTagLink':
      if (mutationType === 'create') {
        // entityId = nodeId, parentId = tagId
        await apiClient.post(`/api/projects/${projectId}/node-tags/${parentId}/nodes/${entityId}`);
      } else if (mutationType === 'delete') {
        await apiClient.delete(`/api/projects/${projectId}/node-tags/${parentId}/nodes/${entityId}`);
      } else if (mutationType === 'update') {
        // Bulk set
        await apiClient.put(`/api/projects/${projectId}/node-tags/by-node/${entityId}`, payload);
      }
      break;

    // ---- Story Stage ----
    case 'storyStage':
      if (mutationType === 'create') {
        await apiClient.post(`/api/projects/${projectId}/stages`, payload);
      } else if (mutationType === 'update') {
        await apiClient.patch(`/api/projects/${projectId}/stages/${entityId}`, payload);
      } else {
        await apiClient.delete(`/api/projects/${projectId}/stages/${entityId}`);
      }
      break;

    default:
      log.warn(`[sync] unknown entity type: ${entityType}`);
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
  try {
    const [nodes, storylines, elements, categories, stages, nodeTags, elementTags] =
      await Promise.all([
        apiClient.get(`/api/projects/${projectId}/nodes`).then(r => r.data).catch(() => []),
        apiClient.get(`/api/projects/${projectId}/storylines`).then(r => r.data).catch(() => []),
        apiClient.get(`/api/projects/${projectId}/elements`).then(r => r.data).catch(() => []),
        apiClient.get(`/api/projects/${projectId}/categories`).then(r => r.data).catch(() => []),
        apiClient.get(`/api/projects/${projectId}/stages`).then(r => r.data).catch(() => []),
        apiClient.get(`/api/projects/${projectId}/node-tags`).then(r => r.data).catch(() => []),
        apiClient.get(`/api/projects/${projectId}/element-tags`).then(r => r.data).catch(() => []),
      ]);

    setStatus('idle');
    return { nodes, storylines, elements, categories, stages, nodeTags, elementTags };
  } catch (err) {
    log.error('[sync] pull failed:', err);
    setStatus('error', 'pull failed');
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
