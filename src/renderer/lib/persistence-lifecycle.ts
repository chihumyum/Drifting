import loglevel from 'loglevel';
import { checkpointDatabase } from './db';
import { saveActiveEditor } from './active-editor';
import { flushSessionTokenStorage } from './session-token';
import {
  flushPendingEntityPersistence,
  forceFlush as forceFlushEntitySync,
} from '../services/entity-sync.service';
import {
  flushAllOpenYjsDocuments,
  forceSyncAllDocuments,
  waitForYjsDocumentTeardown,
} from '../services/yjs-sync.service';
import { flushPreferencesSync } from '../services/preferences-sync.service';
import { flushSnapshotHistoryPersistence } from '../services/snapshot-history.service';

const log = loglevel.getLogger('persistence-lifecycle');

let localFlushTail: Promise<void> = Promise.resolve();
let remoteFlushInFlight: Promise<void> | null = null;

async function performLocalFlush(): Promise<void> {
  // Ordering is intentional. Saving the editor can start Yjs and atomic entity
  // persistence, so drain both before checkpointing the database.
  const steps: Array<() => Promise<unknown>> = [
    () => saveActiveEditor(),
    () => flushAllOpenYjsDocuments(),
    () => flushSnapshotHistoryPersistence(),
    () => flushPendingEntityPersistence(),
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

/** Start one coalesced best-effort remote flush. Local outboxes are already durable. */
export function flushRemoteApplicationPersistence(): Promise<void> {
  if (remoteFlushInFlight) return remoteFlushInFlight;

  const operation = Promise.allSettled([
    forceFlushEntitySync(),
    forceSyncAllDocuments(),
    flushPreferencesSync(),
  ]).then((results) => {
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      log.warn(
        `[persistence] ${failures.length} remote flush operation(s) failed; durable local outboxes remain for retry`,
      );
    }
  });
  const inFlight = operation.finally(() => {
    if (remoteFlushInFlight === inFlight) remoteFlushInFlight = null;
  });
  remoteFlushInFlight = inFlight;
  return inFlight;
}

/**
 * Native close/suspend barrier. Resolve after local SQLite/keychain durability,
 * then let remote sync continue without holding the native shutdown deadline.
 */
export async function flushApplicationPersistenceForLifecycle(): Promise<void> {
  try {
    await flushLocalApplicationPersistence();
  } finally {
    void flushRemoteApplicationPersistence();
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
  if (options.flushRemote !== false) await flushRemoteApplicationPersistence();
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
