/**
 * SyncManager - 同步队列管理器
 * 
 * 核心职责：
 * 1. 管理同步任务队列（FIFO + 优先级）
 * 2. 监听网络状态变化
 * 3. 失败重试机制（指数退避）
 * 4. 持久化队列状态到 SQLite
 * 5. 事件通知
 */

import { nanoid } from 'nanoid';
import type {
  SyncTask,
  SyncTaskInput,
  SyncManagerStatus,
  SyncEventType,
} from './types';

type SyncEventHandler = (...args: unknown[]) => void;

const RETRY_DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s

export class SyncManager {
  private queue: SyncTask[] = [];
  private isSyncing = false;
  private isOnline = navigator.onLine;
  private maxRetries = 3;
  private retryDelays = [1000, 5000, 15000]; // 1s, 5s, 15s
  private eventHandlers: Map<SyncEventType, Set<SyncEventHandler>> = new Map();
  private lastSyncTime: number | null = null;

  constructor() {
    this.initialize();
  }

  /**
   * 初始化 SyncManager
   */
  private initialize() {
    // 监听网络状态变化
    window.addEventListener('online', this.handleOnline.bind(this));
    window.addEventListener('offline', this.handleOffline.bind(this));

    // 从 SQLite 恢复未完成的任务
    this.restoreSyncQueue();
  }

  /**
   * 网络恢复在线
   */
  private handleOnline() {
    console.log('[SyncManager] 网络已连接');
    this.isOnline = true;
    this.processSyncQueue();
  }

  /**
   * 网络断开
   */
  private handleOffline() {
    console.log('[SyncManager] 网络已断开');
    this.isOnline = false;
  }

    /**
   * 从 SQLite 恢复队列
   */
  private async restoreSyncQueue(): Promise<void> {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repository');
      const tasks = await syncQueueRepository.getPendingTasks();
      this.queue = tasks;
      console.log(`[SyncManager] 恢复了 ${tasks.length} 个待同步任务`);
    } catch (error) {
      console.error('[SyncManager] 恢复队列失败:', error);
    }
  }

  /**
   * 添加任务到队列
   */
  enqueue(input: SyncTaskInput): string {
    const task: SyncTask = {
      id: nanoid(),
      type: input.type,
      entity: input.entity,
      localId: input.localId,
      projectId: input.projectId,
      data: input.data,
      priority: input.priority || 'normal',
      retryCount: 0,
      status: 'pending',
      createdAt: Date.now(),
    };

    // 去重：检查是否已有相同任务
    const existingIndex = this.queue.findIndex(
      (t) =>
        t.entity === task.entity &&
        t.localId === task.localId &&
        t.type === task.type &&
        t.status === 'pending'
    );

    if (existingIndex !== -1) {
      // 更新现有任务
      this.queue[existingIndex].data = task.data;
      this.queue[existingIndex].createdAt = task.createdAt;
      console.log('[SyncManager] 更新现有任务:', task.entity, task.localId);
      return this.queue[existingIndex].id;
    }

    // 按优先级插入队列
    this.insertByPriority(task);

    // 持久化到 SQLite
    this.persistTask(task);

    console.log('[SyncManager] 任务已入队:', task);

    // 触发处理
    this.processSyncQueue();

    return task.id;
  }

  /**
   * 按优先级插入任务
   */
  private insertByPriority(task: SyncTask) {
    const priorityMap = { high: 3, normal: 2, low: 1 };

    const index = this.queue.findIndex(
      (t) => priorityMap[t.priority] < priorityMap[task.priority]
    );

    if (index === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(index, 0, task);
    }
  }

  /**
   * 持久化任务到 SQLite
   */
  private async persistTask(task: SyncTask) {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repository');
      await syncQueueRepository.saveTask(task);
    } catch (error) {
      console.error('[SyncManager] 持久化任务失败:', error);
    }
  }  /**
   * 处理同步队列（消费者）
   */
  private async processSyncQueue() {
    // 防止并发处理
    if (this.isSyncing) {
      return;
    }

    // 检查网络状态
    if (!this.isOnline) {
      console.log('[SyncManager] 离线状态，暂停同步');
      return;
    }

    // 检查队列是否为空
    if (this.queue.length === 0) {
      this.emit('queue:empty', null);
      return;
    }

    this.isSyncing = true;
    this.emit('status:change', this.getStatus());

    // 处理队列中的任务
    while (this.queue.length > 0 && this.isOnline) {
      const task = this.queue[0];

      try {
        console.log('[SyncManager] 开始同步任务:', task);
        task.status = 'syncing';
        this.emit('sync:start', task);

        // 执行同步任务
        await this.executeTask(task);

        // 成功：移除任务
        task.status = 'completed';
        this.queue.shift();
        this.lastSyncTime = Date.now();

        // 更新本地 SQLite 的同步状态
        await this.updateLocalSyncStatus(task);

        // 从持久化队列中删除
        await this.deleteTaskFromDB(task.id);

        console.log('[SyncManager] 任务同步成功:', task);
        this.emit('sync:success', task);
      } catch (error) {
        console.error('[SyncManager] 任务同步失败:', task, error);
        await this.handleTaskFailure(task, error as Error);
      }
    }

    this.isSyncing = false;
    this.emit('status:change', this.getStatus());
  }

  /**
   * 执行同步任务
   */
  private async executeTask(task: SyncTask): Promise<void> {
    // 动态导入 API services（避免循环依赖）
    const { nodeApi } = await import('../../services/api/node-api');
    
    // 根据 entity 类型调用对应的 API
    switch (task.entity) {
      case 'node':
        await this.executeNodeTask(task, nodeApi);
        break;
      
      // TODO: 添加其他实体类型
      // case 'thread':
      //   await this.executeThreadTask(task, threadApi);
      //   break;
      // case 'element':
      //   await this.executeElementTask(task, elementApi);
      //   break;
      
      default:
        console.warn('[SyncManager] 未知的实体类型:', task.entity);
        // 模拟 API 调用
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * 执行节点同步任务
   */
  private async executeNodeTask(task: SyncTask, nodeApi: typeof import('../../services/api/node-api').nodeApi): Promise<void> {
    switch (task.type) {
      case 'create':
        if (task.data && typeof task.data === 'object' && 'title' in task.data) {
          // 类型断言为 CreateNodeDto
          const createData = task.data as import('../../services/api/node-api').CreateNodeDto;
          await nodeApi.createNode(createData);
        } else {
          throw new Error('Invalid node data for create');
        }
        break;
      
      case 'update':
        if (task.data && typeof task.data === 'object') {
          const updateData = task.data as import('../../services/api/node-api').UpdateNodeDto;
          await nodeApi.updateNode(task.localId, updateData);
        } else {
          throw new Error('Invalid node data for update');
        }
        break;
      
      case 'delete':
        await nodeApi.deleteNode(task.localId);
        break;
    }
    
    console.log('[SyncManager] Node API 调用成功:', task.type, task.localId);
  }

  /**
   * 处理任务失败
   */
  private async handleTaskFailure(task: SyncTask, error: Error) {
    task.retryCount++;
    task.error = error.message;

    if (task.retryCount >= this.maxRetries) {
      // 达到最大重试次数：标记为失败
      task.status = 'failed';
      this.queue.shift();

      // 更新本地状态为失败
      await this.updateLocalSyncStatus(task, 'failed');

      // 更新持久化队列
      await this.updateTaskInDB(task);

      console.error('[SyncManager] 任务最终失败:', task);
      this.emit('sync:failed', { task, error });
    } else {
      // 重试：延迟后重新加入队列
      const delay = this.retryDelays[task.retryCount - 1];

      setTimeout(() => {
        task.status = 'pending';
        this.queue.shift();
        this.queue.push(task); // 加到队尾
        this.processSyncQueue();
      }, delay);

      console.log(
        `[SyncManager] 将在 ${delay}ms 后重试 (${task.retryCount}/${this.maxRetries})`
      );
    }
  }

  /**
   * 更新本地数据的同步状态
   */
  private async updateLocalSyncStatus(
    task: SyncTask,
    status: 'synced' | 'failed' = 'synced'
  ) {
    try {
      // TODO: 更新本地 SQLite 对应表的 sync_status 字段
      // await db[task.entity].update({
      //   where: { id: task.localId },
      //   data: { syncStatus: status }
      // });
      console.log('[SyncManager] 本地状态已更新:', task.entity, task.localId, status);
    } catch (error) {
      console.error('[SyncManager] 更新本地状态失败:', error);
    }
  }

  /**
   * 从 SQLite 删除任务
   */
  private async deleteTaskFromDB(taskId: string) {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repository');
      await syncQueueRepository.deleteTask(taskId);
    } catch (error) {
      console.error('[SyncManager] 删除任务失败:', error);
    }
  }

  /**
   * 更新 SQLite 中的任务状态
   */
  private async updateTaskInDB(task: SyncTask) {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repository');
      await syncQueueRepository.updateTask(task);
    } catch (error) {
      console.error('[SyncManager] 更新任务失败:', error);
    }
  }

  /**
   * 获取队列状态
   */
  getStatus(): SyncManagerStatus {
    return {
      total: this.queue.length,
      pending: this.queue.filter((t) => t.status === 'pending').length,
      syncing: this.queue.filter((t) => t.status === 'syncing').length,
      failed: this.queue.filter((t) => t.status === 'failed').length,
      completed: 0, // 已完成的任务已出队，这里为 0
      isSyncing: this.isSyncing,
      isOnline: this.isOnline,
      lastSyncTime: this.lastSyncTime,
    };
  }

  /**
   * 清空队列
   */
  async clearQueue() {
    this.queue = [];
    // TODO: await db.syncQueue.deleteMany({ where: { status: 'pending' } });
    console.log('[SyncManager] 队列已清空');
  }

  /**
   * 手动触发同步
   */
  async syncNow() {
    if (!this.isOnline) {
      throw new Error('当前离线，无法同步');
    }
    await this.processSyncQueue();
  }

  /**
   * 事件监听
   */
  on(event: SyncEventType, handler: SyncEventHandler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * 移除事件监听
   */
  off(event: SyncEventType, handler: SyncEventHandler) {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * 触发事件
   */
  private emit(event: SyncEventType, data: unknown) {
    this.eventHandlers.get(event)?.forEach((handler) => handler(data));
  }

  /**
   * 销毁 SyncManager
   */
  destroy() {
    window.removeEventListener('online', this.handleOnline.bind(this));
    window.removeEventListener('offline', this.handleOffline.bind(this));
    this.eventHandlers.clear();
  }
}

// 单例模式：全局唯一的 SyncManager 实例
export const syncManager = new SyncManager();
