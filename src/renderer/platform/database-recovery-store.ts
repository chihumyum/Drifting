import { useSyncExternalStore } from 'react';
import type { DatabaseOpenFailure } from './database';

let failure: DatabaseOpenFailure | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function publishDatabaseOpenFailure(next: DatabaseOpenFailure): void {
  failure = next;
  emit();
}

export function clearDatabaseOpenFailure(): void {
  if (failure === null) return;
  failure = null;
  emit();
}

export function getDatabaseOpenFailure(): DatabaseOpenFailure | null {
  return failure;
}

export function useDatabaseOpenFailure(): DatabaseOpenFailure | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getDatabaseOpenFailure,
    getDatabaseOpenFailure,
  );
}
