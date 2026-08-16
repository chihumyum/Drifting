import loglevel from 'loglevel';
import { checkpointDatabase } from './db';
import { saveActiveEditor } from './active-editor';
import { flushSessionTokenStorage } from './session-token';
import {
  flushAllOpenYjsDocuments,
  waitForYjsDocumentTeardown,
} from '../services/yjs-local-durability.service';
import { flushSnapshotHistoryPersistence } from '../services/snapshot-history.service';
import { flushPendingAtomicSyncTransactions } from '../services/atomic-sync-transaction-tracker';
import { flushPendingAssetPersistence } from '../services/asset-store.service';

const log = loglevel.getLogger('persistence-lifecycle');

let localFlushTail: Promise<void> = Promise.resolve();
export type SyncEngineLifecycleReason = 'shutdown' | 'suspended' | 'database-switch';
export type SyncEngineLifecycleHook = (reason: SyncEngineLifecycleReason) => Promise<void>;
let syncEngineLifecycleHook: SyncEngineLifecycleHook | null = null;

/** Install the single global SyncEngine lifecycle trigger. */
export function installSyncEngineLifecycleHook(hook: SyncEngineLifecycleHook): () => void {
  if (syncEngineLifecycleHook && syncEngineLifecycleHook !== hook) {
    throw new Error('A SyncEngine lifecycle hook is already installed');
  }
  syncEngineLifecycleHook = hook;
  return () => {
    if (syncEngineLifecycleHook === hook) syncEngineLifecycleHook = null;
  };
}

async function performLocalFlush(): Promise<void> {
  // Ordering is intentional. Saving the editor can start Yjs persistence;
  // asset imports may begin before their authored SQLite transaction, while
  // deletes may start file cleanup after it. Drain both sides before the DB
  // checkpoint so the lifecycle barrier covers every local durability lane.
  const steps: Array<() => Promise<unknown>> = [
    () => saveActiveEditor(),
    () => flushAllOpenYjsDocuments(),
    () => flushSnapshotHistoryPersistence(),
    () => flushPendingAssetPersistence(),
    () => flushPendingAtomicSyncTransactions(),
    () => flushPendingAssetPersistence(),
    () => checkpointDatabase(),
    () => flushSessionTokenStorage(),
  ];
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} local persistence step(s) failed`);
  }
}

/**
 * Serialize local durability barriers so close + suspend cannot checkpoint
 * over one another. This path never waits for network I/O.
 */
export function flushLocalApplicationPersistence(): Promise<void> {
  const operation = localFlushTail.catch(() => undefined).then(performLocalFlush);
  localFlushTail = operation.catch(() => undefined);
  return operation;
}

/**
 * Deliver one best-effort SyncEngine lifecycle signal.
 *
 * Until the engine installs its global hook this is an intentional no-op.
 * No legacy hosted entity/Yjs/preferences transport is reachable from the
 * lifecycle path.
 */
export function flushRemoteApplicationPersistence(
  reason: SyncEngineLifecycleReason = 'database-switch',
): Promise<void> {
  const hook = syncEngineLifecycleHook;
  if (!hook) return Promise.resolve();

  return Promise.resolve()
    .then(() => hook(reason))
    .catch((error) => {
      log.warn(
        '[persistence] SyncEngine lifecycle cycle failed; local journal remains durable',
        error,
      );
    });
}

/**
 * Native close/suspend barrier. Resolve after local SQLite/keychain durability,
 * then let remote sync continue without holding the native shutdown deadline.
 */
export async function flushApplicationPersistenceForLifecycle(
  reason: Extract<SyncEngineLifecycleReason, 'shutdown' | 'suspended'> = 'shutdown',
): Promise<void> {
  try {
    await flushLocalApplicationPersistence();
  } finally {
    // Lifecycle hooks never wait for provider I/O. They synchronously freeze
    // the scheduler so a suspend/shutdown cannot start a background request.
    await flushRemoteApplicationPersistence(reason);
  }
}

/**
 * Account/database switch barrier. Unlike native close, a DB switch must wait
 * for remote work while the old user's Y.Docs and credentials are still
 * active, then unmount and checkpoint once more after close snapshots land.
 */
export async function quiesceApplicationForDatabaseSwitch(
  unmountActiveViews: () => void,
  options: { flushRemote?: boolean } = {},
): Promise<void> {
  await flushLocalApplicationPersistence();
  if (options.flushRemote !== false) {
    await flushRemoteApplicationPersistence('database-switch');
  }
  unmountActiveViews();
  await waitForYjsDocumentTeardown();
  await flushLocalApplicationPersistence();
}

/**
 * Credential loss is different from a voluntary account switch: remote work
 * cannot be attempted after the bearer has been rejected, and local flush
 * failures must not keep protected views mounted forever. The caller still
 * receives an AggregateError after teardown so it can report the durability
 * problem while continuing the database reset.
 */
export async function quiesceApplicationAfterCredentialLoss(
  unmountActiveViews: () => void,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await flushLocalApplicationPersistence();
  } catch (error) {
    failures.push(error);
  }

  unmountActiveViews();

  try {
    await waitForYjsDocumentTeardown();
  } catch (error) {
    failures.push(error);
  }

  try {
    await flushLocalApplicationPersistence();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} credential-loss persistence step(s) failed`,
    );
  }
}
