/**
 * Sync observer — keeps a rolling log of `sync:operation` events and
 * exposes derived metrics for the HUD and the settings sync-activity
 * panel.
 *
 * The existing HUD listens to `events.on('sync:operation')` directly and
 * renders short-lived toasts. That's fine for foreground feedback but
 * gives no history once a toast fades. This observer is an in-memory
 * ring buffer that any UI can subscribe to.
 *
 * It does NOT persist across reloads. We could spill to IndexedDB later,
 * but for "what just happened" debugging the in-memory window is enough.
 */
import { create } from 'zustand';
import { events, type SyncOperationEvent } from '../lib/events';

const MAX_HISTORY = 200;

// requestId → started time. Lets us compute durationMs when the
// matching succeed/fail comes in (some events don't carry it themselves).
const startedAt = new Map<string, number>();

export interface SyncMetrics {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number; // 0..1
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  inflight: number;
}

interface SyncObserverState {
  history: SyncOperationEvent[];
  metrics: SyncMetrics;
  clear: () => void;
}

export const useSyncObserver = create<SyncObserverState>((set) => ({
  history: [],
  metrics: {
    total: 0,
    succeeded: 0,
    failed: 0,
    successRate: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    inflight: 0,
  },
  clear: () =>
    set({
      history: [],
      metrics: {
        total: 0,
        succeeded: 0,
        failed: 0,
        successRate: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        inflight: 0,
      },
    }),
}));

function recordEvent(event: SyncOperationEvent): void {
  // Track inflight count via started/finished pairing.
  if (event.state === 'started') {
    startedAt.set(event.requestId, event.at);
  } else if (startedAt.has(event.requestId)) {
    const begun = startedAt.get(event.requestId)!;
    startedAt.delete(event.requestId);
    if (event.durationMs === undefined) {
      event = { ...event, durationMs: event.at - begun };
    }
  }

  const prev = useSyncObserver.getState();
  const history = [event, ...prev.history].slice(0, MAX_HISTORY);
  const inflight = startedAt.size;

  // Counters only consider terminal events.
  let { total, succeeded, failed, lastSuccessAt, lastFailureAt } = prev.metrics;
  if (event.state === 'succeeded') {
    total += 1;
    succeeded += 1;
    lastSuccessAt = event.at;
  } else if (event.state === 'failed') {
    total += 1;
    failed += 1;
    lastFailureAt = event.at;
  }
  const successRate = total === 0 ? 0 : succeeded / total;

  useSyncObserver.setState({
    history,
    metrics: { total, succeeded, failed, successRate, lastSuccessAt, lastFailureAt, inflight },
  });
}

let attached = false;
export function startSyncObserver(): void {
  if (attached) return;
  attached = true;
  events.on('sync:operation', recordEvent);
}

export function stopSyncObserver(): void {
  if (!attached) return;
  events.off('sync:operation', recordEvent);
  attached = false;
  startedAt.clear();
}
