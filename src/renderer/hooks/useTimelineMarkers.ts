/**
 * Timeline markers are narrative-axis time pins. The `timeline_marker` SQLite
 * table is authoritative and is mirrored into useDataStore.timelineMarkers.
 * Mutations are optimistic: the store updates synchronously so `addMarker`
 * can return the created marker while persistence and sync complete behind it.
 */
import { useCallback, useMemo } from 'react';
import { v7 as uuidv7 } from 'uuid';

import type { TimelineMarker } from '../domain/timeline-marker';
import {
  buildTimelineConversion,
  convertOrderToTime,
  convertTimeToOrder,
} from '../domain/timeline-conversion';
import { useDataStore } from '../store/data-store';
import { createTimelineMarkerRepository } from '../sqlite-repo/timeline-marker-repo';
import { withAtomicSyncTransaction } from '../usecase/sync-helpers';
import loglevel from 'loglevel';

const log = loglevel.getLogger('useTimelineMarkers');
log.setLevel(loglevel.levels.WARN);

/** Load the project's current SQLite markers into the data store. */
export async function loadTimelineMarkers(projectId: string): Promise<void> {
  const markers = await createTimelineMarkerRepository(projectId).findAll();
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
  const now = new Date().toISOString();
  const updated = await withAtomicSyncTransaction(projectId, async (tx, sync) => {
    const rows = await createTimelineMarkerRepository(projectId, tx).unbindForDrift(
      driftNodeId,
      fallbackLabel.trim() || 'Marker',
      now,
    );
    for (const marker of rows) {
      await sync('timelineMarker', 'update', marker.id, projectId, {
        driftNodeId: null,
        label: marker.label,
        updatedAt: now,
      });
    }
    return rows;
  });
  const store = useDataStore.getState();
  for (const marker of updated) {
    store.updateTimelineMarker(marker.id, {
      driftNodeId: null,
      label: marker.label,
      updatedAt: now,
    });
  }
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
  const boundDriftIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of markers) if (m.driftNodeId) ids.add(m.driftNodeId);
    return ids;
  }, [markers]);

  const addMarker = useCallback<TimelineMarkersApi['addMarker']>(
    (narrativeOrder, label, options) => {
      if (!projectId) return null;
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
      void withAtomicSyncTransaction(projectId, async (tx, sync) => {
        await createTimelineMarkerRepository(projectId, tx).create(marker);
        await sync('timelineMarker', 'create', marker.id, projectId, markerPayload(marker));
      }).catch((error) => {
        log.error('marker create failed:', error);
        const current = useDataStore.getState().timelineMarkers.find((row) => row.id === marker.id);
        if (current?.updatedAt === marker.updatedAt) {
          useDataStore.getState().removeTimelineMarker(marker.id);
        }
      });
      return marker;
    },
    [projectId],
  );

  const updateMarker = useCallback<TimelineMarkersApi['updateMarker']>(
    (id, patch) => {
      if (!projectId) return;
      const previous = useDataStore.getState().timelineMarkers.find((marker) => marker.id === id);
      if (!previous) return;
      const updatedAt = new Date().toISOString();
      useDataStore.getState().updateTimelineMarker(id, { ...patch, updatedAt });
      void withAtomicSyncTransaction(projectId, async (tx, sync) => {
        const persisted = await createTimelineMarkerRepository(projectId, tx).update(id, {
          ...patch,
          updatedAt,
        });
        if (!persisted) throw new Error(`Timeline marker ${id} not found`);
        await sync('timelineMarker', 'update', id, projectId, { ...patch, updatedAt });
      }).catch((error) => {
        log.error('marker update failed:', error);
        const current = useDataStore.getState().timelineMarkers.find((marker) => marker.id === id);
        if (current?.updatedAt === updatedAt) {
          useDataStore.getState().updateTimelineMarker(id, previous);
        }
      });
    },
    [projectId],
  );

  const deleteMarker = useCallback<TimelineMarkersApi['deleteMarker']>(
    (id) => {
      if (!projectId) return;
      const previous = useDataStore.getState().timelineMarkers.find((marker) => marker.id === id);
      if (!previous) return;
      useDataStore.getState().removeTimelineMarker(id);
      void withAtomicSyncTransaction(projectId, async (tx, sync) => {
        await createTimelineMarkerRepository(projectId, tx).delete(id);
        await sync('timelineMarker', 'delete', id, projectId);
      }).catch((error) => {
        log.error('marker delete failed:', error);
        const current = useDataStore.getState().timelineMarkers.some((marker) => marker.id === id);
        if (!current) useDataStore.getState().addTimelineMarker(previous);
      });
    },
    [projectId],
  );

  // Pre-compute the two reference points used for linear conversion. Pick
  // the two numeric markers with the largest order-gap so the slope is most
  // stable when the user has a long span. Null when we can't form a pair.
  const conversion = useMemo(() => buildTimelineConversion(markers), [markers]);

  const orderToTime = useCallback<TimelineMarkersApi['orderToTime']>(
    (order) => {
      return convertOrderToTime(conversion, order);
    },
    [conversion],
  );

  const timeToOrder = useCallback<TimelineMarkersApi['timeToOrder']>(
    (time) => {
      return convertTimeToOrder(conversion, time);
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
