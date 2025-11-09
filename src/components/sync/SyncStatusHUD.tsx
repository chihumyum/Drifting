import { useEffect } from 'react';
import { syncManager } from '../../lib/sync/sync-manager';
import { syncPullService } from '../../lib/sync/sync-pull.service';
import type { SyncManagerStatus, SyncTask } from '../../lib/sync/types';
import { useSyncStatusStore } from '../../store/sync-status';

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 16,
  right: 16,
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 320,
};

const cardStyle: React.CSSProperties = {
  background: 'rgba(28, 24, 20, 0.92)',
  color: '#fefdfb',
  borderRadius: 12,
  padding: '12px 16px',
  boxShadow: '0 8px 20px rgba(0,0,0,0.2)',
  fontSize: 14,
  lineHeight: 1.5,
};

const closeButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#fefdfb',
  cursor: 'pointer',
  fontSize: 14,
  marginLeft: 'auto',
};

const progressBackground: React.CSSProperties = {
  width: '100%',
  height: 6,
  background: 'rgba(255,255,255,0.2)',
  borderRadius: 999,
  overflow: 'hidden',
  marginTop: 6,
};

const progressBar: React.CSSProperties = {
  height: '100%',
  background: '#b89968',
  borderRadius: 999,
  transition: 'width 0.3s ease',
};

const toastVariantColors: Record<string, string> = {
  info: 'rgba(184, 153, 104, 0.9)',
  success: 'rgba(76, 175, 80, 0.9)',
  error: 'rgba(220, 53, 69, 0.95)',
  warning: 'rgba(255, 193, 7, 0.92)',
};

export function SyncStatusHUD() {
  const {
    status,
    offline,
    isPulling,
    toasts,
    conflicts,
    setStatus,
    setOffline,
    setIsPulling,
    pushToast,
    dismissToast,
    reportConflict,
    clearConflict,
  } = useSyncStatusStore((state) => ({
    status: state.status,
    offline: state.offline,
    isPulling: state.isPulling,
    toasts: state.toasts,
    conflicts: state.conflicts,
    setStatus: state.setStatus,
    setOffline: state.setOffline,
    setIsPulling: state.setIsPulling,
    pushToast: state.pushToast,
    dismissToast: state.dismissToast,
    reportConflict: state.reportConflict,
    clearConflict: state.clearConflict,
  }));

  useEffect(() => {
    const handleStatusChange = (payload: unknown) => {
      setStatus(payload as SyncManagerStatus);
    };

    const handleSyncSuccess = (task: unknown) => {
      const { entity } = (task as SyncTask) ?? { entity: '未知实体' };
      pushToast({ message: `已同步 ${entity}`, variant: 'success' });
    };

    const handleSyncFailed = (payload: unknown) => {
      const { task } = (payload as { task: SyncTask }) ?? {};
      pushToast({ message: `同步失败：${task?.entity ?? '未知'}`, variant: 'error' });
    };

    const handleConflict = (payload: unknown) => {
      const conflict = payload as { entity: SyncTask['entity']; localId: string; description?: string };
      reportConflict(conflict);
      pushToast({ message: '检测到冲突，已保留本地修改', variant: 'warning' });
    };

    const handleQueueEmpty = () => {
      pushToast({ message: '所有同步任务已完成', variant: 'success' });
    };

    const handlePullStart = (detail: unknown) => {
      setIsPulling(true);
      const payload = detail as { projectId?: string };
      pushToast({ message: `开始拉取 ${payload?.projectId ?? '项目'} 数据`, variant: 'info' });
    };

    const handlePullSuccess = (detail: unknown) => {
      setIsPulling(false);
      const payload = detail as { projectId?: string; stats?: SyncStats };
      pushToast({
        message: `同步完成 (${payload?.stats?.totalPulled ?? 0} 项更新)`,
        variant: 'success',
      });
    };

    const handlePullError = () => {
      setIsPulling(false);
      pushToast({ message: '拉取服务器数据失败', variant: 'error' });
    };

    const handleOnline = () => {
      setOffline(false);
      pushToast({ message: '已重新连接网络', variant: 'success' });
    };

    const handleOffline = () => {
      setOffline(true);
      pushToast({ message: '当前离线，变更将排队等待同步', variant: 'warning' });
    };

    syncManager.on('status:change', handleStatusChange);
    syncManager.on('sync:success', handleSyncSuccess);
    syncManager.on('sync:failed', handleSyncFailed);
    syncManager.on('sync:conflict', handleConflict);
    syncManager.on('queue:empty', handleQueueEmpty);

    syncPullService.on('pull:start', handlePullStart);
    syncPullService.on('pull:success', handlePullSuccess);
    syncPullService.on('pull:error', handlePullError);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    setStatus(syncManager.getStatus());
    if (!navigator.onLine) {
      setOffline(true);
    }

    return () => {
      syncManager.off('status:change', handleStatusChange);
      syncManager.off('sync:success', handleSyncSuccess);
      syncManager.off('sync:failed', handleSyncFailed);
      syncManager.off('sync:conflict', handleConflict);
      syncManager.off('queue:empty', handleQueueEmpty);

      syncPullService.off('pull:start', handlePullStart);
      syncPullService.off('pull:success', handlePullSuccess);
      syncPullService.off('pull:error', handlePullError);

      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [pushToast, reportConflict, setIsPulling, setOffline, setStatus]);

  const total = status.total;
  const completed = total - status.pending - status.syncing;
  const progress = total > 0 ? Math.min(1, completed / total) : 0;

  const lastSyncLabel = status.lastSyncTime
    ? new Date(status.lastSyncTime).toLocaleString()
    : '尚未同步';

  return (
    <div style={containerStyle}>
      {offline && (
        <div style={{ ...cardStyle, background: 'rgba(220, 53, 69, 0.9)' }}>
          <strong>离线模式</strong>
          <div>所有改动将暂存本地，恢复网络后自动上传。</div>
        </div>
      )}

      {(status.isSyncing || isPulling || total > 0) && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>{isPulling ? '拉取中' : status.isSyncing ? '同步中' : '同步状态'}</strong>
            <span style={{ fontSize: 12, opacity: 0.8 }}>最后同步：{lastSyncLabel}</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}>
            待处理 {status.pending} · 执行中 {status.syncing} · 失败 {status.failed}
          </div>
          <div style={progressBackground}>
            <div style={{ ...progressBar, width: `${progress * 100}%` }} />
          </div>
        </div>
      )}

      {conflicts.map((conflict) => (
        <div key={conflict.id} style={{ ...cardStyle, background: 'rgba(255, 193, 7, 0.92)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>冲突：{conflict.entity}</strong>
            <button
              type="button"
              style={closeButtonStyle}
              onClick={() => clearConflict(conflict.id)}
              aria-label="关闭冲突提示"
            >
              ×
            </button>
          </div>
          <div style={{ marginTop: 4 }}>本地 ID：{conflict.localId}</div>
          {conflict.description && <div style={{ marginTop: 4 }}>{conflict.description}</div>}
          <div style={{ marginTop: 4, opacity: 0.75, fontSize: 12 }}>
            请检查该实体，本地改动已被保留。
          </div>
        </div>
      ))}

      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            ...cardStyle,
            background: toastVariantColors[toast.variant] ?? toastVariantColors.info,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{toast.message}</span>
            <button
              type="button"
              style={closeButtonStyle}
              onClick={() => dismissToast(toast.id)}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

type SyncStats = {
  totalPulled: number;
  totalPushed: number;
  conflicts: number;
  errors: number;
};
