import { useShallow } from 'zustand/react/shallow';
import { useDataStore } from './data-store';

type DataSnapshot = ReturnType<typeof useDataStore.getState>;

/** Select existing fields from one atomic snapshot, with stable shallow identity. */
export function useDataStoreFields<Key extends keyof DataSnapshot>(...keys: Key[]): Pick<DataSnapshot, Key> {
  return useDataStore(useShallow((state) => {
    const selected = {} as Pick<DataSnapshot, Key>;
    for (const key of keys) selected[key] = state[key];
    return selected;
  }));
}
