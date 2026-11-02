/**
 * Account-isolated libraries (docs/hosted-sync/account-libraries.md).
 *
 * Every Hosted account has its own library and a separate local library holds
 * signed-out writing. A library is a whole native data root, chosen once per
 * process; switching relaunches the App, so nothing here ever sees two
 * libraries. Signing in opens that account's library (a new one starts empty
 * and restores from the cloud; local books are never brought in). An explicit
 * sign-out returns to the local library. An expired session is not a sign-out:
 * the author keeps writing the same library.
 */
import loglevel from 'loglevel';
import { getDb } from '../lib/db';
import { flushLocalApplicationPersistence } from '../lib/persistence-lifecycle';
import { isTauriRuntime, platform } from '../platform';
import type { LibraryOwner } from '../platform';
import { getPlatformRuntime } from '../platform/runtime';
import { SyncConnectAttemptTable, SyncProviderAccountTable } from '../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../sync/app-authority-repository';

const log = loglevel.getLogger('AccountLibrary');

let runningOwner: LibraryOwner | null = null;

/** Desktop switches by relaunching; browser hosts and mobile keep one library. */
export function librarySwitchingAvailable(): boolean {
  return isTauriRuntime() && Boolean(platform.library) && !getPlatformRuntime().isMobile;
}

/** The owner of the library this process runs on, once startup has settled it. */
export function runningLibraryOwner(): LibraryOwner | null {
  return runningOwner;
}

/** True when this process already runs on `subject`'s library. */
export function runsOnAccountLibrary(subject: string): boolean {
  return sameOwner(runningOwner, { kind: 'account', subject });
}

export function isAccountLibrary(): boolean {
  return runningOwner?.kind === 'account';
}

function sameOwner(a: LibraryOwner | null, b: LibraryOwner): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === 'local' || (b.kind === 'account' && a.subject === b.subject);
}

/**
 * Who an unclaimed (pre-registry) library belongs to, from its own sync
 * authority: the account it is bound or connecting to, otherwise local.
 */
async function ownerFromAuthority(): Promise<LibraryOwner> {
  const db = getDb();
  const authority = await createSyncAppAuthorityRepository(db).read();
  const hosted =
    authority.mode === 'hosted' ||
    (authority.transitionState !== 'stable' && authority.targetMode === 'hosted');
  if (!hosted) return { kind: 'local' };
  const accounts = await db.select().from(SyncProviderAccountTable);
  const bound = accounts.find((account) => account.providerKind === 'hosted');
  if (bound) return { kind: 'account', subject: bound.accountSubjectId };
  const attempts = await db.select().from(SyncConnectAttemptTable);
  const target = attempts.find((attempt) => attempt.attemptId === authority.attemptId);
  return target?.targetAccountSubjectId
    ? { kind: 'account', subject: target.targetAccountSubjectId }
    : { kind: 'local' };
}

/** Relaunch onto `owner`'s library. Resolves only when no relaunch is needed. */
async function activate(owner: LibraryOwner): Promise<void> {
  await flushLocalApplicationPersistence();
  const activation = await platform.library!.activate(owner);
  if (!activation.restarting) return;
  log.info(`[library] relaunching onto ${activation.libraryId}`);
  // The quit flush barrier ends this process; nothing may run against the
  // library being left, so callers wait here until the relaunch.
  await new Promise<never>(() => undefined);
}

/**
 * Settle the running library at startup, after the database opened and before
 * any runtime starts. Claims an upgraded install's library from its authority,
 * then makes sure a signed-in author (cached profile, including an expired
 * session) runs on that account's library. Never resolves when it relaunches.
 */
export async function settleRunningLibrary(signedInSubject: string | null): Promise<void> {
  if (!isTauriRuntime() || !platform.library) return;
  try {
    let state = await platform.library.state();
    if (!state.activeOwner) state = await platform.library.claimOwner(await ownerFromAuthority());
    runningOwner = state.activeOwner;
  } catch (error) {
    // A broken registry must not stop local writing; this process keeps the
    // library it opened, and switching stays unavailable until it is repaired.
    log.error('[library] could not settle the running library', error);
    return;
  }
  if (!signedInSubject || !librarySwitchingAvailable()) return;
  const owner: LibraryOwner = { kind: 'account', subject: signedInSubject };
  if (sameOwner(runningOwner, owner)) return;
  await activate(owner).catch((error: unknown) => {
    log.error('[library] could not open the signed-in account library', error);
  });
}

/**
 * Before a session is adopted: an account must run on its own library. The
 * caller has persisted the session and profile, so the relaunched process
 * adopts it there. Never resolves when it relaunches.
 */
export async function openLibraryForAccount(subject: string): Promise<void> {
  if (!librarySwitchingAvailable()) return;
  const owner: LibraryOwner = { kind: 'account', subject };
  if (sameOwner(runningOwner, owner)) return;
  await activate(owner);
}

/** After an explicit sign-out: return to the local library. */
export async function openLocalLibrary(): Promise<void> {
  if (!librarySwitchingAvailable()) return;
  if (sameOwner(runningOwner, { kind: 'local' })) return;
  await activate({ kind: 'local' });
}

/**
 * A new account library restores its cloud projects as soon as the session
 * is verified. Only a library that has never connected qualifies: an author
 * who disconnected this library's sync keeps that choice.
 */
export async function needsFirstAccountConnect(subject: string): Promise<boolean> {
  if (!sameOwner(runningOwner, { kind: 'account', subject })) return false;
  const db = getDb();
  const authority = await createSyncAppAuthorityRepository(db).read();
  if (authority.mode !== 'local' || authority.transitionState !== 'stable') return false;
  const attempts = await db.select({ id: SyncConnectAttemptTable.attemptId }).from(SyncConnectAttemptTable).limit(1);
  return attempts.length === 0;
}

/** Test seam: the owner a settled startup recorded. */
export function setRunningLibraryOwnerForTests(owner: LibraryOwner | null): void {
  runningOwner = owner;
}
