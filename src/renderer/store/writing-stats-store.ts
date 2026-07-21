import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Per-project daily snapshot of the project's total word count, captured at
// the latest update on that day. "Today's words" is then derived as
// `currentTotal - lastSnapshotBeforeToday`, "weekly words" as the sum of
// inter-day deltas in the trailing week, etc. We persist these in
// localStorage rather than SQLite so adding stats doesn't require a schema
// migration; if richer per-session telemetry is needed later, that's where
// it should land.
//
// Word count is intentionally a "total at snapshot" rather than a delta
// because chapter edits can both add *and* remove words. Storing the
// running total lets us recompute deltas later if we ever change the day
// boundaries (e.g. 4am rollover).

export type ISODate = string; // YYYY-MM-DD

interface ProjectHistory {
  // ISODate → total project word count at the latest tick of that day.
  // Sparse — only days the user actually wrote on appear.
  [day: ISODate]: number;
}

interface WritingPlan {
  // Project word target (e.g. 120000). 0 disables the project bar.
  projectWordTarget: number;
  // Words/day commitment. Drives the "Today" progress bar and streak.
  dailyWordGoal: number;
}

interface WritingStatsState {
  history: Record<string, ProjectHistory>;
  plans: Record<string, WritingPlan>;
  // Record today's total. No-op if nothing changed.
  recordTotalWords: (projectId: string, totalWords: number) => void;
  // Update / read the writing plan for a project.
  setProjectWordTarget: (projectId: string, words: number) => void;
  setDailyWordGoal: (projectId: string, words: number) => void;
  getPlan: (projectId: string) => WritingPlan;
}

export const DEFAULT_PROJECT_TARGET = 120000;
const DEFAULT_DAILY_GOAL = 1500;

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

export const useWritingStatsStore = create<WritingStatsState>()(
  persist(
    (set, get) => ({
      history: {},
      plans: {},
      recordTotalWords: (projectId, totalWords) => {
        if (!projectId) return;
        const safeTotal = Math.max(0, Math.floor(totalWords || 0));
        const day = todayKey();
        const current = get().history[projectId] ?? {};
        if (current[day] === safeTotal) return;
        set((state) => ({
          history: {
            ...state.history,
            [projectId]: { ...current, [day]: safeTotal },
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
    }),
    {
      name: 'writing-stats-storage',
      storage: createJSONStorage(() => localStorage),
      version: 1,
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

function priorSnapshot(history: ProjectHistory, day: ISODate): number {
  // Walk back through `history` for the most recent day strictly before
  // `day`. The map is sparse — most days won't have an entry, so this is
  // simpler than maintaining a sorted index.
  let best: ISODate | null = null;
  for (const key of Object.keys(history)) {
    if (key >= day) continue;
    if (best === null || key > best) best = key;
  }
  return best === null ? 0 : (history[best] ?? 0);
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
      streakDays: safe > 0 ? 1 : 0,
      weekDaily: [],
    };
  }

  const today = todayKey();
  // Treat the live `currentTotal` as today's snapshot; the store may not
  // yet have written this tick out, and the user has every right to see
  // numbers that reflect what's in their editor right now.
  const todayTotal = Math.max(history[today] ?? 0, safe);
  const yestTotal = priorSnapshot(history, today);
  const todayWords = Math.max(0, todayTotal - yestTotal);

  // Week — last 7 days including today.
  const weekDaily: { day: ISODate; words: number }[] = [];
  let weekWords = 0;
  for (let i = 6; i >= 0; i--) {
    const day = addDays(today, -i);
    const dayTotal = day === today ? todayTotal : (history[day] ?? null);
    const prevTotal = priorSnapshot(history, day);
    const words = dayTotal == null ? 0 : Math.max(0, dayTotal - prevTotal);
    weekDaily.push({ day, words });
    weekWords += words;
  }

  // Month — count distinct days in the last 30 with words > 0 (interpreted as
  // "active days" rather than total words, to match the label "月内 — 天").
  let monthDaysWritten = 0;
  for (let i = 0; i < 30; i++) {
    const day = addDays(today, -i);
    const dayTotal = day === today ? todayTotal : (history[day] ?? null);
    if (dayTotal == null) continue;
    const prevTotal = priorSnapshot(history, day);
    if (dayTotal - prevTotal > 0) monthDaysWritten += 1;
  }

  // Streak — consecutive days ending today with words > 0. If today is 0
  // but yesterday had writing, the streak is broken, returning 0.
  let streakDays = 0;
  for (let i = 0; ; i++) {
    const day = addDays(today, -i);
    const dayTotal = day === today ? todayTotal : (history[day] ?? null);
    if (dayTotal == null) break;
    const prevTotal = priorSnapshot(history, day);
    if (dayTotal - prevTotal <= 0) break;
    streakDays += 1;
    // Cap at 365 so a long backlog doesn't loop forever on degenerate data.
    if (streakDays >= 365) break;
  }

  return { todayWords, weekWords, monthDaysWritten, streakDays, weekDaily };
}
