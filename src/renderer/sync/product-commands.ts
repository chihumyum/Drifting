import { inArray } from 'drizzle-orm';

import { getDb, type DbClient } from '../lib/db';
import { events } from '../lib/events';
import {
  SyncAppAuthorityTable,
  SyncProviderBindingTable,
} from '../schema/drizzle';
import { productSyncRuntimeControl } from './product-runtime-control';

export interface ProductSyncCommandDependencies {
  readonly database: () => DbClient;
  readonly triggerManual: () => void;
  readonly requestProvisioning: () => boolean;
  readonly emitAuthorityChanged: () => void;
  readonly nowIso: () => string;
}

const defaultDependencies: ProductSyncCommandDependencies = {
  database: getDb,
  triggerManual: () => productSyncRuntimeControl.triggerManual(),
  requestProvisioning: () => false,
  emitAuthorityChanged: () => events.emit('sync:authority-changed'),
  nowIso: () => new Date().toISOString(),
};

/** Product-facing SyncEngine commands; provider credentials remain native-owned. */
export class ProductSyncCommandService {
  constructor(private readonly dependencies: ProductSyncCommandDependencies = defaultDependencies) {}

  triggerManualSync(): void {
    this.dependencies.triggerManual();
  }

  retryProvisioning(): boolean {
    return this.dependencies.requestProvisioning();
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
        authority.mode !== 'hosted'
      ) {
        throw new Error('Pause requires stable cloud authority');
      }
      const bindings = await tx
        .select({ syncGenerationId: SyncProviderBindingTable.syncGenerationId, state: SyncProviderBindingTable.state })
        .from(SyncProviderBindingTable);
      if (bindings.length === 0) throw new Error('No cloud SyncGeneration is connected');
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
