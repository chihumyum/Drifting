import { eq } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import {
  SyncConnectAttemptTable,
  SyncConnectGenerationAttemptTable,
  SyncProviderAccountTable,
  SyncProviderBindingTable,
} from '../../schema/drizzle';
import {
  createSyncAppAuthorityRepository,
  type SyncProviderTransitionAttempt,
} from '../app-authority-repository';
import type { CloudSyncProviderMode } from '../app-authority';

export interface CloudDisconnectDependencies {
  readonly db: DbClient;
  readonly providerMode: CloudSyncProviderMode;
  readonly flushLocalDurability: () => Promise<void>;
  readonly waitForConvergence: (signal: AbortSignal) => Promise<void>;
  /** Native-owned credential revoke + secure-storage deletion. */
  readonly revokeCredential: (credentialSecretRef: string, signal: AbortSignal) => Promise<void>;
  readonly emitAuthorityChanged: () => void;
  readonly nowIso: () => string;
}

export interface CloudDisconnectResult {
  readonly status: 'disconnected' | 'already-local';
  readonly attemptId: string | null;
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'CANCELLED';
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code).slice(0, 128);
  }
  return 'DISCONNECT_FAILED';
}

async function readOwnedDisconnectAttempt(
  dependencies: CloudDisconnectDependencies,
  attemptId: string,
): Promise<SyncProviderTransitionAttempt> {
  const [row] = await dependencies.db
    .select()
    .from(SyncConnectAttemptTable)
    .where(eq(SyncConnectAttemptTable.attemptId, attemptId))
    .limit(1);
  if (!row || row.kind !== 'disconnect' || row.targetMode !== 'local') {
    throw new Error('The durable provider transition is not a disconnect attempt');
  }
  const children = await dependencies.db
    .select()
    .from(SyncConnectGenerationAttemptTable)
    .where(eq(SyncConnectGenerationAttemptTable.attemptId, attemptId));
  return {
    attemptId,
    kind: 'disconnect',
    sourceMode: dependencies.providerMode,
    targetMode: 'local',
    authorityGeneration: row.authorityGeneration,
    generations: children.map((child) => ({
      sourceSyncGenerationId: child.sourceSyncGenerationId,
      targetSyncGenerationId: null,
    })),
  };
}

/** Restart-safe App-wide cloud -> local transition. Complete local project data survives. */
export class CloudDisconnectOrchestrator {
  private inFlight: Promise<CloudDisconnectResult> | null = null;

  constructor(private readonly dependencies: CloudDisconnectDependencies) {}

  disconnect(signal: AbortSignal = new AbortController().signal): Promise<CloudDisconnectResult> {
    if (this.inFlight) return this.inFlight;
    const operation = this.run(signal).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async run(signal: AbortSignal): Promise<CloudDisconnectResult> {
    const repository = createSyncAppAuthorityRepository(this.dependencies.db);
    let authority = await repository.read();
    if (authority.transitionState === 'stable' && authority.mode === 'local') {
      return { status: 'already-local', attemptId: null };
    }

    let attempt: SyncProviderTransitionAttempt;
    if (authority.transitionState === 'stable') {
      if (authority.mode !== this.dependencies.providerMode) {
        throw new Error('The connected provider does not match this disconnect operation');
      }
      await this.dependencies.flushLocalDurability();
      const [readyBinding] = await this.dependencies.db
        .select({ syncGenerationId: SyncProviderBindingTable.syncGenerationId })
        .from(SyncProviderBindingTable)
        .where(eq(SyncProviderBindingTable.state, 'ready'))
        .limit(1);
      // Ready SyncGenerations get a final clean frontier. A provider-stalled SyncGeneration has
      // no active runtime to wait on; disconnect still preserves its complete
      // local replica and may intentionally leave remote state stale.
      if (readyBinding) await this.dependencies.waitForConvergence(signal);
      if (signal.aborted) throw signal.reason;
      attempt = await repository.begin({
        targetMode: 'local',
        nowIso: this.dependencies.nowIso(),
      });
      this.dependencies.emitAuthorityChanged();
    } else {
      if (authority.targetMode !== 'local') {
        throw new Error('Another App-wide provider transition owns sync authority');
      }
      attempt = await readOwnedDisconnectAttempt(this.dependencies, authority.attemptId);
      if (authority.transitionState === 'blocked') {
        await repository.resume({
          attemptId: attempt.attemptId,
          nowIso: this.dependencies.nowIso(),
        });
        authority = await repository.read();
        this.dependencies.emitAuthorityChanged();
      }
    }

    try {
      const [account] = await this.dependencies.db
        .select({ credentialSecretRef: SyncProviderAccountTable.credentialSecretRef })
        .from(SyncProviderAccountTable)
        .limit(1);
      if (!account?.credentialSecretRef) {
        throw new Error('Connected provider credential reference is unavailable');
      }
      await this.dependencies.revokeCredential(account.credentialSecretRef, signal);
      for (const generation of attempt.generations) {
        await repository.markSyncGenerationCommitted({
          attemptId: attempt.attemptId,
          sourceSyncGenerationId: generation.sourceSyncGenerationId,
          nowIso: this.dependencies.nowIso(),
        });
      }
      await repository.complete({
        attemptId: attempt.attemptId,
        nowIso: this.dependencies.nowIso(),
      });
      this.dependencies.emitAuthorityChanged();
      return { status: 'disconnected', attemptId: attempt.attemptId };
    } catch (error) {
      const current = await repository.read().catch(() => null);
      if (current?.transitionState !== 'stable' && current?.attemptId === attempt.attemptId) {
        await repository
          .block({
            attemptId: attempt.attemptId,
            errorCode: errorCode(error),
            nowIso: this.dependencies.nowIso(),
          })
          .catch(() => undefined);
        this.dependencies.emitAuthorityChanged();
      }
      throw error;
    }
  }
}
