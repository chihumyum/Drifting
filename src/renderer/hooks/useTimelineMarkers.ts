import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TimelineMarker } from '../domain/timeline-marker';

// Module-level pub-sub so every hook instance (BottomTimeline, GraphView,
// any future consumer) re-renders when ANY instance persists a change.
// Without this, GraphView's drag-to-reposition only bumps GraphView's
// local state — BottomTimeline keeps showing the pre-drag positions
// until the user refreshes or otherwise triggers a re-render.
const markerSubscribers = new Set<() => void>();
function notifyMarkerSubscribers() {
  markerSubscribers.forEach((cb) => cb());
}

// localStorage key is per-project so switching projects keeps markers
// independent. Bump `STORAGE_VERSION` to invalidate older payloads — we
// just did when renaming the position field from `start` to `narrativeOrder`.
const STORAGE_PREFIX = 'drifting:timeline-markers';
const STORAGE_VERSION = 2;

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
  addMarker: (narrativeOrder: number, label: string) => TimelineMarker | null;
  updateMarker: (
    id: string,
    patch: Partial<Pick<TimelineMarker, 'narrativeOrder' | 'label'>>,
  ) => void;
  deleteMarker: (id: string) => void;
  // Converts a narrativeOrder position to a numeric "time" value if at least
  // two markers carry numeric labels; otherwise null. Linear interpolation
  // between the two extreme numeric markers; linear extrapolation outside.
  orderToTime: (order: number) => number | null;
  // Inverse — given a numeric time, returns the narrativeOrder position.
  // Null when conversion isn't available.
  timeToOrder: (time: number) => number | null;
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

  // Re-render this instance whenever ANY instance persists, so a drag in
  // GraphView is immediately reflected in BottomTimeline (and vice versa).
  useEffect(() => {
    const cb = () => setBump((n) => n + 1);
    markerSubscribers.add(cb);
    return () => {
      markerSubscribers.delete(cb);
    };
  }, []);

  const persist = useCallback(
    (next: TimelineMarker[]) => {
      if (!projectId) return;
      writeMarkers(projectId, next);
      notifyMarkerSubscribers();
    },
    [projectId],
  );

  const addMarker = useCallback<TimelineMarkersApi['addMarker']>(
    (narrativeOrder, label) => {
      if (!projectId) return null;
      const trimmed = label.trim();
      if (!trimmed) return null;
      const marker: TimelineMarker = {
        id: makeId(),
        narrativeOrder,
        label: trimmed,
        createdAt: new Date().toISOString(),
      };
      const next = [...markers, marker].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
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
        .sort((a, b) => a.narrativeOrder - b.narrativeOrder);
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

  // Pre-compute the two reference points used for linear conversion. Pick
  // the two numeric markers with the largest order-gap so the slope is most
  // stable when the user has a long span. Null when we can't form a pair.
  const conversion = useMemo(() => {
    const numeric = markers
      .map((m) => ({ order: m.narrativeOrder, time: parseNumeric(m.label) }))
      .filter((m): m is { order: number; time: number } => m.time !== null)
      .sort((a, b) => a.order - b.order);
    if (numeric.length < 2) return null;
    const a = numeric[0];
    const b = numeric[numeric.length - 1];
    if (a.order === b.order) return null;
    return { a, b };
  }, [markers]);

  const orderToTime = useCallback<TimelineMarkersApi['orderToTime']>(
    (order) => {
      if (!conversion) return null;
      const { a, b } = conversion;
      const slope = (b.time - a.time) / (b.order - a.order);
      return a.time + (order - a.order) * slope;
    },
    [conversion],
  );

  const timeToOrder = useCallback<TimelineMarkersApi['timeToOrder']>(
    (time) => {
      if (!conversion) return null;
      const { a, b } = conversion;
      const slope = (b.order - a.order) / (b.time - a.time);
      return a.order + (time - a.time) * slope;
    },
    [conversion],
  );

  return { markers, addMarker, updateMarker, deleteMarker, orderToTime, timeToOrder };
}
