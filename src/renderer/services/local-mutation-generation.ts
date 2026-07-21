/**
 * In-memory epoch per project used to reject stale server graph snapshots.
 * Bumps are synchronous and intentionally survive failed local transactions:
 * once a pull raced with a local write attempt, that response is no longer a
 * safe server-wins snapshot even if the write later rolls back.
 */
export class LocalMutationGenerationTracker {
  private readonly generations = new Map<string, number>();

  current(projectId: string): number {
    return this.generations.get(projectId) ?? 0;
  }

  bump(projectId: string): number {
    const next = this.current(projectId) + 1;
    this.generations.set(projectId, next);
    return next;
  }

  isCurrent(projectId: string, generation: number): boolean {
    return this.current(projectId) === generation;
  }
}

export const localMutationGeneration = new LocalMutationGenerationTracker();

class StaleProjectGraphError extends Error {}

interface GuardedProjectHydrationOptions<TTransaction> {
  projectId: string;
  expectedGeneration?: number;
  transaction: (work: (tx: TTransaction) => Promise<void>) => Promise<void>;
  hydrate: (tx: TTransaction) => Promise<void>;
  apply: () => void;
}

/**
 * Run a destructive graph replacement only while its captured local-mutation
 * generation remains current. A stale generation thrown from inside the
 * transaction intentionally rolls back the replacement; unrelated errors
 * still propagate to the caller.
 */
export async function runGuardedProjectHydration<TTransaction>({
  projectId,
  expectedGeneration,
  transaction,
  hydrate,
  apply,
}: GuardedProjectHydrationOptions<TTransaction>): Promise<boolean> {
  const generationIsCurrent = () =>
    expectedGeneration === undefined ||
    localMutationGeneration.isCurrent(projectId, expectedGeneration);

  // Reject a response that was already stale before waiting for SQLite.
  if (!generationIsCurrent()) return false;

  try {
    await transaction(async (tx) => {
      // A local writer may have started while this transaction was queued.
      if (!generationIsCurrent()) throw new StaleProjectGraphError();
      await hydrate(tx);
      // Roll back if a writer started while replacement statements yielded.
      if (!generationIsCurrent()) throw new StaleProjectGraphError();
    });
  } catch (error) {
    if (error instanceof StaleProjectGraphError) return false;
    throw error;
  }

  // Commit and store projection are separate steps. Never project stale server
  // objects over a local optimistic update that began at that boundary.
  if (!generationIsCurrent()) return false;
  apply();
  return true;
}
