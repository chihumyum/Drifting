import { eq } from 'drizzle-orm';

import { getDb, type DbClient } from '../../lib/db';
import { events } from '../../lib/events';
import { platform } from '../../platform';
import { SyncConnectAttemptTable } from '../../schema/drizzle';
import { createSyncAppAuthorityRepository } from '../app-authority-repository';

interface PendingTransitionCancelDependencies {
  readonly db: DbClient;
  readonly revokeCredential: (credentialSecretRef: string, signal: AbortSignal) => Promise<void>;
  readonly emitAuthorityChanged: () => void;
  readonly nowIso: () => string;
}

export interface PendingTransitionCancelResult {
  readonly status: 'cancelled' | 'already-local';
  readonly attemptId: string | null;
  readonly kind: 'connect' | 'restore' | null;
}

function cancellationErrorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'CANCELLED';
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code).slice(0, 128);
  }
  return 'TRANSITION_CANCEL_FAILED';
}

/**
 * Cancels an unactivated local -> Drive transition, revokes its native
 * credential and preserves every authored local project.
 */
export async function cancelPendingGoogleDriveTransition(
  dependencies: PendingTransitionCancelDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<PendingTransitionCancelResult> {
  const repository = createSyncAppAuthorityRepository(dependencies.db);
  const authority = await repository.read();
  if (authority.transitionState === 'stable') {
    if (authority.mode !== 'local') {
      throw new Error('Connected Google Drive must use the disconnect flow');
    }
    return { status: 'already-local', attemptId: null, kind: null };
  }
  if (authority.mode !== 'local' || authority.targetMode !== 'google-drive') {
    throw new Error('Only an unactivated local Google Drive transition can be cancelled');
  }
  const [attempt] = await dependencies.db
    .select({
      kind: SyncConnectAttemptTable.kind,
      credentialSecretRef: SyncConnectAttemptTable.targetCredentialSecretRef,
    })
    .from(SyncConnectAttemptTable)
    .where(eq(SyncConnectAttemptTable.attemptId, authority.attemptId))
    .limit(1);
  if (
    !attempt ||
    (attempt.kind !== 'connect' && attempt.kind !== 'restore') ||
    !attempt.credentialSecretRef?.trim()
  ) {
    throw new Error('Pending Google Drive transition credential is unavailable');
  }

  try {
    if (signal.aborted) throw signal.reason;
    await dependencies.revokeCredential(attempt.credentialSecretRef, signal);
    await repository.cancel({ attemptId: authority.attemptId, nowIso: dependencies.nowIso() });
    dependencies.emitAuthorityChanged();
    return {
      status: 'cancelled',
      attemptId: authority.attemptId,
      kind: attempt.kind,
    };
  } catch (error) {
    const current = await repository.read().catch(() => null);
    if (current?.transitionState !== 'stable' && current?.attemptId === authority.attemptId) {
      await repository
        .block({
          attemptId: authority.attemptId,
          errorCode: cancellationErrorCode(error),
          nowIso: dependencies.nowIso(),
        })
        .catch(() => undefined);
      dependencies.emitAuthorityChanged();
    }
    throw error;
  }
}

export function cancelPendingGoogleDriveTransitionFromProduct(
  db: DbClient = getDb(),
  signal: AbortSignal = new AbortController().signal,
): Promise<PendingTransitionCancelResult> {
  return cancelPendingGoogleDriveTransition(
    {
      db,
      revokeCredential: (credentialSecretRef, abortSignal) =>
        platform.googleDrive.revokeAccount(credentialSecretRef, abortSignal),
      emitAuthorityChanged: () => events.emit('sync:authority-changed'),
      nowIso: () => new Date().toISOString(),
    },
    signal,
  );
}
