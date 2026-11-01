import { useSyncExternalStore } from 'react';

import { useAuthStore } from '../store/auth';
import { productSyncAuthorityStore } from './product-authority-store';
import { productSyncRuntimeControl } from './product-runtime-control';
import { EMPTY_SYNC_HEALTH, SyncHealthTracker, type SyncHealthSnapshot } from './sync-health';

type Listener = () => void;

/**
 * The App-wide sync health (sync-health.ts), kept current from the runtime
 * snapshot, the sync authority and the Hosted session. It starts with its
 * first subscriber and then keeps observing, so failures are counted even
 * while no paper is open.
 */
class SyncHealthMonitor {
  private readonly tracker = new SyncHealthTracker();
  private readonly listeners = new Set<Listener>();
  private snapshot: SyncHealthSnapshot = EMPTY_SYNC_HEALTH;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: Listener): () => void {
    this.start();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncHealthSnapshot {
    return this.snapshot;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    productSyncRuntimeControl.subscribe(() => this.observe());
    productSyncAuthorityStore.subscribe(() => this.observe());
    useAuthStore.subscribe((state, previous) => {
      if (state.hostedStatus !== previous.hostedStatus) this.observe();
    });
    this.observe();
  }

  private observe(): void {
    const runtime = productSyncRuntimeControl.getSnapshot();
    const authority = productSyncAuthorityStore.getSnapshot();
    this.tracker.observe(
      {
        loaded: authority.loaded,
        hosted: authority.mode === 'hosted',
        paused: authority.status === 'cloud-paused',
        session: useAuthStore.getState().hostedStatus,
        activationFailed: runtime.activationFailed,
        diagnostics: runtime.diagnostics,
      },
      Date.now(),
    );
    this.evaluate();
  }

  private evaluate(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const nowMs = Date.now();
    const { health, wakeAtMs } = this.tracker.evaluate(nowMs);
    if (wakeAtMs !== null) {
      this.timer = setTimeout(() => this.observe(), Math.max(0, wakeAtMs - nowMs));
    }
    if (!sameHealth(health, this.snapshot)) {
      this.snapshot = health;
      for (const listener of this.listeners) listener();
    }
  }
}

function sameHealth(a: SyncHealthSnapshot, b: SyncHealthSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const syncHealthMonitor = new SyncHealthMonitor();

export function useSyncHealth(): SyncHealthSnapshot {
  return useSyncExternalStore(
    (listener) => syncHealthMonitor.subscribe(listener),
    () => syncHealthMonitor.getSnapshot(),
    () => syncHealthMonitor.getSnapshot(),
  );
}
