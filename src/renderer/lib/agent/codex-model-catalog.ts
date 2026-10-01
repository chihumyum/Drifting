import { isTauriRuntime, platform } from '../../platform';
import type { CodexModel, CodexSubscriptionStatus } from '../../platform';
import { canUseByokProvider } from '../config';
import { setCodexModelCatalog } from './runtime/agent-provider-contract';

type CatalogState = 'idle' | 'loading' | 'ready' | 'error' | 'signed-out';
interface CatalogSnapshot { state: CatalogState; updatedAt: number | null }
interface CatalogSource {
  status(): Promise<CodexSubscriptionStatus>;
  listModels(): Promise<CodexModel[]>;
}

/** Account-scoped, memory-only cache. Stale requests cannot republish after logout. */
export function createCodexModelCatalog(
  source: CatalogSource,
  publish: (models: readonly CodexModel[] | null) => void,
  available: () => boolean,
  now = Date.now,
) {
  let snapshot: CatalogSnapshot = { state: 'idle', updatedAt: null };
  let generation = 0;
  let account: string | null = null;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: CatalogSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const invalidate = () => {
    generation++;
    pending = null;
    account = null;
    publish(null);
    update({ state: 'idle', updatedAt: null });
  };
  const refresh = (force = false): Promise<void> => {
    if (!available()) return Promise.resolve();
    if (pending) return pending;
    if (!force && snapshot.updatedAt !== null && now() - snapshot.updatedAt < 5 * 60_000) {
      return Promise.resolve();
    }
    const revision = generation;
    update({ ...snapshot, state: 'loading' });
    const current = () => revision === generation;
    const request = Promise.resolve().then(async () => {
      try {
        const status = await source.status();
        if (!current()) return;
        if (!status.signedIn) {
          account = null;
          publish(null);
          update({ state: 'signed-out', updatedAt: null });
          return;
        }
        const identity = JSON.stringify([status.account?.accountId, status.account?.email,
          status.login?.phase === 'authenticated' ? status.login.attemptId : null]);
        if (identity !== account) {
          account = identity;
          publish(null);
          update({ state: 'loading', updatedAt: null });
        }
        const models = await source.listModels();
        if (!current()) return;
        if (!models.length) throw new Error('empty catalog');
        publish(models);
        update({ state: 'ready', updatedAt: now() });
      } catch {
        // Preserve this account's last successful catalog. Never expose provider text.
        if (current()) update({ ...snapshot, state: 'error' });
      } finally {
        if (current()) pending = null;
      }
    });
    pending = request;
    return request;
  };
  return {
    refresh,
    invalidate,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const codexModelCatalog = createCodexModelCatalog(
  platform.codexSubscription,
  setCodexModelCatalog,
  () => isTauriRuntime() && canUseByokProvider(),
);
