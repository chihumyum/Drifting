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
import { APP_CONFIG, debugLog } from '../config';
import type { BookNode } from '../../domain/book-node';
import type { CreateNodeDto, UpdateNodeDto } from '../../services/api/node-api';
import { createTraceId, runWithSyncTraceId } from '../trace';
import type {
  SyncTask,
  SyncTaskInput,
  SyncManagerStatus,
  SyncEventType,
  SyncStatus,
} from './types';
import loglevel from "loglevel";

const log = loglevel.getLogger("SyncManager");
log.setLevel(loglevel.levels.ERROR);

type SyncEventHandler = (...args: unknown[]) => void;

export class SyncManager {
  private queue: SyncTask[] = [];
  private isSyncing = false;
  private isOnline = navigator.onLine;
  private maxRetries = 3;
  private retryDelays = [1000, 5000, 15000]; // 1s, 5s, 15s
  private eventHandlers: Map<SyncEventType, Set<SyncEventHandler>> = new Map();
  private lastSyncTime: number | null = null;
  private readonly handleOnlineListener = () => this.handleOnline();
  private readonly handleOfflineListener = () => this.handleOffline();
  private predictiveCleanup: (() => void) | null = null;
  private history: Array<{ timestamp: number; type: 'push' | 'pull'; task?: SyncTask; detail?: string }> = [];
  private localOnlyMode = APP_CONFIG.LOCAL_ONLY_MODE;

  constructor() {
    if (!this.localOnlyMode) {
      this.initialize();
    } else {
      debugLog('SyncManager disabled - running in local-only mode');
    }
  }

  /**
   * 初始化 SyncManager
   */
  private initialize() {
    // 监听网络状态变化
    window.addEventListener('online', this.handleOnlineListener);
    window.addEventListener('offline', this.handleOfflineListener);

    // 从 SQLite 恢复未完成的任务
    this.restoreSyncQueue();

    // 预测性同步调度
    this.schedulePredictiveSync();
  }

  /**
   * 网络恢复在线
   */
  private handleOnline() {
    log.debug('[SyncManager] 网络已连接');
    this.isOnline = true;
    this.processSyncQueue();
  }

  /**
   * 网络断开
   */
  private handleOffline() {
    log.debug('[SyncManager] 网络已断开');
    this.isOnline = false;
  }

  /**
 * 从 SQLite 恢复队列
 */
  private async restoreSyncQueue(): Promise<void> {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repo');
      const tasks = await syncQueueRepository.getPendingTasks();
      this.queue = tasks;
      log.debug(`[SyncManager] 恢复了 ${tasks.length} 个待同步任务`);
    } catch (error) {
      log.error('[SyncManager] 恢复队列失败:', error);
    }
  }

  private recordHistoryEntry(entry: { type: 'push' | 'pull'; task?: SyncTask; detail?: string }) {
    this.history.push({ timestamp: Date.now(), ...entry });
    if (this.history.length > 200) {
      this.history.splice(0, this.history.length - 200);
    }
  }

  /**
   * 设置预测性同步（定时与前台事件驱动）
   */
  private schedulePredictiveSync() {
    const triggerSync = () => {
      if (!this.isOnline || this.isSyncing || this.queue.length === 0) return;
      if (document.visibilityState !== 'visible') return;
      this.processSyncQueue();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        triggerSync();
      }
    };

    const handleFocus = () => {
      triggerSync();
    };

    const intervalId = window.setInterval(triggerSync, 60_000);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);

    this.predictiveCleanup = () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
    };
  }

  /**
   * 添加任务到队列
   */
  enqueue(input: SyncTaskInput): string {
    // In local-only mode, skip sync and return a dummy task ID
    if (this.localOnlyMode) {
      debugLog('SyncManager.enqueue: skipped in local-only mode', input);
      return 'local-' + nanoid();
    }

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
      log.debug('[SyncManager] 更新现有任务:', task.entity, task.localId);
      return this.queue[existingIndex].id;
    }

    // 按优先级插入队列
    this.insertByPriority(task);

    // 持久化到 SQLite
    this.persistTask(task);

    log.debug('[SyncManager] 任务已入队:', task);

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
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repo');
      await syncQueueRepository.saveTask(task);
    } catch (error) {
      log.error('[SyncManager] 持久化任务失败:', error);
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
      log.debug('[SyncManager] 离线状态，暂停同步');
      return;
    }

    // 检查队列是否为空
    if (this.queue.length === 0) {
      this.emit('queue:empty', null);
      return;
    }

    this.isSyncing = true;
    this.emit('status:change', this.getStatus());

    const traceId = createTraceId();
    await runWithSyncTraceId(traceId, async () => {
      // 处理队列中的任务
      while (this.queue.length > 0 && this.isOnline) {
        const task = this.queue[0];

        try {
          log.debug('[SyncManager] 开始同步任务:', task);
          task.status = 'syncing';
          await this.updateLocalSyncStatus(task, 'syncing');
          this.emit('sync:start', task);

          // 执行同步任务
          const result = await this.executeTask(task);

          // 成功：移除任务
          task.status = 'completed';
          this.queue.shift();
          this.lastSyncTime = Date.now();

          // 更新本地 SQLite 的同步状态
          const updatedAt =
            result && typeof result === 'object' && 'updatedAt' in result && typeof result.updatedAt === 'string'
              ? result.updatedAt
              : undefined;
          const metadataOptions = {
            ...(updatedAt ? { updatedAt } : {}),
            ...(task.type === 'delete' ? { isDeleted: true } : {}),
          } as { updatedAt?: string; isDeleted?: boolean };
          await this.updateLocalSyncStatus(
            task,
            'synced',
            Object.keys(metadataOptions).length > 0 ? metadataOptions : undefined,
          );

          // 从持久化队列中删除
          await this.deleteTaskFromDB(task.id);

          log.debug('[SyncManager] 任务同步成功:', task);
          this.emit('sync:success', task);
          this.recordHistoryEntry({ type: 'push', task: { ...task } });
        } catch (error) {
          log.error('[SyncManager] 任务同步失败:', task, error);
          await this.handleTaskFailure(task, error as Error);
        }
      }
    });

    this.isSyncing = false;
    this.emit('status:change', this.getStatus());
  }

  /**
   * 执行同步任务
   */
  private async executeTask(task: SyncTask): Promise<{ updatedAt?: string } | void> {
    // 动态导入 API services（避免循环依赖）
    const apis = await import('../../services/api');

    // 验证 projectId
    if (!task.projectId && task.entity !== 'project') {
      throw new Error(`[SyncManager] projectId is required for ${task.entity} sync`);
    }

    // 根据 entity 类型调用对应的 API
    switch (task.entity) {
      case 'node':
        return this.executeNodeTask(task, apis.nodeApi);

      case 'content':
        await this.executeContentTask(task, apis.nodeApi);
        break;

      case 'storyline':
        await this.executeStorylineTask(task, apis.storylinesApi);
        break;

      case 'element':
        await this.executeElementTask(task, apis.elementsApi);
        break;

      case 'element_category':
        await this.executeCategoryTask(task, apis.elementsApi);
        break;

      case 'project':
        await this.executeProjectTask(task, apis.projectsApi);
        break;

      default:
        log.warn('[SyncManager] 未知的实体类型:', task.entity);
        // 模拟 API 调用
        await new Promise((resolve) => setTimeout(resolve, 100));
        return undefined;
    }
  }

  private async executeContentTask(
    task: SyncTask,
    nodeApi: typeof import('../../services/api/node-api').nodeApi,
  ): Promise<void> {
    const projectId = task.projectId!;
    const nodeId = task.localId;

    if (task.type === 'delete') {
      // Content is currently not deletable independently; skip.
      return;
    }

    if (!task.data || typeof task.data !== 'object') {
      throw new Error('Invalid content data');
    }

    const data = task.data as { pmJson?: unknown; outline?: string; contentText?: string };
    await nodeApi.updateContent(projectId, nodeId, {
      ...(data.pmJson !== undefined ? { pmJson: data.pmJson } : {}),
      ...(data.outline !== undefined ? { outline: data.outline } : {}),
      ...(data.contentText !== undefined ? { contentText: data.contentText } : {}),
    });
  }

  /**
   * 执行节点同步任务
   */
  private async executeNodeTask(
    task: SyncTask,
    nodeApi: typeof import('../../services/api/node-api').nodeApi
  ): Promise<BookNode | void> {
    const projectId = task.projectId!;

    switch (task.type) {
      case 'create':
        if (task.data && typeof task.data === 'object') {
          const createData = this.toCreateNodeDto(task.data as Partial<BookNode>);
          return nodeApi.create(projectId, createData);
        } else {
          throw new Error('Invalid node data for create');
        }
        break;

      case 'update':
        if (task.data && typeof task.data === 'object') {
          const updateData = this.toUpdateNodeDto(task.data as Partial<BookNode>);
          return nodeApi.update(projectId, task.localId, updateData);
        } else {
          throw new Error('Invalid node data for update');
        }
        break;

      case 'delete':
        await nodeApi.delete(projectId, task.localId);
        break;
    }

    log.debug('[SyncManager] Node API 调用成功:', task.type, task.localId);
    return undefined;
  }

  /**
   * 执行故事线同步任务
   */
  private async executeStorylineTask(task: SyncTask, storylinesApi: typeof import('../../services/api/storylines-api').storylinesApi): Promise<void> {
    const projectId = task.projectId!;

    switch (task.type) {
      case 'create':
        if (task.data && typeof task.data === 'object' && 'name' in task.data) {
          const createData = task.data as import('../../services/api/storylines-api').CreateStorylineDto;
          await storylinesApi.create(projectId, createData);
        } else {
          throw new Error('Invalid storyline data for create');
        }
        break;

      case 'update':
        if (task.data && typeof task.data === 'object') {
          const updateData = task.data as import('../../services/api/storylines-api').UpdateStorylineDto;
          await storylinesApi.update(projectId, task.localId, updateData);
        } else {
          throw new Error('Invalid storyline data for update');
        }
        break;

      case 'delete':
        await storylinesApi.delete(projectId, task.localId);
        break;
    }

    log.debug('[SyncManager] Storyline API 调用成功:', task.type, task.localId);
  }

  /**
   * 执行元素同步任务
   */
  private async executeElementTask(task: SyncTask, elementsApi: typeof import('../../services/api/elements-api').elementsApi): Promise<void> {
    const projectId = task.projectId!;

    const getErrorStatus = (error: unknown): number | undefined => {
      if (!error || typeof error !== 'object') return undefined;
      const maybeAny = error as { response?: { status?: unknown } };
      const status = maybeAny.response?.status;
      return typeof status === 'number' ? status : undefined;
    };

    const createFromLocalIfPossible = async (): Promise<boolean> => {
      const { createBookElementSqliteRepository } = await import('../../repositories/book_element_sqlite');
      const localRepo = createBookElementSqliteRepository(projectId);
      const local = await localRepo.findById(task.localId);
      if (!local) return false;

      const description = (() => {
        try {
          const parsed = local.summary ? JSON.parse(local.summary) : undefined;
          return typeof parsed?.description === 'string' ? parsed.description : undefined;
        } catch {
          return undefined;
        }
      })();

      const metadata = (() => {
        try {
          return local.contentJson ? JSON.parse(local.contentJson) : undefined;
        } catch {
          return undefined;
        }
      })();

      await elementsApi.create(projectId, {
        id: local.id,
        name: local.name,
        categoryName: local.categoryId ?? undefined,
        description,
        metadata,
      });
      return true;
    };

    switch (task.type) {
      case 'create':
        if (task.data && typeof task.data === 'object' && 'name' in task.data) {
          const createData = task.data as import('../../services/api/elements-api').CreateElementDto;
          await elementsApi.create(projectId, createData);
        } else {
          throw new Error('Invalid element data for create');
        }
        break;

      case 'update':
        if (task.data && typeof task.data === 'object') {
          const updateData = task.data as import('../../services/api/elements-api').UpdateElementDto;
          try {
            await elementsApi.update(projectId, task.localId, updateData);
          } catch (error) {
            const status = getErrorStatus(error);
            if (status === 404) {
              // Local-first: if server doesn't have the element yet (seeded locally / lost create), create it from local state.
              const created = await createFromLocalIfPossible();
              if (created) return;
            }
            throw error;
          }
        } else {
          throw new Error('Invalid element data for update');
        }
        break;

      case 'delete':
        try {
          await elementsApi.delete(projectId, task.localId);
        } catch (error) {
          const status = getErrorStatus(error);
          // Idempotent delete: if already missing on server, treat as success.
          if (status !== 404) throw error;
        }
        break;
    }

    log.debug('[SyncManager] Element API 调用成功:', task.type, task.localId);
  }

  /**
   * 执行分类同步任务
   */
  private async executeCategoryTask(task: SyncTask, elementsApi: typeof import('../../services/api/elements-api').elementsApi): Promise<void> {
    const projectId = task.projectId!;

    switch (task.type) {
      case 'create':
        if (task.data && typeof task.data === 'object' && 'name' in task.data) {
          const createData = task.data as import('../../services/api/elements-api').CreateCategoryDto;
          await elementsApi.createCategory(projectId, createData);
        } else {
          throw new Error('Invalid category data for create');
        }
        break;

      case 'update':
        if (task.data && typeof task.data === 'object') {
          const updateData = task.data as import('../../services/api/elements-api').UpdateCategoryDto;
          await elementsApi.updateCategory(projectId, task.localId, updateData);
        } else {
          throw new Error('Invalid category data for update');
        }
        break;

      case 'delete':
        await elementsApi.deleteCategory(projectId, task.localId);
        break;
    }

    log.debug('[SyncManager] Category API 调用成功:', task.type, task.localId);
  }

  /**
   * 执行项目同步任务
   */
  private async executeProjectTask(task: SyncTask, projectsApi: typeof import('../../services/api/projects-api').projectsApi): Promise<void> {
    switch (task.type) {
      case 'create':
        if (task.data && typeof task.data === 'object' && 'title' in task.data) {
          const createData = task.data as import('../../services/api/projects-api').CreateProjectDto;
          await projectsApi.create(createData);
        } else {
          throw new Error('Invalid project data for create');
        }
        break;

      case 'update':
        if (task.data && typeof task.data === 'object') {
          const updateData = task.data as import('../../services/api/projects-api').UpdateProjectDto;
          await projectsApi.update(task.localId, updateData);
        } else {
          throw new Error('Invalid project data for update');
        }
        break;

      case 'delete':
        await projectsApi.delete(task.localId);
        break;
    }

    log.debug('[SyncManager] Project API 调用成功:', task.type, task.localId);
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

      log.error('[SyncManager] 任务最终失败:', task);
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

      log.debug(
        `[SyncManager] 将在 ${delay}ms 后重试 (${task.retryCount}/${this.maxRetries})`
      );
    }
  }

  /**
   * 更新本地数据的同步状态
   */
  private async updateLocalSyncStatus(
    task: SyncTask,
    status: SyncStatus = 'synced',
    options?: { updatedAt?: string; isDeleted?: boolean }
  ) {
    return // TODO: implememnt later with backend
    try {
      switch (task.entity) {
        case 'node': {
          const { markNodeSyncStatus } = await import('../../repositories/book_node_sqlite');
          await markNodeSyncStatus(task.localId, status, options);
          break;
        }
        case 'content': {
          const { markContentSyncStatus } = await import('../../repositories/book_content_sqlite');
          await markContentSyncStatus(task.localId, status, options);
          break;
        }
        case 'storyline': {
          const { markStorylineSyncStatus } = await import('../../repositories/storyline_sqlite');
          await markStorylineSyncStatus(task.localId, status, options);
          break;
        }
        case 'element': {
          const { markElementSyncStatus } = await import('../../repositories/book_element_sqlite');
          await markElementSyncStatus(task.localId, status, options);
          break;
        }
        case 'element_category': {
          const { markElementCategorySyncStatus } = await import('../../repositories/book_element_sqlite');
          await markElementCategorySyncStatus(task.localId, status, options);
          break;
        }
        default:
          log.debug('[SyncManager] 未实现的本地状态更新实体:', task.entity);
      }
      log.debug('[SyncManager] 本地状态已更新:', task.entity, task.localId, status);
    } catch (error) {
      log.error('[SyncManager] 更新本地状态失败:', error);
    }
  }

  /**
   * 从 SQLite 删除任务
   */
  private async deleteTaskFromDB(taskId: string) {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repo');
      await syncQueueRepository.deleteTask(taskId);
    } catch (error) {
      log.error('[SyncManager] 删除任务失败:', error);
    }
  }

  /**
   * 更新 SQLite 中的任务状态
   */
  private async updateTaskInDB(task: SyncTask) {
    try {
      const { syncQueueRepository } = await import('../../repositories/sync-queue-repo');
      await syncQueueRepository.updateTask(task);
    } catch (error) {
      log.error('[SyncManager] 更新任务失败:', error);
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

  reportConflict(conflict: { entity: SyncTask['entity']; localId: string; description?: string }) {
    const payload = { ...conflict, timestamp: Date.now() };
    this.recordHistoryEntry({
      type: 'push',
      detail: `conflict:${conflict.entity}:${conflict.localId}`,
    });
    this.emit('sync:conflict', payload);
  }

  recordPull(detail: string) {
    this.recordHistoryEntry({ type: 'pull', detail });
    this.emit('status:change', this.getStatus());
  }

  getHistory(limit = 50) {
    return this.history.slice(-limit);
  }

  getAnalytics() {
    const totalsByEntity: Record<string, number> = {};
    for (const task of this.queue) {
      totalsByEntity[task.entity] = (totalsByEntity[task.entity] ?? 0) + 1;
    }
    const averageRetryCount = this.queue.length
      ? this.queue.reduce((sum, t) => sum + t.retryCount, 0) / this.queue.length
      : 0;

    return {
      status: this.getStatus(),
      queueByEntity: totalsByEntity,
      averageRetryCount,
      history: this.getHistory(10),
    };
  }

  async exportBackup() {
    const { query } = await import('../db');
    const [nodes, storylines, elements, categories] = await Promise.all([
      query<Record<string, unknown>>('SELECT * FROM story_node'),
      query<Record<string, unknown>>('SELECT * FROM story_thread'),
      query<Record<string, unknown>>('SELECT * FROM element'),
      query<Record<string, unknown>>('SELECT * FROM element_category'),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      status: this.getStatus(),
      counts: {
        nodes: nodes.length,
        storylines: storylines.length,
        elements: elements.length,
        categories: categories.length,
      },
      nodes,
      storylines,
      elements,
      categories,
    };
  }

  async triggerBackupDownload(filename = 'drifting-backup.json') {
    const backup = await this.exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /**
   * 清空队列
   */
  async clearQueue() {
    this.queue = [];
    // TODO: await db.syncQueue.deleteMany({ where: { status: 'pending' } });
    log.debug('[SyncManager] 队列已清空');
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
    window.removeEventListener('online', this.handleOnlineListener);
    window.removeEventListener('offline', this.handleOfflineListener);
    this.predictiveCleanup?.();
    this.eventHandlers.clear();
  }

  private toCreateNodeDto(node: Partial<BookNode>): CreateNodeDto {
    if (!node.title) {
      throw new Error('Create node payload missing title');
    }

    const dto: CreateNodeDto = {
      id: node.id,
      title: node.title,
      start: node.start ?? Date.now(),
    };

    if (typeof node.end === 'number') dto.end = node.end;
    if (typeof node.summary === 'string') dto.summary = node.summary;
    if (node.summary === '') dto.summary = '';
    if (typeof node.storyStageId === 'string') dto.storyStageId = node.storyStageId;
    if (node.position) {
      if (typeof node.position.x === 'number') dto.posX = node.position.x;
      if (typeof node.position.y === 'number') dto.posY = node.position.y;
    }

    return dto;
  }

  private toUpdateNodeDto(node: Partial<BookNode>): UpdateNodeDto {
    const dto: UpdateNodeDto = {};

    if (typeof node.title === 'string') dto.title = node.title;
    if (typeof node.start === 'number') dto.start = node.start;
    if (typeof node.end === 'number') dto.end = node.end;
    if (typeof node.summary === 'string') dto.summary = node.summary;
    if (node.summary === '') dto.summary = '';
    if (node.summary === null) dto.summary = '';
    if (typeof node.storyStageId === 'string') dto.storyStageId = node.storyStageId;
    if (node.position) {
      if (typeof node.position.x === 'number') dto.posX = node.position.x;
      if (typeof node.position.y === 'number') dto.posY = node.position.y;
    }

    return dto;
  }
}

// 单例模式：全局唯一的 SyncManager 实例
export const syncManager = new SyncManager();
