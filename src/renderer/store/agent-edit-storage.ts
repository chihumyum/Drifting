import type { PersistStorage } from 'zustand/middleware';

// UTF-16 code units, including the Zustand envelope: at most ~1 MiB of text.
// Before/after prose is duplicated in the visual aggregate and review batches;
// it must not grow to consume the WebView's shared localStorage quota.
export const AGENT_EDIT_CACHE_MAX_CHARS = 512 * 1024;

type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Best-effort presentation cache. SQLite/Yjs remain the durable authority. */
export function createAgentEditStorage<T>(
  getStorage: () => CacheStorage = () => localStorage,
): PersistStorage<T> {
  const removeItem = (name: string): void => {
    try {
      getStorage().removeItem(name);
    } catch {
      // Storage itself can be unavailable (including access to localStorage).
    }
  };

  return {
    getItem: (name) => {
      try {
        const raw = getStorage().getItem(name);
        if (raw === null) return null;
        if (raw.length <= AGENT_EDIT_CACHE_MAX_CHARS) return JSON.parse(raw);
      } catch {
        // A corrupt cache must not prevent editor startup either.
      }
      removeItem(name);
      return null;
    },
    setItem: (name, value) => {
      try {
        const raw = JSON.stringify(value);
        if (raw.length <= AGENT_EDIT_CACHE_MAX_CHARS) {
          getStorage().setItem(name, raw);
          return;
        }
      } catch {
        // Zustand updates memory before persisting. Keep the complete live
        // projection even when another key has exhausted the shared quota.
      }
      // Do not leave an older snapshot that could resurrect acknowledged
      // changes on reload. Evict only this rebuildable cache, never other keys.
      removeItem(name);
    },
    removeItem,
  };
}
