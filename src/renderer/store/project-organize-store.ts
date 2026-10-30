import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ActivityEntityType } from '../lib/agent/tool-entity-ref';
import {
  EMPTY_ORGANIZE_COUNTS,
  type OrganizeCounts,
} from '../lib/agent/organize/organize-task';

/**
 * Organize-on-return state. Device-local on purpose, like the check-in: each
 * device organizes the prose its author wrote there, and a run is only a
 * pointer to an ordinary Agent conversation plus what it reported. The
 * elements, element changes and relations it writes are authored project data.
 */

export type OrganizeRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface OrganizeRunEntity {
  entityType: ActivityEntityType;
  id: string;
  op: 'create' | 'write';
}

export interface OrganizeRun {
  id: string;
  conversationId: string;
  startedAt: string;
  sinceIso: string;
  finishedAt: string | null;
  status: OrganizeRunStatus;
  /** Titles of the prose objects handed to the Agent. */
  documents: string[];
  /** The Agent's closing reply. */
  summary: string;
  counts: OrganizeCounts;
  /** Objects the session created or changed, for links on Project Home. */
  entities: OrganizeRunEntity[];
  error: string | null;
  /** Closed on Project Home. */
  dismissed: boolean;
}

export interface ProjectOrganizeRecord {
  /** Author prose written before this moment has been organized. */
  horizonAt: string | null;
  lastFailureAt: string | null;
  run: OrganizeRun | null;
}

export const EMPTY_PROJECT_ORGANIZE: ProjectOrganizeRecord = Object.freeze({
  horizonAt: null,
  lastFailureAt: null,
  run: null,
}) as ProjectOrganizeRecord;

/** Away from the app this long, then back: the previous session has ended. */
export const ORGANIZE_AWAY_MS = 30 * 60 * 1000;
/** How far back the first organize looks. */
export const ORGANIZE_FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Prose older than this is never organized automatically. */
export const ORGANIZE_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed run is retried on a return at least this much later. */
export const ORGANIZE_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;

export type OrganizeDecision =
  | { run: false; reason: 'disabled' | 'backoff' | 'nothing-new' }
  | { run: true; sinceIso: string };

/**
 * Decide whether a return should organize. Only the author's own prose since
 * the horizon counts; `hasChangesSince` is only called when it can matter.
 */
export async function decideOrganize(input: {
  now: Date;
  enabled: boolean;
  force: boolean;
  record: ProjectOrganizeRecord;
  hasChangesSince: (sinceIso: string) => Promise<boolean>;
}): Promise<OrganizeDecision> {
  if (!input.enabled && !input.force) return { run: false, reason: 'disabled' };
  const now = input.now.getTime();
  const lastFailure = input.record.lastFailureAt ? Date.parse(input.record.lastFailureAt) : 0;
  if (!input.force && now - lastFailure < ORGANIZE_FAILURE_BACKOFF_MS) {
    return { run: false, reason: 'backoff' };
  }
  const oldest = new Date(now - ORGANIZE_MAX_LOOKBACK_MS).toISOString();
  const horizon = input.record.horizonAt ?? new Date(now - ORGANIZE_FIRST_LOOKBACK_MS).toISOString();
  const since = horizon > oldest ? horizon : oldest;
  if (!(await input.hasChangesSince(since))) return { run: false, reason: 'nothing-new' };
  return { run: true, sinceIso: since };
}

interface ProjectOrganizeState {
  enabled: boolean;
  projects: Record<string, ProjectOrganizeRecord>;
  /** Transient: projects deciding on or running an organize pass in this window. */
  active: Record<string, boolean>;
  setEnabled: (enabled: boolean) => void;
  setActive: (projectId: string, active: boolean) => void;
  startRun: (projectId: string, run: OrganizeRun) => void;
  /** Settle a run; a completed run also moves the horizon to its start. */
  finishRun: (
    projectId: string,
    runId: string,
    patch: Pick<OrganizeRun, 'status'> & Partial<Omit<OrganizeRun, 'id' | 'conversationId'>>,
  ) => void;
  /** Nothing worth organizing before this moment. */
  advanceHorizon: (projectId: string, horizonIso: string) => void;
  failAttempt: (projectId: string, atIso: string) => void;
  dismissRun: (projectId: string, runId: string) => void;
}

function recordFor(state: ProjectOrganizeState, projectId: string): ProjectOrganizeRecord {
  return state.projects[projectId] ?? EMPTY_PROJECT_ORGANIZE;
}

export const useProjectOrganizeStore = create<ProjectOrganizeState>()(
  persist(
    (set) => {
      const patchRecord = (
        projectId: string,
        patch: (record: ProjectOrganizeRecord) => Partial<ProjectOrganizeRecord>,
      ) =>
        set((state) => {
          const current = recordFor(state, projectId);
          return { projects: { ...state.projects, [projectId]: { ...current, ...patch(current) } } };
        });
      return {
        enabled: true,
        projects: {},
        active: {},
        setEnabled: (enabled) => set({ enabled }),
        setActive: (projectId, active) =>
          set((state) => ({ active: { ...state.active, [projectId]: active } })),
        startRun: (projectId, run) => patchRecord(projectId, () => ({ run })),
        finishRun: (projectId, runId, patch) =>
          patchRecord(projectId, (record) => {
            if (record.run?.id !== runId) return {};
            const run = { ...record.run, ...patch };
            return patch.status === 'completed'
              ? { run, horizonAt: record.run.startedAt, lastFailureAt: null }
              : patch.status === 'failed'
                ? { run, lastFailureAt: patch.finishedAt ?? new Date().toISOString() }
                : { run };
          }),
        advanceHorizon: (projectId, horizonIso) =>
          patchRecord(projectId, (record) =>
            record.horizonAt && record.horizonAt >= horizonIso ? {} : { horizonAt: horizonIso },
          ),
        failAttempt: (projectId, atIso) => patchRecord(projectId, () => ({ lastFailureAt: atIso })),
        dismissRun: (projectId, runId) =>
          patchRecord(projectId, (record) =>
            record.run?.id === runId ? { run: { ...record.run, dismissed: true } } : {},
          ),
      };
    },
    {
      name: 'project-organize',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ enabled: state.enabled, projects: state.projects }),
    },
  ),
);

export function readProjectOrganize(projectId: string): ProjectOrganizeRecord {
  return recordFor(useProjectOrganizeStore.getState(), projectId);
}

export function newOrganizeRun(input: {
  id: string;
  conversationId: string;
  startedAt: string;
  sinceIso: string;
  documents: string[];
}): OrganizeRun {
  return {
    ...input,
    finishedAt: null,
    status: 'running',
    summary: '',
    counts: { ...EMPTY_ORGANIZE_COUNTS },
    entities: [],
    error: null,
    dismissed: false,
  };
}
