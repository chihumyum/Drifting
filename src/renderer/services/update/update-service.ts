import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import type { AppUpdateMetadata } from '../../platform/contracts';

const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const LAST_CHECK_KEY = 'drifting.alpha-updater.last-check.v1';

export type UpdateServicePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateServiceState {
  readonly phase: UpdateServicePhase;
  readonly update: AppUpdateMetadata | null;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly error: string | null;
}

type UpdateServiceListener = (state: UpdateServiceState) => void;

let state: UpdateServiceState = Object.freeze({
  phase: 'idle',
  update: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
});
const listeners = new Set<UpdateServiceListener>();
let activeOperation: Promise<unknown> | null = null;

function publish(next: UpdateServiceState): void {
  state = Object.freeze(next);
  for (const listener of listeners) listener(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updaterAvailable(): boolean {
  const runtime = getPlatformRuntime();
  return runtime.target === 'desktop' && runtime.capabilities?.featureStatus.appUpdater === 'available';
}

function lastAutomaticCheck(): number {
  try {
    const value = Number(localStorage.getItem(LAST_CHECK_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function markAutomaticCheck(now: number): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(now));
  } catch {
    // A disabled preference store may cause another check next launch, but it
    // never weakens update signature verification or installation safety.
  }
}

async function check(options: { manual?: boolean } = {}): Promise<UpdateServiceState> {
  if (!updaterAvailable()) return state;
  const now = Date.now();
  if (!options.manual && now - lastAutomaticCheck() < AUTO_CHECK_INTERVAL_MS) return state;
  if (activeOperation) return activeOperation as Promise<UpdateServiceState>;
  const operation = (async () => {
    if (!options.manual) markAutomaticCheck(now);
    publish({ phase: 'checking', update: null, downloadedBytes: 0, totalBytes: null, error: null });
    try {
      const update = await platform.updater.check();
      publish({
        phase: update ? 'available' : 'idle',
        update,
        downloadedBytes: 0,
        totalBytes: null,
        error: null,
      });
      return state;
    } catch (error) {
      publish({
        phase: 'error',
        update: null,
        downloadedBytes: 0,
        totalBytes: null,
        error: errorMessage(error),
      });
      return state;
    } finally {
      activeOperation = null;
    }
  })();
  activeOperation = operation;
  return operation;
}

async function download(): Promise<UpdateServiceState> {
  if (state.phase !== 'available' || !state.update) {
    throw new Error('There is no checked update to download');
  }
  if (activeOperation) return activeOperation as Promise<UpdateServiceState>;
  const update = state.update;
  const operation = (async () => {
    publish({ ...state, phase: 'downloading', downloadedBytes: 0, totalBytes: null, error: null });
    try {
      const verifiedSize = await platform.updater.download((event) => {
        if (event.event === 'Started') {
          publish({ ...state, totalBytes: event.data.contentLength });
        } else if (event.event === 'Progress') {
          publish({ ...state, downloadedBytes: state.downloadedBytes + event.data.chunkLength });
        }
      });
      publish({
        phase: 'ready',
        update,
        downloadedBytes: verifiedSize,
        totalBytes: state.totalBytes ?? verifiedSize,
        error: null,
      });
      return state;
    } catch (error) {
      publish({ ...state, phase: 'error', update, error: errorMessage(error) });
      return state;
    } finally {
      activeOperation = null;
    }
  })();
  activeOperation = operation;
  return operation;
}

async function install(): Promise<void> {
  if (state.phase !== 'ready' || !state.update) {
    throw new Error('The checked update is not ready to install');
  }
  if (activeOperation) throw new Error('Another updater operation is still running');
  const operation = (async () => {
    try {
      await platform.updater.install();
    } catch (error) {
      publish({ ...state, phase: 'error', error: errorMessage(error) });
      throw error;
    } finally {
      activeOperation = null;
    }
  })();
  activeOperation = operation;
  await operation;
}

async function dismiss(): Promise<void> {
  if (activeOperation) throw new Error('Another updater operation is still running');
  await platform.updater.dismiss();
  publish({ phase: 'idle', update: null, downloadedBytes: 0, totalBytes: null, error: null });
}

function subscribe(listener: UpdateServiceListener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export const UpdateService = Object.freeze({
  getState: () => state,
  subscribe,
  check,
  download,
  install,
  dismiss,
});
