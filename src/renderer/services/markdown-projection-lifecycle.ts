// Lightweight registry: saving a manuscript must not initialize the exporter,
// database readers or sync journal when no projection worker is mounted.
const flushers = new Set<() => Promise<void>>();

export function registerMarkdownProjectionFlush(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushMarkdownProjections(): Promise<void> {
  for (const flush of [...flushers]) {
    try { await flush(); }
    catch (error) { console.warn('[markdown-projection] Derived output flush failed', error); }
  }
}
