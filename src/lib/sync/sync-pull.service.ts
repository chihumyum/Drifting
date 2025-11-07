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

// 同步状态
interface SyncStats {
  totalPulled: number;
  totalPushed: number;
  conflicts: number;
  errors: number;
}

class SyncPullService {
  private isSyncing = false;
  private lastSyncTime: number = 0;

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

    try {
      console.log('[SyncPull] Starting initial sync from server...');

      // TODO: 当其他 API 服务实现后，添加更多实体的同步
      // 目前 nodeApi.getNodesByProject 需要 projectId，暂时跳过具体实现
      // 等后端提供 getAllNodes 接口后再实现

      // 示例：如果有项目列表
      try {
        // const projects = await projectApi.getMyProjects();
        // for (const project of projects) {
        //   const nodes = await nodeApi.getNodesByProject(project.id);
        //   stats.totalPulled += nodes.length;
        // }
        
        console.log('[SyncPull] Node sync will be implemented when API is ready');
      } catch (error) {
        console.error('[SyncPull] Error syncing nodes:', error);
        stats.errors++;
      }

      this.lastSyncTime = Date.now();
      console.log('[SyncPull] Initial sync completed ✅', stats);

      return stats;
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
}

export const syncPullService = new SyncPullService();
