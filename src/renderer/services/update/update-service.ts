import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import type { AppUpdateMetadata } from '../../platform/contracts';
import { flushLocalApplicationPersistence } from '../../lib/persistence-lifecycle';
import { reportDiagnosticLog, reportIntegrityEvent } from '../diagnostics/crash-reporter';

/** Automatic checks run at most this often, at launch and while the app stays open. */
export const AUTO_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1_000;
const LAST_CHECK_KEY = 'drifting.alpha-updater.last-check.v1';
/** The update being installed, so the relaunched version can say what changed. */
const INSTALLED_UPDATE_KEY = 'drifting.updater.installed.v1';
/**
 * The newest release a check found and whether the author has opened its
 * notice. A relaunch before installing looks it up again at once, so the bell
 * keeps its mark until the author opens the notification center.
 */
const FOUND_UPDATE_KEY = 'drifting.updater.found.v1';
/** Published as `error` when local writes could not be saved before installing. */
export const UPDATE_LOCAL_SAVE_FAILED = 'UPDATE_LOCAL_SAVE_FAILED';
/** Published as `error` when the check could not reach a valid release manifest
 * (no network, the release site down, no published release yet). The author
 * sees a plain sentence instead of the updater's own words. */
export const UPDATE_CHECK_FAILED = 'UPDATE_CHECK_FAILED';

export type UpdateServicePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
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
/** The running check, which a second check joins instead of starting another. */
let activeCheck: Promise<UpdateServiceState> | null = null;
/** The version whose verified bytes the native side holds, ready to install. */
let downloadedVersion: string | null = null;
/** Whether this launch has already looked up an update found by an earlier one. */
let foundUpdateRechecked = false;

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

interface FoundUpdate {
  readonly version: string;
  readonly seen: boolean;
}

function readFoundUpdate(): FoundUpdate | null {
  try {
    const value = JSON.parse(localStorage.getItem(FOUND_UPDATE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return null;
    const { version, seen } = value as Record<string, unknown>;
    return typeof version === 'string' ? { version, seen: seen === true } : null;
  } catch {
    return null;
  }
}

function writeFoundUpdate(value: FoundUpdate | null): void {
  try {
    if (value) localStorage.setItem(FOUND_UPDATE_KEY, JSON.stringify(value));
    else localStorage.removeItem(FOUND_UPDATE_KEY);
  } catch {
    // Losing the record only means a relaunch waits for the next due check.
  }
}

/** Whether the author has already opened the notice for this found version. */
export function foundUpdateSeen(version: string): boolean {
  const found = readFoundUpdate();
  return found?.version === version && found.seen;
}

/** The author opened this version's notice: later launches bring it back read. */
export function markFoundUpdateSeen(version: string): void {
  const found = readFoundUpdate();
  if (found?.version === version && !found.seen) writeFoundUpdate({ version, seen: true });
}

function currentAppVersion(): string | null {
  return getPlatformRuntime().appInfo?.version ?? null;
}

/**
 * A check replaces the native pending update and drops its downloaded bytes,
 * so no automatic check runs while an update is downloading, downloaded, or
 * installing.
 */
function automaticCheckDue(now: number): boolean {
  if (downloadedVersion !== null) return false;
  if (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'installing') return false;
  const elapsed = now - lastAutomaticCheck();
  if (elapsed < 0 || elapsed >= AUTO_CHECK_INTERVAL_MS) return true;
  // An update found before this launch and not installed yet is looked up
  // again at once, so its notice and Install button come back.
  if (foundUpdateRechecked) return false;
  foundUpdateRechecked = true;
  const found = readFoundUpdate();
  return found !== null && found.version !== currentAppVersion();
}

export interface InstalledUpdate {
  readonly version: string;
  readonly notes: string | null;
}

function readInstalledUpdate(): (InstalledUpdate & { announced: boolean }) | null {
  try {
    const value = JSON.parse(localStorage.getItem(INSTALLED_UPDATE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return null;
    const { version, notes, announced } = value as Record<string, unknown>;
    if (typeof version !== 'string') return null;
    return { version, notes: typeof notes === 'string' && notes.trim() ? notes : null, announced: announced === true };
  } catch {
    return null;
  }
}

function writeInstalledUpdate(value: InstalledUpdate & { announced: boolean }): void {
  try {
    localStorage.setItem(INSTALLED_UPDATE_KEY, JSON.stringify(value));
  } catch {
    // Losing the record only skips the "updated" notice; installation is unaffected.
  }
}

/** The installed update's notes, while the app still runs that version. */
export function installedUpdateFor(version: string): InstalledUpdate | null {
  const record = readInstalledUpdate();
  return record?.version === version ? { version: record.version, notes: record.notes } : null;
}

/** The update this launch finished installing, returned once. */
export function takeUnannouncedInstalledUpdate(version: string): InstalledUpdate | null {
  const record = readInstalledUpdate();
  if (!record || record.version !== version || record.announced) return null;
  writeInstalledUpdate({ ...record, announced: true });
  return { version: record.version, notes: record.notes };
}

async function check(options: { manual?: boolean } = {}): Promise<UpdateServiceState> {
  if (!updaterAvailable()) return state;
  if (activeCheck) return activeCheck;
  // An install in progress owns the native pending update.
  if (activeOperation) return state;
  const now = Date.now();
  if (!options.manual && !automaticCheckDue(now)) return state;
  // An automatic check while an update is already offered keeps offering it
  // until the answer arrives: the Install button never flickers away.
  const quiet = !options.manual && state.phase === 'available' && state.update !== null;
  // This launch now knows the latest release; no relaunch recheck is owed.
  foundUpdateRechecked = true;
  const operation = (async () => {
    if (!options.manual) markAutomaticCheck(now);
    if (!quiet) publish({ phase: 'checking', update: null, downloadedBytes: 0, totalBytes: null, error: null });
    try {
      const update = await platform.updater.check();
      downloadedVersion = null;
      reportDiagnosticLog('update-check-completed', { durationMs: Date.now() - now });
      const found = readFoundUpdate();
      writeFoundUpdate(update ? { version: update.version, seen: found?.version === update.version && found.seen } : null);
      publish({
        phase: update ? 'available' : 'idle',
        update,
        downloadedBytes: 0,
        totalBytes: null,
        error: null,
      });
      return state;
    } catch {
      reportDiagnosticLog('update-check-failed', { durationMs: Date.now() - now });
      // A failed check leaves the native pending update alone; keep offering it.
      if (quiet) return state;
      publish({
        phase: 'error',
        update: null,
        downloadedBytes: 0,
        totalBytes: null,
        error: UPDATE_CHECK_FAILED,
      });
      return state;
    } finally {
      activeOperation = null;
      activeCheck = null;
    }
  })();
  activeOperation = operation;
  activeCheck = operation;
  return operation;
}

async function downloadVerified(update: AppUpdateMetadata): Promise<void> {
  publish({ phase: 'downloading', update, downloadedBytes: 0, totalBytes: null, error: null });
  try {
    const verifiedSize = await platform.updater.download((event) => {
      if (event.event === 'Started') {
        publish({ ...state, totalBytes: event.data.contentLength });
      } else if (event.event === 'Progress') {
        publish({ ...state, downloadedBytes: state.downloadedBytes + event.data.chunkLength });
      }
    });
    downloadedVersion = update.version;
    reportDiagnosticLog('update-download-completed', { bytes: verifiedSize });
    publish({
      phase: 'ready',
      update,
      downloadedBytes: verifiedSize,
      totalBytes: state.totalBytes ?? verifiedSize,
      error: null,
    });
  } catch (error) {
    reportDiagnosticLog('update-download-failed');
    publish({ ...state, phase: 'error', update, error: errorMessage(error) });
    throw error;
  }
}

/**
 * One click from a found update to the relaunched new version: download and
 * verify it unless that already happened, save every local write, install,
 * relaunch. A step that fails leaves the current version running and the
 * reason in `error`; clicking again resumes from the verified download.
 */
async function install(): Promise<void> {
  if (state.phase === 'downloading' || state.phase === 'installing') {
    throw new Error('Another updater operation is still running');
  }
  // A quiet automatic check may be refreshing the offered update.
  if (activeOperation) await activeOperation.catch(() => undefined);
  if (activeOperation) throw new Error('Another updater operation is still running');
  const update = state.update;
  if (!update || (state.phase !== 'available' && state.phase !== 'ready' && state.phase !== 'error')) {
    throw new Error('There is no checked update to install');
  }
  const operation = (async () => {
    try {
      if (downloadedVersion !== update.version) await downloadVerified(update);
      publish({ ...state, phase: 'installing', error: null });
      // Installing ends in a relaunch. Refuse to start it until every local
      // write is durable; the verified download stays ready for a retry.
      try {
        await flushLocalApplicationPersistence();
      } catch (error) {
        publish({ ...state, phase: 'ready', error: UPDATE_LOCAL_SAVE_FAILED });
        reportIntegrityEvent('local-flush-failed', error, { reason: 'update-install' });
        throw error;
      }
      try {
        // Native installs, then relaunches through the ordinary quit flush.
        reportDiagnosticLog('update-install-started');
        writeInstalledUpdate({ version: update.version, notes: update.notes ?? null, announced: false });
        await platform.updater.install();
      } catch (error) {
        // The native side keeps the verified bytes, so a retry installs them.
        publish({ ...state, phase: 'error', error: errorMessage(error) });
        throw error;
      }
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
  downloadedVersion = null;
  if (state.update) markFoundUpdateSeen(state.update.version);
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
  install,
  dismiss,
});
