import { eq } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import { platform, type GoogleDriveNativeOAuthResult } from '../../platform';
import {
  SyncAppAuthorityTable,
  SyncConnectAttemptTable,
  SyncProviderAccountTable,
} from '../../schema/drizzle';
import {
  restoreGoogleDriveSyncGenerations,
  type RestoreGoogleDriveSyncGenerationsResult,
} from './google-drive-restore';

export interface ProductGoogleDriveConnectResult extends RestoreGoogleDriveSyncGenerationsResult {
  readonly status: 'connected';
  readonly accountSubject: string;
}

export interface ProductGoogleDriveAlreadyConnectedResult {
  readonly status: 'already-connected';
  readonly attemptId: null;
  readonly accountSubject: string;
  readonly restored: readonly [];
  readonly connectedLocalSyncGenerationIds: readonly string[];
}

export type ProductGoogleDriveConnectionResult =
  | ProductGoogleDriveConnectResult
  | ProductGoogleDriveAlreadyConnectedResult;

export interface ProductGoogleDriveConnectDependencies {
  readonly connectAccount: () => Promise<GoogleDriveNativeOAuthResult>;
  readonly reauthorizeAccount: (
    credentialSecretRef: string,
  ) => Promise<GoogleDriveNativeOAuthResult>;
  readonly connect: typeof restoreGoogleDriveSyncGenerations;
}

const defaultDependencies: ProductGoogleDriveConnectDependencies = {
  connectAccount: () => platform.googleDrive.connectAccount(),
  reauthorizeAccount: (credentialSecretRef) =>
    platform.googleDrive.reauthorizeAccount(credentialSecretRef),
  connect: restoreGoogleDriveSyncGenerations,
};

function required(value: string | null, label: string): string {
  if (!value?.trim()) throw new Error(`Durable Google Drive connect is missing ${label}`);
  return value;
}

/** One product action for both first publication and new-device restore. */
export async function connectGoogleDriveFromProduct(
  input: { db: DbClient; signal: AbortSignal },
  dependencies: ProductGoogleDriveConnectDependencies = defaultDependencies,
): Promise<ProductGoogleDriveConnectionResult> {
  const [authority] = await input.db.select().from(SyncAppAuthorityTable).limit(1);
  if (!authority) throw new Error('Sync App authority is unavailable');
  if (input.signal.aborted) throw input.signal.reason;

  if (authority.transitionState === 'stable' && authority.mode === 'google-drive') {
    const [account] = await input.db
      .select({ accountSubject: SyncProviderAccountTable.accountSubjectId })
      .from(SyncProviderAccountTable)
      .where(eq(SyncProviderAccountTable.authorityGeneration, authority.generation))
      .limit(1);
    return {
      status: 'already-connected',
      attemptId: null,
      accountSubject: required(account?.accountSubject ?? null, 'account subject'),
      restored: [],
      connectedLocalSyncGenerationIds: [],
    };
  }
  if (authority.transitionState === 'stable' && authority.mode !== 'local') {
    throw new Error('Google Drive connect cannot replace another cloud provider');
  }

  let account: GoogleDriveNativeOAuthResult;
  let attemptId: string | undefined;
  if (authority.transitionState === 'stable') {
    account = await dependencies.connectAccount();
  } else {
    if (!authority.attemptId) throw new Error('Sync provider transition has no durable attempt');
    const [attempt] = await input.db
      .select({
        kind: SyncConnectAttemptTable.kind,
        targetMode: SyncConnectAttemptTable.targetMode,
        accountSubject: SyncConnectAttemptTable.targetAccountSubjectId,
        credentialSecretRef: SyncConnectAttemptTable.targetCredentialSecretRef,
        errorCode: SyncConnectAttemptTable.errorCode,
      })
      .from(SyncConnectAttemptTable)
      .where(eq(SyncConnectAttemptTable.attemptId, authority.attemptId))
      .limit(1);
    if (attempt?.kind !== 'connect' || attempt.targetMode !== 'google-drive') {
      throw new Error('Another sync provider transition is already in progress');
    }
    const accountSubject = required(attempt.accountSubject, 'account subject');
    const credentialSecretRef = required(
      attempt.credentialSecretRef,
      'credential secret reference',
    );
    account =
      attempt.errorCode === 'needs-reauth' || attempt.errorCode === 'permission-denied'
        ? await dependencies.reauthorizeAccount(credentialSecretRef)
        : { accountSubject, credentialSecretRef };
    if (
      account.accountSubject !== accountSubject ||
      account.credentialSecretRef !== credentialSecretRef
    ) {
      throw new Error('Google Drive retry selected another account or credential identity');
    }
    attemptId = authority.attemptId;
  }

  const result = await dependencies.connect({
    db: input.db,
    account,
    signal: input.signal,
    ...(attemptId ? { attemptId } : {}),
  });
  return {
    ...result,
    status: 'connected',
    accountSubject: account.accountSubject,
  };
}
