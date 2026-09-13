interface Scope { projectId?: string; conversationId?: string }
interface ReadLease { projectId: string; conversationId: string; valid: boolean }
const overlaps = (scope: Scope, projectId: string, conversationId: string | null) =>
  scope.projectId === projectId || (conversationId !== null && scope.conversationId === conversationId);

/** App-owned deletion lifetimes. New sends wait for overlapping committed
 * cleanup; reads already in flight are invalidated without a permanent ID cache. */
export function createAgentConversationRemovalOwner() {
  const pending = new Map<Scope, Promise<void>>();
  const reads = new Set<ReadLease>();
  let disposed = false;
  let releaseDispose!: () => void;
  const disposal = new Promise<void>(resolve => { releaseDispose = resolve; });
  return {
    begin(scope: Scope) {
      if (disposed) return null;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      pending.set(scope, done);
      for (const read of reads) if (overlaps(scope, read.projectId, read.conversationId)) { read.valid = false; reads.delete(read); }
      return () => { pending.delete(scope); finish(); };
    },
    hasPending: (projectId: string, conversationId: string | null) => [...pending.keys()].some(scope => overlaps(scope, projectId, conversationId)),
    async wait(projectId: string, conversationId: string | null): Promise<boolean> {
      while (!disposed) {
        const waiting = [...pending].filter(([scope]) => overlaps(scope, projectId, conversationId)).map(([, done]) => done);
        if (waiting.length === 0) return true;
        await Promise.race([Promise.all(waiting), disposal]);
      }
      return false;
    },
    read(projectId: string, conversationId: string) {
      const lease: ReadLease = { projectId, conversationId, valid: !disposed && ![...pending.keys()].some(scope => overlaps(scope, projectId, conversationId)) };
      if (lease.valid) reads.add(lease);
      return { isCurrent: () => lease.valid && !disposed, finish: () => { lease.valid = false; reads.delete(lease); } };
    },
    dispose() { disposed = true; releaseDispose(); pending.clear(); for (const read of reads) read.valid = false; reads.clear(); },
  };
}
