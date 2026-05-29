// Single source of truth for the polymorphic entity-kind vocabulary.
//
// Every place that talks about "what kind of entity is at this end of a
// relation / mention / comment" should derive its allowed set from the
// constants below, NOT redeclare its own union. Three concentric circles:
//
//   STRUCTURAL — canonical, content-bearing, referenceable. Can be the
//                target of @-mentions, manuscript comments, and entity
//                references. Show up as named addressable things in the UI.
//
//   ANNOTATIVE — author-side scaffolding (comments / library items). They
//                link OUT to structural entities but are never linked to.
//                Not comment-able, not @-mention-able.
//
//   ALL        — STRUCTURAL ∪ ANNOTATIVE. The full polymorphic vocabulary
//                that may appear in `entity_relation.fromKind`. The
//                `toKind` set is strictly STRUCTURAL.

export const STRUCTURAL_ENTITY_KINDS = [
  'node',
  'element',
  'patch',
  'category',
  'storyline',
] as const;

export const ANNOTATIVE_ENTITY_KINDS = ['comment', 'library_item'] as const;

export const ALL_ENTITY_KINDS = [
  ...STRUCTURAL_ENTITY_KINDS,
  ...ANNOTATIVE_ENTITY_KINDS,
] as const;

export type StructuralEntityKind = (typeof STRUCTURAL_ENTITY_KINDS)[number];
export type AnnotativeEntityKind = (typeof ANNOTATIVE_ENTITY_KINDS)[number];
export type EntityKind = (typeof ALL_ENTITY_KINDS)[number];

// Role-specific aliases. Keep these as type aliases so call sites read with
// intent ("this column holds a comment target" rather than "this column
// holds a structural entity kind") even though the underlying set is the
// same today.
export type EntityRefSourceKind = EntityKind;
export type EntityRefTargetKind = StructuralEntityKind;
export type CommentTargetKind = StructuralEntityKind;
export type InlineMentionKind = StructuralEntityKind;

const ALL_SET: ReadonlySet<string> = new Set(ALL_ENTITY_KINDS);
const STRUCTURAL_SET: ReadonlySet<string> = new Set(STRUCTURAL_ENTITY_KINDS);
const ANNOTATIVE_SET: ReadonlySet<string> = new Set(ANNOTATIVE_ENTITY_KINDS);

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && ALL_SET.has(value);
}

export function isStructuralEntityKind(value: unknown): value is StructuralEntityKind {
  return typeof value === 'string' && STRUCTURAL_SET.has(value);
}

export function isAnnotativeEntityKind(value: unknown): value is AnnotativeEntityKind {
  return typeof value === 'string' && ANNOTATIVE_SET.has(value);
}
