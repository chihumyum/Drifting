/**
 * Sync Pull Service - 从 Server 拉取数据到本地 SQLite
 * 
 * 功能：
 * 1. 登录后全量同步（initialSync）
 * 2. Last Write Wins 合并策略
 * 
 * 触发时机：
 * - 用户登录后
 * - 应用启动时（如果已登录）
 */

import { projectsApi } from '../../services/api/projects-api';
import { nodeApi } from '../../services/api/node-api';
import { threadsApi } from '../../services/api/threads-api';
import { elementsApi } from '../../services/api/elements-api';
import { contentApi } from '../../services/api/content-api';
import { initDatabase } from '../db';
import { applyRemoteNode, cleanupSyncedDeletedNodes } from '../../repositories/book_node_sqlite';
import { applyRemoteContent, cleanupSyncedDeletedContents } from '../../repositories/book_content_sqlite';
import {
  applyRemoteThread,
  cleanupSyncedDeletedThreads,
} from '../../repositories/story_thread_sqlite';
import {
  applyRemoteElement,
  applyRemoteElementCategory,
  cleanupSyncedDeletedElements,
  cleanupSyncedDeletedCategories,
} from '../../repositories/book_element_sqlite';
import { syncManager } from './sync-manager';
import { createTraceId, runWithSyncTraceId } from '../trace';

// 同步状态
interface SyncStats {
  totalPulled: number;
  totalPushed: number;
  conflicts: number;
  errors: number;
}

const SYNC_STORAGE_PREFIX = 'drifting:sync:lastPull:';

type SyncPullEvent = 'pull:start' | 'pull:success' | 'pull:error';

const getLastPullAt = (projectId: string): number | null => {
  try {
    const raw = window.localStorage.getItem(`${SYNC_STORAGE_PREFIX}${projectId}`);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isNaN(value) ? null : value;
  } catch (error) {
    console.warn('[SyncPull] Failed to read last pull timestamp:', error);
    return null;
  }
};

const setLastPullAt = (projectId: string, timestamp: number) => {
  try {
    window.localStorage.setItem(`${SYNC_STORAGE_PREFIX}${projectId}`, String(timestamp));
  } catch (error) {
    console.warn('[SyncPull] Failed to persist last pull timestamp:', error);
  }
};

class SyncPullService {
  private isSyncing = false;
  private lastSyncTime: number = 0;
  private readonly emitter = new EventTarget();
  private listenerMap: Map<SyncPullEvent, Map<(payload: unknown) => void, EventListener>> = new Map();

  /**
   * 检查是否应该同步
   */
  private async shouldPull(): Promise<boolean> {
    try {
      const authModule = await import('../../store/auth');
      const authStore = authModule.useAuthStore.getState();
      return authStore.isAuthenticated && navigator.onLine;
    } catch (error) {
      console.error('[SyncPull] Failed to check auth status:', error);
      return false;
    }
  }

  /**
   * 初始同步：登录后从 Server 拉取所有数据
   */
  async initialSync(): Promise<SyncStats> {
    if (this.isSyncing) {
      console.log('[SyncPull] Sync already in progress, skipping...');
      return { totalPulled: 0, totalPushed: 0, conflicts: 0, errors: 0 };
    }

    if (!(await this.shouldPull())) {
      console.log('[SyncPull] Conditions not met for sync');
      return { totalPulled: 0, totalPushed: 0, conflicts: 0, errors: 0 };
    }

    this.isSyncing = true;
    const stats: SyncStats = {
      totalPulled: 0,
      totalPushed: 0,
      conflicts: 0,
      errors: 0,
    };

    const traceId = createTraceId();
    try {
      return await runWithSyncTraceId(traceId, async () => {
        console.log('[SyncPull] Starting initial sync from server...');

        const projects = await projectsApi.getAll();
        if (!projects.length) {
          console.log('[SyncPull] No remote projects found, skipping.');
        }

        for (const project of projects) {
          try {
            const projectStats = await this.syncProject(project.id);
            stats.totalPulled += projectStats.totalPulled;
            stats.conflicts += projectStats.conflicts;
            stats.errors += projectStats.errors;
          } catch (error) {
            console.error(`[SyncPull] Failed to sync project ${project.id}:`, error);
            stats.errors++;
          }
        }

        this.lastSyncTime = Date.now();
        console.log('[SyncPull] Initial sync completed ✅', stats);

        return stats;
      });
    } catch (error) {
      console.error('[SyncPull] Initial sync failed:', error);
      stats.errors++;
      return stats;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 获取上次同步时间
   */
  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  /**
   * 检查是否正在同步
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * 格式化同步时间为可读字符串
   */
  getLastSyncTimeFormatted(): string {
    if (this.lastSyncTime === 0) {
      return '从未同步';
    }
    
    const now = Date.now();
    const diff = now - this.lastSyncTime;
    const minutes = Math.floor(diff / 60000);
    
    if (minutes < 1) {
      return '刚刚';
    } else if (minutes < 60) {
      return `${minutes} 分钟前`;
    } else {
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return `${hours} 小时前`;
      } else {
        const days = Math.floor(hours / 24);
        return `${days} 天前`;
      }
    }
  }

  async pullFromServer(projectId: string, options?: { fullSync?: boolean }): Promise<SyncStats> {
    if (this.isSyncing) {
      console.log('[SyncPull] Sync already in progress, skipping...');
      return { totalPulled: 0, totalPushed: 0, conflicts: 0, errors: 0 };
    }

    if (!(await this.shouldPull())) {
      console.log('[SyncPull] Conditions not met for sync');
      return { totalPulled: 0, totalPushed: 0, conflicts: 0, errors: 0 };
    }

    this.isSyncing = true;
    const stats: SyncStats = { totalPulled: 0, totalPushed: 0, conflicts: 0, errors: 0 };

    const since = options?.fullSync ? null : getLastPullAt(projectId);
    this.emitEvent('pull:start', { projectId, since });

    const traceId = createTraceId();
    try {
      await runWithSyncTraceId(traceId, async () => {
        const projectStats = await this.syncProject(projectId, { since });
        stats.totalPulled += projectStats.totalPulled;
        stats.totalPushed += projectStats.totalPushed;
        stats.conflicts += projectStats.conflicts;
        stats.errors += projectStats.errors;
        this.lastSyncTime = Date.now();
        this.emitEvent('pull:success', { projectId, stats });
      });
    } catch (error) {
      stats.errors += 1;
      console.error('[SyncPull] pullFromServer failed:', error);
      this.emitEvent('pull:error', { projectId, error });
    } finally {
      this.isSyncing = false;
    }

    return stats;
  }

  private async syncProject(projectId: string, options?: { since?: number | null }): Promise<SyncStats> {
    const stats: SyncStats = { totalPulled: 0, totalPushed: 0, conflicts: 0, errors: 0 };

    try {
      await initDatabase(projectId);
      const since = options?.since ?? getLastPullAt(projectId);

      const [nodes, contentsResponse, threadsResponse, elementsResponse, categoriesResponse] = await Promise.all([
        nodeApi.getAll(projectId, since ? { updatedAfter: since } : undefined),
        contentApi.list(projectId, since ? { updatedAfter: since } : undefined),
        threadsApi.list(projectId, since ? { updatedAfter: since, includeDeleted: true, limit: 500 } : { includeDeleted: true, limit: 500 }),
        elementsApi.list(projectId, since ? { updatedAfter: since, includeDeleted: true, limit: 500 } : { includeDeleted: true, limit: 500 }),
        elementsApi.listCategories(projectId, since ? { updatedAfter: since, includeDeleted: true, limit: 500 } : { includeDeleted: true, limit: 500 }),
      ]);

      for (const node of nodes) {
        const outcome = await applyRemoteNode(node);
        if (outcome === 'conflict') {
          stats.conflicts++;
          syncManager.reportConflict({ entity: 'node', localId: node.id, description: 'Remote node older than local change' });
        } else if (outcome !== 'skipped') {
          stats.totalPulled++;
        }
      }
      await cleanupSyncedDeletedNodes();

      for (const content of contentsResponse.items) {
        const pmJsonString = JSON.stringify(content.pmJson ?? {});
        const outlineJsonString = content.outline ?? '';
        const outcome = await applyRemoteContent({
          nodeId: content.nodeId,
          pmJson: pmJsonString,
          outlineJson: outlineJsonString,
          createdAt: new Date(content.createdAt).toISOString(),
          updatedAt: new Date(content.updatedAt).toISOString(),
        });

        if (outcome === 'conflict') {
          stats.conflicts++;
          syncManager.reportConflict({ entity: 'content', localId: content.nodeId, description: 'Remote content older than local change' });
        } else if (outcome !== 'skipped') {
          stats.totalPulled++;
        }
      }
      await cleanupSyncedDeletedContents();

      // page through threads/elements/categories if needed
      const threads: typeof threadsResponse.items = [...threadsResponse.items];
      let threadCursor = threadsResponse.nextCursor ?? null;
      for (let i = 0; threadCursor && i < 20; i++) {
        const next = await threadsApi.list(projectId, {
          updatedAfter: since ?? undefined,
          includeDeleted: true,
          limit: 500,
          cursor: threadCursor,
        });
        threads.push(...next.items);
        threadCursor = next.nextCursor;
      }

      const elements: typeof elementsResponse.items = [...elementsResponse.items];
      let elementCursor = elementsResponse.nextCursor ?? null;
      for (let i = 0; elementCursor && i < 20; i++) {
        const next = await elementsApi.list(projectId, {
          updatedAfter: since ?? undefined,
          includeDeleted: true,
          limit: 500,
          cursor: elementCursor,
        });
        elements.push(...next.items);
        elementCursor = next.nextCursor;
      }

      const categories: typeof categoriesResponse.items = [...categoriesResponse.items];
      let categoryCursor = categoriesResponse.nextCursor ?? null;
      for (let i = 0; categoryCursor && i < 20; i++) {
        const next = await elementsApi.listCategories(projectId, {
          updatedAfter: since ?? undefined,
          includeDeleted: true,
          limit: 500,
          cursor: categoryCursor,
        });
        categories.push(...next.items);
        categoryCursor = next.nextCursor;
      }

      for (const thread of threads) {
        const outcome = await applyRemoteThread({
          id: thread.id,
          projectId: thread.projectId,
          name: thread.name,
          color: thread.color ?? '#b89968',
          summary: thread.summary ?? null,
          pmJson: thread.pmJson ?? null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          isDeleted: Boolean(thread.isDeleted || thread.deletedAt),
        });

        if (outcome === 'conflict') {
          stats.conflicts++;
          syncManager.reportConflict({ entity: 'thread', localId: thread.id, description: 'Remote thread older than local change' });
        } else if (outcome !== 'skipped') {
          stats.totalPulled++;
        }
      }
      await cleanupSyncedDeletedThreads();

      for (const element of elements) {
        const outcome = await applyRemoteElement({
          id: element.id,
          projectId: element.projectId,
          name: element.name,
          categoryId: element.categoryId ?? null,
          type: element.metadata?.type ? String(element.metadata.type) : element.metadata?.kind ? String(element.metadata.kind) : null,
          contentJson: element.metadata ? JSON.stringify(element.metadata) : '{}',
          summaryJson: element.description ? JSON.stringify({ description: element.description }) : '{}',
          createdAt: element.createdAt,
          updatedAt: element.updatedAt,
          isDeleted: Boolean(element.isDeleted || element.deletedAt),
        });

        if (outcome === 'conflict') {
          stats.conflicts++;
          syncManager.reportConflict({ entity: 'element', localId: element.id, description: 'Remote element older than local change' });
        } else if (outcome !== 'skipped') {
          stats.totalPulled++;
        }
      }
      await cleanupSyncedDeletedElements();

      for (const category of categories) {
        const outcome = await applyRemoteElementCategory({
          id: category.id,
          name: category.name,
          descriptionJson:
            category.descriptionJson === undefined || category.descriptionJson === null
              ? null
              : JSON.stringify(category.descriptionJson),
          color: category.color ?? null,
          updatedAt: category.updatedAt ?? new Date().toISOString(),
          isDeleted: Boolean(category.isDeleted || category.deletedAt),
        });

        if (outcome === 'conflict') {
          stats.conflicts++;
          syncManager.reportConflict({ entity: 'element_category', localId: category.id, description: 'Remote category older than local change' });
        } else if (outcome !== 'skipped') {
          stats.totalPulled++;
        }
      }
      await cleanupSyncedDeletedCategories();

      setLastPullAt(projectId, Date.now());
      syncManager.recordPull(`project:${projectId}`);
    } catch (error) {
      stats.errors++;
      console.error(`[SyncPull] syncProject error for ${projectId}:`, error);
    }

    return stats;
  }

  on(event: SyncPullEvent, handler: (payload: unknown) => void) {
    const listener = (evt: Event) => handler((evt as CustomEvent).detail);
    let map = this.listenerMap.get(event);
    if (!map) {
      map = new Map();
      this.listenerMap.set(event, map);
    }
    map.set(handler, listener);
    this.emitter.addEventListener(event, listener as EventListener);
  }

  off(event: SyncPullEvent, handler: (payload: unknown) => void) {
    const map = this.listenerMap.get(event);
    const listener = map?.get(handler);
    if (listener) {
      this.emitter.removeEventListener(event, listener as EventListener);
      map?.delete(handler);
    }
  }

  private emitEvent(event: SyncPullEvent, detail: unknown) {
    this.emitter.dispatchEvent(new CustomEvent(event, { detail }));
  }
}

export const syncPullService = new SyncPullService();
