import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ActivityEntityType } from '../lib/agent/tool-entity-ref';
import {
  EMPTY_ORGANIZE_COUNTS,
  type OrganizeCounts,
} from '../lib/agent/organize/organize-task';

/**
 * Organize state. Device-local on purpose, like the check-in: each device
 * offers to organize the prose its author wrote there, and a run is only a
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
  /** Author prose written before this moment has been organized or skipped. */
  horizonAt: string | null;
  run: OrganizeRun | null;
}

export const EMPTY_PROJECT_ORGANIZE: ProjectOrganizeRecord = Object.freeze({
  horizonAt: null,
  run: null,
}) as ProjectOrganizeRecord;

/**
 * Project Home's organize card: the author's own prose written since the
 * horizon, waiting for the author to hand it to the Agent.
 */
export interface OrganizeOffer {
  sinceIso: string;
  /** Titles of the prose objects that would be handed to the Agent. */
  documents: string[];
}

/** How far back the first organize card looks. */
export const ORGANIZE_FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Prose older than this is never offered. */
export const ORGANIZE_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The start of the author prose an organize card covers. */
export function organizeSince(now: Date, record: ProjectOrganizeRecord): string {
  const oldest = new Date(now.getTime() - ORGANIZE_MAX_LOOKBACK_MS).toISOString();
  const horizon = record.horizonAt ?? new Date(now.getTime() - ORGANIZE_FIRST_LOOKBACK_MS).toISOString();
  return horizon > oldest ? horizon : oldest;
}

interface ProjectOrganizeState {
  projects: Record<string, ProjectOrganizeRecord>;
  /** Transient: projects starting or running an organize pass in this window. */
  active: Record<string, boolean>;
  /** Transient: the organize card each project's Home shows. */
  offers: Record<string, OrganizeOffer | null>;
  setActive: (projectId: string, active: boolean) => void;
  setOffer: (projectId: string, offer: OrganizeOffer | null) => void;
  startRun: (projectId: string, run: OrganizeRun) => void;
  /** Settle a run; a completed run also moves the horizon to its start. */
  finishRun: (
    projectId: string,
    runId: string,
    patch: Pick<OrganizeRun, 'status'> & Partial<Omit<OrganizeRun, 'id' | 'conversationId'>>,
  ) => void;
  /** Nothing to organize before this moment: formatting only, or skipped. */
  advanceHorizon: (projectId: string, horizonIso: string) => void;
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
        projects: {},
        active: {},
        offers: {},
        setActive: (projectId, active) =>
          set((state) => ({ active: { ...state.active, [projectId]: active } })),
        setOffer: (projectId, offer) =>
          set((state) => ({ offers: { ...state.offers, [projectId]: offer } })),
        startRun: (projectId, run) => patchRecord(projectId, () => ({ run })),
        finishRun: (projectId, runId, patch) =>
          patchRecord(projectId, (record) => {
            if (record.run?.id !== runId) return {};
            const run = { ...record.run, ...patch };
            return patch.status === 'completed' ? { run, horizonAt: record.run.startedAt } : { run };
          }),
        advanceHorizon: (projectId, horizonIso) =>
          patchRecord(projectId, (record) =>
            record.horizonAt && record.horizonAt >= horizonIso ? {} : { horizonAt: horizonIso },
          ),
        dismissRun: (projectId, runId) =>
          patchRecord(projectId, (record) =>
            record.run?.id === runId ? { run: { ...record.run, dismissed: true } } : {},
          ),
      };
    },
    {
      name: 'project-organize',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ projects: state.projects }),
      migrate: (persisted) => migrateProjectOrganizeState(persisted),
    },
  ),
);

/** v1 had an automatic-organize switch and a failure backoff; v2 has neither. */
export function migrateProjectOrganizeState(persisted: unknown): {
  projects: Record<string, ProjectOrganizeRecord>;
} {
  const state = (persisted ?? {}) as { projects?: Record<string, Partial<ProjectOrganizeRecord>> };
  const projects: Record<string, ProjectOrganizeRecord> = {};
  for (const [projectId, record] of Object.entries(state.projects ?? {})) {
    projects[projectId] = { horizonAt: record.horizonAt ?? null, run: record.run ?? null };
  }
  return { projects };
}

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
