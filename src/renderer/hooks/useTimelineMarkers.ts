import { useCallback, useMemo, useState } from 'react';
import type { TimelineMarker } from '../domain/timeline-marker';

// localStorage key is per-project so switching projects keeps markers
// independent. Bumping `STORAGE_VERSION` invalidates older payloads if
// we change the schema later.
const STORAGE_PREFIX = 'drifting:timeline-markers';
const STORAGE_VERSION = 1;

interface StoredPayload {
  v: number;
  markers: TimelineMarker[];
}

function storageKey(projectId: string | null | undefined) {
  return projectId ? `${STORAGE_PREFIX}:${projectId}` : null;
}

function readMarkers(projectId: string | null | undefined): TimelineMarker[] {
  const key = storageKey(projectId);
  if (!key || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPayload;
    if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.markers)) return [];
    return parsed.markers;
  } catch {
    return [];
  }
}

function writeMarkers(projectId: string, markers: TimelineMarker[]) {
  const key = storageKey(projectId);
  if (!key) return;
  const payload: StoredPayload = { v: STORAGE_VERSION, markers };
  localStorage.setItem(key, JSON.stringify(payload));
}

function makeId() {
  return `mk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function parseNumeric(label: string): number | null {
  // Extract the first signed-decimal token from a label so "1938 春"
  // still yields 1938 for interpolation. Returns null when nothing
  // numeric is present.
  const m = /-?\d+(?:\.\d+)?/.exec(label);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

export interface TimelineMarkersApi {
  markers: TimelineMarker[];
  addMarker: (start: number, label: string) => TimelineMarker | null;
  updateMarker: (id: string, patch: Partial<Pick<TimelineMarker, 'start' | 'label'>>) => void;
  deleteMarker: (id: string) => void;
  // Converts a `start` position to a numeric "time" value if at least two
  // markers carry numeric labels; otherwise null. Uses linear interpolation
  // between the two nearest numeric markers and linear extrapolation
  // outside their range.
  startToTime: (start: number) => number | null;
  // Inverse of startToTime — given a numeric time, returns the start
  // position. Null when conversion isn't available.
  timeToStart: (time: number) => number | null;
}

export function useTimelineMarkers(projectId: string | null | undefined): TimelineMarkersApi {
  // The store-of-truth is localStorage; bump is a re-render trigger that
  // forces the markers memo to re-read after a mutation. We avoid the
  // setState-in-effect anti-pattern by reading fresh on every render
  // (cheap: a single localStorage.getItem + JSON.parse on ~tens of items).
  const [bump, setBump] = useState(0);
  const markers = useMemo(() => {
    void bump; // re-read trigger after mutations
    return readMarkers(projectId);
  }, [projectId, bump]);

  const persist = useCallback(
    (next: TimelineMarker[]) => {
      if (!projectId) return;
      writeMarkers(projectId, next);
      setBump((n) => n + 1);
    },
    [projectId],
  );

  const addMarker = useCallback<TimelineMarkersApi['addMarker']>(
    (start, label) => {
      if (!projectId) return null;
      const trimmed = label.trim();
      if (!trimmed) return null;
      const marker: TimelineMarker = {
        id: makeId(),
        start,
        label: trimmed,
        createdAt: new Date().toISOString(),
      };
      const next = [...markers, marker].sort((a, b) => a.start - b.start);
      persist(next);
      return marker;
    },
    [markers, persist, projectId],
  );

  const updateMarker = useCallback<TimelineMarkersApi['updateMarker']>(
    (id, patch) => {
      let changed = false;
      const next = markers
        .map((m) => {
          if (m.id !== id) return m;
          changed = true;
          return { ...m, ...patch };
        })
        .sort((a, b) => a.start - b.start);
      if (changed) persist(next);
    },
    [markers, persist],
  );

  const deleteMarker = useCallback<TimelineMarkersApi['deleteMarker']>(
    (id) => {
      const next = markers.filter((m) => m.id !== id);
      if (next.length !== markers.length) persist(next);
    },
    [markers, persist],
  );

  // Pre-compute the two reference points used for linear conversion.
  // Pick the two numeric markers with the largest start-gap so the
  // slope is most stable when the user has a long span. Null when
  // we can't form a pair.
  const conversion = useMemo(() => {
    const numeric = markers
      .map((m) => ({ start: m.start, time: parseNumeric(m.label) }))
      .filter((m): m is { start: number; time: number } => m.time !== null)
      .sort((a, b) => a.start - b.start);
    if (numeric.length < 2) return null;
    const a = numeric[0];
    const b = numeric[numeric.length - 1];
    if (a.start === b.start) return null;
    return { a, b };
  }, [markers]);

  const startToTime = useCallback<TimelineMarkersApi['startToTime']>(
    (start) => {
      if (!conversion) return null;
      const { a, b } = conversion;
      const slope = (b.time - a.time) / (b.start - a.start);
      return a.time + (start - a.start) * slope;
    },
    [conversion],
  );

  const timeToStart = useCallback<TimelineMarkersApi['timeToStart']>(
    (time) => {
      if (!conversion) return null;
      const { a, b } = conversion;
      const slope = (b.start - a.start) / (b.time - a.time);
      return a.start + (time - a.time) * slope;
    },
    [conversion],
  );

  return { markers, addMarker, updateMarker, deleteMarker, startToTime, timeToStart };
}
