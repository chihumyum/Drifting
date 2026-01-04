import { create } from 'zustand';
import type { SyncManagerStatus, SyncTaskEntity } from '../lib/sync/types';

export type SyncToastVariant = 'info' | 'success' | 'error' | 'warning';

export interface SyncToast {
  id: string;
  message: string;
  variant: SyncToastVariant;
  timestamp: number;
}

export interface ConflictNotice {
  id: string;
  entity: SyncTaskEntity;
  localId: string;
  description?: string;
  timestamp: number;
}

interface SyncUiState {
  status: SyncManagerStatus;
  lastPullAt: Record<string, number>;
  isPulling: boolean;
  offline: boolean;
  toasts: SyncToast[];
  conflicts: ConflictNotice[];
  setStatus: (status: SyncManagerStatus) => void;
  setOffline: (offline: boolean) => void;
  setIsPulling: (value: boolean) => void;
  setLastPullAt: (projectId: string, timestamp: number) => void;
  pushToast: (toast: { id?: string; message: string; variant: SyncToastVariant }) => string;
  dismissToast: (id: string) => void;
  reportConflict: (conflict: { entity: SyncTaskEntity; localId: string; description?: string }) => void;
  clearConflict: (id: string) => void;
}

const createToastId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `toast-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
};

export const useSyncStatusStore = create<SyncUiState>((set) => ({
  status: {
    total: 0,
    pending: 0,
    syncing: 0,
    failed: 0,
    completed: 0,
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    lastSyncTime: null,
  },
  lastPullAt: {},
  isPulling: false,
  offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  toasts: [],
  conflicts: [],
  setStatus: (status) => set({ status }),
  setOffline: (offline) => set({ offline }),
  setIsPulling: (value) => set({ isPulling: value }),
  setLastPullAt: (projectId, timestamp) =>
    set((state) => ({ lastPullAt: { ...state.lastPullAt, [projectId]: timestamp } })),
  pushToast: ({ id, message, variant }) => {
    const toastId = id ?? createToastId();
    const toast: SyncToast = { id: toastId, message, variant, timestamp: Date.now() };
    set((state) => {
      const next = [...state.toasts, toast];
      if (next.length > 5) next.shift();
      return { toasts: next };
    });
    return toastId;
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  reportConflict: ({ entity, localId, description }) => {
    const notice: ConflictNotice = {
      id: createToastId(),
      entity,
      localId,
      description,
      timestamp: Date.now(),
    };
    set((state) => ({ conflicts: [...state.conflicts, notice] }));
  },
  clearConflict: (id) =>
    set((state) => ({ conflicts: state.conflicts.filter((conflict) => conflict.id !== id) })),
}));
