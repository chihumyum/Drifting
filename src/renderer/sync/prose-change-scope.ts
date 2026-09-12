import { parseDocId } from '../lib/yjs-doc-id';

/** Renderer notification hints only, never a wire contract or recovery cursor.
 * Unknown/mixed/oversized scopes use the authoritative full repair path. */
export const MAX_PROSE_CHANGE_DOCS = 128;

export function boundedProseDocIds(docIds: readonly string[]): readonly string[] | undefined {
  if (docIds.length === 0) return undefined;
  const unique = new Set<string>();
  for (const docId of docIds) {
    const parsed = parseDocId(docId);
    if (!parsed?.entityId) return undefined;
    unique.add(docId);
    if (unique.size > MAX_PROSE_CHANGE_DOCS) return undefined;
  }
  return Object.freeze([...unique]);
}

export function committedProseDocIds(mutations: readonly {
  action: string;
  target: { family: string; kind: string; id: string };
}[]): readonly string[] | undefined {
  if (!mutations.every((mutation) => mutation.action === 'yjs.update'
    && mutation.target.family === 'yjs' && mutation.target.kind === 'prose-document')) return undefined;
  return boundedProseDocIds(mutations.map((mutation) => mutation.target.id));
}
