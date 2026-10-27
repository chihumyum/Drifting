// Canonical docId format for one prose document per (kind, id).
//
//   chapter / drift     → `node-content:<nodeId>`   (both share the body field
//                          on the underlying BookNode.NodeContent row)
//   element             → `element:<elementId>`
//   storyline           → `storyline:<storylineId>` (body = contentJson)
//   element category    → `category:<categoryId>`   (body = contentJson)
//   material note       → `library-item:<itemId>`   (body = bodyJson; `note`
//                          editor profile, see lib/editor-schema-profile.ts)
//
export type DocKind = 'node-content' | 'element' | 'storyline' | 'category' | 'library-item';

const KIND_PREFIXES: Record<DocKind, string> = {
  'node-content': 'node-content:',
  element: 'element:',
  storyline: 'storyline:',
  category: 'category:',
  'library-item': 'library-item:',
};

export function makeDocId(kind: DocKind, entityId: string): string {
  return `${KIND_PREFIXES[kind]}${entityId}`;
}

// ---- prose-entity bridge ----------------------------------------------------
//
// The agent-edit review layer is keyed by ActivityEntityType ('node' | 'element'
// | 'storyline' | 'category'), which overlaps DocKind except that 'node' maps to
// the 'node-content' body doc. These helpers are the ONE place that membership +
// the node→node-content spelling live, so every generic write/revert/UI gate
// imports them instead of re-deriving the rule.

/** The entity types whose body is editable prose backed by a Yjs doc. Equal to
 *  the full ActivityEntityType set (tool-entity-ref). */
export const PROSE_ENTITY_TYPES = ['node', 'element', 'storyline', 'category'] as const;

export type ProseEntityType = (typeof PROSE_ENTITY_TYPES)[number];

/** Is this kind a prose entity (has a Yjs body + review UI)? Narrows strings —
 *  e.g. 'patch' (a CommentTargetKind with no Yjs doc) is excluded. */
export function isProseEntityType(kind: string): kind is ProseEntityType {
  return (PROSE_ENTITY_TYPES as readonly string[]).includes(kind);
}

/** The prose entity a document belongs to, or null for a material note: notes
 *  sit outside the book, so Agent review, references and check-ins do not
 *  track them. Entity history does (see SnapshotEntityKind). */
export function proseEntityTypeForDocKind(kind: DocKind): ProseEntityType | null {
  if (kind === 'library-item') return null;
  return kind === 'node-content' ? 'node' : kind;
}

/** The Yjs docId for a prose entity's body, bridging the one spelling mismatch:
 *  'node' → the 'node-content' body doc; the rest map 1:1 to their DocKind. */
export function proseDocId(entityType: ProseEntityType, id: string): string {
  return makeDocId(entityType === 'node' ? 'node-content' : entityType, id);
}

/** Entities with a local time-machine trail: the prose entities plus material
 *  notes, which keep their history even though they sit outside the book. */
export type SnapshotEntityKind = ProseEntityType | 'library_item';

export function snapshotEntityKindForDocKind(kind: DocKind): SnapshotEntityKind {
  if (kind === 'library-item') return 'library_item';
  return kind === 'node-content' ? 'node' : kind;
}

export function snapshotDocId(kind: SnapshotEntityKind, id: string): string {
  return kind === 'library_item' ? makeDocId('library-item', id) : proseDocId(kind, id);
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
