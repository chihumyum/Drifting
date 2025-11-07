/**
 * Sync Queue Repository
 * 
 * 管理 SQLite sync_queue 表的 CRUD 操作
 * 用于持久化同步任务队列
 */

import { query, run } from '../lib/db';
import type { SyncTask, SyncTaskStatus } from '../lib/sync/types';

/**
 * Sync Queue Repository
 */
export const syncQueueRepository = {
  /**
   * 保存同步任务到队列
   */
  async saveTask(task: SyncTask): Promise<void> {
    await run(
      `INSERT OR REPLACE INTO sync_queue 
       (id, type, entity, local_id, project_id, data, priority, retry_count, max_retries, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?)`,
      [
        task.id,
        task.type,
        task.entity,
        task.localId,
        task.projectId ?? null,
        JSON.stringify(task.data),
        task.priority,
        task.retryCount,
        task.status,
        task.error ?? null,
        task.createdAt,
        Date.now(), // updated_at
      ]
    );
  },

  /**
   * 获取所有待处理的任务
   */
  async getPendingTasks(): Promise<SyncTask[]> {
    const rows = await query<{
      id: string;
      type: string;
      entity: string;
      local_id: string;
      project_id: string | null;
      data: string | null;
      priority: string;
      retry_count: number;
      status: string;
      error: string | null;
      created_at: number;
    }>(
      `SELECT * FROM sync_queue 
       WHERE status IN ('pending', 'syncing')
       ORDER BY 
         CASE priority 
           WHEN 'high' THEN 1 
           WHEN 'normal' THEN 2 
           WHEN 'low' THEN 3 
         END,
         created_at ASC`
    );

    return rows.map((row) => ({
      id: row.id,
      type: row.type as SyncTask['type'],
      entity: row.entity as SyncTask['entity'],
      localId: row.local_id,
      projectId: row.project_id ?? undefined,
      data: row.data ? JSON.parse(row.data) : undefined,
      priority: row.priority as SyncTask['priority'],
      retryCount: row.retry_count,
      status: row.status as SyncTaskStatus,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    }));
  },

  /**
   * 更新任务状态
   */
  async updateTask(task: SyncTask): Promise<void> {
    await run(
      `UPDATE sync_queue 
       SET retry_count = ?, status = ?, error = ?, updated_at = ?
       WHERE id = ?`,
      [task.retryCount, task.status, task.error ?? null, Date.now(), task.id]
    );
  },

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<void> {
    await run(`DELETE FROM sync_queue WHERE id = ?`, [taskId]);
  },

  /**
   * 获取队列统计信息
   */
  async getQueueStats(): Promise<{
    total: number;
    pending: number;
    syncing: number;
    failed: number;
  }> {
    const rows = await query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM sync_queue GROUP BY status`
    );

    const stats = {
      total: 0,
      pending: 0,
      syncing: 0,
      failed: 0,
    };

    for (const row of rows) {
      stats.total += row.count;
      if (row.status === 'pending') stats.pending = row.count;
      if (row.status === 'syncing') stats.syncing = row.count;
      if (row.status === 'failed') stats.failed = row.count;
    }

    return stats;
  },

  /**
   * 清除已完成的任务
   */
  async clearCompletedTasks(): Promise<void> {
    await run(`DELETE FROM sync_queue WHERE status = 'completed'`);
  },

  /**
   * 清除失败的任务
   */
  async clearFailedTasks(): Promise<void> {
    await run(`DELETE FROM sync_queue WHERE status = 'failed'`);
  },
};
