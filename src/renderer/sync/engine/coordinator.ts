import { onAuthoredChangeCommitted } from '../journal';
import {
  installSyncEngineLifecycleHook,
  type SyncEngineLifecycleHook,
} from '../../lib/persistence-lifecycle';
import { canUsePersonalCloud } from '../../lib/config';
import type { LifecyclePlatformApi } from '../../platform';
import { platform } from '../../platform';
import {
  SyncScheduler,
  type SchedulerClock,
  type SchedulerTrigger,
} from './scheduler';
import {
  SyncEngineStatusStore,
  type SyncEngineDiagnostics,
  type SyncGenerationPendingDiagnostics,
  type SyncGenerationTransferProgress,
} from './status-store';
import type { SyncGenerationCycleResult, SyncGenerationCycleStatus } from './cycle';
import { fullJitterBackoffMs } from './backoff';

export interface RegisteredSyncGenerationRuntime {
  readonly syncGenerationId: string;
  readonly projectId?: string;
  readonly status?: SyncGenerationCycleStatus;
  readonly transferProgress?: SyncGenerationTransferProgress | null;
  runCycle(triggers: ReadonlySet<SchedulerTrigger>, signal: AbortSignal): Promise<SyncGenerationCycleResult>;
  inspectPending?(): Promise<SyncGenerationPendingDiagnostics>;
  subscribeStatus?(listener: (runtime: RegisteredSyncGenerationRuntime) => void): () => void;
}

export interface SyncEngineCoordinatorOptions {
  readonly nowMs?: () => number;
  readonly schedulerClock?: SchedulerClock;
  readonly statusStore?: SyncEngineStatusStore;
  readonly onCycleError?: (syncGenerationId: string, error: unknown) => void;
  readonly retryRandom?: () => number;
}

function retryMetadata(error: unknown): {
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (!error || typeof error !== 'object') return { retryable: false };
  const candidate = error as { retryable?: unknown; retryAfterMs?: unknown };
  const retryAfterMs = candidate.retryAfterMs;
  return {
    retryable: candidate.retryable === true,
    ...(Number.isSafeInteger(retryAfterMs) && (retryAfterMs as number) >= 0
      ? { retryAfterMs: retryAfterMs as number }
      : {}),
  };
}

export class SyncEngineCoordinator {
  readonly statusStore: SyncEngineStatusStore;

  private readonly nowMs: () => number;
  private readonly runtimes = new Map<string, RegisteredSyncGenerationRuntime>();
  private readonly failureAttempts = new Map<string, number>();
  private readonly scheduler: SyncScheduler;

  constructor(options: SyncEngineCoordinatorOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.statusStore = options.statusStore ?? new SyncEngineStatusStore();
    const retryRandom = options.retryRandom ?? Math.random;
    this.scheduler = new SyncScheduler({
      runCycle: async (syncGenerationId, triggers, signal) => {
        const runtime = this.runtimes.get(syncGenerationId);
        if (!runtime) return;
        try {
          const result = await runtime.runCycle(triggers, signal);
          this.failureAttempts.delete(syncGenerationId);
          return result;
        } finally {
          if (runtime.status) {
            this.statusStore.updateCycle(
              syncGenerationId,
              runtime.status,
              runtime.projectId,
              runtime.transferProgress ?? null,
            );
          }
          if (runtime.inspectPending) {
            this.statusStore.updatePending(
              syncGenerationId,
              await runtime.inspectPending(),
              runtime.projectId,
            );
          }
        }
      },
      clock: options.schedulerClock,
      onCycleError: (syncGenerationId, error) => {
        const retry = retryMetadata(error);
        if (retry.retryable && this.runtimes.has(syncGenerationId)) {
          const attempt = this.failureAttempts.get(syncGenerationId) ?? 0;
          this.failureAttempts.set(syncGenerationId, attempt + 1);
          this.scheduler.scheduleRetry(syncGenerationId, fullJitterBackoffMs({
            failureAttempt: attempt,
            random: retryRandom,
            ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs }),
          }));
        }
        options.onCycleError?.(syncGenerationId, error);
      },
    });
  }

  register(runtime: RegisteredSyncGenerationRuntime): () => void {
    if (this.runtimes.has(runtime.syncGenerationId)) {
      throw new Error(`SyncGeneration ${runtime.syncGenerationId} is already registered with SyncEngine`);
    }
    this.runtimes.set(runtime.syncGenerationId, runtime);
    const unsubscribeStatus = runtime.subscribeStatus?.((source) => {
      if (source.status) {
        this.statusStore.updateCycle(
          source.syncGenerationId,
          source.status,
          source.projectId,
          source.transferProgress ?? null,
        );
      }
    }) ?? (() => {});
    if (runtime.status) {
      this.statusStore.updateCycle(
        runtime.syncGenerationId,
        runtime.status,
        runtime.projectId,
        runtime.transferProgress ?? null,
      );
    }
    this.scheduler.registerSyncGeneration(runtime.syncGenerationId);
    return () => {
      if (this.runtimes.get(runtime.syncGenerationId) !== runtime) return;
      unsubscribeStatus();
      this.runtimes.delete(runtime.syncGenerationId);
      this.failureAttempts.delete(runtime.syncGenerationId);
      this.scheduler.unregisterSyncGeneration(runtime.syncGenerationId);
      this.statusStore.remove(runtime.syncGenerationId);
    };
  }

  triggerLocalCommit(syncGenerationId: string): void {
    if (this.runtimes.has(syncGenerationId)) this.scheduler.triggerLocalCommit(syncGenerationId);
  }

  triggerManual(syncGenerationId: string): void {
    this.scheduler.triggerManual(syncGenerationId);
  }

  triggerStart(): void {
    this.scheduler.triggerStart();
  }

  triggerResume(): void {
    this.scheduler.triggerResume();
  }

  triggerLifecycleFlush(): void {
    this.scheduler.triggerLifecycleFlush();
  }

  setOnline(online: boolean): void {
    this.scheduler.setOnline(online);
  }

  setSuspended(suspended: boolean): void {
    this.scheduler.setSuspended(suspended);
  }

  setForeground(foreground: boolean): void {
    this.scheduler.setForeground(foreground);
  }

  shutdown(): void {
    this.scheduler.shutdown();
  }

  diagnostics(): SyncEngineDiagnostics {
    const scheduler = this.scheduler.snapshot;
    return this.statusStore.diagnostics({
      nowMs: this.nowMs(),
      activeSyncGenerationId: scheduler.activeSyncGenerationId,
      online: scheduler.online,
      suspended: scheduler.suspended,
    });
  }

  registeredSyncGenerationIds(): readonly string[] {
    return Object.freeze([...this.runtimes.keys()].sort());
  }
}

export interface SyncEngineRuntimeSignals {
  readonly authoredCommits: typeof onAuthoredChangeCommitted;
  readonly installLifecycleHook: (hook: SyncEngineLifecycleHook) => () => void;
  readonly lifecycle: Pick<LifecyclePlatformApi, 'onReadyOrResume'>;
  /** Product capability gate; defaults to the local-first personal-cloud policy. */
  readonly canUseProviderTransport?: () => boolean;
  readonly addWindowListener?: (
    event: 'online' | 'offline' | 'focus' | 'blur',
    listener: () => void,
  ) => () => void;
}

function defaultWindowListener(
  event: 'online' | 'offline' | 'focus' | 'blur',
  listener: () => void,
): () => void {
  if (typeof globalThis.addEventListener !== 'function') return () => {};
  globalThis.addEventListener(event, listener);
  return () => globalThis.removeEventListener(event, listener);
}

const defaultSignals: SyncEngineRuntimeSignals = {
  authoredCommits: onAuthoredChangeCommitted,
  installLifecycleHook: installSyncEngineLifecycleHook,
  lifecycle: platform.lifecycle,
  canUseProviderTransport: canUsePersonalCloud,
  addWindowListener: defaultWindowListener,
};

/** Installs authored/lifecycle/network wakeups; every callback only schedules work. */
export function installSyncEngineCoordinatorRuntime(
  coordinator: SyncEngineCoordinator,
  signals: SyncEngineRuntimeSignals = defaultSignals,
): () => void {
  const canUseProviderTransport = signals.canUseProviderTransport ?? (() => true);
  const unsubscribes = [
    signals.authoredCommits((event) => coordinator.triggerLocalCommit(event.syncGenerationId)),
    signals.installLifecycleHook(async (reason) => {
      if (reason === 'suspended' || reason === 'shutdown') {
        coordinator.setSuspended(true);
        return;
      }
      coordinator.triggerLifecycleFlush();
    }),
    signals.lifecycle.onReadyOrResume((event) => {
      coordinator.setSuspended(false);
      if (event === 'resumed') coordinator.triggerResume();
      else coordinator.triggerStart();
    }),
    signals.addWindowListener?.('online', () => {
      coordinator.setOnline(canUseProviderTransport());
    }) ?? (() => {}),
    signals.addWindowListener?.('offline', () => coordinator.setOnline(false)) ?? (() => {}),
    signals.addWindowListener?.('focus', () => coordinator.setForeground(true)) ?? (() => {}),
    signals.addWindowListener?.('blur', () => coordinator.setForeground(false)) ?? (() => {}),
  ];
  coordinator.setOnline(canUseProviderTransport());
  coordinator.setForeground(typeof document === 'undefined' || document.visibilityState === 'visible');
  coordinator.triggerStart();
  return () => {
    for (const unsubscribe of unsubscribes.reverse()) unsubscribe();
    coordinator.shutdown();
  };
}
