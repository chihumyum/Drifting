import { proseDocId, type ProseEntityType } from '../../lib/yjs-doc-id';
import { hydrateProseJson } from '../../lib/agent/prose-hydrate-client';
import type { LocalRelationalMarkdownSource } from './relational-markdown.local-source';

export async function readLocalProseJson(
  entityType: ProseEntityType,
  entityId: string,
  fallbackContentJson: string,
  source: LocalRelationalMarkdownSource,
  hydrate = hydrateProseJson,
): Promise<string> {
  const docId = proseDocId(entityType, entityId);
  const state = source.proseByDocId.get(docId);
  if (!state || (!state.snapshot && state.updates.length === 0)) {
    // A document that has never been opened has no Yjs state yet. Its
    // contentJson projection is still the editor's canonical seed.
    return fallbackContentJson || '{}';
  }
  // Once any Yjs state exists, it is authoritative even when it represents an
  // intentionally empty document. Corruption rejects the export instead of
  // silently falling back to a stale contentJson projection.
  return hydrate(state.snapshot, state.updates);
}
