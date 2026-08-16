import { useSyncExternalStore } from 'react';

import {
  productSyncAuthorityStore,
  type ProductSyncAuthoritySnapshot,
} from './product-authority-store';

export function useProductSyncAuthority(): ProductSyncAuthoritySnapshot {
  return useSyncExternalStore(
    (listener) => productSyncAuthorityStore.subscribe(listener),
    () => productSyncAuthorityStore.getSnapshot(),
    () => productSyncAuthorityStore.getSnapshot(),
  );
}
