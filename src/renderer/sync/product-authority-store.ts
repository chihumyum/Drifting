import { eq } from 'drizzle-orm';

import { getDb, getDbIfInitialized, type DbClient } from '../lib/db';
import { events } from '../lib/events';
import {
  SyncAppAuthorityTable,
  SyncConnectAttemptTable,
  SyncProviderBindingTable,
  SyncGenerationTable,
} from '../schema/drizzle';
import { onAuthoredChangeCommitted } from './journal';
import type { SyncProviderMode } from './app-authority';

export type ProductSyncAuthorityStatus =
  | 'loading'
  | 'local'
  | 'transitioning'
  | 'cloud-ready'
  | 'cloud-provisioning'
  | 'cloud-paused'
  | 'cloud-attention'
  | 'unavailable';

export interface ProductSyncAuthoritySnapshot {
  readonly loaded: boolean;
  readonly status: ProductSyncAuthorityStatus;
  readonly mode: SyncProviderMode;
  readonly targetMode: SyncProviderMode | null;
  readonly transitionKind: 'connect' | 'switch-provider' | 'disconnect' | 'restore' | null;
  readonly generation: number;
  readonly activeSyncGenerations: number;
  readonly readySyncGenerations: number;
  readonly provisioningSyncGenerations: number;
  readonly pausedSyncGenerations: number;
  readonly attentionSyncGenerations: number;
  readonly errorCode: string | null;
}

type Listener = () => void;

const INITIAL: ProductSyncAuthoritySnapshot = Object.freeze({
  loaded: false,
  status: 'loading',
  mode: 'local',
  targetMode: null,
  transitionKind: null,
  generation: 1,
  activeSyncGenerations: 0,
  readySyncGenerations: 0,
  provisioningSyncGenerations: 0,
  pausedSyncGenerations: 0,
  attentionSyncGenerations: 0,
  errorCode: null,
});

const PROVISIONING_STATES = new Set([
  'connecting',
  'discovering',
  'publishing-genesis',
  'restoring',
]);
const ATTENTION_STATES = new Set(['needs-reauth', 'blocked-update', 'blocked-corrupt']);

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code).slice(0, 128);
  }
  return 'SYNC_AUTHORITY_UNAVAILABLE';
}

function deriveStatus(input: {
  mode: SyncProviderMode;
  transitionState: string;
  provisioningSyncGenerations: number;
  pausedSyncGenerations: number;
  attentionSyncGenerations: number;
}): ProductSyncAuthorityStatus {
  if (input.transitionState === 'blocked') return 'cloud-attention';
  if (input.transitionState !== 'stable') return 'transitioning';
  if (input.mode === 'local') return 'local';
  if (input.attentionSyncGenerations > 0) return 'cloud-attention';
  if (input.provisioningSyncGenerations > 0) return 'cloud-provisioning';
  if (input.pausedSyncGenerations > 0) return 'cloud-paused';
  return 'cloud-ready';
}

/** DB-backed, secret-free App provider authority view for product UI. */
export class ProductSyncAuthorityStore {
  private readonly listeners = new Set<Listener>();
  private snapshot: ProductSyncAuthoritySnapshot = INITIAL;
  private tail: Promise<void> = Promise.resolve();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ProductSyncAuthoritySnapshot {
    return this.snapshot;
  }

  refresh(database: DbClient = getDb()): Promise<void> {
    this.tail = this.tail.catch(() => undefined).then(async () => {
      try {
        const next = await database.transaction(async (tx) => {
          const [authority] = await tx.select().from(SyncAppAuthorityTable).limit(1);
          if (!authority) throw new Error('Sync App authority is missing');
          const [attempt] = authority.attemptId
            ? await tx
                .select({
                  kind: SyncConnectAttemptTable.kind,
                  state: SyncConnectAttemptTable.state,
                  errorCode: SyncConnectAttemptTable.errorCode,
                })
                .from(SyncConnectAttemptTable)
                .where(eq(SyncConnectAttemptTable.attemptId, authority.attemptId))
                .limit(1)
            : [];
          const activeSyncGenerations = await tx
            .select({ syncGenerationId: SyncGenerationTable.syncGenerationId })
            .from(SyncGenerationTable)
            .where(eq(SyncGenerationTable.status, 'active'));
          const bindings = await tx
            .select({ syncGenerationId: SyncProviderBindingTable.syncGenerationId, state: SyncProviderBindingTable.state })
            .from(SyncProviderBindingTable);
          const activeIds = new Set(activeSyncGenerations.map(({ syncGenerationId }) => syncGenerationId));
          const activeBindings = bindings.filter(({ syncGenerationId }) => activeIds.has(syncGenerationId));
          const readySyncGenerations = activeBindings.filter(({ state }) => state === 'ready').length;
          const provisioningSyncGenerations = activeBindings.filter(({ state }) =>
            PROVISIONING_STATES.has(state),
          ).length;
          const pausedSyncGenerations = activeBindings.filter(({ state }) => state === 'paused').length;
          const attentionSyncGenerations = activeBindings.filter(({ state }) =>
            ATTENTION_STATES.has(state),
          ).length;
          const mode = authority.mode as SyncProviderMode;
          return Object.freeze({
            loaded: true,
            status: deriveStatus({
              mode,
              transitionState: authority.transitionState,
              provisioningSyncGenerations,
              pausedSyncGenerations,
              attentionSyncGenerations,
            }),
            mode,
            targetMode: authority.targetMode as SyncProviderMode | null,
            transitionKind:
              (attempt?.kind as ProductSyncAuthoritySnapshot['transitionKind']) ?? null,
            generation: authority.generation,
            activeSyncGenerations: activeSyncGenerations.length,
            readySyncGenerations,
            provisioningSyncGenerations,
            pausedSyncGenerations,
            attentionSyncGenerations,
            errorCode:
              attempt?.errorCode ??
              activeBindings.find(({ state }) => ATTENTION_STATES.has(state))?.state ??
              null,
          }) satisfies ProductSyncAuthoritySnapshot;
        });
        this.snapshot = next;
      } catch (error) {
        this.snapshot = Object.freeze({
          ...this.snapshot,
          loaded: false,
          status: 'unavailable',
          errorCode: safeErrorCode(error),
        });
      }
      this.emit();
    });
    return this.tail;
  }

  reset(): void {
    this.snapshot = INITIAL;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const productSyncAuthorityStore = new ProductSyncAuthorityStore();

/** Install at App scope; callbacks perform only short local SQLite reads. */
export function installProductSyncAuthorityMonitor(
  store: ProductSyncAuthorityStore = productSyncAuthorityStore,
): () => void {
  let databaseReady = getDbIfInitialized() !== null;
  const refresh = () => {
    if (!databaseReady) return;
    const database = getDbIfInitialized();
    if (!database) {
      databaseReady = false;
      return;
    }
    void store.refresh(database).catch(() => undefined);
  };
  const onDatabaseReady = () => {
    databaseReady = true;
    refresh();
  };
  const reset = () => {
    databaseReady = false;
    store.reset();
  };
  events.on('db:ready', onDatabaseReady);
  events.on('sync:authority-changed', refresh);
  events.on('sync:runtime-state-changed', refresh);
  events.on('db:error', reset);
  const unsubscribeAuthored = onAuthoredChangeCommitted(refresh);
  refresh();
  return () => {
    unsubscribeAuthored();
    events.off('db:ready', onDatabaseReady);
    events.off('sync:authority-changed', refresh);
    events.off('sync:runtime-state-changed', refresh);
    events.off('db:error', reset);
  };
}
