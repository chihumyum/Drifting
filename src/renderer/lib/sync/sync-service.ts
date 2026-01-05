/**
 * Sync Service - 同步服务包装器
 * 
 * 为现有的 SQLite repositories 提供自动云端同步能力。
 * 采用包装器模式，不修改现有代码，通过 syncService.create/update/delete 使用。
 * 
 * 工作原理：
 * 1. 立即写本地 SQLite（instant response）
 * 2. 判断是否需要同步（isAuthenticated && isOnline）
 * 3. 入队后台同步任务到 SyncManager
 */

import { syncManager } from './sync-manager';
import type { SyncTaskInput, SyncTaskEntity, SyncEventType } from './types';

type EntityWithId = { id: string };

// 动态导入 Auth Store（避免循环依赖）
let getAuthStore: (() => { isAuthenticated: boolean }) | null = null;

const loadAuthStore = async () => {
  if (!getAuthStore) {
    const module = await import('../../store/auth');
    getAuthStore = () => module.useAuthStore.getState();
  }
  return getAuthStore();
};

class SyncService {
  /**
   * 判断是否应该同步到云端
   */
  private async shouldSync(): Promise<boolean> {
    try {
      const authStore = await loadAuthStore();
      return authStore.isAuthenticated && navigator.onLine;
    } catch (error) {
      console.error('[SyncService] Failed to check auth status:', error);
      return false;
    }
  }

  /**
   * 通用创建方法 - 立即写本地 + 后台同步
   * 
   * @param localRepo - 本地 SQLite repository
   * @param entity - 实体类型 ('node' | 'element' | 'storyline' | 'content')
   * @param data - 创建数据
   * @param remoteCreate - 远程 API 创建函数（可选，用于同步）
   * @returns 本地创建的实体
   */
  async create<T extends EntityWithId, TInput>(
    localRepo: { create: (data: TInput) => Promise<T> },
    entity: SyncTaskEntity,
    data: TInput,
    remoteCreate?: (data: TInput) => Promise<T>
  ): Promise<T> {
    // 1. 立即写本地 SQLite（instant response）
    const localEntity = await localRepo.create(data);
    
    // 2. 判断是否需要同步
    if (remoteCreate && (await this.shouldSync())) {
      // 3. 入队后台同步任务
      const taskInput: SyncTaskInput = {
        type: 'create',
        entity,
        localId: localEntity.id,
        data: data as unknown,
        priority: 'normal',
      };
      
      syncManager.enqueue(taskInput);
    }
    
    return localEntity;
  }

  /**
   * 通用更新方法 - 立即写本地 + 后台同步
   * 
   * @param localRepo - 本地 SQLite repository
   * @param entity - 实体类型
   * @param id - 实体 ID
   * @param data - 更新数据
   * @param remoteUpdate - 远程 API 更新函数（可选，用于同步）
   * @returns 本地更新的实体
   */
  async update<T, TInput>(
    localRepo: { update: (id: string, data: TInput) => Promise<T | null> },
    entity: SyncTaskEntity,
    id: string,
    data: TInput,
    remoteUpdate?: (id: string, data: TInput) => Promise<T>
  ): Promise<T | null> {
    // 1. 立即写本地 SQLite
    const localEntity = await localRepo.update(id, data);
    
    // 2. 判断是否需要同步
    if (localEntity && remoteUpdate && (await this.shouldSync())) {
      // 3. 入队后台同步任务
      const taskInput: SyncTaskInput = {
        type: 'update',
        entity,
        localId: id,
        data: data as unknown,
        priority: 'normal',
      };
      
      syncManager.enqueue(taskInput);
    }
    
    return localEntity;
  }

  /**
   * 通用删除方法 - 立即删除本地 + 后台同步
   * 
   * @param localRepo - 本地 SQLite repository
   * @param entity - 实体类型
   * @param id - 实体 ID
   * @param remoteDelete - 远程 API 删除函数（可选，用于同步）
   * @returns 是否删除成功
   */
  async delete(
    localRepo: { delete: (id: string) => Promise<boolean> },
    entity: SyncTaskEntity,
    id: string,
    remoteDelete?: (id: string) => Promise<void>
  ): Promise<boolean> {
    // 1. 立即删除本地
    const success = await localRepo.delete(id);
    
    // 2. 判断是否需要同步
    if (success && remoteDelete && (await this.shouldSync())) {
      // 3. 入队后台同步任务
      const taskInput: SyncTaskInput = {
        type: 'delete',
        entity,
        localId: id,
        data: null,
        priority: 'normal',
      };
      
      syncManager.enqueue(taskInput);
    }

    return success;
  }

  /**
   * 批量创建方法 - 立即写本地 + 后台同步
   * 
   * @param createFn - 批量创建函数
   * @param entity - 实体类型
   * @param dataList - 创建数据列表
   * @param remoteBulkCreate - 远程 API 批量创建函数（可选）
   * @returns 本地创建的实体列表
   */
  async bulkCreate<T, TInput>(
    createFn: (dataList: TInput[]) => Promise<T[]>,
    entity: SyncTaskEntity,
    dataList: TInput[],
    remoteBulkCreate?: (dataList: TInput[]) => Promise<T[]>
  ): Promise<T[]> {
    // 1. 立即批量写本地
    const localEntities = await createFn(dataList);
    
    // 2. 判断是否需要同步
    if (remoteBulkCreate && (await this.shouldSync())) {
      // 3. 入队后台同步任务（高优先级，因为是批量操作）
      const taskInput: SyncTaskInput = {
        type: 'create',
        entity,
        localId: `bulk-${Date.now()}`,
        data: dataList as unknown,
        priority: 'high',
      };
      
      syncManager.enqueue(taskInput);
    }
    
    return localEntities;
  }

  /**
   * 获取同步状态
   */
  getStatus() {
    return syncManager.getStatus();
  }

  /**
   * 监听同步事件
   */
  on(event: SyncEventType, handler: (...args: unknown[]) => void) {
    syncManager.on(event, handler);
  }

  /**
   * 取消监听同步事件
   */
  off(event: SyncEventType, handler: (...args: unknown[]) => void) {
    syncManager.off(event, handler);
  }
}

export const syncService = new SyncService();
