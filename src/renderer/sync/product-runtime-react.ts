import { useSyncExternalStore } from 'react';

import {
  productSyncRuntimeControl,
  type ProductSyncRuntimeSnapshot,
} from './product-runtime-control';

export function useProductSyncRuntime(): ProductSyncRuntimeSnapshot {
  return useSyncExternalStore(
    (listener) => productSyncRuntimeControl.subscribe(listener),
    () => productSyncRuntimeControl.getSnapshot(),
    () => productSyncRuntimeControl.getSnapshot(),
  );
}
