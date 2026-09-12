import { getDb, getDbIfInitialized } from '../lib/db';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import { flushPendingAtomicSyncTransactions } from './atomic-sync-transaction-tracker';
import { captureWorkspaceProjection, type WorkspaceProjectionCapture } from './workspace-projection.service';

export const WORKSPACE_REFRESH_WINDOW_MS = 250;
const MAX_RETRY_MS = 4_000;

interface WorkspaceProjectionRefreshOptions {
  projectId: string;
  userId: string;
  onPublished: (capture: WorkspaceProjectionCapture) => void;
  onMissing: () => void;
  onError: (error: unknown) => void;
  capture?: typeof captureWorkspaceProjection;
  flushDurability?: typeof flushPendingAtomicSyncTransactions;
}

/**
 * One project/database owner, one in-flight capture and one pending epoch.
 * A fixed first-arrival window bounds read starvation under continuous sync.
 * Every read is still a complete SQLite snapshot; partial capture must first
 * account for historical effects rematerialized by the canonical reducer.
 */
export function createWorkspaceProjectionRefresh(options: WorkspaceProjectionRefreshOptions) {
  const { projectId, userId } = options;
  const database = getDb();
  const capture = options.capture ?? captureWorkspaceProjection;
  const flushDurability = options.flushDurability ?? flushPendingAtomicSyncTransactions;
  let disposed = false;
  let pendingEpoch: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let retries = 0;

  function isCurrent(epoch?: number): boolean {
    if (disposed) return false;
    if (getDbIfInitialized() !== database) return false;
    const state = useDataStore.getState();
    return state.workspaceRequestedProjectId === projectId &&
      (epoch === undefined || state.workspaceProjectionEpoch === epoch);
  }

  function schedule() {
    if (timer !== null || running || pendingEpoch === null || !isCurrent()) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, Math.min(MAX_RETRY_MS, WORKSPACE_REFRESH_WINDOW_MS * 2 ** retries));
  }

  function request() {
    if (!isCurrent()) return;
    if (pendingEpoch === null || !isCurrent(pendingEpoch)) {
      pendingEpoch = useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing');
    }
    schedule();
  }

  function retry(epoch: number) {
    if (!isCurrent(epoch)) return;
    retries = Math.min(retries + 1, 4);
    request();
  }

  async function captureAndPublish(epoch: number) {
    try {
      await flushDurability();
      if (!isCurrent(epoch)) return;
      const base = useDataStore.getState();
      const projectBase = useProjectStore.getState().currentProject;
      const result = await capture({ projectId, userId });
      if (!isCurrent(epoch)) return;
      if (useProjectStore.getState().currentProject !== projectBase) {
        retry(epoch);
        return;
      }
      if (!result) {
        if (useDataStore.getState().clearWorkspaceProjection(projectId, epoch, base)) options.onMissing();
        else retry(epoch);
        return;
      }
      const accepted = useDataStore.getState()
        .commitWorkspaceProjection(projectId, epoch, result.data, base);
      if (!accepted) {
        // Optimistic edits/derived metrics changed data without changing the
        // request epoch. Keep the barrier and recapture; never publish the old
        // snapshot or leave a rejected capture stuck in "refreshing".
        retry(epoch);
        return;
      }
      retries = 0;
      options.onPublished(result);
    } catch (error) {
      if (!isCurrent(epoch)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (useDataStore.getState().failWorkspaceProjection(projectId, epoch, message)) {
        options.onError(error);
      }
    }
  }

  function run(): Promise<void> {
    if (running) return running;
    if (pendingEpoch === null || !isCurrent()) return Promise.resolve();
    const epoch = pendingEpoch;
    pendingEpoch = null;
    running = captureAndPublish(epoch).finally(() => {
      running = null;
      schedule();
    });
    return running;
  }

  return {
    request,
    /** Drain one pass for acceptance/teardown; sustained arrivals stay bounded. */
    flush() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return run();
    },
    dispose() {
      disposed = true;
      pendingEpoch = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
