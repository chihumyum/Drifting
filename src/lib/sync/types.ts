/**
 * 同步任务类型定义
 */

export type SyncTaskType = 'create' | 'update' | 'delete';
export type SyncTaskEntity =
  | 'node'
  | 'thread'
  | 'element'
  | 'element_category'
  | 'project'
  | 'node_edge'
  | 'stage'
  | 'tag';

export type SyncTaskPriority = 'high' | 'normal' | 'low';
export type SyncTaskStatus = 'pending' | 'syncing' | 'completed' | 'failed';
export type SyncStatus = 'synced' | 'pending' | 'failed';

/**
 * 同步任务接口
 */
export interface SyncTask {
  id: string;
  type: SyncTaskType;
  entity: SyncTaskEntity;
  localId: string;
  projectId?: string;
  data?: unknown;
  priority: SyncTaskPriority;
  retryCount: number;
  status: SyncTaskStatus;
  createdAt: number;
  error?: string;
}

/**
 * 创建同步任务的输入
 */
export interface SyncTaskInput {
  type: SyncTaskType;
  entity: SyncTaskEntity;
  localId: string;
  projectId?: string;
  data?: unknown;
  priority?: SyncTaskPriority;
}

/**
 * 同步状态接口
 */
export interface SyncManagerStatus {
  total: number;
  pending: number;
  syncing: number;
  failed: number;
  completed: number;
  isSyncing: boolean;
  isOnline: boolean;
  lastSyncTime: number | null;
}

/**
 * 同步事件类型
 */
export type SyncEventType =
  | 'sync:start'
  | 'sync:success'
  | 'sync:failed'
  | 'sync:conflict'
  | 'queue:empty'
  | 'status:change';

/**
 * 同步事件处理器
 */
export type SyncEventHandler = (data: unknown) => void;
