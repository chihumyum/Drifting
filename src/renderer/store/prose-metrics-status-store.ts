import { create } from 'zustand';

export type ProseMetricsProjectStatus = 'idle' | 'reconciling' | 'ready' | 'error';

interface ProseMetricsStatusState {
  byProject: Record<string, ProseMetricsProjectStatus>;
  errors: Record<string, string | null>;
  setStatus: (projectId: string, status: ProseMetricsProjectStatus, error?: string | null) => void;
}

export const useProseMetricsStatusStore = create<ProseMetricsStatusState>((set) => ({
  byProject: {},
  errors: {},
  setStatus: (projectId, status, error = null) =>
    set((state) => ({
      byProject: { ...state.byProject, [projectId]: status },
      errors: { ...state.errors, [projectId]: error },
    })),
}));

export function proseMetricsStatus(projectId: string): ProseMetricsProjectStatus {
  return useProseMetricsStatusStore.getState().byProject[projectId] ?? 'idle';
}
