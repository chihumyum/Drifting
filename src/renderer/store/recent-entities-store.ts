import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type RecentEntityType = 'node' | 'element';

export interface RecentEntityRecord {
  projectId: string;
  entityId: string;
  entityType: RecentEntityType;
  usedAt: number;
}

interface TouchRecentEntityInput {
  projectId: string;
  entityId: string;
  entityType: RecentEntityType;
}

interface RecentEntitiesState {
  items: RecentEntityRecord[];
  touchEntity: (input: TouchRecentEntityInput, maxItems?: number) => void;
  trimToLimit: (maxItems: number) => void;
  clearProject: (projectId: string) => void;
}

function sanitizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  const normalized = Math.floor(limit);
  return Math.max(1, Math.min(50, normalized));
}

export const useRecentEntitiesStore = create<RecentEntitiesState>()(
  persist(
    (set) => ({
      items: [],
      touchEntity: (input, maxItems = 10) =>
        set((state) => {
          const limit = sanitizeLimit(maxItems);
          const deduped = state.items.filter(
            (item) =>
              !(
                item.projectId === input.projectId &&
                item.entityType === input.entityType &&
                item.entityId === input.entityId
              )
          );
          const next: RecentEntityRecord[] = [
            {
              projectId: input.projectId,
              entityId: input.entityId,
              entityType: input.entityType,
              usedAt: Date.now(),
            },
            ...deduped,
          ];
          return { items: next.slice(0, limit) };
        }),
      trimToLimit: (maxItems) =>
        set((state) => {
          const limit = sanitizeLimit(maxItems);
          if (state.items.length <= limit) {
            return state;
          }
          return { items: state.items.slice(0, limit) };
        }),
      clearProject: (projectId) =>
        set((state) => ({
          items: state.items.filter((item) => item.projectId !== projectId),
        })),
    }),
    {
      name: 'recent-entities-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ items: state.items }),
    }
  )
);
