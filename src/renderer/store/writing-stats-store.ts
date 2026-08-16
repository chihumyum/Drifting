import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Per-project daily start/latest snapshots of the project's total word count.
// "Today's words" is derived as `latestTotal - startTotal`, while weekly words
// sum those bounded daily deltas. We persist these in
// localStorage rather than SQLite so adding stats doesn't require a schema
// migration; if richer per-session telemetry is needed later, that's where
// it should land.
//
// Word count is intentionally a "total at snapshot" rather than a delta
// because chapter edits can both add *and* remove words. Storing the
// running total lets us recompute deltas later if we ever change the day
// boundaries (e.g. 4am rollover).

export type ISODate = string; // YYYY-MM-DD

export interface DailyWordSnapshot {
  startTotal: number;
  latestTotal: number;
}

export interface ProjectHistory {
  // Sparse — only days when the project total was observed appear.
  [day: ISODate]: DailyWordSnapshot;
}

interface WritingPlan {
  // Project word target (e.g. 120000). 0 disables the project bar.
  projectWordTarget: number;
  // Words/day commitment. Drives the "Today" progress bar and streak.
  dailyWordGoal: number;
}

export interface WritingStatsState {
  history: Record<string, ProjectHistory>;
  plans: Record<string, WritingPlan>;
  // Record today's total. No-op if nothing changed.
  recordTotalWords: (projectId: string, totalWords: number) => void;
  // Update / read the writing plan for a project.
  setProjectWordTarget: (projectId: string, words: number) => void;
  setDailyWordGoal: (projectId: string, words: number) => void;
  getPlan: (projectId: string) => WritingPlan;
  clearProject: (projectId: string) => void;
}

type LegacyWritingStatsState = Omit<WritingStatsState, 'history'> & {
  history: Record<string, Record<ISODate, number>>;
};

export const DEFAULT_PROJECT_TARGET = 120000;
const DEFAULT_DAILY_GOAL = 1500;

export const WRITING_STATS_STORAGE_VERSION = 3;

export function migrateWritingStatsState(
  persistedState: WritingStatsState | LegacyWritingStatsState,
  persistedVersion: number,
): WritingStatsState {
  if (persistedVersion >= WRITING_STATS_STORAGE_VERSION) {
    return persistedState as WritingStatsState;
  }
  if (persistedVersion < 2) {
    // v1 totals included drift nodes and could be based on untrusted legacy
    // scalars. History is a rebuildable presentation cache, so discard the
    // incompatible baseline while preserving author-owned writing goals.
    return { ...persistedState, history: {} } as WritingStatsState;
  }

  // v2 kept one total per day. Convert each delta to an explicit daily
  // start/latest pair. The first observation becomes a zero-contribution
  // baseline instead of crediting the entire pre-existing book to that day.
  const legacyHistory = persistedState.history as LegacyWritingStatsState['history'];
  const history: Record<string, ProjectHistory> = {};
  for (const [projectId, projectHistory] of Object.entries(legacyHistory)) {
    let previousTotal: number | null = null;
    history[projectId] = Object.fromEntries(
      Object.entries(projectHistory)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, total]) => {
          const safeTotal = Math.max(0, Math.floor(total || 0));
          const snapshot: DailyWordSnapshot = {
            startTotal: previousTotal ?? safeTotal,
            latestTotal: safeTotal,
          };
          previousTotal = safeTotal;
          return [day, snapshot];
        }),
    );
  }
  return { ...persistedState, history } as WritingStatsState;
}

export function todayKey(d: Date = new Date()): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso: ISODate, n: number): ISODate {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) + n);
  return todayKey(date);
}

function latestSnapshotBefore(history: ProjectHistory, day: ISODate): number | null {
  let best: ISODate | null = null;
  for (const key of Object.keys(history)) {
    if (key >= day) continue;
    if (best === null || key > best) best = key;
  }
  return best === null ? null : (history[best]?.latestTotal ?? null);
}

export function recordTotalWordsInHistory(
  history: ProjectHistory | undefined,
  totalWords: number,
  day: ISODate = todayKey(),
): ProjectHistory {
  const safeTotal = Math.max(0, Math.floor(totalWords || 0));
  const current = history ?? {};
  const existing = current[day];
  if (existing?.latestTotal === safeTotal) return current;
  return {
    ...current,
    [day]: {
      startTotal: existing?.startTotal ?? latestSnapshotBefore(current, day) ?? safeTotal,
      latestTotal: safeTotal,
    },
  };
}

export const useWritingStatsStore = create<WritingStatsState>()(
  persist(
    (set, get) => ({
      history: {},
      plans: {},
      recordTotalWords: (projectId, totalWords) => {
        if (!projectId) return;
        const day = todayKey();
        const current = get().history[projectId] ?? {};
        const next = recordTotalWordsInHistory(current, totalWords, day);
        if (next === current) return;
        set((state) => ({
          history: {
            ...state.history,
            [projectId]: next,
          },
        }));
      },
      setProjectWordTarget: (projectId, words) => {
        if (!projectId) return;
        const safe = Math.max(0, Math.floor(words || 0));
        set((state) => ({
          plans: {
            ...state.plans,
            [projectId]: {
              ...(state.plans[projectId] ?? {
                projectWordTarget: DEFAULT_PROJECT_TARGET,
                dailyWordGoal: DEFAULT_DAILY_GOAL,
              }),
              projectWordTarget: safe,
            },
          },
        }));
      },
      setDailyWordGoal: (projectId, words) => {
        if (!projectId) return;
        const safe = Math.max(0, Math.floor(words || 0));
        set((state) => ({
          plans: {
            ...state.plans,
            [projectId]: {
              ...(state.plans[projectId] ?? {
                projectWordTarget: DEFAULT_PROJECT_TARGET,
                dailyWordGoal: DEFAULT_DAILY_GOAL,
              }),
              dailyWordGoal: safe,
            },
          },
        }));
      },
      getPlan: (projectId) =>
        get().plans[projectId] ?? {
          projectWordTarget: DEFAULT_PROJECT_TARGET,
          dailyWordGoal: DEFAULT_DAILY_GOAL,
        },
      clearProject: (projectId) =>
        set((state) => {
          if (!(projectId in state.history) && !(projectId in state.plans)) return state;
          const history = { ...state.history };
          const plans = { ...state.plans };
          delete history[projectId];
          delete plans[projectId];
          return { history, plans };
        }),
    }),
    {
      name: 'writing-stats-storage',
      storage: createJSONStorage(() => localStorage),
      version: WRITING_STATS_STORAGE_VERSION,
      migrate: (persistedState, persistedVersion) =>
        migrateWritingStatsState(
          persistedState as WritingStatsState | LegacyWritingStatsState,
          persistedVersion,
        ),
    },
  ),
);

// ─── Derivations ────────────────────────────────────────────────
// Given the running history of total-words snapshots, derive the user-facing
// numbers the dashboard surfaces.

export interface WritingStatsSnapshot {
  todayWords: number;
  weekWords: number;
  monthDaysWritten: number;
  streakDays: number;
  weekDaily: { day: ISODate; words: number }[];
}

function wordsForSnapshot(snapshot: DailyWordSnapshot | null | undefined): number {
  return snapshot == null ? 0 : Math.max(0, snapshot.latestTotal - snapshot.startTotal);
}

export function deriveWritingStats(
  history: ProjectHistory | undefined,
  currentTotal: number,
): WritingStatsSnapshot {
  const safe = Math.max(0, Math.floor(currentTotal || 0));
  if (!history) {
    return {
      todayWords: 0,
      weekWords: 0,
      monthDaysWritten: 0,
      streakDays: 0,
      weekDaily: [],
    };
  }

  const today = todayKey();
  // Treat the live `currentTotal` as today's snapshot; the store may not
  // yet have written this tick out, and the user has every right to see
  // numbers that reflect what's in their editor right now.
  const storedToday = history[today];
  const todaySnapshot: DailyWordSnapshot = storedToday
    ? { ...storedToday, latestTotal: Math.max(storedToday.latestTotal, safe) }
    : { startTotal: safe, latestTotal: safe };
  const todayWords = wordsForSnapshot(todaySnapshot);

  // Week — last 7 days including today.
  const weekDaily: { day: ISODate; words: number }[] = [];
  let weekWords = 0;
  for (let i = 6; i >= 0; i--) {
    const day = addDays(today, -i);
    const words = wordsForSnapshot(day === today ? todaySnapshot : history[day]);
    weekDaily.push({ day, words });
    weekWords += words;
  }

  // Month — count distinct days in the last 30 with words > 0 (interpreted as
  // "active days" rather than total words, to match the label "月内 — 天").
  let monthDaysWritten = 0;
  for (let i = 0; i < 30; i++) {
    const day = addDays(today, -i);
    const snapshot = day === today ? todaySnapshot : history[day];
    if (wordsForSnapshot(snapshot) > 0) monthDaysWritten += 1;
  }

  // Streak — consecutive days ending today with words > 0. If today is 0
  // but yesterday had writing, the streak is broken, returning 0.
  let streakDays = 0;
  for (let i = 0; ; i++) {
    const day = addDays(today, -i);
    const snapshot = day === today ? todaySnapshot : history[day];
    if (wordsForSnapshot(snapshot) <= 0) break;
    streakDays += 1;
    // Cap at 365 so a long backlog doesn't loop forever on degenerate data.
    if (streakDays >= 365) break;
  }

  return { todayWords, weekWords, monthDaysWritten, streakDays, weekDaily };
}
