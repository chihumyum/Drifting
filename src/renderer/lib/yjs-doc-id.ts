// Canonical docId format for Yjs sync. One synced document per (kind, id).
//
//   chapter / drift     → `node-content:<nodeId>`   (both share the body field
//                          on the underlying BookNode.NodeContent row)
//   element             → `element:<elementId>`
//   storyline           → `storyline:<storylineId>` (body = descriptionJson)
//   element category    → `category:<categoryId>`   (body = descriptionJson)
//
// The legacy hardcoded prefix `node-content:` was the only one supported
// before this file existed. The format is preserved so existing rows in the
// yjs_updates / sync_updates tables keep matching.

export type DocKind = 'node-content' | 'element' | 'storyline' | 'category';

const KIND_PREFIXES: Record<DocKind, string> = {
  'node-content': 'node-content:',
  element: 'element:',
  storyline: 'storyline:',
  category: 'category:',
};

export function makeDocId(kind: DocKind, entityId: string): string {
  return `${KIND_PREFIXES[kind]}${entityId}`;
}

export function parseDocId(docId: string): { kind: DocKind; entityId: string } | null {
  for (const kind of Object.keys(KIND_PREFIXES) as DocKind[]) {
    const prefix = KIND_PREFIXES[kind];
    if (docId.startsWith(prefix)) {
      return { kind, entityId: docId.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Maps a docKind to the EntityType used by the entity-sync mutation log.
 * The two namespaces overlap but are not identical: Yjs talks about
 * 'node-content' (the body row), while the mutation log uses 'nodeContent'.
 */
export function entityTypeForDocKind(
  kind: DocKind,
): 'nodeContent' | 'element' | 'storyline' | 'elementCategory' {
  switch (kind) {
    case 'node-content':
      return 'nodeContent';
    case 'element':
      return 'element';
    case 'storyline':
      return 'storyline';
    case 'category':
      return 'elementCategory';
  }
}
