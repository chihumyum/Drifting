import { and, eq, inArray } from 'drizzle-orm';

import { getDb, type DbClient } from '../lib/db';
import { events } from '../lib/events';
import { platform } from '../platform';
import {
  SyncAppAuthorityTable,
  SyncConnectAttemptTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
} from '../schema/drizzle';
import { cancelPendingGoogleDriveTransitionFromProduct } from './connect/pending-transition-cancel';
import { createGoogleDriveDisconnectOrchestrator } from './disconnect';
import { productSyncRuntimeControl } from './product-runtime-control';
import { requestGoogleDriveSyncGenerationProvisioning } from './provision';
import {
  connectGoogleDriveFromProduct,
  type ProductGoogleDriveConnectionResult,
} from './restore';

export interface ProductSyncCommandDependencies {
  readonly database: () => DbClient;
  readonly connectGoogleDrive: (
    database: DbClient,
    signal: AbortSignal,
  ) => Promise<ProductGoogleDriveConnectionResult>;
  readonly reauthorizeGoogleDrive: (
    credentialSecretRef: string,
  ) => Promise<{ credentialSecretRef: string; accountSubject: string }>;
  readonly disconnectGoogleDrive: (database: DbClient, signal: AbortSignal) => Promise<unknown>;
  readonly cancelPendingGoogleDrive: (database: DbClient, signal: AbortSignal) => Promise<unknown>;
  readonly triggerManual: () => void;
  readonly requestProvisioning: () => boolean;
  readonly emitAuthorityChanged: () => void;
  readonly nowIso: () => string;
}

const defaultDependencies: ProductSyncCommandDependencies = {
  database: getDb,
  connectGoogleDrive: (database, signal) =>
    connectGoogleDriveFromProduct({ db: database, signal }),
  reauthorizeGoogleDrive: (credentialSecretRef) =>
    platform.googleDrive.reauthorizeAccount(credentialSecretRef),
  disconnectGoogleDrive: (database, signal) =>
    createGoogleDriveDisconnectOrchestrator(database).disconnect(signal),
  cancelPendingGoogleDrive: (database, signal) =>
    cancelPendingGoogleDriveTransitionFromProduct(database, signal),
  triggerManual: () => productSyncRuntimeControl.triggerManual(),
  requestProvisioning: requestGoogleDriveSyncGenerationProvisioning,
  emitAuthorityChanged: () => events.emit('sync:authority-changed'),
  nowIso: () => new Date().toISOString(),
};

/** Product-facing SyncEngine commands; provider credentials remain native-owned. */
export class ProductSyncCommandService {
  constructor(private readonly dependencies: ProductSyncCommandDependencies = defaultDependencies) {}

  async connectGoogleDrive(signal: AbortSignal): Promise<ProductGoogleDriveConnectionResult> {
    const result = await this.dependencies.connectGoogleDrive(this.dependencies.database(), signal);
    const projectIds = [...new Set(result.restored.map((item) => item.projectId))];
    if (projectIds.length > 0) events.emit('sync:projects-restored', { projectIds });
    return result;
  }

  triggerManualSync(): void {
    this.dependencies.triggerManual();
  }

  retryProvisioning(): boolean {
    return this.dependencies.requestProvisioning();
  }

  disconnectGoogleDrive(signal: AbortSignal): Promise<unknown> {
    return this.dependencies.disconnectGoogleDrive(this.dependencies.database(), signal);
  }

  cancelPendingGoogleDrive(signal: AbortSignal): Promise<unknown> {
    return this.dependencies.cancelPendingGoogleDrive(this.dependencies.database(), signal);
  }

  /** Native OAuth replaces the opaque credential only after same-subject validation. */
  async reauthorizeGoogleDrive(): Promise<void> {
    const database = this.dependencies.database();
    const [current] = await database
      .select({
        mode: SyncAppAuthorityTable.mode,
        generation: SyncAppAuthorityTable.generation,
        transitionState: SyncAppAuthorityTable.transitionState,
        targetMode: SyncAppAuthorityTable.targetMode,
        attemptId: SyncAppAuthorityTable.attemptId,
        accountId: SyncProviderAccountTable.id,
        accountSubject: SyncProviderAccountTable.accountSubjectId,
        credentialSecretRef: SyncProviderAccountTable.credentialSecretRef,
      })
      .from(SyncAppAuthorityTable)
      .innerJoin(
        SyncProviderAccountTable,
        and(
          eq(SyncProviderAccountTable.providerKind, SyncAppAuthorityTable.mode),
          eq(
            SyncProviderAccountTable.authorityGeneration,
            SyncAppAuthorityTable.generation,
          ),
        ),
      )
      .limit(1);
    if (!current || current.mode !== 'google-drive') {
      throw new Error('Google Drive reauthorization requires owned cloud authority');
    }
    const blockedDisconnectAttemptId =
      current.transitionState === 'blocked' &&
      current.targetMode === 'local' &&
      current.attemptId
        ? current.attemptId
        : null;
    if (current.transitionState !== 'stable' && !blockedDisconnectAttemptId) {
      throw new Error('Google Drive reauthorization requires stable cloud authority or an owned blocked disconnect');
    }
    if (blockedDisconnectAttemptId) {
      const [attempt] = await database
        .select({
          authorityGeneration: SyncConnectAttemptTable.authorityGeneration,
          kind: SyncConnectAttemptTable.kind,
          targetMode: SyncConnectAttemptTable.targetMode,
          state: SyncConnectAttemptTable.state,
          errorCode: SyncConnectAttemptTable.errorCode,
        })
        .from(SyncConnectAttemptTable)
        .where(eq(SyncConnectAttemptTable.attemptId, blockedDisconnectAttemptId))
        .limit(1);
      if (
        attempt?.authorityGeneration !== current.generation ||
        attempt.kind !== 'disconnect' ||
        attempt.targetMode !== 'local' ||
        attempt.state !== 'blocked' ||
        attempt.errorCode !== 'needs-reauth'
      ) {
        throw new Error('Google Drive reauthorization does not own the blocked disconnect attempt');
      }
    } else {
      const [needsReauth] = await database
        .select({ syncGenerationId: SyncProviderBindingTable.syncGenerationId })
        .from(SyncProviderBindingTable)
        .where(eq(SyncProviderBindingTable.state, 'needs-reauth'))
        .limit(1);
      if (!needsReauth) {
        throw new Error('No Google Drive SyncGeneration needs reauthorization');
      }
    }

    const refreshed = await this.dependencies.reauthorizeGoogleDrive(
      current.credentialSecretRef,
    );
    if (
      refreshed.accountSubject !== current.accountSubject ||
      refreshed.credentialSecretRef !== current.credentialSecretRef
    ) {
      throw new Error('Native Google reauthorization returned another account or secret reference');
    }

    const updatedAt = this.dependencies.nowIso();
    await database.transaction(async (tx) => {
      const [authority] = await tx.select().from(SyncAppAuthorityTable).limit(1);
      const [account] = await tx
        .select()
        .from(SyncProviderAccountTable)
        .where(eq(SyncProviderAccountTable.id, current.accountId))
        .limit(1);
      const [disconnectAttempt] = blockedDisconnectAttemptId
        ? await tx
            .select()
            .from(SyncConnectAttemptTable)
            .where(eq(SyncConnectAttemptTable.attemptId, blockedDisconnectAttemptId))
            .limit(1)
        : [];
      if (
        authority?.mode !== 'google-drive' ||
        authority.generation !== current.generation ||
        account?.accountSubjectId !== current.accountSubject ||
        account.credentialSecretRef !== current.credentialSecretRef
      ) {
        throw new Error('Google Drive authority changed during reauthorization');
      }
      if (blockedDisconnectAttemptId) {
        if (
          authority.transitionState !== 'blocked' ||
          authority.targetMode !== 'local' ||
          authority.attemptId !== blockedDisconnectAttemptId ||
          disconnectAttempt?.authorityGeneration !== current.generation ||
          disconnectAttempt.kind !== 'disconnect' ||
          disconnectAttempt.targetMode !== 'local' ||
          disconnectAttempt.state !== 'blocked' ||
          disconnectAttempt.errorCode !== 'needs-reauth'
        ) {
          throw new Error('Google Drive disconnect changed during reauthorization');
        }
      } else if (authority.transitionState !== 'stable') {
        throw new Error('Google Drive authority changed during reauthorization');
      }
      await tx
        .update(SyncProviderAccountTable)
        .set({ updatedAt })
        .where(eq(SyncProviderAccountTable.id, current.accountId));
      if (!blockedDisconnectAttemptId) {
        await tx
          .update(SyncProviderBindingTable)
          .set({ state: 'ready', updatedAt })
          .where(eq(SyncProviderBindingTable.state, 'needs-reauth'));
      }
    });
    this.dependencies.emitAuthorityChanged();
  }

  /** Pause/resume is App-wide; a mixed provider/runtime state is never created. */
  async setPaused(paused: boolean): Promise<void> {
    const database = this.dependencies.database();
    const updatedAt = this.dependencies.nowIso();
    await database.transaction(async (tx) => {
      const [authority] = await tx.select().from(SyncAppAuthorityTable).limit(1);
      if (
        !authority ||
        authority.transitionState !== 'stable' ||
        authority.mode !== 'google-drive'
      ) {
        throw new Error('Google Drive pause requires stable cloud authority');
      }
      const bindings = await tx
        .select({ syncGenerationId: SyncProviderBindingTable.syncGenerationId, state: SyncProviderBindingTable.state })
        .from(SyncProviderBindingTable);
      if (bindings.length === 0) throw new Error('No Google Drive SyncGeneration is connected');
      if (bindings.some(({ state }) => state !== 'ready' && state !== 'paused')) {
        throw new Error('Provisioning or attention state must be resolved before pause changes');
      }
      const targetState = paused ? 'paused' : 'ready';
      const sourceState = paused ? 'ready' : 'paused';
      const changedSyncGenerationIds = bindings
        .filter(({ state }) => state === sourceState)
        .map(({ syncGenerationId }) => syncGenerationId);
      if (changedSyncGenerationIds.length > 0) {
        await tx
          .update(SyncProviderBindingTable)
          .set({ state: targetState, updatedAt })
          .where(inArray(SyncProviderBindingTable.syncGenerationId, changedSyncGenerationIds));
      }
    });
    this.dependencies.emitAuthorityChanged();
  }
}

export const productSyncCommands = new ProductSyncCommandService();
