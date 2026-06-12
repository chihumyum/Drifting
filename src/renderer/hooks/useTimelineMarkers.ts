/**
 * Timeline markers — narrative-axis time pins, now a synced table (formerly
 * localStorage; see domain/timeline-marker.ts for the model + the drift-
 * binding contract).
 *
 * The store-of-truth is the `timeline_marker` SQLite table mirrored into
 * useDataStore.timelineMarkers. Mutations here are optimistic: the store
 * updates synchronously (so `addMarker` can still return the created marker
 * to its caller), persistence + sync ride behind as fire-and-forget — the
 * same pattern the marker UI relied on when this was localStorage.
 */
import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';

import type { TimelineMarker } from '../domain/timeline-marker';
import { useDataStore } from '../store/data-store';
import { createTimelineMarkerRepository } from '../sqlite-repo/timeline-marker-repo';
import {
  syncTimelineMarkerCreate,
  syncTimelineMarkerDelete,
  syncTimelineMarkerUpdate,
} from '../usecase/sync-helpers';
import loglevel from 'loglevel';

const log = loglevel.getLogger('useTimelineMarkers');
log.setLevel(loglevel.levels.WARN);

// ---- Legacy localStorage import (pre-2026-06 storage) ----

const LEGACY_STORAGE_PREFIX = 'drifting:timeline-markers';
const LEGACY_STORAGE_VERSION = 2;

interface LegacyStoredPayload {
  v: number;
  markers: Array<{ id: string; narrativeOrder: number; label: string; createdAt: string }>;
}

function readLegacyMarkers(projectId: string): LegacyStoredPayload['markers'] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${LEGACY_STORAGE_PREFIX}:${projectId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LegacyStoredPayload;
    if (!parsed || parsed.v !== LEGACY_STORAGE_VERSION || !Array.isArray(parsed.markers)) {
      return [];
    }
    return parsed.markers;
  } catch {
    return [];
  }
}

/**
 * App bootstrap: load the project's markers into the data store. Runs the
 * one-time legacy import first — localStorage markers are inserted as real
 * rows (ids preserved), pushed through sync, and the legacy key removed so
 * the import can't double-run.
 */
export async function loadTimelineMarkers(projectId: string): Promise<void> {
  const repo = createTimelineMarkerRepository(projectId);
  let markers = await repo.findAll();

  if (markers.length === 0) {
    const legacy = readLegacyMarkers(projectId);
    if (legacy.length > 0) {
      for (const m of legacy) {
        const row: TimelineMarker = {
          id: m.id,
          projectId,
          narrativeOrder: m.narrativeOrder,
          label: m.label,
          driftNodeId: null,
          createdAt: m.createdAt,
          updatedAt: m.createdAt,
        };
        try {
          await repo.create(row);
          syncTimelineMarkerCreate(row.id, projectId, markerPayload(row));
        } catch (error) {
          log.warn('legacy marker import failed for', m.id, error);
        }
      }
      markers = await repo.findAll();
    }
  }
  // Remove the legacy key even when the table already had rows — the table
  // is authoritative from now on either way.
  try {
    localStorage.removeItem(`${LEGACY_STORAGE_PREFIX}:${projectId}`);
  } catch {
    /* ignore */
  }

  useDataStore.getState().setTimelineMarkers(markers);
}

function markerPayload(marker: TimelineMarker): Record<string, unknown> {
  return {
    id: marker.id,
    narrativeOrder: marker.narrativeOrder,
    label: marker.label,
    driftNodeId: marker.driftNodeId,
    createdAt: marker.createdAt,
    updatedAt: marker.updatedAt,
  };
}

/**
 * Clear the binding on every marker pointing at a drift. MUST be called when
 * a drift is deleted/trashed or converted to a chapter — SQLite FKs aren't
 * enforced in this app, so nothing else will. `fallbackLabel` (the drift's
 * title) captions markers that had no label of their own.
 */
export async function unbindMarkersForDrift(
  projectId: string,
  driftNodeId: string,
  fallbackLabel: string,
): Promise<void> {
  const repo = createTimelineMarkerRepository(projectId);
  const now = new Date().toISOString();
  const updated = await repo.unbindForDrift(driftNodeId, fallbackLabel.trim() || '标记', now);
  const store = useDataStore.getState();
  for (const marker of updated) {
    store.updateTimelineMarker(marker.id, {
      driftNodeId: null,
      label: marker.label,
      updatedAt: now,
    });
    syncTimelineMarkerUpdate(marker.id, projectId, {
      driftNodeId: null,
      label: marker.label,
      updatedAt: now,
    });
  }
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
  /** Ids of drifts currently bound to a marker — drift panels filter these out. */
  boundDriftIds: Set<string>;
  addMarker: (
    narrativeOrder: number,
    label: string,
    options?: { driftNodeId?: string },
  ) => TimelineMarker | null;
  updateMarker: (
    id: string,
    patch: Partial<Pick<TimelineMarker, 'narrativeOrder' | 'label' | 'driftNodeId'>>,
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
  const markers = useDataStore((s) => s.timelineMarkers);
  const repo = useMemo(
    () => (projectId ? createTimelineMarkerRepository(projectId) : null),
    [projectId],
  );

  const boundDriftIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of markers) if (m.driftNodeId) ids.add(m.driftNodeId);
    return ids;
  }, [markers]);

  const addMarker = useCallback<TimelineMarkersApi['addMarker']>(
    (narrativeOrder, label, options) => {
      if (!projectId || !repo) return null;
      const trimmed = label.trim();
      // A bound marker is captioned by its drift; only label-less UNBOUND
      // markers are rejected (nothing to render).
      if (!trimmed && !options?.driftNodeId) return null;
      const now = new Date().toISOString();
      const marker: TimelineMarker = {
        id: uuidv7(),
        projectId,
        narrativeOrder,
        label: trimmed,
        driftNodeId: options?.driftNodeId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      useDataStore.getState().addTimelineMarker(marker);
      void repo
        .create(marker)
        .then(() => syncTimelineMarkerCreate(marker.id, projectId, markerPayload(marker)))
        .catch((error) => {
          log.error('marker create failed:', error);
          useDataStore.getState().removeTimelineMarker(marker.id);
        });
      return marker;
    },
    [projectId, repo],
  );

  const updateMarker = useCallback<TimelineMarkersApi['updateMarker']>(
    (id, patch) => {
      if (!projectId || !repo) return;
      const updatedAt = new Date().toISOString();
      useDataStore.getState().updateTimelineMarker(id, { ...patch, updatedAt });
      void repo
        .update(id, { ...patch, updatedAt })
        .then(() => syncTimelineMarkerUpdate(id, projectId, { ...patch, updatedAt }))
        .catch((error) => log.error('marker update failed:', error));
    },
    [projectId, repo],
  );

  const deleteMarker = useCallback<TimelineMarkersApi['deleteMarker']>(
    (id) => {
      if (!projectId || !repo) return;
      useDataStore.getState().removeTimelineMarker(id);
      void repo
        .delete(id)
        .then(() => syncTimelineMarkerDelete(id, projectId))
        .catch((error) => log.error('marker delete failed:', error));
    },
    [projectId, repo],
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

  return {
    markers,
    boundDriftIds,
    addMarker,
    updateMarker,
    deleteMarker,
    orderToTime,
    timeToOrder,
  };
}
