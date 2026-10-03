/**
 * Development-only labels for renderer work that may stall the main thread.
 * The dev watchdog attaches open and recently finished activities to its stall
 * reports. Every export is a no-op in production builds.
 */

type ActivityDetail = Record<string, string | number | boolean>;

interface Activity {
  label: string;
  detail?: ActivityDetail;
  startedAt: number;
  endedAt?: number;
}

export interface DevActivitySummary {
  label: string;
  detail?: ActivityDetail;
  startedAt: number;
  durationMs: number;
  open: boolean;
}

/** Shorter work cannot explain a one-second stall on its own. */
const RECORD_MIN_MS = 10;
const RECENT_LIMIT = 100;

const open = new Set<Activity>();
const recent: Activity[] = [];
const noop = () => undefined;

export function beginDevActivity(label: string, detail?: ActivityDetail): () => void {
  if (!import.meta.env.DEV) return noop;
  const activity: Activity = { label, detail, startedAt: Date.now() };
  open.add(activity);
  return () => {
    if (!open.delete(activity)) return;
    activity.endedAt = Date.now();
    if (activity.endedAt - activity.startedAt < RECORD_MIN_MS) return;
    recent.push(activity);
    if (recent.length > RECENT_LIMIT) recent.shift();
  };
}

function summarize(activity: Activity, now: number): DevActivitySummary {
  return {
    label: activity.label,
    ...(activity.detail ? { detail: activity.detail } : {}),
    startedAt: activity.startedAt,
    durationMs: (activity.endedAt ?? now) - activity.startedAt,
    open: activity.endedAt === undefined,
  };
}

export function openDevActivities(now = Date.now()): DevActivitySummary[] {
  return [...open].map((activity) => summarize(activity, now));
}

/** Activities overlapping [from, to], longest first. */
export function devActivitiesBetween(from: number, to: number, limit = 20): DevActivitySummary[] {
  const overlapping = [...recent, ...open].filter(
    (activity) => activity.startedAt <= to && (activity.endedAt ?? to) >= from,
  );
  return overlapping
    .map((activity) => summarize(activity, to))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, limit);
}

export function resetDevActivitiesForTest(): void {
  open.clear();
  recent.length = 0;
}
