// Lightweight registry, as for Markdown projections: the quit barrier must
// not load Yjs or the database layer when no handoff runtime is installed.
const flushers = new Set<() => Promise<void>>();

export function registerV2HandoffFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Best effort: a failed handoff never holds up quitting. */
export async function flushV2Handoff(): Promise<void> {
  for (const flush of [...flushers]) {
    try {
      await flush();
    } catch (error) {
      console.warn('[v2-handoff] Quit pass failed; the next launch catches up', error);
    }
  }
}
