import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { CheckinCard } from '../lib/agent/checkin/checkin-prompt';

/**
 * Project Home check-in state. Device-local on purpose: each device sees the
 * changes it can read and decides its own cadence, and nothing here is
 * authored project data (accepted cards become Agent sessions or TODOs, and
 * memory upkeep lands in the synced Project Memory).
 */

export type CheckinCardStatus = 'open' | 'started';

export interface StoredCheckinCard extends CheckinCard {
  createdAt: string;
  status: CheckinCardStatus;
  conversationId?: string;
}

export interface ProjectCheckinRecord {
  /** Previous project open on this device (first Home visit per app run). */
  lastOpenedAt: string | null;
  /** Change horizon covered by the last successful check-in. */
  lastCheckinAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  cards: StoredCheckinCard[];
}

export const EMPTY_PROJECT_CHECKIN: ProjectCheckinRecord = Object.freeze({
  lastOpenedAt: null,
  lastCheckinAt: null,
  lastAttemptAt: null,
  error: null,
  cards: [],
}) as ProjectCheckinRecord;

/** Minimum gap between automatic attempts, successful or not. */
export const CHECKIN_ATTEMPT_COOLDOWN_MS = 90 * 60 * 1000;
/** Being away this long earns a "pick up where you left off" check-in. */
export const CHECKIN_AWAY_MS = 6 * 60 * 60 * 1000;
/** How far back the first check-in, and a returning check-in, look. */
export const CHECKIN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED_CARDS = 12;

export type CheckinDecision =
  | { run: false; reason: 'disabled' | 'running' | 'cooldown' | 'nothing-new' }
  | { run: true; sinceIso: string; mode: 'changes' | 'resume' };

/**
 * Decide whether to check in. Changes since the last check-in always qualify;
 * with no changes, a return after a long absence still does when no earlier
 * card is waiting. `hasChangesSince` is only called when it can matter.
 */
export async function decideCheckin(input: {
  now: Date;
  enabled: boolean;
  running: boolean;
  force: boolean;
  /** An organize pass just settled; its check-in skips the cooldown. */
  afterOrganize?: boolean;
  record: ProjectCheckinRecord;
  previousOpenedAt: string | null;
  hasChangesSince: (sinceIso: string) => Promise<boolean>;
}): Promise<CheckinDecision> {
  if (!input.enabled && !input.force) return { run: false, reason: 'disabled' };
  if (input.running) return { run: false, reason: 'running' };
  const now = input.now.getTime();
  const lastAttempt = input.record.lastAttemptAt ? Date.parse(input.record.lastAttemptAt) : 0;
  if (!input.force && !input.afterOrganize && now - lastAttempt < CHECKIN_ATTEMPT_COOLDOWN_MS) {
    return { run: false, reason: 'cooldown' };
  }
  const lookback = new Date(now - CHECKIN_LOOKBACK_MS).toISOString();
  const since =
    input.record.lastCheckinAt && input.record.lastCheckinAt > lookback
      ? input.record.lastCheckinAt
      : lookback;
  if (await input.hasChangesSince(since)) return { run: true, sinceIso: since, mode: 'changes' };
  const openCards = input.record.cards.some((card) => card.status === 'open');
  const previousOpen = input.previousOpenedAt ? Date.parse(input.previousOpenedAt) : null;
  const away = previousOpen !== null && now - previousOpen >= CHECKIN_AWAY_MS;
  if ((away || input.force) && !openCards && (await input.hasChangesSince(lookback))) {
    return { run: true, sinceIso: lookback, mode: 'resume' };
  }
  return { run: false, reason: 'nothing-new' };
}

interface ProjectCheckinState {
  enabled: boolean;
  projects: Record<string, ProjectCheckinRecord>;
  /** Transient: projects with a check-in in flight in this window. */
  running: Record<string, boolean>;
  setEnabled: (enabled: boolean) => void;
  /** Stamp this open and return the previous one. */
  recordOpen: (projectId: string, atIso: string) => string | null;
  markAttempt: (projectId: string, atIso: string) => void;
  setRunning: (projectId: string, running: boolean) => void;
  completeCheckin: (projectId: string, horizonIso: string, cards: StoredCheckinCard[]) => void;
  failCheckin: (projectId: string, error: string) => void;
  updateCard: (
    projectId: string,
    cardId: string,
    patch: Partial<Pick<StoredCheckinCard, 'status' | 'conversationId'>>,
  ) => void;
  dismissCard: (projectId: string, cardId: string) => void;
}

function recordFor(state: ProjectCheckinState, projectId: string): ProjectCheckinRecord {
  return state.projects[projectId] ?? EMPTY_PROJECT_CHECKIN;
}

export const useProjectCheckinStore = create<ProjectCheckinState>()(
  persist(
    (set, get) => ({
      enabled: true,
      projects: {},
      running: {},
      setEnabled: (enabled) => set({ enabled }),
      recordOpen: (projectId, atIso) => {
        const previous = recordFor(get(), projectId).lastOpenedAt;
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: { ...recordFor(state, projectId), lastOpenedAt: atIso },
          },
        }));
        return previous;
      },
      markAttempt: (projectId, atIso) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: { ...recordFor(state, projectId), lastAttemptAt: atIso },
          },
        })),
      setRunning: (projectId, running) =>
        set((state) => ({ running: { ...state.running, [projectId]: running } })),
      completeCheckin: (projectId, horizonIso, cards) =>
        set((state) => {
          const current = recordFor(state, projectId);
          // New cards replace unanswered ones, which described older state;
          // started cards stay so their conversations remain reachable.
          const kept = current.cards.filter((card) => card.status === 'started');
          return {
            projects: {
              ...state.projects,
              [projectId]: {
                ...current,
                lastCheckinAt: horizonIso,
                error: null,
                cards: [...cards, ...kept].slice(0, MAX_STORED_CARDS),
              },
            },
          };
        }),
      failCheckin: (projectId, error) =>
        set((state) => ({
          projects: {
            ...state.projects,
            [projectId]: { ...recordFor(state, projectId), error },
          },
        })),
      updateCard: (projectId, cardId, patch) =>
        set((state) => {
          const current = recordFor(state, projectId);
          return {
            projects: {
              ...state.projects,
              [projectId]: {
                ...current,
                cards: current.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)),
              },
            },
          };
        }),
      dismissCard: (projectId, cardId) =>
        set((state) => {
          const current = recordFor(state, projectId);
          return {
            projects: {
              ...state.projects,
              [projectId]: { ...current, cards: current.cards.filter((card) => card.id !== cardId) },
            },
          };
        }),
    }),
    {
      name: 'project-checkin',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ enabled: state.enabled, projects: state.projects }),
      migrate: (persisted, version) => migrateProjectCheckinState(persisted, version),
    },
  ),
);

type PersistedProjectCheckin = Pick<ProjectCheckinState, 'enabled' | 'projects'>;

/** v1 cards had question/action/todo kinds and a `done` status; v2 has one kind. */
export function migrateProjectCheckinState(
  persisted: unknown,
  version: number,
): PersistedProjectCheckin {
  const state = (persisted ?? {}) as Partial<PersistedProjectCheckin>;
  const projects: Record<string, ProjectCheckinRecord> = {};
  for (const [projectId, record] of Object.entries(state.projects ?? {})) {
    const cards = (record.cards ?? [])
      .filter((card) => version >= 2 || (card.status as string) !== 'done')
      .map(({ kind, ...card }: StoredCheckinCard & { kind?: unknown }) =>
        // A v1 TODO card kept its text in `detail`; hand it over as a task.
        kind === 'todo' && !card.instruction?.trim()
          ? { ...card, instruction: `把这件事记成项目待办：${card.detail}` }
          : card,
      )
      .filter((card) => typeof card.instruction === 'string' && card.instruction.trim());
    projects[projectId] = { ...EMPTY_PROJECT_CHECKIN, ...record, cards };
  }
  return { enabled: state.enabled ?? true, projects };
}

export function readProjectCheckin(projectId: string): ProjectCheckinRecord {
  return recordFor(useProjectCheckinStore.getState(), projectId);
}
