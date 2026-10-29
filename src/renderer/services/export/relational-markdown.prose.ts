import { proseDocId, type ProseEntityType } from '../../lib/yjs-doc-id';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

/**
 * Prose a long-lived projection renderer has hydrated, each valid for one
 * persisted Yjs version. An incremental capture omits the bytes of documents
 * whose version this cache already holds.
 */
export class ProseJsonCache {
  private readonly entries = new Map<string, { version: string; json: string }>();

  versions(): Map<string, string> {
    return new Map([...this.entries].map(([docId, { version }]) => [docId, version]));
  }

  get(docId: string, version: string): string | undefined {
    const entry = this.entries.get(docId);
    return entry?.version === version ? entry.json : undefined;
  }

  set(docId: string, version: string, json: string): void {
    this.entries.set(docId, { version, json });
  }

  /** Forget documents the latest capture no longer has a version for. */
  retain(docIds: ReadonlySet<string>): void {
    for (const docId of this.entries.keys()) if (!docIds.has(docId)) this.entries.delete(docId);
  }

  clear(): void {
    this.entries.clear();
  }
}

export async function readLocalProseJson(
  entityType: ProseEntityType,
  entityId: string,
  fallbackContentJson: string,
  source: LocalRelationalMarkdownSource,
  hydrate = hydrateProseJson,
  cache?: ProseJsonCache,
): Promise<string> {
  const docId = proseDocId(entityType, entityId);
  const state = source.proseByDocId.get(docId);
  const version = source.proseVersions?.get(docId);
  if (version !== undefined && !state) {
    // Unchanged since the renderer hydrated it. A missing entry means the
    // capture and the cache disagree; never substitute other prose for it.
    const cached = cache?.get(docId, version);
    if (cached === undefined) throw new Error(`Projection prose for ${docId} was not captured`);
    return cached;
  }
  if (!state || (!state.snapshot && state.updates.length === 0)) {
    // A document that has never been opened has no Yjs state yet. Its
    // contentJson projection is still the editor's canonical seed.
    return fallbackContentJson || '{}';
  }
  // Once any Yjs state exists, it is authoritative even when it represents an
  // intentionally empty document. Corruption rejects the export instead of
  // silently falling back to a stale contentJson projection.
  const json = await hydrate(state.snapshot, state.updates);
  if (version !== undefined) cache?.set(docId, version, json);
  return json;
}
