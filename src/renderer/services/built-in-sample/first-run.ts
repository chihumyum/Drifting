// The startup half of the built-in sample project (docs/sample-project.md):
// a small store the shelf observes and the single in-flight creation. The
// recipe and its writers load on demand from ./built-in-sample.

import loglevel from 'loglevel';
import { create } from 'zustand';

const log = loglevel.getLogger('BuiltInSample');

export type BuiltInSamplePhase = 'idle' | 'checking' | 'creating' | 'settled';

interface BuiltInSampleState {
  phase: BuiltInSamplePhase;
  /**
   * Sample projects that are not complete yet (being written, or left behind
   * by an interrupted attempt). Shelves hide them until all are published.
   */
  pendingProjectIds: readonly string[];
  /** The samples this launch created, once complete. */
  createdProjectIds: readonly string[];
}

export const useBuiltInSampleStore = create<BuiltInSampleState>(() => ({
  phase: 'idle',
  pendingProjectIds: [],
  createdProjectIds: [],
}));

let running: Promise<void> | null = null;

/**
 * Called once the local library is open, before any Hosted connect. Never
 * rejects and never blocks startup: a failure is logged and the shelf stays
 * as it is. Repeated calls share the same run.
 */
export function startBuiltInSampleProject(): Promise<void> {
  running ??= (async () => {
    try {
      // An account library starts from its cloud copy; a sample there would
      // be published into the account (services/account-library.ts).
      const { isAccountLibrary } = await import('../account-library');
      if (isAccountLibrary()) return;
      const { ensureBuiltInSampleProject } = await import('./built-in-sample');
      const outcome = await ensureBuiltInSampleProject();
      if (outcome.kind === 'failed') log.warn('[sample] The built-in sample project was not created', outcome.error);
    } catch (error) {
      log.warn('[sample] The built-in sample project check failed', error);
    } finally {
      useBuiltInSampleStore.setState((state) => ({ ...state, phase: 'settled' }));
    }
  })();
  return running;
}

/**
 * Resolves when no sample creation is in flight. Hosted connect waits on it so
 * a half-written sample is never published.
 */
export function waitForBuiltInSampleProject(): Promise<void> {
  return running ?? Promise.resolve();
}

/** Projects a shelf should list: never an unfinished sample. */
export function withoutPendingSampleProject<T extends { id: string }>(projects: readonly T[]): T[] {
  const pending = useBuiltInSampleStore.getState().pendingProjectIds;
  return pending.length ? projects.filter((project) => !pending.includes(project.id)) : [...projects];
}

/** Test seam: forget the in-flight run and the observed phase. */
export function resetBuiltInSampleForTests(): void {
  running = null;
  useBuiltInSampleStore.setState({ phase: 'idle', pendingProjectIds: [], createdProjectIds: [] });
}
