import { describe, expect, it } from 'vitest';
import {
  localMutationGeneration,
  LocalMutationGenerationTracker,
  runGuardedProjectHydration,
} from './local-mutation-generation';

describe('LocalMutationGenerationTracker', () => {
  it('isolates generations by project and invalidates an older capture synchronously', () => {
    const tracker = new LocalMutationGenerationTracker();
    const projectACapture = tracker.current('project-a');
    const projectBCapture = tracker.current('project-b');

    tracker.bump('project-a');

    expect(tracker.isCurrent('project-a', projectACapture)).toBe(false);
    expect(tracker.isCurrent('project-b', projectBCapture)).toBe(true);
  });

  it('invalidates every earlier capture across consecutive local writes', () => {
    const tracker = new LocalMutationGenerationTracker();
    const first = tracker.current('project-a');
    const second = tracker.bump('project-a');
    const third = tracker.bump('project-a');

    expect({ first, second, third }).toEqual({ first: 0, second: 1, third: 2 });
    expect(tracker.isCurrent('project-a', first)).toBe(false);
    expect(tracker.isCurrent('project-a', second)).toBe(false);
    expect(tracker.isCurrent('project-a', third)).toBe(true);
  });
});

describe('runGuardedProjectHydration', () => {
  const projectId = 'guarded-project';

  async function run(options?: {
    bumpBeforeTransactionCallback?: boolean;
    bumpDuringHydrate?: boolean;
    bumpAfterTransaction?: boolean;
  }) {
    const expectedGeneration = localMutationGeneration.current(projectId);
    const events: string[] = [];
    let rolledBack = false;

    const hydrated = await runGuardedProjectHydration({
      projectId,
      expectedGeneration,
      transaction: async (work) => {
        events.push('transaction:start');
        if (options?.bumpBeforeTransactionCallback) localMutationGeneration.bump(projectId);
        try {
          await work({ id: 'tx' });
          events.push('transaction:commit');
        } catch (error) {
          rolledBack = true;
          events.push('transaction:rollback');
          throw error;
        }
        if (options?.bumpAfterTransaction) localMutationGeneration.bump(projectId);
      },
      hydrate: async () => {
        events.push('hydrate');
        if (options?.bumpDuringHydrate) localMutationGeneration.bump(projectId);
      },
      apply: () => events.push('store:apply'),
    });

    return { events, hydrated, rolledBack };
  }

  it('hydrates and applies only while the captured generation stays current', async () => {
    await expect(run()).resolves.toEqual({
      events: ['transaction:start', 'hydrate', 'transaction:commit', 'store:apply'],
      hydrated: true,
      rolledBack: false,
    });
  });

  it('rolls back when a local write starts while the transaction is queued', async () => {
    await expect(run({ bumpBeforeTransactionCallback: true })).resolves.toEqual({
      events: ['transaction:start', 'transaction:rollback'],
      hydrated: false,
      rolledBack: true,
    });
  });

  it('rolls back when a local write starts during destructive hydration', async () => {
    await expect(run({ bumpDuringHydrate: true })).resolves.toEqual({
      events: ['transaction:start', 'hydrate', 'transaction:rollback'],
      hydrated: false,
      rolledBack: true,
    });
  });

  it('skips store projection when a local write starts after the transaction commits', async () => {
    await expect(run({ bumpAfterTransaction: true })).resolves.toEqual({
      events: ['transaction:start', 'hydrate', 'transaction:commit'],
      hydrated: false,
      rolledBack: false,
    });
  });

  it('rejects a graph that was stale before opening a transaction', async () => {
    const expectedGeneration = localMutationGeneration.current(projectId);
    localMutationGeneration.bump(projectId);
    let transactionStarted = false;

    const hydrated = await runGuardedProjectHydration({
      projectId,
      expectedGeneration,
      transaction: async () => {
        transactionStarted = true;
      },
      hydrate: async () => undefined,
      apply: () => undefined,
    });

    expect(hydrated).toBe(false);
    expect(transactionStarted).toBe(false);
  });
});
