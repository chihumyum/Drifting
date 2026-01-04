/**
 * Hybrid Repository 基类
 * 
 * 实现本地优先（Local-First）+ 云端同步策略：
 * 1. 所有写操作先写本地 SQLite（立即响应）
 * 2. 根据条件异步同步到服务器（后台执行）
 * 3. 读操作优先从本地读取
 */

import { syncManager } from './sync-manager';
import type { SyncTaskEntity } from './types';

export interface HybridRepositoryConfig {
  entity: SyncTaskEntity;
  isAuthenticated: () => boolean;
}

export abstract class HybridRepository<T, CreateInput, UpdateInput> {
  protected entity: SyncTaskEntity;
  protected isAuthenticated: () => boolean;

  constructor(config: HybridRepositoryConfig) {
    this.entity = config.entity;
    this.isAuthenticated = config.isAuthenticated;
  }

  /**
   * 创建实体
   */
  async create(input: CreateInput): Promise<T> {
    // 1. 先写本地（立即响应）
    const localEntity = await this.createLocal(input);

    // 2. 决定是否同步到服务器
    if (this.shouldSync()) {
      syncManager.enqueue({
        type: 'create',
        entity: this.entity,
        localId: this.getEntityId(localEntity),
        projectId: this.getProjectId(localEntity),
        data: input,
        priority: 'normal',
      });
    }

    return localEntity;
  }

  /**
   * 更新实体
   */
  async update(id: string, input: UpdateInput): Promise<T> {
    // 1. 先更新本地
    const localEntity = await this.updateLocal(id, input);

    // 2. 决定是否同步
    if (this.shouldSync()) {
      syncManager.enqueue({
        type: 'update',
        entity: this.entity,
        localId: id,
        projectId: this.getProjectId(localEntity),
        data: input,
        priority: 'normal',
      });
    }

    return localEntity;
  }

  /**
   * 删除实体
   */
  async delete(id: string): Promise<void> {
    // 1. 先本地删除（软删除）
    await this.deleteLocal(id);

    // 2. 决定是否同步删除
    if (this.shouldSync()) {
      syncManager.enqueue({
        type: 'delete',
        entity: this.entity,
        localId: id,
        priority: 'normal',
      });
    }
  }

  /**
   * 查找单个实体
   */
  async findById(id: string): Promise<T | null> {
    // 优先从本地读取
    const localEntity = await this.findByIdLocal(id);

    if (!localEntity && this.shouldSync()) {
      try {
        const remoteEntity = await this.fetchRemoteById(id);
        if (remoteEntity) {
          await this.mergeRemoteEntity(remoteEntity);
          return remoteEntity;
        }
      } catch (error) {
        console.warn('[HybridRepository] Failed to fetch remote entity by id:', error);
      }
    }

    return localEntity;
  }

  /**
   * 查找所有实体
   */
  async findAll(projectId: string): Promise<T[]> {
    // 1. 先返回本地数据（快速响应）
    const localEntities = await this.findAllLocal(projectId);

    if (this.shouldSync()) {
      this.fetchRemoteAll(projectId)
        .then(async (remoteEntities) => {
          if (remoteEntities.length === 0) return;
          await this.mergeRemoteEntities(remoteEntities);
        })
        .catch((error) => {
          console.warn('[HybridRepository] Failed to fetch remote collection:', error);
        });
    }

    return localEntities;
  }

  /**
   * 决定是否同步到服务器
   */
  protected shouldSync(): boolean {
    const isOnline = navigator.onLine;
    const isAuthenticated = this.isAuthenticated();

    // 简单决策：已登录 + 在线 = 自动同步
    return isAuthenticated && isOnline;
  }

  // ========================================
  // 子类需要实现的抽象方法
  // ========================================

  /**
   * 在本地 SQLite 创建实体
   */
  protected abstract createLocal(input: CreateInput): Promise<T>;

  /**
   * 在本地 SQLite 更新实体
   */
  protected abstract updateLocal(id: string, input: UpdateInput): Promise<T>;

  /**
   * 在本地 SQLite 删除实体（软删除）
   */
  protected abstract deleteLocal(id: string): Promise<void>;

  /**
   * 从本地 SQLite 查找实体
   */
  protected abstract findByIdLocal(id: string): Promise<T | null>;

  /**
   * 从本地 SQLite 查找所有实体
   */
  protected abstract findAllLocal(projectId: string): Promise<T[]>;

  /**
   * 获取实体的 ID
   */
  protected abstract getEntityId(entity: T): string;

  /**
   * 获取实体关联的 projectId（如果有）
   */
  protected abstract getProjectId(entity: T): string | undefined;

  /**
   * 可选：从服务器加载单个实体
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async fetchRemoteById(_id: string): Promise<T | null> {
    return null;
  }

  /**
   * 可选：从服务器加载指定项目的实体集合
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async fetchRemoteAll(_projectId: string): Promise<T[]> {
    return [];
  }

  /**
   * 合并单个远程实体到本地（子类可覆盖实现）
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async mergeRemoteEntity(_entity: T): Promise<void> {
    // 默认不做处理，由子类实现具体合并逻辑
  }

  /**
   * 合并多个远程实体到本地（子类可覆盖实现）
   */
  protected async mergeRemoteEntities(entities: T[]): Promise<void> {
    for (const entity of entities) {
      // eslint-disable-next-line no-await-in-loop
      await this.mergeRemoteEntity(entity);
    }
  }
}
